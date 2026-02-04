import path from 'path';
import { DATA_DIR } from './config.js';
import { loadJson, saveJson } from './utils.js';
import { TokenEstimateConfig } from './types.js';

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

const MODEL_CONFIG_PATH = path.join(DATA_DIR, 'model.json');

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
  const fallbackChar = parseFloat(process.env.DOTCLAW_TOKENS_PER_CHAR || '0.25');
  const fallbackMessage = parseFloat(process.env.DOTCLAW_TOKENS_PER_MESSAGE || '3');
  const fallbackRequest = parseFloat(process.env.DOTCLAW_TOKENS_PER_REQUEST || '0');

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
