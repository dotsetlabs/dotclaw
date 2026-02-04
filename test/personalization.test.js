import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

function writeBehaviorConfig(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    tool_calling_bias: 0.45,
    memory_importance_threshold: 0.6,
    response_style: 'balanced',
    caution_bias: 0.4,
    last_updated: '2026-02-01T00:00:00.000Z'
  }));
}

test('personalization applies preference memories with conflict keys', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-personal-'));
  await withTempCwd(tempDir, async () => {
    const prevBehaviorPath = process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH;
    process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH = path.join(tempDir, 'behavior.json');
    writeBehaviorConfig(process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH);

    try {
      const { initMemoryStore, upsertMemoryItems } = await importFresh(distPath('memory-store.js'));
      const { loadPersonalizedBehaviorConfig } = await importFresh(distPath('personalization.js'));

      initMemoryStore();

      upsertMemoryItems('main', [
        {
          scope: 'group',
          type: 'preference',
          conflict_key: 'caution_bias',
          content: 'Be cautious with uncertain claims.',
          tags: ['caution_bias:0.7'],
          metadata: { caution_bias: 0.7 },
          importance: 0.7,
          confidence: 0.8
        },
        {
          scope: 'user',
          subject_id: 'user-1',
          type: 'preference',
          conflict_key: 'response_style',
          content: 'Prefers concise responses.',
          tags: ['response_style:concise'],
          metadata: { response_style: 'concise' },
          importance: 0.8,
          confidence: 0.9
        },
        {
          scope: 'user',
          subject_id: 'user-1',
          type: 'preference',
          conflict_key: 'tool_calling_bias',
          content: 'Use tools proactively when needed.',
          tags: ['tool_calling_bias:0.7'],
          metadata: { tool_calling_bias: 0.7 },
          importance: 0.7,
          confidence: 0.9
        }
      ], 'test');

      const personalized = loadPersonalizedBehaviorConfig({ groupFolder: 'main', userId: 'user-1' });

      assert.equal(personalized.response_style, 'concise');
      assert.equal(personalized.tool_calling_bias, 0.7);
      assert.equal(personalized.caution_bias, 0.7);
      assert.equal(personalized.memory_importance_threshold, 0.6);
    } finally {
      if (prevBehaviorPath === undefined) {
        delete process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH;
      } else {
        process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH = prevBehaviorPath;
      }
    }
  });
});
