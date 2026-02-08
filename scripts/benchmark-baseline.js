#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    days: 7,
    dir: '',
    since: '',
    until: '',
    source: '',
    excludeSource: '',
    chatId: ''
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
    if (arg === '--since' && i + 1 < argv.length) {
      args.since = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--until' && i + 1 < argv.length) {
      args.until = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--source' && i + 1 < argv.length) {
      args.source = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--exclude-source' && i + 1 < argv.length) {
      args.excludeSource = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--chat-id' && i + 1 < argv.length) {
      args.chatId = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function normalizeSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return source || 'unknown';
}

function deriveSource(row) {
  const source = normalizeSource(row?.source);
  const inputText = String(row?.input_text || '');
  // Historical canary rows could be mislabeled as "dotclaw". Reclassify by prompt marker
  // so production-weighted SLOs are not skewed by benchmark traffic.
  if ((source === 'dotclaw' || source === 'unknown') && /^\s*\[CANARY(?::|])/i.test(inputText)) {
    return 'live-canary';
  }
  return source;
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

export function loadTraces(traceDir, filtersOrSinceMs) {
  const legacySince = Number.isFinite(filtersOrSinceMs)
    ? Number(filtersOrSinceMs)
    : null;
  const filters = (!legacySince && filtersOrSinceMs && typeof filtersOrSinceMs === 'object')
    ? filtersOrSinceMs
    : {};
  const sinceMs = legacySince ?? Number(filters.sinceMs || 0);
  const untilMs = Number.isFinite(filters.untilMs) ? Number(filters.untilMs) : Infinity;
  const includeSources = filters.includeSources instanceof Set ? filters.includeSources : null;
  const excludeSources = filters.excludeSources instanceof Set ? filters.excludeSources : null;
  const includeChats = filters.includeChats instanceof Set ? filters.includeChats : null;

  if (!fs.existsSync(traceDir)) return [];
  const files = fs.readdirSync(traceDir)
    .filter(name => /^trace-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort();

  const rows = [];
  for (const fileName of files) {
    const filePath = path.join(traceDir, fileName);
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parsed = safeJsonParse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      const ts = Date.parse(String(parsed.timestamp || ''));
      if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
      const source = deriveSource(parsed);
      if (includeSources && !includeSources.has(source)) continue;
      if (excludeSources && excludeSources.has(source)) continue;
      if (includeChats) {
        const chatId = String(parsed.chat_id || '').trim();
        if (!includeChats.has(chatId)) continue;
      }
      rows.push({
        ...parsed,
        source
      });
    }
  }
  return rows;
}

function topEntries(map, limit = 10) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export function buildReport(records, traceDir, days) {
  const total = records.length;
  const errorRecords = records.filter(r => typeof r.error_code === 'string' && r.error_code.trim());
  const successRecords = total - errorRecords.length;
  const emptySuccess = records.filter(r => {
    if (typeof r.error_code === 'string' && r.error_code.trim()) return false;
    const text = typeof r.output_text === 'string' ? r.output_text : '';
    return !text.trim();
  }).length;

  const latencyMs = records
    .map(r => Number(r.latency_ms))
    .filter(v => Number.isFinite(v) && v >= 0);

  const promptTokens = records
    .map(r => Number(r.tokens_prompt))
    .filter(v => Number.isFinite(v) && v >= 0);
  const completionTokens = records
    .map(r => Number(r.tokens_completion))
    .filter(v => Number.isFinite(v) && v >= 0);

  const toolCalls = records.flatMap(r => Array.isArray(r.tool_calls) ? r.tool_calls : []);
  const toolFailures = toolCalls.filter(call => !call?.ok);
  const failoverAttempts = records
    .map(r => Number(r.host_failover_attempts))
    .filter(v => Number.isFinite(v) && v > 1).length;
  const failoverRecovered = records
    .filter(r => r.host_failover_recovered === true).length;

  const errorCounts = new Map();
  for (const row of errorRecords) {
    const key = String(row.error_code || 'unknown');
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
  }

  const modelCounts = new Map();
  for (const row of records) {
    const modelId = String(row.model_id || 'unknown');
    modelCounts.set(modelId, (modelCounts.get(modelId) || 0) + 1);
  }

  const sourceStats = new Map();
  for (const row of records) {
    const source = normalizeSource(row.source);
    if (!sourceStats.has(source)) {
      sourceStats.set(source, {
        records: 0,
        errors: 0,
        emptySuccess: 0,
        toolTotal: 0,
        toolFailed: 0,
        latencies: [],
        promptTokens: 0,
        completionTokens: 0
      });
    }
    const bucket = sourceStats.get(source);
    bucket.records += 1;
    const hasError = typeof row.error_code === 'string' && row.error_code.trim();
    if (hasError) {
      bucket.errors += 1;
    } else {
      const outputText = typeof row.output_text === 'string' ? row.output_text : '';
      if (!outputText.trim()) bucket.emptySuccess += 1;
    }
    const tools = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    bucket.toolTotal += tools.length;
    bucket.toolFailed += tools.filter(call => !call?.ok).length;
    const latency = Number(row.latency_ms);
    if (Number.isFinite(latency) && latency >= 0) {
      bucket.latencies.push(latency);
    }
    const prompt = Number(row.tokens_prompt);
    if (Number.isFinite(prompt) && prompt >= 0) {
      bucket.promptTokens += prompt;
    }
    const completion = Number(row.tokens_completion);
    if (Number.isFinite(completion) && completion >= 0) {
      bucket.completionTokens += completion;
    }
  }

  const recordsBySource = Array.from(sourceStats.entries())
    .map(([source, bucket]) => {
      const success = Math.max(0, bucket.records - bucket.errors);
      const totalTokens = bucket.promptTokens + bucket.completionTokens;
      return {
        source,
        records: bucket.records,
        success,
        errors: bucket.errors,
        success_rate: bucket.records > 0 ? Number((success / bucket.records).toFixed(4)) : null,
        empty_success: bucket.emptySuccess,
        empty_success_rate: success > 0 ? Number((bucket.emptySuccess / success).toFixed(4)) : null,
        tool_calls_total: bucket.toolTotal,
        tool_calls_failed: bucket.toolFailed,
        tool_success_rate: bucket.toolTotal > 0
          ? Number(((bucket.toolTotal - bucket.toolFailed) / bucket.toolTotal).toFixed(4))
          : null,
        token_usage: {
          prompt_total: bucket.promptTokens,
          completion_total: bucket.completionTokens,
          total: totalTokens,
          prompt_per_success: success > 0 ? Number((bucket.promptTokens / success).toFixed(2)) : null,
          completion_per_success: success > 0 ? Number((bucket.completionTokens / success).toFixed(2)) : null,
          total_per_success: success > 0 ? Number((totalTokens / success).toFixed(2)) : null
        },
        latency_ms: {
          p50: percentile(bucket.latencies, 50),
          p95: percentile(bucket.latencies, 95),
          p99: percentile(bucket.latencies, 99)
        }
      };
    })
    .sort((a, b) => b.records - a.records);

  return {
    window_days: days,
    trace_dir: traceDir,
    records_total: total,
    records_success: successRecords,
    records_error: errorRecords.length,
    success_rate: total > 0 ? Number((successRecords / total).toFixed(4)) : null,
    empty_success_responses: emptySuccess,
    latency_ms: {
      p50: percentile(latencyMs, 50),
      p90: percentile(latencyMs, 90),
      p95: percentile(latencyMs, 95),
      p99: percentile(latencyMs, 99),
    },
    token_usage: {
      prompt_total: promptTokens.reduce((a, b) => a + b, 0),
      completion_total: completionTokens.reduce((a, b) => a + b, 0),
      prompt_p50: percentile(promptTokens, 50),
      completion_p50: percentile(completionTokens, 50),
    },
    tool_calls: {
      total: toolCalls.length,
      failed: toolFailures.length,
      success_rate: toolCalls.length > 0
        ? Number(((toolCalls.length - toolFailures.length) / toolCalls.length).toFixed(4))
        : null,
    },
    host_failover: {
      attempted_runs: failoverAttempts,
      recovered_runs: failoverRecovered,
      recovery_rate: failoverAttempts > 0
        ? Number((failoverRecovered / failoverAttempts).toFixed(4))
        : null
    },
    records_by_source: recordsBySource,
    top_models: topEntries(modelCounts, 8),
    top_errors: topEntries(errorCounts, 12),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotclawHome = process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
  const traceDir = args.dir || path.join(dotclawHome, 'traces');
  const sinceMs = resolveTimestamp(args.since, Date.now() - (args.days * 24 * 60 * 60 * 1000));
  const untilMs = resolveTimestamp(args.until, Infinity);
  const includeSources = parseCsvSet(args.source);
  const excludeSources = parseCsvSet(args.excludeSource);
  const includeChats = parseCsvSet(args.chatId, { lower: false });
  const records = loadTraces(traceDir, {
    sinceMs,
    untilMs,
    includeSources,
    excludeSources,
    includeChats
  });
  const report = buildReport(records, traceDir, args.days);
  report.window = {
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : null,
    until: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null
  };
  if (includeSources) {
    report.filters = {
      source: Array.from(includeSources.values())
    };
  }
  if (excludeSources) {
    report.filters = {
      ...(report.filters || {}),
      exclude_source: Array.from(excludeSources.values())
    };
  }
  if (includeChats) {
    report.filters = {
      ...(report.filters || {}),
      chat_id: Array.from(includeChats.values())
    };
  }
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
