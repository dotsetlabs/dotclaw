import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { distPath } from './test-helpers.js';

test('scheduler loop executes claimed due tasks instead of skipping them', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-scheduler-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: {
      scheduler: {
        pollIntervalMs: 25,
        taskMaxRetries: 1,
        taskRetryBaseMs: 25,
        taskRetryMaxMs: 100,
        taskTimeoutMs: 2000
      }
    }
  }, null, 2));

  const dbUrl = pathToFileURL(distPath('db.js')).href;
  const schedulerUrl = pathToFileURL(distPath('task-scheduler.js')).href;
  const script = `
    import { initDatabase, createTask, getTaskById } from ${JSON.stringify(dbUrl)};
    import { startSchedulerLoop, stopSchedulerLoop } from ${JSON.stringify(schedulerUrl)};

    const taskId = 'task-scheduler-chain-test';
    initDatabase();
    createTask({
      id: taskId,
      group_folder: 'missing-group',
      chat_jid: 'chat-1',
      prompt: 'run chain test',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString()
    });

    startSchedulerLoop({
      sendMessage: async () => {},
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      setSession: () => {}
    });

    const deadline = Date.now() + 2000;
    let task = getTaskById(taskId);
    while (Date.now() < deadline) {
      task = getTaskById(taskId);
      if (task && task.last_result) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    stopSchedulerLoop();
    await new Promise(resolve => setTimeout(resolve, 50));
    task = getTaskById(taskId);

    if (!task) {
      console.error('task not found after scheduler run');
      process.exit(2);
    }
    if (!task.last_result || !task.last_result.includes('Group not found: missing-group')) {
      console.error('task did not run as expected', task.last_result);
      process.exit(3);
    }
    if (task.running_since) {
      console.error('running_since not cleared', task.running_since);
      process.exit(4);
    }
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      DOTCLAW_HOME: tempDir,
      HOME: tempDir
    },
    encoding: 'utf-8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout || 'scheduler subprocess failed');
});
