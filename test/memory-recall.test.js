import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

test('hybrid memory recall returns FTS matches when embeddings disabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-recall-'));
  await withTempCwd(tempDir, async () => {
    const prevEmbeddings = process.env.DOTCLAW_MEMORY_EMBEDDINGS_ENABLED;
    process.env.DOTCLAW_MEMORY_EMBEDDINGS_ENABLED = '0';

    try {
      const { initMemoryStore, upsertMemoryItems } = await importFresh(distPath('memory-store.js'));
      const { buildHybridMemoryRecall } = await importFresh(distPath('memory-recall.js'));

      initMemoryStore();
      upsertMemoryItems('main', [
        {
          scope: 'user',
          subject_id: 'user-1',
          type: 'preference',
          content: 'Prefers Ethiopian espresso roasts',
          importance: 0.8
        },
        {
          scope: 'group',
          type: 'project',
          content: 'Project Nova kickoff is next Tuesday',
          importance: 0.6
        }
      ], 'test');

      const recall = await buildHybridMemoryRecall({
        groupFolder: 'main',
        userId: 'user-1',
        query: 'espresso',
        maxResults: 5,
        maxTokens: 500
      });

      assert.ok(recall.length >= 1);
      assert.ok(recall[0].toLowerCase().includes('espresso'));
    } finally {
      if (prevEmbeddings === undefined) {
        delete process.env.DOTCLAW_MEMORY_EMBEDDINGS_ENABLED;
      } else {
        process.env.DOTCLAW_MEMORY_EMBEDDINGS_ENABLED = prevEmbeddings;
      }
    }
  });
});
