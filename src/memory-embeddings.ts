import { countMemoriesMissingEmbeddings, listMemoriesMissingEmbeddings, updateMemoryEmbedding } from './memory-store.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { logger } from './logger.js';

const runtime = loadRuntimeConfig();
const config = runtime.host.memory.embeddings;

export const EMBEDDINGS_ENABLED = config.enabled;
export const EMBEDDING_MODEL = config.model;
export const EMBEDDING_BATCH_SIZE = config.batchSize;
export const EMBEDDING_MIN_ITEMS = config.minItems;
export const EMBEDDING_MIN_QUERY_CHARS = config.minQueryChars;
export const EMBEDDING_MAX_CANDIDATES = config.maxCandidates;
export const EMBEDDING_WEIGHT = config.weight;
export const EMBEDDING_INTERVAL_MS = config.intervalMs;
export const EMBEDDING_MAX_BACKLOG = config.maxBacklog;

const QUERY_CACHE_TTL_MS = config.queryCacheTtlMs;
const QUERY_CACHE_MAX = config.queryCacheMax;

const queryCache = new Map<string, { embedding: number[]; expiresAt: number }>();

function pruneQueryCache(): void {
  const now = Date.now();
  for (const [key, value] of queryCache.entries()) {
    if (value.expiresAt <= now) {
      queryCache.delete(key);
    }
  }
  if (queryCache.size > QUERY_CACHE_MAX) {
    const keys = Array.from(queryCache.keys()).slice(0, queryCache.size - QUERY_CACHE_MAX);
    for (const key of keys) queryCache.delete(key);
  }
}

async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (config.openrouterSiteUrl) {
    headers['HTTP-Referer'] = config.openrouterSiteUrl;
  }
  if (config.openrouterSiteName) {
    headers['X-Title'] = config.openrouterSiteName;
  }
  const response = await fetch(`${config.openrouterBaseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter embeddings error ${response.status}: ${body.slice(0, 300)}`);
  }
  const payload = JSON.parse(body) as { data?: Array<{ embedding?: number[] }> };
  if (!Array.isArray(payload.data)) {
    throw new Error('OpenRouter embeddings response missing data');
  }
  return payload.data.map(item => Array.isArray(item.embedding) ? item.embedding : []);
}

export async function getQueryEmbedding(query: string): Promise<number[] | null> {
  if (!EMBEDDINGS_ENABLED) return null;
  const trimmed = query.trim();
  if (!trimmed) return null;
  const cacheKey = `${EMBEDDING_MODEL}:${trimmed}`;
  pruneQueryCache();
  const cached = queryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.embedding;
  }
  const vectors = await fetchEmbeddings([trimmed]);
  const embedding = vectors[0] || [];
  if (embedding.length === 0) return null;
  queryCache.set(cacheKey, { embedding, expiresAt: Date.now() + QUERY_CACHE_TTL_MS });
  return embedding;
}

export async function backfillEmbeddings(): Promise<number> {
  if (!EMBEDDINGS_ENABLED) return 0;
  if (EMBEDDING_MAX_BACKLOG > 0) {
    const backlog = countMemoriesMissingEmbeddings({});
    if (backlog > EMBEDDING_MAX_BACKLOG) {
      logger.warn({ backlog, limit: EMBEDDING_MAX_BACKLOG }, 'Embedding backlog exceeds limit; skipping backfill');
      return 0;
    }
  }
  const missing = listMemoriesMissingEmbeddings({ limit: EMBEDDING_BATCH_SIZE });
  if (missing.length === 0) return 0;
  const texts = missing.map(item => item.content);
  const embeddings = await fetchEmbeddings(texts);
  let updated = 0;
  for (let i = 0; i < missing.length; i += 1) {
    const embedding = embeddings[i];
    if (!embedding || embedding.length === 0) continue;
    updateMemoryEmbedding({
      id: missing[i].id,
      embedding,
      model: EMBEDDING_MODEL
    });
    updated += 1;
  }
  return updated;
}

let embeddingWorkerStopped = false;

export function startEmbeddingWorker(): void {
  if (!EMBEDDINGS_ENABLED) return;
  embeddingWorkerStopped = false;
  const loop = async () => {
    if (embeddingWorkerStopped) return;
    try {
      await backfillEmbeddings();
    } catch {
      // ignore embedding worker errors
    }
    if (!embeddingWorkerStopped) {
      setTimeout(loop, EMBEDDING_INTERVAL_MS);
    }
  };
  loop();
}

export function stopEmbeddingWorker(): void {
  embeddingWorkerStopped = true;
}
