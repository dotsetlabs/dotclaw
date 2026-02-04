import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

test('loadBehaviorConfig clamps values and validates style', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-behavior-'));
  await withTempCwd(tempDir, async () => {
    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'behavior.json'), JSON.stringify({
      tool_calling_bias: 5,
      memory_importance_threshold: -1,
      response_style: 'wild',
      caution_bias: Number.NaN,
      last_updated: '2026-02-02T00:00:00.000Z'
    }));

    const { loadBehaviorConfig, adjustBehaviorConfig } = await importFresh(distPath('behavior-config.js'));
    const config = loadBehaviorConfig();

    assert.equal(config.tool_calling_bias, 1);
    assert.equal(config.memory_importance_threshold, 0);
    assert.equal(config.caution_bias, 0.5);
    assert.equal(config.response_style, 'balanced');
    assert.equal(config.last_updated, '2026-02-02T00:00:00.000Z');

    const next = adjustBehaviorConfig(config, {
      tool_calling_bias: -0.25,
      response_style: 'concise'
    });

    assert.equal(next.tool_calling_bias, 0);
    assert.equal(next.response_style, 'concise');
  });
});

test('loadBehaviorConfig honors DOTCLAW_BEHAVIOR_CONFIG_PATH override', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-behavior-path-'));
  await withTempCwd(tempDir, async () => {
    const configPath = path.join(tempDir, 'custom-behavior.json');
    fs.writeFileSync(configPath, JSON.stringify({
      tool_calling_bias: 0.2,
      memory_importance_threshold: 0.65,
      response_style: 'detailed',
      caution_bias: 0.6,
      last_updated: '2026-02-02T12:00:00.000Z'
    }));

    const prev = process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH;
    process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH = configPath;

    try {
      const { loadBehaviorConfig } = await importFresh(distPath('behavior-config.js'));
      const config = loadBehaviorConfig();
      assert.equal(config.response_style, 'detailed');
      assert.equal(config.tool_calling_bias, 0.2);
      assert.equal(config.caution_bias, 0.6);
      assert.equal(config.memory_importance_threshold, 0.65);
    } finally {
      if (prev === undefined) {
        delete process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH;
      } else {
        process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH = prev;
      }
    }
  });
});
