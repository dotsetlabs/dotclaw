import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distPath, importFresh } from './test-helpers.js';

test('normalizeMcpConfig sanitizes malformed server entries', async () => {
  const { normalizeMcpConfig } = await importFresh(distPath('mcp-config.js'));
  const normalized = normalizeMcpConfig({
    enabled: true,
    servers: [
      { name: ' server-a ', command: ' node ', args: ['a.js', 1], env: { OK: '1', BAD: 2 } },
      { name: '', command: 'node' },
      null
    ]
  });

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.servers.length, 1);
  assert.equal(normalized.servers[0].name, 'server-a');
  assert.equal(normalized.servers[0].command, 'node');
  assert.deepEqual(normalized.servers[0].args, ['a.js']);
  assert.deepEqual(normalized.servers[0].env, { OK: '1' });
});

test('applyMcpConfigAction handles add/remove/enable/disable and validation', async () => {
  const { applyMcpConfigAction } = await importFresh(distPath('mcp-config.js'));
  const base = { enabled: false, servers: [] };

  const added = applyMcpConfigAction(base, {
    action: 'add_server',
    name: 'search',
    command: 'node',
    args_list: ['server.js'],
    env: { API_KEY: 'secret' }
  });
  assert.equal(added.ok, true);
  if (added.ok) {
    assert.equal(added.changed, true);
    assert.equal(added.mcp.servers.length, 1);
  }

  const duplicate = applyMcpConfigAction(added.ok ? added.mcp : base, {
    action: 'add_server',
    name: 'search',
    command: 'node'
  });
  assert.equal(duplicate.ok, false);

  const enabled = applyMcpConfigAction(added.ok ? added.mcp : base, { action: 'enable' });
  assert.equal(enabled.ok, true);
  if (enabled.ok) {
    assert.equal(enabled.mcp.enabled, true);
  }

  const removed = applyMcpConfigAction(enabled.ok ? enabled.mcp : base, {
    action: 'remove_server',
    name: 'search'
  });
  assert.equal(removed.ok, true);
  if (removed.ok) {
    assert.equal(removed.mcp.servers.length, 0);
  }

  const invalid = applyMcpConfigAction(base, { action: 'unknown_action' });
  assert.equal(invalid.ok, false);
});
