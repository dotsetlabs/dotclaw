import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContextOverflowRecoveryPlan } from '../dist/context-overflow-recovery.js';

test('buildContextOverflowRecoveryPlan keeps latest messages and compacts older ones', () => {
  const contextMessages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
  ];

  const plan = buildContextOverflowRecoveryPlan({
    contextMessages,
    emergencySummary: 'Earlier discussion summary',
    keepRecentCount: 4
  });

  assert.deepEqual(plan.toCompact.map(m => m.content), ['u1', 'a1']);
  assert.deepEqual(plan.toKeep.map(m => m.content), ['u2', 'a2', 'u3', 'a3']);
  assert.equal(plan.retryInput[0].role, 'user');
  assert.ok(plan.retryInput[0].content.includes('Earlier discussion summary'));
  assert.deepEqual(plan.retryInput.slice(1).map(m => m.content), ['u2', 'a2', 'u3', 'a3']);
});

test('buildContextOverflowRecoveryPlan omits summary preface when summary is empty', () => {
  const plan = buildContextOverflowRecoveryPlan({
    contextMessages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' }
    ],
    emergencySummary: '',
    keepRecentCount: 1
  });

  assert.equal(plan.retryInput.length, 1);
  assert.equal(plan.retryInput[0].content, 'a1');
});
