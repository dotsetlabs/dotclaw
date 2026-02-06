import { loadRuntimeConfig } from './runtime-config.js';
import type { NewMessage } from './types.js';

export type TaskProfile = 'fast' | 'standard' | 'deep' | 'background';

export type RoutingDecision = {
  profile: TaskProfile;
  reason: string;
  shouldRunClassifier: boolean;
  shouldBackground: boolean;
  estimatedMinutes?: number;
  modelOverride?: string;
  maxOutputTokens?: number;
  maxToolSteps?: number;
  toolAllow?: string[];
  toolDeny?: string[];
  recallMaxResults?: number;
  recallMaxTokens?: number;
  enablePlanner: boolean;
  enableResponseValidation: boolean;
  responseValidationMaxRetries?: number;
  enableMemoryRecall: boolean;
  enableMemoryExtraction: boolean;
  progress: {
    enabled: boolean;
    initialMs: number;
    intervalMs: number;
    maxUpdates: number;
    messages: string[];
  };
};

const GREETING_REGEX = /^(hi|hello|hey|yo|sup|what's up|who are you|what can you do|help|thanks|thank you)[!.?]*$/i;

function estimateMinutes(textLength: number, multiplier = 1): number {
  if (!Number.isFinite(textLength) || textLength <= 0) return 1;
  const base = Math.max(1, Math.ceil(textLength / 800));
  return Math.min(60, Math.max(1, Math.round(base * multiplier)));
}

function resolveProgressConfig(params: {
  defaultProgress: RoutingDecision['progress'];
  override?: Partial<RoutingDecision['progress']>;
}): RoutingDecision['progress'] {
  const override = params.override || {};
  return {
    enabled: typeof override.enabled === 'boolean' ? override.enabled : params.defaultProgress.enabled,
    initialMs: Number.isFinite(override.initialMs) ? Math.max(0, Number(override.initialMs)) : params.defaultProgress.initialMs,
    intervalMs: Number.isFinite(override.intervalMs) ? Math.max(0, Number(override.intervalMs)) : params.defaultProgress.intervalMs,
    maxUpdates: Number.isFinite(override.maxUpdates) ? Math.max(0, Math.floor(Number(override.maxUpdates))) : params.defaultProgress.maxUpdates,
    messages: Array.isArray(override.messages) && override.messages.length > 0
      ? override.messages.map(item => String(item))
      : params.defaultProgress.messages
  };
}

export function routeRequest(params: {
  prompt: string;
  lastMessage: NewMessage;
}): RoutingDecision {
  const runtime = loadRuntimeConfig();
  const routing = runtime.host.routing;
  const defaultProgress: RoutingDecision['progress'] = {
    enabled: runtime.host.progress.enabled,
    initialMs: runtime.host.progress.initialMs,
    intervalMs: runtime.host.progress.intervalMs,
    maxUpdates: runtime.host.progress.maxUpdates,
    messages: runtime.host.progress.messages
  };
  const fallbackProfile = routing.profiles?.standard;
  const fallbackRecallMaxResults = typeof fallbackProfile?.recallMaxResults === 'number'
    ? Math.max(0, Math.floor(fallbackProfile.recallMaxResults))
    : runtime.host.memory.recall.maxResults;
  const fallbackRecallMaxTokens = typeof fallbackProfile?.recallMaxTokens === 'number'
    ? Math.max(0, Math.floor(fallbackProfile.recallMaxTokens))
    : runtime.host.memory.recall.maxTokens;
  const fallbackValidationRetries = typeof fallbackProfile?.responseValidationMaxRetries === 'number'
    ? Math.max(0, Math.floor(fallbackProfile.responseValidationMaxRetries))
    : runtime.agent.responseValidation.maxRetries;
  if (!routing.enabled) {
    return {
      profile: 'standard',
      reason: 'routing disabled',
      shouldRunClassifier: false,
      shouldBackground: false,
      estimatedMinutes: undefined,
      modelOverride: fallbackProfile?.model,
      maxOutputTokens: fallbackProfile?.maxOutputTokens,
      maxToolSteps: fallbackProfile?.maxToolSteps,
      toolAllow: fallbackProfile?.toolAllow,
      toolDeny: fallbackProfile?.toolDeny,
      recallMaxResults: fallbackRecallMaxResults,
      recallMaxTokens: fallbackRecallMaxTokens,
      enablePlanner: fallbackProfile?.enablePlanner ?? true,
      enableResponseValidation: fallbackProfile?.enableValidation ?? true,
      responseValidationMaxRetries: fallbackValidationRetries,
      enableMemoryRecall: fallbackProfile?.enableMemoryRecall ?? true,
      enableMemoryExtraction: fallbackProfile?.enableMemoryExtraction ?? true,
      progress: resolveProgressConfig({ defaultProgress, override: fallbackProfile?.progress })
    };
  }
  const text = params.lastMessage?.content || params.prompt || '';
  const trimmed = text.trim();
  const length = trimmed.length;

  const isGreeting = GREETING_REGEX.test(trimmed);
  let profile: TaskProfile = 'standard';
  let reason = 'default';

  if (isGreeting || length <= routing.maxFastChars) {
    profile = 'fast';
    reason = isGreeting ? 'greeting' : 'short prompt';
  } else if (length >= routing.maxStandardChars) {
    profile = 'deep';
    reason = 'prompt length';
  }

  const profileConfig = routing.profiles?.[profile] || routing.profiles?.standard;
  const recallMaxResults = typeof profileConfig?.recallMaxResults === 'number'
    ? Math.max(0, Math.floor(profileConfig.recallMaxResults))
    : runtime.host.memory.recall.maxResults;
  const recallMaxTokens = typeof profileConfig?.recallMaxTokens === 'number'
    ? Math.max(0, Math.floor(profileConfig.recallMaxTokens))
    : runtime.host.memory.recall.maxTokens;
  const responseValidationMaxRetries = typeof profileConfig?.responseValidationMaxRetries === 'number'
    ? Math.max(0, Math.floor(profileConfig.responseValidationMaxRetries))
    : runtime.agent.responseValidation.maxRetries;
  const progress = resolveProgressConfig({
    defaultProgress,
    override: profileConfig?.progress
  });

  // Background is never assigned by the router — only the LLM classifier or
  // planner probe can escalate to background.  Keyword matching was removed
  // because it produced too many false positives on common words.
  const shouldBackground = false;
  const shouldRunClassifier = routing.classifierFallback.enabled && profile !== 'fast';

  const estimatedMinutes = profile === 'deep'
    ? estimateMinutes(length)
    : undefined;

  return {
    profile,
    reason,
    shouldRunClassifier,
    shouldBackground,
    estimatedMinutes,
    modelOverride: profileConfig?.model,
    maxOutputTokens: profileConfig?.maxOutputTokens,
    maxToolSteps: profileConfig?.maxToolSteps,
    toolAllow: profileConfig?.toolAllow,
    toolDeny: profileConfig?.toolDeny,
    recallMaxResults,
    recallMaxTokens,
    enablePlanner: profileConfig?.enablePlanner ?? true,
    enableResponseValidation: profileConfig?.enableValidation ?? true,
    responseValidationMaxRetries,
    enableMemoryRecall: profileConfig?.enableMemoryRecall ?? true,
    enableMemoryExtraction: profileConfig?.enableMemoryExtraction ?? true,
    progress
  };
}

export function routePrompt(prompt: string): RoutingDecision {
  const message: NewMessage = {
    id: 'system',
    chat_jid: 'system',
    sender: 'system',
    sender_name: 'system',
    content: prompt,
    timestamp: new Date().toISOString()
  };
  return routeRequest({
    prompt,
    lastMessage: message
  });
}
