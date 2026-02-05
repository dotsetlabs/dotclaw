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
