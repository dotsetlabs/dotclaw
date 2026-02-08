import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh } from './test-helpers.js';

const hostFailoverConfig = {
  enabled: true,
  maxRetries: 1,
  cooldownRateLimitMs: 60_000,
  cooldownTransientMs: 300_000,
  cooldownInvalidResponseMs: 120_000
};

test('host cooldown persistence survives module reload (simulated restart)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-failover-persist-'));
  const storePath = path.join(tempDir, 'failover-cooldowns.json');
  const prevPath = process.env.DOTCLAW_FAILOVER_COOLDOWN_PATH;
  const prevDisable = process.env.DOTCLAW_DISABLE_FAILOVER_COOLDOWN_PERSISTENCE;

  process.env.DOTCLAW_FAILOVER_COOLDOWN_PATH = storePath;
  delete process.env.DOTCLAW_DISABLE_FAILOVER_COOLDOWN_PERSISTENCE;

  try {
    const first = await importFresh(distPath('failover-policy.js'));
    first.resetFailoverCooldownsForTests();
    const nowMs = Date.now();
    first.registerModelFailureCooldown('model-timeout', 'timeout', hostFailoverConfig, nowMs);
    assert.equal(fs.existsSync(storePath), true);
    assert.equal(first.isModelInHostCooldown('model-timeout', nowMs + 1), true);

    const second = await importFresh(distPath('failover-policy.js'));
    assert.equal(second.isModelInHostCooldown('model-timeout', nowMs + 1), true);
    assert.equal(second.isModelInHostCooldown('model-timeout', nowMs + (2 * 60 * 60 * 1000)), false);
  } finally {
    if (prevPath === undefined) {
      delete process.env.DOTCLAW_FAILOVER_COOLDOWN_PATH;
    } else {
      process.env.DOTCLAW_FAILOVER_COOLDOWN_PATH = prevPath;
    }
    if (prevDisable === undefined) {
      delete process.env.DOTCLAW_DISABLE_FAILOVER_COOLDOWN_PERSISTENCE;
    } else {
      process.env.DOTCLAW_DISABLE_FAILOVER_COOLDOWN_PERSISTENCE = prevDisable;
    }
  }
});
