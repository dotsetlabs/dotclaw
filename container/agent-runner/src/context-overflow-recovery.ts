export type ContextMessageLike = {
  role: 'user' | 'assistant';
  content: string;
};

export type ContextOverflowRecoveryPlan = {
  toCompact: ContextMessageLike[];
  toKeep: ContextMessageLike[];
  retryInput: Array<{ role: 'user' | 'assistant'; content: string }>;
};

export function buildContextOverflowRecoveryPlan(params: {
  contextMessages: ContextMessageLike[];
  emergencySummary?: string | null;
  keepRecentCount?: number;
}): ContextOverflowRecoveryPlan {
  const keepRecentCount = Number.isFinite(params.keepRecentCount)
    ? Math.max(1, Math.floor(Number(params.keepRecentCount)))
    : 4;
  const contextMessages = Array.isArray(params.contextMessages)
    ? params.contextMessages
    : [];

  const keepStart = Math.max(0, contextMessages.length - keepRecentCount);
  const toCompact = contextMessages.slice(0, keepStart);
  const toKeep = contextMessages.slice(keepStart);
  const emergencySummary = (params.emergencySummary || '').trim();

  const retryInput = emergencySummary
    ? [{ role: 'user' as const, content: `[Previous conversation summary: ${emergencySummary}]` },
      ...toKeep.map(msg => ({ role: msg.role, content: msg.content }))]
    : toKeep.map(msg => ({ role: msg.role, content: msg.content }));

  return {
    toCompact,
    toKeep,
    retryInput
  };
}
