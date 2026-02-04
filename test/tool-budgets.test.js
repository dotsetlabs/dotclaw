import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempCwd } from './test-helpers.js';

test('applyToolBudgets denies tools that exceed daily limits', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-budgets-'));
  await withTempCwd(tempDir, async () => {
    const prevEnabled = process.env.DOTCLAW_TOOL_BUDGETS_ENABLED;
    const prevPath = process.env.DOTCLAW_TOOL_BUDGETS_PATH;

    const dataDir = path.join(tempDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const budgetsPath = path.join(dataDir, 'tool-budgets.json');
    fs.writeFileSync(budgetsPath, JSON.stringify({
      default: {
        per_day: {
          WebFetch: 1
        }
      }
    }));

    process.env.DOTCLAW_TOOL_BUDGETS_ENABLED = '1';
    process.env.DOTCLAW_TOOL_BUDGETS_PATH = budgetsPath;

    try {
      const { initDatabase, logToolCalls } = await importFresh(distPath('db.js'));
      const { applyToolBudgets } = await importFresh(distPath('tool-budgets.js'));

      initDatabase();

      const basePolicy = { allow: ['WebFetch', 'WebSearch'], deny: [] };
      const before = applyToolBudgets({ groupFolder: 'main', userId: 'user-1', toolPolicy: basePolicy });
      assert.equal(before.deny?.length || 0, 0);

      logToolCalls({
        traceId: 'trace-1',
        chatJid: 'chat-1',
        groupFolder: 'main',
        userId: 'user-1',
        toolCalls: [{ name: 'WebFetch', ok: true }],
        source: 'test'
      });

      const after = applyToolBudgets({ groupFolder: 'main', userId: 'user-1', toolPolicy: basePolicy });
      assert.ok(after.deny?.includes('webfetch'));
    } finally {
      if (prevEnabled === undefined) {
        delete process.env.DOTCLAW_TOOL_BUDGETS_ENABLED;
      } else {
        process.env.DOTCLAW_TOOL_BUDGETS_ENABLED = prevEnabled;
      }
      if (prevPath === undefined) {
        delete process.env.DOTCLAW_TOOL_BUDGETS_PATH;
      } else {
        process.env.DOTCLAW_TOOL_BUDGETS_PATH = prevPath;
      }
    }
  });
});
