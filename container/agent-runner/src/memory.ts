import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function atomicWriteFileSync(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  seq: number;
}

export interface SessionMeta {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  nextSeq: number;
}

export interface MemoryState {
  summary: string;
  facts: string[];
  lastSummarySeq: number;
  updatedAt: string;
  schemaVersion: number;
}

export interface SessionContext {
  sessionId: string;
  sessionDir: string;
  historyPath: string;
  metaPath: string;
  statePath: string;
  meta: SessionMeta;
  state: MemoryState;
}

export interface MemoryConfig {
  maxContextTokens: number;
  compactionTriggerTokens: number;
  recentContextTokens: number;
  summaryUpdateEveryMessages: number;
  memoryMaxResults: number;
  memoryMaxTokens: number;
}

/**
 * Improved token estimation using character-class weighting.
 * More accurate than bytes/4 for code/markdown/mixed content.
 * - ASCII letters/digits: ~0.25 tokens per char
 * - Whitespace/punctuation: ~0.5 tokens per char (frequent tokenizer boundaries)
 * - Non-ASCII (CJK, emoji, etc.): ~0.5 tokens per char (multi-byte → often 1 token)
 * - Code-heavy content has more punctuation → higher ratio
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let weighted = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) {
      weighted += 0.5; // Non-ASCII: CJK, emoji, accented chars
    } else if (
      (code >= 48 && code <= 57) ||  // 0-9
      (code >= 65 && code <= 90) ||  // A-Z
      (code >= 97 && code <= 122)    // a-z
    ) {
      weighted += 0.25; // Alphanumeric
    } else {
      weighted += 0.5; // Whitespace, punctuation, operators
    }
  }
  return Math.ceil(weighted);
}

export function createSessionContext(sessionRoot: string, sessionId?: string): { ctx: SessionContext; isNew: boolean } {
  fs.mkdirSync(sessionRoot, { recursive: true });
  let isNew = false;
  let resolvedSessionId = sessionId?.trim();
  if (!resolvedSessionId) {
    resolvedSessionId = `session-${crypto.randomUUID()}`;
    isNew = true;
  }

  const sessionDir = path.join(sessionRoot, resolvedSessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const metaPath = path.join(sessionDir, 'session.json');
  const statePath = path.join(sessionDir, 'memory.json');
  const historyPath = path.join(sessionDir, 'history.jsonl');

  let meta: SessionMeta;
  if (fs.existsSync(metaPath)) {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } else {
    meta = {
      sessionId: resolvedSessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nextSeq: 1
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    isNew = true;
  }

  let state: MemoryState;
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  } else {
    state = {
      summary: '',
      facts: [],
      lastSummarySeq: 0,
      updatedAt: new Date().toISOString(),
      schemaVersion: 1
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  return {
    ctx: {
      sessionId: resolvedSessionId,
      sessionDir,
      historyPath,
      metaPath,
      statePath,
      meta,
      state
    },
    isNew
  };
}

export function saveSessionMeta(ctx: SessionContext): void {
  ctx.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(ctx.metaPath, JSON.stringify(ctx.meta, null, 2));
}

export function saveMemoryState(ctx: SessionContext): void {
  ctx.state.updatedAt = new Date().toISOString();
  atomicWriteFileSync(ctx.statePath, JSON.stringify(ctx.state, null, 2));
}

export function appendHistory(ctx: SessionContext, role: 'user' | 'assistant', content: string): Message {
  const message: Message = {
    role,
    content,
    timestamp: new Date().toISOString(),
    seq: ctx.meta.nextSeq
  };
  ctx.meta.nextSeq += 1;
  fs.appendFileSync(ctx.historyPath, `${JSON.stringify(message)}\n`);
  saveSessionMeta(ctx);
  return message;
}

export function loadHistory(ctx: SessionContext): Message[] {
  if (!fs.existsSync(ctx.historyPath)) return [];
  const lines = fs.readFileSync(ctx.historyPath, 'utf-8').trim().split('\n');
  const messages: Message[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.role && parsed?.content) {
        messages.push(parsed);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return messages;
}

export function writeHistory(ctx: SessionContext, messages: Message[]): void {
  if (messages.length === 0) {
    if (fs.existsSync(ctx.historyPath)) fs.unlinkSync(ctx.historyPath);
    return;
  }
  const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  atomicWriteFileSync(ctx.historyPath, content);
}

export function splitRecentHistory(messages: Message[], tokenBudget: number, minMessages = 4) {
  const recent: Message[] = [];
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const msgTokens = estimateTokens(message.content);
    if (tokens + msgTokens > tokenBudget && recent.length >= minMessages) {
      break;
    }
    recent.push(message);
    tokens += msgTokens;
  }
  const recentMessages = recent.reverse();
  const recentSet = new Set(recentMessages.map(m => m.seq));
  const olderMessages = messages.filter(m => !recentSet.has(m.seq));
  return { recentMessages, olderMessages };
}

export function shouldCompact(totalTokens: number, config: MemoryConfig): boolean {
  return totalTokens >= config.compactionTriggerTokens;
}

/**
 * Split messages into roughly equal token-share chunks for multi-part summarization.
 * Each chunk gets approximately totalTokens/parts tokens worth of messages.
 */
export function splitMessagesByTokenShare(messages: Message[], parts: number): Message[][] {
  if (messages.length === 0) return [];
  if (parts <= 1) return [messages];

  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const targetPerPart = Math.ceil(totalTokens / parts);
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg.content);
    if (currentTokens + msgTokens > targetPerPart && current.length > 0 && chunks.length < parts - 1) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Build a multi-part summary prompt. Each chunk is summarized with the context
 * of the previous partial summaries for continuity.
 */
export function buildMultiPartSummaryPrompt(
  existingSummary: string,
  existingFacts: string[],
  messageChunk: Message[],
  partIndex: number,
  totalParts: number,
  previousPartSummaries: string[]
) {
  const summaryText = existingSummary || 'None.';
  const factsText = existingFacts.length > 0 ? existingFacts.map(f => `- ${f}`).join('\n') : 'None.';
  const messagesText = messageChunk.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  const prevContext = previousPartSummaries.length > 0
    ? `Previous part summaries:\n${previousPartSummaries.map((s, i) => `Part ${i + 1}: ${s}`).join('\n')}`
    : '';

  const instructions = [
    'You maintain long-term memory for a personal assistant.',
    `This is part ${partIndex + 1} of ${totalParts} of a conversation compaction.`,
    'Update the summary and facts using the NEW messages for this part.',
    'Keep the summary concise, chronological, and focused on durable information.',
    'Facts should be short, specific, and stable. Avoid transient or speculative details.',
    'Return JSON only with keys: summary (string), facts (array of strings).'
  ].join('\n');

  const input = [
    `Existing summary:\n${summaryText}`,
    `Existing facts:\n${factsText}`,
    prevContext,
    `New messages (part ${partIndex + 1}/${totalParts}):\n${messagesText}`
  ].filter(Boolean).join('\n\n');

  return { instructions, input };
}

export function formatTranscriptMarkdown(messages: Message[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant';
    const content = msg.content.length > 4000
      ? `${msg.content.slice(0, 4000)}...`
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function archiveConversation(messages: Message[], summary: string | null, groupDir: string): string | null {
  if (messages.length === 0) return null;
  const conversationsDir = path.join(groupDir, 'conversations');
  fs.mkdirSync(conversationsDir, { recursive: true });

  const date = new Date().toISOString().split('T')[0];
  let name = summary ? sanitizeFilename(summary) : '';
  if (!name) {
    const time = new Date();
    name = `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
  }
  const filename = `${date}-${name}.md`;
  const filePath = path.join(conversationsDir, filename);
  fs.writeFileSync(filePath, formatTranscriptMarkdown(messages, summary));
  return filePath;
}

export function buildSummaryPrompt(existingSummary: string, existingFacts: string[], newMessages: Message[]) {
  const summaryText = existingSummary ? existingSummary : 'None.';
  const factsText = existingFacts.length > 0 ? existingFacts.map(f => `- ${f}`).join('\n') : 'None.';
  const messagesText = newMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

  const instructions = [
    'You maintain long-term memory for a personal assistant.',
    'Update the summary and facts using the NEW messages.',
    'Keep the summary concise, chronological, and focused on durable information.',
    'Facts should be short, specific, and stable. Avoid transient or speculative details.',
    'Return JSON only with keys: summary (string), facts (array of strings).'
  ].join('\n');

  const input = [
    `Existing summary:\n${summaryText}`,
    `Existing facts:\n${factsText}`,
    `New messages:\n${messagesText}`
  ].join('\n\n');

  return { instructions, input };
}

export function parseSummaryResponse(text: string): { summary: string; facts: string[] } | null {
  const trimmed = text.trim();
  let jsonText = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonText);
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.facts)) {
      return null;
    }
    const facts = parsed.facts.filter((f: unknown) => typeof f === 'string');
    return { summary: parsed.summary, facts };
  } catch {
    return null;
  }
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(token => token.length > 1);
}

function scoreCandidate(candidate: string, queryTokens: string[], weight: number): number {
  const candidateTokens = tokenize(candidate);
  if (candidateTokens.length === 0 || queryTokens.length === 0) return 0;
  const tokenSet = new Set(candidateTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (tokenSet.has(token)) overlap += 1;
  }
  if (overlap === 0) return 0;
  return (overlap / Math.sqrt(candidateTokens.length)) * weight;
}

export function retrieveRelevantMemories(params: {
  query: string;
  summary: string;
  facts: string[];
  olderMessages: Message[];
  config: MemoryConfig;
}): string[] {
  const queryTokens = tokenize(params.query);
  if (queryTokens.length === 0) return [];

  const candidates: Array<{ text: string; score: number }> = [];

  if (params.summary) {
    const summaryLines = params.summary.split('\n').map(line => line.trim()).filter(Boolean);
    for (const line of summaryLines) {
      const score = scoreCandidate(line, queryTokens, 1.4);
      if (score > 0) candidates.push({ text: line, score });
    }
  }

  for (const fact of params.facts) {
    const score = scoreCandidate(fact, queryTokens, 2.0);
    if (score > 0) candidates.push({ text: fact, score });
  }

  for (const msg of params.olderMessages.slice(-200)) {
    const snippet = msg.content.length > 300 ? `${msg.content.slice(0, 300)}...` : msg.content;
    const score = scoreCandidate(snippet, queryTokens, 1.0);
    if (score > 0) candidates.push({ text: snippet, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const results: string[] = [];
  let tokens = 0;
  for (const candidate of candidates) {
    if (results.length >= params.config.memoryMaxResults) break;
    const nextTokens = estimateTokens(candidate.text);
    if (tokens + nextTokens > params.config.memoryMaxTokens) break;
    results.push(candidate.text);
    tokens += nextTokens;
  }
  return results;
}

export interface ContextPruningConfig {
  softTrimMaxChars: number;
  softTrimHeadChars: number;
  softTrimTailChars: number;
  keepLastAssistant: number;
}

/**
 * Soft-trim old assistant messages to prevent context bloat from tool output.
 * Preserves the last `keepLastAssistant` assistant messages untouched.
 * User messages are never trimmed.
 */
export function pruneContextMessages(
  messages: Message[],
  config: ContextPruningConfig
): Message[] {
  // Find indices of assistant messages to protect (last N)
  const assistantIndices: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      assistantIndices.push(i);
      if (assistantIndices.length >= config.keepLastAssistant) break;
    }
  }
  const protectedSet = new Set(assistantIndices);

  return messages.map((msg, idx) => {
    if (msg.role !== 'assistant') return msg;
    if (protectedSet.has(idx)) return msg;
    if (msg.content.length <= config.softTrimMaxChars) return msg;

    const head = msg.content.slice(0, config.softTrimHeadChars);
    const tail = msg.content.slice(-config.softTrimTailChars);
    const trimmed = `${head}\n...\n[Content trimmed: kept first ${config.softTrimHeadChars} and last ${config.softTrimTailChars} of ${msg.content.length} chars]\n${tail}`;
    return { ...msg, content: trimmed };
  });
}

/**
 * Limit conversation history to the last N messages.
 * Preserves chronological order.
 */
export function limitHistoryTurns(messages: Message[], maxTurns: number): Message[] {
  if (maxTurns <= 0 || messages.length <= maxTurns) return messages;
  return messages.slice(-maxTurns);
}
