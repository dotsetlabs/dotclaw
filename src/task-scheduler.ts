import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, getAllTasks, updateTask, setGroupSession, logToolCalls, getToolReliability } from './db.js';
import { ScheduledTask, RegisteredGroup } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { writeTrace } from './trace-writer.js';
import { withGroupLock } from './locks.js';
import { getMemoryStats } from './memory-store.js';
import { buildHybridMemoryRecall } from './memory-recall.js';
import { loadPersonalizedBehaviorConfig } from './personalization.js';
import { getEffectiveToolPolicy } from './tool-policy.js';
import { applyToolBudgets } from './tool-budgets.js';
import { resolveModel, loadModelRegistry, getTokenEstimateConfig, getModelPricing } from './model-registry.js';
import { recordTaskRun, recordToolCall, recordLatency, recordError, recordMessage, recordTokenUsage, recordCost, recordMemoryRecall, recordMemoryUpsert, recordMemoryExtract } from './metrics.js';
import { computeCostUSD } from './cost.js';
import { runWithAgentSemaphore } from './agent-semaphore.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const TASK_MAX_RETRIES = parsePositiveInt(process.env.DOTCLAW_TASK_MAX_RETRIES, 3);
const TASK_RETRY_BASE_MS = parsePositiveInt(process.env.DOTCLAW_TASK_RETRY_BASE_MS, 60000);
const TASK_RETRY_MAX_MS = parsePositiveInt(process.env.DOTCLAW_TASK_RETRY_MAX_MS, 3600000);

export interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSession: (groupFolder: string, sessionId: string) => void;
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');
  recordMessage('scheduler');

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === task.group_folder);

  if (!group) {
    logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(task.group_folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
    state_json: t.state_json ?? null,
    retry_count: t.retry_count ?? 0,
    last_error: t.last_error ?? null
  })));

  let result: string | null = null;
  let error: string | null = null;
  let memoryRecall: string[] = [];

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId = task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const traceTimestamp = new Date().toISOString();

  try {
    memoryRecall = await buildHybridMemoryRecall({
      groupFolder: task.group_folder,
      userId: null,
      query: task.prompt,
      maxResults: 6,
      maxTokens: 800
    });
    const memoryStats = getMemoryStats({ groupFolder: task.group_folder, userId: null });
    const behaviorConfig = loadPersonalizedBehaviorConfig({
      groupFolder: group.folder,
      userId: null
    });
    const baseToolPolicy = getEffectiveToolPolicy({ groupFolder: task.group_folder, userId: null });
    const toolPolicy = applyToolBudgets({
      groupFolder: task.group_folder,
      userId: null,
      toolPolicy: baseToolPolicy
    });
    const toolReliability = getToolReliability({ groupFolder: task.group_folder, limit: 200 })
      .map(row => ({
        name: row.tool_name,
        success_rate: row.total > 0 ? row.ok_count / row.total : 0,
        count: row.total,
        avg_duration_ms: row.avg_duration_ms
      }));
    const defaultModel = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
    const modelRegistry = loadModelRegistry(defaultModel);
    const resolvedModel = resolveModel({
      groupFolder: task.group_folder,
      userId: null,
      defaultModel
    });
    const tokenEstimate = getTokenEstimateConfig(resolvedModel.override);

    const stateBlock = task.state_json ? `[TASK STATE]\n${task.state_json}\n` : '';
    const taskPrompt = stateBlock ? `${stateBlock}\n${task.prompt}` : task.prompt;

    const output = await runWithAgentSemaphore(() =>
      withGroupLock(task.group_folder, () =>
        runContainerAgent(group, {
          prompt: taskPrompt,
          sessionId,
          groupFolder: task.group_folder,
          chatJid: task.chat_jid,
          isMain,
          isScheduledTask: true,
          taskId: task.id,
          memoryRecall,
          userProfile: null,
          memoryStats,
          tokenEstimate,
          toolReliability,
          behaviorConfig: behaviorConfig as unknown as Record<string, unknown>,
          toolPolicy: toolPolicy as Record<string, unknown>,
          modelOverride: resolvedModel.model,
          modelContextTokens: resolvedModel.override?.context_window,
          modelMaxOutputTokens: resolvedModel.override?.max_output_tokens,
          modelTemperature: resolvedModel.override?.temperature
        })
      )
    );

    if (output.newSessionId && task.context_mode === 'group') {
      deps.setSession(task.group_folder, output.newSessionId);
      setGroupSession(task.group_folder, output.newSessionId);
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
      recordError('scheduler');
    } else {
      result = output.result;
    }

    if (output.latency_ms) {
      recordLatency(output.latency_ms);
    }

    const tracePricing = getModelPricing(modelRegistry, output.model || resolvedModel.model);
    const traceCost = computeCostUSD(output.tokens_prompt, output.tokens_completion, tracePricing);

    writeTrace({
      trace_id: traceId,
      timestamp: traceTimestamp,
      created_at: Date.now(),
      chat_id: task.chat_jid,
      group_folder: task.group_folder,
      input_text: task.prompt,
      output_text: output.result ?? null,
      model_id: output.model || 'unknown',
      prompt_pack_versions: output.prompt_pack_versions,
      memory_summary: output.memory_summary,
      memory_facts: output.memory_facts,
      memory_recall: memoryRecall,
      tool_calls: output.tool_calls,
      latency_ms: output.latency_ms,
      tokens_prompt: output.tokens_prompt,
      tokens_completion: output.tokens_completion,
      cost_prompt_usd: traceCost?.prompt,
      cost_completion_usd: traceCost?.completion,
      cost_total_usd: traceCost?.total,
      memory_recall_count: output.memory_recall_count,
      session_recall_count: output.session_recall_count,
      memory_items_upserted: output.memory_items_upserted,
      memory_items_extracted: output.memory_items_extracted,
      error_code: output.status === 'error' ? output.error : undefined,
      source: 'dotclaw-scheduler'
    });

    if (output.tool_calls && output.tool_calls.length > 0) {
      logToolCalls({
        traceId,
        chatJid: task.chat_jid,
        groupFolder: task.group_folder,
        userId: null,
        toolCalls: output.tool_calls,
        source: 'scheduler'
      });
      for (const call of output.tool_calls) {
        recordToolCall(call.name, call.ok);
      }
    }

    if (Number.isFinite(output.tokens_prompt) || Number.isFinite(output.tokens_completion)) {
      recordTokenUsage(output.model || resolvedModel.model, 'scheduler', output.tokens_prompt || 0, output.tokens_completion || 0);
      if (traceCost) {
        recordCost(output.model || resolvedModel.model, 'scheduler', traceCost.total);
      }
    }
    if (Number.isFinite(output.memory_recall_count)) {
      recordMemoryRecall('scheduler', output.memory_recall_count || 0);
    }
    if (Number.isFinite(output.memory_items_upserted)) {
      recordMemoryUpsert('scheduler', output.memory_items_upserted || 0);
    }
    if (Number.isFinite(output.memory_items_extracted)) {
      recordMemoryExtract('scheduler', output.memory_items_extracted || 0);
    }

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
    recordError('scheduler');

    writeTrace({
      trace_id: traceId,
      timestamp: traceTimestamp,
      created_at: Date.now(),
      chat_id: task.chat_jid,
      group_folder: task.group_folder,
      input_text: task.prompt,
      output_text: null,
      model_id: 'unknown',
      memory_recall: memoryRecall,
      error_code: error,
      source: 'dotclaw-scheduler'
    });
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error
  });
  recordTaskRun(error ? 'error' : 'success');

  let scheduleNextRun: string | null = null;
  let scheduleError: string | null = null;
  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
      scheduleNextRun = interval.next().toISOString();
    } catch (err) {
      scheduleError = `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      scheduleError = `Invalid interval: "${task.schedule_value}"`;
    } else {
      scheduleNextRun = new Date(Date.now() + ms).toISOString();
    }
  }
  // 'once' tasks have no next run

  if (scheduleError) {
    error = error ? `${error}; ${scheduleError}` : scheduleError;
  }

  let nextRun = scheduleNextRun;
  let retryCount = typeof task.retry_count === 'number' ? task.retry_count : 0;
  if (error) {
    if (retryCount < TASK_MAX_RETRIES) {
      retryCount += 1;
      const backoff = Math.min(TASK_RETRY_MAX_MS, TASK_RETRY_BASE_MS * Math.pow(2, retryCount - 1));
      nextRun = new Date(Date.now() + backoff).toISOString();
    }
  } else {
    retryCount = 0;
  }

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary, error, retryCount);

  if (scheduleError) {
    updateTask(task.id, { status: 'paused', next_run: null });
  }
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        await runTask(currentTask, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
