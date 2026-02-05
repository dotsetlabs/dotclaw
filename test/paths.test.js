import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('getDotclawHome defaults to ~/.dotclaw', async () => {
  const originalHome = process.env.DOTCLAW_HOME;
  delete process.env.DOTCLAW_HOME;
  try {
    const mod = await importFresh(distPath('paths.js'));
    const home = mod.getDotclawHome();
    assert.equal(home, path.join(os.homedir(), '.dotclaw'));
  } finally {
    if (originalHome !== undefined) {
      process.env.DOTCLAW_HOME = originalHome;
    }
  }
});

test('getDotclawHome respects DOTCLAW_HOME env var', async () => {
  await withTempHome('/tmp/custom-dotclaw', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const home = mod.getDotclawHome();
    assert.equal(home, path.resolve('/tmp/custom-dotclaw'));
  });
});

test('getGroupDir builds correct path', async () => {
  await withTempHome('/tmp/test-dc', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const dir = mod.getGroupDir('my-group');
    assert.equal(dir, path.join('/tmp/test-dc', 'groups', 'my-group'));
  });
});

test('getGroupIpcDir builds correct path', async () => {
  await withTempHome('/tmp/test-dc', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const dir = mod.getGroupIpcDir('my-group');
    assert.equal(dir, path.join('/tmp/test-dc', 'data', 'ipc', 'my-group'));
  });
});

test('getGroupSessionDir builds correct path', async () => {
  await withTempHome('/tmp/test-dc', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const dir = mod.getGroupSessionDir('my-group');
    assert.equal(dir, path.join('/tmp/test-dc', 'data', 'sessions', 'my-group'));
  });
});

test('path constants are consistent', async () => {
  await withTempHome('/tmp/test-dc', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const home = mod.getDotclawHome();

    assert.equal(mod.CONFIG_DIR, path.join(home, 'config'));
    assert.equal(mod.DATA_DIR, path.join(home, 'data'));
    assert.equal(mod.STORE_DIR, path.join(home, 'data', 'store'));
    assert.equal(mod.GROUPS_DIR, path.join(home, 'groups'));
    assert.equal(mod.LOGS_DIR, path.join(home, 'logs'));
    assert.equal(mod.TRACES_DIR, path.join(home, 'traces'));
    assert.equal(mod.PROMPTS_DIR, path.join(home, 'prompts'));
    assert.equal(mod.ENV_PATH, path.join(home, '.env'));
  });
});

test('config file paths are correct', async () => {
  await withTempHome('/tmp/test-dc', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const configDir = path.join('/tmp/test-dc', 'config');

    assert.equal(mod.RUNTIME_CONFIG_PATH, path.join(configDir, 'runtime.json'));
    assert.equal(mod.MODEL_CONFIG_PATH, path.join(configDir, 'model.json'));
    assert.equal(mod.BEHAVIOR_CONFIG_PATH, path.join(configDir, 'behavior.json'));
    assert.equal(mod.TOOL_POLICY_PATH, path.join(configDir, 'tool-policy.json'));
    assert.equal(mod.TOOL_BUDGETS_PATH, path.join(configDir, 'tool-budgets.json'));
  });
});

test('data file paths are correct', async () => {
  await withTempHome('/tmp/test-dc', async () => {
    const mod = await importFresh(distPath('paths.js'));
    const dataDir = path.join('/tmp/test-dc', 'data');
    const storeDir = path.join(dataDir, 'store');

    assert.equal(mod.REGISTERED_GROUPS_PATH, path.join(dataDir, 'registered_groups.json'));
    assert.equal(mod.MESSAGES_DB_PATH, path.join(storeDir, 'messages.db'));
    assert.equal(mod.MEMORY_DB_PATH, path.join(storeDir, 'memory.db'));
    assert.equal(mod.IPC_DIR, path.join(dataDir, 'ipc'));
    assert.equal(mod.SESSIONS_DIR, path.join(dataDir, 'sessions'));
  });
});

test('MOUNT_ALLOWLIST_PATH is in ~/.config/dotclaw', async () => {
  const mod = await importFresh(distPath('paths.js'));
  assert.equal(
    mod.MOUNT_ALLOWLIST_PATH,
    path.join(os.homedir(), '.config', 'dotclaw', 'mount-allowlist.json')
  );
});
