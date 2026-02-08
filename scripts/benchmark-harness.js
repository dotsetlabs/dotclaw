#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { buildReport, loadTraces, percentile } from './benchmark-baseline.js';
import { evaluateScenarioMetrics, evaluateScenarioThresholds } from './benchmark-scenarios.js';
import { evaluateReleaseSlo } from './release-slo-check.js';

const DEFAULT_BOOTSTRAP_ITERATIONS = 1200;
const DEFAULT_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_DAYS = 7;
const SNAPSHOT_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const [commandRaw, ...rest] = argv;
  const command = (commandRaw || 'help').trim().toLowerCase();
  const args = {
    command,
    runId: '',
    label: '',
    days: DEFAULT_DAYS,
    since: '',
    until: '',
    source: '',
    excludeSource: '',
    chatId: '',
    dir: '',
    outputDir: '',
    before: '',
    after: '',
    baseline: '',
    candidate: '',
    enforce: false,
    superiorityGate: false,
    bootstrap: DEFAULT_BOOTSTRAP_ITERATIONS,
    recoveryWindowMs: DEFAULT_RECOVERY_WINDOW_MS,
    latencyTolerance: 0.05,
    tokenTolerance: 0.05,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--run-id' && i + 1 < rest.length) {
      args.runId = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--label' && i + 1 < rest.length) {
      args.label = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--days' && i + 1 < rest.length) {
      const value = Number(rest[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.days = Math.floor(value);
      }
      i += 1;
      continue;
    }
    if (arg === '--since' && i + 1 < rest.length) {
      args.since = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--until' && i + 1 < rest.length) {
      args.until = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--source' && i + 1 < rest.length) {
      args.source = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--exclude-source' && i + 1 < rest.length) {
      args.excludeSource = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--chat-id' && i + 1 < rest.length) {
      args.chatId = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--dir' && i + 1 < rest.length) {
      args.dir = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--output-dir' && i + 1 < rest.length) {
      args.outputDir = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--before' && i + 1 < rest.length) {
      args.before = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--after' && i + 1 < rest.length) {
      args.after = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--baseline' && i + 1 < rest.length) {
      args.baseline = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--candidate' && i + 1 < rest.length) {
      args.candidate = rest[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--bootstrap' && i + 1 < rest.length) {
      const value = Number(rest[i + 1]);
      if (Number.isFinite(value) && value >= 200) {
        args.bootstrap = Math.floor(value);
      }
      i += 1;
      continue;
    }
    if (arg === '--recovery-window-ms' && i + 1 < rest.length) {
      const value = Number(rest[i + 1]);
      if (Number.isFinite(value) && value > 0) {
        args.recoveryWindowMs = Math.floor(value);
      }
      i += 1;
      continue;
    }
    if (arg === '--latency-tolerance' && i + 1 < rest.length) {
      const value = Number(rest[i + 1]);
      if (Number.isFinite(value) && value >= 0 && value <= 1) {
        args.latencyTolerance = value;
      }
      i += 1;
      continue;
    }
    if (arg === '--token-tolerance' && i + 1 < rest.length) {
      const value = Number(rest[i + 1]);
      if (Number.isFinite(value) && value >= 0 && value <= 1) {
        args.tokenTolerance = value;
      }
      i += 1;
      continue;
    }
    if (arg === '--enforce') {
      args.enforce = true;
      continue;
    }
    if (arg === '--superiority-gate') {
      args.superiorityGate = true;
    }
  }

  return args;
}

function usage() {
  console.log([
    'DotClaw Benchmark Harness',
    '',
    'Commands:',
    '  init --run-id <id> [--days <n>|--since <iso>] [--until <iso>] [--source <list>] [--dir <traces>] [--output-dir <path>]',
    '    Create a run and capture the "overall_start" snapshot.',
    '',
    '  capture --run-id <id> --label <name> [--days <n>|--since <iso>] [--until <iso>] [--source <list>] [--exclude-source <list>] [--chat-id <id,list>] [--dir <traces>] [--output-dir <path>]',
    '    Capture a named snapshot (for tranche before/after and final).',
    '',
    '  compare --run-id <id> --before <label|file> --after <label|file> [--bootstrap <n>] [--superiority-gate] [--latency-tolerance <0..1>] [--token-tolerance <0..1>] [--enforce]',
    '    Compare two snapshots with statistical tests.',
    '',
    '  headtohead --run-id <id> --baseline <label|file> --candidate <label|file> [--bootstrap <n>] [--latency-tolerance <0..1>] [--token-tolerance <0..1>] [--enforce]',
    '    DotClaw-vs-baseline comparison with superiority gate enforcement.',
    '',
    '  report --run-id <id> [--bootstrap <n>] [--enforce]',
    '    Build run-level report (overall + tranche before/after pairs).',
    '',
    'Examples:',
    '  npm run bench:harness -- init --run-id parity-superiority-20260207 --days 14',
    '  npm run bench:harness -- capture --run-id parity-superiority-20260207 --label tranche1_before --since 2026-02-07T20:00:00Z --source dotclaw,live-canary',
    '  npm run bench:harness -- capture --run-id parity-superiority-20260207 --label tranche1_after --since 2026-02-07T22:00:00Z --source dotclaw,live-canary',
    '  npm run bench:harness -- report --run-id parity-superiority-20260207 --enforce',
  ].join('\n'));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function normalizeLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function timestampToken(now = Date.now()) {
  const iso = new Date(now).toISOString();
  return iso.replace(/[:.]/g, '-');
}

function resolveDotclawHome() {
  return process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
}

function resolveHarnessRoot(args) {
  if (args.outputDir && args.outputDir.trim()) {
    return path.resolve(args.outputDir.trim());
  }
  return path.join(resolveDotclawHome(), 'reports', 'benchmark-harness');
}

function resolveRunDir(args) {
  const runId = args.runId.trim();
  if (!runId) {
    throw new Error('--run-id is required');
  }
  return path.join(resolveHarnessRoot(args), runId);
}

function resolveTraceDir(args) {
  if (args.dir && args.dir.trim()) {
    return path.resolve(args.dir.trim());
  }
  return path.join(resolveDotclawHome(), 'traces');
}

function parseCsvSet(value, options = {}) {
  const lower = options.lower !== false;
  const entries = String(value || '')
    .split(',')
    .map(item => {
      const trimmed = item.trim();
      return lower ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);
  return entries.length > 0 ? new Set(entries) : null;
}

function resolveTimestamp(value, fallback) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return fallback;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return source || 'unknown';
}

function resolveTraceFilters(args) {
  const sinceMs = resolveTimestamp(args.since, Date.now() - (args.days * 24 * 60 * 60 * 1000));
  const untilMs = resolveTimestamp(args.until, Infinity);
  const includeSources = parseCsvSet(args.source);
  const excludeSources = parseCsvSet(args.excludeSource);
  const includeChats = parseCsvSet(args.chatId, { lower: false });
  return {
    sinceMs,
    untilMs,
    includeSources,
    excludeSources,
    includeChats
  };
}

function currentGitInfo() {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const status = execSync('git status --porcelain', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    return { sha: null, dirty: null };
  }
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

function evenlySample(values, maxCount) {
  if (!Array.isArray(values)) return [];
  if (!Number.isFinite(maxCount) || maxCount <= 0) return [];
  if (values.length <= maxCount) return [...values];
  const sampled = [];
  const stride = values.length / maxCount;
  for (let i = 0; i < maxCount; i += 1) {
    const idx = Math.min(values.length - 1, Math.floor(i * stride));
    sampled.push(values[idx]);
  }
  return sampled;
}

function extractRawSignals(records) {
  const successFlags = [];
  const emptySuccessFlags = [];
  const latencies = [];
  const promptTokens = [];
  const completionTokens = [];
  const toolCallSuccessFlags = [];
  const bySource = new Map();
  const errorClassCounts = {
    auth: 0,
    rate_limit: 0,
    timeout: 0,
    context_overflow: 0,
    unknown: 0,
  };

  for (const row of records) {
    const source = normalizeSource(row.source);
    if (!bySource.has(source)) {
      bySource.set(source, {
        success: [],
        empty: [],
        latencies: [],
        tool: [],
        promptTokens: [],
        completionTokens: []
      });
    }
    const sourceSignals = bySource.get(source);
    const hasError = typeof row.error_code === 'string' && row.error_code.trim().length > 0;
    if (hasError) {
      const errorClass = classifyErrorMessage(row.error_code);
      errorClassCounts[errorClass] += 1;
      successFlags.push(0);
      sourceSignals.success.push(0);
    } else {
      successFlags.push(1);
      sourceSignals.success.push(1);
      const outputText = typeof row.output_text === 'string' ? row.output_text.trim() : '';
      const emptyFlag = outputText ? 0 : 1;
      emptySuccessFlags.push(emptyFlag);
      sourceSignals.empty.push(emptyFlag);
    }

    const latency = Number(row.latency_ms);
    if (Number.isFinite(latency) && latency >= 0) {
      latencies.push(latency);
      sourceSignals.latencies.push(latency);
    }
    const prompt = Number(row.tokens_prompt);
    if (Number.isFinite(prompt) && prompt >= 0) {
      promptTokens.push(prompt);
      sourceSignals.promptTokens.push(prompt);
    }
    const completion = Number(row.tokens_completion);
    if (Number.isFinite(completion) && completion >= 0) {
      completionTokens.push(completion);
      sourceSignals.completionTokens.push(completion);
    }

    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    for (const call of toolCalls) {
      const flag = call?.ok ? 1 : 0;
      toolCallSuccessFlags.push(flag);
      sourceSignals.tool.push(flag);
    }
  }

  const perSource = {};
  for (const [source, signals] of bySource.entries()) {
    perSource[source] = {
      success_flags: signals.success,
      empty_success_flags: signals.empty,
      tool_call_success_flags: signals.tool,
      latencies_ms_sample: evenlySample(signals.latencies, 2000),
      prompt_tokens_sample: evenlySample(signals.promptTokens, 2000),
      completion_tokens_sample: evenlySample(signals.completionTokens, 2000)
    };
  }

  return {
    success_flags: successFlags,
    empty_success_flags: emptySuccessFlags,
    tool_call_success_flags: toolCallSuccessFlags,
    latencies_ms_sample: evenlySample(latencies, 4000),
    prompt_tokens_sample: evenlySample(promptTokens, 4000),
    completion_tokens_sample: evenlySample(completionTokens, 4000),
    error_class_counts: errorClassCounts,
    per_source: perSource,
  };
}

function buildSnapshot(args) {
  const traceDir = resolveTraceDir(args);
  const filters = resolveTraceFilters(args);
  const records = loadTraces(traceDir, filters);
  const baseline = buildReport(records, traceDir, args.days);
  const scenarioMetrics = evaluateScenarioMetrics(records, { recoveryWindowMs: args.recoveryWindowMs });
  const scenarioFailures = evaluateScenarioThresholds(scenarioMetrics);
  const releaseSlo = evaluateReleaseSlo(baseline);
  const raw = extractRawSignals(records);

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    run_id: args.runId,
    label: normalizeLabel(args.label),
    captured_at: new Date().toISOString(),
    window_days: args.days,
    window: {
      since: Number.isFinite(filters.sinceMs) ? new Date(filters.sinceMs).toISOString() : null,
      until: Number.isFinite(filters.untilMs) ? new Date(filters.untilMs).toISOString() : null
    },
    filters: {
      source: filters.includeSources ? Array.from(filters.includeSources.values()) : null,
      exclude_source: filters.excludeSources ? Array.from(filters.excludeSources.values()) : null,
      chat_id: filters.includeChats ? Array.from(filters.includeChats.values()) : null
    },
    trace_dir: traceDir,
    git: currentGitInfo(),
    baseline,
    scenarios: {
      ...scenarioMetrics,
      failures: scenarioFailures,
    },
    release_slo: releaseSlo,
    raw,
  };
}

function loadManifest(runDir) {
  const manifestPath = path.join(runDir, 'manifest.json');
  const fallback = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    run_id: path.basename(runDir),
    created_at: new Date().toISOString(),
    snapshots: [],
  };
  const manifest = readJson(manifestPath, fallback);
  if (!Array.isArray(manifest.snapshots)) manifest.snapshots = [];
  return manifest;
}

function saveManifest(runDir, manifest) {
  writeJson(path.join(runDir, 'manifest.json'), manifest);
}

function addSnapshotToManifest(manifest, snapshotFile, snapshot) {
  const entry = {
    label: snapshot.label,
    file: path.basename(snapshotFile),
    captured_at: snapshot.captured_at,
    records_total: snapshot?.baseline?.records_total ?? 0,
  };
  const existingIdx = manifest.snapshots.findIndex((item) => item.label === entry.label);
  if (existingIdx >= 0) {
    manifest.snapshots[existingIdx] = entry;
  } else {
    manifest.snapshots.push(entry);
  }
  manifest.snapshots.sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at)));
}

function resolveSnapshotPathFromLabel(runDir, label) {
  const clean = normalizeLabel(label);
  if (!clean) return null;
  const direct = path.join(runDir, 'snapshots', `${clean}.json`);
  if (fs.existsSync(direct)) return direct;
  return null;
}

function resolveSnapshotPath(runDir, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed.endsWith('.json') && fs.existsSync(trimmed)) {
    return path.resolve(trimmed);
  }
  if (fs.existsSync(path.join(runDir, 'snapshots', trimmed))) {
    return path.join(runDir, 'snapshots', trimmed);
  }
  return resolveSnapshotPathFromLabel(runDir, trimmed);
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * abs);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs));
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function twoProportionStats(params) {
  const n1 = Math.max(0, Number(params.n1) || 0);
  const n2 = Math.max(0, Number(params.n2) || 0);
  const s1 = Math.min(n1, Math.max(0, Number(params.s1) || 0));
  const s2 = Math.min(n2, Math.max(0, Number(params.s2) || 0));
  if (n1 === 0 || n2 === 0) {
    return {
      before: n1 > 0 ? s1 / n1 : null,
      after: n2 > 0 ? s2 / n2 : null,
      delta: null,
      p_value: null,
      ci95: [null, null],
      significant: false,
    };
  }

  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const delta = p2 - p1;
  const pooled = (s1 + s2) / (n1 + n2);
  const sePooled = Math.sqrt(Math.max(1e-12, pooled * (1 - pooled) * (1 / n1 + 1 / n2)));
  const z = delta / sePooled;
  const pValue = Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))));

  const se = Math.sqrt(
    Math.max(1e-12, (p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2)
  );
  const ciLow = delta - 1.96 * se;
  const ciHigh = delta + 1.96 * se;

  return {
    before: p1,
    after: p2,
    delta,
    p_value: pValue,
    ci95: [ciLow, ciHigh],
    significant: pValue < 0.05,
  };
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithReplacement(values, rng) {
  const result = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const idx = Math.floor(rng() * values.length);
    result[i] = values[idx];
  }
  return result;
}

function bootstrapDelta(params) {
  const before = Array.isArray(params.before) ? params.before.filter(Number.isFinite) : [];
  const after = Array.isArray(params.after) ? params.after.filter(Number.isFinite) : [];
  const iterations = Math.max(200, Math.floor(params.iterations || DEFAULT_BOOTSTRAP_ITERATIONS));
  const statFn = params.statFn;
  if (before.length < 20 || after.length < 20) {
    return {
      before: before.length > 0 ? statFn(before) : null,
      after: after.length > 0 ? statFn(after) : null,
      delta: null,
      p_value: null,
      ci95: [null, null],
      significant: false,
    };
  }

  const beforeStat = statFn(before);
  const afterStat = statFn(after);
  const deltas = [];
  const seed = (before.length * 2654435761 + after.length * 1013904223 + iterations) >>> 0;
  const rng = mulberry32(seed);

  for (let i = 0; i < iterations; i += 1) {
    const b = sampleWithReplacement(before, rng);
    const a = sampleWithReplacement(after, rng);
    deltas.push(statFn(a) - statFn(b));
  }
  deltas.sort((a, b) => a - b);
  const ciLow = percentile(deltas, 2.5);
  const ciHigh = percentile(deltas, 97.5);
  const observedDelta = afterStat - beforeStat;
  const oppositeSignCount = observedDelta >= 0
    ? deltas.filter(v => v <= 0).length
    : deltas.filter(v => v >= 0).length;
  const pValue = Math.max(1 / iterations, Math.min(1, (2 * oppositeSignCount) / iterations));

  return {
    before: beforeStat,
    after: afterStat,
    delta: observedDelta,
    p_value: pValue,
    ci95: [ciLow, ciHigh],
    significant: ciLow !== null && ciHigh !== null && (ciLow > 0 || ciHigh < 0),
  };
}

function summarizeDirectionalResult(name, stats, direction) {
  const delta = stats?.delta;
  const improved = Number.isFinite(delta)
    ? (direction === 'up' ? delta > 0 : delta < 0)
    : false;
  const regressed = Number.isFinite(delta)
    ? (direction === 'up' ? delta < 0 : delta > 0)
    : false;
  const significant = Boolean(stats?.significant);
  return {
    name,
    direction,
    ...stats,
    improved,
    regressed,
    significant_improvement: improved && significant,
    significant_regression: regressed && significant,
  };
}

function getSourceMix(snapshot) {
  const rows = Array.isArray(snapshot?.baseline?.records_by_source)
    ? snapshot.baseline.records_by_source
    : [];
  const total = rows.reduce((sum, item) => sum + Number(item.records || 0), 0);
  if (!Number.isFinite(total) || total <= 0) return {};
  const mix = {};
  for (const row of rows) {
    const source = normalizeSource(row.source);
    const records = Number(row.records || 0);
    if (records <= 0) continue;
    mix[source] = records / total;
  }
  return mix;
}

function weightedAverage(parts, weights) {
  let weighted = 0;
  let appliedWeight = 0;
  for (const [source, value] of Object.entries(parts || {})) {
    if (!Number.isFinite(value)) continue;
    const weight = Number(weights[source] || 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weighted += value * weight;
    appliedWeight += weight;
  }
  if (appliedWeight <= 0) return null;
  return weighted / appliedWeight;
}

function resampleToCount(values, count) {
  const list = Array.isArray(values) ? values.filter(Number.isFinite) : [];
  if (count <= 0 || list.length === 0) return [];
  if (list.length >= count) {
    return evenlySample(list, count);
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(list[i % list.length]);
  }
  return out;
}

function weightedLatencyPercentile(snapshot, mix, p) {
  const perSource = snapshot?.raw?.per_source || {};
  const targetSample = 4000;
  const combined = [];
  let totalWeight = 0;
  for (const [source, weightRaw] of Object.entries(mix || {})) {
    const weight = Number(weightRaw || 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    totalWeight += weight;
    const sourceRows = perSource[source];
    const values = sourceRows?.latencies_ms_sample || [];
    if (!Array.isArray(values) || values.length === 0) continue;
    const count = Math.max(1, Math.round(weight * targetSample));
    combined.push(...resampleToCount(values, count));
  }
  if (combined.length === 0 || totalWeight <= 0) return null;
  return percentile(combined, p);
}

function weightedCoreValues(snapshot, mix) {
  const rows = Array.isArray(snapshot?.baseline?.records_by_source)
    ? snapshot.baseline.records_by_source
    : [];
  const sourceMetrics = {};
  for (const row of rows) {
    const source = normalizeSource(row.source);
    const successRate = Number(row.success_rate);
    const emptySuccessRate = Number(row.empty_success_rate);
    const toolSuccessRate = Number(row.tool_success_rate);
    const errorRate = Number.isFinite(successRate) ? 1 - successRate : NaN;
    const sourceTokenUsage = row?.token_usage && typeof row.token_usage === 'object'
      ? row.token_usage
      : {};
    const promptPerSuccess = Number(sourceTokenUsage.prompt_per_success);
    const completionPerSuccess = Number(sourceTokenUsage.completion_per_success);
    const totalPerSuccess = Number(sourceTokenUsage.total_per_success);
    sourceMetrics[source] = {
      success_rate: Number.isFinite(successRate) ? successRate : NaN,
      error_rate: Number.isFinite(errorRate) ? errorRate : NaN,
      empty_success_rate: Number.isFinite(emptySuccessRate) ? emptySuccessRate : NaN,
      tool_success_rate: Number.isFinite(toolSuccessRate) ? toolSuccessRate : NaN,
      prompt_tokens_per_success: Number.isFinite(promptPerSuccess) ? promptPerSuccess : NaN,
      completion_tokens_per_success: Number.isFinite(completionPerSuccess) ? completionPerSuccess : NaN,
      total_tokens_per_success: Number.isFinite(totalPerSuccess) ? totalPerSuccess : NaN
    };
  }

  const parts = {
    success_rate: {},
    error_rate: {},
    empty_success_rate: {},
    tool_success_rate: {},
    prompt_tokens_per_success: {},
    completion_tokens_per_success: {},
    total_tokens_per_success: {},
  };
  for (const [source, metrics] of Object.entries(sourceMetrics)) {
    parts.success_rate[source] = metrics.success_rate;
    parts.error_rate[source] = metrics.error_rate;
    parts.empty_success_rate[source] = metrics.empty_success_rate;
    parts.tool_success_rate[source] = metrics.tool_success_rate;
    parts.prompt_tokens_per_success[source] = metrics.prompt_tokens_per_success;
    parts.completion_tokens_per_success[source] = metrics.completion_tokens_per_success;
    parts.total_tokens_per_success[source] = metrics.total_tokens_per_success;
  }

  return {
    success_rate: weightedAverage(parts.success_rate, mix),
    error_rate: weightedAverage(parts.error_rate, mix),
    empty_success_rate: weightedAverage(parts.empty_success_rate, mix),
    tool_success_rate: weightedAverage(parts.tool_success_rate, mix),
    latency_p50_ms: weightedLatencyPercentile(snapshot, mix, 50),
    latency_p95_ms: weightedLatencyPercentile(snapshot, mix, 95),
    latency_p99_ms: weightedLatencyPercentile(snapshot, mix, 99),
    prompt_tokens_per_success: weightedAverage(parts.prompt_tokens_per_success, mix),
    completion_tokens_per_success: weightedAverage(parts.completion_tokens_per_success, mix),
    total_tokens_per_success: weightedAverage(parts.total_tokens_per_success, mix)
  };
}

function summarizeWeightedMetric(name, direction, beforeValue, afterValue) {
  const before = Number.isFinite(beforeValue) ? Number(beforeValue) : null;
  const after = Number.isFinite(afterValue) ? Number(afterValue) : null;
  const delta = before !== null && after !== null ? after - before : null;
  const improved = delta !== null ? (direction === 'up' ? delta > 0 : delta < 0) : false;
  const regressed = delta !== null ? (direction === 'up' ? delta < 0 : delta > 0) : false;
  return {
    name,
    direction,
    before,
    after,
    delta,
    p_value: null,
    ci95: [null, null],
    significant: false,
    improved,
    regressed,
    significant_improvement: false,
    significant_regression: false,
  };
}

function deterministicDeltaStats(beforeValue, afterValue) {
  const before = Number.isFinite(beforeValue) ? Number(beforeValue) : null;
  const after = Number.isFinite(afterValue) ? Number(afterValue) : null;
  const delta = before !== null && after !== null ? after - before : null;
  return {
    before,
    after,
    delta,
    p_value: null,
    ci95: [null, null],
    significant: false
  };
}

function extractTokensPerSuccess(snapshot) {
  const promptTotal = Number(snapshot?.baseline?.token_usage?.prompt_total || 0);
  const completionTotal = Number(snapshot?.baseline?.token_usage?.completion_total || 0);
  const success = Number(snapshot?.baseline?.records_success || 0);
  if (!Number.isFinite(success) || success <= 0) {
    return {
      prompt_tokens_per_success: null,
      completion_tokens_per_success: null,
      total_tokens_per_success: null,
    };
  }
  const promptPerSuccess = Number.isFinite(promptTotal) ? promptTotal / success : null;
  const completionPerSuccess = Number.isFinite(completionTotal) ? completionTotal / success : null;
  const totalPerSuccess = Number.isFinite(promptPerSuccess) && Number.isFinite(completionPerSuccess)
    ? promptPerSuccess + completionPerSuccess
    : null;
  return {
    prompt_tokens_per_success: Number.isFinite(promptPerSuccess) ? Number(promptPerSuccess.toFixed(2)) : null,
    completion_tokens_per_success: Number.isFinite(completionPerSuccess) ? Number(completionPerSuccess.toFixed(2)) : null,
    total_tokens_per_success: Number.isFinite(totalPerSuccess) ? Number(totalPerSuccess.toFixed(2)) : null,
  };
}

export function evaluateSnapshotComparison(beforeSnapshot, afterSnapshot, options = {}) {
  const before = beforeSnapshot;
  const after = afterSnapshot;
  const bootstrapIterations = Math.max(200, Math.floor(options.bootstrapIterations || DEFAULT_BOOTSTRAP_ITERATIONS));

  const beforeTotal = Number(before?.baseline?.records_total || 0);
  const afterTotal = Number(after?.baseline?.records_total || 0);
  const beforeErrors = Number(before?.baseline?.records_error || 0);
  const afterErrors = Number(after?.baseline?.records_error || 0);
  const beforeSuccess = Number(before?.baseline?.records_success || 0);
  const afterSuccess = Number(after?.baseline?.records_success || 0);
  const beforeEmpty = Number(before?.baseline?.empty_success_responses || 0);
  const afterEmpty = Number(after?.baseline?.empty_success_responses || 0);

  const beforeToolTotal = Number(before?.baseline?.tool_calls?.total || 0);
  const beforeToolFailed = Number(before?.baseline?.tool_calls?.failed || 0);
  const afterToolTotal = Number(after?.baseline?.tool_calls?.total || 0);
  const afterToolFailed = Number(after?.baseline?.tool_calls?.failed || 0);
  const beforeToolSuccess = Math.max(0, beforeToolTotal - beforeToolFailed);
  const afterToolSuccess = Math.max(0, afterToolTotal - afterToolFailed);

  const successRate = summarizeDirectionalResult(
    'success_rate',
    twoProportionStats({ s1: beforeSuccess, n1: beforeTotal, s2: afterSuccess, n2: afterTotal }),
    'up'
  );
  const errorRate = summarizeDirectionalResult(
    'error_rate',
    twoProportionStats({ s1: beforeErrors, n1: beforeTotal, s2: afterErrors, n2: afterTotal }),
    'down'
  );
  const emptySuccessRate = summarizeDirectionalResult(
    'empty_success_rate',
    twoProportionStats({ s1: beforeEmpty, n1: beforeSuccess, s2: afterEmpty, n2: afterSuccess }),
    'down'
  );
  const toolSuccessRate = summarizeDirectionalResult(
    'tool_success_rate',
    twoProportionStats({ s1: beforeToolSuccess, n1: beforeToolTotal, s2: afterToolSuccess, n2: afterToolTotal }),
    'up'
  );

  const latencyP50Stats = bootstrapDelta({
    before: before?.raw?.latencies_ms_sample || [],
    after: after?.raw?.latencies_ms_sample || [],
    iterations: bootstrapIterations,
    statFn: values => percentile(values, 50),
  });
  const latencyP50 = summarizeDirectionalResult('latency_p50_ms', latencyP50Stats, 'down');

  const latencyP95Stats = bootstrapDelta({
    before: before?.raw?.latencies_ms_sample || [],
    after: after?.raw?.latencies_ms_sample || [],
    iterations: bootstrapIterations,
    statFn: values => percentile(values, 95),
  });
  const latencyP95 = summarizeDirectionalResult('latency_p95_ms', latencyP95Stats, 'down');

  const latencyP99Stats = bootstrapDelta({
    before: before?.raw?.latencies_ms_sample || [],
    after: after?.raw?.latencies_ms_sample || [],
    iterations: bootstrapIterations,
    statFn: values => percentile(values, 99),
  });
  const latencyP99 = summarizeDirectionalResult('latency_p99_ms', latencyP99Stats, 'down');

  const beforeTokensPerSuccess = extractTokensPerSuccess(before);
  const afterTokensPerSuccess = extractTokensPerSuccess(after);
  const promptTokensPerSuccess = summarizeDirectionalResult(
    'prompt_tokens_per_success',
    deterministicDeltaStats(beforeTokensPerSuccess.prompt_tokens_per_success, afterTokensPerSuccess.prompt_tokens_per_success),
    'down'
  );
  const completionTokensPerSuccess = summarizeDirectionalResult(
    'completion_tokens_per_success',
    deterministicDeltaStats(beforeTokensPerSuccess.completion_tokens_per_success, afterTokensPerSuccess.completion_tokens_per_success),
    'down'
  );
  const totalTokensPerSuccess = summarizeDirectionalResult(
    'total_tokens_per_success',
    deterministicDeltaStats(beforeTokensPerSuccess.total_tokens_per_success, afterTokensPerSuccess.total_tokens_per_success),
    'down'
  );

  const scenarioKeys = ['memory_carryover', 'tool_heavy', 'transient_recovery', 'context_recovery'];
  const scenarioResults = [];
  for (const key of scenarioKeys) {
    const beforeScenario = before?.scenarios?.scenarios?.[key];
    const afterScenario = after?.scenarios?.scenarios?.[key];
    const scenarioStats = summarizeDirectionalResult(
      `scenario_${key}_pass_rate`,
      twoProportionStats({
        s1: Number(beforeScenario?.passed || 0),
        n1: Number(beforeScenario?.candidates || 0),
        s2: Number(afterScenario?.passed || 0),
        n2: Number(afterScenario?.candidates || 0),
      }),
      'up'
    );
    scenarioResults.push({
      ...scenarioStats,
      before_candidates: Number(beforeScenario?.candidates || 0),
      after_candidates: Number(afterScenario?.candidates || 0),
    });
  }

  const core = [
    successRate,
    errorRate,
    emptySuccessRate,
    toolSuccessRate,
    latencyP50,
    latencyP95,
    latencyP99,
    promptTokensPerSuccess,
    completionTokensPerSuccess,
    totalTokensPerSuccess
  ];
  const all = [...core, ...scenarioResults];
  const significantImprovements = all.filter(item => item.significant_improvement).map(item => item.name);
  const significantRegressions = all.filter(item => item.significant_regression).map(item => item.name);

  const productionSourceMix = getSourceMix(before);
  const weightedBefore = weightedCoreValues(before, productionSourceMix);
  const weightedAfter = weightedCoreValues(after, productionSourceMix);
  const weightedCore = {
    success_rate: summarizeWeightedMetric('success_rate', 'up', weightedBefore.success_rate, weightedAfter.success_rate),
    error_rate: summarizeWeightedMetric('error_rate', 'down', weightedBefore.error_rate, weightedAfter.error_rate),
    empty_success_rate: summarizeWeightedMetric('empty_success_rate', 'down', weightedBefore.empty_success_rate, weightedAfter.empty_success_rate),
    tool_success_rate: summarizeWeightedMetric('tool_success_rate', 'up', weightedBefore.tool_success_rate, weightedAfter.tool_success_rate),
    latency_p50_ms: summarizeWeightedMetric('latency_p50_ms', 'down', weightedBefore.latency_p50_ms, weightedAfter.latency_p50_ms),
    latency_p95_ms: summarizeWeightedMetric('latency_p95_ms', 'down', weightedBefore.latency_p95_ms, weightedAfter.latency_p95_ms),
    latency_p99_ms: summarizeWeightedMetric('latency_p99_ms', 'down', weightedBefore.latency_p99_ms, weightedAfter.latency_p99_ms),
    prompt_tokens_per_success: summarizeWeightedMetric('prompt_tokens_per_success', 'down', weightedBefore.prompt_tokens_per_success, weightedAfter.prompt_tokens_per_success),
    completion_tokens_per_success: summarizeWeightedMetric('completion_tokens_per_success', 'down', weightedBefore.completion_tokens_per_success, weightedAfter.completion_tokens_per_success),
    total_tokens_per_success: summarizeWeightedMetric('total_tokens_per_success', 'down', weightedBefore.total_tokens_per_success, weightedAfter.total_tokens_per_success),
  };
  const weightedItems = Object.values(weightedCore);
  const weightedSummary = {
    improvements: weightedItems.filter(item => item.improved).map(item => item.name),
    regressions: weightedItems.filter(item => item.regressed).map(item => item.name),
  };

  return {
    before_label: before?.label || 'before',
    after_label: after?.label || 'after',
    before_snapshot: before,
    after_snapshot: after,
    bootstrap_iterations: bootstrapIterations,
    comparisons: {
      core: {
        success_rate: successRate,
        error_rate: errorRate,
        empty_success_rate: emptySuccessRate,
        tool_success_rate: toolSuccessRate,
        latency_p50_ms: latencyP50,
        latency_p95_ms: latencyP95,
        latency_p99_ms: latencyP99,
        prompt_tokens_per_success: promptTokensPerSuccess,
        completion_tokens_per_success: completionTokensPerSuccess,
        total_tokens_per_success: totalTokensPerSuccess,
      },
      scenarios: scenarioResults,
      production_weighted: {
        source_mix: productionSourceMix,
        core: weightedCore,
        summary: weightedSummary
      }
    },
    summary: {
      significant_improvements: significantImprovements,
      significant_regressions: significantRegressions,
      improved_without_significance: all
        .filter(item => item.improved && !item.significant)
        .map(item => item.name),
      regressed_without_significance: all
        .filter(item => item.regressed && !item.significant)
        .map(item => item.name),
      passed: significantRegressions.length === 0,
    },
  };
}

function pickWeightedOrCoreMetric(comparison, metricName) {
  const weighted = comparison?.comparisons?.production_weighted?.core?.[metricName];
  if (weighted && Number.isFinite(weighted.before) && Number.isFinite(weighted.after)) {
    return { ...weighted, source: 'production_weighted' };
  }
  const core = comparison?.comparisons?.core?.[metricName];
  if (core && Number.isFinite(core.before) && Number.isFinite(core.after)) {
    return { ...core, source: 'core' };
  }
  return null;
}

function safeRatio(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  return after / before;
}

export function evaluateSuperiorityGate(comparison, options = {}) {
  const latencyTolerance = Number.isFinite(options.latencyTolerance)
    ? Number(options.latencyTolerance)
    : 0.05;
  const tokenTolerance = Number.isFinite(options.tokenTolerance)
    ? Number(options.tokenTolerance)
    : 0.05;
  const checks = [];
  const failures = [];
  const epsilon = 1e-9;

  const reliabilityChecks = [
    ['success_rate', 'up'],
    ['error_rate', 'down'],
    ['empty_success_rate', 'down'],
    ['tool_success_rate', 'up']
  ];
  for (const [name, direction] of reliabilityChecks) {
    const metric = pickWeightedOrCoreMetric(comparison, name);
    if (!metric) {
      checks.push({ metric: name, status: 'skipped', reason: 'insufficient_data' });
      continue;
    }
    const before = Number(metric.before);
    const after = Number(metric.after);
    const passed = direction === 'up'
      ? after + epsilon >= before
      : after <= before + epsilon;
    checks.push({
      metric: name,
      source: metric.source,
      direction,
      before,
      after,
      delta: Number((after - before).toFixed(6)),
      passed
    });
    if (!passed) {
      failures.push(`${name} regressed (${before} -> ${after})`);
    }
  }

  const scenarios = Array.isArray(comparison?.comparisons?.scenarios)
    ? comparison.comparisons.scenarios
    : [];
  const requiredScenarioMetrics = new Set([
    'scenario_memory_carryover_pass_rate',
    'scenario_tool_heavy_pass_rate'
  ]);
  for (const metricName of requiredScenarioMetrics) {
    const metric = scenarios.find(item => item?.name === metricName);
    if (!metric || !Number.isFinite(metric.before) || !Number.isFinite(metric.after)) {
      checks.push({ metric: metricName, status: 'skipped', reason: 'insufficient_data' });
      continue;
    }
    const before = Number(metric.before);
    const after = Number(metric.after);
    const passed = after + epsilon >= before;
    checks.push({
      metric: metricName,
      direction: 'up',
      before,
      after,
      delta: Number((after - before).toFixed(6)),
      before_candidates: metric.before_candidates,
      after_candidates: metric.after_candidates,
      passed
    });
    if (!passed) {
      failures.push(`${metricName} regressed (${before} -> ${after})`);
    }
  }

  const latencyMetrics = ['latency_p95_ms', 'latency_p99_ms'];
  for (const metricName of latencyMetrics) {
    const metric = pickWeightedOrCoreMetric(comparison, metricName);
    if (!metric) {
      checks.push({ metric: metricName, status: 'skipped', reason: 'insufficient_data' });
      continue;
    }
    const before = Number(metric.before);
    const after = Number(metric.after);
    const ratio = safeRatio(before, after);
    const maxAllowed = before * (1 + latencyTolerance);
    const passed = Number.isFinite(maxAllowed) ? after <= maxAllowed + epsilon : after <= before + epsilon;
    checks.push({
      metric: metricName,
      source: metric.source,
      before,
      after,
      ratio,
      max_allowed: Number.isFinite(maxAllowed) ? Number(maxAllowed.toFixed(2)) : null,
      tolerance: latencyTolerance,
      passed
    });
    if (!passed) {
      failures.push(`${metricName} above tolerance (${before} -> ${after}, tolerance=${latencyTolerance})`);
    }
  }

  const tokenMetrics = [
    'prompt_tokens_per_success',
    'completion_tokens_per_success',
    'total_tokens_per_success'
  ];
  for (const metricName of tokenMetrics) {
    const metric = pickWeightedOrCoreMetric(comparison, metricName);
    if (!metric) {
      checks.push({ metric: metricName, status: 'skipped', reason: 'insufficient_data' });
      continue;
    }
    const before = Number(metric.before);
    const after = Number(metric.after);
    const ratio = safeRatio(before, after);
    const maxAllowed = before * (1 + tokenTolerance);
    const passed = Number.isFinite(maxAllowed) ? after <= maxAllowed + epsilon : after <= before + epsilon;
    checks.push({
      metric: metricName,
      source: metric.source,
      before,
      after,
      ratio,
      max_allowed: Number.isFinite(maxAllowed) ? Number(maxAllowed.toFixed(2)) : null,
      tolerance: tokenTolerance,
      passed
    });
    if (!passed) {
      failures.push(`${metricName} above tolerance (${before} -> ${after}, tolerance=${tokenTolerance})`);
    }
  }

  return {
    baseline_label: comparison?.before_label || 'baseline',
    candidate_label: comparison?.after_label || 'candidate',
    latency_tolerance: latencyTolerance,
    token_tolerance: tokenTolerance,
    checks,
    failures,
    passed: failures.length === 0
  };
}

function captureSnapshotCommand(args) {
  const label = normalizeLabel(args.label);
  if (!label) {
    throw new Error('--label is required');
  }
  const runDir = resolveRunDir(args);
  const snapshotDir = path.join(runDir, 'snapshots');
  ensureDir(snapshotDir);
  const manifest = loadManifest(runDir);
  const snapshot = buildSnapshot({ ...args, label });
  const snapshotPath = path.join(snapshotDir, `${label}.json`);
  writeJson(snapshotPath, snapshot);
  addSnapshotToManifest(manifest, snapshotPath, snapshot);
  saveManifest(runDir, manifest);

  const output = {
    run_id: args.runId,
    label,
    snapshot_path: snapshotPath,
    records_total: snapshot?.baseline?.records_total ?? 0,
    success_rate: snapshot?.baseline?.success_rate ?? null,
    p95_latency_ms: snapshot?.baseline?.latency_ms?.p95 ?? null,
    release_slo_passed: snapshot?.release_slo?.passed ?? null,
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

function initRunCommand(args) {
  const runDir = resolveRunDir(args);
  ensureDir(path.join(runDir, 'snapshots'));
  const manifest = loadManifest(runDir);
  manifest.created_at = manifest.created_at || new Date().toISOString();
  manifest.run_id = args.runId;
  saveManifest(runDir, manifest);
  return captureSnapshotCommand({ ...args, label: 'overall_start' });
}

function loadComparisonSnapshots(args, beforeRef, afterRef) {
  const runDir = resolveRunDir(args);
  const beforePath = resolveSnapshotPath(runDir, beforeRef);
  const afterPath = resolveSnapshotPath(runDir, afterRef);
  if (!beforePath) throw new Error(`Unable to resolve baseline snapshot: ${beforeRef}`);
  if (!afterPath) throw new Error(`Unable to resolve candidate snapshot: ${afterRef}`);
  const before = readJson(beforePath);
  const after = readJson(afterPath);
  if (!before || !after) {
    throw new Error('Failed to read one or both snapshots');
  }
  return { before, after };
}

function compareSnapshotsCommand(args) {
  const { before, after } = loadComparisonSnapshots(args, args.before, args.after);
  const comparison = evaluateSnapshotComparison(before, after, {
    bootstrapIterations: args.bootstrap,
  });
  const superiorityGate = args.superiorityGate
    ? evaluateSuperiorityGate(comparison, {
      latencyTolerance: args.latencyTolerance,
      tokenTolerance: args.tokenTolerance
    })
    : null;
  const output = superiorityGate
    ? { ...comparison, superiority_gate: superiorityGate }
    : comparison;
  console.log(JSON.stringify(output, null, 2));
  const passed = superiorityGate ? superiorityGate.passed : comparison.summary.passed;
  if (args.enforce && !passed) {
    process.exitCode = 1;
  }
  return output;
}

function headToHeadCommand(args) {
  if (!args.baseline || !args.candidate) {
    throw new Error('--baseline and --candidate are required for headtohead');
  }
  const { before, after } = loadComparisonSnapshots(args, args.baseline, args.candidate);
  const comparison = evaluateSnapshotComparison(before, after, {
    bootstrapIterations: args.bootstrap,
  });
  const superiorityGate = evaluateSuperiorityGate(comparison, {
    latencyTolerance: args.latencyTolerance,
    tokenTolerance: args.tokenTolerance
  });
  const output = {
    mode: 'head_to_head',
    baseline_ref: args.baseline,
    candidate_ref: args.candidate,
    ...comparison,
    superiority_gate: superiorityGate
  };
  console.log(JSON.stringify(output, null, 2));
  if (args.enforce && !superiorityGate.passed) {
    process.exitCode = 1;
  }
  return output;
}

function buildRunComparisons(manifest, runDir, bootstrapIterations) {
  const snapshotsByLabel = new Map();
  for (const entry of manifest.snapshots || []) {
    const file = entry?.file ? path.join(runDir, 'snapshots', entry.file) : null;
    if (!file || !fs.existsSync(file)) continue;
    const snapshot = readJson(file);
    if (!snapshot) continue;
    snapshotsByLabel.set(entry.label, snapshot);
  }

  const labels = Array.from(snapshotsByLabel.keys()).sort();
  const comparisons = [];

  if (snapshotsByLabel.has('overall_start')) {
    const terminal = snapshotsByLabel.get('overall_end')
      || (() => {
        const ordered = manifest.snapshots || [];
        const latest = ordered[ordered.length - 1];
        return latest ? snapshotsByLabel.get(latest.label) : null;
      })();
    if (terminal) {
      comparisons.push({
        kind: 'overall',
        key: 'overall_start->terminal',
        result: evaluateSnapshotComparison(
          snapshotsByLabel.get('overall_start'),
          terminal,
          { bootstrapIterations }
        ),
      });
    }
  }

  const trancheIndices = new Set();
  for (const label of labels) {
    const match = /^tranche(\d+)_before$/.exec(label);
    if (match) trancheIndices.add(Number(match[1]));
  }

  for (const idx of Array.from(trancheIndices).sort((a, b) => a - b)) {
    const beforeLabel = `tranche${idx}_before`;
    const afterLabel = `tranche${idx}_after`;
    const before = snapshotsByLabel.get(beforeLabel);
    const after = snapshotsByLabel.get(afterLabel);
    if (!before || !after) continue;
    comparisons.push({
      kind: 'tranche',
      key: `tranche${idx}`,
      result: evaluateSnapshotComparison(before, after, { bootstrapIterations }),
    });
  }

  return comparisons;
}

function reportCommand(args) {
  const runDir = resolveRunDir(args);
  const manifest = loadManifest(runDir);
  const comparisons = buildRunComparisons(manifest, runDir, args.bootstrap);
  const significantRegressions = comparisons.flatMap(item =>
    item.result.summary.significant_regressions.map(metric => `${item.key}:${metric}`)
  );
  const significantImprovements = comparisons.flatMap(item =>
    item.result.summary.significant_improvements.map(metric => `${item.key}:${metric}`)
  );
  const report = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    run_id: args.runId,
    generated_at: new Date().toISOString(),
    snapshots: manifest.snapshots || [],
    comparisons,
    summary: {
      significant_improvements: significantImprovements,
      significant_regressions: significantRegressions,
      passed: significantRegressions.length === 0,
    },
  };

  const reportsDir = path.join(runDir, 'reports');
  ensureDir(reportsDir);
  const reportPath = path.join(reportsDir, `report-${timestampToken()}.json`);
  writeJson(reportPath, report);

  const output = {
    run_id: args.runId,
    report_path: reportPath,
    comparisons: comparisons.length,
    significant_improvements: significantImprovements.length,
    significant_regressions: significantRegressions.length,
    passed: report.summary.passed,
  };
  console.log(JSON.stringify(output, null, 2));

  if (args.enforce && !report.summary.passed) {
    process.exitCode = 1;
  }
  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    switch (args.command) {
      case 'init':
        initRunCommand(args);
        break;
      case 'capture':
        captureSnapshotCommand(args);
        break;
      case 'compare':
        if (!args.before || !args.after) {
          throw new Error('--before and --after are required for compare');
        }
        compareSnapshotsCommand(args);
        break;
      case 'headtohead':
        headToHeadCommand(args);
        break;
      case 'report':
        reportCommand(args);
        break;
      case 'help':
      default:
        usage();
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[benchmark-harness] ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
