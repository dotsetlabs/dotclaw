import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAgentConfig } from '../dist/agent-config.js';
import { createTools } from '../dist/tools.js';

function buildTools(policy) {
  const config = loadAgentConfig().agent;
  return createTools(
    { chatJid: '123456', groupFolder: 'main', isMain: true },
    config,
    policy ? { policy } : undefined
  );
}

function getTool(name) {
  const tool = buildTools().find(entry => entry.function?.name === name);
  assert.ok(tool, `Tool not found: ${name}`);
  return tool.function;
}

test('createTools filters schema list by allow/deny policy', () => {
  const tools = buildTools({
    allow: ['Read', 'Bash', 'WebSearch'],
    deny: ['Bash']
  });
  const names = tools.map(entry => entry.function?.name);

  assert.ok(names.includes('Read'));
  assert.ok(names.includes('WebSearch'));
  assert.equal(names.includes('Bash'), false);
  assert.equal(names.includes('Write'), false);
});

test('send_buttons schema rejects invalid button definitions', () => {
  const sendButtons = getTool('mcp__dotclaw__send_buttons');
  const schema = sendButtons.inputSchema;

  assert.equal(schema.safeParse({
    text: 'Choose one',
    buttons: [[{ text: 'Open', url: 'https://example.com' }]]
  }).success, true);

  assert.equal(schema.safeParse({
    text: 'Invalid',
    buttons: [[{ text: 'Bad', url: 'https://example.com', callback_data: 'x' }]]
  }).success, false);

  assert.equal(schema.safeParse({
    text: 'Invalid',
    buttons: [[{ text: 'Bad' }]]
  }).success, false);

  assert.equal(schema.safeParse({
    text: 'Invalid',
    buttons: [[{ text: 'Bad', url: 'file:///etc/passwd' }]]
  }).success, false);
});

test('send_poll schema rejects invalid poll combinations', () => {
  const sendPoll = getTool('mcp__dotclaw__send_poll');
  const schema = sendPoll.inputSchema;

  assert.equal(schema.safeParse({
    question: 'Best color?',
    options: ['Red', 'Blue']
  }).success, true);

  assert.equal(schema.safeParse({
    question: 'Quiz mode',
    options: ['A', 'B'],
    type: 'quiz',
    allows_multiple_answers: true
  }).success, false);

  assert.equal(schema.safeParse({
    question: 'Quiz mode',
    options: ['A', 'B'],
    type: 'quiz'
  }).success, false);

  assert.equal(schema.safeParse({
    question: 'Quiz mode',
    options: ['A', 'B'],
    type: 'quiz',
    correct_option_id: 1
  }).success, true);

  assert.equal(schema.safeParse({
    question: 'Duplicates',
    options: ['A', 'a']
  }).success, false);
});

test('telegram send tool schemas reject empty required text fields', () => {
  const sendMessage = getTool('mcp__dotclaw__send_message');
  assert.equal(sendMessage.inputSchema.safeParse({ text: '   ' }).success, false);

  const sendContact = getTool('mcp__dotclaw__send_contact');
  assert.equal(sendContact.inputSchema.safeParse({
    phone_number: ' ',
    first_name: 'Name'
  }).success, false);
  assert.equal(sendContact.inputSchema.safeParse({
    phone_number: '+15551234567',
    first_name: ' '
  }).success, false);
});

test('send_file execution rejects paths outside /workspace/group', async () => {
  const sendFile = getTool('mcp__dotclaw__send_file');
  await assert.rejects(
    () => sendFile.execute({ path: '/workspace/global/secrets.txt' }),
    /Path must be inside \/workspace\/group/
  );
});

test('tool execution normalizes stringified and aliased arguments', async () => {
  const write = getTool('Write');
  const read = getTool('Read');

  await assert.rejects(
    () => write.execute('{"filePath":"/tmp/normalized-args.txt","text":"hello from normalized args"}'),
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /outside allowed roots/);
      assert.equal(/Path is required/.test(message), false);
      return true;
    }
  );

  await assert.rejects(
    () => read.execute({ filePath: '/workspace/group/missing.txt', maxBytes: -128 }),
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      assert.match(message, /does not exist|outside allowed roots/);
      assert.equal(/Path is required/.test(message), false);
      return true;
    }
  );
});
