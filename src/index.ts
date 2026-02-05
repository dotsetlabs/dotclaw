import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,  TIMEZONE,
  CONTAINER_MODE,
  WARM_START_ENABLED,
  ENV_PATH,
  BATCH_WINDOW_MS
} from './config.js';

// Load .env from the canonical location (~/.dotclaw/.env)
dotenv.config({ path: ENV_PATH });
import { RegisteredGroup, Session, BackgroundJobStatus } from './types.js';
import {
  initDatabase,
  closeDatabase,
  storeMessage,
  upsertChat,
  getMessagesSinceCursor,
  getChatState,
  updateChatState,
  createTask,
  updateTask,
  deleteTask,
  getTaskById,
  getAllGroupSessions,
  setGroupSession,
  deleteGroupSession,
  pauseTasksForGroup,
  getBackgroundJobQueuePosition,
  getBackgroundJobQueueDepth,
  linkMessageToTrace,
  getTraceIdForMessage,
  recordUserFeedback,
  enqueueMessageItem,
  claimBatchForChat,
  completeQueuedMessages,
  failQueuedMessages,
  getChatsWithPendingMessages,
  resetStalledMessages
} from './db.js';
import { startSchedulerLoop, stopSchedulerLoop, runTaskNow } from './task-scheduler.js';
import {
  startBackgroundJobLoop,
  stopBackgroundJobLoop,
  spawnBackgroundJob,
  getBackgroundJobStatus,
  listBackgroundJobsForGroup,
  cancelBackgroundJob,
  recordBackgroundJobUpdate
} from './background-jobs.js';
import type { ContainerOutput } from './container-protocol.js';
import type { AgentContext } from './agent-context.js';
import { loadJson, saveJson, isSafeGroupFolder } from './utils.js';
import { writeTrace } from './trace-writer.js';
import { formatTelegramMessage, TELEGRAM_PARSE_MODE } from './telegram-format.js';
import {
  initMemoryStore,
  getMemoryStats,
  upsertMemoryItems,
  searchMemories,
  listMemories,
  forgetMemories,
  cleanupExpiredMemories,
  MemoryScope,
  MemoryType,
  MemoryItemInput
} from './memory-store.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory-embeddings.js';
import { createProgressManager, DEFAULT_PROGRESS_MESSAGES, DEFAULT_PROGRESS_STAGES, formatProgressWithPlan, formatPlanStepList } from './progress.js';
import { parseAdminCommand } from './admin-commands.js';
import { loadModelRegistry, saveModelRegistry } from './model-registry.js';
import { startMetricsServer, stopMetricsServer, recordMessage, recordError, recordRoutingDecision, recordStageLatency } from './metrics.js';
import { startMaintenanceLoop, stopMaintenanceLoop } from './maintenance.js';
import { warmGroupContainer, startDaemonHealthCheckLoop, stopDaemonHealthCheckLoop, cleanupInstanceContainers } from './container-runner.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { logger } from './logger.js';
import { startDashboard, stopDashboard, setTelegramConnected, setLastMessageTime, setMessageQueueDepth } from './dashboard.js';
import { humanizeError } from './error-messages.js';
import { classifyBackgroundJob } from './background-job-classifier.js';
import { routeRequest, routePrompt } from './request-router.js';
import { probePlanner } from './planner-probe.js';
import { generateId } from './id.js';

const runtime = loadRuntimeConfig();

function buildTriggerRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function buildAvailableGroupsSnapshot(): Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }> {
  return Object.entries(registeredGroups).map(([jid, info]) => ({
    jid,
    name: info.name,
    lastActivity: getChatState(jid)?.last_agent_timestamp || info.added_at,
    isRegistered: true
  }));
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return value === 'user' || value === 'group' || value === 'global';
}

function isMemoryType(value: unknown): value is MemoryType {
  return value === 'identity'
    || value === 'preference'
    || value === 'fact'
    || value === 'relationship'
    || value === 'project'
    || value === 'task'
    || value === 'note'
    || value === 'archive';
}

function isMemoryKind(value: unknown): value is 'semantic' | 'episodic' | 'procedural' | 'preference' {
  return value === 'semantic'
    || value === 'episodic'
    || value === 'procedural'
    || value === 'preference';
}

function clampInputMessage(content: string, maxChars: number): string {
  if (!content) return '';
  if (!Number.isFinite(maxChars) || maxChars <= 0) return content;
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[Message truncated for length]`;
}

function coerceMemoryItems(input: unknown): MemoryItemInput[] {
  if (!Array.isArray(input)) return [];
  const items: MemoryItemInput[] = [];

  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const scope = raw.scope;
    const type = raw.type;
    const kind = raw.kind;
    const content = raw.content;
    if (!isMemoryScope(scope) || !isMemoryType(type) || typeof content !== 'string' || !content.trim()) {
      continue;
    }

    items.push({
      scope,
      type,
      kind: isMemoryKind(kind) ? kind : undefined,
      conflict_key: typeof raw.conflict_key === 'string' ? raw.conflict_key : undefined,
      content: content.trim(),
      subject_id: typeof raw.subject_id === 'string' ? raw.subject_id : null,
      importance: typeof raw.importance === 'number' ? raw.importance : undefined,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
      ttl_days: typeof raw.ttl_days === 'number' ? raw.ttl_days : undefined,
      source: typeof raw.source === 'string' ? raw.source : undefined,
      metadata: isRecord(raw.metadata) ? raw.metadata : undefined
    });
  }

  return items;
}

// Rate limiting configuration
const RATE_LIMIT_MAX_MESSAGES = 20; // Max messages per user per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const rateLimiter = new Map<string, RateLimitEntry>();

function checkRateLimit(userId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimiter.get(userId);

  if (!entry || now > entry.resetAt) {
    // New window
    rateLimiter.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_MESSAGES) {
    // Rate limited
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  // Increment counter
  entry.count += 1;
  return { allowed: true };
}

function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimiter.entries()) {
    if (now > entry.resetAt) {
      rateLimiter.delete(key);
    }
  }
}

// Clean up expired rate limit entries periodically
setInterval(cleanupRateLimiter, 60_000);

const TELEGRAM_HANDLER_TIMEOUT_MS = runtime.host.telegram.handlerTimeoutMs;
const TELEGRAM_SEND_RETRIES = runtime.host.telegram.sendRetries;
const TELEGRAM_SEND_RETRY_DELAY_MS = runtime.host.telegram.sendRetryDelayMs;
const MEMORY_RECALL_MAX_RESULTS = runtime.host.memory.recall.maxResults;
const MEMORY_RECALL_MAX_TOKENS = runtime.host.memory.recall.maxTokens;
const INPUT_MESSAGE_MAX_CHARS = runtime.host.telegram.inputMessageMaxChars;
const HEARTBEAT_ENABLED = runtime.host.heartbeat.enabled;
const HEARTBEAT_INTERVAL_MS = runtime.host.heartbeat.intervalMs;
const HEARTBEAT_GROUP_FOLDER = (runtime.host.heartbeat.groupFolder || MAIN_GROUP_FOLDER).trim() || MAIN_GROUP_FOLDER;
const BACKGROUND_JOBS_ENABLED = runtime.host.backgroundJobs.enabled;
const AUTO_SPAWN_CONFIG = runtime.host.backgroundJobs.autoSpawn;
const AUTO_SPAWN_ENABLED = BACKGROUND_JOBS_ENABLED && AUTO_SPAWN_CONFIG.enabled;
const AUTO_SPAWN_FOREGROUND_TIMEOUT_MS = AUTO_SPAWN_CONFIG.foregroundTimeoutMs;
const AUTO_SPAWN_ON_TIMEOUT = AUTO_SPAWN_CONFIG.onTimeout;
const AUTO_SPAWN_ON_TOOL_LIMIT = AUTO_SPAWN_CONFIG.onToolLimit;
const AUTO_SPAWN_CLASSIFIER_ENABLED = AUTO_SPAWN_CONFIG.classifier.enabled;
const TOOL_CALL_FALLBACK_PATTERN = /tool calls? but did not get a final response/i;

// Initialize Telegram bot with extended timeout for long-running agent tasks
const telegrafBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
  handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS
});
telegrafBot.catch((err, ctx) => {
  logger.error({ err, chatId: ctx?.chat?.id }, 'Unhandled Telegraf error');
});

let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;
const TELEGRAM_SEND_DELAY_MS = 250;

const activeDrains = new Set<string>();
const activeRuns = new Map<string, AbortController>();

function isCancelMessage(content: string): boolean {
  if (!content) return false;
  const normalized = content.trim().toLowerCase();
  return normalized === 'cancel'
    || normalized === 'stop'
    || normalized === 'abort'
    || normalized === 'cancel request'
    || normalized === 'stop request';
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
    case 'planning':
      return 1;
    case 'searching':
      return Math.min(2, totalSteps);
    case 'coding':
      return Math.min(Math.max(2, Math.ceil(totalSteps * 0.6)), totalSteps);
    case 'drafting':
      return Math.min(Math.max(2, Math.ceil(totalSteps * 0.8)), totalSteps);
    case 'finalizing':
      return totalSteps;
    default:
      return 1;
  }
}

async function setTyping(chatId: string): Promise<void> {
  try {
    await telegrafBot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to set typing indicator');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBotMentioned(
  text: string,
  entities: Array<{ offset: number; length: number; type: string; user?: { id: number } }> | undefined,
  botUsername: string,
  botId?: number
): boolean {
  if (!entities || entities.length === 0) return false;
  const normalized = botUsername ? botUsername.toLowerCase() : '';
  for (const entity of entities) {
    const segment = text.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === 'mention') {
      if (segment.toLowerCase() === `@${normalized}`) return true;
    }
    if (entity.type === 'text_mention' && botId && entity.user?.id === botId) return true;
    if (entity.type === 'bot_command') {
      if (segment.toLowerCase().includes(`@${normalized}`)) return true;
    }
  }
  return false;
}

function isBotReplied(message: { reply_to_message?: { from?: { id?: number } } } | undefined, botId?: number): boolean {
  if (!message?.reply_to_message?.from?.id || !botId) return false;
  return message.reply_to_message.from.id === botId;
}

function getTelegramErrorCode(err: unknown): number | null {
  const anyErr = err as { code?: number; response?: { error_code?: number } };
  if (typeof anyErr?.code === 'number') return anyErr.code;
  if (typeof anyErr?.response?.error_code === 'number') return anyErr.response.error_code;
  return null;
}

function getTelegramRetryAfterMs(err: unknown): number | null {
  const anyErr = err as { parameters?: { retry_after?: number | string }; response?: { parameters?: { retry_after?: number | string } } };
  const retryAfter = anyErr?.parameters?.retry_after ?? anyErr?.response?.parameters?.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) return retryAfter * 1000;
  if (typeof retryAfter === 'string') {
    const parsed = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(parsed)) return parsed * 1000;
  }
  return null;
}

function isRetryableTelegramError(err: unknown): boolean {
  const code = getTelegramErrorCode(err);
  if (code === 429) return true;
  if (code && code >= 500 && code < 600) return true;
  const anyErr = err as { code?: string };
  if (!anyErr?.code) return false;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(anyErr.code);
}

function loadState(): void {
  sessions = {};
  const loadedGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  const sanitizedGroups: Record<string, RegisteredGroup> = {};
  const usedFolders = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const [chatId, group] of Object.entries(loadedGroups as Record<string, RegisteredGroup>)) {
    if (!group || typeof group !== 'object') {
      logger.warn({ chatId }, 'Skipping registered group with invalid entry');
      invalidCount += 1;
      continue;
    }
    if (typeof group.name !== 'string' || group.name.trim() === '') {
      logger.warn({ chatId }, 'Skipping registered group with invalid name');
      invalidCount += 1;
      continue;
    }
    if (!isSafeGroupFolder(group.folder, GROUPS_DIR)) {
      logger.warn({ chatId, folder: group.folder }, 'Skipping registered group with invalid folder');
      invalidCount += 1;
      continue;
    }
    if (usedFolders.has(group.folder)) {
      logger.warn({ chatId, folder: group.folder }, 'Skipping registered group with duplicate folder');
      duplicateCount += 1;
      continue;
    }
    usedFolders.add(group.folder);
    sanitizedGroups[chatId] = group;
  }

  registeredGroups = sanitizedGroups;
  if (invalidCount > 0 || duplicateCount > 0) {
    logger.error({ invalidCount, duplicateCount }, 'Registered groups contained invalid or duplicate folders');
  }
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
  const finalSessions = getAllGroupSessions();
  sessions = finalSessions.reduce<Session>((acc, row) => {
    acc[row.group_folder] = row.session_id;
    return acc;
  }, {});
}

function registerGroup(chatId: string, group: RegisteredGroup): void {
  if (!isSafeGroupFolder(group.folder, GROUPS_DIR)) {
    logger.warn({ chatId, folder: group.folder }, 'Refusing to register group with invalid folder');
    return;
  }
  const folderCollision = Object.values(registeredGroups).some(g => g.folder === group.folder);
  if (folderCollision) {
    logger.warn({ chatId, folder: group.folder }, 'Refusing to register group with duplicate folder');
    return;
  }
  registeredGroups[chatId] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group registered');

  if (CONTAINER_MODE === 'daemon' && WARM_START_ENABLED) {
    try {
      warmGroupContainer(group, group.folder === MAIN_GROUP_FOLDER);
      logger.info({ group: group.folder }, 'Warmed daemon container for new group');
    } catch (err) {
      logger.warn({ group: group.folder, err }, 'Failed to warm container for new group');
    }
  }
}

function listRegisteredGroups(): Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }> {
  return Object.entries(registeredGroups).map(([chatId, group]) => ({
    chat_id: chatId,
    name: group.name,
    folder: group.folder,
    trigger: group.trigger,
    added_at: group.added_at
  }));
}

function resolveGroupIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  for (const [chatId, group] of Object.entries(registeredGroups)) {
    if (chatId === trimmed) return chatId;
    if (group.name.toLowerCase() === normalized) return chatId;
    if (group.folder.toLowerCase() === normalized) return chatId;
  }
  return null;
}

function unregisterGroup(identifier: string): { ok: boolean; error?: string; group?: RegisteredGroup & { chat_id: string } } {
  const chatId = resolveGroupIdentifier(identifier);
  if (!chatId) {
    return { ok: false, error: 'Group not found' };
  }
  const group = registeredGroups[chatId];
  if (!group) {
    return { ok: false, error: 'Group not found' };
  }
  if (group.folder === MAIN_GROUP_FOLDER) {
    return { ok: false, error: 'Cannot remove main group' };
  }

  delete registeredGroups[chatId];
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  delete sessions[group.folder];
  deleteGroupSession(group.folder);
  pauseTasksForGroup(group.folder);

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group removed');

  return { ok: true, group: { ...group, chat_id: chatId } };
}

function splitPlainText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

async function sendMessage(
  chatId: string,
  text: string,
  options?: { messageThreadId?: number; parseMode?: string | null }
): Promise<{ success: boolean; messageId?: string }> {
  const parseMode = options?.parseMode === undefined ? TELEGRAM_PARSE_MODE : options.parseMode;
  const chunks = parseMode
    ? formatTelegramMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH)
    : splitPlainText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  let firstMessageId: string | undefined;
  const sendChunk = async (chunk: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= TELEGRAM_SEND_RETRIES; attempt += 1) {
      try {
        const payload: Record<string, unknown> = {};
        if (parseMode) payload.parse_mode = parseMode;
        if (options?.messageThreadId) payload.message_thread_id = options.messageThreadId;
        const sent = await telegrafBot.telegram.sendMessage(chatId, chunk, payload);
        if (!firstMessageId) {
          firstMessageId = String(sent.message_id);
        }
        return true;
      } catch (err) {
        const retryAfterMs = getTelegramRetryAfterMs(err);
        const retryable = isRetryableTelegramError(err);
        if (!retryable || attempt === TELEGRAM_SEND_RETRIES) {
          logger.error({ chatId, attempt, err }, 'Failed to send Telegram message chunk');
          return false;
        }
        const delayMs = retryAfterMs ?? (TELEGRAM_SEND_RETRY_DELAY_MS * attempt);
        logger.warn({ chatId, attempt, delayMs }, 'Telegram send failed; retrying');
        await sleep(delayMs);
      }
    }
    return false;
  };

  try {
    // Telegram bots send messages as themselves, no prefix needed
    for (let i = 0; i < chunks.length; i += 1) {
      const ok = await sendChunk(chunks[i]);
      if (!ok) return { success: false };
      if (i < chunks.length - 1) {
        await sleep(TELEGRAM_SEND_DELAY_MS);
      }
    }
    logger.info({ chatId, length: text.length }, 'Message sent');
    return { success: true, messageId: firstMessageId };
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
    return { success: false };
  }
}

interface TelegramMessage {
  chatId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: string;
  isGroup: boolean;
  chatType: string;
  messageThreadId?: number;
}

function enqueueMessage(msg: TelegramMessage): void {
  if (isCancelMessage(msg.content)) {
    const controller = activeRuns.get(msg.chatId);
    if (controller) {
      controller.abort();
      activeRuns.delete(msg.chatId);
      void sendMessage(msg.chatId, 'Canceled the current request.', { messageThreadId: msg.messageThreadId });
      return;
    }
    void sendMessage(msg.chatId, 'There is no active request to cancel.', { messageThreadId: msg.messageThreadId });
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
    message_thread_id: msg.messageThreadId
  });
  setMessageQueueDepth(activeDrains.size);
  if (!activeDrains.has(msg.chatId)) {
    void drainQueue(msg.chatId);
  }
}

async function drainQueue(chatId: string): Promise<void> {
  if (activeDrains.has(chatId)) return;
  activeDrains.add(chatId);
  setMessageQueueDepth(activeDrains.size);
  try {
    while (true) {
      const batch = claimBatchForChat(chatId, BATCH_WINDOW_MS);
      if (batch.length === 0) break;
      const last = batch[batch.length - 1];
      const triggerMsg: TelegramMessage = {
        chatId: last.chat_jid,
        messageId: last.message_id,
        senderId: last.sender_id,
        senderName: last.sender_name,
        content: last.content,
        timestamp: last.timestamp,
        isGroup: last.is_group === 1,
        chatType: last.chat_type,
        messageThreadId: last.message_thread_id ?? undefined
      };
      const batchIds = batch.map(b => b.id);
      try {
        await processMessage(triggerMsg);
        completeQueuedMessages(batchIds);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        failQueuedMessages(batchIds, errMsg);
        logger.error({ chatId, err }, 'Error processing message batch');
      }
    }
  } finally {
    activeDrains.delete(chatId);
    setMessageQueueDepth(activeDrains.size);
  }
}

async function processMessage(msg: TelegramMessage): Promise<boolean> {
  const group = registeredGroups[msg.chatId];
  if (!group) {
    logger.debug({ chatId: msg.chatId }, 'Message from unregistered Telegram chat');
    return false;
  }
  recordMessage('telegram');
  setLastMessageTime(msg.timestamp);

  // Get messages since last agent interaction, filtered to only include
  // messages up to and including the triggering message (not future queued ones)
  const chatState = getChatState(msg.chatId);
  let missedMessages = getMessagesSinceCursor(
    msg.chatId,
    chatState?.last_agent_timestamp || null,
    chatState?.last_agent_message_id || null
  );
  missedMessages = missedMessages.filter(m =>
    m.timestamp < msg.timestamp ||
    (m.timestamp === msg.timestamp && m.id <= msg.messageId)
  );
  if (missedMessages.length === 0) {
    logger.warn({ chatId: msg.chatId }, 'No missed messages found; falling back to current message');
    missedMessages = [{
      id: msg.messageId,
      chat_jid: msg.chatId,
      sender: msg.senderId,
      sender_name: msg.senderName,
      content: msg.content,
      timestamp: msg.timestamp
    }];
  }

  const lines = missedMessages.map(m => {
    // Escape XML special characters in content
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const safeContent = clampInputMessage(m.content, INPUT_MESSAGE_MAX_CHARS);
    return `<message sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" time="${m.timestamp}">${escapeXml(safeContent)}</message>`;
  });
  const prompt = `<messages>
${lines.join('\n')}
</messages>`;
  const lastMessage = missedMessages[missedMessages.length - 1];

  const routingStartedAt = Date.now();
  const routingDecision = routeRequest({
    prompt,
    lastMessage
  });
  recordRoutingDecision(routingDecision.profile);
  const routerMs = Date.now() - routingStartedAt;
  recordStageLatency('router', routerMs, 'telegram');
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

  await setTyping(msg.chatId);
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

  const maybeAutoSpawn = async (
    reason: 'timeout' | 'tool_limit' | 'classifier' | 'router' | 'planner',
    detail?: string | null,
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
    const result = spawnBackgroundJob({
      prompt,
      groupFolder: group.folder,
      chatJid: msg.chatId,
      contextMode: 'group',
      tags,
      parentTraceId: traceBase.trace_id,
      parentMessageId: msg.messageId,
      modelOverride: overrides?.modelOverride ?? routingDecision.modelOverride,
      maxToolSteps: overrides?.maxToolSteps ?? routingDecision.maxToolSteps,
      toolAllow: routingDecision.toolAllow,
      toolDeny: routingDecision.toolDeny,
      timeoutMs: overrides?.timeoutMs ?? computedTimeoutMs
    });
    if (!result.ok || !result.jobId) {
      logger.warn({ chatId: msg.chatId, reason, error: result.error }, 'Auto-spawn background job failed');
      return false;
    }

    const queuePosition = getBackgroundJobQueuePosition({ jobId: result.jobId, groupFolder: group.folder });
    const eta = routingDecision.estimatedMinutes ? `${routingDecision.estimatedMinutes} min` : null;
    const detailLine = detail ? `\n\nReason: ${detail}` : '';
    const queueLine = queuePosition ? `\n\nQueue position: ${queuePosition.position} of ${queuePosition.total}` : '';
    const etaLine = eta ? `\n\nEstimated time: ${eta}` : '';
    const planPreview = plannerProbeSteps.length > 0
      ? formatPlanStepList({ steps: plannerProbeSteps, currentStep: 1, maxSteps: 4 })
      : '';
    const planLine = planPreview ? `\n\nPlanned steps:\n${planPreview}` : '';
    await sendMessage(
      msg.chatId,
      `Queued this as background job ${result.jobId}. I'll report back when it's done. You can keep chatting while it runs.${queueLine}${etaLine}${detailLine}${planLine}`,
      { messageThreadId: msg.messageThreadId }
    );

    updateChatState(msg.chatId, msg.timestamp, msg.messageId);
    return true;
  };

  let plannerProbeTools: string[] = [];
  let plannerProbeSteps: string[] = [];
  let plannerProbeMs: number | null = null;
  if (shouldPlannerProbe() && lastMessage) {
    const probeStarted = Date.now();
    const probeResult = await probePlanner({
      lastMessage,
      recentMessages: missedMessages
    });
    plannerProbeMs = Date.now() - probeStarted;
    recordStageLatency('planner_probe', plannerProbeMs, 'telegram');
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

  if (routingDecision.shouldBackground) {
    const autoSpawned = await maybeAutoSpawn('router', routingDecision.reason);
    if (autoSpawned) {
      return true;
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
        metricsSource: 'telegram'
      });
      if (classifierResult.latencyMs) {
        classifierMs = classifierResult.latencyMs;
        recordStageLatency('classifier', classifierResult.latencyMs, 'telegram');
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
        if (autoSpawned) {
          return true;
        }
      }
    } catch (err) {
      logger.warn({ chatId: msg.chatId, err }, 'Background job classifier failed');
    }
  }

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
    send: async (text) => { await sendMessage(msg.chatId, text, { messageThreadId: msg.messageThreadId }); },
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
      onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
      availableGroups: buildAvailableGroupsSnapshot(),
      modelOverride: routingDecision.modelOverride,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      disablePlanner: !routingDecision.enablePlanner,
      disableResponseValidation: !routingDecision.enableResponseValidation,
      responseValidationMaxRetries: routingDecision.responseValidationMaxRetries,
      disableMemoryExtraction: !routingDecision.enableMemoryExtraction,
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
        metricsSource: 'telegram',
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
      if (autoSpawned) {
        return true;
      }
    }
    const userMessage = humanizeError(errorMessage || 'Unknown error');
    await sendMessage(msg.chatId, userMessage, { messageThreadId: msg.messageThreadId });
    return false;
  }

  if (output.status === 'error') {
    if (context) {
      recordAgentTelemetry({
        traceBase,
        output,
        context,
        metricsSource: 'telegram',
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
      if (autoSpawned) {
        return true;
      }
    }
    const userMessage = humanizeError(errorText);
    await sendMessage(msg.chatId, userMessage, { messageThreadId: msg.messageThreadId });
    return false;
  }

  updateChatState(msg.chatId, msg.timestamp, msg.messageId);

  if (output.result && output.result.trim()) {
    const sendResult = await sendMessage(msg.chatId, output.result, { messageThreadId: msg.messageThreadId });
    const sentMessageId = sendResult.messageId;
    // Link the sent message to the trace for feedback tracking
    if (sentMessageId) {
      try {
        linkMessageToTrace(sentMessageId, msg.chatId, traceBase.trace_id);
      } catch {
        // Don't fail if linking fails
      }
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
            metricsSource: 'telegram',
            toolAuditSource: 'message',
            extraTimings
          });
        }
        return true;
      }
    }
    await sendMessage(
      msg.chatId,
      'I hit my tool-call step limit before I could finish. If you want me to keep going, please narrow the scope or ask for a specific subtask.',
      { messageThreadId: msg.messageThreadId }
    );
  } else {
    logger.warn({ chatId: msg.chatId }, 'Agent returned empty/whitespace response');
    await sendMessage(msg.chatId, "I wasn't able to generate a response. Please try rephrasing your message.", { messageThreadId: msg.messageThreadId });
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      metricsSource: 'telegram',
      toolAuditSource: 'message',
      extraTimings
    });
  }

  return true;
}


let ipcWatcher: fs.FSWatcher | null = null;
let ipcPollingTimer: NodeJS.Timeout | null = null;
let ipcStopped = false;

function stopIpcWatcher(): void {
  ipcStopped = true;
  if (ipcWatcher) {
    ipcWatcher.close();
    ipcWatcher = null;
  }
  if (ipcPollingTimer) {
    clearTimeout(ipcPollingTimer);
    ipcPollingTimer = null;
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  ipcStopped = false;
  let processing = false;
  let scheduled = false;

  const processIpcFiles = async () => {
    if (processing) return;
    processing = true;
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      processing = false;
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const requestsDir = path.join(ipcBaseDir, sourceGroup, 'requests');
      const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
                  await sendMessage(data.chatJid, data.text);
                  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process request/response IPC for synchronous operations (memory, etc.)
      try {
        if (fs.existsSync(requestsDir)) {
          fs.mkdirSync(responsesDir, { recursive: true });
          const requestFiles = fs.readdirSync(requestsDir).filter(f => f.endsWith('.json'));
          for (const file of requestFiles) {
            const filePath = path.join(requestsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              const response = await processRequestIpc(data, sourceGroup, isMain);
              if (response?.id) {
                const responsePath = path.join(responsesDir, `${response.id}.json`);
                fs.writeFileSync(responsePath, JSON.stringify(response, null, 2));
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC request');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC requests directory');
      }
    }

    processing = false;
  };

  const scheduleProcess = () => {
    if (scheduled || ipcStopped) return;
    scheduled = true;
    setTimeout(async () => {
      scheduled = false;
      if (!ipcStopped) await processIpcFiles();
    }, 100);
  };

  let watcherActive = false;
  try {
    ipcWatcher = fs.watch(ipcBaseDir, { recursive: true }, () => {
      scheduleProcess();
    });
    ipcWatcher.on('error', (err) => {
      logger.warn({ err }, 'IPC watcher error; falling back to polling');
      ipcWatcher?.close();
      ipcWatcher = null;
      if (!ipcPollingTimer && !ipcStopped) {
        const poll = () => {
          if (ipcStopped) return;
          scheduleProcess();
          ipcPollingTimer = setTimeout(poll, IPC_POLL_INTERVAL);
        };
        poll();
      }
    });
    watcherActive = true;
  } catch (err) {
    logger.warn({ err }, 'IPC watch unsupported; falling back to polling');
  }

  if (!watcherActive) {
    const poll = () => {
      if (ipcStopped) return;
      scheduleProcess();
      ipcPollingTimer = setTimeout(poll, IPC_POLL_INTERVAL);
    };
    poll();
  } else {
    scheduleProcess();
  }

  if (ipcPollingTimer) {
    logger.info('IPC watcher started (polling)');
  } else {
    logger.info('IPC watcher started (fs.watch)');
  }
}

async function runHeartbeatOnce(): Promise<void> {
  const entry = Object.entries(registeredGroups).find(([, group]) => group.folder === HEARTBEAT_GROUP_FOLDER);
  if (!entry) {
    logger.warn({ group: HEARTBEAT_GROUP_FOLDER }, 'Heartbeat group not registered');
    return;
  }
  const [chatId, group] = entry;
  const prompt = [
    '[HEARTBEAT]',
    'You are running automatically. Review scheduled tasks, pending reminders, and long-running work.',
    'If you need to communicate, use mcp__dotclaw__send_message. Otherwise, take no user-visible action.'
  ].join('\n');

  const traceBase = createTraceBase({
    chatId,
    groupFolder: group.folder,
    userId: null,
    inputText: prompt,
    source: 'dotclaw-heartbeat'
  });
  const routingStartedAt = Date.now();
  const routingDecision = routePrompt(prompt);
  recordRoutingDecision(routingDecision.profile);
  const routerMs = Date.now() - routingStartedAt;
  recordStageLatency('router', routerMs, 'scheduler');

  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;
  let errorMessage: string | null = null;

  const baseRecallResults = Number.isFinite(routingDecision.recallMaxResults)
    ? Math.max(0, Math.floor(routingDecision.recallMaxResults as number))
    : MEMORY_RECALL_MAX_RESULTS;
  const baseRecallTokens = Number.isFinite(routingDecision.recallMaxTokens)
    ? Math.max(0, Math.floor(routingDecision.recallMaxTokens as number))
    : MEMORY_RECALL_MAX_TOKENS;
  const recallMaxResults = routingDecision.enableMemoryRecall ? Math.max(4, baseRecallResults - 2) : 0;
  const recallMaxTokens = routingDecision.enableMemoryRecall ? Math.max(600, baseRecallTokens - 200) : 0;

  try {
    const execution = await executeAgentRun({
      group,
      prompt,
      chatJid: chatId,
      userId: null,
      recallQuery: prompt,
      recallMaxResults,
      recallMaxTokens,
      sessionId: sessions[group.folder],
      onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
      isScheduledTask: true,
      availableGroups: buildAvailableGroupsSnapshot(),
      modelOverride: routingDecision.modelOverride,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      disablePlanner: !routingDecision.enablePlanner,
      disableResponseValidation: !routingDecision.enableResponseValidation,
      responseValidationMaxRetries: routingDecision.responseValidationMaxRetries,
      disableMemoryExtraction: !routingDecision.enableMemoryExtraction
    });
    output = execution.output;
    context = execution.context;
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
    logger.error({ err }, 'Heartbeat run failed');
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      toolAuditSource: 'heartbeat',
      errorMessage: errorMessage ?? undefined,
      extraTimings: { router_ms: routerMs }
    });
  } else if (errorMessage) {
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
      error_code: errorMessage,
      source: traceBase.source
    });
  }
}


let heartbeatStopped = false;

function stopHeartbeatLoop(): void {
  heartbeatStopped = true;
}

function startHeartbeatLoop(): void {
  if (!HEARTBEAT_ENABLED) return;
  heartbeatStopped = false;
  const loop = async () => {
    if (heartbeatStopped) return;
    try {
      await runHeartbeatOnce();
    } catch (err) {
      logger.error({ err }, 'Heartbeat run failed');
    }
    if (!heartbeatStopped) {
      setTimeout(loop, HEARTBEAT_INTERVAL_MS);
    }
  };
  loop();
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    state_json?: string;
    status?: string;
    identifier?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    model?: string;
    scope?: 'global' | 'group' | 'user';
    target_id?: string;
  },
  sourceGroup: string,
  isMain: boolean
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        // Resolve the correct chat ID for the target group (don't trust IPC payload)
        const targetChatId = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetChatId) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = generateId('task');
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetChatId,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task || (!isMain && task.group_folder !== sourceGroup)) {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task update attempt');
          break;
        }

        const updates: Partial<Pick<typeof task, 'prompt' | 'schedule_type' | 'schedule_value' | 'status' | 'context_mode' | 'state_json' | 'next_run'>> = {};
        if (typeof data.prompt === 'string') updates.prompt = data.prompt;
        if (typeof data.context_mode === 'string') updates.context_mode = data.context_mode as typeof task.context_mode;
        if (typeof data.status === 'string') updates.status = data.status as typeof task.status;
        if (typeof data.state_json === 'string') updates.state_json = data.state_json;

        if (typeof data.schedule_type === 'string' && typeof data.schedule_value === 'string') {
          updates.schedule_type = data.schedule_type as typeof task.schedule_type;
          updates.schedule_value = data.schedule_value;

          let nextRun: string | null = null;
          if (updates.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(updates.schedule_value, { tz: TIMEZONE });
              nextRun = interval.next().toISOString();
            } catch {
              logger.warn({ scheduleValue: updates.schedule_value }, 'Invalid cron expression for update_task');
            }
          } else if (updates.schedule_type === 'interval') {
            const ms = parseInt(updates.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              nextRun = new Date(Date.now() + ms).toISOString();
            }
          } else if (updates.schedule_type === 'once') {
            const scheduled = new Date(updates.schedule_value);
            if (!isNaN(scheduled.getTime())) {
              nextRun = scheduled.toISOString();
            }
          }
          if (nextRun) {
            updates.next_run = nextRun;
          }
        }

        updateTask(data.taskId, updates);
        logger.info({ taskId: data.taskId, sourceGroup }, 'Task updated via IPC');
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    case 'remove_group':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized remove_group attempt blocked');
        break;
      }
      if (!data.identifier || typeof data.identifier !== 'string') {
        logger.warn({ data }, 'Invalid remove_group request - missing identifier');
        break;
      }
      {
        const result = unregisterGroup(data.identifier);
        if (!result.ok) {
          logger.warn({ identifier: data.identifier, error: result.error }, 'Failed to remove group');
        }
      }
      break;

    case 'set_model':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized set_model attempt blocked');
        break;
      }
      if (!data.model || typeof data.model !== 'string') {
        logger.warn({ data }, 'Invalid set_model request - missing model');
        break;
      }
      {
        const defaultModel = runtime.host.defaultModel;
        const config = loadModelRegistry(defaultModel);
        const nextModel = data.model.trim();
        if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(nextModel)) {
          logger.warn({ model: nextModel }, 'Model not in allowlist; refusing set_model');
          break;
        }
        const scope = typeof data.scope === 'string' ? data.scope : 'global';
        const targetId = typeof data.target_id === 'string' ? data.target_id : undefined;
        if (scope === 'user' && !targetId) {
          logger.warn({ data }, 'set_model missing target_id for user scope');
          break;
        }
        if (scope === 'group' && !targetId) {
          logger.warn({ data }, 'set_model missing target_id for group scope');
          break;
        }
        const nextConfig = { ...config };
        if (scope === 'global') {
          nextConfig.model = nextModel;
        } else if (scope === 'group') {
          nextConfig.per_group = nextConfig.per_group || {};
          nextConfig.per_group[targetId!] = { model: nextModel };
        } else if (scope === 'user') {
          nextConfig.per_user = nextConfig.per_user || {};
          nextConfig.per_user[targetId!] = { model: nextModel };
        }
        nextConfig.updated_at = new Date().toISOString();
        saveModelRegistry(nextConfig);
        logger.info({ model: nextModel, scope, targetId }, 'Model updated via IPC');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function processRequestIpc(
  data: {
    id?: string;
    type: string;
    payload?: Record<string, unknown>;
  },
  sourceGroup: string,
  isMain: boolean
): Promise<{ id?: string; ok: boolean; result?: unknown; error?: string }> {
  const requestId = typeof data.id === 'string' ? data.id : undefined;
  const payload = data.payload || {};

  const resolveGroupFolder = (): string => {
    const target = typeof payload.target_group === 'string' ? payload.target_group : null;
    if (target && isMain) return target;
    return sourceGroup;
  };

  try {
    switch (data.type) {
      case 'memory_upsert': {
        const items = coerceMemoryItems(payload.items);
        const groupFolder = resolveGroupFolder();
        const source = typeof payload.source === 'string' ? payload.source : 'agent';
        const results = upsertMemoryItems(groupFolder, items, source);
        return { id: requestId, ok: true, result: { count: results.length } };
      }
      case 'memory_forget': {
        const groupFolder = resolveGroupFolder();
        const ids = Array.isArray(payload.ids) ? (payload.ids as string[]) : undefined;
        const content = typeof payload.content === 'string' ? payload.content : undefined;
        const scope = isMemoryScope(payload.scope) ? payload.scope : undefined;
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const count = forgetMemories({
          groupFolder,
          ids,
          content,
          scope,
          userId
        });
        return { id: requestId, ok: true, result: { count } };
      }
      case 'memory_list': {
        const groupFolder = resolveGroupFolder();
        const scope = isMemoryScope(payload.scope) ? payload.scope : undefined;
        const type = isMemoryType(payload.type) ? payload.type : undefined;
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        const items = listMemories({
          groupFolder,
          scope,
          type,
          userId,
          limit
        });
        return { id: requestId, ok: true, result: { items } };
      }
      case 'memory_search': {
        const groupFolder = resolveGroupFolder();
        const query = typeof payload.query === 'string' ? payload.query : '';
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        const results = searchMemories({
          groupFolder,
          userId,
          query,
          limit
        });
        return { id: requestId, ok: true, result: { items: results } };
      }
      case 'memory_stats': {
        const groupFolder = resolveGroupFolder();
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const stats = getMemoryStats({ groupFolder, userId });
        return { id: requestId, ok: true, result: { stats } };
      }
      case 'list_groups': {
        if (!isMain) {
          return { id: requestId, ok: false, error: 'Only the main group can list groups.' };
        }
        const groups = listRegisteredGroups();
        return { id: requestId, ok: true, result: { groups } };
      }
      case 'run_task': {
        const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
        if (!taskId) {
          return { id: requestId, ok: false, error: 'task_id is required.' };
        }
        const task = getTaskById(taskId);
        if (!task) {
          return { id: requestId, ok: false, error: 'Task not found.' };
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          return { id: requestId, ok: false, error: 'Unauthorized task run attempt.' };
        }
        const result = await runTaskNow(taskId, {
          sendMessage: async (jid, text) => { await sendMessage(jid, text); },
          registeredGroups: () => registeredGroups,
          getSessions: () => sessions,
          setSession: (groupFolder, sessionId) => { sessions[groupFolder] = sessionId; }
        });
        return {
          id: requestId,
          ok: result.ok,
          result: { result: result.result ?? null },
          error: result.ok ? undefined : result.error
        };
      }
      case 'spawn_job': {
        const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
        if (!prompt) {
          return { id: requestId, ok: false, error: 'prompt is required.' };
        }
        const targetGroup = (typeof payload.target_group === 'string' && isMain)
          ? payload.target_group
          : sourceGroup;
        const groupEntry = Object.entries(registeredGroups).find(([, group]) => group.folder === targetGroup);
        if (!groupEntry) {
          return { id: requestId, ok: false, error: 'Target group not registered.' };
        }
        const [chatId, group] = groupEntry;
        const result = spawnBackgroundJob({
          prompt,
          groupFolder: group.folder,
          chatJid: chatId,
          contextMode: (payload.context_mode === 'group' || payload.context_mode === 'isolated')
            ? payload.context_mode
            : undefined,
          timeoutMs: typeof payload.timeout_ms === 'number' ? payload.timeout_ms : undefined,
          maxToolSteps: typeof payload.max_tool_steps === 'number' ? payload.max_tool_steps : undefined,
          toolAllow: Array.isArray(payload.tool_allow) ? payload.tool_allow as string[] : undefined,
          toolDeny: Array.isArray(payload.tool_deny) ? payload.tool_deny as string[] : undefined,
          modelOverride: typeof payload.model_override === 'string' ? payload.model_override : undefined,
          priority: typeof payload.priority === 'number' ? payload.priority : undefined,
          tags: Array.isArray(payload.tags) ? payload.tags as string[] : undefined,
          parentTraceId: typeof payload.parent_trace_id === 'string' ? payload.parent_trace_id : undefined,
          parentMessageId: typeof payload.parent_message_id === 'string' ? payload.parent_message_id : undefined
        });
        return {
          id: requestId,
          ok: result.ok,
          result: result.ok ? { job_id: result.jobId } : undefined,
          error: result.ok ? undefined : result.error
        };
      }
      case 'job_status': {
        const jobId = typeof payload.job_id === 'string' ? payload.job_id : '';
        if (!jobId) {
          return { id: requestId, ok: false, error: 'job_id is required.' };
        }
        const job = getBackgroundJobStatus(jobId);
        if (!job) {
          return { id: requestId, ok: false, error: 'Job not found.' };
        }
        if (!isMain && job.group_folder !== sourceGroup) {
          return { id: requestId, ok: false, error: 'Unauthorized job status request.' };
        }
        return { id: requestId, ok: true, result: { job } };
      }
      case 'list_jobs': {
        const targetGroup = (typeof payload.target_group === 'string' && isMain)
          ? payload.target_group
          : sourceGroup;
        const statusRaw = typeof payload.status === 'string' ? payload.status : undefined;
        const allowedStatuses: BackgroundJobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out'];
        const status = statusRaw && allowedStatuses.includes(statusRaw as BackgroundJobStatus)
          ? (statusRaw as BackgroundJobStatus)
          : undefined;
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        const jobs = listBackgroundJobsForGroup({ groupFolder: targetGroup, status, limit });
        return { id: requestId, ok: true, result: { jobs } };
      }
      case 'cancel_job': {
        const jobId = typeof payload.job_id === 'string' ? payload.job_id : '';
        if (!jobId) {
          return { id: requestId, ok: false, error: 'job_id is required.' };
        }
        const job = getBackgroundJobStatus(jobId);
        if (!job) {
          return { id: requestId, ok: false, error: 'Job not found.' };
        }
        if (!isMain && job.group_folder !== sourceGroup) {
          return { id: requestId, ok: false, error: 'Unauthorized job cancel attempt.' };
        }
        const result = cancelBackgroundJob(jobId);
        return { id: requestId, ok: result.ok, error: result.error };
      }
      case 'job_update': {
        const jobId = typeof payload.job_id === 'string' ? payload.job_id : '';
        const message = typeof payload.message === 'string' ? payload.message.trim() : '';
        const levelRaw = typeof payload.level === 'string' ? payload.level : 'progress';
        const allowedLevels = ['info', 'progress', 'warn', 'error'] as const;
        type JobUpdateLevel = typeof allowedLevels[number];
        const level: JobUpdateLevel = allowedLevels.includes(levelRaw as JobUpdateLevel)
          ? (levelRaw as JobUpdateLevel)
          : 'progress';
        if (!jobId || !message) {
          return { id: requestId, ok: false, error: 'job_id and message are required.' };
        }
        const job = getBackgroundJobStatus(jobId);
        if (!job) {
          return { id: requestId, ok: false, error: 'Job not found.' };
        }
        if (!isMain && job.group_folder !== sourceGroup) {
          return { id: requestId, ok: false, error: 'Unauthorized job update attempt.' };
        }
        const result = recordBackgroundJobUpdate({
          jobId,
          level,
          message,
          data: typeof payload.data === 'object' && payload.data ? payload.data as Record<string, unknown> : undefined
        });
        if (result.ok && payload.notify === true && job.chat_jid) {
          await sendMessage(job.chat_jid, `Background job ${job.id} update:\n\n${message}`);
        }
        return { id: requestId, ok: result.ok, error: result.error };
      }
      default:
        return { id: requestId, ok: false, error: `Unknown request type: ${data.type}` };
    }
  } catch (err) {
    return { id: requestId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatGroups(groups: Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }>): string {
  if (groups.length === 0) return 'No registered groups.';
  const lines = groups.map(group => {
    const trigger = group.trigger ? ` (trigger: ${group.trigger})` : '';
    return `- ${group.name} [${group.folder}] chat=${group.chat_id}${trigger}`;
  });
  return ['Registered groups:', ...lines].join('\n');
}

function applyModelOverride(params: { model: string; scope: 'global' | 'group' | 'user'; targetId?: string }): { ok: boolean; error?: string } {
  const defaultModel = runtime.host.defaultModel;
  const config = loadModelRegistry(defaultModel);
  const nextModel = params.model.trim();
  if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(nextModel)) {
    return { ok: false, error: 'Model not in allowlist' };
  }
  const scope = params.scope || 'global';
  const targetId = params.targetId;
  if (scope === 'user' && !targetId) {
    return { ok: false, error: 'Missing target_id for user scope' };
  }
  if (scope === 'group' && !targetId) {
    return { ok: false, error: 'Missing target_id for group scope' };
  }
  const nextConfig = { ...config };
  if (scope === 'global') {
    nextConfig.model = nextModel;
  } else if (scope === 'group') {
    nextConfig.per_group = nextConfig.per_group || {};
    nextConfig.per_group[targetId!] = { model: nextModel };
  } else if (scope === 'user') {
    nextConfig.per_user = nextConfig.per_user || {};
    nextConfig.per_user[targetId!] = { model: nextModel };
  }
  nextConfig.updated_at = new Date().toISOString();
  saveModelRegistry(nextConfig);
  return { ok: true };
}

async function handleAdminCommand(params: {
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  botUsername?: string;
  messageThreadId?: number;
}): Promise<boolean> {
  const parsed = parseAdminCommand(params.content, params.botUsername);
  if (!parsed) return false;

  const reply = (text: string) => sendMessage(params.chatId, text, { messageThreadId: params.messageThreadId });

  const group = registeredGroups[params.chatId];
  if (!group) {
    await reply('This chat is not registered with DotClaw.');
    return true;
  }

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const command = parsed.command;
  const args = parsed.args;

  const requireMain = (name: string): boolean => {
    if (isMain) return false;
    reply(`${name} is only available in the main group.`).catch(() => undefined);
    return true;
  };

  if (command === 'help') {
    await reply([
      'DotClaw admin commands:',
      '- `/dotclaw help`',
      '- `/dotclaw groups` (main only)',
      '- `/dotclaw add-group <chat_id> <name> [folder]` (main only)',
      '- `/dotclaw remove-group <chat_id|name|folder>` (main only)',
      '- `/dotclaw set-model <model> [global|group|user] [target_id]` (main only)',
      '- `/dotclaw remember <fact>` (main only)',
      '- `/dotclaw style <concise|balanced|detailed>`',
      '- `/dotclaw tools <conservative|balanced|proactive>`',
      '- `/dotclaw caution <low|balanced|high>`',
      '- `/dotclaw memory <strict|balanced|loose>`'
    ].join('\n'));
    return true;
  }

  if (command === 'groups') {
    if (requireMain('Listing groups')) return true;
    await reply(formatGroups(listRegisteredGroups()));
    return true;
  }

  if (command === 'add-group') {
    if (requireMain('Adding groups')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw add-group <chat_id> <name> [folder]');
      return true;
    }
    const jid = args[0];
    if (registeredGroups[jid]) {
      await reply('That chat id is already registered.');
      return true;
    }
    const name = args[1] || `group-${jid}`;
    const folder = args[2] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!isSafeGroupFolder(folder, GROUPS_DIR)) {
      await reply('Invalid folder name. Use lowercase letters, numbers, and dashes only.');
      return true;
    }
    registerGroup(jid, {
      name,
      folder: folder || `group-${jid}`,
      added_at: new Date().toISOString()
    });
    await reply(`Registered group "${name}" with folder "${folder}".`);
    return true;
  }

  if (command === 'remove-group') {
    if (requireMain('Removing groups')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw remove-group <chat_id|name|folder>');
      return true;
    }
    const result = unregisterGroup(args.join(' '));
    if (!result.ok) {
      await reply(`Failed to remove group: ${result.error || 'unknown error'}`);
      return true;
    }
    await reply(`Removed group "${result.group?.name}" (${result.group?.folder}).`);
    return true;
  }

  if (command === 'set-model') {
    if (requireMain('Setting models')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw set-model <model> [global|group|user] [target_id]');
      return true;
    }
    const model = args[0];
    const scopeCandidate = (args[1] || '').toLowerCase();
    const scope = (scopeCandidate === 'global' || scopeCandidate === 'group' || scopeCandidate === 'user')
      ? (scopeCandidate as 'global' | 'group' | 'user')
      : 'global';
    const targetId = args[2] || (scope === 'group' ? group.folder : scope === 'user' ? params.senderId : undefined);
    const result = applyModelOverride({ model, scope, targetId });
    if (!result.ok) {
      await reply(`Failed to set model: ${result.error || 'unknown error'}`);
      return true;
    }
    await reply(`Model set to ${model} (${scope}${targetId ? `:${targetId}` : ''}).`);
    return true;
  }

  if (command === 'remember') {
    if (requireMain('Remembering facts')) return true;
    const fact = args.join(' ').trim();
    if (!fact) {
      await reply('Usage: /dotclaw remember <fact>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'global',
      type: 'fact',
      content: fact,
      importance: 0.7,
      confidence: 0.8,
      tags: ['manual']
    }];
    upsertMemoryItems('global', items, 'admin-command');
    await reply('Saved to global memory.');
    return true;
  }

  if (command === 'style') {
    const style = (args[0] || '').toLowerCase();
    if (!['concise', 'balanced', 'detailed'].includes(style)) {
      await reply('Usage: /dotclaw style <concise|balanced|detailed>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'response_style',
      content: `Prefers ${style} responses.`,
      importance: 0.7,
      confidence: 0.85,
      tags: [`response_style:${style}`],
      metadata: { response_style: style }
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    await reply(`Response style set to ${style}.`);
    return true;
  }

  if (command === 'tools') {
    const level = (args[0] || '').toLowerCase();
    const bias = level === 'proactive' ? 0.7 : level === 'balanced' ? 0.5 : level === 'conservative' ? 0.3 : null;
    if (bias === null) {
      await reply('Usage: /dotclaw tools <conservative|balanced|proactive>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'tool_calling_bias',
      content: `Prefers ${level} tool usage.`,
      importance: 0.65,
      confidence: 0.8,
      tags: [`tool_calling_bias:${bias}`],
      metadata: { tool_calling_bias: bias, bias }
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    await reply(`Tool usage bias set to ${level}.`);
    return true;
  }

  if (command === 'caution') {
    const level = (args[0] || '').toLowerCase();
    const bias = level === 'high' ? 0.7 : level === 'balanced' ? 0.5 : level === 'low' ? 0.35 : null;
    if (bias === null) {
      await reply('Usage: /dotclaw caution <low|balanced|high>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'caution_bias',
      content: `Prefers ${level} caution in responses.`,
      importance: 0.65,
      confidence: 0.8,
      tags: [`caution_bias:${bias}`],
      metadata: { caution_bias: bias, bias }
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    await reply(`Caution bias set to ${level}.`);
    return true;
  }

  if (command === 'memory') {
    const level = (args[0] || '').toLowerCase();
    const threshold = level === 'strict' ? 0.7 : level === 'balanced' ? 0.55 : level === 'loose' ? 0.45 : null;
    if (threshold === null) {
      await reply('Usage: /dotclaw memory <strict|balanced|loose>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'memory_importance_threshold',
      content: `Prefers memory strictness ${level}.`,
      importance: 0.6,
      confidence: 0.8,
      tags: [`memory_importance_threshold:${threshold}`],
      metadata: { memory_importance_threshold: threshold, threshold }
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    await reply(`Memory strictness set to ${level}.`);
    return true;
  }

  await reply('Unknown command. Use `/dotclaw help` for options.');
  return true;
}

function setupTelegramHandlers(): void {
  // Handle message reactions (👍/👎 for feedback)
  telegrafBot.on('message_reaction', async (ctx) => {
    try {
      const update = ctx.update as unknown as {
        message_reaction?: {
          chat: { id: number };
          message_id: number;
          user?: { id: number };
          new_reaction?: Array<{ type: string; emoji?: string }>;
        };
      };

      const reaction = update.message_reaction;
      if (!reaction) return;

      const emoji = reaction.new_reaction?.[0]?.emoji;
      if (!emoji || (emoji !== '👍' && emoji !== '👎')) return;

      const chatId = String(reaction.chat.id);
      const messageId = String(reaction.message_id);
      const userId = reaction.user?.id ? String(reaction.user.id) : undefined;

      // Look up the trace ID for this message
      const traceId = getTraceIdForMessage(messageId, chatId);
      if (!traceId) {
        logger.debug({ chatId, messageId }, 'No trace found for reacted message');
        return;
      }

      // Record the feedback
      const feedbackType = emoji === '👍' ? 'positive' : 'negative';
      recordUserFeedback({
        trace_id: traceId,
        message_id: messageId,
        chat_jid: chatId,
        feedback_type: feedbackType,
        user_id: userId
      });

      logger.info({ chatId, messageId, feedbackType, traceId }, 'User feedback recorded');
    } catch (err) {
      logger.debug({ err }, 'Error handling message reaction');
    }
  });

  // Handle all text messages
  telegrafBot.on('message', async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    const chatId = String(ctx.chat.id);
    const chatType = ctx.chat.type;
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const isPrivate = chatType === 'private';
    const senderId = String(ctx.from?.id || ctx.chat.id);
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const chatName = ('title' in ctx.chat && ctx.chat.title)
      || ('username' in ctx.chat && ctx.chat.username)
      || ctx.from?.first_name
      || ctx.from?.username
      || senderName;
    const content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const messageId = String(ctx.message.message_id);
    const rawThreadId = (ctx.message as { message_thread_id?: number }).message_thread_id;
    const messageThreadId = Number.isFinite(rawThreadId) ? Number(rawThreadId) : undefined;

    logger.info({ chatId, isGroup, senderName }, `Telegram message: ${content.substring(0, 50)}...`);

    try {
      // Store message in database
      upsertChat({ chatId, name: chatName, lastMessageTime: timestamp });
      storeMessage(
        String(ctx.message.message_id),
        chatId,
        senderId,
        senderName,
        content,
        timestamp,
        false
      );
    } catch (error) {
      logger.error({ error, chatId }, 'Failed to persist Telegram message');
    }

    const botUsername = ctx.me;
    const botId = ctx.botInfo?.id;
    const adminHandled = await handleAdminCommand({
      chatId,
      senderId,
      senderName,
      content,
      botUsername,
      messageThreadId
    });
    if (adminHandled) {
      return;
    }

    const mentioned = isBotMentioned(content, ctx.message.entities, botUsername, botId);
    const replied = isBotReplied(ctx.message, botId);
    const group = registeredGroups[chatId];
    const triggerRegex = isGroup && group?.trigger ? buildTriggerRegex(group.trigger) : null;
    const triggered = Boolean(triggerRegex && triggerRegex.test(content));
    const shouldProcess = isPrivate || mentioned || replied || triggered;

    if (!shouldProcess) {
      return;
    }

    // Rate limiting check
    const rateCheck = checkRateLimit(senderId);
    if (!rateCheck.allowed) {
      const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 60000) / 1000);
      logger.warn({ senderId, retryAfterSec }, 'Rate limit exceeded');
      await sendMessage(chatId, `You're sending messages too quickly. Please wait ${retryAfterSec} seconds and try again.`, { messageThreadId });
      return;
    }

    enqueueMessage({
      chatId,
      messageId,
      senderId,
      senderName,
      content,
      timestamp,
      isGroup,
      chatType,
      messageThreadId
    });
  });
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    // Intentionally using console.error for maximum visibility on fatal exit
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }
}

async function main(): Promise<void> {
  // Ensure directory structure exists before anything else
  const { ensureDirectoryStructure } = await import('./paths.js');
  ensureDirectoryStructure();

  try {
    const envStat = fs.existsSync(ENV_PATH) ? fs.statSync(ENV_PATH) : null;
    if (!envStat || envStat.size === 0) {
      logger.warn({ envPath: ENV_PATH }, '.env is missing or empty; set TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY');
    }
  } catch (err) {
    logger.warn({ envPath: ENV_PATH, err }, 'Failed to check .env file');
  }

  // Validate Telegram token
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN environment variable is required.\n' +
      'Create a bot with @BotFather and add the token to your .env file at: ' +
      ENV_PATH
    );
  }

  ensureDockerRunning();
  initDatabase();
  const resetCount = resetStalledMessages();
  if (resetCount > 0) {
    logger.info({ resetCount }, 'Reset stalled queue messages to pending');
  }
  initMemoryStore();
  startEmbeddingWorker();
  const expiredMemories = cleanupExpiredMemories();
  if (expiredMemories > 0) {
    logger.info({ expiredMemories }, 'Expired memories cleaned up');
  }
  logger.info('Database initialized');
  startMetricsServer();
  loadState();

  if (CONTAINER_MODE === 'daemon' && WARM_START_ENABLED) {
    const groups = Object.values(registeredGroups);
    for (const group of groups) {
      try {
        warmGroupContainer(group, group.folder === MAIN_GROUP_FOLDER);
        logger.info({ group: group.folder }, 'Warmed daemon container');
      } catch (err) {
        logger.warn({ group: group.folder, err }, 'Failed to warm daemon container');
      }
    }
  }

  // Resume any pending message queues from before restart
  const pendingChats = getChatsWithPendingMessages();
  for (const chatId of pendingChats) {
    if (registeredGroups[chatId]) {
      logger.info({ chatId }, 'Resuming message queue drain after restart');
      void drainQueue(chatId);
    }
  }

  // Set up Telegram message handlers
  setupTelegramHandlers();

  // Start dashboard
  startDashboard();

  // Start Telegram bot
  try {
    telegrafBot.launch();
    setTelegramConnected(true);
    logger.info('Telegram bot started');

    // Graceful shutdown
    let shuttingDown = false;
    const gracefulShutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Graceful shutdown initiated');

      // 1. Stop accepting new work
      setTelegramConnected(false);
      telegrafBot.stop(signal);

      // 2. Stop all loops and watchers
      stopSchedulerLoop();
      stopBackgroundJobLoop();
      stopIpcWatcher();
      stopMaintenanceLoop();
      stopHeartbeatLoop();
      stopDaemonHealthCheckLoop();
      stopEmbeddingWorker();

      // 3. Stop HTTP servers
      stopMetricsServer();
      stopDashboard();

      // 4. Clean up Docker containers for this instance
      cleanupInstanceContainers();

      // 5. Close database
      closeDatabase();

      logger.info('Shutdown complete');
      process.exit(0);
    };
    process.once('SIGINT', () => gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Start scheduler and IPC watcher
    // Wrapper that matches the scheduler's expected interface (Promise<void>)
    const sendMessageForScheduler = async (jid: string, text: string): Promise<void> => {
      await sendMessage(jid, text);
    };
    startSchedulerLoop({
      sendMessage: sendMessageForScheduler,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSession: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setGroupSession(groupFolder, sessionId);
      }
    });
    startBackgroundJobLoop({
      sendMessage: sendMessageForScheduler,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSession: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setGroupSession(groupFolder, sessionId);
      }
    });
    startIpcWatcher();
    startMaintenanceLoop();
    startHeartbeatLoop();
    startDaemonHealthCheckLoop(() => registeredGroups, MAIN_GROUP_FOLDER);

    logger.info('DotClaw running on Telegram (responds to DMs and group mentions/replies)');
  } catch (error) {
    logger.error({ error }, 'Failed to start Telegram bot');
    process.exit(1);
  }
}

main().catch(err => {
  logger.error({ err }, 'Failed to start DotClaw');
  process.exit(1);
});
