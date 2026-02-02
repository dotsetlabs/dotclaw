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

    async registerGroup(args: { jid: string; name: string; folder: string; trigger: string }) {
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

    async setModel(args: { model: string }) {
      if (!isMain) {
        return { ok: false, error: 'Only the main group can change the model.' };
      }
      writeIpcFile(TASKS_DIR, {
        type: 'set_model',
        model: args.model,
        groupFolder,
        chatJid,
        timestamp: new Date().toISOString()
      });
      return { ok: true };
    }
  };
}
