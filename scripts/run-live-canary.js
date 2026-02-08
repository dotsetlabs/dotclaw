#!/usr/bin/env node

import path from 'node:path';

import { DATA_DIR } from '../dist/config.js';
import { initDatabase } from '../dist/db.js';
import { loadJson } from '../dist/utils.js';
import {
  AgentExecutionError,
  createTraceBase,
  executeAgentRun,
  recordAgentTelemetry,
} from '../dist/agent-execution.js';
import { routeRequest } from '../dist/request-router.js';
import { writeTrace } from '../dist/trace-writer.js';
import { percentile } from './benchmark-baseline.js';

function parseArgs(argv) {
  const args = {
    rounds: 8,
    toolAllow: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
    chatJid: '',
    groupFolder: 'main',
    userId: 'canary-live-user',
    userName: 'Canary',
    source: 'live-canary',
    reasoningEffort: 'low',
    maxToolSteps: 40,
    timeoutMs: 180_000,
    promptPrefix: '[CANARY:LIVE]'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--rounds' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.rounds = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--chat-jid' && i + 1 < argv.length) {
      args.chatJid = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--group-folder' && i + 1 < argv.length) {
      args.groupFolder = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--max-tool-steps' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.maxToolSteps = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms' && i + 1 < argv.length) {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) args.timeoutMs = Math.floor(value);
      i += 1;
      continue;
    }
    if (arg === '--reasoning-effort' && i + 1 < argv.length) {
      const value = String(argv[i + 1]).trim().toLowerCase();
      if (value === 'off' || value === 'low' || value === 'medium' || value === 'high') {
        args.reasoningEffort = value;
      }
      i += 1;
      continue;
    }
    if (arg === '--prompt-prefix' && i + 1 < argv.length) {
      args.promptPrefix = String(argv[i + 1] || '').trim() || args.promptPrefix;
      i += 1;
      continue;
    }
    if (arg === '--source' && i + 1 < argv.length) {
      args.source = String(argv[i + 1] || '').trim() || args.source;
      i += 1;
      continue;
    }
    if (arg === '--tool-allow' && i + 1 < argv.length) {
      const tools = String(argv[i + 1] || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (tools.length > 0) args.toolAllow = tools;
      i += 1;
    }
  }

  return args;
}

function loadRegisteredGroups() {
  const filePath = path.join(DATA_DIR, 'registered_groups.json');
  return loadJson(filePath, {});
}

function resolveChatAndGroup(args) {
  const groups = loadRegisteredGroups();
  const entries = Object.entries(groups);
  if (!entries.length) {
    throw new Error(`No registered groups found in ${path.join(DATA_DIR, 'registered_groups.json')}`);
  }

  if (args.chatJid) {
    const group = groups[args.chatJid];
    if (!group || typeof group !== 'object') {
      throw new Error(`Chat not registered: ${args.chatJid}`);
    }
    return { chatJid: args.chatJid, group };
  }

  const matching = entries.find(([, group]) => group?.folder === args.groupFolder);
  if (matching) return { chatJid: matching[0], group: matching[1] };
  return { chatJid: entries[0][0], group: entries[0][1] };
}

function buildRoundPrompts(prefix, round, stamp) {
  const canaryFile = `inbox/live-canary-${stamp}-r${String(round).padStart(2, '0')}.txt`;
  return [
    `${prefix} [SCENARIO:tool_heavy] Round ${round}: Create file "${canaryFile}" with 3 lines: alpha-${round}, beta-${round}, gamma-${round}. Then read it back and return a 1-sentence summary with exact filename.`,
    `${prefix} [SCENARIO:memory] Round ${round}: From this same conversation session, what exact filename did you just create and what was line 2? Answer in one concise sentence.`,
    `${prefix} [SCENARIO:tool_heavy] Round ${round}: List the 5 newest files under inbox/, read the newest one, and return exactly 2 bullet points with key details.`,
  ];
}

function summarizeResults(executions) {
  const rows = executions.length;
  const successRows = executions.filter((item) => item.output?.status === 'success');
  const errorRows = executions.filter((item) => item.output?.status === 'error' || item.error);
  const emptySuccess = successRows.filter((item) => {
    const text = typeof item.output?.result === 'string' ? item.output.result.trim() : '';
    return !text;
  }).length;
  const latencies = successRows
    .map((item) => Number(item.output?.latency_ms))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const toolCalls = successRows.flatMap((item) => Array.isArray(item.output?.tool_calls) ? item.output.tool_calls : []);
  const failedToolCalls = toolCalls.filter((call) => !call?.ok).length;
  const errorCounts = new Map();
  for (const item of errorRows) {
    const key = String(item.error || item.output?.error || 'unknown error').trim() || 'unknown error';
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
  }
  const topErrors = Array.from(errorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([error, count]) => ({ error, count }));

  const memoryCandidates = executions.filter((item) => /\[(?:scenario:)?memory(?:_carryover)?\]/i.test(item.prompt));
  const memoryPassed = memoryCandidates.filter((item) => {
    const text = typeof item.output?.result === 'string' ? item.output.result.trim() : '';
    return item.output?.status === 'success' && text.length > 0;
  }).length;
  const toolHeavyCandidates = executions.filter((item) => /\[(?:scenario:)?tool_heavy\]/i.test(item.prompt));
  const toolHeavyPassed = toolHeavyCandidates.filter((item) => {
    if (item.output?.status !== 'success') return false;
    const calls = Array.isArray(item.output?.tool_calls) ? item.output.tool_calls : [];
    if (calls.length < 2) return false;
    const failed = calls.filter((call) => !call?.ok).length;
    return failed <= Math.floor(calls.length * 0.2);
  }).length;

  return {
    rows_total: rows,
    rows_success: successRows.length,
    rows_error: errorRows.length,
    success_rate: rows > 0 ? Number((successRows.length / rows).toFixed(4)) : null,
    empty_success_rate: successRows.length > 0 ? Number((emptySuccess / successRows.length).toFixed(4)) : null,
    latency_ms: {
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
    tool_calls: {
      total: toolCalls.length,
      failed: failedToolCalls,
      success_rate: toolCalls.length > 0
        ? Number(((toolCalls.length - failedToolCalls) / toolCalls.length).toFixed(4))
        : null,
    },
    top_errors: topErrors,
    scenarios: {
      memory_carryover: {
        candidates: memoryCandidates.length,
        passed: memoryPassed,
        pass_rate: memoryCandidates.length > 0 ? Number((memoryPassed / memoryCandidates.length).toFixed(4)) : null,
      },
      tool_heavy: {
        candidates: toolHeavyCandidates.length,
        passed: toolHeavyPassed,
        pass_rate: toolHeavyCandidates.length > 0 ? Number((toolHeavyPassed / toolHeavyCandidates.length).toFixed(4)) : null,
      }
    }
  };
}

async function runOne(params) {
  const traceBase = createTraceBase({
    chatId: params.chatJid,
    groupFolder: params.group.folder,
    userId: params.userId,
    inputText: params.prompt,
    source: params.source
  });

  let output = null;
  let context = null;
  let errorMessage = null;

  try {
    const execution = await executeAgentRun({
      group: params.group,
      prompt: params.prompt,
      chatJid: params.chatJid,
      userId: params.userId,
      userName: params.userName,
      recallQuery: params.prompt,
      recallMaxResults: params.routing.recallMaxResults,
      recallMaxTokens: params.routing.recallMaxTokens,
      sessionId: params.sessionId,
      persistSession: true,
      useGroupLock: true,
      useSemaphore: true,
      modelFallbacks: params.routing.fallbacks,
      reasoningEffort: params.reasoningEffort,
      modelMaxOutputTokens: params.routing.maxOutputTokens || undefined,
      maxToolSteps: params.maxToolSteps,
      lane: 'maintenance',
      toolAllow: params.toolAllow,
      timeoutMs: params.timeoutMs
    });
    output = execution.output;
    context = execution.context;
    if (output.status === 'error') {
      errorMessage = output.error || 'Unknown error';
    }
    return {
      output,
      context,
      errorMessage,
      nextSessionId: output?.newSessionId || params.sessionId
    };
  } catch (err) {
    if (err instanceof AgentExecutionError) {
      context = err.context;
      errorMessage = err.message;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    return {
      output,
      context,
      errorMessage,
      nextSessionId: params.sessionId
    };
  } finally {
    if (context) {
      recordAgentTelemetry({
        traceBase,
        output,
        context,
        metricsSource: 'live_canary',
        toolAuditSource: 'heartbeat',
        errorMessage: errorMessage || undefined
      });
    } else {
      writeTrace({
        ...traceBase,
        output_text: output?.result ?? null,
        model_id: output?.model || 'unknown',
        memory_recall: [],
        error_code: errorMessage || undefined,
        source: params.source
      });
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  initDatabase();
  const resolved = resolveChatAndGroup(args);
  const routing = routeRequest();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const executions = [];
  let sessionId;

  for (let round = 1; round <= args.rounds; round += 1) {
    const prompts = buildRoundPrompts(args.promptPrefix, round, stamp);
    for (const prompt of prompts) {
      const result = await runOne({
        chatJid: resolved.chatJid,
        group: resolved.group,
        prompt,
        userId: args.userId,
        userName: args.userName,
        source: args.source,
        routing,
        sessionId,
        reasoningEffort: args.reasoningEffort,
        maxToolSteps: args.maxToolSteps,
        timeoutMs: args.timeoutMs,
        toolAllow: args.toolAllow
      });
      sessionId = result.nextSessionId;
      executions.push({
        round,
        prompt,
        output: result.output,
        error: result.errorMessage
      });
    }
  }

  const summary = summarizeResults(executions);
  const output = {
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    chat_jid: resolved.chatJid,
    group_folder: resolved.group.folder,
    source: args.source,
    rounds: args.rounds,
    prompts_executed: executions.length,
    model: routing.model,
    fallbacks: routing.fallbacks,
    metrics: summary
  };
  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
