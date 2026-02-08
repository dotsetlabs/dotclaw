import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distPath, importFresh, withTempHome } from './test-helpers.js';

function loadFixture() {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'memory', 'precision-recall-fixture.json');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

test('memory recall fixture meets precision/recall thresholds', async () => {
  const fixture = loadFixture();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-memory-precision-'));
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

  await withTempHome(tempDir, async () => {
    const { initMemoryStore, upsertMemoryItems } = await importFresh(distPath('memory-store.js'));
    const { buildHybridMemoryRecall } = await importFresh(distPath('memory-recall.js'));
    initMemoryStore();
    upsertMemoryItems('main', fixture.memories, 'test-fixture');

    let recallSum = 0;
    let precisionSum = 0;
    let forbiddenChecks = 0;
    let forbiddenHits = 0;

    for (const item of fixture.cases) {
      const recall = await buildHybridMemoryRecall({
        groupFolder: 'main',
        userId: 'user-1',
        query: item.query,
        maxResults: 4,
        maxTokens: 900
      });

      const lines = recall.map(line => line.toLowerCase());
      const expectedHits = item.expected_keywords.filter(keyword =>
        lines.some(line => line.includes(String(keyword).toLowerCase()))
      ).length;
      const caseRecall = item.expected_keywords.length > 0
        ? expectedHits / item.expected_keywords.length
        : 1;
      recallSum += caseRecall;

      const relevantLines = lines.filter(line =>
        item.expected_keywords.some(keyword => line.includes(String(keyword).toLowerCase()))
      ).length;
      const casePrecision = lines.length > 0 ? relevantLines / lines.length : 0;
      precisionSum += casePrecision;

      for (const forbiddenKeyword of item.forbidden_keywords) {
        forbiddenChecks += 1;
        if (lines.some(line => line.includes(String(forbiddenKeyword).toLowerCase()))) {
          forbiddenHits += 1;
        }
      }
    }

    const avgRecall = recallSum / fixture.cases.length;
    const avgPrecision = precisionSum / fixture.cases.length;
    const forbiddenHitRate = forbiddenChecks > 0 ? forbiddenHits / forbiddenChecks : 0;

    assert.ok(
      avgRecall >= fixture.thresholds.min_avg_recall,
      `avgRecall=${avgRecall.toFixed(3)} below ${fixture.thresholds.min_avg_recall}`
    );
    assert.ok(
      avgPrecision >= fixture.thresholds.min_avg_precision,
      `avgPrecision=${avgPrecision.toFixed(3)} below ${fixture.thresholds.min_avg_precision}`
    );
    assert.ok(
      forbiddenHitRate <= fixture.thresholds.max_forbidden_hit_rate,
      `forbiddenHitRate=${forbiddenHitRate.toFixed(3)} above ${fixture.thresholds.max_forbidden_hit_rate}`
    );
  });
});
