import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distPath, importFresh } from './test-helpers.js';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('parseProgressMessages handles JSON and pipe formats', async () => {
  const { parseProgressMessages, DEFAULT_PROGRESS_MESSAGES } = await importFresh(distPath('progress.js'));

  const jsonMessages = parseProgressMessages('["one", "two"]', DEFAULT_PROGRESS_MESSAGES);
  assert.deepEqual(jsonMessages, ['one', 'two']);

  const pipeMessages = parseProgressMessages('first | second | third', DEFAULT_PROGRESS_MESSAGES);
  assert.deepEqual(pipeMessages, ['first', 'second', 'third']);

  const fallback = parseProgressMessages('', DEFAULT_PROGRESS_MESSAGES);
  assert.deepEqual(fallback, DEFAULT_PROGRESS_MESSAGES);
});

test('createProgressNotifier sends limited progress updates', async () => {
  const { createProgressNotifier } = await importFresh(distPath('progress.js'));

  const sent = [];
  const notifier = createProgressNotifier({
    enabled: true,
    initialDelayMs: 5,
    intervalMs: 10,
    maxUpdates: 2,
    messages: ['first', 'second', 'third'],
    send: async (text) => {
      sent.push(text);
    }
  });

  notifier.start();
  await wait(40);
  notifier.stop();

  assert.deepEqual(sent, ['first', 'second']);
});
