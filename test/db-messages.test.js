import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('upsertChat creates chat row so storeMessage succeeds', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-db-'));
  await withTempHome(tempDir, async () => {
    const { initDatabase, upsertChat, storeMessage, getMessagesSinceCursor } = await importFresh(distPath('db.js'));
    initDatabase();

    const timestamp = new Date().toISOString();
    upsertChat({ chatId: 'chat-1', name: 'Test Chat', lastMessageTime: timestamp });

    assert.doesNotThrow(() => {
      storeMessage('1', 'chat-1', 'user-1', 'Greg', 'Hello', timestamp, false);
    });

    const messages = getMessagesSinceCursor('chat-1', null, null);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'Hello');
  });
});

test('message queue tracks attempts and supports re-queue retries', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-db-queue-'));
  await withTempHome(tempDir, async () => {
    const {
      initDatabase,
      enqueueMessageItem,
      claimBatchForChat,
      requeueQueuedMessages,
      failQueuedMessages
    } = await importFresh(distPath('db.js'));
    initDatabase();

    enqueueMessageItem({
      chat_jid: 'chat-queue-1',
      message_id: 'm1',
      sender_id: 'user-1',
      sender_name: 'Greg',
      content: 'hello',
      timestamp: new Date().toISOString(),
      is_group: false,
      chat_type: 'private'
    });

    const firstClaim = claimBatchForChat('chat-queue-1', 2000, 10);
    assert.equal(firstClaim.length, 1);
    assert.equal(firstClaim[0].attempt_count ?? 0, 0);

    requeueQueuedMessages([firstClaim[0].id], 'transient send error');

    const secondClaim = claimBatchForChat('chat-queue-1', 2000, 10);
    assert.equal(secondClaim.length, 1);
    assert.equal(secondClaim[0].attempt_count ?? 0, 1);

    failQueuedMessages([secondClaim[0].id], 'permanent failure');
    const thirdClaim = claimBatchForChat('chat-queue-1', 2000, 10);
    assert.equal(thirdClaim.length, 0);
  });
});
