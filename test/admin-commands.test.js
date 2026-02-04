import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distPath, importFresh } from './test-helpers.js';

test('parseAdminCommand handles slash commands', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const help = parseAdminCommand('/dotclaw', 'dotclaw_bot');
  assert.deepEqual(help, { command: 'help', args: [] });

  const add = parseAdminCommand('/dotclaw add-group "123" "My Group" my-group', 'dotclaw_bot');
  assert.equal(add.command, 'add-group');
  assert.deepEqual(add.args, ['123', 'My Group', 'my-group']);

  const model = parseAdminCommand('/dotclaw set model moonshotai/kimi-k2.5', 'dotclaw_bot');
  assert.equal(model.command, 'set-model');
  assert.deepEqual(model.args, ['moonshotai/kimi-k2.5']);
});

test('parseAdminCommand handles mentions and ignores unknowns', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const groups = parseAdminCommand('@dotclaw_bot list groups', 'dotclaw_bot');
  assert.equal(groups.command, 'groups');

  const ignored = parseAdminCommand('@dotclaw_bot do the thing', 'dotclaw_bot');
  assert.equal(ignored, null);
});
