import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distPath, importFresh } from './test-helpers.js';

test('optimizeRecallQuery keeps the most recent lines and respects char budget', async () => {
  const { optimizeRecallQuery } = await importFresh(distPath('recall-policy.js'));
  const query = [
    '[01] line',
    '[02] line',
    '[03] line',
    '[04] line',
    '[05] line',
    '[06] line',
    '[07] line',
    '[08] line',
    '[09] line',
    '[10] line'
  ].join('\n');
  const optimized = optimizeRecallQuery(query, '', 30);
  assert.equal(optimized.includes('[01] line'), false);
  assert.equal(optimized.includes('[10] line'), true);
  assert.ok(optimized.length <= 30);
});

test('shouldRunMemoryRecall skips low-signal turns but keeps explicit memory intent', async () => {
  const { shouldRunMemoryRecall } = await importFresh(distPath('recall-policy.js'));

  assert.equal(shouldRunMemoryRecall('ok'), false);
  assert.equal(shouldRunMemoryRecall('thanks'), false);
  assert.equal(shouldRunMemoryRecall('status?'), false);
  assert.equal(shouldRunMemoryRecall('remember my preferred deployment region'), true);
  assert.equal(shouldRunMemoryRecall('summarize the api timeout errors from production logs'), true);
});

test('resolveRecallBudget preserves explicit memory intent', async () => {
  const { resolveRecallBudget } = await importFresh(distPath('recall-policy.js'));
  const budget = resolveRecallBudget({
    query: 'Remember my preferred deployment region and recall it later',
    maxResults: 8,
    maxTokens: 1500
  });
  assert.deepEqual(budget, { maxResults: 8, maxTokens: 1500 });
});

test('resolveRecallBudget trims non-memory tool-heavy prompts', async () => {
  const { resolveRecallBudget } = await importFresh(distPath('recall-policy.js'));
  const budget = resolveRecallBudget({
    query: 'Create file inbox/test.txt and read it back',
    maxResults: 8,
    maxTokens: 1500
  });
  assert.deepEqual(budget, { maxResults: 4, maxTokens: 900 });
});

test('resolveRecallBudget trims generic non-memory prompts', async () => {
  const { resolveRecallBudget } = await importFresh(distPath('recall-policy.js'));
  const budget = resolveRecallBudget({
    query: 'Summarize the latest build status and next actions',
    maxResults: 8,
    maxTokens: 1500
  });
  assert.deepEqual(budget, { maxResults: 6, maxTokens: 1200 });
});
