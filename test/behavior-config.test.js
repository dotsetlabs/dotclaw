import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

// Use a shared temp dir so BEHAVIOR_CONFIG_PATH (a module-level constant from
// paths.js) stays valid for all tests. ESM caches paths.js after first load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-behavior-'));
const configDir = path.join(tmpDir, 'config');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadBehaviorConfig returns defaults when no config file', async () => {
  // First test: no config file exists yet, should get defaults.
  // This must run first to pin paths.js with our tmpDir.
  await withTempHome(tmpDir, async () => {
    const { loadBehaviorConfig } = await importFresh(distPath('behavior-config.js'));
    const config = loadBehaviorConfig();

    assert.equal(config.tool_calling_bias, 0.5);
    assert.equal(config.memory_importance_threshold, 0.55);
    assert.equal(config.response_style, 'balanced');
    assert.equal(config.caution_bias, 0.5);
  });
});

test('loadBehaviorConfig clamps values and validates style', async () => {
  await withTempHome(tmpDir, async () => {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'behavior.json'), JSON.stringify({
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

test('loadBehaviorConfig returns valid config structure', async () => {
  await withTempHome(tmpDir, async () => {
    const { loadBehaviorConfig } = await importFresh(distPath('behavior-config.js'));
    const config = loadBehaviorConfig();

    assert.ok(typeof config.tool_calling_bias === 'number', 'tool_calling_bias should be number');
    assert.ok(typeof config.memory_importance_threshold === 'number', 'memory_importance_threshold should be number');
    assert.ok(typeof config.caution_bias === 'number', 'caution_bias should be number');
    assert.ok(['concise', 'balanced', 'detailed'].includes(config.response_style), 'response_style should be valid');

    assert.ok(config.tool_calling_bias >= 0 && config.tool_calling_bias <= 1, 'tool_calling_bias in range');
    assert.ok(config.memory_importance_threshold >= 0 && config.memory_importance_threshold <= 1, 'memory_importance_threshold in range');
    assert.ok(config.caution_bias >= 0 && config.caution_bias <= 1, 'caution_bias in range');
  });
});

test('saveBehaviorConfig round-trips correctly', async () => {
  await withTempHome(tmpDir, async () => {
    const { loadBehaviorConfig, saveBehaviorConfig } = await importFresh(distPath('behavior-config.js'));

    const config = {
      tool_calling_bias: 0.7,
      memory_importance_threshold: 0.45,
      response_style: 'detailed',
      caution_bias: 0.3,
      last_updated: '2026-02-05T12:00:00.000Z',
      notes: 'User prefers detailed responses'
    };

    saveBehaviorConfig(config);
    const loaded = loadBehaviorConfig();

    assert.equal(loaded.tool_calling_bias, 0.7);
    assert.equal(loaded.memory_importance_threshold, 0.45);
    assert.equal(loaded.response_style, 'detailed');
    assert.equal(loaded.caution_bias, 0.3);
    assert.equal(loaded.notes, 'User prefers detailed responses');
  });
});

test('adjustBehaviorConfig clamps at boundaries', async () => {
  const { adjustBehaviorConfig } = await importFresh(distPath('behavior-config.js'));

  const base = {
    tool_calling_bias: 0.5,
    memory_importance_threshold: 0.5,
    response_style: 'balanced',
    caution_bias: 0.5,
    last_updated: '2026-01-01T00:00:00.000Z'
  };

  const high = adjustBehaviorConfig(base, {
    tool_calling_bias: 1.5,
    memory_importance_threshold: 2.0,
    caution_bias: 999
  });
  assert.equal(high.tool_calling_bias, 1);
  assert.equal(high.memory_importance_threshold, 1);
  assert.equal(high.caution_bias, 1);

  const low = adjustBehaviorConfig(base, {
    tool_calling_bias: -0.5,
    memory_importance_threshold: -100,
    caution_bias: -1
  });
  assert.equal(low.tool_calling_bias, 0);
  assert.equal(low.memory_importance_threshold, 0);
  assert.equal(low.caution_bias, 0);
});

test('adjustBehaviorConfig updates last_updated', async () => {
  const { adjustBehaviorConfig } = await importFresh(distPath('behavior-config.js'));

  const oldDate = '2025-01-01T00:00:00.000Z';
  const base = {
    tool_calling_bias: 0.5,
    memory_importance_threshold: 0.5,
    response_style: 'balanced',
    caution_bias: 0.5,
    last_updated: oldDate
  };

  const result = adjustBehaviorConfig(base, { tool_calling_bias: 0.6 });
  assert.notEqual(result.last_updated, oldDate, 'last_updated should be refreshed');
  assert.ok(!Number.isNaN(Date.parse(result.last_updated)), 'last_updated should be valid ISO date');
});

test('adjustBehaviorConfig preserves notes field', async () => {
  const { adjustBehaviorConfig } = await importFresh(distPath('behavior-config.js'));

  const base = {
    tool_calling_bias: 0.5,
    memory_importance_threshold: 0.5,
    response_style: 'balanced',
    caution_bias: 0.5,
    last_updated: '2026-01-01T00:00:00.000Z',
    notes: 'important note'
  };

  const result = adjustBehaviorConfig(base, { response_style: 'concise' });
  assert.equal(result.notes, 'important note');
  assert.equal(result.response_style, 'concise');
});

test('adjustBehaviorConfig ignores invalid response_style', async () => {
  const { adjustBehaviorConfig } = await importFresh(distPath('behavior-config.js'));

  const base = {
    tool_calling_bias: 0.5,
    memory_importance_threshold: 0.5,
    response_style: 'detailed',
    caution_bias: 0.5,
    last_updated: '2026-01-01T00:00:00.000Z'
  };

  const result = adjustBehaviorConfig(base, { response_style: 'invalid' });
  assert.equal(result.response_style, 'detailed', 'Should keep original style when update is invalid');
});

test('adjustBehaviorConfig handles NaN and Infinity', async () => {
  const { adjustBehaviorConfig } = await importFresh(distPath('behavior-config.js'));

  const base = {
    tool_calling_bias: 0.3,
    memory_importance_threshold: 0.6,
    response_style: 'balanced',
    caution_bias: 0.5,
    last_updated: '2026-01-01T00:00:00.000Z'
  };

  const nan = adjustBehaviorConfig(base, { tool_calling_bias: NaN });
  assert.equal(nan.tool_calling_bias, 0.5, 'NaN should fall back to 0.5');

  const inf = adjustBehaviorConfig(base, { caution_bias: Infinity });
  assert.equal(inf.caution_bias, 0.5, 'Infinity should fall back to 0.5');

  const negInf = adjustBehaviorConfig(base, { memory_importance_threshold: -Infinity });
  assert.equal(negInf.memory_importance_threshold, 0.5, '-Infinity should fall back to 0.5');
});

test('loadBehaviorConfig handles each valid response_style', async () => {
  await withTempHome(tmpDir, async () => {
    fs.mkdirSync(configDir, { recursive: true });

    for (const style of ['concise', 'balanced', 'detailed']) {
      fs.writeFileSync(path.join(configDir, 'behavior.json'), JSON.stringify({
        response_style: style
      }));
      const { loadBehaviorConfig } = await importFresh(distPath('behavior-config.js'));
      const config = loadBehaviorConfig();
      assert.equal(config.response_style, style, `Should accept '${style}' as valid style`);
    }
  });
});
