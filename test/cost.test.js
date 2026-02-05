import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCostUSD } from '../dist/cost.js';

test('computeCostUSD returns null when pricing is null', () => {
  const result = computeCostUSD(1000, 500, null);
  assert.equal(result, null);
});

test('computeCostUSD computes correct cost with valid inputs', () => {
  const pricing = { prompt_per_million: 1.0, completion_per_million: 2.0 };
  const result = computeCostUSD(1_000_000, 500_000, pricing);
  assert.deepEqual(result, { prompt: 1.0, completion: 1.0, total: 2.0 });
});

test('computeCostUSD handles zero tokens', () => {
  const pricing = { prompt_per_million: 5.0, completion_per_million: 10.0 };
  const result = computeCostUSD(0, 0, pricing);
  assert.deepEqual(result, { prompt: 0, completion: 0, total: 0 });
});

test('computeCostUSD treats undefined tokens as zero', () => {
  const pricing = { prompt_per_million: 1.0, completion_per_million: 2.0 };
  const result = computeCostUSD(undefined, undefined, pricing);
  assert.deepEqual(result, { prompt: 0, completion: 0, total: 0 });
});

test('computeCostUSD treats NaN tokens as zero', () => {
  const pricing = { prompt_per_million: 1.0, completion_per_million: 2.0 };
  const result = computeCostUSD(NaN, Infinity, pricing);
  assert.deepEqual(result, { prompt: 0, completion: 0, total: 0 });
});

test('computeCostUSD handles small token counts', () => {
  const pricing = { prompt_per_million: 0.15, completion_per_million: 0.60 };
  const result = computeCostUSD(100, 50, pricing);
  assert.ok(result !== null);
  assert.ok(Math.abs(result.prompt - 0.000015) < 1e-10);
  assert.ok(Math.abs(result.completion - 0.00003) < 1e-10);
  assert.ok(Math.abs(result.total - 0.000045) < 1e-10);
});

test('computeCostUSD handles only prompt tokens', () => {
  const pricing = { prompt_per_million: 2.0, completion_per_million: 4.0 };
  const result = computeCostUSD(500_000, 0, pricing);
  assert.deepEqual(result, { prompt: 1.0, completion: 0, total: 1.0 });
});

test('computeCostUSD handles only completion tokens', () => {
  const pricing = { prompt_per_million: 2.0, completion_per_million: 4.0 };
  const result = computeCostUSD(0, 250_000, pricing);
  assert.deepEqual(result, { prompt: 0, completion: 1.0, total: 1.0 });
});
