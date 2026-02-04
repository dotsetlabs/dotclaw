import { listMemoriesMissingEmbeddings, updateMemoryEmbedding } from './memory-store.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabledEnv(name: string, defaultValue = true): boolean {
  const value = (process.env[name] || '').toLowerCase().trim();
  if (!value) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value);
}

export const EMBEDDINGS_ENABLED = isEnabledEnv('DOTCLAW_MEMORY_EMBEDDINGS_ENABLED', true);
export const EMBEDDING_MODEL = process.env.DOTCLAW_MEMORY_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
export const EMBEDDING_BATCH_SIZE = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_BATCH_SIZE, 8);
export const EMBEDDING_MIN_ITEMS = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_MIN_ITEMS, 20);
export const EMBEDDING_MIN_QUERY_CHARS = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_MIN_QUERY_CHARS, 40);
export const EMBEDDING_MAX_CANDIDATES = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_MAX_CANDIDATES, 2000);
export const EMBEDDING_WEIGHT = parsePositiveFloat(process.env.DOTCLAW_MEMORY_EMBEDDING_WEIGHT, 0.6);
export const EMBEDDING_INTERVAL_MS = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_INTERVAL_MS, 300000);

const QUERY_CACHE_TTL_MS = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_QUERY_CACHE_MS, 600000);
const QUERY_CACHE_MAX = parsePositiveInt(process.env.DOTCLAW_MEMORY_EMBEDDING_QUERY_CACHE_MAX, 200);

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
  const baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (process.env.OPENROUTER_SITE_URL) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  }
  if (process.env.OPENROUTER_SITE_NAME) {
    headers['X-Title'] = process.env.OPENROUTER_SITE_NAME;
  }
  const response = await fetch(`${baseUrl}/embeddings`, {
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

export function startEmbeddingWorker(): void {
  if (!EMBEDDINGS_ENABLED) return;
  const loop = async () => {
    try {
      await backfillEmbeddings();
    } catch {
      // ignore embedding worker errors
    }
    setTimeout(loop, EMBEDDING_INTERVAL_MS);
  };
  loop();
}
