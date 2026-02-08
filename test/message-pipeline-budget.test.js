import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectPromptLineIndicesWithinBudget } from '../dist/message-pipeline.js';

test('selectPromptLineIndicesWithinBudget keeps newest lines within budget', () => {
  const lines = [
    'old-a',
    'old-b',
    'recent-c',
    'recent-d',
  ];

  const result = selectPromptLineIndicesWithinBudget(lines, 'recent-c'.length + 'recent-d'.length + 2);
  assert.deepEqual(result.indices, [2, 3]);
  assert.equal(result.omitted, 2);
});

test('selectPromptLineIndicesWithinBudget keeps all lines when budget allows', () => {
  const lines = ['a', 'b', 'c'];
  const result = selectPromptLineIndicesWithinBudget(lines, 100);
  assert.deepEqual(result.indices, [0, 1, 2]);
  assert.equal(result.omitted, 0);
});

test('selectPromptLineIndicesWithinBudget treats invalid budget as unlimited', () => {
  const lines = ['a', 'b', 'c'];
  const result = selectPromptLineIndicesWithinBudget(lines, 0);
  assert.deepEqual(result.indices, [0, 1, 2]);
  assert.equal(result.omitted, 0);
});
