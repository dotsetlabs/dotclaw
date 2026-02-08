import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('db access auto-initializes without explicit initDatabase call', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-db-autoinit-'));
  await withTempHome(tempDir, async () => {
    const db = await importFresh(distPath('db.js'));
    db.closeDatabase();

    const tasks = db.getAllTasks();
    assert.deepEqual(tasks, []);

    db.upsertChat({
      chatId: 'telegram:autoinit-test',
      name: 'AutoInit',
      lastMessageTime: new Date().toISOString()
    });

    const messages = db.getMessagesSinceCursor('telegram:autoinit-test', null, null);
    assert.deepEqual(messages, []);
  });
});
