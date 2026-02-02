import fs from 'fs';
import path from 'path';

export function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Return default on error
  }
  return defaultValue;
}

export function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function isSafeGroupFolder(folder: string, groupsDir: string): boolean {
  if (!folder || !/^[a-z0-9-]+$/.test(folder)) return false;
  const base = path.resolve(groupsDir);
  const resolved = path.resolve(base, folder);
  return resolved.startsWith(base + path.sep);
}

export interface ModelConfig {
  model: string;
  allowlist: string[];
  updated_at?: string;
}

export function loadModelConfig(filePath: string, defaultModel: string): ModelConfig {
  const fallback: ModelConfig = {
    model: defaultModel,
    allowlist: []
  };
  const config = loadJson<ModelConfig>(filePath, fallback);
  const model = typeof config.model === 'string' && config.model.trim() ? config.model.trim() : defaultModel;
  const allowlist = Array.isArray(config.allowlist)
    ? config.allowlist.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
  return {
    model,
    allowlist,
    updated_at: config.updated_at
  };
}

export function saveModelConfig(filePath: string, config: ModelConfig): void {
  saveJson(filePath, config);
}

export function isModelAllowed(config: ModelConfig, model: string): boolean {
  if (config.allowlist.length === 0) return true;
  return config.allowlist.includes(model);
}
