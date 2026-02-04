import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  CONTAINER_TIMEOUT,
  TIMEZONE,
  CONTAINER_MODE,
  WARM_START_ENABLED
} from './config.js';
import { RegisteredGroup, Session } from './types.js';
import {
  initDatabase,
  storeMessage,
  storeChatMetadata,
  getMessagesSinceCursor,
  getChatState,
  updateChatState,
  getAllTasks,
  createTask,
  updateTask,
  deleteTask,
  getTaskById,
  getAllGroupSessions,
  setGroupSession,
  deleteGroupSession,
  pauseTasksForGroup,
  logToolCalls,
  getToolReliability
} from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot } from './container-runner.js';
import type { ContainerOutput } from './container-runner.js';
import { loadJson, saveJson, isSafeGroupFolder } from './utils.js';
import { writeTrace } from './trace-writer.js';
import { formatTelegramMessage, TELEGRAM_PARSE_MODE } from './telegram-format.js';
import { withGroupLock } from './locks.js';
import {
  initMemoryStore,
  buildUserProfile,
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
import { buildHybridMemoryRecall } from './memory-recall.js';
import { startEmbeddingWorker } from './memory-embeddings.js';
import { loadPersonalizedBehaviorConfig } from './personalization.js';
import { createProgressNotifier, DEFAULT_PROGRESS_MESSAGES, parseProgressMessages } from './progress.js';
import { parseAdminCommand } from './admin-commands.js';
import { getEffectiveToolPolicy } from './tool-policy.js';
import { applyToolBudgets } from './tool-budgets.js';
import { resolveModel, loadModelRegistry, saveModelRegistry, getTokenEstimateConfig, getModelPricing } from './model-registry.js';
import { startMetricsServer, recordMessage, recordError, recordToolCall, recordLatency, recordTokenUsage, recordCost, recordMemoryRecall, recordMemoryUpsert, recordMemoryExtract } from './metrics.js';
import { computeCostUSD } from './cost.js';
import { runWithAgentSemaphore } from './agent-semaphore.js';
import { startMaintenanceLoop } from './maintenance.js';
import { warmGroupContainer } from './container-runner.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabledEnv(name: string, defaultValue = true): boolean {
  const value = (process.env[name] || '').toLowerCase().trim();
  if (!value) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value);
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

const TELEGRAM_HANDLER_TIMEOUT_MS = parsePositiveInt(
  process.env.DOTCLAW_TELEGRAM_HANDLER_TIMEOUT_MS,
  Math.max(CONTAINER_TIMEOUT + 30_000, 120_000)
);
const TELEGRAM_SEND_RETRIES = parsePositiveInt(process.env.DOTCLAW_TELEGRAM_SEND_RETRIES, 3);
const TELEGRAM_SEND_RETRY_DELAY_MS = parsePositiveInt(process.env.DOTCLAW_TELEGRAM_SEND_RETRY_DELAY_MS, 1000);
const MEMORY_RECALL_MAX_RESULTS = parsePositiveInt(process.env.DOTCLAW_MEMORY_RECALL_MAX_RESULTS, 8);
const MEMORY_RECALL_MAX_TOKENS = parsePositiveInt(process.env.DOTCLAW_MEMORY_RECALL_MAX_TOKENS, 1200);
const PROGRESS_ENABLED = isEnabledEnv('DOTCLAW_PROGRESS_ENABLED', true);
const PROGRESS_INITIAL_MS = parsePositiveInt(process.env.DOTCLAW_PROGRESS_INITIAL_MS, 30000);
const PROGRESS_INTERVAL_MS = parsePositiveInt(process.env.DOTCLAW_PROGRESS_INTERVAL_MS, 60000);
const PROGRESS_MAX_UPDATES = parsePositiveInt(process.env.DOTCLAW_PROGRESS_MAX_UPDATES, 3);
const PROGRESS_MESSAGES = parseProgressMessages(process.env.DOTCLAW_PROGRESS_MESSAGES, DEFAULT_PROGRESS_MESSAGES);
const HEARTBEAT_ENABLED = isEnabledEnv('DOTCLAW_HEARTBEAT_ENABLED', true);
const HEARTBEAT_INTERVAL_MS = parsePositiveInt(process.env.DOTCLAW_HEARTBEAT_INTERVAL_MS, 900000);
const HEARTBEAT_GROUP_FOLDER = (process.env.DOTCLAW_HEARTBEAT_GROUP || MAIN_GROUP_FOLDER).trim() || MAIN_GROUP_FOLDER;

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

type QueueState = {
  inFlight: boolean;
  pendingMessage?: TelegramMessage;
};

const messageQueues = new Map<string, QueueState>();

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

  // Load sessions from DB; migrate legacy sessions.json if DB is empty
  const dbSessions = getAllGroupSessions();
  if (dbSessions.length === 0) {
    const legacySessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
    for (const [folder, sessionId] of Object.entries(legacySessions)) {
      if (typeof sessionId === 'string' && sessionId.trim()) {
        setGroupSession(folder, sessionId);
      }
    }
  }
  const finalSessions = getAllGroupSessions();
  sessions = finalSessions.reduce<Session>((acc, row) => {
    acc[row.group_folder] = row.session_id;
    return acc;
  }, {});
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
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
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
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

async function sendMessage(chatId: string, text: string): Promise<void> {
  const chunks = formatTelegramMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  const sendChunk = async (chunk: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= TELEGRAM_SEND_RETRIES; attempt += 1) {
      try {
        await telegrafBot.telegram.sendMessage(chatId, chunk, { parse_mode: TELEGRAM_PARSE_MODE });
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
      if (!ok) return;
      if (i < chunks.length - 1) {
        await sleep(TELEGRAM_SEND_DELAY_MS);
      }
    }
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
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
}

function enqueueMessage(msg: TelegramMessage): void {
  const existing = messageQueues.get(msg.chatId);
  if (existing) {
    existing.pendingMessage = msg;
    if (!existing.inFlight) {
      void drainQueue(msg.chatId);
    }
    return;
  }
  messageQueues.set(msg.chatId, { inFlight: false, pendingMessage: msg });
  void drainQueue(msg.chatId);
}

async function drainQueue(chatId: string): Promise<void> {
  const state = messageQueues.get(chatId);
  if (!state || state.inFlight) return;

  state.inFlight = true;
  try {
    while (state.pendingMessage) {
      const next = state.pendingMessage;
      state.pendingMessage = undefined;
      await processMessage(next);
    }
  } catch (err) {
    logger.error({ chatId, err }, 'Error draining message queue');
  } finally {
    state.inFlight = false;
    if (state.pendingMessage) {
      void drainQueue(chatId);
    } else {
      messageQueues.delete(chatId);
    }
  }
}

async function processMessage(msg: TelegramMessage): Promise<boolean> {
  const group = registeredGroups[msg.chatId];
  if (!group) {
    logger.debug({ chatId: msg.chatId }, 'Message from unregistered Telegram chat');
    return false;
  }
  recordMessage('telegram');

  // Get all messages since last agent interaction so the session has full context
  const chatState = getChatState(msg.chatId);
  let missedMessages = getMessagesSinceCursor(
    msg.chatId,
    chatState?.last_agent_timestamp || null,
    chatState?.last_agent_message_id || null
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
    return `<message sender="${escapeXml(m.sender_name)}" sender_id="${escapeXml(m.sender)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;
  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const traceTimestamp = new Date().toISOString();
  const traceBase = {
    trace_id: traceId,
    timestamp: traceTimestamp,
    created_at: Date.now(),
    chat_id: msg.chatId,
    group_folder: group.folder,
    user_id: msg.senderId,
    input_text: prompt,
    source: 'dotclaw'
  } as const;

  const recordTrace = (output: ContainerOutput | null, errorMessage?: string) => {
    const pricing = output?.model ? getModelPricing(modelRegistry, output.model) : modelPricing;
    const cost = computeCostUSD(output?.tokens_prompt, output?.tokens_completion, pricing);
    writeTrace({
      ...traceBase,
      output_text: output?.result ?? null,
      model_id: output?.model || 'unknown',
      prompt_pack_versions: output?.prompt_pack_versions,
      memory_summary: output?.memory_summary,
      memory_facts: output?.memory_facts,
      memory_recall: memoryRecall,
      tool_calls: output?.tool_calls,
      latency_ms: output?.latency_ms,
      tokens_prompt: output?.tokens_prompt,
      tokens_completion: output?.tokens_completion,
      cost_prompt_usd: cost?.prompt,
      cost_completion_usd: cost?.completion,
      cost_total_usd: cost?.total,
      memory_recall_count: output?.memory_recall_count,
      session_recall_count: output?.session_recall_count,
      memory_items_upserted: output?.memory_items_upserted,
      memory_items_extracted: output?.memory_items_extracted,
      error_code: errorMessage || (output?.status === 'error' ? output?.error : undefined)
    });
  };

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  await setTyping(msg.chatId);
  const recallQuery = missedMessages.map(m => m.content).join('\n');
  const memoryRecall = await buildHybridMemoryRecall({
    groupFolder: group.folder,
    userId: msg.senderId,
    query: recallQuery || msg.content,
    maxResults: MEMORY_RECALL_MAX_RESULTS,
    maxTokens: MEMORY_RECALL_MAX_TOKENS
  });
  const userProfile = buildUserProfile({
    groupFolder: group.folder,
    userId: msg.senderId
  });
  const memoryStats = getMemoryStats({
    groupFolder: group.folder,
    userId: msg.senderId
  });
  const behaviorConfig = loadPersonalizedBehaviorConfig({
    groupFolder: group.folder,
    userId: msg.senderId
  });
  const baseToolPolicy = getEffectiveToolPolicy({
    groupFolder: group.folder,
    userId: msg.senderId
  });
  const toolPolicy = applyToolBudgets({
    groupFolder: group.folder,
    userId: msg.senderId,
    toolPolicy: baseToolPolicy
  });
  const toolReliability = getToolReliability({ groupFolder: group.folder, limit: 200 })
    .map(row => ({
      name: row.tool_name,
      success_rate: row.total > 0 ? row.ok_count / row.total : 0,
      count: row.total,
      avg_duration_ms: row.avg_duration_ms
    }));
  const defaultModel = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
  const modelRegistry = loadModelRegistry(defaultModel);
  const resolvedModel = resolveModel({
    groupFolder: group.folder,
    userId: msg.senderId,
    defaultModel
  });
  const tokenEstimate = getTokenEstimateConfig(resolvedModel.override);
  const modelPricing = getModelPricing(modelRegistry, resolvedModel.model);

  let output: ContainerOutput | null = null;
  const progressNotifier = createProgressNotifier({
    enabled: PROGRESS_ENABLED,
    initialDelayMs: PROGRESS_INITIAL_MS,
    intervalMs: PROGRESS_INTERVAL_MS,
    maxUpdates: PROGRESS_MAX_UPDATES,
    messages: PROGRESS_MESSAGES,
    send: (text) => sendMessage(msg.chatId, text),
    onError: (err) => logger.debug({ chatId: msg.chatId, err }, 'Failed to send progress update')
  });
  progressNotifier.start();
  try {
    output = await runAgent(group, prompt, msg.chatId, {
      userId: msg.senderId,
      userName: msg.senderName,
      memoryRecall,
      userProfile,
      memoryStats,
      tokenEstimate,
      toolReliability,
      behaviorConfig: behaviorConfig as unknown as Record<string, unknown>,
      toolPolicy: toolPolicy as Record<string, unknown>,
      modelOverride: resolvedModel.model,
      modelContextTokens: resolvedModel.override?.context_window,
      modelMaxOutputTokens: resolvedModel.override?.max_output_tokens,
      modelTemperature: resolvedModel.override?.temperature
    });
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    recordError('agent');
    recordTrace(null, err instanceof Error ? err.message : String(err));
    await sendMessage(msg.chatId, 'Sorry, I ran into an error while processing that.');
    return false;
  } finally {
    progressNotifier.stop();
  }

  if (!output) {
    recordTrace(null, 'No output from agent');
    return false;
  }

  if (output.status === 'error') {
    logger.error({ group: group.name, error: output.error }, 'Container agent error');
    recordError('agent');
    recordTrace(output, output.error);
    await sendMessage(msg.chatId, 'Sorry, I ran into an error while processing that.');
    return false;
  }

  const lastMessage = missedMessages[missedMessages.length - 1];
  if (lastMessage) {
    updateChatState(msg.chatId, lastMessage.timestamp, lastMessage.id);
  }
  saveState();

  if (output.result && output.result.trim()) {
    await sendMessage(msg.chatId, output.result);
  } else if (output.tool_calls && output.tool_calls.length > 0) {
    await sendMessage(
      msg.chatId,
      'I hit my tool-call step limit before I could finish. If you want me to keep going, please narrow the scope or ask for a specific subtask.'
    );
  } else {
    logger.warn({ chatId: msg.chatId }, 'Agent returned empty/whitespace response');
  }

  recordTrace(output);
  if (output.latency_ms) {
    recordLatency(output.latency_ms);
  }
  if (Number.isFinite(output.tokens_prompt) || Number.isFinite(output.tokens_completion)) {
    recordTokenUsage(output.model || resolvedModel.model, 'telegram', output.tokens_prompt || 0, output.tokens_completion || 0);
    const pricing = getModelPricing(modelRegistry, output.model || resolvedModel.model);
    const cost = computeCostUSD(output.tokens_prompt, output.tokens_completion, pricing);
    if (cost) {
      recordCost(output.model || resolvedModel.model, 'telegram', cost.total);
    }
  }
  if (Number.isFinite(output.memory_recall_count)) {
    recordMemoryRecall('telegram', output.memory_recall_count || 0);
  }
  if (Number.isFinite(output.memory_items_upserted)) {
    recordMemoryUpsert('telegram', output.memory_items_upserted || 0);
  }
  if (Number.isFinite(output.memory_items_extracted)) {
    recordMemoryExtract('telegram', output.memory_items_extracted || 0);
  }
  if (output.tool_calls && output.tool_calls.length > 0) {
    logToolCalls({
      traceId,
      chatJid: msg.chatId,
      groupFolder: group.folder,
      userId: msg.senderId,
      toolCalls: output.tool_calls,
      source: 'message'
    });
    for (const call of output.tool_calls) {
      recordToolCall(call.name, call.ok);
    }
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatId: string,
  options?: {
    userId?: string;
    userName?: string;
    memoryRecall?: string[];
    userProfile?: string | null;
    memoryStats?: { total: number; user: number; group: number; global: number };
    tokenEstimate?: { tokens_per_char: number; tokens_per_message: number; tokens_per_request: number };
    toolReliability?: Array<{ name: string; success_rate: number; count: number; avg_duration_ms: number | null }>;
    behaviorConfig?: Record<string, unknown>;
    toolPolicy?: Record<string, unknown>;
    modelOverride?: string;
    modelContextTokens?: number;
    modelMaxOutputTokens?: number;
    modelTemperature?: number;
  }
): Promise<ContainerOutput> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
    state_json: t.state_json ?? null,
    retry_count: t.retry_count ?? 0,
    last_error: t.last_error ?? null
  })));

  // For Telegram, we don't have dynamic group discovery like WhatsApp
  // Pass registered groups for main (admin) context
  const availableGroups = Object.entries(registeredGroups).map(([jid, info]) => ({
    jid,
    name: info.name,
    lastActivity: getChatState(jid)?.last_agent_timestamp || info.added_at,
    isRegistered: true
  }));
  writeGroupsSnapshot(group.folder, isMain, availableGroups);

  try {
    const output = await runWithAgentSemaphore(() =>
      withGroupLock(group.folder, () =>
        runContainerAgent(group, {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid: chatId,
          isMain,
          userId: options?.userId,
          userName: options?.userName,
          memoryRecall: options?.memoryRecall,
        userProfile: options?.userProfile ?? null,
        memoryStats: options?.memoryStats,
        tokenEstimate: options?.tokenEstimate,
        toolReliability: options?.toolReliability,
        behaviorConfig: options?.behaviorConfig,
          toolPolicy: options?.toolPolicy,
          modelOverride: options?.modelOverride,
          modelContextTokens: options?.modelContextTokens,
          modelMaxOutputTokens: options?.modelMaxOutputTokens,
          modelTemperature: options?.modelTemperature
        })
      )
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setGroupSession(group.folder, output.newSessionId);
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    return output;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      result: null,
      error: errorMessage
    };
  }
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  let processing = false;
  let scheduled = false;
  let pollingTimer: NodeJS.Timeout | null = null;

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
    if (scheduled) return;
    scheduled = true;
    setTimeout(async () => {
      scheduled = false;
      await processIpcFiles();
    }, 100);
  };

  let watcherActive = false;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(ipcBaseDir, { recursive: true }, () => {
      scheduleProcess();
    });
    watcher.on('error', (err) => {
      logger.warn({ err }, 'IPC watcher error; falling back to polling');
      watcher?.close();
      if (!pollingTimer) {
        const poll = () => {
          scheduleProcess();
          pollingTimer = setTimeout(poll, IPC_POLL_INTERVAL);
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
      scheduleProcess();
      pollingTimer = setTimeout(poll, IPC_POLL_INTERVAL);
    };
    poll();
  } else {
    scheduleProcess();
  }

  if (pollingTimer) {
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
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const prompt = [
    '[HEARTBEAT]',
    'You are running automatically. Review scheduled tasks, pending reminders, and long-running work.',
    'If you need to communicate, use mcp__dotclaw__send_message. Otherwise, take no user-visible action.'
  ].join(' ');

  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const traceTimestamp = new Date().toISOString();

  const memoryRecall = await buildHybridMemoryRecall({
    groupFolder: group.folder,
    userId: null,
    query: prompt,
    maxResults: Math.max(4, MEMORY_RECALL_MAX_RESULTS - 2),
    maxTokens: Math.max(600, MEMORY_RECALL_MAX_TOKENS - 200)
  });
  const memoryStats = getMemoryStats({
    groupFolder: group.folder,
    userId: null
  });
  const behaviorConfig = loadPersonalizedBehaviorConfig({
    groupFolder: group.folder,
    userId: null
  });
  const baseToolPolicy = getEffectiveToolPolicy({
    groupFolder: group.folder,
    userId: null
  });
  const toolPolicy = applyToolBudgets({
    groupFolder: group.folder,
    userId: null,
    toolPolicy: baseToolPolicy
  });
  const toolReliability = getToolReliability({ groupFolder: group.folder, limit: 200 })
    .map(row => ({
      name: row.tool_name,
      success_rate: row.total > 0 ? row.ok_count / row.total : 0,
      count: row.total,
      avg_duration_ms: row.avg_duration_ms
    }));
  const defaultModel = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
  const modelRegistry = loadModelRegistry(defaultModel);
  const resolvedModel = resolveModel({
    groupFolder: group.folder,
    userId: null,
    defaultModel
  });
  const tokenEstimate = getTokenEstimateConfig(resolvedModel.override);

  const sessionId = sessions[group.folder];
  const output = await runWithAgentSemaphore(() =>
    withGroupLock(group.folder, () =>
      runContainerAgent(group, {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: chatId,
        isMain,
        isScheduledTask: true,
        memoryRecall,
        userProfile: null,
        memoryStats,
        tokenEstimate,
        toolReliability,
        behaviorConfig: behaviorConfig as unknown as Record<string, unknown>,
        toolPolicy: toolPolicy as Record<string, unknown>,
        modelOverride: resolvedModel.model,
        modelContextTokens: resolvedModel.override?.context_window,
        modelMaxOutputTokens: resolvedModel.override?.max_output_tokens,
        modelTemperature: resolvedModel.override?.temperature
      })
    )
  );

  if (output?.newSessionId) {
    sessions[group.folder] = output.newSessionId;
    setGroupSession(group.folder, output.newSessionId);
    saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
  }

  const cost = computeCostUSD(
    output?.tokens_prompt,
    output?.tokens_completion,
    getModelPricing(modelRegistry, output?.model || resolvedModel.model)
  );

  writeTrace({
    trace_id: traceId,
    timestamp: traceTimestamp,
    created_at: Date.now(),
    chat_id: chatId,
    group_folder: group.folder,
    input_text: prompt,
    output_text: output?.result ?? null,
    model_id: output?.model || 'unknown',
    prompt_pack_versions: output?.prompt_pack_versions,
    memory_summary: output?.memory_summary,
    memory_facts: output?.memory_facts,
    tool_calls: output?.tool_calls,
    latency_ms: output?.latency_ms,
    tokens_prompt: output?.tokens_prompt,
    tokens_completion: output?.tokens_completion,
    cost_prompt_usd: cost?.prompt,
    cost_completion_usd: cost?.completion,
    cost_total_usd: cost?.total,
    memory_recall_count: output?.memory_recall_count,
    session_recall_count: output?.session_recall_count,
    memory_items_upserted: output?.memory_items_upserted,
    memory_items_extracted: output?.memory_items_extracted,
    error_code: output?.status === 'error' ? output?.error : undefined,
    source: 'dotclaw-heartbeat'
  });

  if (output?.tool_calls && output.tool_calls.length > 0) {
    logToolCalls({
      traceId,
      chatJid: chatId,
      groupFolder: group.folder,
      userId: null,
      toolCalls: output.tool_calls,
      source: 'heartbeat'
    });
    for (const call of output.tool_calls) {
      recordToolCall(call.name, call.ok);
    }
  }
}

function startHeartbeatLoop(): void {
  if (!HEARTBEAT_ENABLED) return;
  const loop = async () => {
    try {
      await runHeartbeatOnce();
    } catch (err) {
      logger.error({ err }, 'Heartbeat run failed');
    }
    setTimeout(loop, HEARTBEAT_INTERVAL_MS);
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

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
        const defaultModel = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
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
  const defaultModel = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
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
}): Promise<boolean> {
  const parsed = parseAdminCommand(params.content, params.botUsername);
  if (!parsed) return false;

  const group = registeredGroups[params.chatId];
  if (!group) {
    await sendMessage(params.chatId, 'This chat is not registered with DotClaw.');
    return true;
  }

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const command = parsed.command;
  const args = parsed.args;

  const requireMain = (name: string): boolean => {
    if (isMain) return false;
    sendMessage(params.chatId, `${name} is only available in the main group.`).catch(() => undefined);
    return true;
  };

  if (command === 'help') {
    await sendMessage(params.chatId, [
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
    await sendMessage(params.chatId, formatGroups(listRegisteredGroups()));
    return true;
  }

  if (command === 'add-group') {
    if (requireMain('Adding groups')) return true;
    if (args.length < 1) {
      await sendMessage(params.chatId, 'Usage: /dotclaw add-group <chat_id> <name> [folder]');
      return true;
    }
    const jid = args[0];
    if (registeredGroups[jid]) {
      await sendMessage(params.chatId, 'That chat id is already registered.');
      return true;
    }
    const name = args[1] || `group-${jid}`;
    const folder = args[2] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!isSafeGroupFolder(folder, GROUPS_DIR)) {
      await sendMessage(params.chatId, 'Invalid folder name. Use lowercase letters, numbers, and dashes only.');
      return true;
    }
    registerGroup(jid, {
      name,
      folder: folder || `group-${jid}`,
      added_at: new Date().toISOString()
    });
    await sendMessage(params.chatId, `Registered group "${name}" with folder "${folder}".`);
    return true;
  }

  if (command === 'remove-group') {
    if (requireMain('Removing groups')) return true;
    if (args.length < 1) {
      await sendMessage(params.chatId, 'Usage: /dotclaw remove-group <chat_id|name|folder>');
      return true;
    }
    const result = unregisterGroup(args.join(' '));
    if (!result.ok) {
      await sendMessage(params.chatId, `Failed to remove group: ${result.error || 'unknown error'}`);
      return true;
    }
    await sendMessage(params.chatId, `Removed group "${result.group?.name}" (${result.group?.folder}).`);
    return true;
  }

  if (command === 'set-model') {
    if (requireMain('Setting models')) return true;
    if (args.length < 1) {
      await sendMessage(params.chatId, 'Usage: /dotclaw set-model <model> [global|group|user] [target_id]');
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
      await sendMessage(params.chatId, `Failed to set model: ${result.error || 'unknown error'}`);
      return true;
    }
    await sendMessage(params.chatId, `Model set to ${model} (${scope}${targetId ? `:${targetId}` : ''}).`);
    return true;
  }

  if (command === 'remember') {
    if (requireMain('Remembering facts')) return true;
    const fact = args.join(' ').trim();
    if (!fact) {
      await sendMessage(params.chatId, 'Usage: /dotclaw remember <fact>');
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
    await sendMessage(params.chatId, 'Saved to global memory.');
    return true;
  }

  if (command === 'style') {
    const style = (args[0] || '').toLowerCase();
    if (!['concise', 'balanced', 'detailed'].includes(style)) {
      await sendMessage(params.chatId, 'Usage: /dotclaw style <concise|balanced|detailed>');
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
    await sendMessage(params.chatId, `Response style set to ${style}.`);
    return true;
  }

  if (command === 'tools') {
    const level = (args[0] || '').toLowerCase();
    const bias = level === 'proactive' ? 0.7 : level === 'balanced' ? 0.5 : level === 'conservative' ? 0.3 : null;
    if (bias === null) {
      await sendMessage(params.chatId, 'Usage: /dotclaw tools <conservative|balanced|proactive>');
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
    await sendMessage(params.chatId, `Tool usage bias set to ${level}.`);
    return true;
  }

  if (command === 'caution') {
    const level = (args[0] || '').toLowerCase();
    const bias = level === 'high' ? 0.7 : level === 'balanced' ? 0.5 : level === 'low' ? 0.35 : null;
    if (bias === null) {
      await sendMessage(params.chatId, 'Usage: /dotclaw caution <low|balanced|high>');
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
    await sendMessage(params.chatId, `Caution bias set to ${level}.`);
    return true;
  }

  if (command === 'memory') {
    const level = (args[0] || '').toLowerCase();
    const threshold = level === 'strict' ? 0.7 : level === 'balanced' ? 0.55 : level === 'loose' ? 0.45 : null;
    if (threshold === null) {
      await sendMessage(params.chatId, 'Usage: /dotclaw memory <strict|balanced|loose>');
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
    await sendMessage(params.chatId, `Memory strictness set to ${level}.`);
    return true;
  }

  await sendMessage(params.chatId, 'Unknown command. Use `/dotclaw help` for options.');
  return true;
}

function setupTelegramHandlers(): void {
  // Handle all text messages
  telegrafBot.on('message', async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const isPrivate = ctx.chat.type === 'private';
    const senderId = String(ctx.from?.id || ctx.chat.id);
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();
    const messageId = String(ctx.message.message_id);

    logger.info({ chatId, isGroup, senderName }, `Telegram message: ${content.substring(0, 50)}...`);

    try {
      // Ensure chat exists in database (required for foreign key)
      const chatName = ctx.chat.type === 'private'
        ? (ctx.from?.first_name || ctx.from?.username || 'Private Chat')
        : ('title' in ctx.chat ? ctx.chat.title : 'Group Chat');
      storeChatMetadata(chatId, timestamp, chatName);

      // Store message in database
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
      botUsername
    });
    if (adminHandled) {
      return;
    }

    const mentioned = isBotMentioned(content, ctx.message.entities, botUsername, botId);
    const replied = isBotReplied(ctx.message, botId);
    const shouldProcess = isPrivate || mentioned || replied;

    if (!shouldProcess) {
      return;
    }

    enqueueMessage({
      chatId,
      messageId,
      senderId,
      senderName,
      content,
      timestamp,
      isGroup
    });
  });
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
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
  const envPath = path.join(process.cwd(), '.env');
  try {
    const envStat = fs.existsSync(envPath) ? fs.statSync(envPath) : null;
    if (!envStat || envStat.size === 0) {
      logger.warn({ envPath }, '.env is missing or empty; set TELEGRAM_BOT_TOKEN and OpenRouter auth');
    }
  } catch (err) {
    logger.warn({ envPath, err }, 'Failed to check .env file');
  }

  // Validate Telegram token
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN environment variable is required.\n' +
      'Create a bot with @BotFather and add the token to your .env file at: ' +
      envPath
    );
  }

  ensureDockerRunning();
  initDatabase();
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

  // Set up Telegram message handlers
  setupTelegramHandlers();

  // Start Telegram bot
  try {
    telegrafBot.launch();
    logger.info('Telegram bot started');

    // Graceful shutdown
    process.once('SIGINT', () => {
      logger.info('Shutting down Telegram bot');
      telegrafBot.stop('SIGINT');
    });
    process.once('SIGTERM', () => {
      logger.info('Shutting down Telegram bot');
      telegrafBot.stop('SIGTERM');
    });

    // Start scheduler and IPC watcher
    startSchedulerLoop({
      sendMessage,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSession: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setGroupSession(groupFolder, sessionId);
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
      }
    });
    startIpcWatcher();
    startMaintenanceLoop();
    startHeartbeatLoop();

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
