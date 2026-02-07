import path from 'path';
import fs from 'fs';
import { DATA_DIR, MODEL_CONFIG_PATH } from './paths.js';
import { loadJson, saveJson } from './utils.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { TokenEstimateConfig } from './types.js';
import { logger } from './logger.js';

export interface ModelOverride {
  context_window?: number;
  max_output_tokens?: number;
  temperature?: number;
  tokens_per_char?: number;
  tokens_per_message?: number;
  tokens_per_request?: number;
}

export interface ModelPricing {
  prompt_per_million: number;
  completion_per_million: number;
  currency?: 'USD';
}

export interface ModelConfig {
  model: string;
  allowlist: string[];
  overrides?: Record<string, ModelOverride>;
  pricing?: Record<string, ModelPricing>;
  per_group?: Record<string, { model: string }>;
  per_user?: Record<string, { model: string }>;
  updated_at?: string;
}

const runtime = loadRuntimeConfig();

const MODEL_CAPABILITIES_PATH = path.join(DATA_DIR, 'model-capabilities.json');
const CAPABILITIES_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ModelCapabilities {
  context_length: number;
  max_completion_tokens?: number;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

interface ModelCapabilitiesCache {
  models: Record<string, ModelCapabilities>;
  fetched_at: string;
}

let capabilitiesCache: ModelCapabilitiesCache | null = null;
let capabilitiesFetchPromise: Promise<void> | null = null;

export function loadModelRegistry(defaultModel: string): ModelConfig {
  const fallback: ModelConfig = {
    model: defaultModel,
    allowlist: []
  };
  const config = loadJson<ModelConfig>(MODEL_CONFIG_PATH, fallback);
  config.model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : defaultModel;
  config.allowlist = Array.isArray(config.allowlist)
    ? config.allowlist.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return config;
}

export function saveModelRegistry(config: ModelConfig): void {
  saveJson(MODEL_CONFIG_PATH, config);
}

export function resolveModel(params: {
  groupFolder: string;
  userId?: string | null;
  defaultModel: string;
}): { model: string; override?: ModelOverride } {
  const config = loadModelRegistry(params.defaultModel);
  let model = config.model;

  const groupOverride = config.per_group?.[params.groupFolder];
  if (groupOverride?.model) {
    model = groupOverride.model;
  }
  if (params.userId) {
    const userOverride = config.per_user?.[params.userId];
    if (userOverride?.model) {
      model = userOverride.model;
    }
  }

  if (config.allowlist.length > 0 && !config.allowlist.includes(model)) {
    model = config.model;
  }

  const override = config.overrides?.[model];
  return { model, override };
}

export function getTokenEstimateConfig(override?: ModelOverride): TokenEstimateConfig {
  const fallbackChar = runtime.host.tokenEstimate.tokensPerChar;
  const fallbackMessage = runtime.host.tokenEstimate.tokensPerMessage;
  const fallbackRequest = runtime.host.tokenEstimate.tokensPerRequest;

  const tokensPerChar = Number.isFinite(override?.tokens_per_char)
    ? Number(override?.tokens_per_char)
    : fallbackChar;
  const tokensPerMessage = Number.isFinite(override?.tokens_per_message)
    ? Number(override?.tokens_per_message)
    : fallbackMessage;
  const tokensPerRequest = Number.isFinite(override?.tokens_per_request)
    ? Number(override?.tokens_per_request)
    : fallbackRequest;

  return {
    tokens_per_char: Math.max(0, tokensPerChar),
    tokens_per_message: Math.max(0, tokensPerMessage),
    tokens_per_request: Math.max(0, tokensPerRequest)
  };
}

export function getModelPricing(config: ModelConfig, model: string): ModelPricing | null {
  const pricing = config.pricing?.[model];
  if (!pricing) return null;
  if (!Number.isFinite(pricing.prompt_per_million) || !Number.isFinite(pricing.completion_per_million)) {
    return null;
  }
  return {
    prompt_per_million: Number(pricing.prompt_per_million),
    completion_per_million: Number(pricing.completion_per_million),
    currency: pricing.currency || 'USD'
  };
}

/**
 * Load model capabilities from cache file
 */
function loadCapabilitiesCache(): ModelCapabilitiesCache | null {
  try {
    if (!fs.existsSync(MODEL_CAPABILITIES_PATH)) return null;
    const raw = fs.readFileSync(MODEL_CAPABILITIES_PATH, 'utf-8');
    const data = JSON.parse(raw) as ModelCapabilitiesCache;

    // Check if cache is still valid
    if (data.fetched_at) {
      const fetchedAt = new Date(data.fetched_at).getTime();
      if (Date.now() - fetchedAt < CAPABILITIES_CACHE_TTL_MS) {
        return data;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save model capabilities to cache file
 */
function saveCapabilitiesCache(cache: ModelCapabilitiesCache): void {
  try {
    fs.mkdirSync(path.dirname(MODEL_CAPABILITIES_PATH), { recursive: true });
    fs.writeFileSync(MODEL_CAPABILITIES_PATH, JSON.stringify(cache, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to save model capabilities cache');
  }
}

/**
 * Fetch model capabilities from OpenRouter API
 */
async function fetchModelCapabilities(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    logger.warn('Cannot fetch model capabilities: OPENROUTER_API_KEY not set');
    return;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': runtime.agent.openrouter.siteUrl || 'https://github.com/dotsetlabs/dotclaw',
        'X-Title': runtime.agent.openrouter.siteName || 'DotClaw'
      }
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Failed to fetch model capabilities from OpenRouter');
      return;
    }

    const data = await response.json() as {
      data: Array<{
        id: string;
        context_length?: number;
        top_provider?: {
          max_completion_tokens?: number;
        };
        pricing?: {
          prompt?: string;
          completion?: string;
        };
      }>;
    };

    const models: Record<string, ModelCapabilities> = {};

    for (const model of data.data) {
      if (!model.id || !model.context_length) continue;

      models[model.id] = {
        context_length: model.context_length,
        max_completion_tokens: model.top_provider?.max_completion_tokens,
        pricing: model.pricing?.prompt && model.pricing?.completion
          ? { prompt: model.pricing.prompt, completion: model.pricing.completion }
          : undefined
      };
    }

    capabilitiesCache = {
      models,
      fetched_at: new Date().toISOString()
    };

    saveCapabilitiesCache(capabilitiesCache);
    logger.info({ modelCount: Object.keys(models).length }, 'Model capabilities updated');
  } catch (err) {
    logger.warn({ err }, 'Failed to fetch model capabilities');
  }
}

/**
 * Ensure model capabilities are loaded (from cache or API)
 */
async function ensureCapabilities(): Promise<void> {
  // Return if we already have valid cache
  if (capabilitiesCache) return;

  // Try loading from file first
  const cached = loadCapabilitiesCache();
  if (cached) {
    capabilitiesCache = cached;
    return;
  }

  // Fetch from API (deduplicate concurrent fetches)
  if (!capabilitiesFetchPromise) {
    capabilitiesFetchPromise = fetchModelCapabilities().finally(() => {
      capabilitiesFetchPromise = null;
    });
  }

  await capabilitiesFetchPromise;
}

/**
 * Get capabilities for a specific model
 * Returns default values if not found
 */
export async function getModelCapabilities(model: string): Promise<ModelCapabilities> {
  await ensureCapabilities();

  const cached = capabilitiesCache?.models[model];
  if (cached) {
    return cached;
  }

  // Generous fallback — most modern models are 128K+
  return {
    context_length: 128_000,
    max_completion_tokens: undefined,
  };
}

