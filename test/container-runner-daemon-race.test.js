import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('waitForAgentResponse tolerates partial-write parse race and returns final payload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-daemon-race-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: { container: { daemonPollMs: 25 } }
  }));

  await withTempHome(tempDir, async () => {
    const { waitForAgentResponse } = await importFresh(distPath('container-runner.js'));
    const responsePath = path.join(tempDir, 'response.json');

    const waiter = waitForAgentResponse(responsePath, 2_000);

    // Simulate daemon writing a partial response first, then completing it.
    fs.writeFileSync(responsePath, '{"status":"success","result":"partial');
    await sleep(40);
    fs.writeFileSync(responsePath, JSON.stringify({ status: 'success', result: 'final' }));

    const output = await waiter;
    assert.equal(output.status, 'success');
    assert.equal(output.result, 'final');
  });
});

test('waitForAgentResponse aborts cleanly while waiting', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-daemon-race-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: { container: { daemonPollMs: 25 } }
  }));

  await withTempHome(tempDir, async () => {
    const { waitForAgentResponse } = await importFresh(distPath('container-runner.js'));
    const responsePath = path.join(tempDir, 'response.json');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);

    await assert.rejects(
      () => waitForAgentResponse(responsePath, 1_000, ac.signal),
      /preempted/i
    );
  });
});

test('waitForAgentResponse tolerates ENOENT stat race during parse retry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-daemon-race-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: { container: { daemonPollMs: 25 } }
  }));

  await withTempHome(tempDir, async () => {
    const { waitForAgentResponse } = await importFresh(distPath('container-runner.js'));
    const responsePath = path.join(tempDir, 'response-enoent.json');
    const originalStatSync = fs.statSync;
    let injected = false;

    fs.statSync = ((targetPath, ...rest) => {
      if (!injected && targetPath === responsePath) {
        injected = true;
        const err = new Error('simulated stat race');
        err.code = 'ENOENT';
        throw err;
      }
      return originalStatSync(targetPath, ...rest);
    });

    try {
      const waiter = waitForAgentResponse(responsePath, 2_000);
      fs.writeFileSync(responsePath, '{"status":"success","result":"partial');
      await sleep(40);
      fs.writeFileSync(responsePath, JSON.stringify({ status: 'success', result: 'final-after-enoent' }));
      const output = await waiter;
      assert.equal(output.status, 'success');
      assert.equal(output.result, 'final-after-enoent');
    } finally {
      fs.statSync = originalStatSync;
    }
  });
});

test('waitForAgentResponse extends timeout for active daemon request', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-daemon-race-'));
  const ipcDir = path.join(tempDir, 'ipc', 'main');
  fs.mkdirSync(ipcDir, { recursive: true });
  const { waitForAgentResponse } = await importFresh(distPath('container-runner.js'));
  const responsePath = path.join(tempDir, 'response-extended.json');
  const requestId = 'req-extend-1';
  const statusPath = path.join(ipcDir, 'daemon_status.json');

  fs.writeFileSync(statusPath, JSON.stringify({
    state: 'processing',
    ts: Date.now(),
    request_id: requestId,
    started_at: Date.now(),
    pid: process.pid
  }));

  const waiter = waitForAgentResponse(responsePath, 120, undefined, {
    requestId,
    maxExtensionMs: 300,
    daemonStatusPath: statusPath
  });

  await sleep(180);
  fs.writeFileSync(responsePath, JSON.stringify({ status: 'success', result: 'extended-final' }));

  const output = await waiter;
  assert.equal(output.status, 'success');
  assert.equal(output.result, 'extended-final');
});

test('shouldRetryDaemonRequestError only retries recoverable daemon failures', async () => {
  const { shouldRetryDaemonRequestError } = await importFresh(distPath('container-runner.js'));
  assert.equal(shouldRetryDaemonRequestError('Daemon response timeout after 30000ms'), true);
  assert.equal(shouldRetryDaemonRequestError('Failed to parse daemon response after 8 attempts'), true);
  assert.equal(shouldRetryDaemonRequestError('Stale daemon response file: invalid payload'), true);
  assert.equal(shouldRetryDaemonRequestError('Container run preempted'), false);
  assert.equal(shouldRetryDaemonRequestError('model not found'), false);
});
