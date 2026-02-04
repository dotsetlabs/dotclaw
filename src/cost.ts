export function computeCostUSD(
  tokensPrompt: number | undefined,
  tokensCompletion: number | undefined,
  pricing: { prompt_per_million: number; completion_per_million: number } | null
): { prompt: number; completion: number; total: number } | null {
  if (!pricing) return null;
  const promptTokens = Number.isFinite(tokensPrompt) ? Number(tokensPrompt) : 0;
  const completionTokens = Number.isFinite(tokensCompletion) ? Number(tokensCompletion) : 0;
  const prompt = (promptTokens / 1_000_000) * pricing.prompt_per_million;
  const completion = (completionTokens / 1_000_000) * pricing.completion_per_million;
  const total = prompt + completion;
  return { prompt, completion, total };
}
