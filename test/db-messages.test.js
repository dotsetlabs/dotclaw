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
