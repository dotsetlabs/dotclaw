import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFailoverEnvelope,
  classifyFailoverError,
  chooseNextHostModelChain,
  isModelInHostCooldown,
  registerModelFailureCooldown,
  resetFailoverCooldownsForTests,
  downgradeReasoningEffort,
  reduceToolStepBudget
} from '../dist/failover-policy.js';

const hostFailoverConfig = {
  enabled: true,
  maxRetries: 1,
  cooldownRateLimitMs: 60_000,
  cooldownTransientMs: 300_000,
  cooldownInvalidResponseMs: 120_000
};

test('classifyFailoverError maps common categories', () => {
  assert.equal(classifyFailoverError('429 rate limit'), 'rate_limit');
  assert.equal(classifyFailoverError('Daemon response timeout after 90000ms'), 'timeout');
  assert.equal(classifyFailoverError('maximum context length exceeded'), 'context_overflow');
  assert.equal(classifyFailoverError('invalid api key'), 'auth');
});

test('model cooldown is applied and influences chain selection', () => {
  resetFailoverCooldownsForTests();
  registerModelFailureCooldown('model-b', 'rate_limit', hostFailoverConfig, 1000);
  assert.equal(isModelInHostCooldown('model-b', 1001), true);

  const next = chooseNextHostModelChain({
    modelChain: ['model-a', 'model-b', 'model-c'],
    attemptedPrimaryModels: new Set(['model-a']),
    nowMs: 1001
  });
  assert.ok(next);
  assert.equal(next.model, 'model-c');
  assert.deepEqual(next.fallbacks, ['model-a']);
});

test('cooldown expiry allows model back into chain selection', () => {
  resetFailoverCooldownsForTests();
  registerModelFailureCooldown('model-b', 'rate_limit', hostFailoverConfig, 1000);
  assert.equal(isModelInHostCooldown('model-b', 2000), true);
  assert.equal(isModelInHostCooldown('model-b', 62050), false);

  const next = chooseNextHostModelChain({
    modelChain: ['model-a', 'model-b', 'model-c'],
    attemptedPrimaryModels: new Set(['model-a']),
    nowMs: 62050
  });
  assert.ok(next);
  assert.equal(next.model, 'model-b');
});

test('timeout cooldown is extended beyond transient base cooldown', () => {
  resetFailoverCooldownsForTests();
  registerModelFailureCooldown('model-timeout', 'timeout', hostFailoverConfig, 1000);
  // Timeout cooldown is intentionally stricter than generic transient cooldown.
  assert.equal(isModelInHostCooldown('model-timeout', 301000), true);
  assert.equal(isModelInHostCooldown('model-timeout', 901000), false);
});

test('chain selection returns null when all candidates attempted or in cooldown', () => {
  resetFailoverCooldownsForTests();
  registerModelFailureCooldown('model-b', 'rate_limit', hostFailoverConfig, 1000);
  registerModelFailureCooldown('model-c', 'timeout', hostFailoverConfig, 1000);
  const next = chooseNextHostModelChain({
    modelChain: ['model-a', 'model-b', 'model-c'],
    attemptedPrimaryModels: new Set(['model-a']),
    nowMs: 2000
  });
  assert.equal(next, null);
});

test('reasoning/tool budgets downgrade for retry attempts', () => {
  assert.equal(downgradeReasoningEffort('high'), 'medium');
  assert.equal(downgradeReasoningEffort('medium'), 'low');
  assert.equal(downgradeReasoningEffort('low'), 'off');
  assert.equal(reduceToolStepBudget(100), 70);
  assert.equal(reduceToolStepBudget(10), 8);
});

test('buildFailoverEnvelope includes typed category and retryability', () => {
  const envelope = buildFailoverEnvelope({
    error: 'HTTP 429 too many requests',
    source: 'runtime_exception',
    attempt: 2,
    model: 'model-a',
    timestampMs: 1_700_000_000_000
  });

  assert.equal(envelope.category, 'rate_limit');
  assert.equal(envelope.retryable, true);
  assert.equal(envelope.source, 'runtime_exception');
  assert.equal(envelope.attempt, 2);
  assert.equal(envelope.model, 'model-a');
  assert.equal(envelope.statusCode, 429);
  assert.equal(typeof envelope.timestamp, 'string');
});
