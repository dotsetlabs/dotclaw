const MEMORY_INTENT_RE = /\b(remember|recall|previous|last time|you said|as discussed|preference|profile|about me|saved|stored)\b/i;
const TOOL_HEAVY_HINT_RE = /\b(scenario:?tool_heavy|create file|write file|read (?:it|the file|it back|back)|list (?:the )?\d* ?newest files?|run (?:this|that|the)? ?command|execute (?:this|that|the)? ?command|open .*pull request|fix .*ci)\b/i;
const LOW_SIGNAL_TURNS = new Set([
  'ok',
  'okay',
  'thanks',
  'thank you',
  'thx',
  'yes',
  'no',
  'sure',
  'k',
  'kk',
  'cool',
  'great',
  'nice',
  'next',
  'continue'
]);
const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'could', 'does',
  'from', 'have', 'into', 'just', 'more', 'only', 'over', 'same', 'some', 'such', 'that',
  'their', 'there', 'these', 'this', 'those', 'very', 'what', 'when', 'where', 'which',
  'while', 'with', 'would', 'your', 'you', 'they', 'them', 'then', 'please'
]);

const DEFAULT_MAX_QUERY_CHARS = 3500;

function tokenizeContentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter(token => !STOP_WORDS.has(token));
}

export function hasExplicitMemoryIntent(text: string): boolean {
  return MEMORY_INTENT_RE.test(text);
}

export function optimizeRecallQuery(rawQuery: string, fallbackQuery = '', maxChars = DEFAULT_MAX_QUERY_CHARS): string {
  const source = String(rawQuery || fallbackQuery || '').trim();
  if (!source) return '';
  const lines = source
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const compact = lines.slice(-8).join('\n');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || compact.length <= maxChars) {
    return compact;
  }
  return compact.slice(compact.length - maxChars);
}

export function shouldRunMemoryRecall(query: string): boolean {
  const normalized = String(query || '').trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (LOW_SIGNAL_TURNS.has(lower)) return false;
  if (hasExplicitMemoryIntent(normalized)) return true;
  if (normalized.length < 10) return false;

  const contentTokens = tokenizeContentWords(normalized);
  if (contentTokens.length >= 2) return true;

  // Allow short-but-meaningful user requests that include at least one strong token.
  return contentTokens.length === 1 && normalized.length >= 24;
}

export function resolveRecallBudget(params: {
  query: string;
  maxResults: number;
  maxTokens: number;
}): { maxResults: number; maxTokens: number } {
  const requestedResults = Math.max(0, Math.floor(params.maxResults || 0));
  const requestedTokens = Math.max(0, Math.floor(params.maxTokens || 0));
  if (requestedResults === 0 || requestedTokens === 0) {
    return { maxResults: requestedResults, maxTokens: requestedTokens };
  }

  const query = String(params.query || '').trim();
  if (!query) {
    return { maxResults: requestedResults, maxTokens: requestedTokens };
  }

  if (hasExplicitMemoryIntent(query)) {
    return { maxResults: requestedResults, maxTokens: requestedTokens };
  }

  if (TOOL_HEAVY_HINT_RE.test(query)) {
    return {
      maxResults: Math.min(requestedResults, 4),
      maxTokens: Math.min(requestedTokens, 900)
    };
  }

  return {
    maxResults: Math.min(requestedResults, 6),
    maxTokens: Math.min(requestedTokens, 1200)
  };
}
