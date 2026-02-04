/**
 * IPC utilities for DotClaw (container-side).
 * Writes messages and task operations to /workspace/ipc for the host to consume.
 */

import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const REQUESTS_DIR = path.join(IPC_DIR, 'requests');
const RESPONSES_DIR = path.join(IPC_DIR, 'responses');
const DEFAULT_REQUEST_TIMEOUT_MS = parseInt(process.env.DOTCLAW_IPC_REQUEST_TIMEOUT_MS || '6000', 10);
const DEFAULT_REQUEST_POLL_MS = parseInt(process.env.DOTCLAW_IPC_REQUEST_POLL_MS || '150', 10);

export interface IpcContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestResponse(type: string, payload: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });

  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    await sleep(DEFAULT_REQUEST_POLL_MS);
  }

  return { ok: false, error: `IPC request timeout (${timeoutMs}ms)` };
}

export function createIpcHandlers(ctx: IpcContext) {
  const { chatJid, groupFolder, isMain } = ctx;

  return {
    async sendMessage(text: string) {
      const data = {
        type: 'message',
        chatJid,
        text,
        groupFolder,
        timestamp: new Date().toISOString()
      };
      const filename = writeIpcFile(MESSAGES_DIR, data);
      return { ok: true, id: filename };
    },

    async scheduleTask(args: {
      prompt: string;
      schedule_type: 'cron' | 'interval' | 'once';
      schedule_value: string;
      context_mode?: 'group' | 'isolated';
      target_group?: string;
    }) {
      if (args.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(args.schedule_value);
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

    async updateTask(args: { task_id: string; state_json?: string; prompt?: string; schedule_type?: string; schedule_value?: string; context_mode?: string; status?: string }) {
      writeIpcFile(TASKS_DIR, {
        type: 'update_task',
        taskId: args.task_id,
        state_json: args.state_json,
        prompt: args.prompt,
        schedule_type: args.schedule_type,
        schedule_value: args.schedule_value,
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
      return requestResponse('list_groups', {});
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
      });
    },

    async memoryForget(args: { ids?: string[]; content?: string; scope?: string; userId?: string; target_group?: string }) {
      return requestResponse('memory_forget', {
        ids: args.ids,
        content: args.content,
        scope: args.scope,
        userId: args.userId,
        target_group: args.target_group
      });
    },

    async memoryList(args: { scope?: string; type?: string; userId?: string; limit?: number; target_group?: string }) {
      return requestResponse('memory_list', {
        scope: args.scope,
        type: args.type,
        userId: args.userId,
        limit: args.limit,
        target_group: args.target_group
      });
    },

    async memorySearch(args: { query: string; userId?: string; limit?: number; target_group?: string }) {
      return requestResponse('memory_search', {
        query: args.query,
        userId: args.userId,
        limit: args.limit,
        target_group: args.target_group
      });
    },

    async memoryStats(args: { userId?: string; target_group?: string }) {
      return requestResponse('memory_stats', {
        userId: args.userId,
        target_group: args.target_group
      });
    }
  };
}
