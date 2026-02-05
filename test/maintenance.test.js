import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

// Use a single shared temp dir for all tests. The maintenance module imports
// DATA_DIR / TRACE_DIR from config.js as module-level constants that get frozen
// on first load. Using per-test temp dirs (beforeEach) caused the IPC tests to
// fail because config.js was cached with the first test's (now-deleted) tmpDir.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-maint-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('cleanupTraceFiles removes old trace files', async () => {
  await withTempHome(tmpDir, async () => {
    const tracesDir = path.join(tmpDir, 'traces');
    fs.mkdirSync(tracesDir, { recursive: true });

    // Create an old trace file (30 days ago)
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const oldDateStr = oldDate.toISOString().slice(0, 10);
    const oldFile = path.join(tracesDir, `trace-${oldDateStr}.jsonl`);
    fs.writeFileSync(oldFile, '{"test": true}\n');

    // Create a recent trace file (today)
    const now = new Date();
    const nowDateStr = now.toISOString().slice(0, 10);
    const newFile = path.join(tracesDir, `trace-${nowDateStr}.jsonl`);
    fs.writeFileSync(newFile, '{"test": true}\n');

    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupTraceFiles(14);

    assert.equal(removed, 1);
    assert.ok(!fs.existsSync(oldFile), 'Old file should be removed');
    assert.ok(fs.existsSync(newFile), 'Recent file should remain');
  });
});

test('cleanupTraceFiles returns 0 for zero retention days', async () => {
  await withTempHome(tmpDir, async () => {
    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupTraceFiles(0);
    assert.equal(removed, 0);
  });
});

test('cleanupTraceFiles returns 0 when trace dir has no old files', async () => {
  await withTempHome(tmpDir, async () => {
    // traces dir exists from the first test with only the recent file remaining
    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupTraceFiles(14);
    assert.equal(removed, 0);
  });
});

test('cleanupOrphanedIpcFiles removes stale IPC files', async () => {
  await withTempHome(tmpDir, async () => {
    const ipcDir = path.join(tmpDir, 'data', 'ipc', 'main', 'requests');
    const agentRequestsDir = path.join(tmpDir, 'data', 'ipc', 'main', 'agent_requests');
    fs.mkdirSync(ipcDir, { recursive: true });
    fs.mkdirSync(agentRequestsDir, { recursive: true });

    // Create a stale file (set mtime to 10 minutes ago)
    const staleFile = path.join(ipcDir, 'old-request.json');
    fs.writeFileSync(staleFile, '{}');
    const pastTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(staleFile, pastTime, pastTime);

    // Create a fresh file
    const freshFile = path.join(ipcDir, 'fresh-request.json');
    fs.writeFileSync(freshFile, '{}');

    // Create stale and fresh daemon cancel sentinels
    const staleCancel = path.join(agentRequestsDir, 'old-request.cancel');
    fs.writeFileSync(staleCancel, '');
    fs.utimesSync(staleCancel, pastTime, pastTime);
    const freshCancel = path.join(agentRequestsDir, 'fresh-request.cancel');
    fs.writeFileSync(freshCancel, '');

    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupOrphanedIpcFiles();

    assert.equal(removed, 2);
    assert.ok(!fs.existsSync(staleFile), 'Stale file should be removed');
    assert.ok(!fs.existsSync(staleCancel), 'Stale cancel sentinel should be removed');
    assert.ok(fs.existsSync(freshFile), 'Fresh file should remain');
    assert.ok(fs.existsSync(freshCancel), 'Fresh cancel sentinel should remain');
  });
});

test('cleanupOrphanedIpcFiles returns 0 when no stale files', async () => {
  await withTempHome(tmpDir, async () => {
    // IPC dir still has the fresh file from the previous test
    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupOrphanedIpcFiles();
    assert.equal(removed, 0);
  });
});

test('cleanupIpcErrorFiles removes old error files', async () => {
  await withTempHome(tmpDir, async () => {
    const errorsDir = path.join(tmpDir, 'data', 'ipc', 'errors');
    fs.mkdirSync(errorsDir, { recursive: true });

    // Create an old error file (2 days ago)
    const oldFile = path.join(errorsDir, 'old-error.json');
    fs.writeFileSync(oldFile, '{}');
    const pastTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, pastTime, pastTime);

    // Create a recent error file
    const recentFile = path.join(errorsDir, 'recent-error.json');
    fs.writeFileSync(recentFile, '{}');

    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupIpcErrorFiles();

    assert.equal(removed, 1);
    assert.ok(!fs.existsSync(oldFile), 'Old error file should be removed');
    assert.ok(fs.existsSync(recentFile), 'Recent error file should remain');
  });
});

test('cleanupIpcErrorFiles returns 0 when no old error files', async () => {
  await withTempHome(tmpDir, async () => {
    // errors dir still has the recent file from the previous test
    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupIpcErrorFiles();
    assert.equal(removed, 0);
  });
});

test('cleanupStaleSessionSnapshots removes stale session snapshot directories', async () => {
  await withTempHome(tmpDir, async () => {
    const openrouterDir = path.join(tmpDir, 'data', 'sessions', 'main', 'openrouter');
    fs.mkdirSync(openrouterDir, { recursive: true });

    const staleDash = path.join(openrouterDir, 'session-stale-1');
    const staleUnderscore = path.join(openrouterDir, 'session_stale_2');
    const freshDash = path.join(openrouterDir, 'session-fresh-3');
    const nonSession = path.join(openrouterDir, 'notes');
    fs.mkdirSync(staleDash, { recursive: true });
    fs.mkdirSync(staleUnderscore, { recursive: true });
    fs.mkdirSync(freshDash, { recursive: true });
    fs.mkdirSync(nonSession, { recursive: true });

    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleDash, oldTime, oldTime);
    fs.utimesSync(staleUnderscore, oldTime, oldTime);

    const mod = await importFresh(distPath('maintenance.js'));
    const removed = mod.cleanupStaleSessionSnapshots();

    assert.equal(removed, 2);
    assert.equal(fs.existsSync(staleDash), false);
    assert.equal(fs.existsSync(staleUnderscore), false);
    assert.equal(fs.existsSync(freshDash), true);
    assert.equal(fs.existsSync(nonSession), true);
  });
});
