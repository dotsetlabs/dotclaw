import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('createWorkflowRun and getWorkflowRun round-trip', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-wfstore-'));
  await withTempHome(tempDir, async () => {
    const mod = await importFresh(distPath('workflow-store.js'));
    const now = new Date().toISOString();
    mod.createWorkflowRun({
      id: 'wf-test-1',
      workflow_name: 'test-workflow',
      group_folder: 'main',
      chat_jid: 'chat@g.us',
      status: 'running',
      current_step: null,
      state_json: null,
      params_json: null,
      created_at: now,
      updated_at: now
    });

    const run = mod.getWorkflowRun('wf-test-1');
    assert.ok(run);
    assert.equal(run.workflow_name, 'test-workflow');
    assert.equal(run.status, 'running');
    mod.closeWorkflowStore();
  });
});

test('cleanupOldWorkflowRuns removes old completed runs and step results', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-wfcleanup-'));
  await withTempHome(tempDir, async () => {
    const mod = await importFresh(distPath('workflow-store.js'));
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const recentDate = new Date().toISOString();

    // Create an old completed run
    mod.createWorkflowRun({
      id: 'wf-old',
      workflow_name: 'old-workflow',
      group_folder: 'main',
      chat_jid: 'chat@g.us',
      status: 'completed',
      current_step: null,
      state_json: null,
      params_json: null,
      created_at: oldDate,
      updated_at: oldDate
    });
    mod.updateWorkflowRun('wf-old', { status: 'completed', finished_at: oldDate });
    mod.upsertStepResult('wf-old', 'step1', { status: 'completed', result: 'done' });

    // Create a recent completed run
    mod.createWorkflowRun({
      id: 'wf-recent',
      workflow_name: 'recent-workflow',
      group_folder: 'main',
      chat_jid: 'chat@g.us',
      status: 'completed',
      current_step: null,
      state_json: null,
      params_json: null,
      created_at: recentDate,
      updated_at: recentDate
    });
    mod.updateWorkflowRun('wf-recent', { status: 'completed', finished_at: recentDate });
    mod.upsertStepResult('wf-recent', 'step1', { status: 'completed', result: 'done' });

    // Create an old running run (should NOT be cleaned up)
    mod.createWorkflowRun({
      id: 'wf-running',
      workflow_name: 'running-workflow',
      group_folder: 'main',
      chat_jid: 'chat@g.us',
      status: 'running',
      current_step: 'step1',
      state_json: null,
      params_json: null,
      created_at: oldDate,
      updated_at: oldDate
    });

    const retentionMs = 30 * 24 * 60 * 60 * 1000; // 30 days
    const removed = mod.cleanupOldWorkflowRuns(retentionMs);
    assert.equal(removed, 1, 'Should remove only the old completed run');

    assert.equal(mod.getWorkflowRun('wf-old'), undefined, 'Old completed run should be removed');
    assert.ok(mod.getWorkflowRun('wf-recent'), 'Recent completed run should remain');
    assert.ok(mod.getWorkflowRun('wf-running'), 'Running run should remain regardless of age');

    const oldSteps = mod.getStepResults('wf-old');
    assert.equal(oldSteps.length, 0, 'Step results for old run should be removed');

    const recentSteps = mod.getStepResults('wf-recent');
    assert.equal(recentSteps.length, 1, 'Step results for recent run should remain');

    mod.closeWorkflowStore();
  });
});

test('closeWorkflowStore closes the database connection', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-wfclose-'));
  await withTempHome(tempDir, async () => {
    const mod = await importFresh(distPath('workflow-store.js'));
    const now = new Date().toISOString();
    mod.createWorkflowRun({
      id: 'wf-close-test',
      workflow_name: 'test',
      group_folder: 'main',
      chat_jid: 'chat@g.us',
      status: 'pending',
      current_step: null,
      state_json: null,
      params_json: null,
      created_at: now,
      updated_at: now
    });

    // Close should not throw
    assert.doesNotThrow(() => mod.closeWorkflowStore());

    // Calling close again should be safe (idempotent)
    assert.doesNotThrow(() => mod.closeWorkflowStore());
  });
});
