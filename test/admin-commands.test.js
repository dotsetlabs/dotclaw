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

test('parseAdminCommand handles /dc shorthand', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const help = parseAdminCommand('/dc help', 'dotclaw_bot');
  assert.deepEqual(help, { command: 'help', args: [] });

  const style = parseAdminCommand('/dc style concise', 'dotclaw_bot');
  assert.equal(style.command, 'style');
  assert.deepEqual(style.args, ['concise']);
});

test('parseAdminCommand handles remove-group', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const remove = parseAdminCommand('/dotclaw remove-group my-chat', 'dotclaw_bot');
  assert.equal(remove.command, 'remove-group');
  assert.deepEqual(remove.args, ['my-chat']);

  const deleteSyn = parseAdminCommand('/dotclaw delete group my-chat', 'dotclaw_bot');
  assert.equal(deleteSyn.command, 'remove-group');
});

test('parseAdminCommand handles style command', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const style = parseAdminCommand('/dotclaw style detailed', 'dotclaw_bot');
  assert.equal(style.command, 'style');
  assert.deepEqual(style.args, ['detailed']);
});

test('parseAdminCommand handles tools command', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const tools = parseAdminCommand('/dotclaw tools proactive', 'dotclaw_bot');
  assert.equal(tools.command, 'tools');
  assert.deepEqual(tools.args, ['proactive']);
});

test('parseAdminCommand handles caution command', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const caution = parseAdminCommand('/dotclaw caution high', 'dotclaw_bot');
  assert.equal(caution.command, 'caution');
  assert.deepEqual(caution.args, ['high']);
});

test('parseAdminCommand handles memory command', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const mem = parseAdminCommand('/dotclaw memory strict', 'dotclaw_bot');
  assert.equal(mem.command, 'memory');
  assert.deepEqual(mem.args, ['strict']);
});

test('parseAdminCommand handles remember command', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const rem = parseAdminCommand('/dotclaw remember User prefers dark mode', 'dotclaw_bot');
  assert.equal(rem.command, 'remember');
  assert.deepEqual(rem.args, ['User', 'prefers', 'dark', 'mode']);
});

test('parseAdminCommand handles groups command', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const groups = parseAdminCommand('/dotclaw groups', 'dotclaw_bot');
  assert.equal(groups.command, 'groups');
});

test('parseAdminCommand returns null for non-command text', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  assert.equal(parseAdminCommand('hello there', 'dotclaw_bot'), null);
  assert.equal(parseAdminCommand('', 'dotclaw_bot'), null);
  assert.equal(parseAdminCommand('/unknown command', 'dotclaw_bot'), null);
});

test('parseAdminCommand handles model shorthand', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const model = parseAdminCommand('/dotclaw model openai/gpt-5-mini', 'dotclaw_bot');
  assert.equal(model.command, 'set-model');
  assert.deepEqual(model.args, ['openai/gpt-5-mini']);
});

test('parseAdminCommand handles add group with natural language', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const add = parseAdminCommand('/dotclaw add group 12345 work work-chat', 'dotclaw_bot');
  assert.equal(add.command, 'add-group');
  assert.deepEqual(add.args, ['12345', 'work', 'work-chat']);
});

test('parseAdminCommand handles bot mention with @suffix', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const cmd = parseAdminCommand('/dotclaw@dotclaw_bot help', 'dotclaw_bot');
  assert.equal(cmd.command, 'help');
});

test('parseAdminCommand handles set-model with scope', async () => {
  const { parseAdminCommand } = await importFresh(distPath('admin-commands.js'));

  const cmd = parseAdminCommand('/dotclaw set-model openai/gpt-5-mini group main', 'dotclaw_bot');
  assert.equal(cmd.command, 'set-model');
  assert.deepEqual(cmd.args, ['openai/gpt-5-mini', 'group', 'main']);
});
