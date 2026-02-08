#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_THRESHOLDS = {
  memory_carryover: { min_candidates: 5, min_pass_rate: 0.9 },
  tool_heavy: { min_candidates: 5, min_pass_rate: 0.95 },
  transient_recovery: { min_candidates: 3, min_pass_rate: 0.8 },
  context_recovery: { min_candidates: 2, min_pass_rate: 0.75 },
  empty_success_rate: { min_success: 20, max_rate: 0.02 }
};

function parseArgs(argv) {
  const args = {
    days: 7,
    dir: '',
    input: '',
    enforce: false,
    recoveryWindowMs: 10 * 60 * 1000,
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
    if (arg === '--enforce') {
      args.enforce = true;
      continue;
    }
    if (arg === '--recovery-window-ms' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.recoveryWindowMs = value;
      i += 1;
    }
  }
  return args;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function loadJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const parsed = safeJsonParse(line);
    if (parsed && typeof parsed === 'object') rows.push(parsed);
  }
  return rows;
}

function loadTracesFromDir(traceDir, sinceMs) {
  if (!fs.existsSync(traceDir)) return [];
  const rows = [];
  const files = fs.readdirSync(traceDir)
    .filter(name => /^trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();
  for (const fileName of files) {
    const fileRows = loadJsonlFile(path.join(traceDir, fileName));
    for (const row of fileRows) {
      const ts = Date.parse(String(row.timestamp || ''));
      if (!Number.isFinite(ts) || ts < sinceMs) continue;
      rows.push(row);
    }
  }
  return rows;
}

function getTimestampMs(row) {
  const ts = Date.parse(String(row.timestamp || ''));
  if (Number.isFinite(ts)) return ts;
  const created = Number(row.created_at);
  return Number.isFinite(created) ? created : 0;
}

function isSuccess(row) {
  return !(typeof row.error_code === 'string' && row.error_code.trim());
}

function isTransientErrorMessage(message) {
  const lower = String(message || '').toLowerCase();
  return /rate.?limit|too many requests|429|timeout|timed out|deadline|overloaded|unavailable|bad gateway|server error|econnrefused|econnreset|eai_again|enotfound|provider error|model not available/.test(lower);
}

function isContextErrorMessage(message) {
  const lower = String(message || '').toLowerCase();
  return /context.?length|maximum.?context|too many tokens|token.?limit/.test(lower);
}

function hasScenarioTag(inputText, tag) {
  const lower = String(inputText || '').toLowerCase();
  if (!lower) return false;
  const escaped = tag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`\\[(?:scenario:)?${escaped}\\]`, 'i').test(lower);
}

function evaluateRecoveryScenario(rows, matcher, recoveryWindowMs) {
  const sorted = [...rows].sort((a, b) => getTimestampMs(a) - getTimestampMs(b));
  const byChat = new Map();
  for (const row of sorted) {
    const chatId = String(row.chat_id || 'unknown');
    if (!byChat.has(chatId)) byChat.set(chatId, []);
    byChat.get(chatId).push(row);
  }

  let candidates = 0;
  let passed = 0;
  for (const events of byChat.values()) {
    for (let i = 0; i < events.length; i += 1) {
      const row = events[i];
      if (!matcher(row)) continue;
      candidates += 1;
      const startMs = getTimestampMs(row);
      let recovered = false;
      for (let j = i + 1; j < events.length; j += 1) {
        const next = events[j];
        const delta = getTimestampMs(next) - startMs;
        if (delta < 0) continue;
        if (delta > recoveryWindowMs) break;
        if (isSuccess(next)) {
          recovered = true;
          break;
        }
      }
      if (recovered) passed += 1;
    }
  }
  return {
    candidates,
    passed,
    pass_rate: candidates > 0 ? Number((passed / candidates).toFixed(4)) : null
  };
}

export function evaluateScenarioMetrics(rows, options = {}) {
  const recoveryWindowMs = Number.isFinite(options.recoveryWindowMs)
    ? Number(options.recoveryWindowMs)
    : (10 * 60 * 1000);

  const successRows = rows.filter(isSuccess);
  const memoryCandidates = rows.filter((row) => {
    const recallCount = Number(row.memory_recall_count);
    const hasRecallActivity = Number.isFinite(recallCount) && recallCount > 0;
    const explicitScenario = hasScenarioTag(row.input_text, 'memory')
      || hasScenarioTag(row.input_text, 'memory_carryover');
    return hasRecallActivity || explicitScenario;
  });
  let memoryPassed = 0;
  for (const row of memoryCandidates) {
    const recallCount = Number(row.memory_recall_count) || 0;
    const outputText = typeof row.output_text === 'string' ? row.output_text.trim() : '';
    if (isSuccess(row) && recallCount > 0 && outputText) memoryPassed += 1;
  }

  const toolCandidates = rows.filter((row) => {
    const explicitScenario = hasScenarioTag(row.input_text, 'tool_heavy');
    const calls = Array.isArray(row.tool_calls) ? row.tool_calls.length : 0;
    return explicitScenario || calls >= 3;
  });
  let toolPassed = 0;
  for (const row of toolCandidates) {
    const explicitScenario = hasScenarioTag(row.input_text, 'tool_heavy');
    const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    const minCalls = explicitScenario ? 1 : 3;
    if (calls.length < minCalls) continue;
    const failedCalls = calls.filter(call => !call?.ok).length;
    const outputText = typeof row.output_text === 'string' ? row.output_text.trim() : '';
    if (isSuccess(row) && outputText && failedCalls <= Math.floor(calls.length * 0.2)) {
      toolPassed += 1;
    }
  }

  const transientRecovery = evaluateRecoveryScenario(
    rows,
    row => !isSuccess(row) && isTransientErrorMessage(row.error_code),
    recoveryWindowMs
  );
  const contextRecovery = evaluateRecoveryScenario(
    rows,
    row => !isSuccess(row) && isContextErrorMessage(row.error_code),
    recoveryWindowMs
  );

  const emptySuccess = successRows.filter(row => {
    const outputText = typeof row.output_text === 'string' ? row.output_text.trim() : '';
    return !outputText;
  }).length;

  return {
    totals: {
      records: rows.length,
      success: successRows.length,
      empty_success: emptySuccess,
      empty_success_rate: successRows.length > 0 ? Number((emptySuccess / successRows.length).toFixed(4)) : null
    },
    scenarios: {
      memory_carryover: {
        candidates: memoryCandidates.length,
        passed: memoryPassed,
        pass_rate: memoryCandidates.length > 0 ? Number((memoryPassed / memoryCandidates.length).toFixed(4)) : null
      },
      tool_heavy: {
        candidates: toolCandidates.length,
        passed: toolPassed,
        pass_rate: toolCandidates.length > 0 ? Number((toolPassed / toolCandidates.length).toFixed(4)) : null
      },
      transient_recovery: transientRecovery,
      context_recovery: contextRecovery
    }
  };
}

export function evaluateScenarioThresholds(metrics, thresholds = DEFAULT_THRESHOLDS) {
  const failures = [];
  const checks = [
    ['memory_carryover', thresholds.memory_carryover],
    ['tool_heavy', thresholds.tool_heavy],
    ['transient_recovery', thresholds.transient_recovery],
    ['context_recovery', thresholds.context_recovery],
  ];

  for (const [scenarioKey, config] of checks) {
    const scenario = metrics.scenarios[scenarioKey];
    if (!scenario || !config) continue;
    if (scenario.candidates < config.min_candidates) continue;
    if ((scenario.pass_rate ?? 0) < config.min_pass_rate) {
      failures.push(
        `${scenarioKey} pass_rate ${scenario.pass_rate} below ${config.min_pass_rate} ` +
        `(candidates=${scenario.candidates})`
      );
    }
  }

  const emptyCfg = thresholds.empty_success_rate;
  if (emptyCfg && metrics.totals.success >= emptyCfg.min_success) {
    if ((metrics.totals.empty_success_rate ?? 0) > emptyCfg.max_rate) {
      failures.push(
        `empty_success_rate ${metrics.totals.empty_success_rate} above ${emptyCfg.max_rate} ` +
        `(success=${metrics.totals.success})`
      );
    }
  }

  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotclawHome = process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
  const traceDir = args.dir || path.join(dotclawHome, 'traces');
  const sinceMs = Date.now() - (args.days * 24 * 60 * 60 * 1000);
  const rows = args.input
    ? loadJsonlFile(args.input)
    : loadTracesFromDir(traceDir, sinceMs);

  const metrics = evaluateScenarioMetrics(rows, { recoveryWindowMs: args.recoveryWindowMs });
  const failures = evaluateScenarioThresholds(metrics, DEFAULT_THRESHOLDS);
  const output = {
    source: args.input || traceDir,
    window_days: args.input ? null : args.days,
    recovery_window_ms: args.recoveryWindowMs,
    thresholds: DEFAULT_THRESHOLDS,
    ...metrics,
    failures
  };
  console.log(JSON.stringify(output, null, 2));
  if (args.enforce && failures.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
