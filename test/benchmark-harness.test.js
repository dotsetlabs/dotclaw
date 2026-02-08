import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { evaluateSnapshotComparison, evaluateSuperiorityGate } from '../scripts/benchmark-harness.js';

function rangeArray(size, start, step) {
  return Array.from({ length: size }, (_, index) => start + (index * step));
}

function buildSnapshot({
  label,
  total,
  success,
  emptySuccess,
  toolTotal,
  toolFailed,
  latencySample,
  memoryCandidates,
  memoryPassed
}) {
  const promptTotal = success * 420;
  const completionTotal = success * 110;
  const toolSuccessRate = toolTotal > 0 ? Number(((toolTotal - toolFailed) / toolTotal).toFixed(4)) : null;
  const successRate = total > 0 ? Number((success / total).toFixed(4)) : null;
  const emptySuccessRate = success > 0 ? Number((emptySuccess / success).toFixed(4)) : null;
  return {
    label,
    baseline: {
      records_total: total,
      records_success: success,
      records_error: total - success,
      empty_success_responses: emptySuccess,
      success_rate: successRate,
      latency_ms: {
        p50: latencySample[Math.floor(latencySample.length * 0.5)] ?? null,
        p95: latencySample[Math.floor(latencySample.length * 0.95)] ?? null,
        p99: latencySample[Math.floor(latencySample.length * 0.99)] ?? null
      },
      token_usage: {
        prompt_total: promptTotal,
        completion_total: completionTotal
      },
      tool_calls: {
        total: toolTotal,
        failed: toolFailed
      },
      records_by_source: [{
        source: 'dotclaw',
        records: total,
        success,
        errors: total - success,
        success_rate: successRate,
        empty_success: emptySuccess,
        empty_success_rate: emptySuccessRate,
        tool_calls_total: toolTotal,
        tool_calls_failed: toolFailed,
        tool_success_rate: toolSuccessRate,
        token_usage: {
          prompt_total: promptTotal,
          completion_total: completionTotal,
          total: promptTotal + completionTotal,
          prompt_per_success: success > 0 ? Number((promptTotal / success).toFixed(2)) : null,
          completion_per_success: success > 0 ? Number((completionTotal / success).toFixed(2)) : null,
          total_per_success: success > 0 ? Number(((promptTotal + completionTotal) / success).toFixed(2)) : null
        }
      }]
    },
    scenarios: {
      scenarios: {
        memory_carryover: { candidates: memoryCandidates, passed: memoryPassed },
        tool_heavy: { candidates: 0, passed: 0 },
        transient_recovery: { candidates: 0, passed: 0 },
        context_recovery: { candidates: 0, passed: 0 }
      }
    },
    raw: {
      latencies_ms_sample: latencySample
    }
  };
}

function traceFileName(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `trace-${year}-${month}-${day}.jsonl`;
}

function buildTraceRows(total, successTotal, latencyBase, failToolFraction) {
  const rows = [];
  const timestamp = new Date().toISOString();
  for (let i = 0; i < total; i += 1) {
    const success = i < successTotal;
    const toolCalls = Array.from({ length: 3 }, (_, idx) => ({
      id: `tool-${i}-${idx}`,
      ok: success ? ((i + idx) % 10) / 10 >= failToolFraction : false
    }));
    rows.push({
      timestamp,
      chat_id: `chat-${Math.floor(i / 10)}`,
      input_text: `request ${i}`,
      output_text: success ? `response ${i}` : '',
      error_code: success ? '' : 'timeout',
      latency_ms: latencyBase + (i % 20) * 12,
      tokens_prompt: 500 + (i % 15),
      tokens_completion: 150 + (i % 8),
      tool_calls: toolCalls
    });
  }
  return rows;
}

function writeJsonl(filePath, rows) {
  const content = rows.map(row => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}\n`);
}

function runHarness(args, env = {}) {
  const scriptPath = path.join(process.cwd(), 'scripts', 'benchmark-harness.js');
  const stdout = execFileSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env }
  });
  return JSON.parse(stdout);
}

test('evaluateSnapshotComparison detects significant improvements without regressions', () => {
  const before = buildSnapshot({
    label: 'before',
    total: 500,
    success: 390,
    emptySuccess: 35,
    toolTotal: 1500,
    toolFailed: 260,
    latencySample: rangeArray(500, 98000, 20),
    memoryCandidates: 120,
    memoryPassed: 85
  });
  const after = buildSnapshot({
    label: 'after',
    total: 500,
    success: 470,
    emptySuccess: 8,
    toolTotal: 1500,
    toolFailed: 40,
    latencySample: rangeArray(500, 62000, 12),
    memoryCandidates: 120,
    memoryPassed: 112
  });

  const comparison = evaluateSnapshotComparison(before, after, { bootstrapIterations: 500 });

  assert.equal(comparison.summary.passed, true);
  assert.equal(comparison.summary.significant_regressions.length, 0);
  assert.ok(comparison.summary.significant_improvements.includes('success_rate'));
  assert.ok(comparison.summary.significant_improvements.includes('error_rate'));
  assert.ok(comparison.summary.significant_improvements.includes('tool_success_rate'));
  assert.ok(comparison.summary.significant_improvements.includes('latency_p95_ms'));
});

test('evaluateSuperiorityGate enforces reliability, latency, and token tolerances', () => {
  const baseline = buildSnapshot({
    label: 'openclaw_baseline',
    total: 500,
    success: 470,
    emptySuccess: 6,
    toolTotal: 1400,
    toolFailed: 70,
    latencySample: rangeArray(500, 90000, 20),
    memoryCandidates: 120,
    memoryPassed: 110
  });
  const candidate = buildSnapshot({
    label: 'dotclaw_candidate',
    total: 500,
    success: 478,
    emptySuccess: 4,
    toolTotal: 1400,
    toolFailed: 55,
    latencySample: rangeArray(500, 70000, 16),
    memoryCandidates: 120,
    memoryPassed: 114
  });
  const comparison = evaluateSnapshotComparison(baseline, candidate, { bootstrapIterations: 400 });
  const gate = evaluateSuperiorityGate(comparison, { latencyTolerance: 0.08, tokenTolerance: 0.08 });
  assert.equal(gate.passed, true);
  assert.equal(gate.failures.length, 0);

  const regressed = buildSnapshot({
    label: 'dotclaw_regressed',
    total: 500,
    success: 450,
    emptySuccess: 15,
    toolTotal: 1400,
    toolFailed: 140,
    latencySample: rangeArray(500, 120000, 30),
    memoryCandidates: 120,
    memoryPassed: 90
  });
  const regressedComparison = evaluateSnapshotComparison(baseline, regressed, { bootstrapIterations: 300 });
  const regressedGate = evaluateSuperiorityGate(regressedComparison, { latencyTolerance: 0.05, tokenTolerance: 0.05 });
  assert.equal(regressedGate.passed, false);
  assert.ok(regressedGate.failures.some(item => item.includes('success_rate')));
});

test('benchmark harness CLI captures tranche snapshots and builds run report', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotclaw-harness-'));
  const traceDir = path.join(tempDir, 'traces');
  const outputDir = path.join(tempDir, 'reports');
  fs.mkdirSync(traceDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const tracePath = path.join(traceDir, traceFileName());
  const runId = 'tranche-run';

  writeJsonl(tracePath, buildTraceRows(180, 130, 110000, 0.35));

  const initOutput = runHarness([
    'init',
    '--run-id', runId,
    '--days', '30',
    '--dir', traceDir,
    '--output-dir', outputDir
  ]);
  assert.equal(initOutput.label, 'overall_start');

  const beforeOutput = runHarness([
    'capture',
    '--run-id', runId,
    '--label', 'tranche1_before',
    '--days', '30',
    '--dir', traceDir,
    '--output-dir', outputDir
  ]);
  assert.equal(beforeOutput.label, 'tranche1_before');

  writeJsonl(tracePath, buildTraceRows(180, 168, 72000, 0.08));

  const afterOutput = runHarness([
    'capture',
    '--run-id', runId,
    '--label', 'tranche1_after',
    '--days', '30',
    '--dir', traceDir,
    '--output-dir', outputDir
  ]);
  assert.equal(afterOutput.label, 'tranche1_after');

  runHarness([
    'capture',
    '--run-id', runId,
    '--label', 'overall_end',
    '--days', '30',
    '--dir', traceDir,
    '--output-dir', outputDir
  ]);

  const compareOutput = runHarness([
    'compare',
    '--run-id', runId,
    '--before', 'tranche1_before',
    '--after', 'tranche1_after',
    '--output-dir', outputDir
  ]);
  assert.equal(compareOutput.before_label, 'tranche1_before');
  assert.equal(compareOutput.after_label, 'tranche1_after');
  assert.equal(compareOutput.summary.passed, true);

  const headToHeadOutput = runHarness([
    'headtohead',
    '--run-id', runId,
    '--baseline', 'tranche1_before',
    '--candidate', 'tranche1_after',
    '--output-dir', outputDir
  ]);
  assert.equal(headToHeadOutput.mode, 'head_to_head');
  assert.equal(headToHeadOutput.superiority_gate.passed, true);

  const reportOutput = runHarness([
    'report',
    '--run-id', runId,
    '--output-dir', outputDir
  ]);
  assert.equal(reportOutput.run_id, runId);
  assert.equal(fs.existsSync(reportOutput.report_path), true);
  assert.equal(reportOutput.passed, true);
  assert.ok(reportOutput.comparisons >= 2);

  const report = JSON.parse(fs.readFileSync(reportOutput.report_path, 'utf-8'));
  const keys = report.comparisons.map(item => item.key);
  assert.ok(keys.includes('tranche1'));
  assert.ok(keys.includes('overall_start->terminal'));
});
