import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateReleaseSlo } from '../scripts/release-slo-check.js';

test('evaluateReleaseSlo passes for healthy report', () => {
  const report = {
    records_total: 100,
    records_success: 98,
    records_error: 2,
    success_rate: 0.98,
    empty_success_responses: 0,
    latency_ms: { p95: 20000 },
    tool_calls: { success_rate: 0.97 },
    top_errors: [
      { key: 'Daemon response timeout after 90000ms', count: 2 }
    ]
  };
  const result = evaluateReleaseSlo(report, {
    min_records: 20,
    min_success_rate: 0.95,
    max_error_rate: 0.05,
    max_empty_success_rate: 0.01,
    min_tool_success_rate: 0.95,
    max_p95_latency_ms: 120000,
    max_error_class_rate: {
      auth: 0.02,
      rate_limit: 0.1,
      timeout: 0.1,
      context_overflow: 0.05,
      unknown: 0.1
    }
  });
  assert.equal(result.passed, true);
  assert.equal(result.failures.length, 0);
});

test('evaluateReleaseSlo flags failing SLO checks', () => {
  const report = {
    records_total: 10,
    records_success: 5,
    records_error: 5,
    success_rate: 0.5,
    empty_success_responses: 3,
    latency_ms: { p95: 500000 },
    tool_calls: { success_rate: 0.3 },
    top_errors: [
      { key: '401 unauthorized', count: 3 },
      { key: '429 rate limit', count: 2 }
    ]
  };
  const result = evaluateReleaseSlo(report);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(item => item.includes('records_total')));
  assert.ok(result.failures.some(item => item.includes('success_rate')));
  assert.ok(result.failures.some(item => item.includes('tool_success_rate')));
});
