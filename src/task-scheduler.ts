import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { claimDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, updateTask, updateTaskRunStatsOnly } from './db.js';
import { recordTaskRun, recordError, recordMessage } from './metrics.js';
import { ScheduledTask, RegisteredGroup } from './types.js';
import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { routeRequest } from './request-router.js';
import { writeTrace } from './trace-writer.js';
import type { AgentContext } from './agent-context.js';
import type { ContainerOutput } from './container-protocol.js';
import { logger } from './logger.js';
import { emitHook } from './hooks.js';
import { humanizeError } from './error-messages.js';

const runtime = loadRuntimeConfig();

const TASK_MAX_RETRIES = runtime.host.scheduler.taskMaxRetries;
const TASK_RETRY_BASE_MS = runtime.host.scheduler.taskRetryBaseMs;
const TASK_RETRY_MAX_MS = runtime.host.scheduler.taskRetryMaxMs;
const TASK_TIMEOUT_MS = runtime.host.scheduler.taskTimeoutMs;
const TASK_NOTIFY_RETRIES = 3;
const TASK_NOTIFY_RETRY_BASE_MS = 2_000;
const TASK_NOTIFY_RETRY_MAX_MS = 30_000;

function computeNotificationRetryDelayMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  const base = Math.min(TASK_NOTIFY_RETRY_MAX_MS, TASK_NOTIFY_RETRY_BASE_MS * Math.pow(2, exp));
  const jitter = base * (0.8 + Math.random() * 0.4);
  return Math.max(500, Math.round(jitter));
}

async function sendTaskNotification(task: ScheduledTask, message: string, deps: SchedulerDependencies): Promise<void> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= TASK_NOTIFY_RETRIES; attempt += 1) {
    try {
      await deps.sendMessage(task.chat_jid, message);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt >= TASK_NOTIFY_RETRIES) break;
      const delayMs = computeNotificationRetryDelayMs(attempt);
      logger.warn({ taskId: task.id, attempt, delayMs, error: lastError }, 'Scheduled task notification failed; retrying');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(lastError || 'Unknown scheduled task notification error');
}

function summarizeTaskText(value: string | null | undefined, maxChars: number): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[Truncated for length]`;
}

function formatRelativeNextRun(isoTimestamp: string | null): string | null {
  if (!isoTimestamp) return null;
  try {
    const nextDate = new Date(isoTimestamp);
    const nowMs = Date.now();
    const diffMs = nextDate.getTime() - nowMs;
    if (diffMs < 0) return null;
    const diffMinutes = Math.round(diffMs / 60_000);
    if (diffMinutes < 2) return 'in about a minute';
    if (diffMinutes < 60) return `in about ${diffMinutes} minutes`;
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours === 1) return 'in about an hour';
    if (diffHours < 24) return `in about ${diffHours} hours`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays === 1) return 'tomorrow';
    return `in ${diffDays} days`;
  } catch {
    return null;
  }
}

function buildTaskNotificationMessage(params: {
  task: ScheduledTask;
  result: string | null;
  error: string | null;
  durationMs: number;
  nextRun: string | null;
  timezone: string;
  retryCount?: number;
}): string {
  const taskLabel = params.task.prompt.length > 60
    ? `"${params.task.prompt.slice(0, 57)}..."`
    : `"${params.task.prompt}"`;
  const statusLabel = params.error ? 'ran into an issue' : 'completed';
  const relativeNext = formatRelativeNextRun(params.nextRun);
  const nextRunLine = relativeNext
    ? `Next run: ${relativeNext}.`
    : (params.nextRun ? null : 'This was a one-time task.');
  const retryLine = params.error && typeof params.retryCount === 'number' && params.retryCount > 0
    ? `Retrying (attempt ${params.retryCount}).`
    : null;
  const body = params.error
    ? humanizeError(params.error)
    : (summarizeTaskText(params.result, 3000) || 'Done.');
  return [
    `Your task ${taskLabel} ${statusLabel}.`,
    retryLine,
    nextRunLine,
    body
  ].filter(Boolean).join('\n\n');
}

export function computeNextRun(task: ScheduledTask, error: string | null, nowMs: number = Date.now()): { nextRun: string | null; retryCount: number; error: string | null } {
  let scheduleNextRun: string | null = null;
  let scheduleError: string | null = null;
  const timezone = task.timezone || TIMEZONE;
  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, { tz: timezone, currentDate: new Date(nowMs) });
      scheduleNextRun = interval.next().toISOString();
    } catch (err) {
      scheduleError = `Invalid cron expression: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      scheduleError = `Invalid interval: "${task.schedule_value}"`;
    } else {
      scheduleNextRun = new Date(nowMs + ms).toISOString();
    }
  }

  const combinedError = scheduleError
    ? (error ? `${error}; ${scheduleError}` : scheduleError)
    : error;

  let nextRun = scheduleNextRun;
  let retryCount = typeof task.retry_count === 'number' ? task.retry_count : 0;
  if (combinedError) {
    if (retryCount < TASK_MAX_RETRIES) {
      retryCount += 1;
      const baseBackoff = Math.min(TASK_RETRY_MAX_MS, TASK_RETRY_BASE_MS * Math.pow(2, retryCount - 1));
      const jitter = baseBackoff * (0.7 + Math.random() * 0.6);
      nextRun = new Date(nowMs + jitter).toISOString();
    } else {
      // Circuit breaker: max retries exhausted → pause the task
      nextRun = null;
    }
  } else {
    retryCount = 0;
  }

  return { nextRun, retryCount, error: combinedError };
}

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
  const taskTimezone = task.timezone || TIMEZONE;

  // Scheduler loop claims tasks in DB before dispatching runTask.
  // Do not re-check/re-claim here or claimed tasks will be skipped.

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');
  recordMessage('scheduler');
  void emitHook('task:fired', { task_id: task.id, group_folder: task.group_folder, prompt: task.prompt.slice(0, 200) });

  const abortController = new AbortController();
  const taskTimeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === task.group_folder);

  if (!group) {
    clearTimeout(taskTimeout);
    const groupError = `Group not found: ${task.group_folder}`;
    logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
    recordError('scheduler');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: groupError
    });
    recordTaskRun('error');
    const { nextRun: earlyNextRun, retryCount: earlyRetryCount, error: earlyError } = computeNextRun(task, groupError);
    try {
      const message = buildTaskNotificationMessage({
        task,
        result: null,
        error: groupError,
        durationMs: Date.now() - startTime,
        nextRun: earlyNextRun,
        timezone: taskTimezone
      });
      await sendTaskNotification(task, message, deps);
    } catch (notifyErr) {
      logger.error({ taskId: task.id, err: notifyErr }, 'Failed to send scheduled task notification');
    }
    updateTaskAfterRun(task.id, earlyNextRun, `Error: ${groupError}`, earlyError, earlyRetryCount);
    updateTask(task.id, { running_since: null });
    return;
  }

  let result: string | null = null;
  let error: string | null = null;
  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;

  // Recurring tasks (cron/interval) use fresh sessions to prevent unbounded
  // session history accumulation. Only one-off tasks may use the group session.
  const isRecurring = task.schedule_type === 'cron' || task.schedule_type === 'interval';
  const useGroupSession = task.context_mode === 'group' && !isRecurring;
  const sessions = deps.getSessions();
  const sessionId = useGroupSession ? sessions[task.group_folder] : undefined;

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
  const routingDecision = routeRequest();

  try {
    const execution = await executeAgentRun({
      group,
      prompt: taskPrompt,
      chatJid: task.chat_jid,
      userId: null,
      recallQuery: task.prompt,
      recallMaxResults: routingDecision.recallMaxResults,
      recallMaxTokens: routingDecision.recallMaxTokens,
      sessionId,
      persistSession: useGroupSession,
      onSessionUpdate: (sessionId) => deps.setSession(task.group_folder, sessionId),
      isScheduledTask: true,
      taskId: task.id,
      useGroupLock: false,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      abortSignal: abortController.signal,
      timeoutMs: TASK_TIMEOUT_MS,
      timezone: taskTimezone
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
  } finally {
    clearTimeout(taskTimeout);
    updateTask(task.id, { running_since: null });
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
      extraTimings: {}
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

  const { nextRun, retryCount, error: combinedError } = computeNextRun(task, error);
  if (combinedError) error = combinedError;

  const notificationMessage = buildTaskNotificationMessage({
    task,
    result,
    error,
    durationMs,
    nextRun,
    timezone: taskTimezone,
    retryCount
  });
  try {
    await sendTaskNotification(task, notificationMessage, deps);
  } catch (notifyErr) {
    logger.error({ taskId: task.id, err: notifyErr }, 'Failed to send scheduled task notification');
  }

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary, error, retryCount);

  // Pause if schedule is invalid or retries exhausted (circuit breaker)
  if (combinedError && !nextRun) {
    const reason = (combinedError.includes('Invalid cron expression') || combinedError.includes('Invalid interval'))
      ? 'the schedule format is invalid'
      : `it failed ${retryCount} times in a row`;
    updateTask(task.id, { status: 'paused', next_run: null });
    try {
      await deps.sendMessage(task.chat_jid, `Your scheduled task has been paused because ${reason}. Use the task tool to resume it when you're ready.`);
    } catch (pauseNotifyErr) {
      logger.error({ taskId: task.id, err: pauseNotifyErr }, 'Failed to send task pause notification');
    }
  }
}

export async function runTaskNow(taskId: string, deps: SchedulerDependencies): Promise<{ ok: boolean; result?: string | null; error?: string }> {
  const task = getTaskById(taskId);
  if (!task) {
    return { ok: false, error: 'Task not found' };
  }
  if (task.running_since) {
    return { ok: false, error: 'Task is already running' };
  }
  updateTask(task.id, { running_since: new Date().toISOString() });

  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running task immediately');
  recordMessage('scheduler');

  const abortController = new AbortController();
  const taskTimeout = setTimeout(() => abortController.abort(), TASK_TIMEOUT_MS);

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === task.group_folder);
  if (!group) {
    clearTimeout(taskTimeout);
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
    updateTask(task.id, { running_since: null });
    return { ok: false, error };
  }

  let result: string | null = null;
  let error: string | null = null;
  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;

  // Manual runs of recurring tasks still use fresh sessions to prevent accumulation
  const isRecurring = task.schedule_type === 'cron' || task.schedule_type === 'interval';
  const useGroupSession = task.context_mode === 'group' && !isRecurring;
  const sessions = deps.getSessions();
  const sessionId = useGroupSession ? sessions[task.group_folder] : undefined;

  const stateBlock = task.state_json ? `[TASK STATE]\n${task.state_json}\n` : '';
  const taskPrompt = stateBlock ? `${stateBlock}\n${task.prompt}` : task.prompt;

  const traceBase = createTraceBase({
    chatId: task.chat_jid,
    groupFolder: task.group_folder,
    userId: null,
    inputText: task.prompt,
    source: 'dotclaw-manual-task'
  });
  const routingDecision = routeRequest();

  try {
    const execution = await executeAgentRun({
      group,
      prompt: taskPrompt,
      chatJid: task.chat_jid,
      userId: null,
      recallQuery: task.prompt,
      recallMaxResults: routingDecision.recallMaxResults,
      recallMaxTokens: routingDecision.recallMaxTokens,
      sessionId,
      persistSession: useGroupSession,
      onSessionUpdate: (sessionId) => deps.setSession(task.group_folder, sessionId),
      isScheduledTask: true,
      taskId: task.id,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      abortSignal: abortController.signal,
      timeoutMs: TASK_TIMEOUT_MS,
      timezone: task.timezone || TIMEZONE
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
  } finally {
    clearTimeout(taskTimeout);
    updateTask(task.id, { running_since: null });
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
      extraTimings: {}
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
      const dueTasks = claimDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      const taskPromises = dueTasks
        .map(t => {
          const currentTask = getTaskById(t.id);
          if (!currentTask || currentTask.status !== 'active') return null;
          return runTask(currentTask, deps);
        })
        .filter(Boolean);
      if (taskPromises.length > 0) {
        await Promise.allSettled(taskPromises);
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
