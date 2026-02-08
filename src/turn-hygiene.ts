import type { NewMessage } from './types.js';

const PARTIAL_PLACEHOLDER_RE = /^\[?\s*(typing|streaming|partial|draft|working|thinking)\s*(\.\.\.|…)?\s*\]?$/i;
const PARTIAL_BRACKET_RE = /^\[\s*(typing|streaming|partial|draft|working|thinking)[^\]]{0,48}\]$/i;
const REPEATED_DOTS_RE = /^(\.{2,}|…+)$/;
const DEDUPE_WINDOW_MS = 60_000;

export type TurnHygieneStats = {
  inputCount: number;
  outputCount: number;
  droppedMalformed: number;
  droppedDuplicates: number;
  droppedStalePartials: number;
  normalizedToolEnvelopes: number;
};

function parseTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function sanitizeMessageContent(content: string): string {
  let sanitized = '';
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const code = content.charCodeAt(i);
    const isControl = (code <= 0x1f || code === 0x7f)
      && code !== 0x09
      && code !== 0x0a
      && code !== 0x0d;
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function normalizeForDedup(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

function summarizeToolOutput(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeToolEnvelope(content: string): { content: string; normalized: boolean } {
  const trimmed = content.trim();
  if (!trimmed) return { content: trimmed, normalized: false };

  const xmlMatch = trimmed.match(/^<tool_result\b([^>]*)>([\s\S]*?)<\/tool_result>$/i);
  if (xmlMatch) {
    const attrs = xmlMatch[1] || '';
    const body = (xmlMatch[2] || '')
      .replace(/<\/?[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const toolName = attrs.match(/\b(?:name|tool)=["']([^"']+)["']/i)?.[1];
    const summary = truncate(body || '[no output]', 1200);
    return {
      content: `Tool result${toolName ? ` (${toolName})` : ''}: ${summary}`,
      normalized: true
    };
  }

  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    return { content: trimmed, normalized: false };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const source = (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && 'tool_result' in parsed
      && parsed.tool_result
      && typeof parsed.tool_result === 'object'
      && !Array.isArray(parsed.tool_result)
    ) ? parsed.tool_result as Record<string, unknown> : parsed as Record<string, unknown>;

    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return { content: trimmed, normalized: false };
    }

    const toolNameRaw = source.tool ?? source.tool_name ?? source.name;
    const outputRaw = source.output ?? source.result ?? source.message ?? source.data;
    if (!toolNameRaw && outputRaw === undefined) {
      return { content: trimmed, normalized: false };
    }

    const toolName = typeof toolNameRaw === 'string' ? toolNameRaw.trim() : '';
    const output = truncate(summarizeToolOutput(outputRaw) || '[no output]', 1200);
    return {
      content: `Tool result${toolName ? ` (${toolName})` : ''}: ${output}`,
      normalized: true
    };
  } catch {
    return { content: trimmed, normalized: false };
  }
}

function looksLikeStalePartial(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length > 96) return false;
  const normalized = trimmed.toLowerCase();
  return PARTIAL_PLACEHOLDER_RE.test(normalized)
    || PARTIAL_BRACKET_RE.test(normalized)
    || REPEATED_DOTS_RE.test(normalized);
}

function withinWindow(a: string, b: string, windowMs = DEDUPE_WINDOW_MS): boolean {
  const aMs = parseTimestampMs(a);
  const bMs = parseTimestampMs(b);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  return Math.abs(bMs - aMs) <= windowMs;
}

function isPrefixChunk(previous: string, next: string): boolean {
  const prev = normalizeForDedup(previous);
  const curr = normalizeForDedup(next);
  if (prev.length < 24 || curr.length <= prev.length) return false;
  if (!curr.startsWith(prev)) return false;
  const ratio = prev.length / curr.length;
  return ratio >= 0.35;
}

function isMalformedTurn(turn: NewMessage): boolean {
  if (!turn || typeof turn !== 'object') return true;
  if (!turn.id || typeof turn.id !== 'string') return true;
  if (!turn.sender || typeof turn.sender !== 'string') return true;
  if (!turn.sender_name || typeof turn.sender_name !== 'string') return true;
  if (!turn.timestamp || typeof turn.timestamp !== 'string') return true;
  if (!Number.isFinite(parseTimestampMs(turn.timestamp))) return true;
  if (typeof turn.content !== 'string') return true;
  return false;
}

export function applyTurnHygiene(messages: NewMessage[]): { messages: NewMessage[]; stats: TurnHygieneStats } {
  const stats: TurnHygieneStats = {
    inputCount: Array.isArray(messages) ? messages.length : 0,
    outputCount: 0,
    droppedMalformed: 0,
    droppedDuplicates: 0,
    droppedStalePartials: 0,
    normalizedToolEnvelopes: 0
  };

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], stats };
  }

  const prepared: NewMessage[] = [];
  for (const turn of messages) {
    if (isMalformedTurn(turn)) {
      stats.droppedMalformed += 1;
      continue;
    }

    const sanitized = sanitizeMessageContent(turn.content);
    if (!sanitized) {
      stats.droppedMalformed += 1;
      continue;
    }

    const normalizedTool = normalizeToolEnvelope(sanitized);
    if (normalizedTool.normalized) {
      stats.normalizedToolEnvelopes += 1;
    }

    prepared.push({
      ...turn,
      content: normalizedTool.content
    });
  }

  const cleaned: NewMessage[] = [];
  const recentByFingerprint = new Map<string, number>();

  for (let i = 0; i < prepared.length; i += 1) {
    const current = prepared[i];
    const next = prepared[i + 1];
    const currentMs = parseTimestampMs(current.timestamp);
    const currentFingerprint = `${current.sender}:${normalizeForDedup(current.content)}`;

    if (
      next
      && current.sender === next.sender
      && withinWindow(current.timestamp, next.timestamp)
      && looksLikeStalePartial(current.content)
      && !looksLikeStalePartial(next.content)
    ) {
      stats.droppedStalePartials += 1;
      continue;
    }

    const lastSeen = recentByFingerprint.get(currentFingerprint);
    if (typeof lastSeen === 'number' && Number.isFinite(currentMs) && Math.abs(currentMs - lastSeen) <= DEDUPE_WINDOW_MS) {
      stats.droppedDuplicates += 1;
      continue;
    }

    const previous = cleaned[cleaned.length - 1];
    if (previous && previous.sender === current.sender && withinWindow(previous.timestamp, current.timestamp)) {
      const prevNormalized = normalizeForDedup(previous.content);
      if (prevNormalized === normalizeForDedup(current.content)) {
        stats.droppedDuplicates += 1;
        continue;
      }
      if (isPrefixChunk(previous.content, current.content)) {
        cleaned[cleaned.length - 1] = current;
        recentByFingerprint.set(currentFingerprint, currentMs);
        stats.droppedDuplicates += 1;
        continue;
      }
    }

    cleaned.push(current);
    recentByFingerprint.set(currentFingerprint, currentMs);
  }

  stats.outputCount = cleaned.length;
  return { messages: cleaned, stats };
}
