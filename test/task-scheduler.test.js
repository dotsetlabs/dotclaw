import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('computeNextRun respects task timezone for cron schedules', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-scheduler-tz-'));
  await withTempHome(tempDir, async () => {
    const { computeNextRun } = await importFresh(distPath('task-scheduler.js'));
    const nowMs = Date.parse('2026-02-05T12:00:00.000Z');
    const task = {
      id: 'task-tz',
      group_folder: 'main',
      chat_jid: 'chat-1',
      prompt: 'run',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      timezone: 'America/New_York',
      context_mode: 'group',
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: new Date(nowMs).toISOString()
    };

    const result = computeNextRun(task, null, nowMs);
    assert.equal(result.error, null);
    assert.equal(result.nextRun, '2026-02-05T14:00:00.000Z');
    assert.equal(result.retryCount, 0);
  });
});

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
  const notifyLog = path.join(tempDir, 'scheduler-notify.log');
  const script = `
    import { initDatabase, createTask, getTaskById } from ${JSON.stringify(dbUrl)};
    import { startSchedulerLoop, stopSchedulerLoop } from ${JSON.stringify(schedulerUrl)};
    import fs from 'node:fs';

    const taskId = 'task-scheduler-chain-test';
    const notifyLog = ${JSON.stringify(notifyLog)};
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
      sendMessage: async (_jid, text) => {
        fs.appendFileSync(notifyLog, text + '\\n---\\n');
      },
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
    if (!fs.existsSync(notifyLog)) {
      console.error('notification log missing');
      process.exit(5);
    }
    const sent = fs.readFileSync(notifyLog, 'utf-8');
    if (!sent.includes('Scheduled task ' + taskId + ' failed.')) {
      console.error('scheduler notification was not sent', sent);
      process.exit(6);
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
