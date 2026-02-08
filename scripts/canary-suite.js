#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { evaluateScenarioMetrics } from './benchmark-scenarios.js';

const DEFAULT_INPUT = path.join(process.cwd(), 'test', 'fixtures', 'benchmark', 'scenario-traces.jsonl');
const DEFAULT_EXPECTED = path.join(process.cwd(), 'test', 'fixtures', 'benchmark', 'canary-expected.json');

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    expected: DEFAULT_EXPECTED,
    enforce: false,
    recoveryWindowMs: 10 * 60 * 1000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && i + 1 < argv.length) {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--expected' && i + 1 < argv.length) {
      args.expected = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--recovery-window-ms' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.recoveryWindowMs = value;
      i += 1;
      continue;
    }
    if (arg === '--enforce') {
      args.enforce = true;
    }
  }
  return args;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function loadJsonl(filePath) {
  const rows = [];
  if (!fs.existsSync(filePath)) return rows;
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

export function evaluateCanaryExpectations(metrics, expected) {
  const failures = [];
  const checks = [];

  const scenarioExpectations = expected?.scenarios || {};
  for (const [scenarioKey, config] of Object.entries(scenarioExpectations)) {
    const scenario = metrics.scenarios?.[scenarioKey];
    if (!scenario) {
      failures.push(`missing scenario metrics: ${scenarioKey}`);
      continue;
    }
    const minCandidates = Number(config.min_candidates ?? 0);
    const minPassRate = Number(config.min_pass_rate ?? 0);
    checks.push({
      scenario: scenarioKey,
      candidates: scenario.candidates,
      pass_rate: scenario.pass_rate,
      min_candidates: minCandidates,
      min_pass_rate: minPassRate
    });
    if (scenario.candidates < minCandidates) {
      failures.push(`${scenarioKey} candidates ${scenario.candidates} below ${minCandidates}`);
      continue;
    }
    if ((scenario.pass_rate ?? 0) < minPassRate) {
      failures.push(`${scenarioKey} pass_rate ${scenario.pass_rate} below ${minPassRate}`);
    }
  }

  const maxEmptySuccessRate = Number(expected?.totals?.max_empty_success_rate ?? Number.POSITIVE_INFINITY);
  const emptyRate = metrics.totals?.empty_success_rate;
  if (Number.isFinite(maxEmptySuccessRate) && Number.isFinite(emptyRate) && emptyRate > maxEmptySuccessRate) {
    failures.push(`empty_success_rate ${emptyRate} above ${maxEmptySuccessRate}`);
  }

  return { checks, failures };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = loadJsonl(args.input);
  const expected = loadJson(args.expected);
  const metrics = evaluateScenarioMetrics(rows, { recoveryWindowMs: args.recoveryWindowMs });
  const evaluation = evaluateCanaryExpectations(metrics, expected);

  const output = {
    input: args.input,
    expected: args.expected,
    recovery_window_ms: args.recoveryWindowMs,
    metrics,
    checks: evaluation.checks,
    failures: evaluation.failures
  };
  console.log(JSON.stringify(output, null, 2));

  if (args.enforce && evaluation.failures.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
