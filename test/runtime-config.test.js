import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('loadRuntimeConfig merges defaults with overrides', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const runtimePayload = {
    host: {
      container: {
        timeoutMs: 123456
      },
      metrics: {
        port: 3100
      }
    },
    agent: {
      assistantName: 'TestBot'
    }
  };
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify(runtimePayload, null, 2));

  await withTempHome(tempDir, async () => {
    const { loadRuntimeConfig, getRuntimeConfigPath } = await importFresh(distPath('runtime-config.js'));
    const config = loadRuntimeConfig();
    assert.equal(getRuntimeConfigPath().endsWith(path.join('config', 'runtime.json')), true);
    assert.equal(config.host.container.timeoutMs, 123456);
    assert.equal(config.host.metrics.port, 3100);
    assert.equal(config.agent.assistantName, 'TestBot');
    // defaults still applied
    assert.equal(typeof config.host.container.maxOutputBytes, 'number');
    assert.equal(config.host.container.maxOutputBytes > 0, true);
    assert.equal(config.host.container.privileged, true);
  });
});

test('loadRuntimeConfig allows overriding container privileged mode', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const runtimePayload = {
    host: {
      container: {
        privileged: false
      }
    }
  };
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify(runtimePayload, null, 2));

  await withTempHome(tempDir, async () => {
    const { loadRuntimeConfig } = await importFresh(distPath('runtime-config.js'));
    const config = loadRuntimeConfig();
    assert.equal(config.host.container.privileged, false);
  });
});

test('validation clamps invalid negative timeouts to safe defaults', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-val-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const runtimePayload = {
    host: {
      scheduler: { pollIntervalMs: -100 },
      container: { timeoutMs: 0 },
      concurrency: { maxAgents: 0 },
      maintenance: { intervalMs: -1 },
    },
    hooks: { maxConcurrent: 0 }
  };
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify(runtimePayload, null, 2));

  await withTempHome(tempDir, async () => {
    const { loadRuntimeConfig } = await importFresh(distPath('runtime-config.js'));
    const config = loadRuntimeConfig();
    assert.ok(config.host.scheduler.pollIntervalMs >= 1000, 'pollIntervalMs should be clamped to >= 1000');
    assert.ok(config.host.container.timeoutMs >= 1000, 'container timeoutMs should be clamped to >= 1000');
    assert.ok(config.host.concurrency.maxAgents >= 1, 'maxAgents should be clamped to >= 1');
    assert.ok(config.host.maintenance.intervalMs >= 60000, 'maintenance intervalMs should be clamped to >= 60000');
    assert.ok(config.hooks.maxConcurrent >= 1, 'hooks maxConcurrent should be clamped to >= 1');
  });
});

test('validation clamps invalid container mode to daemon', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-mode-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const runtimePayload = {
    host: {
      container: {
        mode: 'invalid'
      }
    }
  };
  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify(runtimePayload, null, 2));

  await withTempHome(tempDir, async () => {
    const { loadRuntimeConfig } = await importFresh(distPath('runtime-config.js'));
    const config = loadRuntimeConfig();
    // mergeDefaults only applies overrides when typeof matches, so 'invalid' is a string
    // like 'daemon', but validateRuntimeConfig should correct it to 'daemon'
    assert.equal(config.host.container.mode, 'daemon', 'Invalid container mode should be clamped to daemon');
  });
});

test('default routing maxOutputTokens is 0 (auto) and maxToolSteps is 200', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-defaults-'));
  await withTempHome(tempDir, async () => {
    const { loadRuntimeConfig } = await importFresh(distPath('runtime-config.js'));
    const config = loadRuntimeConfig();
    assert.equal(config.host.routing.maxOutputTokens, 0, 'maxOutputTokens should default to 0 (auto)');
    assert.equal(config.host.routing.maxToolSteps, 200, 'maxToolSteps should default to 200');
  });
});
