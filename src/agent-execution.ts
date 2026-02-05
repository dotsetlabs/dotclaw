import { buildAgentContext, AgentContext } from './agent-context.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot } from './container-runner.js';
import { getAllTasks, setGroupSession, logToolCalls } from './db.js';
import { MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { generateId } from './id.js';
import { runWithAgentSemaphore } from './agent-semaphore.js';
import { withGroupLock } from './locks.js';
import { getModelPricing } from './model-registry.js';
import { computeCostUSD } from './cost.js';
import { writeTrace } from './trace-writer.js';
import { recordLatency, recordTokenUsage, recordCost, recordMemoryRecall, recordMemoryUpsert, recordMemoryExtract, recordToolCall, recordError, recordStageLatency } from './metrics.js';
import type { ContainerOutput } from './container-protocol.js';
import type { RegisteredGroup } from './types.js';

export type TraceBase = {
  trace_id: string;
  timestamp: string;
  created_at: number;
  chat_id: string;
  group_folder: string;
  user_id?: string;
  input_text: string;
  source: string;
};

export class AgentExecutionError extends Error {
  context: AgentContext;
  constructor(message: string, context: AgentContext) {
    super(message);
    this.context = context;
  }
}


export function createTraceBase(params: {
  chatId: string;
  groupFolder: string;
  userId?: string | null;
  inputText: string;
  source: string;
}): TraceBase {
  return {
    trace_id: generateId('trace'),
    timestamp: new Date().toISOString(),
    created_at: Date.now(),
    chat_id: params.chatId,
    group_folder: params.groupFolder,
    user_id: params.userId ?? undefined,
    input_text: params.inputText,
    source: params.source
  };
}

function buildTaskSnapshot() {
  const tasks = getAllTasks();
  return tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    timezone: t.timezone ?? null,
    status: t.status,
    next_run: t.next_run,
    state_json: t.state_json ?? null,
    retry_count: t.retry_count ?? 0,
    last_error: t.last_error ?? null
  }));
}

export async function executeAgentRun(params: {
  group: RegisteredGroup;
  prompt: string;
  chatJid: string;
  userId?: string | null;
  userName?: string;
  recallQuery: string;
  recallMaxResults: number;
  recallMaxTokens: number;
  toolAllow?: string[];
  toolDeny?: string[];
  modelOverride?: string;
  modelMaxOutputTokens?: number;
  sessionId?: string;
  persistSession?: boolean;
  onSessionUpdate?: (sessionId: string) => void;
  useGroupLock?: boolean;
  useSemaphore?: boolean;
  abortSignal?: AbortSignal;
  isScheduledTask?: boolean;
  isBackgroundTask?: boolean;
  taskId?: string;
  jobId?: string;
  isBackgroundJob?: boolean;
  disablePlanner?: boolean;
  disableResponseValidation?: boolean;
  responseValidationMaxRetries?: number;
  disableMemoryExtraction?: boolean;
  availableGroups?: Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>;
  maxToolSteps?: number;
  timeoutMs?: number;
  timezone?: string;
  attachments?: Array<{
    type: 'photo' | 'document' | 'voice' | 'video' | 'audio';
    path: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    width?: number;
    height?: number;
  }>;
}): Promise<{ output: ContainerOutput; context: AgentContext }> {
  const group = params.group;
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const persistSession = params.persistSession !== false;
  const useGroupLock = params.useGroupLock !== false;
  const useSemaphore = params.useSemaphore !== false;

  writeTasksSnapshot(group.folder, isMain, buildTaskSnapshot());
  if (isMain && params.availableGroups) {
    writeGroupsSnapshot(group.folder, isMain, params.availableGroups);
  }

  const context = await buildAgentContext({
    groupFolder: group.folder,
    userId: params.userId ?? null,
    recallQuery: params.recallQuery,
    recallMaxResults: params.recallMaxResults,
    recallMaxTokens: params.recallMaxTokens,
    toolAllow: params.toolAllow,
    toolDeny: params.toolDeny,
    recallEnabled: params.recallMaxResults > 0 && params.recallMaxTokens > 0
  });

  const resolvedMaxOutputTokens = [params.modelMaxOutputTokens, context.resolvedModel.override?.max_output_tokens]
    .filter((value): value is number => Number.isFinite(value))
    .reduce((min, value) => Math.min(min, value), Infinity);

  const runContainer = () => runContainerAgent(group, {
    prompt: params.prompt,
    sessionId: params.sessionId,
    groupFolder: group.folder,
    chatJid: params.chatJid,
    isMain,
    isScheduledTask: params.isScheduledTask,
    isBackgroundTask: params.isBackgroundTask,
    taskId: params.taskId,
    jobId: params.jobId,
    isBackgroundJob: params.isBackgroundJob,
    userId: params.userId ?? undefined,
    userName: params.userName,
    memoryRecall: context.memoryRecall,
    userProfile: context.userProfile,
    memoryStats: context.memoryStats,
    tokenEstimate: context.tokenEstimate,
    toolReliability: context.toolReliability,
    behaviorConfig: context.behaviorConfig as Record<string, unknown>,
    toolPolicy: context.toolPolicy as Record<string, unknown>,
    modelOverride: params.modelOverride || context.resolvedModel.model,
    modelMaxOutputTokens: Number.isFinite(resolvedMaxOutputTokens) ? resolvedMaxOutputTokens : undefined,
    modelContextTokens: context.resolvedModel.override?.context_window,
    modelTemperature: context.resolvedModel.override?.temperature,
    timezone: params.timezone || TIMEZONE,
    disablePlanner: params.disablePlanner,
    disableResponseValidation: params.disableResponseValidation,
    responseValidationMaxRetries: params.responseValidationMaxRetries,
    disableMemoryExtraction: params.disableMemoryExtraction,
    maxToolSteps: params.maxToolSteps,
    attachments: params.attachments
  }, { abortSignal: params.abortSignal, timeoutMs: params.timeoutMs });

  let output: ContainerOutput;
  try {
    const runner = () => (useGroupLock ? withGroupLock(group.folder, () => runContainer()) : runContainer());
    output = useSemaphore
      ? await runWithAgentSemaphore(runner)
      : await runner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentExecutionError(message, context);
  }

  if (output.newSessionId && persistSession) {
    params.onSessionUpdate?.(output.newSessionId);
    setGroupSession(group.folder, output.newSessionId);
  }

  return { output, context };
}

export function recordAgentTelemetry(params: {
  traceBase: TraceBase;
  output: ContainerOutput | null;
  context: AgentContext;
  metricsSource?: 'telegram' | 'scheduler';
  toolAuditSource: 'message' | 'background' | 'scheduler' | 'heartbeat';
  errorMessage?: string;
  errorType?: string;
  extraTimings?: Record<string, number>;
}): void {
  const { traceBase, output, context } = params;
  const stageSource = params.metricsSource
    ? params.metricsSource
    : (params.toolAuditSource === 'background' ? 'background' : 'telegram');
  const pricing = output?.model
    ? getModelPricing(context.modelRegistry, output.model)
    : context.modelPricing;
  const cost = computeCostUSD(output?.tokens_prompt, output?.tokens_completion, pricing);

  const timingBundle: Record<string, number> = {};
  if (context.timings?.context_build_ms) timingBundle.context_build_ms = context.timings.context_build_ms;
  if (context.timings?.memory_recall_ms) timingBundle.memory_recall_ms = context.timings.memory_recall_ms;
  if (output?.timings?.planner_ms) timingBundle.planner_ms = output.timings.planner_ms;
  if (output?.timings?.response_validation_ms) timingBundle.response_validation_ms = output.timings.response_validation_ms;
  if (output?.timings?.memory_extraction_ms) timingBundle.memory_extraction_ms = output.timings.memory_extraction_ms;
  if (output?.timings?.tool_ms) timingBundle.tool_ms = output.timings.tool_ms;
  if (params.extraTimings) {
    for (const [key, value] of Object.entries(params.extraTimings)) {
      if (Number.isFinite(value)) timingBundle[key] = Number(value);
    }
  }

  writeTrace({
    ...traceBase,
    output_text: output?.result ?? null,
    model_id: output?.model || 'unknown',
    prompt_pack_versions: output?.prompt_pack_versions,
    memory_summary: output?.memory_summary,
    memory_facts: output?.memory_facts,
    memory_recall: context.memoryRecall,
    tool_calls: output?.tool_calls,
    latency_ms: output?.latency_ms,
    tokens_prompt: output?.tokens_prompt,
    tokens_completion: output?.tokens_completion,
    cost_prompt_usd: cost?.prompt,
    cost_completion_usd: cost?.completion,
    cost_total_usd: cost?.total,
    memory_recall_count: output?.memory_recall_count,
    session_recall_count: output?.session_recall_count,
    memory_items_upserted: output?.memory_items_upserted,
    memory_items_extracted: output?.memory_items_extracted,
    timings: Object.keys(timingBundle).length > 0 ? timingBundle : undefined,
    error_code: params.errorMessage || (output?.status === 'error' ? output?.error : undefined)
  });

  if (context.timings?.context_build_ms) {
    recordStageLatency('context_build', context.timings.context_build_ms, stageSource);
  }
  if (context.timings?.memory_recall_ms) {
    recordStageLatency('memory_recall', context.timings.memory_recall_ms, stageSource);
  }
  if (output?.timings?.planner_ms) {
    recordStageLatency('planner', output.timings.planner_ms, stageSource);
  }
  if (output?.timings?.response_validation_ms) {
    recordStageLatency('response_validation', output.timings.response_validation_ms, stageSource);
  }
  if (output?.timings?.memory_extraction_ms) {
    recordStageLatency('memory_extraction', output.timings.memory_extraction_ms, stageSource);
  }
  if (output?.timings?.tool_ms) {
    recordStageLatency('tools', output.timings.tool_ms, stageSource);
  }
  if (params.extraTimings) {
    for (const [key, value] of Object.entries(params.extraTimings)) {
      if (!Number.isFinite(value)) continue;
      recordStageLatency(key, Number(value), stageSource);
    }
  }

  if (params.errorMessage || output?.status === 'error') {
    if (params.errorType) {
      recordError(params.errorType);
    }
  }

  if (params.metricsSource) {
    if (output?.latency_ms) {
      recordLatency(output.latency_ms);
    }
    if (Number.isFinite(output?.tokens_prompt) || Number.isFinite(output?.tokens_completion)) {
      const modelId = output?.model || context.resolvedModel.model;
      recordTokenUsage(modelId, params.metricsSource, output?.tokens_prompt || 0, output?.tokens_completion || 0);
      if (cost) {
        recordCost(modelId, params.metricsSource, cost.total);
      }
    }
    if (Number.isFinite(output?.memory_recall_count)) {
      recordMemoryRecall(params.metricsSource, output?.memory_recall_count || 0);
    }
    if (Number.isFinite(output?.memory_items_upserted)) {
      recordMemoryUpsert(params.metricsSource, output?.memory_items_upserted || 0);
    }
    if (Number.isFinite(output?.memory_items_extracted)) {
      recordMemoryExtract(params.metricsSource, output?.memory_items_extracted || 0);
    }
  }

  if (output?.tool_calls && output.tool_calls.length > 0) {
    logToolCalls({
      traceId: traceBase.trace_id,
      chatJid: traceBase.chat_id,
      groupFolder: traceBase.group_folder,
      userId: traceBase.user_id ?? null,
      toolCalls: output.tool_calls,
      source: params.toolAuditSource
    });
    for (const call of output.tool_calls) {
      recordToolCall(call.name, call.ok);
    }
  }
}
