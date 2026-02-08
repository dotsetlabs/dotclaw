import { buildAgentContext, AgentContext } from './agent-context.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot } from './container-runner.js';
import { getAllTasks, setGroupSession, logToolCalls } from './db.js';
import { MAIN_GROUP_FOLDER, TIMEZONE } from './config.js';
import { generateId } from './id.js';
import { runWithAgentSemaphore, AgentExecutionLane } from './agent-semaphore.js';
import { withGroupLock } from './locks.js';
import { getModelPricing } from './model-registry.js';
import { computeCostUSD } from './cost.js';
import { writeTrace } from './trace-writer.js';
import { recordLatency, recordTokenUsage, recordCost, recordMemoryRecall, recordMemoryUpsert, recordMemoryExtract, recordToolCall, recordError, recordStageLatency, recordFailover } from './metrics.js';
import { loadRuntimeConfig } from './runtime-config.js';
import {
  buildFailoverEnvelope,
  chooseNextHostModelChain,
  downgradeReasoningEffort,
  type FailoverEnvelope,
  reduceToolStepBudget,
  registerModelFailureCooldown
} from './failover-policy.js';
import { emitHook } from './hooks.js';
import type { ContainerOutput } from './container-protocol.js';
import type { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

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

function buildModelChain(primary: string, fallbacks?: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [primary, ...(fallbacks || [])]) {
    const normalized = (candidate || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    deduped.push(normalized);
    seen.add(normalized);
  }
  return deduped;
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
  modelFallbacks?: string[];
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  abortSignal?: AbortSignal;
  isScheduledTask?: boolean;
  taskId?: string;
  availableGroups?: Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>;
  maxToolSteps?: number;
  timeoutMs?: number;
  timezone?: string;
  lane?: AgentExecutionLane;
  streamDir?: string;
  attachments?: Array<{
    type: 'photo' | 'document' | 'voice' | 'video' | 'audio';
    path: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration?: number;
    width?: number;
    height?: number;
    transcript?: string;
  }>;
}): Promise<{ output: ContainerOutput; context: AgentContext }> {
  const runStartedAt = Date.now();
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
    recallEnabled: params.recallMaxResults > 0 && params.recallMaxTokens > 0,
    messageText: params.recallQuery
  });

  // Context window guard
  const ctxLength = context.modelCapabilities?.context_length;
  if (ctxLength && ctxLength < 16_000) {
    throw new AgentExecutionError(
      `Model context window too small (${ctxLength} tokens, minimum 16,000)`,
      context
    );
  }
  if (ctxLength && ctxLength < 32_000) {
    logger.warn({ model: context.resolvedModel.model, ctxLength }, 'Model context window below 32K — quality may degrade');
  }

  const outputCandidates = [params.modelMaxOutputTokens, context.resolvedModel.override?.max_output_tokens]
    .filter((v): v is number => typeof v === 'number' && v > 0);
  const resolvedMaxOutputTokens = outputCandidates.length > 0
    ? Math.min(...outputCandidates)
    : Infinity;

  const runtime = loadRuntimeConfig();
  const hostFailover = runtime.host.routing.hostFailover;
  const maxHostRetries = hostFailover.enabled ? Math.max(0, hostFailover.maxRetries) : 0;
  const lane: AgentExecutionLane = params.lane || (params.isScheduledTask ? 'scheduled' : 'interactive');
  const initialModelChain = buildModelChain(
    params.modelOverride || context.resolvedModel.model,
    params.modelFallbacks
  );
  const initialChainSelection = chooseNextHostModelChain({
    modelChain: initialModelChain,
    attemptedPrimaryModels: new Set<string>()
  });
  const initialPrimary = initialModelChain[0] || context.resolvedModel.model;
  if (initialChainSelection && initialChainSelection.model !== initialPrimary) {
    logger.info({
      chatJid: params.chatJid,
      groupFolder: group.folder,
      skippedModel: initialPrimary,
      selectedModel: initialChainSelection.model
    }, 'Skipping primary model due to active host cooldown');
  }
  const attemptedPrimaryModels = new Set<string>();
  let activeModelChain = initialChainSelection
    ? [initialChainSelection.model, ...initialChainSelection.fallbacks]
    : [...initialModelChain];
  let activeReasoningEffort = params.reasoningEffort;
  let activeMaxToolSteps = params.maxToolSteps;
  let hostAttempts = 0;
  let hostRecovered = false;
  let lastFailoverCategory: string | undefined;
  let lastFailoverEnvelope: FailoverEnvelope | undefined;
  const failoverEnvelopes: FailoverEnvelope[] = [];
  const markFailoverExhaustedIfNeeded = () => {
    if (hostAttempts > 1 && lastFailoverCategory) {
      recordFailover('exhausted', lastFailoverCategory);
    }
  };
  const planHostRetry = (hostAttempt: number, envelope: FailoverEnvelope) => {
    const canRetry = hostAttempt < maxHostRetries && envelope.retryable;
    if (!canRetry) return null;
    return chooseNextHostModelChain({
      modelChain: initialModelChain,
      attemptedPrimaryModels
    });
  };
  const applyHostRetry = (
    hostAttempt: number,
    envelope: FailoverEnvelope,
    nextChain: { model: string; fallbacks: string[] },
    message: string
  ) => {
    recordFailover('attempt', envelope.category);
    activeModelChain = [nextChain.model, ...nextChain.fallbacks];
    activeReasoningEffort = downgradeReasoningEffort(activeReasoningEffort);
    activeMaxToolSteps = reduceToolStepBudget(activeMaxToolSteps);
    logger.warn({
      chatJid: params.chatJid,
      groupFolder: group.folder,
      attempt: hostAttempt + 1,
      category: envelope.category,
      source: envelope.source,
      statusCode: envelope.statusCode,
      retryModel: nextChain.model
    }, message);
  };

  const runContainer = (modelOverride: string, modelFallbacks: string[]) => runContainerAgent(group, {
    prompt: params.prompt,
    sessionId: params.sessionId,
    groupFolder: group.folder,
    chatJid: params.chatJid,
    isMain,
    isScheduledTask: params.isScheduledTask,
    taskId: params.taskId,
    userId: params.userId ?? undefined,
    userName: params.userName,
    memoryRecall: context.memoryRecall,
    memoryRecallAttempted: context.memoryRecallAttempted,
    userProfile: context.userProfile,
    memoryStats: context.memoryStats,
    tokenEstimate: context.tokenEstimate,
    toolReliability: context.toolReliability,
    behaviorConfig: context.behaviorConfig as Record<string, unknown>,
    toolPolicy: context.toolPolicy as Record<string, unknown>,
    modelOverride,
    modelFallbacks,
    reasoningEffort: activeReasoningEffort,
    modelCapabilities: {
      context_length: context.modelCapabilities.context_length,
      max_completion_tokens: context.modelCapabilities.max_completion_tokens,
    },
    modelMaxOutputTokens: Number.isFinite(resolvedMaxOutputTokens) ? resolvedMaxOutputTokens : undefined,
    modelContextTokens: context.resolvedModel.override?.context_window,
    modelTemperature: context.resolvedModel.override?.temperature,
    timezone: params.timezone || TIMEZONE,
    hostPlatform: `${process.platform}/${process.arch}`,
    maxToolSteps: activeMaxToolSteps,
    streamDir: params.streamDir,
    attachments: params.attachments
  }, { abortSignal: params.abortSignal, timeoutMs: params.timeoutMs });

  void emitHook('agent:start', {
    group_folder: group.folder,
    chat_jid: params.chatJid,
    user_id: params.userId ?? undefined,
    prompt: params.prompt.slice(0, 500),
    model: params.modelOverride || context.resolvedModel.model,
    source: params.isScheduledTask ? 'scheduler' : 'message'
  });

  let output: ContainerOutput | null = null;
  let lastException: unknown = null;
  for (let hostAttempt = 0; hostAttempt <= maxHostRetries; hostAttempt += 1) {
    const nextPrimary = activeModelChain[0] || context.resolvedModel.model;
    const nextFallbacks = activeModelChain.slice(1);
    attemptedPrimaryModels.add(nextPrimary);
    hostAttempts = hostAttempt + 1;

    try {
      const runner = () => (
        useGroupLock
          ? withGroupLock(group.folder, () => runContainer(nextPrimary, nextFallbacks))
          : runContainer(nextPrimary, nextFallbacks)
      );
      const attemptOutput = useSemaphore
        ? await runWithAgentSemaphore(runner, { lane })
        : await runner();

      if (attemptOutput.status !== 'error') {
        output = attemptOutput;
        hostRecovered = hostAttempts > 1;
        if (hostRecovered && lastFailoverCategory) {
          recordFailover('recovered', lastFailoverCategory);
        }
        break;
      }

      const envelope = buildFailoverEnvelope({
        error: attemptOutput.error || 'Unknown error',
        source: 'container_output',
        attempt: hostAttempts,
        model: attemptOutput.model || nextPrimary
      });
      failoverEnvelopes.push(envelope);
      lastFailoverEnvelope = envelope;
      lastFailoverCategory = envelope.category;
      registerModelFailureCooldown(envelope.model || nextPrimary, envelope.category, hostFailover);

      const nextChain = planHostRetry(hostAttempt, envelope);
      if (!nextChain) {
        markFailoverExhaustedIfNeeded();
        output = attemptOutput;
        break;
      }
      applyHostRetry(hostAttempt, envelope, nextChain, 'Host-level failover retry');
      continue;
    } catch (err) {
      lastException = err;
      const envelope = buildFailoverEnvelope({
        error: err instanceof Error ? err.message : String(err),
        source: 'runtime_exception',
        attempt: hostAttempts,
        model: nextPrimary
      });
      failoverEnvelopes.push(envelope);
      lastFailoverEnvelope = envelope;
      lastFailoverCategory = envelope.category;
      registerModelFailureCooldown(nextPrimary, envelope.category, hostFailover);
      const nextChain = planHostRetry(hostAttempt, envelope);
      if (!nextChain) {
        markFailoverExhaustedIfNeeded();
        break;
      }
      applyHostRetry(hostAttempt, envelope, nextChain, 'Host-level failover retry after runtime error');
    }
  }

  if (!output && lastException) {
    const message = lastException instanceof Error ? lastException.message : String(lastException);
    throw new AgentExecutionError(message, context);
  }
  if (!output) {
    throw new AgentExecutionError('No output from agent run', context);
  }

  output.host_failover_attempts = hostAttempts;
  output.host_failover_recovered = hostRecovered;
  output.host_failover_category = lastFailoverCategory;
  output.host_failover_source = lastFailoverEnvelope?.source;
  output.host_failover_status_code = lastFailoverEnvelope?.statusCode;
  output.host_failover_envelopes = failoverEnvelopes.length > 0 ? failoverEnvelopes : undefined;
  output.latency_ms = Math.max(1, Date.now() - runStartedAt);

  void emitHook('agent:complete', {
    group_folder: group.folder,
    chat_jid: params.chatJid,
    status: output.status,
    model: output.model,
    tokens_prompt: output.tokens_prompt,
    tokens_completion: output.tokens_completion,
    latency_ms: output.latency_ms,
    tool_calls_count: output.tool_calls?.length ?? 0
  });

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
  metricsSource?: string;
  toolAuditSource: 'message' | 'scheduler' | 'heartbeat';
  errorMessage?: string;
  errorType?: string;
  extraTimings?: Record<string, number>;
}): void {
  const { traceBase, output, context } = params;
  const stageSource = params.metricsSource || 'telegram';
  const pricing = output?.model
    ? getModelPricing(context.modelRegistry, output.model)
    : context.modelPricing;
  const cost = computeCostUSD(output?.tokens_prompt, output?.tokens_completion, pricing);

  const timingBundle: Record<string, number> = {};
  if (context.timings?.context_build_ms) timingBundle.context_build_ms = context.timings.context_build_ms;
  if (context.timings?.memory_recall_ms) timingBundle.memory_recall_ms = context.timings.memory_recall_ms;
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
    host_failover_attempts: output?.host_failover_attempts,
    host_failover_recovered: output?.host_failover_recovered,
    host_failover_category: output?.host_failover_category,
    host_failover_source: output?.host_failover_source,
    host_failover_status_code: output?.host_failover_status_code,
    host_failover_envelopes: output?.host_failover_envelopes,
    tool_retry_attempts: output?.tool_retry_attempts,
    tool_outcome_verification_forced: output?.tool_outcome_verification_forced,
    tool_loop_breaker_triggered: output?.tool_loop_breaker_triggered,
    tool_loop_breaker_reason: output?.tool_loop_breaker_reason,
    memory_extraction_error: output?.memory_extraction_error,
    timings: Object.keys(timingBundle).length > 0 ? timingBundle : undefined,
    error_code: params.errorMessage || (output?.status === 'error' ? output?.error : undefined)
  });

  if (context.timings?.context_build_ms) {
    recordStageLatency('context_build', context.timings.context_build_ms, stageSource);
  }
  if (context.timings?.memory_recall_ms) {
    recordStageLatency('memory_recall', context.timings.memory_recall_ms, stageSource);
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
