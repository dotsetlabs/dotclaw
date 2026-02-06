import fs from 'fs';
import path from 'path';
import type { RegisteredGroup, Session, MessageAttachment } from './types.js';
import type { ContainerOutput } from './container-protocol.js';
import type { AgentContext } from './agent-context.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { ProviderAttachment } from './providers/types.js';
import {
  getMessagesSinceCursor,
  getChatState,
  updateChatState,
  enqueueMessageItem,
  claimBatchForChat,
  completeQueuedMessages,
  failQueuedMessages,
  requeueQueuedMessages,
  getBackgroundJobQueuePosition,
  getBackgroundJobQueueDepth,
  linkMessageToTrace,
  getPendingMessageCount,
} from './db.js';
import {
  spawnBackgroundJob,
} from './background-jobs.js';
import { hostPathToContainerGroupPath } from './path-mapping.js';
import { writeTrace } from './trace-writer.js';
import { createProgressManager, DEFAULT_PROGRESS_MESSAGES, DEFAULT_PROGRESS_STAGES, formatProgressWithPlan, formatPlanStepList } from './progress.js';
import { recordMessage, recordError, recordRoutingDecision, recordStageLatency } from './metrics.js';
import { synthesizeSpeechHost } from './transcription.js';
import { emitHook } from './hooks.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { logger } from './logger.js';
import { setLastMessageTime, setMessageQueueDepth } from './dashboard.js';
import { humanizeError } from './error-messages.js';
import { classifyBackgroundJob } from './background-job-classifier.js';
import { routeRequest } from './request-router.js';
import { probePlanner } from './planner-probe.js';
import {
  GROUPS_DIR,
  BATCH_WINDOW_MS,
  MAX_BATCH_SIZE,
} from './config.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { ProviderRegistry as ProviderRegistryClass } from './providers/registry.js';

const runtime = loadRuntimeConfig();

const MEMORY_RECALL_MAX_RESULTS = runtime.host.memory.recall.maxResults;
const MEMORY_RECALL_MAX_TOKENS = runtime.host.memory.recall.maxTokens;
const BACKGROUND_JOBS_ENABLED = runtime.host.backgroundJobs.enabled;
const AUTO_SPAWN_CONFIG = runtime.host.backgroundJobs.autoSpawn;
const AUTO_SPAWN_ENABLED = BACKGROUND_JOBS_ENABLED && AUTO_SPAWN_CONFIG.enabled;
const AUTO_SPAWN_FOREGROUND_TIMEOUT_MS = AUTO_SPAWN_CONFIG.foregroundTimeoutMs;
const AUTO_SPAWN_ON_TIMEOUT = AUTO_SPAWN_CONFIG.onTimeout;
const AUTO_SPAWN_ON_TOOL_LIMIT = AUTO_SPAWN_CONFIG.onToolLimit;
const AUTO_SPAWN_CLASSIFIER_ENABLED = AUTO_SPAWN_CONFIG.classifier.enabled;
const TOOL_CALL_FALLBACK_PATTERN = /tool calls? but did not get a final response/i;
const MESSAGE_QUEUE_MAX_RETRIES = Math.max(1, runtime.host.messageQueue.maxRetries ?? 4);
const MESSAGE_QUEUE_RETRY_BASE_MS = Math.max(250, runtime.host.messageQueue.retryBaseMs ?? 3_000);
const MESSAGE_QUEUE_RETRY_MAX_MS = Math.max(MESSAGE_QUEUE_RETRY_BASE_MS, runtime.host.messageQueue.retryMaxMs ?? 60_000);
const MAX_DRAIN_ITERATIONS = 50;

const CANCEL_PHRASES = new Set([
  'cancel', 'stop', 'abort', 'cancel request', 'stop request'
]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isCancelMessage(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length > 20) return false;
  return CANCEL_PHRASES.has(trimmed.toLowerCase());
}

function clampInputMessage(content: string, maxChars: number): string {
  if (!content) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return content;
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[Message truncated for length]`;
}

function computeMessageQueueRetryDelayMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  const base = Math.min(MESSAGE_QUEUE_RETRY_MAX_MS, MESSAGE_QUEUE_RETRY_BASE_MS * Math.pow(2, exp));
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.max(250, Math.round(jitter));
}

class RetryableMessageProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableMessageProcessingError';
  }
}

function hostPathToContainerPath(hostPath: string, groupFolder: string): string | null {
  return hostPathToContainerGroupPath(hostPath, groupFolder, GROUPS_DIR);
}

export function buildAttachmentsXml(attachments: MessageAttachment[], groupFolder: string): string {
  if (!attachments || attachments.length === 0) return '';
  const escapeXml = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return attachments.map(a => {
    const attrs: string[] = [`type="${escapeXml(a.type)}"`];
    const containerPath = a.local_path ? hostPathToContainerPath(a.local_path, groupFolder) : null;
    if (containerPath) attrs.push(`path="${escapeXml(containerPath)}"`);
    if (a.file_name) attrs.push(`filename="${escapeXml(a.file_name)}"`);
    if (a.mime_type) attrs.push(`mime="${escapeXml(a.mime_type)}"`);
    if (a.file_size) attrs.push(`size="${a.file_size}"`);
    if (a.duration) attrs.push(`duration="${a.duration}"`);
    if (a.width) attrs.push(`width="${a.width}"`);
    if (a.height) attrs.push(`height="${a.height}"`);
    if (a.transcript) {
      return `<attachment ${attrs.join(' ')}>\n  <transcript>${escapeXml(a.transcript)}</transcript>\n</attachment>`;
    }
    return `<attachment ${attrs.join(' ')} />`;
  }).join('\n');
}

function inferProgressStage(params: { content: string; plannerTools: string[]; plannerSteps: string[]; enablePlanner: boolean }): string {
  const content = params.content.toLowerCase();
  const tools = params.plannerTools.map(tool => tool.toLowerCase());
  const hasWebTool = tools.some(tool => tool.includes('web') || tool.includes('search') || tool.includes('fetch'));
  const hasCodeTool = tools.some(tool => tool.includes('bash') || tool.includes('edit') || tool.includes('write') || tool.includes('git'));
  if (params.enablePlanner) return 'planning';
  if (hasWebTool || /research|search|browse|web|site|docs/.test(content)) return 'searching';
  if (hasCodeTool || /build|code|implement|refactor|fix|debug/.test(content)) return 'coding';
  return 'drafting';
}

function estimateForegroundMs(params: { content: string; routing: { estimatedMinutes?: number; profile: string }; plannerSteps: string[]; plannerTools: string[] }): number | null {
  if (typeof params.routing.estimatedMinutes === 'number' && Number.isFinite(params.routing.estimatedMinutes)) {
    return Math.max(1000, params.routing.estimatedMinutes * 60_000);
  }
  const baseChars = params.content.length;
  if (baseChars === 0) return null;
  const stepFactor = params.plannerSteps.length > 0 ? params.plannerSteps.length * 6000 : 0;
  const toolFactor = params.plannerTools.length > 0 ? params.plannerTools.length * 8000 : 0;
  const lengthFactor = Math.min(60_000, Math.max(3000, Math.round(baseChars / 3)));
  const profileFactor = params.routing.profile === 'deep' ? 1.4 : 1;
  return Math.round((lengthFactor + stepFactor + toolFactor) * profileFactor);
}

function inferPlanStepIndex(stage: string, totalSteps: number): number | null {
  if (!Number.isFinite(totalSteps) || totalSteps <= 0) return null;
  const normalized = stage.trim().toLowerCase();
  if (!normalized) return 1;
  switch (normalized) {
    case 'planning': return 1;
    case 'searching': return Math.min(2, totalSteps);
    case 'coding': return Math.min(Math.max(2, Math.ceil(totalSteps * 0.6)), totalSteps);
    case 'drafting': return Math.min(Math.max(2, Math.ceil(totalSteps * 0.8)), totalSteps);
    case 'finalizing': return totalSteps;
    default: return 1;
  }
}

/** Convert ProviderAttachment to MessageAttachment for DB storage */
export function providerAttachmentToMessageAttachment(pa: ProviderAttachment): MessageAttachment {
  return {
    type: pa.type,
    provider_file_ref: pa.providerFileRef,
    file_name: pa.fileName,
    mime_type: pa.mimeType,
    file_size: pa.fileSize,
    local_path: pa.localPath,
    duration: pa.duration,
    width: pa.width,
    height: pa.height,
    transcript: pa.transcript,
  };
}

export interface PipelineMessage {
  chatId: string;         // Prefixed chat ID (e.g. "telegram:123")
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  isGroup: boolean;
  chatType: string;
  threadId?: string;
  attachments?: MessageAttachment[];
}

export interface MessagePipelineDeps {
  registry: ProviderRegistry;
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Session;
  setSession: (folder: string, id: string) => void;
  buildAvailableGroupsSnapshot: () => Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>;
}

const activeDrains = new Set<string>();
const activeRuns = new Map<string, AbortController>();

export function getActiveDrains(): Set<string> {
  return activeDrains;
}

export function getActiveRuns(): Map<string, AbortController> {
  return activeRuns;
}

export function createMessagePipeline(deps: MessagePipelineDeps) {

  async function sendMessageForQueue(
    chatId: string,
    text: string,
    options?: { threadId?: string; parseMode?: string | null; replyToMessageId?: string }
  ): Promise<{ success: true; messageId?: string }> {
    const provider = deps.registry.getProviderForChat(chatId);
    const result = await provider.sendMessage(chatId, text, {
      threadId: options?.threadId,
      parseMode: options?.parseMode,
      replyToMessageId: options?.replyToMessageId,
    });
    if (!result.success) {
      throw new RetryableMessageProcessingError('Failed to deliver message');
    }
    return { success: true, messageId: result.messageId };
  }

  function enqueueMessage(msg: PipelineMessage): void {
    if (isCancelMessage(msg.content)) {
      const controller = activeRuns.get(msg.chatId);
      if (controller) {
        controller.abort();
        activeRuns.delete(msg.chatId);
        const provider = deps.registry.getProviderForChat(msg.chatId);
        void provider.sendMessage(msg.chatId, 'Canceled.', { threadId: msg.threadId });
        return;
      }
      const provider = deps.registry.getProviderForChat(msg.chatId);
      void provider.sendMessage(msg.chatId, "Nothing's running right now.", { threadId: msg.threadId });
      return;
    }
    enqueueMessageItem({
      chat_jid: msg.chatId,
      message_id: msg.messageId,
      sender_id: msg.senderId,
      sender_name: msg.senderName,
      content: msg.content,
      timestamp: msg.timestamp,
      is_group: msg.isGroup,
      chat_type: msg.chatType,
      message_thread_id: msg.threadId ? Number(msg.threadId) : undefined,
    });
    setMessageQueueDepth(getPendingMessageCount());
    if (!activeDrains.has(msg.chatId)) {
      void drainQueue(msg.chatId);
    }
  }

  async function drainQueue(chatId: string): Promise<void> {
    if (activeDrains.has(chatId)) return;
    activeDrains.add(chatId);
    setMessageQueueDepth(getPendingMessageCount());
    let reschedule = false;
    try {
      let iterations = 0;
      while (iterations < MAX_DRAIN_ITERATIONS) {
        const batch = claimBatchForChat(chatId, BATCH_WINDOW_MS, MAX_BATCH_SIZE);
        if (batch.length === 0) break;
        iterations++;
        const last = batch[batch.length - 1];
        const triggerMsg: PipelineMessage = {
          chatId: last.chat_jid,
          messageId: last.message_id,
          senderId: last.sender_id,
          senderName: last.sender_name,
          content: last.content,
          timestamp: last.timestamp,
          isGroup: last.is_group === 1,
          chatType: last.chat_type,
          threadId: last.message_thread_id != null ? String(last.message_thread_id) : undefined,
        };
        const batchIds = batch.map(b => b.id);
        try {
          await processMessage(triggerMsg);
          completeQueuedMessages(batchIds);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const attempt = Math.max(
            1,
            ...batch.map(row => {
              const previousAttempts = Number.isFinite(row.attempt_count) ? Number(row.attempt_count) : 0;
              return previousAttempts + 1;
            })
          );
          const isRetryable = err instanceof RetryableMessageProcessingError;
          if (isRetryable && attempt < MESSAGE_QUEUE_MAX_RETRIES) {
            requeueQueuedMessages(batchIds, errMsg);
            const delayMs = computeMessageQueueRetryDelayMs(attempt);
            logger.warn({
              chatId,
              attempt,
              maxRetries: MESSAGE_QUEUE_MAX_RETRIES,
              delayMs,
              error: errMsg
            }, 'Retryable batch failure; re-queued for retry');
            await sleep(delayMs);
            continue;
          }
          failQueuedMessages(batchIds, errMsg);
          logger.error({ chatId, attempt, err }, 'Error processing message batch');
        }
      }
      if (iterations >= MAX_DRAIN_ITERATIONS) {
        reschedule = true;
        logger.warn({ chatId, iterations }, 'Drain loop hit iteration limit; re-scheduling');
        setTimeout(() => {
          activeDrains.delete(chatId);
          void drainQueue(chatId);
        }, 1000);
      }
    } finally {
      if (!reschedule) {
        activeDrains.delete(chatId);
      }
      setMessageQueueDepth(getPendingMessageCount());
    }
  }

  async function processMessage(msg: PipelineMessage): Promise<boolean> {
    const registeredGroups = deps.registeredGroups();
    const sessions = deps.sessions();
    const group = registeredGroups[msg.chatId];
    if (!group) {
      logger.debug({ chatId: msg.chatId }, 'Message from unregistered chat');
      return false;
    }

    const providerName = ProviderRegistryClass.getPrefix(msg.chatId);
    recordMessage(providerName);
    setLastMessageTime(msg.timestamp);

    const chatState = getChatState(msg.chatId);
    let missedMessages = getMessagesSinceCursor(
      msg.chatId,
      chatState?.last_agent_timestamp || null,
      chatState?.last_agent_message_id || null
    );
    const triggerMessageId = Number.parseInt(msg.messageId, 10);
    missedMessages = missedMessages.filter((message) => {
      if (message.timestamp < msg.timestamp) return true;
      if (message.timestamp !== msg.timestamp) return false;
      const numericId = Number.parseInt(message.id, 10);
      if (Number.isFinite(triggerMessageId) && Number.isFinite(numericId)) {
        return numericId <= triggerMessageId;
      }
      return message.id <= msg.messageId;
    });
    if (missedMessages.length === 0) {
      logger.warn({ chatId: msg.chatId }, 'No missed messages found; falling back to current message');
      const fallbackAttachments = msg.attachments && msg.attachments.length > 0
        ? JSON.stringify(msg.attachments)
        : null;
      missedMessages = [{
        id: msg.messageId,
        chat_jid: msg.chatId,
        sender: msg.senderId,
        sender_name: msg.senderName,
        content: msg.content,
        timestamp: msg.timestamp,
        attachments_json: fallbackAttachments
      }];
    }

    const inputMaxChars = deps.registry.getProviderForChat(msg.chatId).capabilities.maxMessageLength;
    const lines = missedMessages.map(m => {
      const escapeXml = (s: string) => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
      const safeContent = clampInputMessage(m.content, inputMaxChars);
      let attachments: MessageAttachment[] = [];
      if (m.attachments_json) {
        try { attachments = JSON.parse(m.attachments_json); } catch { /* ignore */ }
      }
      const attachmentXml = buildAttachmentsXml(attachments, group.folder);
      const inner = attachmentXml
        ? `${escapeXml(safeContent)}\n${attachmentXml}`
        : escapeXml(safeContent);
      return `<message sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" time="${m.timestamp}">${inner}</message>`;
    });
    const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;
    const lastMessage = missedMessages[missedMessages.length - 1];
    const replyToMessageId = msg.messageId;
    const containerAttachments = (() => {
      for (let idx = missedMessages.length - 1; idx >= 0; idx -= 1) {
        const raw = missedMessages[idx].attachments_json;
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as MessageAttachment[];
          if (!Array.isArray(parsed) || parsed.length === 0) continue;
          const mapped = parsed.flatMap(attachment => {
            if (!attachment?.local_path) return [];
            const containerPath = hostPathToContainerPath(attachment.local_path, group.folder);
            if (!containerPath) return [];
            return [{
              type: attachment.type,
              path: containerPath,
              file_name: attachment.file_name,
              mime_type: attachment.mime_type,
              file_size: attachment.file_size,
              duration: attachment.duration,
              width: attachment.width,
              height: attachment.height
            }];
          });
          if (mapped.length > 0) return mapped;
        } catch {
          // ignore malformed attachment payloads
        }
      }
      return undefined;
    })();

    const routingStartedAt = Date.now();
    const routingDecision = routeRequest({ prompt, lastMessage });
    const routerMs = Date.now() - routingStartedAt;
    recordStageLatency('router', routerMs, providerName);

    // Smart upgrade: if routed to "fast" by short length, probe for tool intent
    if (routingDecision.profile === 'fast' && routingDecision.reason === 'short prompt') {
      const { probeToolIntent } = await import('./tool-intent-probe.js');
      const probeResult = await probeToolIntent(lastMessage?.content || prompt);
      if (probeResult.needsTools) {
        const standardConfig = runtime.host.routing.profiles?.standard;
        if (standardConfig) {
          routingDecision.profile = 'standard';
          routingDecision.reason = 'tool intent probe';
          routingDecision.modelOverride = standardConfig.model;
          routingDecision.maxOutputTokens = standardConfig.maxOutputTokens;
          routingDecision.maxToolSteps = standardConfig.maxToolSteps;
          routingDecision.enablePlanner = standardConfig.enablePlanner;
          routingDecision.enableResponseValidation = standardConfig.enableValidation;
          routingDecision.enableMemoryRecall = standardConfig.enableMemoryRecall;
          routingDecision.enableMemoryExtraction = standardConfig.enableMemoryExtraction;
          if (typeof standardConfig.recallMaxResults === 'number') {
            routingDecision.recallMaxResults = standardConfig.recallMaxResults;
          }
          if (typeof standardConfig.recallMaxTokens === 'number') {
            routingDecision.recallMaxTokens = standardConfig.recallMaxTokens;
          }
          if (typeof standardConfig.responseValidationMaxRetries === 'number') {
            routingDecision.responseValidationMaxRetries = standardConfig.responseValidationMaxRetries;
          }
        }
        logger.info({ latencyMs: probeResult.latencyMs }, 'Tool intent probe upgraded fast → standard');
      } else {
        logger.debug({ latencyMs: probeResult.latencyMs }, 'Tool intent probe: staying fast');
      }
    }

    recordRoutingDecision(routingDecision.profile);
    logger.info({
      chatId: msg.chatId,
      profile: routingDecision.profile,
      reason: routingDecision.reason,
      shouldBackground: routingDecision.shouldBackground
    }, 'Routing decision');

    const traceBase = createTraceBase({
      chatId: msg.chatId,
      groupFolder: group.folder,
      userId: msg.senderId,
      inputText: prompt,
      source: 'dotclaw'
    });

    logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

    void emitHook('message:processing', {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      sender_id: msg.senderId,
      group_folder: group.folder,
      message_count: missedMessages.length
    });

    const provider = deps.registry.getProviderForChat(msg.chatId);
    await provider.setTyping(msg.chatId);
    const recallQuery = missedMessages.map(entry => entry.content).join('\n');

    let output: ContainerOutput | null = null;
    let context: AgentContext | null = null;
    let errorMessage: string | null = null;

    const isTimeoutError = (value?: string | null): boolean => {
      if (!value) return false;
      return /timed out|timeout/i.test(value);
    };

    const shouldPlannerProbe = () => {
      const config = runtime.host.routing.plannerProbe;
      if (!config.enabled) return false;
      if (routingDecision.profile === 'fast' || routingDecision.shouldBackground) return false;
      const contentLength = lastMessage?.content?.length || 0;
      return contentLength >= config.minChars;
    };

    let plannerProbeTools: string[] = [];
    let plannerProbeSteps: string[] = [];
    let plannerProbeMs: number | null = null;

    const maybeAutoSpawn = async (
      reason: 'timeout' | 'tool_limit' | 'classifier' | 'router' | 'planner',
      _detail?: string | null,
      overrides?: {
        modelOverride?: string;
        maxToolSteps?: number;
        timeoutMs?: number;
        tags?: string[];
      }
    ): Promise<boolean> => {
      if (!BACKGROUND_JOBS_ENABLED) return false;
      if (reason !== 'router' && !AUTO_SPAWN_ENABLED) return false;
      if (reason === 'timeout' && !AUTO_SPAWN_ON_TIMEOUT) return false;
      if (reason === 'tool_limit' && !AUTO_SPAWN_ON_TOOL_LIMIT) return false;

      const tags = ['auto-spawn', reason, `profile:${routingDecision.profile}`];
      if (overrides?.tags && overrides.tags.length > 0) {
        tags.push(...overrides.tags);
      }
      if (routingDecision.estimatedMinutes) {
        tags.push(`eta:${routingDecision.estimatedMinutes}`);
      }
      const estimatedMs = typeof routingDecision.estimatedMinutes === 'number'
        ? routingDecision.estimatedMinutes * 60_000
        : null;
      const computedTimeoutMs = estimatedMs
        ? Math.min(runtime.host.backgroundJobs.maxRuntimeMs, Math.max(5 * 60_000, Math.round(estimatedMs * 2)))
        : undefined;
      // Always use the background profile's model for background jobs, not the
      // original routing profile's model (which may be a fast/standard model and
      // may not even be in the model allowlist).
      const bgProfile = runtime.host.routing.profiles?.background;
      const bgModel = overrides?.modelOverride ?? bgProfile?.model ?? routingDecision.modelOverride;
      const bgMaxToolSteps = overrides?.maxToolSteps ?? bgProfile?.maxToolSteps ?? routingDecision.maxToolSteps;
      const result = spawnBackgroundJob({
        prompt,
        groupFolder: group.folder,
        chatJid: msg.chatId,
        contextMode: 'group',
        tags,
        parentTraceId: traceBase.trace_id,
        parentMessageId: msg.messageId,
        modelOverride: bgModel,
        maxToolSteps: bgMaxToolSteps,
        toolAllow: routingDecision.toolAllow,
        toolDeny: routingDecision.toolDeny,
        timeoutMs: overrides?.timeoutMs ?? computedTimeoutMs
      });
      if (!result.ok || !result.jobId) {
        logger.warn({ chatId: msg.chatId, reason, error: result.error }, 'Auto-spawn background job failed');
        return false;
      }

      const queuePosition = getBackgroundJobQueuePosition({ jobId: result.jobId, groupFolder: group.folder });
      const eta = routingDecision.estimatedMinutes ? `~${routingDecision.estimatedMinutes} min` : null;
      const queueLine = queuePosition && queuePosition.position > 1
        ? `\n\n${queuePosition.position - 1} job${queuePosition.position > 2 ? 's' : ''} ahead of this one.`
        : '';
      const etaLine = eta ? `\n\nEstimated time: ${eta}.` : '';
      const planPreview = plannerProbeSteps.length > 0
        ? formatPlanStepList({ steps: plannerProbeSteps, currentStep: 1, maxSteps: 4 })
        : '';
      const planLine = planPreview ? `\n\nPlanned steps:\n${planPreview}` : '';
      await sendMessageForQueue(
        msg.chatId,
        `Working on it in the background. I'll send the result when it's done.${queueLine}${etaLine}${planLine}`,
        { threadId: msg.threadId, replyToMessageId }
      );

      updateChatState(msg.chatId, msg.timestamp, msg.messageId);
      return true;
    };

    if (shouldPlannerProbe() && lastMessage) {
      const probeStarted = Date.now();
      const probeResult = await probePlanner({
        lastMessage,
        recentMessages: missedMessages
      });
      plannerProbeMs = Date.now() - probeStarted;
      recordStageLatency('planner_probe', plannerProbeMs, providerName);
      if (probeResult.steps.length > 0) plannerProbeSteps = probeResult.steps;
      if (probeResult.tools.length > 0) plannerProbeTools = probeResult.tools;
      logger.info({
        chatId: msg.chatId,
        shouldBackground: probeResult.shouldBackground,
        steps: probeResult.steps.length,
        tools: probeResult.tools.length,
        latencyMs: probeResult.latencyMs,
        model: probeResult.model,
        error: probeResult.error
      }, 'Planner probe decision');
      if (probeResult.shouldBackground) {
        const autoSpawned = await maybeAutoSpawn('planner', 'planner probe predicted multi-step work');
        if (autoSpawned) return true;
      }
    }

    let classifierMs: number | null = null;
    if (AUTO_SPAWN_ENABLED && AUTO_SPAWN_CLASSIFIER_ENABLED && lastMessage && routingDecision.shouldRunClassifier) {
      try {
        const queueDepth = getBackgroundJobQueueDepth({ groupFolder: group.folder });
        const classifierResult = await classifyBackgroundJob({
          lastMessage,
          recentMessages: missedMessages,
          isGroup: msg.isGroup,
          chatType: msg.chatType,
          queueDepth,
          metricsSource: providerName,
        });
        if (classifierResult.latencyMs) {
          classifierMs = classifierResult.latencyMs;
          recordStageLatency('classifier', classifierResult.latencyMs, providerName);
        }
        logger.info({
          chatId: msg.chatId,
          decision: classifierResult.shouldBackground,
          confidence: classifierResult.confidence,
          latencyMs: classifierResult.latencyMs,
          model: classifierResult.model,
          reason: classifierResult.reason,
          error: classifierResult.error
        }, 'Background job classifier decision');
        if (classifierResult.shouldBackground) {
          const estimated = classifierResult.estimatedMinutes;
          if (typeof estimated === 'number' && Number.isFinite(estimated) && estimated > 0) {
            routingDecision.estimatedMinutes = Math.round(estimated);
          }
          const autoSpawned = await maybeAutoSpawn('classifier', classifierResult.reason);
          if (autoSpawned) return true;
        }
      } catch (err) {
        logger.warn({ chatId: msg.chatId, err }, 'Background job classifier failed');
      }
    }

    // Refresh typing indicator
    const typingInterval = setInterval(() => { void provider.setTyping(msg.chatId); }, 4_000);

    const predictedStage = inferProgressStage({
      content: lastMessage?.content || prompt,
      plannerTools: plannerProbeTools,
      plannerSteps: plannerProbeSteps,
      enablePlanner: routingDecision.enablePlanner
    });
    const predictedMs = estimateForegroundMs({
      content: lastMessage?.content || prompt,
      routing: routingDecision,
      plannerSteps: plannerProbeSteps,
      plannerTools: plannerProbeTools
    });
    const planStepIndex = inferPlanStepIndex(predictedStage, plannerProbeSteps.length);

    const progressManager = createProgressManager({
      enabled: routingDecision.progress.enabled,
      initialDelayMs: routingDecision.progress.initialMs,
      intervalMs: routingDecision.progress.intervalMs,
      maxUpdates: routingDecision.progress.maxUpdates,
      messages: routingDecision.progress.messages.length > 0
        ? routingDecision.progress.messages
        : DEFAULT_PROGRESS_MESSAGES,
      stageMessages: DEFAULT_PROGRESS_STAGES,
      stageThrottleMs: 20_000,
      send: async (text) => { await provider.sendMessage(msg.chatId, text, { threadId: msg.threadId }); },
      onError: (err) => logger.debug({ chatId: msg.chatId, err }, 'Failed to send progress update')
    });
    progressManager.start();
    let sentPlan = false;
    if (predictedMs && predictedMs >= 10_000 && routingDecision.progress.enabled) {
      if (plannerProbeSteps.length > 0) {
        const planMessage = formatProgressWithPlan({
          steps: plannerProbeSteps,
          currentStep: planStepIndex ?? 1,
          stage: predictedStage
        });
        progressManager.notify(planMessage);
        sentPlan = true;
      } else {
        progressManager.notify(DEFAULT_PROGRESS_STAGES.ack);
      }
    }
    if (!(sentPlan && predictedStage === 'planning')) {
      progressManager.setStage(predictedStage);
    }
    if (predictedStage === 'planning') {
      const followUpStage = inferProgressStage({
        content: lastMessage?.content || prompt,
        plannerTools: plannerProbeTools,
        plannerSteps: plannerProbeSteps,
        enablePlanner: false
      });
      if (followUpStage !== 'planning') {
        const delay = Math.min(15_000, Math.max(5_000, Math.floor(routingDecision.progress.initialMs / 2)));
        setTimeout(() => progressManager.setStage(followUpStage), delay);
      }
    }
    const abortController = new AbortController();
    activeRuns.set(msg.chatId, abortController);
    try {
      const recallMaxResults = routingDecision.enableMemoryRecall
        ? (Number.isFinite(routingDecision.recallMaxResults)
          ? Math.max(0, Math.floor(routingDecision.recallMaxResults as number))
          : MEMORY_RECALL_MAX_RESULTS)
        : 0;
      const recallMaxTokens = routingDecision.enableMemoryRecall
        ? (Number.isFinite(routingDecision.recallMaxTokens)
          ? Math.max(0, Math.floor(routingDecision.recallMaxTokens as number))
          : MEMORY_RECALL_MAX_TOKENS)
        : 0;
      const execution = await executeAgentRun({
        group,
        prompt,
        chatJid: msg.chatId,
        userId: msg.senderId,
        userName: msg.senderName,
        recallQuery: recallQuery || msg.content,
        recallMaxResults,
        recallMaxTokens,
        toolAllow: routingDecision.toolAllow,
        toolDeny: routingDecision.toolDeny,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { deps.setSession(group.folder, sessionId); },
        availableGroups: deps.buildAvailableGroupsSnapshot(),
        modelOverride: routingDecision.modelOverride,
        modelMaxOutputTokens: routingDecision.maxOutputTokens,
        maxToolSteps: routingDecision.maxToolSteps,
        disablePlanner: !routingDecision.enablePlanner,
        disableResponseValidation: !routingDecision.enableResponseValidation,
        responseValidationMaxRetries: routingDecision.responseValidationMaxRetries,
        disableMemoryExtraction: !routingDecision.enableMemoryExtraction,
        profile: routingDecision.profile as 'fast' | 'standard' | 'deep' | 'background',
        attachments: containerAttachments,
        abortSignal: abortController.signal,
        timeoutMs: AUTO_SPAWN_ENABLED && AUTO_SPAWN_FOREGROUND_TIMEOUT_MS > 0
          ? AUTO_SPAWN_FOREGROUND_TIMEOUT_MS
          : undefined
      });
      output = execution.output;
      context = execution.context;
      progressManager.setStage('finalizing');

      if (output.status === 'error') {
        errorMessage = output.error || 'Unknown error';
      }
    } catch (err) {
      if (err instanceof AgentExecutionError) {
        context = err.context;
        errorMessage = err.message;
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      logger.error({ group: group.name, err }, 'Agent error');
    } finally {
      clearInterval(typingInterval);
      progressManager.stop();
      activeRuns.delete(msg.chatId);
    }

    const extraTimings: Record<string, number> = {};
    extraTimings.router_ms = routerMs;
    if (classifierMs !== null) extraTimings.classifier_ms = classifierMs;
    if (plannerProbeMs !== null) extraTimings.planner_probe_ms = plannerProbeMs;

    if (!output) {
      const message = errorMessage || 'No output from agent';
      if (context) {
        recordAgentTelemetry({
          traceBase,
          output: null,
          context,
          metricsSource: providerName,
          toolAuditSource: 'message',
          errorMessage: message,
          errorType: 'agent',
          extraTimings
        });
      } else {
        recordError('agent');
        writeTrace({
          trace_id: traceBase.trace_id,
          timestamp: traceBase.timestamp,
          created_at: traceBase.created_at,
          chat_id: traceBase.chat_id,
          group_folder: traceBase.group_folder,
          user_id: traceBase.user_id,
          input_text: traceBase.input_text,
          output_text: null,
          model_id: 'unknown',
          memory_recall: [],
          error_code: message,
          source: traceBase.source
        });
      }
      if (isTimeoutError(message)) {
        const autoSpawned = await maybeAutoSpawn('timeout', message);
        if (autoSpawned) return true;
      }
      const userMessage = humanizeError(errorMessage || 'Unknown error');
      await sendMessageForQueue(msg.chatId, userMessage, { threadId: msg.threadId, replyToMessageId });
      return false;
    }

    if (output.status === 'error') {
      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          metricsSource: providerName,
          toolAuditSource: 'message',
          errorMessage: errorMessage || output.error || 'Unknown error',
          errorType: 'agent',
          extraTimings
        });
      }
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      const errorText = errorMessage || output.error || 'Unknown error';
      if (isTimeoutError(errorText)) {
        const autoSpawned = await maybeAutoSpawn('timeout', errorText);
        if (autoSpawned) return true;
      }
      const userMessage = humanizeError(errorText);
      await sendMessageForQueue(msg.chatId, userMessage, { threadId: msg.threadId, replyToMessageId });
      return false;
    }

    updateChatState(msg.chatId, msg.timestamp, msg.messageId);

    if (output.result && output.result.trim()) {
      const hasVoiceAttachment = missedMessages.some(m => {
        if (!m.attachments_json) return false;
        try {
          const atts = JSON.parse(m.attachments_json) as MessageAttachment[];
          return atts.some(a => a.type === 'voice');
        } catch { return false; }
      });

      if (hasVoiceAttachment) {
        const inboxDir = path.join(GROUPS_DIR, group.folder, 'inbox');
        const voicePath = await synthesizeSpeechHost(output.result, inboxDir);
        if (voicePath) {
          try {
            await provider.sendVoice(msg.chatId, voicePath);
            fs.unlinkSync(voicePath);
          } catch (err) {
            logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Failed to send TTS voice reply');
            await sendMessageForQueue(msg.chatId, output.result, { threadId: msg.threadId, replyToMessageId });
          }
        } else {
          await sendMessageForQueue(msg.chatId, output.result, { threadId: msg.threadId, replyToMessageId });
        }
      } else {
        const sendResult = await sendMessageForQueue(msg.chatId, output.result, { threadId: msg.threadId, replyToMessageId });
        const sentMessageId = sendResult.messageId;
        if (sentMessageId) {
          try {
            linkMessageToTrace(sentMessageId, msg.chatId, traceBase.trace_id);
          } catch {
            // Don't fail if linking fails
          }
        }
      }
      if (output.stdoutTruncated) {
        await sendMessageForQueue(
          msg.chatId,
          'That response was cut short because it was too large. Ask me to continue or try a smaller request.',
          { threadId: msg.threadId }
        );
      }
    } else if (output.tool_calls && output.tool_calls.length > 0) {
      const toolLimitHit = !output.result || !output.result.trim() || TOOL_CALL_FALLBACK_PATTERN.test(output.result);
      if (toolLimitHit) {
        const autoSpawned = await maybeAutoSpawn('tool_limit', 'Tool-call step limit reached');
        if (autoSpawned) {
          if (context) {
            recordAgentTelemetry({
              traceBase,
              output,
              context,
              metricsSource: providerName,
              toolAuditSource: 'message',
              extraTimings
            });
          }
          return true;
        }
      }
      await sendMessageForQueue(
        msg.chatId,
        "I ran out of steps before I could finish. Try narrowing the scope or asking for a specific part.",
        { threadId: msg.threadId, replyToMessageId }
      );
    } else {
      logger.warn({ chatId: msg.chatId }, 'Agent returned empty/whitespace response');
      await sendMessageForQueue(msg.chatId, "I wasn't able to come up with a response. Could you try rephrasing?", { threadId: msg.threadId, replyToMessageId });
    }

    if (context) {
      recordAgentTelemetry({
        traceBase,
        output,
        context,
        metricsSource: providerName,
        toolAuditSource: 'message',
        extraTimings
      });
    }

    void emitHook('message:responded', {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      group_folder: group.folder,
      has_result: !!output.result?.trim(),
      model: context?.resolvedModel?.model || 'unknown'
    });

    return true;
  }

  return {
    enqueueMessage,
    drainQueue,
    processMessage,
    sendMessageForQueue,
  };
}

export type MessagePipeline = ReturnType<typeof createMessagePipeline>;
