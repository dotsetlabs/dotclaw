import { BehaviorConfig, ResponseStyle, loadBehaviorConfig } from './behavior-config.js';
import { listPreferenceMemories, PreferenceMemory } from './memory-store.js';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CACHE_TTL_MS = parsePositiveInt(process.env.DOTCLAW_PERSONALIZATION_CACHE_MS, 300000);
const cache = new Map<string, { config: BehaviorConfig; expiresAt: number }>();

function pruneCache(): void {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp(value);
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return clamp(parsed);
  }
  return null;
}

function parseResponseStyle(value: unknown): ResponseStyle | null {
  if (value === 'concise' || value === 'balanced' || value === 'detailed') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (normalized.includes('concise') || normalized.includes('brief') || normalized.includes('short') || normalized.includes('succinct')) {
      return 'concise';
    }
    if (normalized.includes('detailed') || normalized.includes('verbose') || normalized.includes('step') || normalized.includes('thorough')) {
      return 'detailed';
    }
    if (normalized.includes('balanced')) {
      return 'balanced';
    }
  }
  return null;
}

function tagValue(tags: string[], key: string): string | null {
  const target = key.toLowerCase();
  for (const tag of tags) {
    const normalized = tag.toLowerCase();
    if (normalized.startsWith(`${target}=`)) return tag.slice(target.length + 1).trim();
    if (normalized.startsWith(`${target}:`)) return tag.slice(target.length + 1).trim();
  }
  return null;
}

function extractResponseStyle(memory: PreferenceMemory): ResponseStyle | null {
  const meta = memory.metadata || {};
  const fromMeta = parseResponseStyle(meta.response_style ?? meta.responseStyle ?? meta.style ?? meta.value);
  if (fromMeta) return fromMeta;
  const tag = tagValue(memory.tags, 'response_style') || tagValue(memory.tags, 'style');
  const fromTag = parseResponseStyle(tag);
  if (fromTag) return fromTag;
  return parseResponseStyle(memory.content);
}

function extractBias(memory: PreferenceMemory, keys: string[]): number | null {
  const meta = memory.metadata || {};
  for (const key of keys) {
    const value = parseNumber((meta as Record<string, unknown>)[key]);
    if (value !== null) return value;
  }
  const tag = tagValue(memory.tags, keys[0]);
  const fromTag = parseNumber(tag);
  if (fromTag !== null) return fromTag;
  return null;
}

function inferToolBias(content: string): number | null {
  const text = content.toLowerCase();
  if (text.includes('avoid tools') || text.includes('no tools') || text.includes('without tools')) return 0.3;
  if (text.includes('ask before using tools') || text.includes('ask before browsing')) return 0.4;
  if (text.includes('use tools') || text.includes('be proactive') || text.includes('call tools')) return 0.7;
  return null;
}

function inferCautionBias(content: string): number | null {
  const text = content.toLowerCase();
  if (text.includes('be cautious') || text.includes('double-check') || text.includes('verify')) return 0.7;
  if (text.includes('be bold') || text.includes('decisive') || text.includes('take initiative')) return 0.35;
  return null;
}

function inferMemoryThreshold(content: string): number | null {
  const text = content.toLowerCase();
  if (text.includes('remember more') || text.includes('store more') || text.includes('keep more')) return 0.45;
  if (text.includes('remember less') || text.includes('only important') || text.includes('don\'t store')) return 0.7;
  return null;
}

function extractOverrides(memories: PreferenceMemory[]): Partial<BehaviorConfig> {
  const overrides: Partial<BehaviorConfig> = {};
  const seen = new Set<string>();

  for (const memory of memories) {
    const key = memory.conflict_key;
    if (!key || seen.has(key)) continue;

    if (key === 'response_style') {
      const style = extractResponseStyle(memory);
      if (style) {
        overrides.response_style = style;
        seen.add(key);
      }
      continue;
    }

    if (key === 'tool_calling_bias') {
      const bias = extractBias(memory, ['tool_calling_bias', 'tool_bias', 'bias']);
      const inferred = bias ?? inferToolBias(memory.content);
      if (inferred !== null) {
        overrides.tool_calling_bias = clamp(inferred);
        seen.add(key);
      }
      continue;
    }

    if (key === 'caution_bias') {
      const bias = extractBias(memory, ['caution_bias', 'caution', 'bias']);
      const inferred = bias ?? inferCautionBias(memory.content);
      if (inferred !== null) {
        overrides.caution_bias = clamp(inferred);
        seen.add(key);
      }
      continue;
    }

    if (key === 'memory_importance_threshold') {
      const threshold = extractBias(memory, ['memory_importance_threshold', 'memory_threshold', 'threshold']);
      const inferred = threshold ?? inferMemoryThreshold(memory.content);
      if (inferred !== null) {
        overrides.memory_importance_threshold = clamp(inferred);
        seen.add(key);
      }
      continue;
    }
  }

  return overrides;
}

export function loadPersonalizedBehaviorConfig(params: { groupFolder: string; userId?: string | null }): BehaviorConfig {
  const cacheKey = `${params.groupFolder}:${params.userId || 'none'}`;
  if (CACHE_TTL_MS > 0) {
    pruneCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.config;
    }
  }

  const base = loadBehaviorConfig();
  const memories = listPreferenceMemories({
    groupFolder: params.groupFolder,
    userId: params.userId || null,
    limit: 100
  });

  const groupPrefs = memories.filter(memory => memory.scope !== 'user');
  const userPrefs = memories.filter(memory => memory.scope === 'user');

  const merged: BehaviorConfig = {
    ...base,
    ...extractOverrides(groupPrefs),
    ...extractOverrides(userPrefs)
  };

  if (CACHE_TTL_MS > 0) {
    cache.set(cacheKey, { config: merged, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  return merged;
}
