import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('hybrid memory recall returns FTS matches when embeddings disabled', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-recall-'));
  await withTempHome(tempDir, async () => {
    const configDir = path.join(tempDir, 'config');
    const storeDir = path.join(tempDir, 'data', 'store');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
      host: {
        memory: {
          embeddings: {
            enabled: false
          }
        }
      }
    }));

    const { initMemoryStore, upsertMemoryItems } = await importFresh(distPath('memory-store.js'));
    const { buildHybridMemoryRecall } = await importFresh(distPath('memory-recall.js'));
    const groupFolder = 'recall-fts';

    initMemoryStore();
    upsertMemoryItems(groupFolder, [
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
      groupFolder,
      userId: 'user-1',
      query: 'espresso',
      maxResults: 5,
      maxTokens: 500
    });

    assert.ok(recall.length >= 1);
    assert.ok(recall[0].toLowerCase().includes('espresso'));
  });
});

test('hybrid memory recall diversifies results and caps repeated topics', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-recall-'));
  await withTempHome(tempDir, async () => {
    const configDir = path.join(tempDir, 'config');
    const storeDir = path.join(tempDir, 'data', 'store');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
      host: {
        memory: {
          embeddings: {
            enabled: false
          }
        }
      }
    }));

    const { initMemoryStore, upsertMemoryItems } = await importFresh(distPath('memory-store.js'));
    const { buildHybridMemoryRecall } = await importFresh(distPath('memory-recall.js'));
    const groupFolder = 'recall-diverse';

    initMemoryStore();
    upsertMemoryItems(groupFolder, [
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'preference',
        content: 'My coffee roast preference is light roast for mornings',
        importance: 0.9
      },
      {
        scope: 'group',
        type: 'task',
        content: 'Project Atlas deployment is every Friday afternoon',
        importance: 0.8
      },
      {
        scope: 'group',
        type: 'note',
        content: 'Coffee roast profile alpha works for pour-over',
        importance: 0.7
      },
      {
        scope: 'group',
        type: 'note',
        content: 'Coffee roast profile beta works for espresso',
        importance: 0.7
      },
      {
        scope: 'group',
        type: 'note',
        content: 'Coffee roast profile gamma works for cold brew',
        importance: 0.7
      }
    ], 'test');

    const recall = await buildHybridMemoryRecall({
      groupFolder,
      userId: 'user-1',
      query: 'remember my coffee roast preference and previous project deployment notes',
      maxResults: 6,
      maxTokens: 1500
    });

    assert.ok(recall.some(line => line.includes('(preference)')));
    assert.ok(recall.some(line => line.includes('(task)')));
    const repeatedTopicLines = recall.filter(line => line.toLowerCase().includes('coffee roast profile'));
    assert.ok(repeatedTopicLines.length <= 2);
  });
});

test('hybrid memory recall avoids low-signal filler for explicit memory intent', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-recall-'));
  await withTempHome(tempDir, async () => {
    const configDir = path.join(tempDir, 'config');
    const storeDir = path.join(tempDir, 'data', 'store');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
      host: {
        memory: {
          embeddings: {
            enabled: false
          }
        }
      }
    }));

    const { initMemoryStore, upsertMemoryItems } = await importFresh(distPath('memory-store.js'));
    const { buildHybridMemoryRecall } = await importFresh(distPath('memory-recall.js'));
    const groupFolder = 'recall-intent';

    initMemoryStore();
    upsertMemoryItems(groupFolder, [
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'preference',
        content: 'User prefers light roast coffee in the morning',
        importance: 0.9
      },
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'relationship',
        content: 'Alice is the product manager for Project Atlas',
        importance: 0.85
      },
      {
        scope: 'group',
        type: 'task',
        content: 'Project Atlas deployment happens every Friday at 3pm',
        importance: 0.8
      },
      {
        scope: 'group',
        type: 'note',
        content: 'Lunch preference note: pepperoni pizza',
        importance: 0.4
      }
    ], 'test');

    const recall = await buildHybridMemoryRecall({
      groupFolder,
      userId: 'user-1',
      query: 'remember my coffee preference and who manages atlas',
      maxResults: 4,
      maxTokens: 1200
    });

    assert.ok(recall.some(line => line.includes('(preference)')));
    assert.ok(recall.some(line => line.includes('(relationship)')));
    assert.ok(recall.some(line => line.includes('(task)')));
    assert.ok(!recall.some(line => line.toLowerCase().includes('pepperoni pizza')));
  });
});
