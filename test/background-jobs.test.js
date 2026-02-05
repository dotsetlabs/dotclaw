import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('spawnBackgroundJob queues a job and cancelBackgroundJob marks it canceled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-bg-jobs-'));

  await withTempHome(tempDir, async () => {
    const {
      spawnBackgroundJob,
      listBackgroundJobsForGroup,
      cancelBackgroundJob,
      getBackgroundJobStatus
    } = await importFresh(distPath('background-jobs.js'));
    const { initDatabase } = await import(distPath('db.js'));
    initDatabase();

    const result = spawnBackgroundJob({
      prompt: 'Do a deep analysis of X',
      groupFolder: 'main',
      chatJid: 'chat-1'
    });

    assert.equal(result.ok, true);
    assert.ok(result.jobId);

    const jobs = listBackgroundJobsForGroup({ groupFolder: 'main' });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'queued');

    const cancelResult = cancelBackgroundJob(jobs[0].id);
    assert.equal(cancelResult.ok, true);

    const status = getBackgroundJobStatus(jobs[0].id);
    assert.equal(status?.status, 'canceled');
  });
});

test('resolveBackgroundJobStatus distinguishes timeout from cancel', async () => {
  const { resolveBackgroundJobStatus } = await importFresh(distPath('background-jobs.js'));

  assert.equal(resolveBackgroundJobStatus({
    aborted: true,
    abortReason: 'timeout',
    error: null
  }), 'timed_out');

  assert.equal(resolveBackgroundJobStatus({
    aborted: true,
    abortReason: 'canceled_by_user',
    error: null
  }), 'canceled');

  assert.equal(resolveBackgroundJobStatus({
    aborted: false,
    error: 'Request timed out after 30s'
  }), 'timed_out');

  assert.equal(resolveBackgroundJobStatus({
    aborted: false,
    error: 'Something failed'
  }), 'failed');

  assert.equal(resolveBackgroundJobStatus({
    aborted: true,
    abortReason: 'timeout',
    latestStatus: 'canceled',
    error: null
  }), 'canceled');
});

test('resetStalledBackgroundJobs re-queues running jobs after restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-bg-recovery-'));
  await withTempHome(tempDir, async () => {
    const {
      initDatabase,
      createBackgroundJob,
      updateBackgroundJob,
      getBackgroundJobById,
      resetStalledBackgroundJobs
    } = await importFresh(distPath('db.js'));
    initDatabase();

    createBackgroundJob({
      id: 'job-recover-1',
      group_folder: 'main',
      chat_jid: 'chat-1',
      prompt: 'recover me',
      context_mode: 'group',
      status: 'queued'
    });
    updateBackgroundJob('job-recover-1', {
      status: 'running',
      started_at: new Date(Date.now() - 30_000).toISOString(),
      lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
      updated_at: new Date().toISOString()
    });

    const resetCount = resetStalledBackgroundJobs();
    assert.equal(resetCount, 1);

    const recovered = getBackgroundJobById('job-recover-1');
    assert.equal(recovered?.status, 'queued');
    assert.equal(recovered?.started_at, null);
    assert.equal(recovered?.lease_expires_at, null);
    assert.equal(typeof recovered?.last_error, 'string');
    assert.match(recovered?.last_error || '', /recovered after restart/i);
  });
});
