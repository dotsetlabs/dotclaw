/**
 * IPC utilities for DotClaw (container-side).
 * Writes messages and task operations to /workspace/ipc for the host to consume.
 */

import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { generateId } from './id.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const REQUESTS_DIR = path.join(IPC_DIR, 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

export interface IpcContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export interface IpcConfig {
  requestTimeoutMs: number;
  requestPollMs: number;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${generateId('')}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

async function requestResponse(
  type: string,
  payload: Record<string, unknown>,
  config: IpcConfig,
  timeoutMs = config.requestTimeoutMs
) {
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });

  const id = generateId('req');
  writeIpcFile(REQUESTS_DIR, {
    id,
    type,
    payload,
    timestamp: new Date().toISOString()
  });

  const deadline = Date.now() + timeoutMs;
  const responsePath = path.join(RESPONSES_DIR, `${id}.json`);

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const responseRaw = fs.readFileSync(responsePath, 'utf-8');
      fs.unlinkSync(responsePath);
      try {
        return JSON.parse(responseRaw);
      } catch {
        return { ok: false, error: 'Failed to parse IPC response' };
      }
    }
    await sleep(config.requestPollMs);
  }

  return { ok: false, error: `IPC request timeout (${timeoutMs}ms)` };
}

export function createIpcHandlers(ctx: IpcContext, config: IpcConfig) {
  const { chatJid, groupFolder, isMain } = ctx;

  return {
    async sendMessage(text: string, options?: { reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'message',
        chatJid,
        text,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (options?.reply_to_message_id) data.reply_to_message_id = options.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendFile(args: { path: string; caption?: string; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_file',
        chatJid,
        path: args.path,
        caption: args.caption,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendPhoto(args: { path: string; caption?: string; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_photo',
        chatJid,
        path: args.path,
        caption: args.caption,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendVoice(args: { path: string; caption?: string; duration?: number; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_voice',
        chatJid,
        path: args.path,
        caption: args.caption,
        duration: args.duration,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendAudio(args: { path: string; caption?: string; duration?: number; performer?: string; title?: string; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_audio',
        chatJid,
        path: args.path,
        caption: args.caption,
        duration: args.duration,
        performer: args.performer,
        title: args.title,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendLocation(args: { latitude: number; longitude: number; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_location',
        chatJid,
        latitude: args.latitude,
        longitude: args.longitude,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendContact(args: { phone_number: string; first_name: string; last_name?: string; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_contact',
        chatJid,
        phone_number: args.phone_number,
        first_name: args.first_name,
        last_name: args.last_name,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendPoll(args: {
      question: string;
      options: string[];
      is_anonymous?: boolean;
      allows_multiple_answers?: boolean;
      type?: string;
      correct_option_id?: number;
      reply_to_message_id?: number;
    }) {
      const data: Record<string, unknown> = {
        type: 'send_poll',
        chatJid,
        question: args.question,
        options: args.options,
        is_anonymous: args.is_anonymous,
        allows_multiple_answers: args.allows_multiple_answers,
        poll_type: args.type,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (typeof args.correct_option_id === 'number') data.correct_option_id = args.correct_option_id;
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async sendButtons(args: { text: string; buttons: Array<Array<{ text: string; url?: string; callback_data?: string }>>; reply_to_message_id?: number }) {
      const data: Record<string, unknown> = {
        type: 'send_buttons',
        chatJid,
        text: args.text,
        buttons: args.buttons,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      if (args.reply_to_message_id) data.reply_to_message_id = args.reply_to_message_id;
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },
    async editMessage(args: { message_id: number; text: string; chat_jid?: string }) {
      return requestResponse('edit_message', {
        message_id: args.message_id,
        text: args.text,
        chat_jid: args.chat_jid || chatJid
      }, config);
    },
    async deleteMessage(args: { message_id: number; chat_jid?: string }) {
      return requestResponse('delete_message', {
        message_id: args.message_id,
        chat_jid: args.chat_jid || chatJid
      }, config);
    },
    async scheduleTask(args: {
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      timezone?: string;
      context_mode?: 'group' | 'isolated';
      target_group?: string;
    }) {
      const timezone = typeof args.timezone === 'string' && args.timezone.trim()
        ? args.timezone.trim()
        : undefined;
      if (timezone && !isValidTimezone(timezone)) {
        return {
          ok: false,
          error: `Invalid timezone: "${args.timezone}". Use an IANA timezone like "America/New_York".`
        };
      }
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value, timezone ? { tz: timezone } : undefined);
        } catch {
          return {
            ok: false,
            error: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`
          };
        }
      } else if (args.schedule_type === 'interval') {
        const ms = parseInt(args.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            ok: false,
            error: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`
          };
        }
      } else if (args.schedule_type === 'once') {
        const date = new Date(args.schedule_value);
        if (isNaN(date.getTime())) {
          return {
            ok: false,
            error: `Invalid timestamp: "${args.schedule_value}". Use local ISO 8601 format like "2026-02-01T15:30:00" (no Z/UTC suffix).`
          };
        }
      }

      const targetGroup = isMain && args.target_group ? args.target_group : groupFolder;

      const data = {
        type: 'schedule_task',
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        timezone,
        context_mode: args.context_mode || 'group',
        groupFolder: targetGroup,
        chatJid,
        createdBy: groupFolder,
        timestamp: new Date().toISOString()
      };

      const filename = writeIpcFile(TASKS_DIR, data);
      return { ok: true, id: filename };
    },

    async listTasks() {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
      if (!fs.existsSync(tasksFile)) {
        return { ok: true, tasks: [] as string[] };
      }
      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);
      return { ok: true, tasks };
    },

    async pauseTask(taskId: string) {
      writeIpcFile(TASKS_DIR, {
        type: 'pause_task',
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async resumeTask(taskId: string) {
      writeIpcFile(TASKS_DIR, {
        type: 'resume_task',
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async cancelTask(taskId: string) {
      writeIpcFile(TASKS_DIR, {
        type: 'cancel_task',
        taskId,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async updateTask(args: { task_id: string; state_json?: string; prompt?: string; schedule_type?: string; schedule_value?: string; timezone?: string; context_mode?: string; status?: string }) {
      const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : undefined;
      if (timezone && !isValidTimezone(timezone)) {
        return { ok: false, error: `Invalid timezone: "${args.timezone}".` };
      }
      writeIpcFile(TASKS_DIR, {
        type: 'update_task',
        taskId: args.task_id,
        state_json: args.state_json,
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
        timezone,
        context_mode: args.context_mode,
        status: args.status,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async registerGroup(args: { jid: string; name: string; folder: string; trigger?: string }) {
      if (!isMain) {
        return { ok: false, error: 'Only the main group can register new groups.' };
      }
      writeIpcFile(TASKS_DIR, {
        type: 'register_group',
        jid: args.jid,
        name: args.name,
        folder: args.folder,
        trigger: args.trigger,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async removeGroup(args: { identifier: string }) {
      if (!isMain) {
        return { ok: false, error: 'Only the main group can remove groups.' };
      }
      if (!args.identifier || typeof args.identifier !== 'string') {
        return { ok: false, error: 'identifier is required (chat id, name, or folder).' };
      }
      writeIpcFile(TASKS_DIR, {
        type: 'remove_group',
        identifier: args.identifier,
        groupFolder,
        isMain,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async listGroups() {
      if (!isMain) {
        return { ok: false, error: 'Only the main group can list groups.' };
      }
      return requestResponse('list_groups', {}, config);
    },

    async runTask(taskId: string) {
      return requestResponse('run_task', { task_id: taskId }, config);
    },

    async spawnJob(args: {
      prompt: string;
      context_mode?: 'group' | 'isolated';
      timeout_ms?: number;
      max_tool_steps?: number;
      tool_allow?: string[];
      tool_deny?: string[];
      model_override?: string;
      priority?: number;
      tags?: string[];
      target_group?: string;
    }) {
      return requestResponse('spawn_job', args as Record<string, unknown>, config);
    },

    async jobStatus(jobId: string) {
      return requestResponse('job_status', { job_id: jobId }, config);
    },

    async listJobs(args: { status?: string; limit?: number; target_group?: string }) {
      return requestResponse('list_jobs', args as Record<string, unknown>, config);
    },

    async cancelJob(jobId: string) {
      return requestResponse('cancel_job', { job_id: jobId }, config);
    },

    async jobUpdate(args: { job_id: string; message: string; level?: string; notify?: boolean; data?: Record<string, unknown> }) {
      return requestResponse('job_update', args as Record<string, unknown>, config);
    },

    async setModel(args: { model: string; scope?: 'global' | 'group' | 'user'; target_id?: string }) {
      if (!isMain) {
        return { ok: false, error: 'Only the main group can change the model.' };
      }
      writeIpcFile(TASKS_DIR, {
        type: 'set_model',
        model: args.model,
        scope: args.scope,
        target_id: args.target_id,
        groupFolder,
        chatJid,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    },

    async memoryUpsert(args: { items: unknown[]; source?: string; target_group?: string }) {
      return requestResponse('memory_upsert', {
        items: args.items,
        source: args.source,
        target_group: args.target_group
      }, config);
    },

    async memoryForget(args: { ids?: string[]; content?: string; scope?: string; userId?: string; target_group?: string }) {
      return requestResponse('memory_forget', {
        ids: args.ids,
        content: args.content,
        scope: args.scope,
        userId: args.userId,
        target_group: args.target_group
      }, config);
    },

    async memoryList(args: { scope?: string; type?: string; userId?: string; limit?: number; target_group?: string }) {
      return requestResponse('memory_list', {
        scope: args.scope,
        type: args.type,
        userId: args.userId,
        limit: args.limit,
        target_group: args.target_group
      }, config);
    },

    async memorySearch(args: { query: string; userId?: string; limit?: number; target_group?: string }) {
      return requestResponse('memory_search', {
        query: args.query,
        userId: args.userId,
        limit: args.limit,
        target_group: args.target_group
      }, config);
    },

    async memoryStats(args: { userId?: string; target_group?: string }) {
      return requestResponse('memory_stats', {
        userId: args.userId,
        target_group: args.target_group
      }, config);
    }
  };
}
