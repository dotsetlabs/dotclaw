import path from 'path';
import { pathToFileURL } from 'url';
import { buildHybridMemoryRecall } from './memory-recall.js';
import { buildUserProfile, getMemoryStats } from './memory-store.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { getDotclawHome } from './paths.js';
import { logger } from './logger.js';

export type MemoryBackend = {
  buildRecall(params: {
    groupFolder: string;
    userId?: string | null;
    query: string;
    maxResults: number;
    maxTokens: number;
    minScore: number;
  }): Promise<string[]>;
  buildUserProfile(params: { groupFolder: string; userId?: string | null }): string | null;
  getStats(params: { groupFolder: string; userId?: string | null }): { total: number; user: number; group: number; global: number };
};

export const builtinMemoryBackend: MemoryBackend = {
  async buildRecall(params) {
    return buildHybridMemoryRecall(params);
  },
  buildUserProfile(params) {
    return buildUserProfile(params);
  },
  getStats(params) {
    return getMemoryStats(params);
  }
};

let cachedMemoryBackend: { key: string; backend: MemoryBackend } | null = null;

function isMemoryBackend(value: unknown): value is MemoryBackend {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MemoryBackend>;
  return typeof candidate.buildRecall === 'function'
    && typeof candidate.buildUserProfile === 'function'
    && typeof candidate.getStats === 'function';
}

function resolveBackendModulePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  if (path.isAbsolute(trimmed)) return trimmed;
  return path.join(getDotclawHome(), trimmed);
}

function safeBackend(modulePath: string, backend: MemoryBackend): MemoryBackend {
  return {
    async buildRecall(params) {
      try {
        return await backend.buildRecall(params);
      } catch (err) {
        logger.warn({
          modulePath,
          error: err instanceof Error ? err.message : String(err)
        }, 'Custom memory backend recall failed; using builtin backend');
        return builtinMemoryBackend.buildRecall(params);
      }
    },
    buildUserProfile(params) {
      try {
        return backend.buildUserProfile(params);
      } catch (err) {
        logger.warn({
          modulePath,
          error: err instanceof Error ? err.message : String(err)
        }, 'Custom memory backend profile failed; using builtin backend');
        return builtinMemoryBackend.buildUserProfile(params);
      }
    },
    getStats(params) {
      try {
        return backend.getStats(params);
      } catch (err) {
        logger.warn({
          modulePath,
          error: err instanceof Error ? err.message : String(err)
        }, 'Custom memory backend stats failed; using builtin backend');
        return builtinMemoryBackend.getStats(params);
      }
    }
  };
}

export async function resolveMemoryBackend(): Promise<MemoryBackend> {
  const config = loadRuntimeConfig().host.memory.backend;
  if (config.strategy !== 'module') {
    return builtinMemoryBackend;
  }

  const modulePath = resolveBackendModulePath(config.modulePath || '');
  if (!modulePath) {
    return builtinMemoryBackend;
  }

  const cacheKey = `module:${modulePath}`;
  if (cachedMemoryBackend?.key === cacheKey) {
    return cachedMemoryBackend.backend;
  }

  try {
    const imported = await import(pathToFileURL(modulePath).href);
    const candidate = imported.default ?? imported.memoryBackend ?? imported;
    if (!isMemoryBackend(candidate)) {
      logger.warn({ modulePath }, 'Custom memory backend module has invalid shape; using builtin backend');
      return builtinMemoryBackend;
    }
    const backend = safeBackend(modulePath, candidate);
    cachedMemoryBackend = { key: cacheKey, backend };
    logger.info({ modulePath }, 'Custom memory backend loaded');
    return backend;
  } catch (err) {
    logger.warn({
      modulePath,
      error: err instanceof Error ? err.message : String(err)
    }, 'Failed to load custom memory backend; using builtin backend');
    return builtinMemoryBackend;
  }
}

export function resetMemoryBackendCacheForTests(): void {
  cachedMemoryBackend = null;
}
