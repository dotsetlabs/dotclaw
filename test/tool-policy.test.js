import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distPath, importFresh } from './test-helpers.js';

test('getEffectiveToolPolicy returns policy with expected tools', async () => {
  // Test that the default policy includes expected tools
  const { getEffectiveToolPolicy } = await importFresh(distPath('tool-policy.js'));
  const policy = getEffectiveToolPolicy({ groupFolder: 'test-group', userId: null });

  // Should have core tools in allow list
  assert.ok(policy.allow?.includes('Read'), 'Should allow Read');
  assert.ok(policy.allow?.includes('Write'), 'Should allow Write');
  assert.ok(policy.allow?.includes('Bash'), 'Should allow Bash');
  assert.ok(policy.allow?.includes('Python'), 'Should allow Python');
  assert.ok(policy.allow?.includes('WebSearch'), 'Should allow WebSearch');

  // Should have reasonable limits
  assert.ok(typeof policy.default_max_per_run === 'number', 'Should have default_max_per_run');
  assert.ok(policy.max_per_run?.Bash !== undefined, 'Should have Bash limit');
  assert.ok(policy.max_per_run?.Python !== undefined, 'Should have Python limit');
});

test('applyToolAllowOverride filters allow-list case-insensitively', async () => {
  const { applyToolAllowOverride } = await importFresh(distPath('agent-context.js'));
  const next = applyToolAllowOverride(
    { allow: ['Read', 'WebSearch', 'Bash'], deny: [] },
    ['websearch', 'READ']
  );

  assert.deepEqual(next.allow, ['Read', 'WebSearch']);
});

test('applyToolAllowOverride fails closed when requested tools do not match policy', async () => {
  const { applyToolAllowOverride } = await importFresh(distPath('agent-context.js'));
  const next = applyToolAllowOverride(
    { allow: ['Read', 'WebSearch'], deny: [] },
    ['NoSuchTool']
  );

  assert.deepEqual(next.allow, []);
});

test('applyToolAllowOverride applies explicit allow-list when policy has no allow entries', async () => {
  const { applyToolAllowOverride } = await importFresh(distPath('agent-context.js'));
  const next = applyToolAllowOverride({ deny: [] }, ['Bash', 'Python']);

  assert.deepEqual(next.allow, ['Bash', 'Python']);
});
