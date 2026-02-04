import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { loadJson, saveJson } from './utils.js';

export type ResponseStyle = 'concise' | 'balanced' | 'detailed';

export interface BehaviorConfig {
  tool_calling_bias: number;
  memory_importance_threshold: number;
  response_style: ResponseStyle;
  caution_bias: number;
  last_updated: string;
  notes?: string;
}

const DEFAULT_CONFIG: BehaviorConfig = {
  tool_calling_bias: 0.5,
  memory_importance_threshold: 0.55,
  response_style: 'balanced',
  caution_bias: 0.5,
  last_updated: new Date(0).toISOString()
};

const HOME_DIR = process.env.HOME || '/Users/user';
const LEGACY_CONFIG_PATH = path.join(DATA_DIR, 'behavior.json');
const DEFAULT_CONFIG_PATH = path.join(HOME_DIR, '.config', 'dotclaw', 'behavior.json');

export function getBehaviorConfigPath(): string {
  const override = process.env.DOTCLAW_BEHAVIOR_CONFIG_PATH;
  if (override && override.trim()) return override.trim();
  if (fs.existsSync(LEGACY_CONFIG_PATH)) return LEGACY_CONFIG_PATH;
  return DEFAULT_CONFIG_PATH;
}

export function loadBehaviorConfig(): BehaviorConfig {
  const configPath = getBehaviorConfigPath();
  const raw = loadJson<Partial<BehaviorConfig>>(configPath, {});
  const merged: BehaviorConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    tool_calling_bias: clamp(raw.tool_calling_bias ?? DEFAULT_CONFIG.tool_calling_bias),
    memory_importance_threshold: clamp(raw.memory_importance_threshold ?? DEFAULT_CONFIG.memory_importance_threshold),
    caution_bias: clamp(raw.caution_bias ?? DEFAULT_CONFIG.caution_bias),
    response_style: validateStyle(raw.response_style) ?? DEFAULT_CONFIG.response_style,
    last_updated: raw.last_updated || DEFAULT_CONFIG.last_updated
  };
  return merged;
}

export function saveBehaviorConfig(config: BehaviorConfig): void {
  saveJson(getBehaviorConfigPath(), config);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function validateStyle(style?: string): ResponseStyle | null {
  if (style === 'concise' || style === 'balanced' || style === 'detailed') return style;
  return null;
}

export function adjustBehaviorConfig(config: BehaviorConfig, updates: Partial<BehaviorConfig>): BehaviorConfig {
  const next: BehaviorConfig = {
    ...config,
    ...updates,
    tool_calling_bias: clamp(updates.tool_calling_bias ?? config.tool_calling_bias),
    memory_importance_threshold: clamp(updates.memory_importance_threshold ?? config.memory_importance_threshold),
    caution_bias: clamp(updates.caution_bias ?? config.caution_bias),
    response_style: validateStyle(updates.response_style) ?? config.response_style,
    last_updated: new Date().toISOString()
  };
  return next;
}
