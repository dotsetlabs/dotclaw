import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StreamingDelivery, watchStreamChunks } from '../dist/streaming.js';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeMockProvider() {
  const calls = [];
  return {
    calls,
    name: 'test',
    capabilities: { maxMessageLength: 4096 },
    async sendMessage(chatId, text, opts) {
      const msgId = `msg-${calls.length + 1}`;
      calls.push({ type: 'send', chatId, text, opts, msgId });
      return { success: true, messageId: msgId };
    },
    async editMessage(chatId, messageId, text) {
      calls.push({ type: 'edit', chatId, messageId, text });
      return { success: true, messageId };
    },
    async setTyping() {},
    isConnected() { return true; },
    async start() {},
    async stop() {},
    async sendPhoto() { return { success: true }; },
    async sendDocument() { return { success: true }; },
    async sendVoice() { return { success: true }; },
    async sendAudio() { return { success: true }; },
    async sendLocation() { return { success: true }; },
    async sendContact() { return { success: true }; },
    async sendPoll() { return { success: true }; },
    async sendButtons() { return { success: true }; },
    async deleteMessage() { return { success: true }; },
    async downloadFile() { return { path: null }; },
    formatMessage(text) { return [text]; },
    isBotMentioned() { return false; },
    isBotReplied() { return false; },
  };
}

test('StreamingDelivery sends first message then edits on subsequent chunks', async () => {
  const provider = makeMockProvider();
  const config = { enabled: true, chunkFlushIntervalMs: 50, editIntervalMs: 50, maxEditLength: 4000 };
  const delivery = new StreamingDelivery(provider, 'chat-1', config);

  await delivery.onChunk('Hello ');
  await wait(100); // Wait for flush timer
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].type, 'send');
  assert.equal(provider.calls[0].text, 'Hello');

  await delivery.onChunk('world!');
  await wait(100);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[1].type, 'edit');
  assert.equal(provider.calls[1].text, 'Hello world!');

  const msgId = await delivery.finalize('Hello world! Final.');
  assert.ok(msgId);
  // Finalize should have edited with final text
  const lastCall = provider.calls[provider.calls.length - 1];
  assert.equal(lastCall.type, 'edit');
  assert.equal(lastCall.text, 'Hello world! Final.');
});

test('StreamingDelivery finalize without prior chunks sends new message', async () => {
  const provider = makeMockProvider();
  const config = { enabled: true, chunkFlushIntervalMs: 50, editIntervalMs: 50, maxEditLength: 4000 };
  const delivery = new StreamingDelivery(provider, 'chat-1', config);

  const msgId = await delivery.finalize('Direct response.');
  assert.ok(msgId);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].type, 'send');
  assert.equal(provider.calls[0].text, 'Direct response.');
});

test('watchStreamChunks yields chunks in order and stops on done', async () => {
  const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-stream-'));

  // Write chunks in sequence with small delays
  const writeChunks = async () => {
    fs.writeFileSync(path.join(streamDir, 'chunk_000001.txt'), 'Hello ');
    await wait(20);
    fs.writeFileSync(path.join(streamDir, 'chunk_000002.txt'), 'world');
    await wait(20);
    fs.writeFileSync(path.join(streamDir, 'done'), '');
  };

  void writeChunks();

  const chunks = [];
  for await (const chunk of watchStreamChunks(streamDir)) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, ['Hello ', 'world']);

  // Cleanup
  fs.rmSync(streamDir, { recursive: true, force: true });
});

test('watchStreamChunks stops on abort signal', async () => {
  const streamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-stream-'));
  const ac = new AbortController();

  // Write one chunk, then abort
  fs.writeFileSync(path.join(streamDir, 'chunk_000001.txt'), 'first');
  setTimeout(() => ac.abort(), 100);

  const chunks = [];
  try {
    for await (const chunk of watchStreamChunks(streamDir, ac.signal)) {
      chunks.push(chunk);
    }
    assert.fail('Expected AbortError');
  } catch (err) {
    assert.equal(err.name, 'AbortError');
  }

  assert.deepEqual(chunks, ['first']);

  // Cleanup
  fs.rmSync(streamDir, { recursive: true, force: true });
});
