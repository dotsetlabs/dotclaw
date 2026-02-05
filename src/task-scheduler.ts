import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, updateTask, updateTaskRunStatsOnly } from './db.js';
import { recordTaskRun, recordError, recordMessage, recordRoutingDecision, recordStageLatency } from './metrics.js';
import { ScheduledTask, RegisteredGroup } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { routePrompt } from './request-router.js';
import { writeTrace } from './trace-writer.js';
import type { AgentContext } from './agent-context.js';
import type { ContainerOutput } from './container-protocol.js';
import { logger } from './logger.js';

const runtime = loadRuntimeConfig();

const TASK_MAX_RETRIES = runtime.host.scheduler.taskMaxRetries;
const TASK_RETRY_BASE_MS = runtime.host.scheduler.taskRetryBaseMs;
const TASK_RETRY_MAX_MS = runtime.host.scheduler.taskRetryMaxMs;

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
    recordError('scheduler');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`
    });
    recordTaskRun('error');
    return;
  }

  let result: string | null = null;
  let error: string | null = null;
  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;

  const sessions = deps.getSessions();
  const sessionId = task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  const stateBlock = task.state_json ? `[TASK STATE]
${task.state_json}
` : '';
  const taskPrompt = stateBlock ? `${stateBlock}
${task.prompt}` : task.prompt;

  const traceBase = createTraceBase({
    chatId: task.chat_jid,
    groupFolder: task.group_folder,
    userId: null,
    inputText: task.prompt,
    source: 'dotclaw-scheduler'
  });
  const routingStartedAt = Date.now();
  const routingDecision = routePrompt(taskPrompt);
  recordRoutingDecision(routingDecision.profile);
  const routerMs = Date.now() - routingStartedAt;
  recordStageLatency('router', routerMs, 'scheduler');

  try {
    const recallMaxResults = routingDecision.enableMemoryRecall
      ? (Number.isFinite(routingDecision.recallMaxResults)
        ? Math.max(0, Math.floor(routingDecision.recallMaxResults as number))
        : runtime.host.memory.recall.maxResults)
      : 0;
    const recallMaxTokens = routingDecision.enableMemoryRecall
      ? (Number.isFinite(routingDecision.recallMaxTokens)
        ? Math.max(0, Math.floor(routingDecision.recallMaxTokens as number))
        : runtime.host.memory.recall.maxTokens)
      : 0;
    const execution = await executeAgentRun({
      group,
      prompt: taskPrompt,
      chatJid: task.chat_jid,
      userId: null,
      recallQuery: task.prompt,
      recallMaxResults,
      recallMaxTokens,
      sessionId,
      persistSession: task.context_mode === 'group',
      onSessionUpdate: (sessionId) => deps.setSession(task.group_folder, sessionId),
      isScheduledTask: true,
      taskId: task.id,
      useGroupLock: false,
      modelOverride: routingDecision.modelOverride,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      disablePlanner: !routingDecision.enablePlanner,
      disableResponseValidation: !routingDecision.enableResponseValidation,
      responseValidationMaxRetries: routingDecision.responseValidationMaxRetries,
      disableMemoryExtraction: !routingDecision.enableMemoryExtraction
    });
    output = execution.output;
    context = execution.context;

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else {
      result = output.result;
    }
  } catch (err) {
    if (err instanceof AgentExecutionError) {
      context = err.context;
      error = err.message;
    } else {
      error = err instanceof Error ? err.message : String(err);
    }
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      metricsSource: 'scheduler',
      toolAuditSource: 'scheduler',
      errorMessage: error ?? undefined,
      errorType: error ? 'scheduler' : undefined,
      extraTimings: { router_ms: routerMs }
    });
  } else if (error) {
    recordError('scheduler');
    writeTrace({
      trace_id: traceBase.trace_id,
      timestamp: traceBase.timestamp,
      created_at: traceBase.created_at,
      chat_id: traceBase.chat_id,
      group_folder: traceBase.group_folder,
      input_text: traceBase.input_text,
      output_text: null,
      model_id: 'unknown',
      memory_recall: [],
      error_code: error,
      source: traceBase.source
    });
  }

  if (!error) {
    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
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

export async function runTaskNow(taskId: string, deps: SchedulerDependencies): Promise<{ ok: boolean; result?: string | null; error?: string }> {
  const task = getTaskById(taskId);
  if (!task) {
    return { ok: false, error: 'Task not found' };
  }

  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running task immediately');
  recordMessage('scheduler');

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === task.group_folder);
  if (!group) {
    const error = `Group not found: ${task.group_folder}`;
    logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
    recordError('scheduler');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error
    });
    recordTaskRun('error');
    updateTaskRunStatsOnly(task.id, `Error: ${error}`, error);
    return { ok: false, error };
  }

  let result: string | null = null;
  let error: string | null = null;
  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;

  const sessions = deps.getSessions();
  const sessionId = task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  const stateBlock = task.state_json ? `[TASK STATE]\n${task.state_json}\n` : '';
  const taskPrompt = stateBlock ? `${stateBlock}\n${task.prompt}` : task.prompt;

  const traceBase = createTraceBase({
    chatId: task.chat_jid,
    groupFolder: task.group_folder,
    userId: null,
    inputText: task.prompt,
    source: 'dotclaw-manual-task'
  });
  const routingStartedAt = Date.now();
  const routingDecision = routePrompt(taskPrompt);
  recordRoutingDecision(routingDecision.profile);
  const routerMs = Date.now() - routingStartedAt;
  recordStageLatency('router', routerMs, 'scheduler');

  try {
    const recallMaxResults = routingDecision.enableMemoryRecall
      ? (Number.isFinite(routingDecision.recallMaxResults)
        ? Math.max(0, Math.floor(routingDecision.recallMaxResults as number))
        : runtime.host.memory.recall.maxResults)
      : 0;
    const recallMaxTokens = routingDecision.enableMemoryRecall
      ? (Number.isFinite(routingDecision.recallMaxTokens)
        ? Math.max(0, Math.floor(routingDecision.recallMaxTokens as number))
        : runtime.host.memory.recall.maxTokens)
      : 0;
    const execution = await executeAgentRun({
      group,
      prompt: taskPrompt,
      chatJid: task.chat_jid,
      userId: null,
      recallQuery: task.prompt,
      recallMaxResults,
      recallMaxTokens,
      sessionId,
      persistSession: task.context_mode === 'group',
      onSessionUpdate: (sessionId) => deps.setSession(task.group_folder, sessionId),
      isScheduledTask: true,
      taskId: task.id,
      modelOverride: routingDecision.modelOverride,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      disablePlanner: !routingDecision.enablePlanner,
      disableResponseValidation: !routingDecision.enableResponseValidation,
      responseValidationMaxRetries: routingDecision.responseValidationMaxRetries,
      disableMemoryExtraction: !routingDecision.enableMemoryExtraction
    });
    output = execution.output;
    context = execution.context;

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else {
      result = output.result;
    }
  } catch (err) {
    if (err instanceof AgentExecutionError) {
      context = err.context;
      error = err.message;
    } else {
      error = err instanceof Error ? err.message : String(err);
    }
    logger.error({ taskId: task.id, error }, 'Immediate task run failed');
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      metricsSource: 'scheduler',
      toolAuditSource: 'scheduler',
      errorMessage: error ?? undefined,
      errorType: error ? 'scheduler' : undefined,
      extraTimings: { router_ms: routerMs }
    });
  } else if (error) {
    recordError('scheduler');
    writeTrace({
      trace_id: traceBase.trace_id,
      timestamp: traceBase.timestamp,
      created_at: traceBase.created_at,
      chat_id: traceBase.chat_id,
      group_folder: traceBase.group_folder,
      input_text: traceBase.input_text,
      output_text: null,
      model_id: 'unknown',
      memory_recall: [],
      error_code: error,
      source: traceBase.source
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

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskRunStatsOnly(task.id, resultSummary, error);

  return { ok: !error, result, error: error ?? undefined };
}


let schedulerStopped = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  schedulerStopped = false;
  logger.info('Scheduler loop started');

  const loop = async () => {
    if (schedulerStopped) return;
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

    if (!schedulerStopped) {
      setTimeout(loop, SCHEDULER_POLL_INTERVAL);
    }
  };

  loop();
}

export function stopSchedulerLoop(): void {
  schedulerStopped = true;
}
