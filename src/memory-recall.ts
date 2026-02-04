import { searchMemories, listEmbeddedMemories, MemorySearchResult } from './memory-store.js';
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
  type: string;
  score: number;
};

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

function rankEmbeddingCandidates(params: {
  queryEmbedding: number[];
  candidates: Array<{ id: string; content: string; type: string; importance: number; updated_at: string; embedding_json: string }>;
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
      score: item.score
    });
  }
  for (const item of params.semantic) {
    const existing = merged.get(item.id);
    if (!existing || item.score > existing.score) {
      merged.set(item.id, item);
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

export async function buildHybridMemoryRecall(params: {
  groupFolder: string;
  userId?: string | null;
  query: string;
  maxResults?: number;
  maxTokens?: number;
}): Promise<string[]> {
  const maxResults = params.maxResults || 8;
  const maxTokens = params.maxTokens || 1200;

  const ftsResults = searchMemories({
    groupFolder: params.groupFolder,
    userId: params.userId,
    query: params.query,
    limit: maxResults * 2
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
        }).slice(0, maxResults * 3);
      }
    }
  }

  const merged = mergeResults({ fts: ftsResults, semantic: semanticResults });
  const recall: string[] = [];
  let tokens = 0;
  for (const item of merged) {
    if (recall.length >= maxResults) break;
    const line = `(${item.type}) ${item.content}`;
    const estimate = estimateTokens(line);
    if (tokens + estimate > maxTokens) break;
    recall.push(line);
    tokens += estimate;
  }
  return recall;
}
