#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_SLOS = {
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
};

function parseArgs(argv) {
  const args = {
    days: 7,
    dir: '',
    input: '',
    thresholds: '',
    enforce: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.days = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--dir' && i + 1 < argv.length) {
      args.dir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--input' && i + 1 < argv.length) {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--thresholds' && i + 1 < argv.length) {
      args.thresholds = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--enforce') {
      args.enforce = true;
    }
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function classifyErrorMessage(message) {
  const lower = String(message || '').toLowerCase();
  if (/invalid.?api.?key|unauthorized|forbidden|payment|required|insufficient.?credit|\b401\b|\b402\b|\b403\b/.test(lower)) {
    return 'auth';
  }
  if (/rate.?limit|too many requests|\b429\b/.test(lower)) {
    return 'rate_limit';
  }
  if (/timeout|timed out|deadline|econnreset|econnrefused|enotfound|eai_again/.test(lower)) {
    return 'timeout';
  }
  if (/context.?length|maximum.?context|too many tokens|token.?limit/.test(lower)) {
    return 'context_overflow';
  }
  return 'unknown';
}

function mergeThresholds(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return base;
  const merged = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object') {
      merged[key] = mergeThresholds(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function computeEmptySuccessRate(report) {
  const success = Number(report.records_success || 0);
  const empty = Number(report.empty_success_responses || 0);
  if (!Number.isFinite(success) || success <= 0) return null;
  if (!Number.isFinite(empty) || empty < 0) return null;
  return empty / success;
}

export function evaluateReleaseSlo(report, thresholds = DEFAULT_SLOS) {
  const failures = [];
  const checks = [];

  const recordsTotal = Number(report.records_total || 0);
  const successRate = Number(report.success_rate || 0);
  const errorRate = recordsTotal > 0 ? Number(report.records_error || 0) / recordsTotal : 0;
  const emptySuccessRate = computeEmptySuccessRate(report) ?? 0;
  const toolSuccessRate = Number(report?.tool_calls?.success_rate ?? 0);
  const p95Latency = Number(report?.latency_ms?.p95 ?? 0);

  checks.push({ name: 'records_total', actual: recordsTotal, threshold: thresholds.min_records, comparator: '>=' });
  if (recordsTotal < thresholds.min_records) {
    failures.push(`records_total ${recordsTotal} below ${thresholds.min_records}`);
  }

  checks.push({ name: 'success_rate', actual: successRate, threshold: thresholds.min_success_rate, comparator: '>=' });
  if (successRate < thresholds.min_success_rate) {
    failures.push(`success_rate ${successRate} below ${thresholds.min_success_rate}`);
  }

  checks.push({ name: 'error_rate', actual: Number(errorRate.toFixed(4)), threshold: thresholds.max_error_rate, comparator: '<=' });
  if (errorRate > thresholds.max_error_rate) {
    failures.push(`error_rate ${errorRate.toFixed(4)} above ${thresholds.max_error_rate}`);
  }

  checks.push({ name: 'empty_success_rate', actual: Number(emptySuccessRate.toFixed(4)), threshold: thresholds.max_empty_success_rate, comparator: '<=' });
  if (emptySuccessRate > thresholds.max_empty_success_rate) {
    failures.push(`empty_success_rate ${emptySuccessRate.toFixed(4)} above ${thresholds.max_empty_success_rate}`);
  }

  checks.push({ name: 'tool_success_rate', actual: toolSuccessRate, threshold: thresholds.min_tool_success_rate, comparator: '>=' });
  if (toolSuccessRate < thresholds.min_tool_success_rate) {
    failures.push(`tool_success_rate ${toolSuccessRate} below ${thresholds.min_tool_success_rate}`);
  }

  checks.push({ name: 'latency_p95_ms', actual: p95Latency, threshold: thresholds.max_p95_latency_ms, comparator: '<=' });
  if (p95Latency > thresholds.max_p95_latency_ms) {
    failures.push(`latency_p95_ms ${p95Latency} above ${thresholds.max_p95_latency_ms}`);
  }

  const classCounts = {
    auth: 0,
    rate_limit: 0,
    timeout: 0,
    context_overflow: 0,
    unknown: 0
  };
  const topErrors = Array.isArray(report.top_errors) ? report.top_errors : [];
  for (const entry of topErrors) {
    const errorClass = classifyErrorMessage(entry.key);
    classCounts[errorClass] += Number(entry.count || 0);
  }

  for (const [errorClass, maxRate] of Object.entries(thresholds.max_error_class_rate || {})) {
    const rate = recordsTotal > 0 ? classCounts[errorClass] / recordsTotal : 0;
    checks.push({
      name: `error_class_${errorClass}_rate`,
      actual: Number(rate.toFixed(4)),
      threshold: maxRate,
      comparator: '<='
    });
    if (rate > maxRate) {
      failures.push(`error_class_${errorClass}_rate ${rate.toFixed(4)} above ${maxRate}`);
    }
  }

  return {
    checks,
    failures,
    passed: failures.length === 0
  };
}

function buildBaselineReport(args) {
  if (args.input) {
    return readJson(args.input);
  }
  const baselineScript = path.join(process.cwd(), 'scripts', 'benchmark-baseline.js');
  const baselineArgs = [baselineScript, '--days', String(args.days)];
  if (args.dir) {
    baselineArgs.push('--dir', args.dir);
  }
  const stdout = execFileSync(process.execPath, baselineArgs, { encoding: 'utf-8' });
  return JSON.parse(stdout);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = buildBaselineReport(args);
  const thresholds = args.thresholds
    ? mergeThresholds(DEFAULT_SLOS, readJson(args.thresholds))
    : DEFAULT_SLOS;
  const evaluation = evaluateReleaseSlo(report, thresholds);
  const output = {
    source: args.input || 'benchmark-baseline',
    thresholds,
    report,
    checks: evaluation.checks,
    failures: evaluation.failures,
    passed: evaluation.passed
  };

  console.log(JSON.stringify(output, null, 2));
  if (args.enforce && !evaluation.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
