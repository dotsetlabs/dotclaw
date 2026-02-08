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
      concurrency: { maxAgents: 0, laneStarvationMs: -1, maxConsecutiveInteractive: 0 },
      maintenance: { intervalMs: -1 },
      messageQueue: { promptMaxChars: -50 },
      routing: { hostFailover: { maxRetries: -1 } },
      memory: { backend: { strategy: 'invalid' } }
    },
    agent: {
      tools: {
        completionGuard: {
          idempotentRetryAttempts: 0,
          idempotentRetryBackoffMs: -5,
          repeatedSignatureThreshold: 1,
          repeatedRoundThreshold: 1,
          nonRetryableFailureThreshold: 0
        }
      }
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
    assert.ok(config.host.concurrency.laneStarvationMs >= 1000, 'laneStarvationMs should be clamped to >= 1000');
    assert.ok(config.host.concurrency.maxConsecutiveInteractive >= 1, 'maxConsecutiveInteractive should be clamped to >= 1');
    assert.ok(config.host.maintenance.intervalMs >= 60000, 'maintenance intervalMs should be clamped to >= 60000');
    assert.ok(config.host.messageQueue.promptMaxChars >= 2000, 'promptMaxChars should be clamped to >= 2000');
    assert.ok(config.host.routing.hostFailover.maxRetries >= 0, 'host failover maxRetries should be clamped to >= 0');
    assert.equal(config.host.memory.backend.strategy, 'builtin', 'invalid memory backend strategy should default to builtin');
    assert.ok(config.agent.tools.completionGuard.idempotentRetryAttempts >= 1, 'idempotentRetryAttempts should be clamped to >= 1');
    assert.ok(config.agent.tools.completionGuard.idempotentRetryBackoffMs >= 0, 'idempotentRetryBackoffMs should be clamped to >= 0');
    assert.ok(config.agent.tools.completionGuard.repeatedSignatureThreshold >= 2, 'repeatedSignatureThreshold should be clamped to >= 2');
    assert.ok(config.agent.tools.completionGuard.repeatedRoundThreshold >= 2, 'repeatedRoundThreshold should be clamped to >= 2');
    assert.ok(config.agent.tools.completionGuard.nonRetryableFailureThreshold >= 1, 'nonRetryableFailureThreshold should be clamped to >= 1');
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
    assert.equal(config.host.messageQueue.promptMaxChars, 24000, 'promptMaxChars should default to 24000');
    assert.equal(config.host.routing.hostFailover.enabled, true, 'host failover should default to enabled');
    assert.equal(config.host.routing.hostFailover.maxRetries, 1, 'host failover maxRetries should default to 1');
    assert.equal(config.host.memory.backend.strategy, 'builtin', 'memory backend should default to builtin');
    assert.equal(config.agent.tools.completionGuard.idempotentRetryAttempts, 2, 'idempotentRetryAttempts should default to 2');
    assert.equal(config.agent.tools.completionGuard.repeatedSignatureThreshold, 3, 'repeatedSignatureThreshold should default to 3');
    assert.equal(config.agent.tools.completionGuard.nonRetryableFailureThreshold, 3, 'nonRetryableFailureThreshold should default to 3');
    assert.equal(config.agent.tools.completionGuard.forceSynthesisAfterTools, true, 'forceSynthesisAfterTools should default to true');
    assert.equal(config.agent.tools.bash.timeoutMs, 600000, 'bash timeout should default to 10 minutes');
    assert.equal(config.agent.mcp.enabled, false, 'MCP should default to disabled');
    assert.equal(config.agent.tts.provider, 'edge-tts', 'TTS provider should default to edge-tts');
    assert.equal(config.agent.process.maxSessions, 16, 'process maxSessions should default to 16');
  });
});

test('runtime config document helpers strip deprecated keys on write', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-doc-'));
  const configPath = path.join(tempDir, 'config', 'runtime.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  await withTempHome(tempDir, async () => {
    const {
      writeRuntimeConfigDocument,
      readRuntimeConfigDocument,
      updateRuntimeConfigDocument,
    } = await importFresh(distPath('runtime-config.js'));

    writeRuntimeConfigDocument({
      host: {
        backgroundJobs: { enabled: true },
        routing: { profiles: { default: {} }, model: 'moonshotai/kimi-k2.5' }
      },
      agent: { mcp: { enabled: true, servers: [] } }
    }, configPath);

    const persisted = readRuntimeConfigDocument(configPath);
    assert.equal(Object.prototype.hasOwnProperty.call(persisted.host, 'backgroundJobs'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(persisted.host.routing, 'profiles'), false);

    updateRuntimeConfigDocument((draft) => {
      draft.host = draft.host || {};
      draft.host.container = { instanceId: 'dev-instance' };
    }, configPath);

    const updated = readRuntimeConfigDocument(configPath);
    assert.equal(updated.host.container.instanceId, 'dev-instance');
  });
});

test('updateRuntimeConfigDocument skips writes when mutator returns false', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-runtime-noop-'));
  const configPath = path.join(tempDir, 'config', 'runtime.json');

  await withTempHome(tempDir, async () => {
    const { updateRuntimeConfigDocument } = await importFresh(distPath('runtime-config.js'));
    updateRuntimeConfigDocument(() => false, configPath);
    assert.equal(fs.existsSync(configPath), false);
  });
});
