export type ToolCallLike = {
  id?: string;
  name: string;
  arguments?: unknown;
};

export type ToolResultLike = {
  name: string;
  ok: boolean;
  output?: string;
  error?: string;
};

export type ToolConversationCompactionOptions = {
  maxOutputChars: number;
  outputHeadChars: number;
  outputTailChars: number;
  maxArgumentChars: number;
  maxArgumentArrayItems: number;
  maxArgumentObjectKeys: number;
  argumentRedactKeys: string[];
};

export type ToolCallClass = 'idempotent' | 'mutating' | 'unknown';

export type ToolExecutionRequirement = {
  required: boolean;
  reason?: string;
};

export type CreateReadFileInstruction = {
  path: string;
  lines: string[];
};

export type ListReadNewestInstruction = {
  directory: string;
  count: number;
  bulletCount?: number;
};

const IDEMPOTENT_TOOL_NAMES = new Set([
  'read',
  'glob',
  'grep',
  'webfetch',
  'websearch',
  'analyzeimage',
  'listtasks',
  'listgroups',
  'getconfig',
  'mcp__dotclaw__memory_search',
  'mcp__dotclaw__memory_list',
  'mcp__dotclaw__memory_stats',
  'mcp__dotclaw__list_tasks',
  'mcp__dotclaw__list_groups',
  'mcp__dotclaw__get_config'
]);

const IDEMPOTENT_PREFIXES = [
  'mcp__dotclaw__memory_search',
  'mcp__dotclaw__memory_list',
  'mcp__dotclaw__memory_stats',
  'mcp__dotclaw__list_',
  'mcp__dotclaw__get_'
];

const MUTATING_TOOL_NAMES = new Set([
  'write',
  'edit',
  'bash',
  'python',
  'gitclone',
  'packageinstall',
  'sendmessage',
  'sendfile',
  'sendphoto',
  'sendvoice',
  'sendaudio',
  'sendlocation',
  'sendcontact',
  'sendpoll',
  'sendbuttons',
  'editmessage',
  'deletemessage',
  'downloadurl',
  'scheduletask',
  'runtask',
  'pausetask',
  'resumetask',
  'canceltask',
  'updatetask',
  'registergroup',
  'removegroup',
  'setmodel',
  'mcp__dotclaw__set_model',
  'mcp__dotclaw__set_behavior',
  'mcp__dotclaw__set_mcp_config',
  'mcp__dotclaw__set_tool_policy',
  'mcp__dotclaw__memory_upsert',
  'mcp__dotclaw__memory_forget'
]);

const MUTATING_PREFIXES = [
  'plugin__',
  'mcp__dotclaw__send_',
  'mcp__dotclaw__set_',
  'mcp__dotclaw__schedule_',
  'mcp__dotclaw__update_',
  'mcp__dotclaw__register_',
  'mcp__dotclaw__remove_',
  'mcp__dotclaw__memory_upsert',
  'mcp__dotclaw__memory_forget'
];

const POSITIVE_INT_FIELDS_BY_TOOL: Record<string, string[]> = {
  read: ['maxBytes'],
  glob: ['maxResults'],
  grep: ['maxResults'],
  webfetch: ['maxBytes'],
  websearch: ['count'],
  bash: ['timeoutMs'],
  process: ['timeoutMs'],
  gitclone: ['depth'],
  sendmessage: ['reply_to_message_id'],
  sendfile: ['reply_to_message_id'],
  sendphoto: ['reply_to_message_id'],
  sendvoice: ['duration', 'reply_to_message_id'],
  sendaudio: ['duration', 'reply_to_message_id'],
  sendlocation: ['reply_to_message_id'],
  sendcontact: ['reply_to_message_id'],
  sendpoll: ['reply_to_message_id'],
  editmessage: ['message_id'],
  deletemessage: ['message_id'],
};

const NONNEGATIVE_INT_FIELDS_BY_TOOL: Record<string, string[]> = {
  websearch: ['offset']
};

const PATH_LIKE_FIELDS_BY_TOOL: Record<string, string[]> = {
  read: ['path'],
  write: ['path'],
  edit: ['path'],
  glob: ['pattern'],
  grep: ['path', 'glob'],
  sendfile: ['path'],
  sendphoto: ['path'],
  sendvoice: ['path'],
  sendaudio: ['path'],
  analyzeimage: ['path'],
};

const TRANSIENT_ERROR_PATTERNS = [
  /\b429\b/i,
  /\b5\d{2}\b/i,
  /rate.?limit/i,
  /timeout|timed out|deadline/i,
  /temporar|transient|unavailable|overloaded|busy/i,
  /econnreset|econnrefused|enotfound|eai_again|socket hang up/i
];

const NON_RETRYABLE_ERROR_PATTERNS = [
  /tool is disabled by policy/i,
  /tool not allowed by policy/i,
  /usage limit reached/i,
  /invalid input|validation|zod/i,
  /malformed arguments|unterminated string|unexpected end of json input/i,
  /path is required|content is required|command is required|code is required/i,
  /out of range|received undefined/i,
  /path is outside allowed roots|path does not exist|must be inside/i,
  /permission denied|forbidden|unauthorized/i
];

const DEFAULT_ARGUMENT_REDACT_KEYS = [
  'content',
  'text',
  'body',
  'input',
  'code',
  'script',
  'patch',
  'diff',
  'markdown',
  'html',
  'xml',
  'json',
  'yaml'
];

const TOOL_REQUIRED_SCENARIO_PATTERN = /\[(?:scenario:)?tool_heavy\]/i;
const EXPLICIT_TOOL_INSTRUCTION_PATTERN = /\b(use|call|run)\s+(?:the\s+)?(?:read|write|edit|glob|grep|bash|python|tool|tools)\b/i;
const FILE_ACTION_VERB_PATTERN = /\b(create|write|edit|update|append|delete|remove|rename|read|open|list|show|find|search|grep|cat|head|tail)\b/i;
const FILE_OBJECT_PATTERN = /\b(file|files|folder|directory|path|paths|inbox|workspace|repo|repository)\b/i;
const PATH_HINT_PATTERN = /(?:\b[\w.-]+\/[\w./-]+|\b[\w.-]+\.(?:txt|md|json|yaml|yml|csv|log|js|jsx|ts|tsx|py|sh|toml|xml|html)\b)/i;
const TOOL_ACTION_PHRASE_PATTERN = /\b(read it back|verify|newest files?|list the \d+ newest files?|exact filename)\b/i;
const CONVERSATION_RECALL_PATTERN = /\b(from\s+(?:this|our)\s+(?:same\s+)?(?:conversation|chat)|what\s+(?:exact\s+)?(?:file\s*name|filename)\s+did\s+you\s+just\s+create|what\s+did\s+(?:i|you)\s+just)\b/i;
const CREATE_READ_FILE_PATTERN = /create file\s+["']([^"']+)["']\s+with\s+\d+\s+lines?:\s*([^\n.]+)\./i;
const LIST_NEWEST_READ_PATTERN = /list\s+(?:the\s+)?(\d+)\s+newest\s+files?\s+(?:under|in)\s+["'`]?([^"'`\s,.;]+\/?)["'`]?(?:,|\s).*?\bread\s+the\s+newest\s+one\b/i;
const LIST_NEWEST_READ_FALLBACK_PATTERN = /list\s+(?:the\s+)?newest\s+files?\s+(?:under|in)\s+["'`]?([^"'`\s,.;]+\/?)["'`]?(?:,|\s).*?\bread\s+the\s+newest\s+one\b/i;
const EXACT_BULLET_COUNT_PATTERN = /\bexactly\s+(\d+)\s+bullet(?:\s+point)?s?\b/i;

function normalizeToolName(name: string): string {
  return (name || '').trim().toLowerCase();
}

export function detectToolExecutionRequirement(prompt: string): ToolExecutionRequirement {
  const text = String(prompt || '').trim();
  if (!text) return { required: false };

  if (TOOL_REQUIRED_SCENARIO_PATTERN.test(text)) {
    return { required: true, reason: 'scenario_tool_heavy' };
  }

  if (EXPLICIT_TOOL_INSTRUCTION_PATTERN.test(text)) {
    return { required: true, reason: 'explicit_tool_instruction' };
  }

  if (CONVERSATION_RECALL_PATTERN.test(text)) {
    return { required: false };
  }

  const hasFileAction = FILE_ACTION_VERB_PATTERN.test(text);
  const hasFileTarget = FILE_OBJECT_PATTERN.test(text) || PATH_HINT_PATTERN.test(text) || TOOL_ACTION_PHRASE_PATTERN.test(text);
  if (hasFileAction && hasFileTarget) {
    return { required: true, reason: 'workspace_file_action' };
  }

  return { required: false };
}

export function buildToolExecutionNudgePrompt(params: {
  reason?: string;
  attempt?: number;
}): string {
  const reason = params.reason || 'required_tool_execution';
  const attempt = Math.max(1, Math.floor(params.attempt || 1));
  const isFileAction = reason === 'workspace_file_action' || reason === 'scenario_tool_heavy';
  return [
    '[SYSTEM CONTINUATION]',
    `The previous response did not execute tools for a tool-required request (${reason}). Attempt ${attempt}.`,
    'You MUST emit at least one function_call in your next response before any user-facing prose.',
    isFileAction
      ? 'For file work, use appropriate tools (for example: Write/Edit then Read, or Glob/Read/Bash for listing and verification).'
      : 'Use the appropriate tools to gather/act on required state before finalizing.',
    'Do not claim file/system/web actions unless corresponding tool calls in this turn succeeded.',
    'If a required tool fails, report the failure and the next best action instead of claiming success.',
    'Return only the final user-facing answer after tool execution.'
  ].join('\n');
}

export function parseCreateReadFileInstruction(prompt: string): CreateReadFileInstruction | null {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const match = text.match(CREATE_READ_FILE_PATTERN);
  if (!match) return null;
  const filePath = String(match[1] || '').trim();
  if (!filePath) return null;
  const rawLines = String(match[2] || '').replace(/\s+\band\b\s+/gi, ',');
  const lines = rawLines
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  return { path: filePath, lines };
}

export function parseListReadNewestInstruction(prompt: string): ListReadNewestInstruction | null {
  const text = String(prompt || '').trim();
  if (!text) return null;

  let directory = '';
  let count = 5;

  const explicitMatch = text.match(LIST_NEWEST_READ_PATTERN);
  if (explicitMatch) {
    const parsedCount = Number(explicitMatch[1]);
    if (Number.isFinite(parsedCount) && parsedCount > 0) {
      count = Math.min(50, Math.max(1, Math.floor(parsedCount)));
    }
    directory = String(explicitMatch[2] || '').trim();
  } else {
    const fallbackMatch = text.match(LIST_NEWEST_READ_FALLBACK_PATTERN);
    if (!fallbackMatch) return null;
    directory = String(fallbackMatch[1] || '').trim();
  }

  directory = directory.replace(/[.,;:]+$/, '');
  if (!directory) return null;

  const bulletMatch = text.match(EXACT_BULLET_COUNT_PATTERN);
  const bulletCount = bulletMatch
    ? Math.min(6, Math.max(1, Math.floor(Number(bulletMatch[1]) || 0)))
    : undefined;

  return {
    directory,
    count,
    bulletCount: bulletCount && Number.isFinite(bulletCount) ? bulletCount : undefined
  };
}

function coerceIntegerField(value: unknown, mode: 'positive' | 'nonnegative'): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const rounded = Math.floor(value);
    if (mode === 'positive') return rounded > 0 ? rounded : null;
    return rounded >= 0 ? rounded : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    const rounded = Math.floor(parsed);
    if (mode === 'positive') return rounded > 0 ? rounded : null;
    return rounded >= 0 ? rounded : null;
  }
  return null;
}

function sanitizeObjectArgumentsForTool(toolName: string, record: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeToolName(toolName);
  const out = { ...record };
  const positiveFields = POSITIVE_INT_FIELDS_BY_TOOL[normalized] || [];
  const nonnegativeFields = NONNEGATIVE_INT_FIELDS_BY_TOOL[normalized] || [];

  for (const field of positiveFields) {
    if (!(field in out)) continue;
    const coerced = coerceIntegerField(out[field], 'positive');
    if (coerced === null) {
      delete out[field];
    } else {
      out[field] = coerced;
    }
  }
  for (const field of nonnegativeFields) {
    if (!(field in out)) continue;
    const coerced = coerceIntegerField(out[field], 'nonnegative');
    if (coerced === null) {
      delete out[field];
    } else {
      out[field] = coerced;
    }
  }
  return out;
}

function validateSanitizedArgumentsForTool(toolName: string, record: Record<string, unknown>): string | undefined {
  const normalized = normalizeToolName(toolName);
  const pathLikeFields = PATH_LIKE_FIELDS_BY_TOOL[normalized] || [];
  for (const field of pathLikeFields) {
    if (!(field in record)) continue;
    const value = record[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const hasControlBreak = /[\r\n]/.test(trimmed) || trimmed.includes('\0');
    if (trimmed.includes('$(') || /[`]/.test(trimmed) || hasControlBreak) {
      return `${field} contains unsupported shell syntax`;
    }
  }
  return undefined;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`);
  return `{${entries.join(',')}}`;
}

export function classifyToolCallClass(name: string): ToolCallClass {
  const normalized = normalizeToolName(name);
  if (!normalized) return 'unknown';
  if (MUTATING_TOOL_NAMES.has(normalized) || MUTATING_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return 'mutating';
  }
  if (IDEMPOTENT_TOOL_NAMES.has(normalized) || IDEMPOTENT_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return 'idempotent';
  }
  return 'unknown';
}

export function isNonRetryableToolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message) return false;
  return NON_RETRYABLE_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function isRetryableToolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  if (!message) return false;
  if (isNonRetryableToolError(message)) return false;
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

export function shouldRetryIdempotentToolCall(params: {
  toolName: string;
  error: unknown;
  attempt: number;
  maxAttempts: number;
}): boolean {
  if (params.attempt >= params.maxAttempts) return false;
  if (classifyToolCallClass(params.toolName) !== 'idempotent') return false;
  return isRetryableToolError(params.error);
}

export function normalizeToolCallSignature(call: ToolCallLike): string {
  const name = normalizeToolName(call.name) || 'unknown';
  const args = stableJson(call.arguments);
  return `${name}:${args}`;
}

export function normalizeToolRoundSignature(calls: ToolCallLike[]): string {
  const signatures = calls
    .map(call => normalizeToolCallSignature(call))
    .sort();
  return signatures.join('|');
}

function looksLikeJsonCandidate(value: string): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
}

function coerceScalarArguments(toolName: string, value: string): Record<string, unknown> | null {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return null;
  if (!value.trim()) return null;
  switch (normalized) {
    case 'bash':
    case 'process':
      return { command: value };
    case 'python':
      return { code: value };
    case 'webfetch':
      return { url: value.trim() };
    case 'websearch':
      return { query: value };
    case 'read':
      return { path: value };
    case 'glob':
      return { pattern: value };
    case 'grep':
      return { pattern: value };
    default:
      return null;
  }
}

export function normalizeToolCallArguments(params: {
  toolName: string;
  rawArguments: unknown;
}): { arguments: unknown; malformedReason?: string } {
  const raw = params.rawArguments;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw)) {
      return { arguments: raw, malformedReason: 'arguments must be an object' };
    }
    const sanitized = sanitizeObjectArgumentsForTool(params.toolName, raw as Record<string, unknown>);
    const validationError = validateSanitizedArgumentsForTool(params.toolName, sanitized);
    return validationError
      ? { arguments: sanitized, malformedReason: validationError }
      : { arguments: sanitized };
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { arguments: raw, malformedReason: 'arguments are empty' };
    }
    if (looksLikeJsonCandidate(trimmed)) {
      try {
        let parsed: unknown = trimmed;
        for (let i = 0; i < 2 && typeof parsed === 'string'; i += 1) {
          parsed = JSON.parse(parsed);
        }
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed)) {
            return { arguments: parsed, malformedReason: 'arguments must be an object' };
          }
          const sanitized = sanitizeObjectArgumentsForTool(params.toolName, parsed as Record<string, unknown>);
          const validationError = validateSanitizedArgumentsForTool(params.toolName, sanitized);
          return validationError
            ? { arguments: sanitized, malformedReason: validationError }
            : { arguments: sanitized };
        }
        if (typeof parsed === 'string') {
          const coerced = coerceScalarArguments(params.toolName, parsed);
          if (coerced) return { arguments: coerced };
        }
      } catch {
        return { arguments: raw, malformedReason: 'malformed JSON arguments (possibly truncated)' };
      }
    }
    const coerced = coerceScalarArguments(params.toolName, trimmed);
    if (coerced) {
      const sanitized = sanitizeObjectArgumentsForTool(params.toolName, coerced);
      const validationError = validateSanitizedArgumentsForTool(params.toolName, sanitized);
      return validationError
        ? { arguments: sanitized, malformedReason: validationError }
        : { arguments: sanitized };
    }
    return { arguments: raw, malformedReason: 'arguments must be an object' };
  }

  if (typeof raw === 'number' || typeof raw === 'boolean') {
    const coerced = coerceScalarArguments(params.toolName, String(raw));
    if (coerced) {
      const sanitized = sanitizeObjectArgumentsForTool(params.toolName, coerced);
      const validationError = validateSanitizedArgumentsForTool(params.toolName, sanitized);
      return validationError
        ? { arguments: sanitized, malformedReason: validationError }
        : { arguments: sanitized };
    }
  }

  if (raw === null || raw === undefined) {
    return { arguments: raw, malformedReason: 'arguments are missing' };
  }
  return { arguments: raw, malformedReason: 'unsupported argument type' };
}

function compactLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function compactWithHeadTail(text: string, maxChars: number, headChars: number, tailChars: number, label: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = trimmed.slice(0, Math.max(0, headChars));
  const tail = trimmed.slice(Math.max(0, trimmed.length - Math.max(0, tailChars)));
  return `${head}\n...\n${tail}\n[${label}: kept first ${head.length} and last ${tail.length} of ${trimmed.length} chars.]`;
}

function compactArgumentValue(
  value: unknown,
  options: ToolConversationCompactionOptions,
  depth = 0,
  keyHint = ''
): unknown {
  if (depth > 4) {
    return '[argument depth trimmed]';
  }
  if (typeof value === 'string') {
    const normalizedKey = String(keyHint || '').trim().toLowerCase();
    const redactSet = new Set(options.argumentRedactKeys.map(key => key.toLowerCase()));
    if (redactSet.has(normalizedKey) && value.length > Math.floor(options.maxArgumentChars * 0.6)) {
      return `[${normalizedKey || 'value'} omitted: ${value.length} chars]`;
    }
    if (value.length > options.maxArgumentChars) {
      return compactWithHeadTail(
        value,
        options.maxArgumentChars,
        Math.min(Math.floor(options.maxArgumentChars * 0.6), options.maxArgumentChars),
        Math.min(Math.floor(options.maxArgumentChars * 0.25), options.maxArgumentChars),
        'Argument trimmed'
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    const limited = value.slice(0, Math.max(1, options.maxArgumentArrayItems));
    const mapped = limited.map(item => compactArgumentValue(item, options, depth + 1));
    if (value.length > limited.length) {
      mapped.push(`[${value.length - limited.length} items omitted]`);
    }
    return mapped;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const limitedEntries = entries.slice(0, Math.max(1, options.maxArgumentObjectKeys));
    const out: Record<string, unknown> = {};
    for (const [key, val] of limitedEntries) {
      out[key] = compactArgumentValue(val, options, depth + 1, key);
    }
    if (entries.length > limitedEntries.length) {
      out.__trimmed_keys = entries.length - limitedEntries.length;
    }
    return out;
  }
  return value;
}

function compactToolConversationItemInternal(item: unknown, options: ToolConversationCompactionOptions): { item: unknown; compacted: boolean } {
  if (!item || typeof item !== 'object') {
    return { item, compacted: false };
  }
  const record = item as Record<string, unknown>;
  if (record.type === 'function_call_output') {
    const output = record.output;
    if (typeof output !== 'string' || output.length <= options.maxOutputChars) {
      return { item, compacted: false };
    }
    return {
      item: {
        ...record,
        output: compactWithHeadTail(
          output,
          options.maxOutputChars,
          options.outputHeadChars,
          options.outputTailChars,
          'Tool output trimmed'
        )
      },
      compacted: true
    };
  }

  if (record.type === 'function_call') {
    const compactedArgs = compactArgumentValue(record.arguments, options);
    const compacted = JSON.stringify(compactedArgs) !== JSON.stringify(record.arguments);
    if (!compacted) {
      return { item, compacted: false };
    }
    return {
      item: {
        ...record,
        arguments: compactedArgs
      },
      compacted: true
    };
  }

  return { item, compacted: false };
}

export function compactToolConversationItems(
  items: unknown[],
  partialOptions: Partial<ToolConversationCompactionOptions> = {}
): { items: unknown[]; compacted: number } {
  const options: ToolConversationCompactionOptions = {
    maxOutputChars: Math.max(800, Math.floor(partialOptions.maxOutputChars || 3000)),
    outputHeadChars: Math.max(200, Math.floor(partialOptions.outputHeadChars || 1200)),
    outputTailChars: Math.max(120, Math.floor(partialOptions.outputTailChars || 600)),
    maxArgumentChars: Math.max(300, Math.floor(partialOptions.maxArgumentChars || 1000)),
    maxArgumentArrayItems: Math.max(3, Math.floor(partialOptions.maxArgumentArrayItems || 20)),
    maxArgumentObjectKeys: Math.max(4, Math.floor(partialOptions.maxArgumentObjectKeys || 24)),
    argumentRedactKeys: Array.isArray(partialOptions.argumentRedactKeys) && partialOptions.argumentRedactKeys.length > 0
      ? partialOptions.argumentRedactKeys.map(item => String(item || '').trim()).filter(Boolean)
      : [...DEFAULT_ARGUMENT_REDACT_KEYS]
  };

  const next: unknown[] = [];
  let compacted = 0;
  for (const item of items || []) {
    const result = compactToolConversationItemInternal(item, options);
    next.push(result.item);
    if (result.compacted) compacted += 1;
  }
  return { items: next, compacted };
}

export function selectToolOutcomeHighlights(toolOutputs: ToolResultLike[], limit = 4): string[] {
  if (!Array.isArray(toolOutputs) || toolOutputs.length === 0) return [];
  const lines: string[] = [];
  for (let i = toolOutputs.length - 1; i >= 0 && lines.length < limit; i -= 1) {
    const item = toolOutputs[i];
    if (!item || !item.name) continue;
    if (item.ok) {
      if (!item.output || !item.output.trim()) continue;
      lines.push(`- ${item.name}: ${compactLine(item.output, 260)}`);
      continue;
    }
    if (item.error && item.error.trim()) {
      lines.push(`- ${item.name} (error): ${compactLine(item.error, 200)}`);
    }
  }
  return lines;
}

export function buildForcedSynthesisPrompt(params: {
  reason: string;
  pendingCalls: ToolCallLike[];
  toolOutputs: ToolResultLike[];
}): string {
  const pendingSummary = params.pendingCalls.length > 0
    ? params.pendingCalls.map(call => `- ${call.name}`).slice(0, 8).join('\n')
    : '- none';
  const outcomeLines = selectToolOutcomeHighlights(params.toolOutputs, 6);
  const outcomes = outcomeLines.length > 0 ? outcomeLines.join('\n') : '- no tool outputs captured';
  return [
    '[SYSTEM CONTINUATION]',
    `Tool loop ended because: ${params.reason}.`,
    'Produce a final assistant response now.',
    'Do not call more tools in this response.',
    'If there is missing data, state what is missing and provide the best next action.',
    '',
    'Pending tool calls:',
    pendingSummary,
    '',
    'Recent tool outcomes:',
    outcomes
  ].join('\n');
}

export function buildToolOutcomeFallback(params: {
  reason: string;
  toolOutputs: ToolResultLike[];
  pendingCalls: ToolCallLike[];
}): string {
  const highlights = selectToolOutcomeHighlights(params.toolOutputs, 5);
  const lines = [
    `I completed tool work but could not produce a full final response (${params.reason}).`,
  ];
  if (highlights.length > 0) {
    lines.push('Here are the most relevant tool outcomes:');
    lines.push(...highlights);
  }
  if (params.pendingCalls.length > 0) {
    lines.push(`Unresolved tool calls: ${params.pendingCalls.map(call => call.name).slice(0, 8).join(', ')}.`);
  }
  lines.push('Tell me if you want me to continue from this point or change approach.');
  return lines.join('\n');
}
