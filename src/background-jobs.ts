import fs from 'fs';
import path from 'path';
import {
  createBackgroundJob,
  getBackgroundJobById,
  listBackgroundJobs,
  updateBackgroundJob,
  claimNextBackgroundJob,
  failExpiredBackgroundJobs,
  logBackgroundJobRun,
  logBackgroundJobEvent
} from './db.js';
import { GROUPS_DIR, DATA_DIR } from './config.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { writeTrace } from './trace-writer.js';
import type { AgentContext } from './agent-context.js';
import type { ContainerOutput } from './container-protocol.js';
import type { RegisteredGroup, BackgroundJob, BackgroundJobStatus } from './types.js';
import { recordBackgroundJobRun } from './metrics.js';
import { loadModelRegistry } from './model-registry.js';
import { logger } from './logger.js';
import { generateId } from './id.js';

const runtime = loadRuntimeConfig();

const JOBS_ENABLED = runtime.host.backgroundJobs.enabled;
const JOBS_POLL_INTERVAL = runtime.host.backgroundJobs.pollIntervalMs;
const JOBS_MAX_CONCURRENT = runtime.host.backgroundJobs.maxConcurrent;
const JOBS_MAX_RUNTIME_MS = runtime.host.backgroundJobs.maxRuntimeMs;
const JOBS_MAX_TOOL_STEPS = runtime.host.backgroundJobs.maxToolSteps;
const JOBS_INLINE_MAX_CHARS = runtime.host.backgroundJobs.inlineMaxChars;
const JOBS_CONTEXT_DEFAULT = runtime.host.backgroundJobs.contextModeDefault;
const JOBS_TOOL_ALLOW = runtime.host.backgroundJobs.toolAllow;
const JOBS_TOOL_DENY = runtime.host.backgroundJobs.toolDeny;
const JOBS_PROGRESS = runtime.host.backgroundJobs.progress;
const BACKGROUND_PROFILE = runtime.host.routing?.profiles?.background;

type JobPolicy = {
  tool_allow?: string[];
  tool_deny?: string[];
};

export interface BackgroundJobDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSession: (groupFolder: string, sessionId: string) => void;
}

const inFlightJobs = new Map<string, AbortController>();

function formatJobCompletionMessage(params: {
  job: BackgroundJob;
  status: BackgroundJobStatus;
  durationMs: number;
  outputText?: string | null;
  outputPath?: string | null;
}): string {
  const statusLine = `Background job ${params.job.id} ${params.status}.`;
  const durationLine = `Duration: ${Math.round(params.durationMs / 1000)}s.`;
  const outputPathLine = params.outputPath ? `Output saved to: ${params.outputPath}` : '';
  const summary = params.outputText ? params.outputText.trim() : '';
  const summaryLine = summary ? `Summary:\n${summary}` : '';
  return [statusLine, durationLine, outputPathLine, summaryLine].filter(Boolean).join('\n\n');
}

function coerceJobPolicy(raw?: string | null): JobPolicy {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return {
      tool_allow: Array.isArray(parsed.tool_allow) ? parsed.tool_allow : undefined,
      tool_deny: Array.isArray(parsed.tool_deny) ? parsed.tool_deny : undefined
    };
  } catch {
    return {};
  }
}

function extractEstimatedMinutes(tags?: string | null): number | null {
  if (!tags) return null;
  try {
    const parsed = JSON.parse(tags) as string[];
    if (!Array.isArray(parsed)) return null;
    for (const tag of parsed) {
      if (typeof tag !== 'string') continue;
      const match = tag.match(/^eta:(\\d+(?:\\.\\d+)?)$/i);
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > 0) return value;
      }
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

function effectiveToolAllow(job: BackgroundJob): string[] | undefined {
  const policy = coerceJobPolicy(job.tool_policy_json ?? null);
  if (policy.tool_allow && policy.tool_allow.length > 0) return policy.tool_allow;
  return JOBS_TOOL_ALLOW.length > 0 ? JOBS_TOOL_ALLOW : undefined;
}

function effectiveToolDeny(job: BackgroundJob): string[] {
  const policy = coerceJobPolicy(job.tool_policy_json ?? null);
  const deny = Array.isArray(policy.tool_deny) ? policy.tool_deny : [];
  return [...JOBS_TOOL_DENY, ...deny];
}

function ensureJobDir(groupFolder: string, jobId: string): { dir: string; relative: string } {
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const jobsDir = path.join(groupDir, 'jobs');
  const jobDir = path.join(jobsDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  return { dir: jobDir, relative: path.join('jobs', jobId) };
}

function createSessionSnapshot(groupFolder: string, sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const sessionsDir = path.join(DATA_DIR, 'sessions', groupFolder, 'openrouter');
  if (!fs.existsSync(sessionsDir)) return undefined;
  const sourceDir = path.join(sessionsDir, sessionId);
  if (!fs.existsSync(sourceDir)) return undefined;
  const snapshotId = generateId('session');
  const destDir = path.join(sessionsDir, snapshotId);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(sourceDir, destDir, { recursive: true });
    const metaPath = path.join(destDir, 'session.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        meta.sessionId = snapshotId;
        meta.updatedAt = new Date().toISOString();
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      } catch {
        // ignore meta rewrite failures
      }
    }
    return snapshotId;
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to snapshot session for background job');
    return undefined;
  }
}

async function runBackgroundJob(job: BackgroundJob, deps: BackgroundJobDependencies): Promise<void> {
  const startTime = Date.now();
  const abortController = new AbortController();
  inFlightJobs.set(job.id, abortController);

  const now = new Date().toISOString();
  const timeoutMs = job.timeout_ms ?? JOBS_MAX_RUNTIME_MS;
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;
  let error: string | null = null;
  let resultText: string | null = null;
  const recallEnabled = BACKGROUND_PROFILE?.enableMemoryRecall ?? true;
  const recallMaxResults = recallEnabled
    ? (Number.isFinite(BACKGROUND_PROFILE?.recallMaxResults)
      ? Math.max(0, Math.floor(BACKGROUND_PROFILE?.recallMaxResults as number))
      : runtime.host.memory.recall.maxResults)
    : 0;
  const recallMaxTokens = recallEnabled
    ? (Number.isFinite(BACKGROUND_PROFILE?.recallMaxTokens)
      ? Math.max(0, Math.floor(BACKGROUND_PROFILE?.recallMaxTokens as number))
      : runtime.host.memory.recall.maxTokens)
    : 0;
  const maxToolSteps = job.max_tool_steps ?? BACKGROUND_PROFILE?.maxToolSteps ?? JOBS_MAX_TOOL_STEPS;
  const modelOverride = job.model_override ?? BACKGROUND_PROFILE?.model;
  const modelMaxOutputTokens = BACKGROUND_PROFILE?.maxOutputTokens;
  const disablePlanner = BACKGROUND_PROFILE ? !BACKGROUND_PROFILE.enablePlanner : undefined;
  const disableResponseValidation = BACKGROUND_PROFILE ? !BACKGROUND_PROFILE.enableValidation : undefined;
  const responseValidationMaxRetries = Number.isFinite(BACKGROUND_PROFILE?.responseValidationMaxRetries)
    ? Math.max(0, Math.floor(BACKGROUND_PROFILE?.responseValidationMaxRetries as number))
    : undefined;
  const disableMemoryExtraction = BACKGROUND_PROFILE ? !BACKGROUND_PROFILE.enableMemoryExtraction : undefined;
  let progressTimer: NodeJS.Timeout | null = null;
  let progressCount = 0;

  logBackgroundJobEvent({
    job_id: job.id,
    created_at: now,
    level: 'info',
    message: 'Background job started',
    data_json: null
  });

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === job.group_folder);
  if (!group) {
    error = `Group not found: ${job.group_folder}`;
  }

  const traceBase = createTraceBase({
    chatId: job.chat_jid,
    groupFolder: job.group_folder,
    userId: null,
    inputText: job.prompt,
    source: 'dotclaw-background-job'
  });

  try {
    if (!error && group) {
      if (JOBS_PROGRESS.enabled && job.chat_jid) {
        const eta = extractEstimatedMinutes(job.tags);
        const startedAt = Date.now();
        const scheduleProgress = () => {
          if (progressCount >= JOBS_PROGRESS.maxUpdates) return;
          progressCount += 1;
          const elapsedMinutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000));
          const remaining = eta ? Math.max(1, Math.ceil(eta - elapsedMinutes)) : null;
          const etaLine = remaining ? ` ~${remaining} min remaining.` : '';
          void deps.sendMessage(job.chat_jid, `Background job ${job.id} is still running.${etaLine}`);
        };
        const startDelay = Math.max(0, JOBS_PROGRESS.startDelayMs);
        if (startDelay === 0) {
          scheduleProgress();
        }
        progressTimer = setTimeout(function tick() {
          scheduleProgress();
          if (progressCount < JOBS_PROGRESS.maxUpdates) {
            progressTimer = setTimeout(tick, Math.max(5_000, JOBS_PROGRESS.intervalMs));
          }
        }, startDelay);
      }

      const sessions = deps.getSessions();
      const sessionId = job.context_mode === 'group'
        ? createSessionSnapshot(job.group_folder, sessions[job.group_folder])
        : undefined;

      const execution = await executeAgentRun({
        group,
        prompt: job.prompt,
        chatJid: job.chat_jid,
        userId: null,
        recallQuery: job.prompt,
        recallMaxResults,
        recallMaxTokens,
        sessionId,
        persistSession: false,
        isBackgroundJob: true,
        jobId: job.id,
        useGroupLock: false,
        useSemaphore: false,
        abortSignal: abortController.signal,
        toolAllow: effectiveToolAllow(job),
        toolDeny: effectiveToolDeny(job),
        modelOverride: modelOverride ?? undefined,
        modelMaxOutputTokens,
        maxToolSteps,
        disablePlanner,
        disableResponseValidation,
        responseValidationMaxRetries,
        disableMemoryExtraction,
        timeoutMs
      });
      output = execution.output;
      context = execution.context;
      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else {
        resultText = output.result ?? null;
      }
    }
  } catch (err) {
    if (err instanceof AgentExecutionError) {
      context = err.context;
      error = err.message;
    } else {
      error = err instanceof Error ? err.message : String(err);
    }
    logger.error({ jobId: job.id, err }, 'Background job failed');
  } finally {
    clearTimeout(timeout);
    if (progressTimer) clearTimeout(progressTimer);
    inFlightJobs.delete(job.id);
  }

  if (!error && (!resultText || !resultText.trim())) {
    error = 'Job returned empty result.';
    resultText = null;
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      toolAuditSource: 'background',
      errorMessage: error ?? undefined,
      errorType: error ? 'background_job' : undefined
    });
  } else if (error) {
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

  let status: BackgroundJobStatus = 'succeeded';
  if (abortController.signal.aborted) {
    status = 'canceled';
  } else if (error) {
    status = /timed out|timeout/i.test(error) ? 'timed_out' : 'failed';
  }

  let outputPath: string | null = null;
  let outputSummary = resultText ? resultText.trim() : '';
  let outputTruncated = 0;

  if (!outputSummary && error) {
    outputSummary = `Error: ${error}`;
  }

  const latest = getBackgroundJobById(job.id);
  if (latest?.status === 'canceled') {
    status = 'canceled';
    if (!error) error = 'Canceled by user.';
    if (!outputSummary) outputSummary = 'Canceled by user.';
  }

  if (resultText && resultText.length > JOBS_INLINE_MAX_CHARS) {
    const jobDir = ensureJobDir(job.group_folder, job.id);
    const outputFile = path.join(jobDir.dir, 'output.md');
    fs.writeFileSync(outputFile, resultText);
    outputPath = path.join(jobDir.relative, 'output.md');
    outputSummary = resultText.slice(0, Math.min(1000, JOBS_INLINE_MAX_CHARS)).trim();
    outputTruncated = 1;
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startTime;
  updateBackgroundJob(job.id, {
    status,
    updated_at: finishedAt,
    finished_at: finishedAt,
    result_summary: outputSummary || null,
    output_path: outputPath,
    output_truncated: outputTruncated,
    last_error: error ?? null,
    lease_expires_at: null
  });

  const runStatus: 'success' | 'error' | 'canceled' | 'timed_out' = status === 'succeeded'
    ? 'success'
    : (status === 'failed' ? 'error' : status);
  logBackgroundJobRun({
    job_id: job.id,
    run_at: finishedAt,
    duration_ms: durationMs,
    status: runStatus,
    result_summary: outputSummary || null,
    error
  });
  recordBackgroundJobRun(runStatus);

  logBackgroundJobEvent({
    job_id: job.id,
    created_at: finishedAt,
    level: status === 'succeeded' ? 'info' : 'error',
    message: status === 'succeeded' ? 'Background job completed' : `Background job ${status}`,
    data_json: null
  });

  if (job.chat_jid) {
    const summaryForChat = outputSummary
      ? outputSummary.slice(0, JOBS_INLINE_MAX_CHARS)
      : '';
    const message = formatJobCompletionMessage({
      job,
      status,
      durationMs,
      outputText: summaryForChat || null,
      outputPath
    });
    try {
      await deps.sendMessage(job.chat_jid, message);
    } catch (err) {
      logger.warn({ err, jobId: job.id }, 'Failed to send background job completion message');
    }
  }
}

let jobLoopStopped = false;

export function startBackgroundJobLoop(deps: BackgroundJobDependencies): void {
  if (!JOBS_ENABLED || JOBS_MAX_CONCURRENT <= 0) return;
  jobLoopStopped = false;
  logger.info('Background job loop started');

  const loop = async () => {
    if (jobLoopStopped) return;
    try {
      const now = new Date().toISOString();
      failExpiredBackgroundJobs(now);

      while (inFlightJobs.size < JOBS_MAX_CONCURRENT) {
        const job = claimNextBackgroundJob({ now, defaultLeaseMs: JOBS_MAX_RUNTIME_MS });
        if (!job) break;
        void runBackgroundJob(job, deps);
      }
    } catch (err) {
      logger.error({ err }, 'Error in background job loop');
    }

    if (!jobLoopStopped) {
      setTimeout(loop, JOBS_POLL_INTERVAL);
    }
  };

  loop();
}

export function stopBackgroundJobLoop(): void {
  jobLoopStopped = true;
  // Abort all in-flight jobs
  for (const [jobId, controller] of inFlightJobs) {
    controller.abort();
    logger.info({ jobId }, 'Aborted in-flight background job');
  }
}

export function spawnBackgroundJob(params: {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  contextMode?: 'group' | 'isolated';
  timeoutMs?: number;
  maxToolSteps?: number;
  toolAllow?: string[];
  toolDeny?: string[];
  modelOverride?: string;
  priority?: number;
  tags?: string[];
  parentTraceId?: string;
  parentMessageId?: string;
}): { ok: boolean; jobId?: string; error?: string } {
  if (!params.prompt || !params.groupFolder || !params.chatJid) {
    return { ok: false, error: 'Missing required job fields.' };
  }
  if (params.modelOverride) {
    const registry = loadModelRegistry(runtime.host.defaultModel);
    if (registry.allowlist && registry.allowlist.length > 0 && !registry.allowlist.includes(params.modelOverride)) {
      return { ok: false, error: 'Model not in allowlist.' };
    }
  }

  const jobId = generateId('job');
  const now = new Date().toISOString();
  const contextMode = params.contextMode || JOBS_CONTEXT_DEFAULT;
  const toolPolicyJson = JSON.stringify({
    tool_allow: params.toolAllow && params.toolAllow.length > 0 ? params.toolAllow : undefined,
    tool_deny: params.toolDeny && params.toolDeny.length > 0 ? params.toolDeny : undefined
  });

  const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? params.timeoutMs
    : JOBS_MAX_RUNTIME_MS;
  const maxToolSteps = typeof params.maxToolSteps === 'number' && params.maxToolSteps > 0
    ? params.maxToolSteps
    : JOBS_MAX_TOOL_STEPS;

  createBackgroundJob({
    id: jobId,
    group_folder: params.groupFolder,
    chat_jid: params.chatJid,
    prompt: params.prompt,
    context_mode: contextMode,
    status: 'queued',
    created_at: now,
    updated_at: now,
    timeout_ms: timeoutMs,
    max_tool_steps: maxToolSteps,
    tool_policy_json: toolPolicyJson,
    model_override: params.modelOverride ?? null,
    priority: params.priority ?? 0,
    tags: params.tags ? JSON.stringify(params.tags) : null,
    parent_trace_id: params.parentTraceId ?? null,
    parent_message_id: params.parentMessageId ?? null
  });

  logBackgroundJobEvent({
    job_id: jobId,
    created_at: now,
    level: 'info',
    message: 'Background job queued',
    data_json: null
  });

  return { ok: true, jobId };
}

export function getBackgroundJobStatus(jobId: string): BackgroundJob | undefined {
  return getBackgroundJobById(jobId);
}

export function listBackgroundJobsForGroup(params: { groupFolder: string; status?: BackgroundJobStatus; limit?: number }): BackgroundJob[] {
  return listBackgroundJobs({ groupFolder: params.groupFolder, status: params.status, limit: params.limit });
}

export function cancelBackgroundJob(jobId: string): { ok: boolean; error?: string } {
  const job = getBackgroundJobById(jobId);
  if (!job) return { ok: false, error: 'Job not found.' };
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled' || job.status === 'timed_out') {
    return { ok: true };
  }

  const now = new Date().toISOString();
  updateBackgroundJob(jobId, {
    status: 'canceled',
    updated_at: now,
    finished_at: now,
    last_error: job.last_error
  });

  const controller = inFlightJobs.get(jobId);
  if (controller) {
    controller.abort();
  }

  logBackgroundJobEvent({
    job_id: jobId,
    created_at: now,
    level: 'warn',
    message: 'Background job canceled',
    data_json: null
  });

  return { ok: true };
}

export function recordBackgroundJobUpdate(params: {
  jobId: string;
  level: 'info' | 'progress' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}): { ok: boolean; error?: string } {
  const job = getBackgroundJobById(params.jobId);
  if (!job) return { ok: false, error: 'Job not found.' };
  const now = new Date().toISOString();
  updateBackgroundJob(job.id, { updated_at: now });
  logBackgroundJobEvent({
    job_id: job.id,
    created_at: now,
    level: params.level,
    message: params.message,
    data_json: params.data ? JSON.stringify(params.data) : null
  });
  return { ok: true };
}
