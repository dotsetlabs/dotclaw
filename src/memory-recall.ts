import { searchMemories, listEmbeddedMemories, recordMemoryAccess, MemorySearchResult, MemoryScope, MemoryType } from './memory-store.js';
import {
  EMBEDDINGS_ENABLED,
  EMBEDDING_MAX_CANDIDATES,
  EMBEDDING_MIN_ITEMS,
  EMBEDDING_MIN_QUERY_CHARS,
  EMBEDDING_WEIGHT,
  getQueryEmbedding
} from './memory-embeddings.js';

type ScoredMemory = {
  id: string;
  content: string;
  type: MemoryType;
  scope: MemoryScope;
  score: number;
};

const MEMORY_INTENT_RE = /\b(remember|recall|previous|last time|you said|as discussed|preference|profile|about me|saved|stored)\b/i;
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'could', 'does',
  'from', 'have', 'into', 'just', 'more', 'only', 'over', 'same', 'some', 'such', 'that',
  'their', 'there', 'these', 'this', 'those', 'very', 'what', 'when', 'where', 'which',
  'while', 'with', 'would', 'your', 'you', 'they', 'them', 'then'
]);
const EXPLICIT_MEMORY_INTENT_PRIORITY_TYPES = new Set<MemoryType>([
  'preference',
  'identity',
  'relationship',
  'project',
  'task'
]);

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf-8') / 4);
}

function normalizeScope(value: unknown): MemoryScope {
  if (value === 'user' || value === 'group' || value === 'global') return value;
  return 'group';
}

function rankEmbeddingCandidates(params: {
  queryEmbedding: number[];
  candidates: Array<{ id: string; content: string; type: MemoryType; scope: MemoryScope; importance: number; updated_at: string; embedding_json: string }>;
}): ScoredMemory[] {
  const now = Date.now();
  const baseWeight = Math.max(0, 1 - EMBEDDING_WEIGHT);
  const importanceWeight = baseWeight * 0.6;
  const recencyWeight = baseWeight * 0.4;
  const scored: ScoredMemory[] = [];
  for (const candidate of params.candidates) {
    let embedding: number[];
    try {
      embedding = JSON.parse(candidate.embedding_json) as number[];
    } catch {
      continue;
    }
    if (!Array.isArray(embedding) || embedding.length === 0) continue;
    const similarity = cosineSimilarity(params.queryEmbedding, embedding);
    const ageDays = candidate.updated_at
      ? (now - new Date(candidate.updated_at).getTime()) / (1000 * 60 * 60 * 24)
      : 365;
    const recency = Math.exp(-ageDays / 30);
    const score = (similarity * EMBEDDING_WEIGHT)
      + (candidate.importance * importanceWeight)
      + (recency * recencyWeight);
    scored.push({
      id: candidate.id,
      content: candidate.content,
      type: candidate.type,
      scope: normalizeScope(candidate.scope),
      score
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function mergeResults(params: {
  fts: MemorySearchResult[];
  semantic: ScoredMemory[];
}): ScoredMemory[] {
  const merged = new Map<string, ScoredMemory>();
  for (const item of params.fts) {
    merged.set(item.id, {
      id: item.id,
      content: item.content,
      type: item.type,
      scope: normalizeScope(item.scope),
      score: item.score
    });
  }
  for (const item of params.semantic) {
    const existing = merged.get(item.id);
    if (existing) {
      // Boost: item appears in both FTS and semantic results.
      const combined = Math.max(existing.score, item.score) + Math.min(existing.score, item.score) * 0.3;
      merged.set(item.id, {
        ...existing,
        score: combined
      });
    } else {
      merged.set(item.id, item);
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

function topicKey(content: string): string {
  const tokens = (content.toLowerCase().match(/[a-z0-9]{4,}/g) || [])
    .filter(token => !STOP_WORDS.has(token));
  if (tokens.length === 0) return '';
  return tokens.slice(0, 2).join(':');
}

function selectRecallCandidates(params: {
  candidates: ScoredMemory[];
  maxResults: number;
  maxTokens: number;
  minScore: number;
  explicitMemoryIntent: boolean;
}): ScoredMemory[] {
  const selected: ScoredMemory[] = [];
  const selectedIds = new Set<string>();
  const topicCounts = new Map<string, number>();
  const filtered = params.candidates.filter(item => item.score >= params.minScore);
  const tokenLimit = Number.isFinite(params.maxTokens) && params.maxTokens > 0
    ? params.maxTokens
    : Number.POSITIVE_INFINITY;
  let usedTokens = 0;

  const canSelect = (item: ScoredMemory, enforceTopicCap: boolean): boolean => {
    if (selectedIds.has(item.id)) return false;
    if (!enforceTopicCap) return true;
    const key = topicKey(item.content);
    if (!key) return true;
    const count = topicCounts.get(key) || 0;
    return count < 2;
  };

  const addCandidate = (item: ScoredMemory, enforceTopicCap: boolean): boolean => {
    if (!canSelect(item, enforceTopicCap)) return false;
    const line = `(${item.type}) ${item.content}`;
    const estimate = estimateTokens(line);
    if (usedTokens + estimate > tokenLimit) return false;
    selected.push(item);
    selectedIds.add(item.id);
    usedTokens += estimate;
    const key = topicKey(item.content);
    if (key) {
      topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
    }
    return true;
  };

  const shouldAllowForIntent = (item: ScoredMemory): boolean => {
    if (!params.explicitMemoryIntent) return true;
    if (EXPLICIT_MEMORY_INTENT_PRIORITY_TYPES.has(item.type)) return true;
    // Prefer concise, high-signal memory types once enough context is selected.
    return selected.length < 3;
  };

  for (const scope of ['user', 'group', 'global'] as const) {
    if (selected.length >= params.maxResults) break;
    const candidate = filtered.find(item => item.scope === scope && !selectedIds.has(item.id));
    if (candidate) {
      addCandidate(candidate, false);
    }
  }

  if (params.explicitMemoryIntent) {
    for (const type of ['preference', 'identity', 'relationship', 'project', 'task'] as const) {
      if (selected.length >= params.maxResults) break;
      const candidate = filtered.find(item => item.type === type && !selectedIds.has(item.id));
      if (candidate) {
        addCandidate(candidate, false);
      }
    }
  }

  const seenTypes = new Set(selected.map(item => item.type));
  for (const candidate of filtered) {
    if (selected.length >= params.maxResults) break;
    if (!shouldAllowForIntent(candidate)) continue;
    if (seenTypes.has(candidate.type)) continue;
    if (addCandidate(candidate, true)) {
      seenTypes.add(candidate.type);
    }
  }

  for (const candidate of filtered) {
    if (selected.length >= params.maxResults) break;
    if (!shouldAllowForIntent(candidate)) continue;
    addCandidate(candidate, true);
  }

  if (selected.length === 0 && params.explicitMemoryIntent && params.candidates.length > 0) {
    addCandidate(params.candidates[0], false);
  }

  return selected;
}

export async function buildHybridMemoryRecall(params: {
  groupFolder: string;
  userId?: string | null;
  query: string;
  maxResults?: number;
  maxTokens?: number;
  minScore?: number;
}): Promise<string[]> {
  const maxResults = params.maxResults || 8;
  const maxTokens = params.maxTokens || 1200;
  const minScore = params.minScore ?? 0.35;
  const explicitMemoryIntent = MEMORY_INTENT_RE.test(params.query);
  const effectiveMinScore = explicitMemoryIntent
    ? Math.max(0.2, minScore * 0.85)
    : minScore;

  const ftsResults = searchMemories({
    groupFolder: params.groupFolder,
    userId: params.userId,
    query: params.query,
    limit: maxResults * 3
  });

  let semanticResults: ScoredMemory[] = [];
  if (EMBEDDINGS_ENABLED && params.query.trim().length >= EMBEDDING_MIN_QUERY_CHARS) {
    const candidates = listEmbeddedMemories({
      groupFolder: params.groupFolder,
      userId: params.userId,
      limit: EMBEDDING_MAX_CANDIDATES
    });
    if (candidates.length >= EMBEDDING_MIN_ITEMS) {
      const queryEmbedding = await getQueryEmbedding(params.query);
      if (queryEmbedding && queryEmbedding.length > 0) {
        semanticResults = rankEmbeddingCandidates({
          queryEmbedding,
          candidates
        }).slice(0, maxResults * 4);
      }
    }
  }

  const merged = mergeResults({ fts: ftsResults, semantic: semanticResults });
  const chosen = selectRecallCandidates({
    candidates: merged,
    maxResults,
    maxTokens,
    minScore: effectiveMinScore,
    explicitMemoryIntent
  });

  const recall: string[] = chosen.map(item => `(${item.type}) ${item.content}`);
  const accessedIds = chosen.map(item => item.id);

  if (accessedIds.length > 0) {
    try {
      recordMemoryAccess(accessedIds);
    } catch {
      // Don't fail recall if access recording fails.
    }
  }

  return recall;
}
