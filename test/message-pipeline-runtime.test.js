import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('resolveMessagePipelineRuntime applies safe queue bounds from runtime config', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-msg-runtime-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: {
      messageQueue: {
        interruptOnNewMessage: false,
        maxRetries: 0,
        retryBaseMs: 10,
        retryMaxMs: 50,
        promptMaxChars: 100,
        batchWindowMs: -1,
        maxBatchSize: 0
      }
    },
    agent: {
      reasoning: { effort: 'low' }
    }
  }, null, 2));

  await withTempHome(tempDir, async () => {
    const { resolveMessagePipelineRuntime } = await importFresh(distPath('message-pipeline.js'));
    const runtime = resolveMessagePipelineRuntime();
    assert.equal(runtime.queue.interruptOnNewMessage, false);
    assert.equal(runtime.queue.maxRetries, 1);
    assert.equal(runtime.queue.retryBaseMs, 250);
    assert.equal(runtime.queue.retryMaxMs, 250);
    assert.equal(runtime.queue.promptMaxChars, 2000);
    assert.equal(runtime.queue.batchWindowMs, 0);
    assert.equal(runtime.queue.maxBatchSize, 1);
    assert.equal(runtime.reasoningEffort, 'low');
  });
});
