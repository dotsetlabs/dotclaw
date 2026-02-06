import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('routeRequest returns flat config from defaults', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-router-'));
  await withTempHome(tempDir, async () => {
    const { routeRequest } = await importFresh(distPath('request-router.js'));
    const decision = routeRequest();
    assert.equal(typeof decision.model, 'string');
    assert.ok(decision.model.length > 0);
    assert.equal(typeof decision.maxOutputTokens, 'number');
    assert.ok(decision.maxOutputTokens > 0);
    assert.equal(typeof decision.maxToolSteps, 'number');
    assert.ok(decision.maxToolSteps > 0);
    assert.equal(typeof decision.recallMaxResults, 'number');
    assert.equal(typeof decision.recallMaxTokens, 'number');
  });
});

test('routeRequest respects runtime.json overrides', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-router-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: {
      routing: {
        model: 'test/model-123',
        maxOutputTokens: 8192,
        maxToolSteps: 10
      }
    }
  }, null, 2));
  await withTempHome(tempDir, async () => {
    const { routeRequest } = await importFresh(distPath('request-router.js'));
    const decision = routeRequest();
    assert.equal(decision.model, 'test/model-123');
    assert.equal(decision.maxOutputTokens, 8192);
    assert.equal(decision.maxToolSteps, 10);
  });
});

test('routePrompt returns same as routeRequest', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-router-'));
  await withTempHome(tempDir, async () => {
    const { routeRequest, routePrompt } = await importFresh(distPath('request-router.js'));
    const a = routeRequest();
    const b = routePrompt('anything');
    assert.deepEqual(a, b);
  });
});
