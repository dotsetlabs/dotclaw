import fs from 'fs';
import path from 'path';
import type { RegisteredGroup, Session } from './types.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  createTask,
  updateTask,
  deleteTask,
  getTaskById,
} from './db.js';
import { resolveContainerGroupPathToHost } from './path-mapping.js';
import {
  upsertMemoryItems,
  searchMemories,
  listMemories,
  forgetMemories,
  getMemoryStats,
  MemoryScope,
  MemoryType,
  MemoryItemInput,
} from './memory-store.js';
import { invalidatePersonalizationCache } from './personalization.js';
import { loadModelRegistry, saveModelRegistry } from './model-registry.js';
import { logger } from './logger.js';
import { generateId } from './id.js';
import { isValidTimezone, normalizeTaskTimezone, parseScheduledTimestamp } from './timezone.js';
import { loadRuntimeConfig } from './runtime-config.js';
import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  TIMEZONE,
  IPC_POLL_INTERVAL,
} from './config.js';
import { runTaskNow } from './task-scheduler.js';

const runtime = loadRuntimeConfig();

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

function normalizePollOptions(rawOptions: unknown): string[] | null {
  if (!Array.isArray(rawOptions)) return null;
  const options = rawOptions
    .filter((value): value is string => typeof value === 'string')
    .map(option => option.trim())
    .filter(Boolean);
  if (options.length < 2 || options.length > 10) return null;
  if (options.some(option => option.length > 100)) return null;
  if (new Set(options.map(option => option.toLowerCase())).size !== options.length) return null;
  return options;
}

function isAllowedInlineButtonUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'tg:';
  } catch {
    return false;
  }
}

type InlineKeyboardButton = { text: string; callback_data?: string; url?: string };

function normalizeInlineKeyboard(rawButtons: unknown): Array<Array<InlineKeyboardButton>> | null {
  if (!Array.isArray(rawButtons) || rawButtons.length === 0) return null;
  const rows: Array<Array<InlineKeyboardButton>> = [];
  for (const rawRow of rawButtons) {
    if (!Array.isArray(rawRow) || rawRow.length === 0) return null;
    const row: InlineKeyboardButton[] = [];
    for (const rawButton of rawRow) {
      if (!rawButton || typeof rawButton !== 'object') return null;
      const button = rawButton as Record<string, unknown>;
      const text = typeof button.text === 'string' ? button.text.trim() : '';
      const url = typeof button.url === 'string' ? button.url.trim() : '';
      const callbackData = typeof button.callback_data === 'string' ? button.callback_data : '';
      const hasUrl = url.length > 0;
      const hasCallback = callbackData.length > 0;
      if (!text || hasUrl === hasCallback) return null;
      if (hasUrl && !isAllowedInlineButtonUrl(url)) return null;
      if (hasCallback && callbackData.length > 64) return null;
      if (hasUrl) row.push({ text, url });
      else row.push({ text, callback_data: callbackData });
    }
    rows.push(row);
  }
  return rows;
}

function resolveContainerPathToHost(containerPath: string, groupFolder: string): string | null {
  return resolveContainerGroupPathToHost(containerPath, groupFolder, GROUPS_DIR);
}

export interface IpcDispatcherDeps {
  registry: ProviderRegistry;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (chatId: string, group: RegisteredGroup) => void;
  unregisterGroup: (identifier: string) => { ok: boolean; error?: string; group?: RegisteredGroup & { chat_id: string } };
  listRegisteredGroups: () => Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }>;
  sessions: () => Session;
  setSession: (folder: string, id: string) => void;
}

let ipcWatcher: fs.FSWatcher | null = null;
let ipcPollingTimer: NodeJS.Timeout | null = null;
let ipcStopped = false;

export function stopIpcWatcher(): void {
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

export function startIpcWatcher(deps: IpcDispatcherDeps): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  ipcStopped = false;
  let processing = false;
  let scheduled = false;
  let rerunRequested = false;

  const processIpcFiles = async () => {
    if (processing) {
      rerunRequested = true;
      return;
    }
    processing = true;
    try {
      do {
        rerunRequested = false;
        let groupFolders: string[];
        try {
          groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
            const stat = fs.statSync(path.join(ipcBaseDir, f));
            return stat.isDirectory() && f !== 'errors';
          });
        } catch (err) {
          logger.error({ err }, 'Error reading IPC base directory');
          return;
        }

        for (const sourceGroup of groupFolders) {
          const isMain = sourceGroup === MAIN_GROUP_FOLDER;
          const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
          const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
          const requestsDir = path.join(ipcBaseDir, sourceGroup, 'requests');
          const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');

          // Process messages
          try {
            if (fs.existsSync(messagesDir)) {
              const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
              for (const file of messageFiles) {
                const filePath = path.join(messagesDir, file);
                try {
                  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                  await processIpcMessage(deps, data, sourceGroup, isMain);
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

          // Process tasks
          try {
            if (fs.existsSync(tasksDir)) {
              const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
              for (const file of taskFiles) {
                const filePath = path.join(tasksDir, file);
                try {
                  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                  await processTaskIpc(deps, data, sourceGroup, isMain);
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

          // Process request/response IPC
          try {
            if (fs.existsSync(requestsDir)) {
              fs.mkdirSync(responsesDir, { recursive: true });
              const requestFiles = fs.readdirSync(requestsDir).filter(f => f.endsWith('.json'));
              for (const file of requestFiles) {
                const filePath = path.join(requestsDir, file);
                try {
                  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                  const response = await processRequestIpc(deps, data, sourceGroup, isMain);
                  if (response?.id) {
                    const responsePath = path.join(responsesDir, `${response.id}.json`);
                    const tmpPath = responsePath + '.tmp';
                    fs.writeFileSync(tmpPath, JSON.stringify(response, null, 2));
                    fs.renameSync(tmpPath, responsePath);
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
      } while (rerunRequested && !ipcStopped);
    } finally {
      processing = false;
    }
  };

  const scheduleProcess = () => {
    if (ipcStopped) return;
    if (processing) {
      rerunRequested = true;
      return;
    }
    if (scheduled) return;
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

async function processIpcMessage(
  deps: IpcDispatcherDeps,
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean
): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const chatJid = data.chatJid as string | undefined;
  const targetGroup = chatJid ? registeredGroups[chatJid] : undefined;
  const isAuthorized = chatJid && (isMain || (targetGroup && targetGroup.folder === sourceGroup));

  const rawReplyTo = typeof data.reply_to_message_id === 'number'
    ? Math.trunc(data.reply_to_message_id)
    : NaN;
  const replyTo = Number.isInteger(rawReplyTo) && rawReplyTo > 0
    ? String(rawReplyTo)
    : undefined;

  const messageText = typeof data.text === 'string' ? data.text.trim() : '';
  const provider = chatJid ? deps.registry.getProviderForChat(chatJid) : null;
  if (!provider || !chatJid) return;

  if (data.type === 'message' && messageText) {
    if (isAuthorized) {
      await provider.sendMessage(chatJid, messageText, { replyToMessageId: replyTo });
      logger.info({ chatJid, sourceGroup }, 'IPC message sent');
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
    }
  } else if ((data.type === 'send_file' || data.type === 'send_photo') && data.path) {
    if (isAuthorized) {
      const hostPath = resolveContainerPathToHost(data.path as string, sourceGroup);
      if (hostPath && fs.existsSync(hostPath)) {
        const caption = typeof data.caption === 'string' ? data.caption : undefined;
        if (data.type === 'send_photo') {
          await provider.sendPhoto(chatJid, hostPath, { caption, replyToMessageId: replyTo });
        } else {
          await provider.sendDocument(chatJid, hostPath, { caption, replyToMessageId: replyTo });
        }
        logger.info({ chatJid, sourceGroup, type: data.type, path: data.path }, 'IPC file sent');
      } else {
        logger.warn({ chatJid, sourceGroup, path: data.path, hostPath }, 'IPC file not found');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC file send attempt blocked');
    }
  } else if ((data.type === 'send_voice' || data.type === 'send_audio') && data.path) {
    if (isAuthorized) {
      const hostPath = resolveContainerPathToHost(data.path as string, sourceGroup);
      if (hostPath && fs.existsSync(hostPath)) {
        const caption = typeof data.caption === 'string' ? data.caption : undefined;
        const duration = typeof data.duration === 'number' ? data.duration : undefined;
        if (data.type === 'send_voice') {
          await provider.sendVoice(chatJid, hostPath, { caption, duration, replyToMessageId: replyTo });
        } else {
          const performer = typeof data.performer === 'string' ? data.performer : undefined;
          const title = typeof data.title === 'string' ? data.title : undefined;
          await provider.sendAudio(chatJid, hostPath, { caption, duration, performer, title, replyToMessageId: replyTo });
        }
        logger.info({ chatJid, sourceGroup, type: data.type }, 'IPC audio/voice sent');
      } else {
        logger.warn({ chatJid, sourceGroup, path: data.path }, 'IPC audio file not found');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC audio send blocked');
    }
  } else if (data.type === 'send_location') {
    if (isAuthorized) {
      const lat = typeof data.latitude === 'number' ? data.latitude : NaN;
      const lng = typeof data.longitude === 'number' ? data.longitude : NaN;
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        await provider.sendLocation(chatJid, lat, lng, { replyToMessageId: replyTo });
        logger.info({ chatJid, sourceGroup }, 'IPC location sent');
      } else {
        logger.warn({ chatJid, sourceGroup }, 'Invalid location coordinates');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC location send blocked');
    }
  } else if (data.type === 'send_contact') {
    if (isAuthorized) {
      const phone = typeof data.phone_number === 'string' ? data.phone_number.trim() : '';
      const firstName = typeof data.first_name === 'string' ? data.first_name.trim() : '';
      const lastName = typeof data.last_name === 'string' ? data.last_name.trim() : undefined;
      if (phone && firstName) {
        await provider.sendContact(chatJid, phone, firstName, { lastName, replyToMessageId: replyTo });
        logger.info({ chatJid, sourceGroup }, 'IPC contact sent');
      } else {
        logger.warn({ chatJid, sourceGroup }, 'Invalid contact (phone/name missing)');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC contact send blocked');
    }
  } else if (data.type === 'send_poll') {
    if (isAuthorized) {
      const question = typeof data.question === 'string' ? data.question.trim() : '';
      const options = normalizePollOptions(data.options);
      const pollType = data.poll_type === 'quiz' ? 'quiz' as const : 'regular' as const;
      const allowsMultipleAnswers = typeof data.allows_multiple_answers === 'boolean'
        ? data.allows_multiple_answers
        : undefined;
      const rawCorrectOptionId = typeof data.correct_option_id === 'number' ? Math.trunc(data.correct_option_id) : undefined;
      const hasValidCorrectOption = rawCorrectOptionId !== undefined
        && options !== null
        && rawCorrectOptionId >= 0
        && rawCorrectOptionId < options.length;
      const invalidQuizConfig = pollType === 'quiz' && allowsMultipleAnswers;
      const unexpectedCorrectOption = pollType !== 'quiz' && rawCorrectOptionId !== undefined;
      if (question && question.length <= 300 && options && !invalidQuizConfig && !unexpectedCorrectOption && (rawCorrectOptionId === undefined || hasValidCorrectOption)) {
        await provider.sendPoll(chatJid, question, options, {
          isAnonymous: typeof data.is_anonymous === 'boolean' ? data.is_anonymous : undefined,
          type: pollType,
          allowsMultipleAnswers,
          correctOptionId: pollType === 'quiz' ? rawCorrectOptionId : undefined,
          replyToMessageId: replyTo
        });
        logger.info({ chatJid, sourceGroup }, 'IPC poll sent');
      } else {
        logger.warn({ chatJid, sourceGroup }, 'Invalid poll payload');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC poll send blocked');
    }
  } else if (data.type === 'send_buttons') {
    if (isAuthorized) {
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      const normalizedButtons = normalizeInlineKeyboard(data.buttons);
      if (text && normalizedButtons) {
        const buttons = normalizedButtons.map(row =>
          row.map(btn => ({
            text: btn.text,
            callbackData: btn.callback_data,
            url: btn.url,
          }))
        );
        await provider.sendButtons(chatJid, text, buttons, { replyToMessageId: replyTo });
        logger.info({ chatJid, sourceGroup }, 'IPC buttons sent');
      } else {
        logger.warn({ chatJid, sourceGroup }, 'Invalid buttons message');
      }
    } else {
      logger.warn({ chatJid, sourceGroup }, 'Unauthorized IPC buttons send blocked');
    }
  }
}

async function processTaskIpc(
  deps: IpcDispatcherDeps,
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean
): Promise<void> {
  const { CronExpressionParser } = await import('cron-parser');
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task': {
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        const targetGroup = data.groupFolder as string;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }
        const targetChatId = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];
        if (!targetChatId) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }
        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';
        let taskTimezone = TIMEZONE;
        if (typeof data.timezone === 'string' && (data.timezone as string).trim()) {
          const candidateTimezone = (data.timezone as string).trim();
          if (!isValidTimezone(candidateTimezone)) {
            logger.warn({ timezone: data.timezone }, 'Invalid task timezone');
            break;
          }
          taskTimezone = candidateTimezone;
        }
        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value as string, { tz: taskTimezone });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value, timezone: taskTimezone }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value as string, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = parseScheduledTimestamp(data.schedule_value as string, taskTimezone);
          if (!scheduled) {
            logger.warn({ scheduleValue: data.schedule_value, timezone: taskTimezone }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }
        const taskId = generateId('task');
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode as 'group' | 'isolated'
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetChatId,
          prompt: data.prompt as string,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value as string,
          timezone: taskTimezone,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode, timezone: taskTimezone }, 'Task created via IPC');
      }
      break;
    }
    case 'pause_task': {
      if (data.taskId) {
        const task = getTaskById(data.taskId as string);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId as string, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;
    }
    case 'resume_task': {
      if (data.taskId) {
        const task = getTaskById(data.taskId as string);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId as string, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;
    }
    case 'cancel_task': {
      if (data.taskId) {
        const task = getTaskById(data.taskId as string);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId as string);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;
    }
    case 'update_task': {
      if (data.taskId) {
        const task = getTaskById(data.taskId as string);
        if (!task || (!isMain && task.group_folder !== sourceGroup)) {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task update attempt');
          break;
        }
        const updates: Partial<Pick<typeof task, 'prompt' | 'schedule_type' | 'schedule_value' | 'timezone' | 'status' | 'context_mode' | 'state_json' | 'next_run'>> = {};
        if (typeof data.prompt === 'string') updates.prompt = data.prompt;
        if (typeof data.context_mode === 'string') updates.context_mode = data.context_mode as typeof task.context_mode;
        if (typeof data.status === 'string') updates.status = data.status as typeof task.status;
        if (typeof data.state_json === 'string') updates.state_json = data.state_json;
        if (typeof data.timezone === 'string') {
          const timezoneValue = (data.timezone as string).trim();
          if (timezoneValue) {
            if (!isValidTimezone(timezoneValue)) {
              logger.warn({ timezone: data.timezone }, 'Invalid timezone for update_task');
              break;
            }
            updates.timezone = timezoneValue;
          } else {
            updates.timezone = normalizeTaskTimezone(task.timezone, TIMEZONE);
          }
        }
        if (typeof data.schedule_type === 'string' && typeof data.schedule_value === 'string') {
          updates.schedule_type = data.schedule_type as typeof task.schedule_type;
          updates.schedule_value = data.schedule_value;
          const taskTimezone = updates.timezone || task.timezone || TIMEZONE;
          let nextRun: string | null = null;
          if (updates.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(updates.schedule_value, { tz: taskTimezone });
              nextRun = interval.next().toISOString();
            } catch {
              logger.warn({ scheduleValue: updates.schedule_value, timezone: taskTimezone }, 'Invalid cron expression for update_task');
            }
          } else if (updates.schedule_type === 'interval') {
            const ms = parseInt(updates.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              nextRun = new Date(Date.now() + ms).toISOString();
            }
          } else if (updates.schedule_type === 'once') {
            const scheduled = parseScheduledTimestamp(updates.schedule_value, taskTimezone);
            if (scheduled) {
              nextRun = scheduled.toISOString();
            }
          }
          if (nextRun) {
            updates.next_run = nextRun;
          }
        }
        updateTask(data.taskId as string, updates);
        logger.info({ taskId: data.taskId, sourceGroup }, 'Task updated via IPC');
      }
      break;
    }
    case 'register_group': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder) {
        deps.registerGroup(data.jid as string, {
          name: data.name as string,
          folder: data.folder as string,
          trigger: data.trigger as string | undefined,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig as RegisteredGroup['containerConfig'],
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;
    }
    case 'remove_group': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized remove_group attempt blocked');
        break;
      }
      if (!data.identifier || typeof data.identifier !== 'string') {
        logger.warn({ data }, 'Invalid remove_group request - missing identifier');
        break;
      }
      const result = deps.unregisterGroup(data.identifier);
      if (!result.ok) {
        logger.warn({ identifier: data.identifier, error: result.error }, 'Failed to remove group');
      }
      break;
    }
    case 'set_model': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized set_model attempt blocked');
        break;
      }
      if (!data.model || typeof data.model !== 'string') {
        logger.warn({ data }, 'Invalid set_model request - missing model');
        break;
      }
      const defaultModel = runtime.host.defaultModel;
      const config = loadModelRegistry(defaultModel);
      const nextModel = (data.model as string).trim();
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
      break;
    }
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function processRequestIpc(
  deps: IpcDispatcherDeps,
  data: { id?: string; type: string; payload?: Record<string, unknown> },
  sourceGroup: string,
  isMain: boolean
): Promise<{ id?: string; ok: boolean; result?: unknown; error?: string }> {
  const requestId = typeof data.id === 'string' ? data.id : undefined;
  const payload = data.payload || {};
  const registeredGroups = deps.registeredGroups();
  const sessions = deps.sessions();

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
        invalidatePersonalizationCache(groupFolder);
        return { id: requestId, ok: true, result: { count: results.length } };
      }
      case 'memory_forget': {
        const groupFolder = resolveGroupFolder();
        const ids = Array.isArray(payload.ids) ? (payload.ids as string[]) : undefined;
        const content = typeof payload.content === 'string' ? payload.content : undefined;
        const scope = isMemoryScope(payload.scope) ? payload.scope : undefined;
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const count = forgetMemories({ groupFolder, ids, content, scope, userId });
        invalidatePersonalizationCache(groupFolder);
        return { id: requestId, ok: true, result: { count } };
      }
      case 'memory_list': {
        const groupFolder = resolveGroupFolder();
        const scope = isMemoryScope(payload.scope) ? payload.scope : undefined;
        const type = isMemoryType(payload.type) ? payload.type : undefined;
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        const items = listMemories({ groupFolder, scope, type, userId, limit });
        return { id: requestId, ok: true, result: { items } };
      }
      case 'memory_search': {
        const groupFolder = resolveGroupFolder();
        const query = typeof payload.query === 'string' ? payload.query : '';
        const userId = typeof payload.userId === 'string' ? payload.userId : undefined;
        const limit = typeof payload.limit === 'number' ? payload.limit : undefined;
        const results = searchMemories({ groupFolder, userId, query, limit });
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
        const groups = deps.listRegisteredGroups();
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
        const provider = deps.registry.getProviderForChat(task.chat_jid);
        const result = await runTaskNow(taskId, {
          sendMessage: async (jid, text) => { await provider.sendMessage(jid, text); },
          registeredGroups: () => registeredGroups,
          getSessions: () => sessions,
          setSession: (groupFolder, sessionId) => { deps.setSession(groupFolder, sessionId); }
        });
        return {
          id: requestId,
          ok: result.ok,
          result: { result: result.result ?? null },
          error: result.ok ? undefined : result.error
        };
      }
      case 'edit_message': {
        const messageId = typeof payload.message_id === 'number' ? String(payload.message_id) : String(payload.message_id);
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        const chatJid = typeof payload.chat_jid === 'string' ? payload.chat_jid : '';
        if (!text || !chatJid) {
          return { id: requestId, ok: false, error: 'message_id, text, and chat_jid are required.' };
        }
        const group = Object.entries(registeredGroups).find(([id]) => id === chatJid);
        if (!group) {
          return { id: requestId, ok: false, error: 'Chat not registered.' };
        }
        if (!isMain && group[1].folder !== sourceGroup) {
          return { id: requestId, ok: false, error: 'Unauthorized edit_message attempt.' };
        }
        const provider = deps.registry.getProviderForChat(chatJid);
        await provider.editMessage(chatJid, messageId, text);
        return { id: requestId, ok: true, result: { edited: true } };
      }
      case 'delete_message': {
        const messageId = typeof payload.message_id === 'number' ? String(payload.message_id) : String(payload.message_id);
        const chatJid = typeof payload.chat_jid === 'string' ? payload.chat_jid : '';
        if (!chatJid) {
          return { id: requestId, ok: false, error: 'message_id and chat_jid are required.' };
        }
        const group = Object.entries(registeredGroups).find(([id]) => id === chatJid);
        if (!group) {
          return { id: requestId, ok: false, error: 'Chat not registered.' };
        }
        if (!isMain && group[1].folder !== sourceGroup) {
          return { id: requestId, ok: false, error: 'Unauthorized delete_message attempt.' };
        }
        const provider = deps.registry.getProviderForChat(chatJid);
        await provider.deleteMessage(chatJid, messageId);
        return { id: requestId, ok: true, result: { deleted: true } };
      }
      default:
        return { id: requestId, ok: false, error: `Unknown request type: ${data.type}` };
    }
  } catch (err) {
    return { id: requestId, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
