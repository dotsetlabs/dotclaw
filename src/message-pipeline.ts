import fs from 'fs';
import path from 'path';
import type { RegisteredGroup, Session, MessageAttachment } from './types.js';
import type { ContainerOutput } from './container-protocol.js';
import type { AgentContext } from './agent-context.js';
import type { ProviderRegistry } from './providers/registry.js';
import {
  getMessagesSinceCursor,
  getChatState,
  updateChatState,
  enqueueMessageItem,
  claimBatchForChat,
  completeQueuedMessages,
  failQueuedMessages,
  requeueQueuedMessages,
  linkMessageToTrace,
  getPendingMessageCount,
} from './db.js';
import { hostPathToContainerGroupPath } from './path-mapping.js';
import { recordMessage, recordError, recordStageLatency } from './metrics.js';
import { synthesizeSpeechHost } from './transcription.js';
import { emitHook } from './hooks.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { applyTurnHygiene } from './turn-hygiene.js';
import { logger } from './logger.js';
import { setLastMessageTime, setMessageQueueDepth } from './dashboard.js';
import { humanizeError, isTransientError } from './error-messages.js';
import { routeRequest } from './request-router.js';
import {
  GROUPS_DIR,
} from './config.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { ProviderRegistry as ProviderRegistryClass } from './providers/registry.js';
import { StreamingDelivery, watchStreamChunks } from './streaming.js';

const MAX_DRAIN_ITERATIONS = 50;

type MessagePipelineRuntime = {
  queue: {
    interruptOnNewMessage: boolean;
    maxRetries: number;
    retryBaseMs: number;
    retryMaxMs: number;
    promptMaxChars: number;
    batchWindowMs: number;
    maxBatchSize: number;
  };
  streaming: {
    enabled: boolean;
    chunkFlushIntervalMs: number;
    editIntervalMs: number;
    maxEditLength: number;
  };
  reasoningEffort: 'off' | 'low' | 'medium' | 'high';
};

export function resolveMessagePipelineRuntime(): MessagePipelineRuntime {
  const runtime = loadRuntimeConfig();
  const queue = runtime.host.messageQueue;
  const retryBaseMs = Math.max(250, queue.retryBaseMs ?? 3_000);
  return {
    queue: {
      interruptOnNewMessage: queue.interruptOnNewMessage ?? true,
      maxRetries: Math.max(1, queue.maxRetries ?? 4),
      retryBaseMs,
      retryMaxMs: Math.max(retryBaseMs, queue.retryMaxMs ?? 60_000),
      promptMaxChars: Math.max(2_000, queue.promptMaxChars ?? 24_000),
      batchWindowMs: Math.max(0, queue.batchWindowMs ?? 2_000),
      maxBatchSize: Math.max(1, queue.maxBatchSize ?? 50),
    },
    streaming: {
      enabled: runtime.host.streaming.enabled,
      chunkFlushIntervalMs: runtime.host.streaming.chunkFlushIntervalMs,
      editIntervalMs: runtime.host.streaming.editIntervalMs,
      maxEditLength: runtime.host.streaming.maxEditLength,
    },
    reasoningEffort: runtime.agent.reasoning.effort
  };
}

const CANCEL_PHRASES = new Set([
  'cancel', 'stop', 'abort', 'cancel request', 'stop request'
]);

function isSilentReply(text: string): boolean {
  return /^\s*NO_REPLY\s*$/.test(text);
}

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

function computeMessageQueueRetryDelayMs(attempt: number, runtime: MessagePipelineRuntime): number {
  const exp = Math.max(0, attempt - 1);
  const base = Math.min(runtime.queue.retryMaxMs, runtime.queue.retryBaseMs * Math.pow(2, exp));
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.max(250, Math.round(jitter));
}

export function selectPromptLineIndicesWithinBudget(lines: string[], maxChars: number): { indices: number[]; omitted: number } {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { indices: [], omitted: 0 };
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { indices: lines.map((_, idx) => idx), omitted: 0 };
  }

  const keptDescending: number[] = [];
  let usedChars = 0;
  let omitted = 0;
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx] || '';
    const candidateChars = line.length + 1;
    if (keptDescending.length > 0 && usedChars + candidateChars > maxChars) {
      omitted += 1;
      continue;
    }
    keptDescending.push(idx);
    usedChars += candidateChars;
  }

  keptDescending.reverse();
  return { indices: keptDescending, omitted };
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

/** Convert ProviderAttachment to MessageAttachment for DB storage */
import type { ProviderAttachment } from './providers/types.js';

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
    const runtime = resolveMessagePipelineRuntime();
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
    if (runtime.queue.interruptOnNewMessage) {
      const controller = activeRuns.get(msg.chatId);
      if (controller) {
        logger.info({ chatId: msg.chatId }, 'Interrupting active run for new message');
        controller.abort('interrupted');
        activeRuns.delete(msg.chatId);
      }
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
    const runtime = resolveMessagePipelineRuntime();
    activeDrains.add(chatId);
    setMessageQueueDepth(getPendingMessageCount());
    let reschedule = false;
    try {
      let iterations = 0;
      while (iterations < MAX_DRAIN_ITERATIONS) {
        const batch = claimBatchForChat(chatId, runtime.queue.batchWindowMs, runtime.queue.maxBatchSize);
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
          if (isRetryable && attempt < runtime.queue.maxRetries) {
            requeueQueuedMessages(batchIds, errMsg);
            const delayMs = computeMessageQueueRetryDelayMs(attempt, runtime);
            logger.warn({
              chatId,
              attempt,
              maxRetries: runtime.queue.maxRetries,
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
    const runtime = resolveMessagePipelineRuntime();
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

    const hygiene = applyTurnHygiene(missedMessages);
    missedMessages = hygiene.messages;
    if (
      hygiene.stats.droppedMalformed > 0
      || hygiene.stats.droppedDuplicates > 0
      || hygiene.stats.droppedStalePartials > 0
      || hygiene.stats.normalizedToolEnvelopes > 0
    ) {
      logger.debug({
        chatId: msg.chatId,
        inputCount: hygiene.stats.inputCount,
        outputCount: hygiene.stats.outputCount,
        droppedMalformed: hygiene.stats.droppedMalformed,
        droppedDuplicates: hygiene.stats.droppedDuplicates,
        droppedStalePartials: hygiene.stats.droppedStalePartials,
        normalizedToolEnvelopes: hygiene.stats.normalizedToolEnvelopes
      }, 'Applied turn hygiene');
    }
    if (missedMessages.length === 0) {
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

    const { indices: promptLineIndices, omitted: omittedPromptMessages } =
      selectPromptLineIndicesWithinBudget(lines, runtime.queue.promptMaxChars);
    const selectedMessages = promptLineIndices.map(idx => missedMessages[idx]);
    const selectedLines = promptLineIndices.map(idx => lines[idx]);

    if (omittedPromptMessages > 0) {
      selectedLines.unshift(
        `<message sender="system" sender_id="system" time="${msg.timestamp}">` +
          `[${omittedPromptMessages} earlier message(s) omitted due to context budget. Focus on the most recent intent.]` +
          `</message>`
      );
    }

    const prompt = `<messages>\n${selectedLines.join('\n')}\n</messages>`;
    const replyToMessageId = msg.messageId;
    const containerAttachments = (() => {
      for (let idx = selectedMessages.length - 1; idx >= 0; idx -= 1) {
        const raw = selectedMessages[idx].attachments_json;
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
              height: attachment.height,
              transcript: attachment.transcript
            }];
          });
          if (mapped.length > 0) return mapped;
        } catch {
          // ignore malformed attachment payloads
        }
      }
      return undefined;
    })();

    // Single routing decision — no probes, no profiles
    const routingStartedAt = Date.now();
    const routing = routeRequest();
    const routerMs = Date.now() - routingStartedAt;
    recordStageLatency('router', routerMs, providerName);

    logger.info({
      chatId: msg.chatId,
      model: routing.model,
    }, 'Routing decision');

    const traceBase = createTraceBase({
      chatId: msg.chatId,
      groupFolder: group.folder,
      userId: msg.senderId,
      inputText: prompt,
      source: 'dotclaw'
    });

    logger.info({
      group: group.name,
      messageCount: missedMessages.length,
      promptMessageCount: selectedMessages.length,
      omittedPromptMessages
    }, 'Processing message');

    void emitHook('message:processing', {
      chat_id: msg.chatId,
      message_id: msg.messageId,
      sender_id: msg.senderId,
      group_folder: group.folder,
      message_count: missedMessages.length,
      prompt_message_count: selectedMessages.length,
      omitted_prompt_messages: omittedPromptMessages
    });

    const provider = deps.registry.getProviderForChat(msg.chatId);
    await provider.setTyping(msg.chatId);
    const recallQuery = selectedMessages.map(entry => entry.content).join('\n');

    let output: ContainerOutput | null = null;
    let context: AgentContext | null = null;
    let errorMessage: string | null = null;

    // Set up streaming delivery
    const streaming = runtime.streaming.enabled
      ? new StreamingDelivery(provider, msg.chatId, runtime.streaming, {
        threadId: msg.threadId,
        replyToMessageId,
      })
      : null;

    // Refresh typing indicator (cleared on first stream chunk or completion)
    const typingInterval = setInterval(() => { void provider.setTyping(msg.chatId); }, 4_000);

    const abortController = new AbortController();
    activeRuns.set(msg.chatId, abortController);

    // Prepare stream directory for IPC-based streaming
    let streamDir: string | undefined;
    if (runtime.streaming.enabled) {
      const { DATA_DIR } = await import('./config.js');
      streamDir = path.join(DATA_DIR, 'ipc', group.folder, 'stream', traceBase.trace_id);
      fs.mkdirSync(streamDir, { recursive: true });
    }

    try {
      // Launch agent run (single call — no probes, no retries)
      const executionPromise = executeAgentRun({
        group,
        prompt,
        chatJid: msg.chatId,
        userId: msg.senderId,
        userName: msg.senderName,
        recallQuery: recallQuery || msg.content,
        recallMaxResults: routing.recallMaxResults,
        recallMaxTokens: routing.recallMaxTokens,
        sessionId: sessions[group.folder],
        onSessionUpdate: (sessionId) => { deps.setSession(group.folder, sessionId); },
        availableGroups: deps.buildAvailableGroupsSnapshot(),
        modelFallbacks: routing.fallbacks,
        reasoningEffort: runtime.reasoningEffort,
        modelMaxOutputTokens: routing.maxOutputTokens || undefined,
        maxToolSteps: routing.maxToolSteps,
        lane: 'interactive',
        attachments: containerAttachments,
        abortSignal: abortController.signal,
        streamDir,
      });

      // Concurrently watch stream chunks and deliver in real-time
      if (streaming && streamDir) {
        const chunkWatcher = (async () => {
          try {
            let firstChunk = true;
            for await (const chunk of watchStreamChunks(streamDir!, abortController.signal)) {
              if (firstChunk) {
                clearInterval(typingInterval);
                firstChunk = false;
              }
              await streaming.onChunk(chunk);
            }
          } catch (err) {
            // Stream watching errors are non-fatal
            if (!(err instanceof Error && err.name === 'AbortError')) {
              logger.debug({ chatId: msg.chatId, err }, 'Stream chunk watcher error');
            }
          }
        })();

        // Wait for agent to complete
        const execution = await executionPromise;
        output = execution.output;
        context = execution.context;

        // Wait briefly for any remaining chunks
        await Promise.race([chunkWatcher, sleep(500)]);
      } else {
        const execution = await executionPromise;
        output = execution.output;
        context = execution.context;
      }

      if (output.status === 'error') {
        errorMessage = output.error || 'Unknown error';
      }
    } catch (err) {
      // Check if run was interrupted by a new message
      if (abortController.signal.aborted && abortController.signal.reason === 'interrupted') {
        logger.debug({ chatId: msg.chatId }, 'Run interrupted by new message');
        if (streaming) {
          try { await streaming.cleanup(); } catch { /* best effort */ }
        }
        clearInterval(typingInterval);
        activeRuns.delete(msg.chatId);
        if (streamDir) {
          try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        return false;
      }
      if (err instanceof AgentExecutionError) {
        context = err.context;
        errorMessage = err.message;
      } else {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      logger.error({ group: group.name, err }, 'Agent error');
    } finally {
      clearInterval(typingInterval);
      activeRuns.delete(msg.chatId);
      // Clean up stream directory
      if (streamDir) {
        try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    const extraTimings: Record<string, number> = {};
    extraTimings.router_ms = routerMs;

    if (!output) {
      const message = errorMessage || 'No output from agent';
      // Retry transient errors (rate limits, timeouts, 5xx) instead of showing to user
      if (isTransientError(message)) {
        if (streaming) {
          try { await streaming.cleanup(); } catch { /* best effort */ }
        }
        throw new RetryableMessageProcessingError(message);
      }
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
        const { writeTrace } = await import('./trace-writer.js');
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
      const userMessage = humanizeError(errorMessage || 'Unknown error');
      // Finalize streaming or send error
      if (streaming) {
        await streaming.finalize(userMessage);
      } else {
        await sendMessageForQueue(msg.chatId, userMessage, { threadId: msg.threadId, replyToMessageId });
      }
      return false;
    }

    if (output.status === 'error') {
      const errorText = errorMessage || output.error || 'Unknown error';
      // Retry transient errors (rate limits, timeouts, 5xx) instead of showing to user
      if (isTransientError(errorText)) {
        if (streaming) {
          try { await streaming.cleanup(); } catch { /* best effort */ }
        }
        throw new RetryableMessageProcessingError(errorText);
      }
      if (context) {
        recordAgentTelemetry({
          traceBase,
          output,
          context,
          metricsSource: providerName,
          toolAuditSource: 'message',
          errorMessage: errorText,
          errorType: 'agent',
          extraTimings
        });
      }
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      const userMessage = humanizeError(errorText);
      if (streaming) {
        await streaming.finalize(userMessage);
      } else {
        await sendMessageForQueue(msg.chatId, userMessage, { threadId: msg.threadId, replyToMessageId });
      }
      return false;
    }

    updateChatState(msg.chatId, msg.timestamp, msg.messageId);

    // Resolve reply target: container can override with [[reply_to:...]] tags
    const resolvedReplyTo = (() => {
      if (!output.replyToId) return replyToMessageId;
      if (output.replyToId === '__current__') return replyToMessageId;
      return output.replyToId;
    })();

    if (output.result && output.result.trim() && isSilentReply(output.result)) {
      logger.debug({ chatId: msg.chatId }, 'Agent returned NO_REPLY — suppressing message');
      if (streaming) {
        try { await streaming.cleanup(); } catch { /* best effort */ }
      }
      // Skip sending; still record telemetry below
    } else if (output.result && output.result.trim()) {
      const hasVoiceAttachment = selectedMessages.some(m => {
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
            if (streaming) {
              await streaming.finalize(output.result);
            } else {
              await sendMessageForQueue(msg.chatId, output.result, { threadId: msg.threadId, replyToMessageId: resolvedReplyTo });
            }
          }
        } else {
          if (streaming) {
            await streaming.finalize(output.result);
          } else {
            await sendMessageForQueue(msg.chatId, output.result, { threadId: msg.threadId, replyToMessageId: resolvedReplyTo });
          }
        }
      } else {
        // Finalize streaming with the complete text, or send normally
        if (streaming) {
          const sentMessageId = await streaming.finalize(output.result);
          if (sentMessageId) {
            try {
              linkMessageToTrace(sentMessageId, msg.chatId, traceBase.trace_id);
            } catch {
              // Don't fail if linking fails
            }
          }
        } else {
          const sendResult = await sendMessageForQueue(msg.chatId, output.result, { threadId: msg.threadId, replyToMessageId: resolvedReplyTo });
          const sentMessageId = sendResult.messageId;
          if (sentMessageId) {
            try {
              linkMessageToTrace(sentMessageId, msg.chatId, traceBase.trace_id);
            } catch {
              // Don't fail if linking fails
            }
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
      const fallbackText = "I used some tools but wasn't able to produce a final response. Could you try rephrasing or ask me to continue?";
      output.result = fallbackText;
      if (streaming) {
        await streaming.finalize(fallbackText);
      } else {
        await sendMessageForQueue(
          msg.chatId,
          fallbackText,
          { threadId: msg.threadId, replyToMessageId: resolvedReplyTo }
        );
      }
    } else {
      logger.warn({ chatId: msg.chatId }, 'Agent returned empty/whitespace response');
      const fallbackText = "I wasn't able to come up with a response. Could you try rephrasing?";
      output.result = fallbackText;
      if (streaming) {
        await streaming.finalize(fallbackText);
      } else {
        await sendMessageForQueue(msg.chatId, fallbackText, { threadId: msg.threadId, replyToMessageId: resolvedReplyTo });
      }
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
