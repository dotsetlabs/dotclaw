import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateScenarioMetrics } from '../scripts/benchmark-scenarios.js';
import { evaluateCanaryExpectations } from '../scripts/canary-suite.js';

function loadScenarioRows() {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'benchmark', 'scenario-traces.jsonl');
  const rows = [];
  const raw = fs.readFileSync(fixturePath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function loadExpected() {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'benchmark', 'canary-expected.json');
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
}

test('canary fixture satisfies expected outcomes', () => {
  const rows = loadScenarioRows();
  const expected = loadExpected();
  const metrics = evaluateScenarioMetrics(rows, { recoveryWindowMs: 10 * 60 * 1000 });
  const evaluation = evaluateCanaryExpectations(metrics, expected);
  assert.equal(evaluation.failures.length, 0, evaluation.failures.join('; '));
});

test('canary evaluator flags threshold regressions', () => {
  const metrics = {
    totals: { empty_success_rate: 0.2 },
    scenarios: {
      memory_carryover: { candidates: 10, pass_rate: 0.5 },
      tool_heavy: { candidates: 10, pass_rate: 0.5 },
      transient_recovery: { candidates: 5, pass_rate: 0.4 },
      context_recovery: { candidates: 4, pass_rate: 0.3 }
    }
  };
  const expected = loadExpected();
  const evaluation = evaluateCanaryExpectations(metrics, expected);
  assert.ok(evaluation.failures.length > 0);
  assert.ok(evaluation.failures.some(item => item.includes('memory_carryover')));
});
