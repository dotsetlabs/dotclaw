import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateScenarioMetrics, evaluateScenarioThresholds } from '../scripts/benchmark-scenarios.js';

function loadFixtureRows() {
  const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'benchmark', 'scenario-traces.jsonl');
  const rows = [];
  const raw = fs.readFileSync(fixturePath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

test('benchmark scenario fixture meets default thresholds', () => {
  const rows = loadFixtureRows();
  const metrics = evaluateScenarioMetrics(rows, { recoveryWindowMs: 10 * 60 * 1000 });
  const failures = evaluateScenarioThresholds(metrics);
  assert.equal(failures.length, 0, failures.join('; '));
  assert.ok((metrics.scenarios.memory_carryover.pass_rate || 0) >= 0.9);
  assert.ok((metrics.scenarios.tool_heavy.pass_rate || 0) >= 0.95);
  assert.ok((metrics.scenarios.transient_recovery.pass_rate || 0) >= 0.8);
  assert.ok((metrics.scenarios.context_recovery.pass_rate || 0) >= 0.75);
});

test('benchmark threshold evaluator flags insufficient pass rates', () => {
  const rows = [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      chat_id: 'a',
      input_text: '[SCENARIO:memory] low quality',
      output_text: '',
      memory_recall_count: 0,
      error_code: ''
    },
    {
      timestamp: '2026-01-01T00:01:00.000Z',
      chat_id: 'a',
      input_text: '[SCENARIO:memory] low quality',
      output_text: '',
      memory_recall_count: 0,
      error_code: ''
    },
    {
      timestamp: '2026-01-01T00:02:00.000Z',
      chat_id: 'a',
      input_text: '[SCENARIO:memory] low quality',
      output_text: '',
      memory_recall_count: 0,
      error_code: ''
    },
    {
      timestamp: '2026-01-01T00:03:00.000Z',
      chat_id: 'a',
      input_text: '[SCENARIO:memory] low quality',
      output_text: '',
      memory_recall_count: 0,
      error_code: ''
    },
    {
      timestamp: '2026-01-01T00:04:00.000Z',
      chat_id: 'a',
      input_text: '[SCENARIO:memory] low quality',
      output_text: '',
      memory_recall_count: 0,
      error_code: ''
    }
  ];
  const metrics = evaluateScenarioMetrics(rows, { recoveryWindowMs: 10 * 60 * 1000 });
  const failures = evaluateScenarioThresholds(metrics);
  assert.ok(failures.some(item => item.includes('memory_carryover')));
});

test('memory carryover candidates require recall activity or explicit scenario tag', () => {
  const rows = [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      chat_id: 'plain',
      input_text: 'normal chat turn',
      output_text: 'ok',
      memory_recall_count: 0,
      error_code: ''
    },
    {
      timestamp: '2026-01-01T00:01:00.000Z',
      chat_id: 'memory',
      input_text: 'follow-up with recall',
      output_text: 'used memory',
      memory_recall_count: 2,
      error_code: ''
    }
  ];

  const metrics = evaluateScenarioMetrics(rows, { recoveryWindowMs: 10 * 60 * 1000 });
  assert.equal(metrics.scenarios.memory_carryover.candidates, 1);
  assert.equal(metrics.scenarios.memory_carryover.passed, 1);
});
