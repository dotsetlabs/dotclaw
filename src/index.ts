import 'dotenv/config';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  MODEL_CONFIG_PATH,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  CONTAINER_TIMEOUT,
  TIMEZONE
} from './config.js';
import { RegisteredGroup, Session } from './types.js';
import { initDatabase, storeMessage, storeChatMetadata, getMessagesSince, getAllTasks, createTask, updateTask, deleteTask, getTaskById } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot } from './container-runner.js';
import type { ContainerOutput } from './container-runner.js';
import { loadJson, saveJson, isSafeGroupFolder, loadModelConfig, saveModelConfig, isModelAllowed } from './utils.js';
import { writeTrace } from './trace-writer.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TELEGRAM_HANDLER_TIMEOUT_MS = parsePositiveInt(
  process.env.DOTCLAW_TELEGRAM_HANDLER_TIMEOUT_MS,
  Math.max(CONTAINER_TIMEOUT + 30_000, 120_000)
);
const TELEGRAM_SEND_RETRIES = parsePositiveInt(process.env.DOTCLAW_TELEGRAM_SEND_RETRIES, 3);
const TELEGRAM_SEND_RETRY_DELAY_MS = parsePositiveInt(process.env.DOTCLAW_TELEGRAM_SEND_RETRY_DELAY_MS, 1000);

// Initialize Telegram bot with extended timeout for long-running agent tasks
const telegrafBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!, {
  handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS
});
telegrafBot.catch((err, ctx) => {
  logger.error({ err, chatId: ctx?.chat?.id }, 'Unhandled Telegraf error');
});

let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

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
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
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
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_agent_timestamp: lastAgentTimestamp });
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
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  const sendChunk = async (chunk: string): Promise<boolean> => {
    for (let attempt = 1; attempt <= TELEGRAM_SEND_RETRIES; attempt += 1) {
      try {
        await telegrafBot.telegram.sendMessage(chatId, chunk);
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
    if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      const ok = await sendChunk(text);
      if (!ok) return;
    } else {
      for (let i = 0; i < text.length; i += TELEGRAM_MAX_MESSAGE_LENGTH) {
        const chunk = text.slice(i, i + TELEGRAM_MAX_MESSAGE_LENGTH);
        const ok = await sendChunk(chunk);
        if (!ok) return;
        if (i + TELEGRAM_MAX_MESSAGE_LENGTH < text.length) {
          await sleep(TELEGRAM_SEND_DELAY_MS);
        }
      }
    }
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}

interface TelegramMessage {
  chatId: string;
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

  const content = msg.content.trim();

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chatId] || '';
  let missedMessages = getMessagesSince(msg.chatId, sinceTimestamp, ASSISTANT_NAME);
  if (missedMessages.length === 0) {
    logger.warn({ chatId: msg.chatId }, 'No missed messages found; falling back to current message');
    missedMessages = [{
      id: `fallback-${Date.now()}`,
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
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
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
    writeTrace({
      ...traceBase,
      output_text: output?.result ?? null,
      model_id: output?.model || 'unknown',
      prompt_pack_versions: output?.prompt_pack_versions,
      memory_summary: output?.memory_summary,
      memory_facts: output?.memory_facts,
      tool_calls: output?.tool_calls,
      latency_ms: output?.latency_ms,
      error_code: errorMessage || (output?.status === 'error' ? output?.error : undefined)
    });
  };

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  await setTyping(msg.chatId);
  let output: ContainerOutput | null = null;
  try {
    output = await runAgent(group, prompt, msg.chatId);
  }
  catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    recordTrace(null, err instanceof Error ? err.message : String(err));
    await sendMessage(msg.chatId, 'Sorry, I ran into an error while processing that.');
    return false;
  }

  if (!output) {
    recordTrace(null, 'No output from agent');
    return false;
  }

  if (output.status === 'error') {
    logger.error({ group: group.name, error: output.error }, 'Container agent error');
    recordTrace(output, output.error);
    await sendMessage(msg.chatId, 'Sorry, I ran into an error while processing that.');
    return false;
  }

  lastAgentTimestamp[msg.chatId] = msg.timestamp;
  saveState();

  if (output.result && output.result.trim()) {
    await sendMessage(msg.chatId, output.result);
  } else {
    logger.warn({ chatId: msg.chatId }, 'Agent returned empty/whitespace response');
  }

  recordTrace(output);

  return true;
}

async function runAgent(group: RegisteredGroup, prompt: string, chatId: string): Promise<ContainerOutput> {
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
    next_run: t.next_run
  })));

  // For Telegram, we don't have dynamic group discovery like WhatsApp
  // Just pass the registered groups
  writeGroupsSnapshot(group.folder, isMain, [], new Set(Object.keys(registeredGroups)));

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: chatId,
      isMain
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
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
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    model?: string;
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
        const config = loadModelConfig(MODEL_CONFIG_PATH, defaultModel);
        const nextModel = data.model.trim();
        if (!isModelAllowed(config, nextModel)) {
          logger.warn({ model: nextModel }, 'Model not in allowlist; refusing set_model');
          break;
        }
        saveModelConfig(MODEL_CONFIG_PATH, {
          ...config,
          model: nextModel,
          updated_at: new Date().toISOString()
        });
        logger.info({ model: nextModel }, 'Model updated via IPC');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function setupTelegramHandlers(): void {
  // Handle all text messages
  telegrafBot.on('message', (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const isPrivate = ctx.chat.type === 'private';
    const senderId = String(ctx.from?.id || ctx.chat.id);
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const content = ctx.message.text;
    const timestamp = new Date(ctx.message.date * 1000).toISOString();

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
    const mentioned = isBotMentioned(content, ctx.message.entities, botUsername, botId);
    const replied = isBotReplied(ctx.message, botId);
    const shouldProcess = isPrivate || mentioned || replied;

    if (!shouldProcess) {
      return;
    }

    enqueueMessage({
      chatId,
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
  logger.info('Database initialized');
  loadState();

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
      getSessions: () => sessions
    });
    startIpcWatcher();

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
