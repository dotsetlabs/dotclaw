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
