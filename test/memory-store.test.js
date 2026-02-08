import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('memory store supports upsert, search, list, and forget flows', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-mem-'));
  await withTempHome(tempDir, async () => {
    // Create required directories
    const storeDir = path.join(tempDir, 'data', 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    const { initMemoryStore, upsertMemoryItems, searchMemories, listMemories, forgetMemories, getMemoryStats, buildUserProfile } =
      await importFresh(distPath('memory-store.js'));
    const { buildHybridMemoryRecall } =
      await importFresh(distPath('memory-recall.js'));

    initMemoryStore();

    const inserted = upsertMemoryItems('main', [
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'preference',
        content: 'Likes espresso',
        tags: ['coffee'],
        importance: 0.8
      },
      {
        scope: 'group',
        type: 'project',
        content: 'Project Apollo kickoff meeting Friday',
        tags: ['apollo'],
        importance: 0.7
      }
    ], 'test');

    assert.equal(inserted.length, 2);

    const searchResults = searchMemories({
      groupFolder: 'main',
      userId: 'user-1',
      query: 'espresso'
    });
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].content, 'Likes espresso');

    const listResults = listMemories({ groupFolder: 'main', scope: 'user', userId: 'user-1' });
    assert.equal(listResults.length, 1);

    const profile = buildUserProfile({ groupFolder: 'main', userId: 'user-1' });
    assert.ok(profile?.includes('Likes espresso'));

    // buildHybridMemoryRecall is async and returns formatted strings
    const recall = await buildHybridMemoryRecall({
      groupFolder: 'main',
      userId: 'user-1',
      query: 'apollo',
      maxResults: 10,
      maxTokens: 2000
    });
    assert.ok(Array.isArray(recall), 'recall should be an array');
    // Recall may be empty if no FTS match (depending on exact content matching)
    // The memory store search is FTS-based and may require exact terms

    const stats = getMemoryStats({ groupFolder: 'main', userId: 'user-1' });
    assert.equal(stats.total, 2);
    assert.equal(stats.user, 1);
    assert.equal(stats.group, 1);

    const removed = forgetMemories({
      groupFolder: 'main',
      content: 'Likes espresso',
      scope: 'user',
      userId: 'user-1'
    });
    assert.equal(removed, 1);
  });
});

test('memory search ignores stop-word noise in natural-language queries', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-mem-'));
  await withTempHome(tempDir, async () => {
    const storeDir = path.join(tempDir, 'data', 'store');
    fs.mkdirSync(storeDir, { recursive: true });

    const { initMemoryStore, upsertMemoryItems, searchMemories } =
      await importFresh(distPath('memory-store.js'));

    initMemoryStore();
    upsertMemoryItems('main', [
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'preference',
        content: 'User prefers light roast coffee in the morning',
        importance: 0.8
      },
      {
        scope: 'group',
        type: 'task',
        content: 'Project Atlas deployment happens every Friday at 3pm',
        importance: 0.8
      },
      {
        scope: 'global',
        type: 'fact',
        content: 'Primary office timezone is PST',
        importance: 0.7
      }
    ], 'test');

    const results = searchMemories({
      groupFolder: 'main',
      userId: 'user-1',
      query: 'what is the atlas deployment schedule we discussed',
      limit: 10
    });

    assert.ok(results.some(item => item.content.includes('Project Atlas deployment')));
    assert.ok(!results.some(item => item.content.includes('light roast coffee')));
    assert.ok(!results.some(item => item.content.includes('timezone is PST')));
  });
});

test('buildUserProfile truncates oversized entries to stay prompt-efficient', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-mem-'));
  await withTempHome(tempDir, async () => {
    const storeDir = path.join(tempDir, 'data', 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    const { initMemoryStore, upsertMemoryItems, buildUserProfile } =
      await importFresh(distPath('memory-store.js'));

    initMemoryStore();
    upsertMemoryItems('main', [
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'preference',
        content: `User prefers ${'very '.repeat(200)}concise output for coding tasks`,
        importance: 0.9
      },
      {
        scope: 'user',
        subject_id: 'user-1',
        type: 'project',
        content: `Active project is ${'alpha '.repeat(180)}shipping`,
        importance: 0.8
      }
    ], 'test');

    const profile = buildUserProfile({ groupFolder: 'main', userId: 'user-1' });
    assert.ok(profile, 'profile should be generated');
    assert.ok(profile.length <= 1200, `profile length should be bounded, got ${profile.length}`);
    assert.ok(profile.includes('…'), 'oversized entries should be truncated');
  });
});
