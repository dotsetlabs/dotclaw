import { buildHybridMemoryRecall } from './memory-recall.js';
import { buildUserProfile, getMemoryStats } from './memory-store.js';
import { loadPersonalizedBehaviorConfig } from './personalization.js';
import { getEffectiveToolPolicy, mergeToolPolicyDeny, ToolPolicy } from './tool-policy.js';
import { applyToolBudgets } from './tool-budgets.js';
import { getToolReliability } from './db.js';
import { resolveModel, loadModelRegistry, getTokenEstimateConfig, getModelPricing, getModelCapabilities, ModelCapabilities } from './model-registry.js';
import { loadRuntimeConfig } from './runtime-config.js';

export type AgentContext = {
  memoryRecall: string[];
  userProfile: string | null;
  memoryStats: { total: number; user: number; group: number; global: number };
  behaviorConfig: Record<string, unknown>;
  toolPolicy: ToolPolicy;
  toolReliability: Array<{ name: string; success_rate: number; count: number; avg_duration_ms: number | null }>;
  resolvedModel: { model: string; override?: { context_window?: number; max_output_tokens?: number; temperature?: number } };
  modelRegistry: ReturnType<typeof loadModelRegistry>;
  modelPricing: ReturnType<typeof getModelPricing>;
  tokenEstimate: ReturnType<typeof getTokenEstimateConfig>;
  modelCapabilities: ModelCapabilities;
  dynamicMemoryBudget: number;
  timings: {
    context_build_ms?: number;
    memory_recall_ms?: number;
  };
};

/**
 * Calculate dynamic memory token budget based on model capabilities
 * Reserves 15% of available context for memories (min 800, max 4000)
 */
function calculateMemoryBudget(
  modelCapabilities: ModelCapabilities,
  maxOutputTokens: number,
  configuredMax: number
): number {
  const contextWindow = modelCapabilities.context_length;
  const outputReserve = modelCapabilities.max_completion_tokens || maxOutputTokens;

  // Available tokens after reserving output space
  const availableTokens = contextWindow - outputReserve;

  // Reserve 15% for memories
  const memoryShare = 0.15;
  const calculatedBudget = Math.floor(availableTokens * memoryShare);

  // Clamp between 800 and 4000, and also respect configured max
  return Math.min(
    Math.max(800, Math.min(4000, calculatedBudget)),
    configuredMax
  );
}

export function applyToolAllowOverride(policy: ToolPolicy, toolAllow?: string[]): ToolPolicy {
  if (!Array.isArray(toolAllow) || toolAllow.length === 0) return policy;

  const requested = Array.from(new Set(
    toolAllow
      .map(item => item.trim())
      .filter(Boolean)
  ));
  const requestedLower = new Set(requested.map(item => item.toLowerCase()));

  if (Array.isArray(policy.allow)) {
    const filtered = policy.allow.filter(name => requestedLower.has(name.toLowerCase()));
    return { ...policy, allow: filtered };
  }

  // If policy has no explicit allow-list, honor requested tools directly.
  return { ...policy, allow: requested };
}

export async function buildAgentContext(params: {
  groupFolder: string;
  userId?: string | null;
  recallQuery: string;
  recallMaxResults: number;
  recallMaxTokens: number;
  toolAllow?: string[];
  toolDeny?: string[];
  recallEnabled?: boolean;
  messageText?: string;
}): Promise<AgentContext> {
  const startedAt = Date.now();
  const runtime = loadRuntimeConfig();
  // Use routing.model as the base — model.json per_user/per_group overrides take priority
  const defaultModel = runtime.host.routing.model || runtime.host.defaultModel;
  const modelRegistry = loadModelRegistry(defaultModel);
  const resolvedModel = resolveModel({
    groupFolder: params.groupFolder,
    userId: params.userId ?? null,
    defaultModel,
    messageText: params.messageText
  });
  const tokenEstimate = getTokenEstimateConfig(resolvedModel.override);
  const modelPricing = getModelPricing(modelRegistry, resolvedModel.model);

  // Get model capabilities (auto-detected from OpenRouter or defaults)
  const modelCapabilities = await getModelCapabilities(resolvedModel.model);

  // Calculate dynamic memory budget based on model context window
  const dynamicMemoryBudget = calculateMemoryBudget(
    modelCapabilities,
    runtime.agent.context.maxOutputTokens,
    params.recallMaxTokens
  );

  let memoryRecall: string[] = [];
  let memoryRecallMs: number | undefined;
  if (params.recallEnabled !== false && params.recallMaxResults > 0 && params.recallMaxTokens > 0) {
    const recallStart = Date.now();
    memoryRecall = await buildHybridMemoryRecall({
      groupFolder: params.groupFolder,
      userId: params.userId ?? null,
      query: params.recallQuery,
      maxResults: params.recallMaxResults,
      maxTokens: dynamicMemoryBudget,
      minScore: runtime.host.memory.recall.minScore
    });
    memoryRecallMs = Date.now() - recallStart;
  }

  const userProfile = buildUserProfile({
    groupFolder: params.groupFolder,
    userId: params.userId ?? null
  });

  const memoryStats = getMemoryStats({
    groupFolder: params.groupFolder,
    userId: params.userId ?? null
  });

  const behaviorConfig = loadPersonalizedBehaviorConfig({
    groupFolder: params.groupFolder,
    userId: params.userId ?? null
  }) as unknown as Record<string, unknown>;

  const baseToolPolicy = getEffectiveToolPolicy({
    groupFolder: params.groupFolder,
    userId: params.userId ?? null
  });
  const budgetedToolPolicy = applyToolBudgets({
    groupFolder: params.groupFolder,
    userId: params.userId ?? null,
    toolPolicy: baseToolPolicy
  });
  let toolPolicy = params.toolDeny && params.toolDeny.length > 0
    ? mergeToolPolicyDeny(budgetedToolPolicy, params.toolDeny)
    : budgetedToolPolicy;

  toolPolicy = applyToolAllowOverride(toolPolicy, params.toolAllow);

  const toolReliability = getToolReliability({ groupFolder: params.groupFolder, limit: 200 })
    .map(row => ({
      name: row.tool_name,
      success_rate: row.total > 0 ? row.ok_count / row.total : 0,
      count: row.total,
      avg_duration_ms: row.avg_duration_ms
    }));

  return {
    memoryRecall,
    userProfile,
    memoryStats,
    behaviorConfig,
    toolPolicy,
    toolReliability,
    resolvedModel,
    modelRegistry,
    modelPricing,
    tokenEstimate,
    modelCapabilities,
    dynamicMemoryBudget,
    timings: {
      context_build_ms: Date.now() - startedAt,
      memory_recall_ms: memoryRecallMs
    }
  };
}
