import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

test('resolveMemoryBackend loads configured module backend', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-memory-backend-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: {
      memory: {
        backend: {
          strategy: 'module',
          modulePath: 'custom-memory-backend.mjs'
        }
      }
    }
  }, null, 2));

  fs.writeFileSync(path.join(tempDir, 'custom-memory-backend.mjs'), `
export default {
  async buildRecall() { return ['(note) custom backend recall']; },
  buildUserProfile() { return 'custom profile'; },
  getStats() { return { total: 11, user: 3, group: 6, global: 2 }; }
};
`);

  await withTempHome(tempDir, async () => {
    const { resolveMemoryBackend, resetMemoryBackendCacheForTests } = await importFresh(distPath('memory-backend.js'));
    resetMemoryBackendCacheForTests();
    const backend = await resolveMemoryBackend();
    const recall = await backend.buildRecall({
      groupFolder: 'main',
      userId: 'u1',
      query: 'remember this',
      maxResults: 8,
      maxTokens: 1000,
      minScore: 0.35
    });
    assert.deepEqual(recall, ['(note) custom backend recall']);
    assert.equal(backend.buildUserProfile({ groupFolder: 'main', userId: 'u1' }), 'custom profile');
    assert.deepEqual(
      backend.getStats({ groupFolder: 'main', userId: 'u1' }),
      { total: 11, user: 3, group: 6, global: 2 }
    );
  });
});

test('resolveMemoryBackend falls back to builtin when module load fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-memory-backend-'));
  const configDir = path.join(tempDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, 'runtime.json'), JSON.stringify({
    host: {
      memory: {
        backend: {
          strategy: 'module',
          modulePath: 'missing-backend.mjs'
        }
      }
    }
  }, null, 2));

  await withTempHome(tempDir, async () => {
    const { resolveMemoryBackend, builtinMemoryBackend, resetMemoryBackendCacheForTests } = await importFresh(distPath('memory-backend.js'));
    resetMemoryBackendCacheForTests();
    const backend = await resolveMemoryBackend();
    assert.equal(backend, builtinMemoryBackend);
  });
});
