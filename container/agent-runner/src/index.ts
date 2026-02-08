/**
 * DotClaw Agent Runner (OpenRouter)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenRouter } from '@openrouter/sdk';
import { createTools, discoverMcpTools, ToolCallRecord, type ToolResultRecord } from './tools.js';
import { createIpcHandlers } from './ipc.js';
import { loadAgentConfig } from './agent-config.js';
import { OUTPUT_START_MARKER, OUTPUT_END_MARKER, type ContainerInput, type ContainerOutput } from './container-protocol.js';
import {
  createSessionContext,
  appendHistory,
  loadHistory,
  splitRecentHistory,
  shouldCompact,
  archiveConversation,
  buildSummaryPrompt,
  buildMultiPartSummaryPrompt,
  splitMessagesByTokenShare,
  parseSummaryResponse,
  saveMemoryState,
  writeHistory,
  estimateTokens,
  pruneContextMessages,
  limitHistoryTurns,
  MemoryConfig,
  Message
} from './memory.js';
import { loadPromptPackWithCanary, formatPromptPack, PromptPack } from './prompt-packs.js';
import { buildSkillCatalog, type SkillCatalog } from './skill-loader.js';
import { buildSystemPrompt } from './system-prompt.js';
import { buildContextOverflowRecoveryPlan } from './context-overflow-recovery.js';
import {
  buildForcedSynthesisPrompt,
  buildToolExecutionNudgePrompt,
  buildToolOutcomeFallback,
  compactToolConversationItems,
  detectToolExecutionRequirement,
  isNonRetryableToolError,
  normalizeToolCallArguments,
  normalizeToolCallSignature,
  normalizeToolRoundSignature,
  parseCreateReadFileInstruction,
  parseListReadNewestInstruction,
  shouldRetryIdempotentToolCall,
} from './tool-loop-policy.js';

type OpenRouterResult = ReturnType<OpenRouter['callModel']>;


const SESSION_ROOT = '/workspace/session';
const GROUP_DIR = '/workspace/group';
const IPC_DIR = '/workspace/ipc';
const GLOBAL_DIR = '/workspace/global';
const PROMPTS_DIR = '/workspace/prompts';
const AVAILABLE_GROUPS_PATH = '/workspace/ipc/available_groups.json';
const GROUP_CLAUDE_PATH = path.join(GROUP_DIR, 'CLAUDE.md');
const GLOBAL_CLAUDE_PATH = path.join(GLOBAL_DIR, 'CLAUDE.md');
const CLAUDE_NOTES_MAX_CHARS = 4000;

const agentConfig = loadAgentConfig();
const agent = agentConfig.agent;

const PROMPT_PACKS_ENABLED = agent.promptPacks.enabled;
const PROMPT_PACKS_MAX_CHARS = agent.promptPacks.maxChars;
const PROMPT_PACKS_MAX_DEMOS = agent.promptPacks.maxDemos;
const PROMPT_PACKS_CANARY_RATE = agent.promptPacks.canaryRate;

// ── Model cooldown tracking ──────────────────────────────────────────
// After a model fails, put it in cooldown. 429 → 60s, 5xx/timeout → 300s.
const modelCooldowns = new Map<string, number>(); // model → cooldown-until epoch ms

function isModelInCooldown(model: string): boolean {
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

function cooldownModel(model: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  let durationMs = 300_000; // default: 5 min for 5xx/timeout
  if (/429|rate.?limit/.test(lower)) {
    durationMs = 60_000; // 1 min for rate limits
  }
  modelCooldowns.set(model, Date.now() + durationMs);
  log(`Model ${model} in cooldown for ${durationMs / 1000}s`);
}

// ── Reply tag parsing ────────────────────────────────────────────────
// Parse [[reply_to_current]] and [[reply_to:<id>]] tags from agent output.
export function parseReplyTags(text: string): { cleanText: string; replyToId?: string } {
  if (!text) return { cleanText: text };
  const replyCurrentMatch = text.match(/\[\[reply_to_current\]\]/);
  const replyIdMatch = text.match(/\[\[reply_to:(\d+)\]\]/);
  let replyToId: string | undefined;
  let cleanText = text;

  if (replyIdMatch) {
    replyToId = replyIdMatch[1];
    cleanText = cleanText.replace(/\[\[reply_to:\d+\]\]/g, '').trim();
  } else if (replyCurrentMatch) {
    replyToId = '__current__'; // sentinel — host resolves to the triggering message
    cleanText = cleanText.replace(/\[\[reply_to_current\]\]/g, '').trim();
  }

  return { cleanText, replyToId };
}

let cachedOpenRouter: OpenRouter | null = null;
let cachedOpenRouterKey = '';
let cachedOpenRouterOptions = '';

function getCachedOpenRouter(apiKey: string, options: ReturnType<typeof getOpenRouterOptions>): OpenRouter {
  const optionsKey = JSON.stringify(options);
  if (cachedOpenRouter && cachedOpenRouterKey === apiKey && cachedOpenRouterOptions === optionsKey) {
    return cachedOpenRouter;
  }
  const client = new OpenRouter({
    apiKey,
    ...options
  });

  // The SDK accepts httpReferer/xTitle in the constructor but never injects
  // them as HTTP headers in the Responses API path (betaResponsesSend).
  // Wrap callModel to inject them on every request.
  const { httpReferer, xTitle } = options;
  if (httpReferer || xTitle) {
    const extraHeaders: Record<string, string> = {};
    if (httpReferer) extraHeaders['HTTP-Referer'] = httpReferer;
    if (xTitle) extraHeaders['X-Title'] = xTitle;

    const originalCallModel = client.callModel.bind(client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client.callModel = (request: any, opts?: any) => {
      return originalCallModel(request, {
        ...opts,
        headers: { ...extraHeaders, ...(opts?.headers as Record<string, string>) }
      });
    };
  }

  cachedOpenRouter = client;
  cachedOpenRouterKey = apiKey;
  cachedOpenRouterOptions = optionsKey;
  return cachedOpenRouter;
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function classifyError(err: unknown): 'retryable' | 'context_overflow' | null {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (/maximum context length|context.?length.?exceeded|too many tokens/i.test(msg)) return 'context_overflow';
  if (/429|rate.?limit/.test(lower)) return 'retryable';
  if (/\b5\d{2}\b/.test(msg) || /server error|bad gateway|unavailable/.test(lower)) return 'retryable';
  if (/timeout|timed out|deadline/.test(lower)) return 'retryable';
  if (/model.?not.?available|no endpoints|provider error/.test(lower)) return 'retryable';
  return null;
}

// ── Response text extraction ─────────────────────────────────────────

async function getResponseText(result: OpenRouterResult, context: string): Promise<{ text: string; error?: string }> {
  try {
    const text = await result.getText();
    if (typeof text === 'string' && text.trim()) {
      return { text };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`getText failed (${context}): ${message}`);
    return { text: '', error: message };
  }
  return { text: '' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextFromApiResponse(response: any): string {
  if (response?.outputText) return response.outputText;
  for (const item of response?.output || []) {
    if (item?.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && part.text) return part.text;
      }
    }
  }
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractFunctionCalls(response: any): Array<{ id: string; name: string; arguments: any }> {
  const calls: Array<{ id: string; name: string; arguments: unknown }> = [];
  for (const item of response?.output || []) {
    if (item?.type === 'function_call') {
      let args = item.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* keep as string */ }
      }
      calls.push({ id: item.callId, name: item.name, arguments: args });
    }
  }
  return calls;
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

async function runSelfCheck(params: {
  model: string;
}) {
  const details: string[] = [];

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  fs.mkdirSync(GROUP_DIR, { recursive: true });
  fs.mkdirSync(SESSION_ROOT, { recursive: true });
  fs.mkdirSync(IPC_DIR, { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(IPC_DIR, 'tasks'), { recursive: true });

  const filePath = path.join(GROUP_DIR, '.dotclaw-selfcheck');
  fs.writeFileSync(filePath, `self-check-${Date.now()}`);
  const readBack = fs.readFileSync(filePath, 'utf-8');
  if (!readBack.startsWith('self-check-')) {
    throw new Error('Failed to read back self-check file');
  }
  fs.unlinkSync(filePath);
  details.push('group directory writable');

  const sessionPath = path.join(SESSION_ROOT, 'self-check');
  fs.mkdirSync(sessionPath, { recursive: true });
  const sessionFile = path.join(sessionPath, 'probe.txt');
  fs.writeFileSync(sessionFile, 'ok');
  fs.readFileSync(sessionFile, 'utf-8');
  fs.unlinkSync(sessionFile);
  details.push('session directory writable');

  const ipcFile = path.join(IPC_DIR, 'messages', `self-check-${Date.now()}.json`);
  fs.writeFileSync(ipcFile, JSON.stringify({ ok: true }, null, 2));
  fs.unlinkSync(ipcFile);
  details.push('ipc directory writable');

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json'
  };
  if (agent.openrouter.siteUrl) {
    headers['HTTP-Referer'] = agent.openrouter.siteUrl;
  }
  if (agent.openrouter.siteName) {
    headers['X-Title'] = agent.openrouter.siteName;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: 'user', content: 'Return exactly the string "OK".' }],
      max_tokens: 8,
      temperature: 0
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  try {
    const data = JSON.parse(bodyText);
    const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text;
    if (!content || !String(content).trim()) {
      throw new Error('OpenRouter call returned empty response');
    }
  } catch (err) {
    throw new Error(`OpenRouter response parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  details.push('openrouter call ok');

  return details;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function getConfig(config: ReturnType<typeof loadAgentConfig>): MemoryConfig & {
  maxOutputTokens: number;
  summaryMaxOutputTokens: number;
  temperature: number;
} {
  return {
    maxContextTokens: config.agent.context.maxContextTokens,
    compactionTriggerTokens: config.agent.context.compactionTriggerTokens,
    recentContextTokens: config.agent.context.recentContextTokens,
    summaryUpdateEveryMessages: config.agent.context.summaryUpdateEveryMessages,
    memoryMaxResults: config.agent.memory.maxResults,
    memoryMaxTokens: config.agent.memory.maxTokens,
    maxOutputTokens: config.agent.context.maxOutputTokens,
    summaryMaxOutputTokens: config.agent.context.summaryMaxOutputTokens,
    temperature: config.agent.context.temperature
  };
}

function resolveModelLimits(
  input: ContainerInput,
  configDefaults: { maxContextTokens: number; maxOutputTokens: number; compactionTriggerTokens: number; maxContextMessageTokens: number }
) {
  const caps = input.modelCapabilities;

  // Context: use model capability, fall back to config
  const contextLength = caps?.context_length || configDefaults.maxContextTokens;

  // Output tokens: only set when explicitly configured by user.
  // DO NOT use caps.max_completion_tokens — for reasoning models, maxOutputTokens covers
  // both reasoning tokens AND visible text. Setting it to the model's max causes the model
  // to allocate the entire budget to reasoning with 0 left for visible output.
  let maxOutputTokens: number | undefined;
  if (input.modelMaxOutputTokens && Number.isFinite(input.modelMaxOutputTokens)) {
    maxOutputTokens = input.modelMaxOutputTokens;  // Explicit cost-control override
  }
  // else: undefined — omit from callModel(), let the API decide token budgeting

  // Derive other limits from context length
  const outputReserve = maxOutputTokens || Math.floor(contextLength * 0.25);
  const maxContextTokens = contextLength;
  const compactionTriggerTokens = Math.max(1000, contextLength - outputReserve);
  const maxContextMessageTokens = Math.max(1000, Math.floor(contextLength * 0.03));

  return { maxContextTokens, maxOutputTokens, compactionTriggerTokens, maxContextMessageTokens };
}

function getOpenRouterOptions(config: ReturnType<typeof loadAgentConfig>) {
  const timeoutMs = config.agent.openrouter.timeoutMs;
  const retryEnabled = config.agent.openrouter.retry;
  const retryConfig = retryEnabled
    ? {
      strategy: 'backoff' as const,
      backoff: {
        initialInterval: 500,
        maxInterval: 5000,
        exponent: 2,
        maxElapsedTime: 20_000
      },
      retryConnectionErrors: true
    }
    : { strategy: 'none' as const };

  return {
    timeoutMs,
    retryConfig,
    httpReferer: config.agent.openrouter.siteUrl || undefined,
    xTitle: config.agent.openrouter.siteName || undefined
  };
}

function resolveTokenEstimate(
  input: ContainerInput,
  config: ReturnType<typeof loadAgentConfig>
): { tokensPerChar: number; tokensPerMessage: number; tokensPerRequest: number } {
  const fallbackChar = config.agent.tokenEstimate.tokensPerChar;
  const fallbackMessage = config.agent.tokenEstimate.tokensPerMessage;
  const fallbackRequest = config.agent.tokenEstimate.tokensPerRequest;
  const tokensPerChar = Number.isFinite(input.tokenEstimate?.tokens_per_char)
    ? Number(input.tokenEstimate?.tokens_per_char)
    : fallbackChar;
  const tokensPerMessage = Number.isFinite(input.tokenEstimate?.tokens_per_message)
    ? Number(input.tokenEstimate?.tokens_per_message)
    : fallbackMessage;
  const tokensPerRequest = Number.isFinite(input.tokenEstimate?.tokens_per_request)
    ? Number(input.tokenEstimate?.tokens_per_request)
    : fallbackRequest;
  return {
    tokensPerChar: Math.max(0, tokensPerChar),
    tokensPerMessage: Math.max(0, tokensPerMessage),
    tokensPerRequest: Math.max(0, tokensPerRequest)
  };
}

function estimateTokensForModel(text: string, tokensPerChar: number): number {
  if (!text) return 0;
  const bytes = Buffer.byteLength(text, 'utf-8');
  return Math.ceil(bytes * tokensPerChar);
}

function estimateMessagesTokens(messages: Message[], tokensPerChar: number, tokensPerMessage: number): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForModel(message.content, tokensPerChar);
    total += tokensPerMessage;
  }
  return total;
}

function buildInstructions(params: {
  assistantName: string;
  groupNotes?: string | null;
  globalNotes?: string | null;
  skillCatalog?: SkillCatalog | null;
  memorySummary: string;
  memoryFacts: string[];
  sessionRecall: string[];
  longTermRecall: string[];
  userProfile?: string | null;
  memoryStats?: { total: number; user: number; group: number; global: number };
  availableGroups?: Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>;
  toolReliability?: Array<{ name: string; success_rate: number; count: number; avg_duration_ms: number | null }>;
  behaviorConfig?: Record<string, unknown>;
  isScheduledTask: boolean;
  taskId?: string;
  timezone?: string;
  hostPlatform?: string;
  messagingPlatform?: string;
  taskExtractionPack?: PromptPack | null;
  responseQualityPack?: PromptPack | null;
  toolCallingPack?: PromptPack | null;
  toolOutcomePack?: PromptPack | null;
  memoryPolicyPack?: PromptPack | null;
  memoryRecallPack?: PromptPack | null;
  maxToolSteps?: number;
  trimLevel?: number;
}): string {
  return buildSystemPrompt({
    mode: 'full',
    assistantName: params.assistantName,
    messagingPlatform: params.messagingPlatform,
    hostPlatform: params.hostPlatform,
    timezone: params.timezone,
    isScheduledTask: params.isScheduledTask,
    taskId: params.taskId,
    groupNotes: params.groupNotes,
    globalNotes: params.globalNotes,
    skillCatalog: params.skillCatalog,
    memorySummary: params.memorySummary,
    memoryFacts: params.memoryFacts,
    sessionRecall: params.sessionRecall,
    longTermRecall: params.longTermRecall,
    userProfile: params.userProfile,
    memoryStats: params.memoryStats,
    availableGroups: params.availableGroups,
    toolReliability: params.toolReliability,
    behaviorConfig: params.behaviorConfig,
    taskExtractionPack: params.taskExtractionPack,
    responseQualityPack: params.responseQualityPack,
    toolCallingPack: params.toolCallingPack,
    toolOutcomePack: params.toolOutcomePack,
    memoryPolicyPack: params.memoryPolicyPack,
    memoryRecallPack: params.memoryRecallPack,
    maxToolSteps: params.maxToolSteps,
    browserEnabled: agentConfig.agent.browser.enabled,
    promptPacksMaxChars: PROMPT_PACKS_MAX_CHARS,
    promptPacksMaxDemos: PROMPT_PACKS_MAX_DEMOS,
    trimLevel: params.trimLevel,
  });
}

function loadAvailableGroups(): Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }> {
  try {
    if (!fs.existsSync(AVAILABLE_GROUPS_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(AVAILABLE_GROUPS_PATH, 'utf-8')) as {
      groups?: Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>;
    };
    return Array.isArray(raw.groups) ? raw.groups.filter(group => group && typeof group.jid === 'string') : [];
  } catch {
    return [];
  }
}

function readTextFileLimited(filePath: string, maxChars: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return null;
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n\n[Truncated for length]`;
  } catch {
    return null;
  }
}

function loadClaudeNotes(): { group: string | null; global: string | null } {
  return {
    group: readTextFileLimited(GROUP_CLAUDE_PATH, CLAUDE_NOTES_MAX_CHARS),
    global: readTextFileLimited(GLOBAL_CLAUDE_PATH, CLAUDE_NOTES_MAX_CHARS)
  };
}


// ── Image/Vision support ──────────────────────────────────────────────

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB per image
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB total across all images
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function loadImageAttachments(attachments?: ContainerInput['attachments']): Array<{
  type: 'image_url';
  image_url: { url: string };
}> {
  if (!attachments) return [];
  const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  let totalBytes = 0;
  for (const att of attachments) {
    if (att.type !== 'photo') continue;
    const mime = att.mime_type || 'image/jpeg';
    if (!IMAGE_MIME_TYPES.has(mime)) continue;
    try {
      const stat = fs.statSync(att.path);
      if (stat.size > MAX_IMAGE_BYTES) {
        log(`Skipping image ${att.path}: ${stat.size} bytes exceeds ${MAX_IMAGE_BYTES}`);
        continue;
      }
      if (totalBytes + stat.size > MAX_TOTAL_IMAGE_BYTES) {
        log(`Skipping image ${att.path}: cumulative size would exceed ${MAX_TOTAL_IMAGE_BYTES}`);
        break;
      }
      const data = fs.readFileSync(att.path);
      totalBytes += data.length;
      const b64 = data.toString('base64');
      images.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${b64}` }
      });
    } catch (err) {
      log(`Failed to load image ${att.path}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return images;
}

function messagesToOpenRouter(messages: Message[]) {
  return messages.map(message => ({
    role: message.role,
    content: message.content
  }));
}

function clampContextMessages(messages: Message[], tokensPerChar: number, maxTokens: number): Message[] {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return messages;
  const tpc = tokensPerChar > 0 ? tokensPerChar : 0.25;
  const maxBytes = Math.max(200, Math.floor(maxTokens / tpc));
  const suffix = '\n\n[Context truncated for length]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf-8');
  return messages.map(message => {
    const contentBytes = Buffer.byteLength(message.content, 'utf-8');
    if (contentBytes <= maxBytes) return message;
    const budget = Math.max(0, maxBytes - suffixBytes);
    const truncated = Buffer.from(message.content, 'utf-8')
      .subarray(0, budget)
      .toString('utf-8');
    return { ...message, content: `${truncated}${suffix}` };
  });
}

function shouldDisableToolsForPrompt(prompt: string, toolRequired: boolean): boolean {
  if (toolRequired) return false;
  const text = String(prompt || '').trim();
  if (!text) return false;
  if (/\[(?:scenario:)?memory(?:_carryover)?\]/i.test(text)) return true;
  if (/\bfrom\s+(?:this|our)\s+(?:same\s+)?(?:conversation|chat)\b/i.test(text)) return true;
  if (/\bwhat\s+did\s+(?:i|you)\s+just\b/i.test(text)) return true;
  if (/\bearlier\s+in\s+(?:this\s+)?(?:conversation|chat)\b/i.test(text)) return true;
  return false;
}

function resolvePromptOutputCap(prompt: string): number | undefined {
  const text = String(prompt || '').trim();
  if (!text) return undefined;
  let cap: number | undefined;

  if (/\b(?:one|single)[-\s]?word\b/i.test(text)) {
    cap = 48;
  }

  if (/\bone\s+(?:concise\s+|short\s+|brief\s+)?sentence\b/i.test(text)) {
    cap = cap ? Math.min(cap, 180) : 180;
  }

  const bulletMatch = text.match(/\bexactly\s+(\d+)\s+bullet(?:\s+point)?s?\b/i);
  if (bulletMatch) {
    const bulletCount = Math.min(10, Math.max(1, Math.floor(Number(bulletMatch[1]) || 0)));
    const bulletCap = Math.max(180, Math.min(900, 140 + (bulletCount * 90)));
    cap = cap ? Math.min(cap, bulletCap) : bulletCap;
  }

  if (/\bconcise|brief|short\b/i.test(text)) {
    cap = cap ? Math.min(cap, 260) : 260;
  }

  return cap;
}

async function updateMemorySummary(params: {
  openrouter: OpenRouter;
  model: string;
  existingSummary: string;
  existingFacts: string[];
  newMessages: Message[];
  maxOutputTokens: number;
}): Promise<{ summary: string; facts: string[] } | null> {
  if (params.newMessages.length === 0) return null;
  const prompt = buildSummaryPrompt(params.existingSummary, params.existingFacts, params.newMessages);
  const result = await params.openrouter.callModel({
    model: params.model,
    instructions: prompt.instructions,
    input: prompt.input,
    maxOutputTokens: params.maxOutputTokens,
    temperature: 0.1,
    reasoning: { effort: 'low' as const }
  });
  const { text } = await getResponseText(result, 'summary');
  return parseSummaryResponse(text);
}

function buildMemoryExtractionPrompt(params: {
  assistantName: string;
  userId?: string;
  userName?: string;
  messages: Message[];
  memoryPolicyPack?: PromptPack | null;
}): { instructions: string; input: string } {
  const policyBlock = params.memoryPolicyPack
    ? formatPromptPack({
      label: 'Memory Policy Guidelines',
      pack: params.memoryPolicyPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const instructions = [
    `You are ${params.assistantName}'s long-term memory extractor.`,
    'Extract durable, user-approved memories only.',
    'Prefer stable facts, preferences, identity details, projects, and long-running tasks.',
    'Avoid transient details, ephemeral scheduling, or speculative statements.',
    'If the user explicitly asked to remember something, include it.',
    'Return JSON only with key "items": array of memory objects.',
    'Each item fields:',
    '- scope: "user" | "group" | "global"',
    '- subject_id: user id for user scope (optional for group/global)',
    '- type: "identity" | "preference" | "fact" | "relationship" | "project" | "task" | "note"',
    '- kind: optional "semantic" | "episodic" | "procedural" | "preference"',
    '- conflict_key: optional string to replace older memories with same key (e.g., "favorite_color")',
    '- content: the memory string',
    '- importance: 0-1 (higher = more important)',
    '- confidence: 0-1',
    '- tags: array of short tags',
    '- ttl_days: optional number (omit for permanent memories).',
    '- For preferences about response style, tool usage, caution, or memory strictness, use conflict_key:',
    '  response_style, tool_calling_bias, caution_bias, memory_importance_threshold.',
    '  Include metadata fields for these preferences where possible, e.g.',
    '  { "metadata": { "response_style": "concise" } } or { "metadata": { "bias": 0.7 } }.',
    policyBlock
  ].filter(Boolean).join('\n');

  const transcript = params.messages
    .map(msg => `${msg.role.toUpperCase()}: ${msg.content}`)
    .join('\n\n');

  const input = [
    `User: ${params.userName || 'Unknown'} (${params.userId || 'unknown'})`,
    'Transcript:',
    transcript
  ].join('\n\n');

  return { instructions, input };
}

function parseMemoryExtraction(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  let jsonText = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonText);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter((item: unknown) => !!item && typeof item === 'object');
  } catch {
    return [];
  }
}

export async function runAgentOnce(input: ContainerInput): Promise<ContainerOutput> {
  log(`Received input for group: ${input.groupFolder}`);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      status: 'error',
      result: null,
      error: 'OPENROUTER_API_KEY is not set'
    };
  }

  const model = input.modelOverride || agentConfig.defaultModel;
  const summaryModel = agent.models.summary;
  const memoryModel = agent.models.memory;
  const assistantName = agent.assistantName;
  const config = getConfig(agentConfig);
  const limits = resolveModelLimits(input, {
    maxContextTokens: config.maxContextTokens,
    maxOutputTokens: config.maxOutputTokens,
    compactionTriggerTokens: config.compactionTriggerTokens,
    maxContextMessageTokens: agent.context.maxContextMessageTokens,
  });
  config.maxContextTokens = limits.maxContextTokens;
  config.compactionTriggerTokens = limits.compactionTriggerTokens;
  const resolvedMaxOutputTokens = limits.maxOutputTokens;  // may be undefined
  const resolvedMaxContextMessageTokens = limits.maxContextMessageTokens;
  if (input.modelTemperature && Number.isFinite(input.modelTemperature)) {
    config.temperature = input.modelTemperature;
  }
  const openrouterOptions = getOpenRouterOptions(agentConfig);
  const maxToolSteps = Number.isFinite(input.maxToolSteps)
    ? Math.max(1, Math.floor(input.maxToolSteps as number))
    : agent.tools.maxToolSteps;
  const completionGuard = agent.tools.completionGuard;
  const idempotentRetryAttempts = Math.max(1, Math.floor(completionGuard.idempotentRetryAttempts));
  const idempotentRetryBackoffMs = Math.max(0, Math.floor(completionGuard.idempotentRetryBackoffMs));
  const repeatedSignatureThreshold = Math.max(2, Math.floor(completionGuard.repeatedSignatureThreshold));
  const repeatedRoundThreshold = Math.max(2, Math.floor(completionGuard.repeatedRoundThreshold));
  const nonRetryableFailureThreshold = Math.max(1, Math.floor(completionGuard.nonRetryableFailureThreshold || 3));
  const forceSynthesisAfterTools = completionGuard.forceSynthesisAfterTools !== false;
  const memoryExtractionEnabled = agent.memory.extraction.enabled;
  const isDaemon = process.env.DOTCLAW_DAEMON === '1';
  const memoryExtractionMaxMessages = agent.memory.extraction.maxMessages;
  const memoryExtractionMaxOutputTokens = agent.memory.extraction.maxOutputTokens;
  const memoryExtractScheduled = agent.memory.extractScheduled;
  const memoryArchiveSync = agent.memory.archiveSync;

  const openrouter = getCachedOpenRouter(apiKey, openrouterOptions);
  const tokenEstimate = resolveTokenEstimate(input, agentConfig);
  const availableGroups = loadAvailableGroups();
  const claudeNotes = loadClaudeNotes();
  const skillCatalog = buildSkillCatalog({
    groupDir: GROUP_DIR,
    globalDir: GLOBAL_DIR,
    maxSkills: agent.skills.maxSkills
  });

  const { ctx: sessionCtx, isNew } = createSessionContext(SESSION_ROOT, input.sessionId);
  const toolCalls: ToolCallRecord[] = [];
  const toolOutputs: ToolResultRecord[] = [];
  let memoryItemsUpserted = 0;
  let memoryItemsExtracted = 0;
  const timings: { memory_extraction_ms?: number; tool_ms?: number } = {};
  const ipc = createIpcHandlers({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  }, agent.ipc);
  const inputToolPolicy = (input.toolPolicy && typeof input.toolPolicy === 'object')
    ? input.toolPolicy as { allow?: string[]; deny?: string[] }
    : {};
  const hasAllowPolicy = Array.isArray(inputToolPolicy.allow);
  const allowedToolSet = new Set(
    (hasAllowPolicy ? (inputToolPolicy.allow || []) : [])
      .map((name) => String(name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const deniedToolSet = new Set(
    (inputToolPolicy.deny || [])
      .map((name) => String(name || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const isToolAllowedByPolicy = (name: string): boolean => {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized) return false;
    if (deniedToolSet.has(normalized)) return false;
    if (hasAllowPolicy && !allowedToolSet.has(normalized)) return false;
    return true;
  };
  const tools = createTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  }, agent, {
    onToolCall: (call) => {
      toolCalls.push(call);
    },
    onToolResult: (record) => {
      toolOutputs.push(record);
    },
    policy: input.toolPolicy
  });

  // Discover MCP external tools if enabled
  let mcpCleanup: (() => Promise<void>) | null = null;
  if (agent.mcp.enabled && agent.mcp.servers.length > 0) {
    try {
      // Build a minimal wrapExecute for MCP tools (policy + logging handled by createTools wrapExecute pattern)
      const wrapMcp = <TInput, TOutput>(name: string, execute: (args: TInput) => Promise<TOutput>) => {
        return async (args: TInput): Promise<TOutput> => {
          const start = Date.now();
          try {
            const result = await execute(args);
            toolCalls.push({ name, ok: true, duration_ms: Date.now() - start });
            return result;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            toolCalls.push({ name, ok: false, duration_ms: Date.now() - start, error });
            throw err;
          }
        };
      };
      const mcp = await discoverMcpTools(agent, wrapMcp);
      const filteredMcpTools = mcp.tools.filter(toolEntry => isToolAllowedByPolicy(toolEntry.function.name));
      tools.push(...filteredMcpTools);
      mcpCleanup = mcp.cleanup;
      if (filteredMcpTools.length > 0) {
        log(`MCP: discovered ${filteredMcpTools.length} external tools`);
      }
    } catch (err) {
      log(`MCP discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const cleanupMcpConnections = async () => {
    if (!mcpCleanup) return;
    const cleanup = mcpCleanup;
    mcpCleanup = null;
    try {
      await cleanup();
    } catch {
      // ignore cleanup errors
    }
  };

  // Build schema-only tools (no execute functions) for SDK — prevents the SDK from
  // auto-executing tools in its internal loop, which drops conversation context in
  // follow-up API calls (makeFollowupRequest only sends model output + tool results,
  // losing the original user messages). We run the tool loop ourselves instead.
  const schemaTools = tools.map(t => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any
    const { execute, ...rest } = t.function as any;
    return { type: t.type, function: rest };
  }) as typeof tools;

  // Map tool names → original execute functions (with policy/callback wrappers intact)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolExecutors = new Map<string, (args: any) => Promise<any>>();
  for (const t of tools) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (t.function as any).execute;
    if (typeof fn === 'function') {
      toolExecutors.set(t.function.name, fn);
    }
  }

  if (process.env.DOTCLAW_SELF_CHECK === '1') {
    try {
      const details = await runSelfCheck({ model });
      await cleanupMcpConnections();
      return {
        status: 'success',
        result: `Self-check passed: ${details.join(', ')}`,
        newSessionId: isNew ? sessionCtx.sessionId : undefined
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Self-check failed: ${errorMessage}`);
      await cleanupMcpConnections();
      return {
        status: 'error',
        result: null,
        newSessionId: isNew ? sessionCtx.sessionId : undefined,
        error: errorMessage
      };
    }
  }

  // Resolve reasoning effort: input override > agent config > 'low'
  const VALID_EFFORTS = ['off', 'low', 'medium', 'high'] as const;
  const rawEffort = input.reasoningEffort || agent.reasoning?.effort || 'low';
  const reasoningEffort = VALID_EFFORTS.includes(rawEffort as typeof VALID_EFFORTS[number]) ? rawEffort : 'low';
  const resolvedReasoning = reasoningEffort === 'off'
    ? undefined
    : { effort: reasoningEffort as 'low' | 'medium' | 'high' };

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__dotclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }
  if (Array.isArray(input.attachments) && input.attachments.length > 0) {
    const attachmentSummary = input.attachments.map(attachment => {
      const parts = [`type=${attachment.type}`, `path=${attachment.path}`];
      if (attachment.file_name) parts.push(`filename=${attachment.file_name}`);
      if (attachment.mime_type) parts.push(`mime=${attachment.mime_type}`);
      if (Number.isFinite(attachment.file_size)) parts.push(`size=${attachment.file_size}`);
      return `- ${parts.join(' ')}`;
    }).join('\n');
    prompt = `${prompt}\n\n<latest_attachments>\n${attachmentSummary}\n</latest_attachments>`;
  }
  const toolExecutionRequirement = detectToolExecutionRequirement(prompt);
  const disableToolsForTurn = shouldDisableToolsForPrompt(prompt, toolExecutionRequirement.required);
  const promptOutputCap = resolvePromptOutputCap(prompt);
  const effectiveMaxOutputTokens = promptOutputCap
    ? (
      (typeof resolvedMaxOutputTokens === 'number' && Number.isFinite(resolvedMaxOutputTokens))
        ? Math.max(64, Math.min(resolvedMaxOutputTokens, promptOutputCap))
        : promptOutputCap
    )
    : resolvedMaxOutputTokens;
  if (typeof effectiveMaxOutputTokens === 'number' && effectiveMaxOutputTokens !== resolvedMaxOutputTokens) {
    log(`Applying prompt output cap: ${effectiveMaxOutputTokens} tokens`);
  }
  if (disableToolsForTurn) {
    log('Prompt classified as conversation-recall: disabling tool schema for this turn');
  }

  appendHistory(sessionCtx, 'user', prompt);
  let history = loadHistory(sessionCtx);

  if (agent.context.maxHistoryTurns > 0) {
    history = limitHistoryTurns(history, agent.context.maxHistoryTurns);
  }

  // Dynamic context budget: if recentContextTokens is 0 (auto), allocate 35% of context to
  // conversation history, capped at 24K tokens for latency/throughput stability.
  const effectiveRecentTokens = config.recentContextTokens > 0
    ? config.recentContextTokens
    : Math.min(24_000, Math.floor(config.maxContextTokens * 0.35));
  const tokenRatio = tokenEstimate.tokensPerChar > 0 ? (0.25 / tokenEstimate.tokensPerChar) : 1;
  const adjustedRecentTokens = Math.max(1000, Math.floor(effectiveRecentTokens * tokenRatio));

  const totalTokens = history.reduce(
    (sum, message) => sum + estimateTokensForModel(message.content, tokenEstimate.tokensPerChar) + tokenEstimate.tokensPerMessage,
    0
  );
  let { recentMessages, olderMessages } = splitRecentHistory(history, adjustedRecentTokens);

  if (shouldCompact(totalTokens, config)) {
    log(`Compacting history: ${totalTokens} tokens`);
    archiveConversation(history, sessionCtx.state.summary || null, GROUP_DIR);

    // Multi-part compaction: split older messages into chunks, summarize each
    const olderTokens = olderMessages.reduce(
      (sum, m) => sum + estimateTokens(m.content), 0
    );
    const MULTI_PART_THRESHOLD = 40_000; // Use multi-part for large histories
    const numParts = olderTokens > MULTI_PART_THRESHOLD ? Math.min(3, Math.ceil(olderTokens / MULTI_PART_THRESHOLD)) : 1;

    let summaryUpdate: { summary: string; facts: string[] } | null = null;

    if (numParts > 1) {
      log(`Multi-part compaction: ${numParts} parts`);
      const chunks = splitMessagesByTokenShare(olderMessages, numParts);
      const partSummaries: string[] = [];
      const mergedFacts: string[] = [...sessionCtx.state.facts];

      for (let i = 0; i < chunks.length; i++) {
        const partPrompt = buildMultiPartSummaryPrompt(
          sessionCtx.state.summary,
          mergedFacts,
          chunks[i],
          i,
          chunks.length,
          partSummaries
        );
        const partResult = openrouter.callModel({
          model: summaryModel,
          instructions: partPrompt.instructions,
          input: partPrompt.input,
          maxOutputTokens: config.summaryMaxOutputTokens,
          temperature: 0.1,
          reasoning: { effort: 'low' as const }
        });
        const { text: partText } = await getResponseText(partResult, `summary_part_${i}`);
        const parsed = parseSummaryResponse(partText);
        if (parsed) {
          partSummaries.push(parsed.summary);
          // Merge facts, deduplicating by content
          const existingSet = new Set(mergedFacts.map(f => f.toLowerCase()));
          for (const fact of parsed.facts) {
            if (!existingSet.has(fact.toLowerCase())) {
              mergedFacts.push(fact);
              existingSet.add(fact.toLowerCase());
            }
          }
        }
      }

      if (partSummaries.length > 0) {
        summaryUpdate = {
          summary: partSummaries.join(' '),
          facts: mergedFacts
        };
      }
    } else {
      summaryUpdate = await updateMemorySummary({
        openrouter,
        model: summaryModel,
        existingSummary: sessionCtx.state.summary,
        existingFacts: sessionCtx.state.facts,
        newMessages: olderMessages,
        maxOutputTokens: config.summaryMaxOutputTokens
      });
    }

    // Cap facts to prevent unbounded growth across compaction cycles.
    // Keep the most recent facts (end of array) since compaction appends new ones.
    const MAX_FACTS = 30;

    if (summaryUpdate) {
      const cappedFacts = summaryUpdate.facts.length > MAX_FACTS
        ? summaryUpdate.facts.slice(-MAX_FACTS)
        : summaryUpdate.facts;
      sessionCtx.state.summary = summaryUpdate.summary;
      sessionCtx.state.facts = cappedFacts;
      sessionCtx.state.lastSummarySeq = olderMessages.length > 0
        ? olderMessages[olderMessages.length - 1].seq
        : sessionCtx.state.lastSummarySeq;
      saveMemoryState(sessionCtx);

      if (memoryArchiveSync) {
        try {
          const archiveItems: Array<Record<string, unknown>> = [];
          if (summaryUpdate.summary) {
            archiveItems.push({
              scope: 'group',
              type: 'archive',
              content: `Conversation summary: ${summaryUpdate.summary}`,
              importance: 0.6,
              confidence: 0.7,
              tags: ['summary', 'archive']
            });
          }
          for (const fact of summaryUpdate.facts || []) {
            if (!fact || typeof fact !== 'string') continue;
            archiveItems.push({
              scope: 'group',
              type: 'fact',
              content: fact,
              importance: 0.7,
              confidence: 0.7,
              tags: ['fact', 'archive']
            });
          }
          if (archiveItems.length > 0) {
            await ipc.memoryUpsert({ items: archiveItems, source: 'compaction' });
            memoryItemsUpserted += archiveItems.length;
          }
        } catch (err) {
          log(`Memory archive sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    writeHistory(sessionCtx, recentMessages);
    history = recentMessages;
  }

  // Recompute split after possible compaction
  ({ recentMessages, olderMessages } = splitRecentHistory(history, adjustedRecentTokens));

  // Long-term memory is now tool-based (agent calls mcp__dotclaw__memory_search on demand).
  // Session recall removed — redundant with summary + facts + recent messages.
  const sessionRecallCount = 0;
  const memoryRecallCount = Array.isArray(input.memoryRecall) ? input.memoryRecall.length : 0;
  const memoryRecallCountForOutput = input.memoryRecallAttempted ? memoryRecallCount : undefined;

  const sharedPromptDir = fs.existsSync(PROMPTS_DIR) ? PROMPTS_DIR : undefined;
  const taskPackResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'task-extraction', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const responseQualityResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'response-quality', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const toolCallingResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'tool-calling', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const toolOutcomeResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'tool-outcome', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const memoryPolicyResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'memory-policy', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;
  const memoryRecallResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'memory-recall', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;

  const logPack = (label: string, result: { pack: PromptPack; source: string; isCanary?: boolean } | null) => {
    if (!result) return;
    const canaryNote = result.isCanary ? ' (canary)' : '';
    log(`Loaded prompt pack (${label}${canaryNote}): ${result.pack.name}@${result.pack.version}`);
  };
  logPack(taskPackResult?.source || 'unknown', taskPackResult);
  logPack(responseQualityResult?.source || 'unknown', responseQualityResult);
  logPack(toolCallingResult?.source || 'unknown', toolCallingResult);
  logPack(toolOutcomeResult?.source || 'unknown', toolOutcomeResult);
  logPack(memoryPolicyResult?.source || 'unknown', memoryPolicyResult);
  logPack(memoryRecallResult?.source || 'unknown', memoryRecallResult);

  const promptPackVersions: Record<string, string> = {};
  if (taskPackResult) promptPackVersions['task-extraction'] = taskPackResult.pack.version;
  if (responseQualityResult) promptPackVersions['response-quality'] = responseQualityResult.pack.version;
  if (toolCallingResult) promptPackVersions['tool-calling'] = toolCallingResult.pack.version;
  if (toolOutcomeResult) promptPackVersions['tool-outcome'] = toolOutcomeResult.pack.version;
  if (memoryPolicyResult) promptPackVersions['memory-policy'] = memoryPolicyResult.pack.version;
  if (memoryRecallResult) promptPackVersions['memory-recall'] = memoryRecallResult.pack.version;

  const resolveInstructions = (trimLevel = 0) => {
    const base = buildInstructions({
      assistantName,
      groupNotes: claudeNotes.group,
      globalNotes: claudeNotes.global,
      skillCatalog,
      memorySummary: sessionCtx.state.summary,
      memoryFacts: sessionCtx.state.facts,
      sessionRecall: [],
      longTermRecall: [],
      userProfile: input.userProfile ?? null,
      memoryStats: input.memoryStats,
      availableGroups,
      toolReliability: input.toolReliability,
      behaviorConfig: input.behaviorConfig,
      isScheduledTask: !!input.isScheduledTask,
      taskId: input.taskId,
      timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
      hostPlatform: typeof input.hostPlatform === 'string' ? input.hostPlatform : undefined,
      messagingPlatform: input.chatJid?.includes(':') ? input.chatJid.split(':')[0] : undefined,
      taskExtractionPack: taskPackResult?.pack || null,
      responseQualityPack: responseQualityResult?.pack || null,
      toolCallingPack: toolCallingResult?.pack || null,
      toolOutcomePack: toolOutcomeResult?.pack || null,
      memoryPolicyPack: memoryPolicyResult?.pack || null,
      memoryRecallPack: memoryRecallResult?.pack || null,
      maxToolSteps,
      trimLevel
    });
    if (!toolExecutionRequirement.required) return base;
    const reason = toolExecutionRequirement.reason || 'required_tool_execution';
    return `${base}\n\n[Tool Execution Requirement]\nThis request requires real tool execution (${reason}). Do not claim file/system/web actions unless matching tool calls in this turn succeeded. If tools fail, state the failure clearly and provide the best next action.`;
  };

  const buildContext = () => {
    // System prompt budget: keep prompt lean for lower p95 latency.
    // Cap absolute size to avoid over-spending tokens on instructions.
    const systemPromptShare = input.isScheduledTask ? 0.1 : 0.12;
    const maxSystemPromptTokens = Math.max(
      1200,
      Math.min(6000, Math.floor(config.maxContextTokens * systemPromptShare))
    );
    const MAX_TRIM_LEVEL = 4;

    let resolvedInstructions = '';
    let resolvedInstructionTokens = 0;
    let trimLevel = 0;

    // Progressive trimming loop: build prompt, check size, trim if needed
    for (trimLevel = 0; trimLevel <= MAX_TRIM_LEVEL; trimLevel++) {
      resolvedInstructions = resolveInstructions(trimLevel);
      resolvedInstructionTokens = estimateTokensForModel(resolvedInstructions, tokenEstimate.tokensPerChar);
      if (resolvedInstructionTokens <= maxSystemPromptTokens || trimLevel === MAX_TRIM_LEVEL) {
        break;
      }
      log(`System prompt ${resolvedInstructionTokens} tokens exceeds budget ${maxSystemPromptTokens}, trimming (level ${trimLevel + 1})`);
    }

    const outputReserve = resolvedMaxOutputTokens || Math.floor(config.maxContextTokens * 0.25);
    const resolvedMaxContext = Math.max(config.maxContextTokens - outputReserve - resolvedInstructionTokens, 2000);
    const resolvedAdjusted = Math.max(
      1000,
      Math.min(adjustedRecentTokens, Math.floor(resolvedMaxContext * tokenRatio))
    );
    let { recentMessages: contextMessages } = splitRecentHistory(recentMessages, resolvedAdjusted, 6);
    contextMessages = clampContextMessages(contextMessages, tokenEstimate.tokensPerChar, resolvedMaxContextMessageTokens);
    contextMessages = pruneContextMessages(contextMessages, agent.context.contextPruning);
    return {
      instructions: resolvedInstructions,
      instructionsTokens: resolvedInstructionTokens,
      contextMessages
    };
  };

  let responseText = '';
  let completionTokens = 0;
  let promptTokens = 0;
  let latencyMs: number | undefined;
  let toolRetryAttempts = 0;
  let toolOutcomeVerificationForced = false;
  let toolLoopBreakerTriggered = false;
  let toolLoopBreakerReason: string | undefined;

  const modelChain = [model, ...(input.modelFallbacks || [])].slice(0, 3);
  let currentModel = model;
  const toolTrimConfig = agent.context.contextPruning;
  const toolSoftTrimMaxChars = Math.max(500, Math.floor(toolTrimConfig.softTrimMaxChars || 4000));
  const toolSoftTrimHead = Math.max(100, Math.floor(toolTrimConfig.softTrimHeadChars || 1500));
  const toolSoftTrimTail = Math.max(100, Math.floor(toolTrimConfig.softTrimTailChars || 1500));
  const followupOutputMaxChars = Math.max(900, Math.floor(toolSoftTrimMaxChars * 0.75));
  const followupArgumentMaxChars = Math.max(300, Math.floor(toolSoftTrimMaxChars * 0.25));
  let streamSeq = 0;

  if (input.streamDir) {
    try {
      fs.mkdirSync(input.streamDir, { recursive: true });
    } catch {
      // ignore stream dir creation failure; normal response still works
    }
  }

  const writeStreamChunk = (text: string) => {
    if (!input.streamDir) return;
    streamSeq += 1;
    const chunkFile = path.join(input.streamDir, `chunk_${String(streamSeq).padStart(6, '0')}.txt`);
    const tmpFile = `${chunkFile}.tmp`;
    try {
      fs.writeFileSync(tmpFile, text);
      fs.renameSync(tmpFile, chunkFile);
    } catch (writeErr) {
      log(`Stream write error at seq ${streamSeq}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
    }
  };

  const finalizeStream = () => {
    if (!input.streamDir) return;
    try {
      const donePath = path.join(input.streamDir, 'done');
      if (!fs.existsSync(donePath)) {
        fs.writeFileSync(donePath, '');
      }
    } catch {
      // ignore
    }
  };

  const markStreamError = (errorMessage: string) => {
    if (!input.streamDir) return;
    try {
      const donePath = path.join(input.streamDir, 'done');
      if (!fs.existsSync(donePath)) {
        fs.writeFileSync(path.join(input.streamDir, 'error'), errorMessage);
      }
    } catch {
      // ignore
    }
  };

  try {
    const { instructions: resolvedInstructions, instructionsTokens: resolvedInstructionTokens, contextMessages } = buildContext();
    // Apply 1.3x safety margin to account for token estimation inaccuracy.
    // estimateTokensForModel (bytes * 0.25) underestimates by 30-40% in practice.
    // OpenClaw uses SAFETY_MARGIN = 1.2; we use 1.3 for extra safety.
    const TOKEN_SAFETY_MARGIN = 1.3;
    const resolvedPromptTokens = Math.ceil((resolvedInstructionTokens
      + estimateMessagesTokens(contextMessages, tokenEstimate.tokensPerChar, tokenEstimate.tokensPerMessage)
      + tokenEstimate.tokensPerRequest) * TOKEN_SAFETY_MARGIN);

    // Safe limit: context window minus tool schema reserve (~6K) and output reserve
    const safeLimit = Math.floor(config.maxContextTokens * 0.75);
    if (resolvedPromptTokens > safeLimit && contextMessages.length > 2) {
      log(`Estimated ${resolvedPromptTokens} tokens (with 1.3x margin) exceeds safe limit ${safeLimit}, truncating`);
      while (contextMessages.length > 2) {
        const currentTokens = Math.ceil((resolvedInstructionTokens + estimateMessagesTokens(contextMessages, tokenEstimate.tokensPerChar, tokenEstimate.tokensPerMessage) + tokenEstimate.tokensPerRequest) * TOKEN_SAFETY_MARGIN);
        if (currentTokens <= safeLimit) break;
        contextMessages.splice(0, 1);
      }
    }

    const contextInput = messagesToOpenRouter(contextMessages);

    // Inject vision content into the last user message if images are present
    const imageContent = loadImageAttachments(input.attachments);
    if (imageContent.length > 0 && contextInput.length > 0) {
      const lastMsg = contextInput[contextInput.length - 1];
      if (lastMsg.role === 'user') {
        // Convert string content to multi-modal content array
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (lastMsg as any).content = [
          { type: 'text', text: typeof lastMsg.content === 'string' ? lastMsg.content : '' },
          ...imageContent
        ];
      }
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt < modelChain.length; attempt++) {
      currentModel = modelChain[attempt];
      // Skip models in cooldown (unless it's the last option)
      if (isModelInCooldown(currentModel) && attempt < modelChain.length - 1) {
        log(`Skipping ${currentModel} (in cooldown)`);
        continue;
      }
      if (attempt > 0) log(`Fallback ${attempt}: trying ${currentModel}`);

      const startedAt = Date.now();
      try {
        log(`Starting OpenRouter call (${currentModel})...`);
        // ── Custom tool execution loop ──────────────────────────────────
        // The SDK's built-in tool loop (executeToolsIfNeeded) drops conversation
        // context in follow-up API calls — it only sends [function_calls, function_call_outputs]
        // without the original user messages or previousResponseId. This causes models to
        // produce empty text after tools that return minimal results (e.g. sequential-thinking).
        // We use schema-only tools (no execute functions) so the SDK returns tool calls
        // without auto-executing, then run the loop ourselves with full context.

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let conversationInput: any[] = [...contextInput];
        let step = 0;

        // Initial call — uses streaming for real-time delivery
        const initialResult = openrouter.callModel({
          model: currentModel,
          instructions: resolvedInstructions,
          input: conversationInput,
          tools: disableToolsForTurn ? undefined : schemaTools,
          maxOutputTokens: effectiveMaxOutputTokens,
          temperature: config.temperature,
          reasoning: resolvedReasoning
        });

        // Stream text from initial response
        if (input.streamDir) {
          try {
            for await (const delta of initialResult.getTextStream()) {
              writeStreamChunk(delta);
            }
          } catch (streamErr) {
            log(`Stream error: ${streamErr instanceof Error ? streamErr.message : String(streamErr)}`);
            markStreamError(streamErr instanceof Error ? streamErr.message : String(streamErr));
          }
        }

        // Get initial response (no auto-execution since schemaTools have no execute fns)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let lastResponse: any;
        try {
          lastResponse = await initialResult.getResponse();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`Initial getResponse failed: ${message}`);
          throw err;
        }

        responseText = extractTextFromApiResponse(lastResponse);
        let pendingCalls = extractFunctionCalls(lastResponse);
        const callSignatureCounts = new Map<string, number>();
        let previousRoundSignature = '';
        let repeatedRoundCount = 0;
        let runToolLoopBreakerTriggered = false;
        let runToolLoopBreakerReason: string | undefined;
        let runToolRetryAttempts = 0;
        let runNonRetryableFailures = 0;
        let runOutcomeVerificationForced = false;

        const maxToolRequirementNudges = 2;
        let toolRequirementNudgeAttempt = 0;
        const nudgeReason = toolExecutionRequirement.reason || 'required_tool_execution';
        const runDeterministicToolRequirementFallback = async (phase: 'pre_loop' | 'post_loop'): Promise<boolean> => {
          const createReadInstruction = parseCreateReadFileInstruction(prompt);
          if (createReadInstruction) {
            const writeExecutor = toolExecutors.get('Write');
            const readExecutor = toolExecutors.get('Read');
            if (!writeExecutor || !readExecutor) return false;
            runOutcomeVerificationForced = true;
            log(`Tool requirement fallback (${phase}): deterministic create+read for ${createReadInstruction.path}`);
            try {
              await writeExecutor({
                path: createReadInstruction.path,
                content: createReadInstruction.lines.join('\n')
              });
              await readExecutor({ path: createReadInstruction.path });
              responseText = `Created file "${createReadInstruction.path}" with ${createReadInstruction.lines.length} lines and verified it by reading it back.`;
              writeStreamChunk(responseText);
              return true;
            } catch (fallbackErr) {
              log(`Deterministic create+read fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
              return false;
            }
          }

          const listReadInstruction = parseListReadNewestInstruction(prompt);
          if (!listReadInstruction) return false;
          const globExecutor = toolExecutors.get('Glob');
          const readExecutor = toolExecutors.get('Read');
          if (!globExecutor || !readExecutor) return false;
          runOutcomeVerificationForced = true;
          log(`Tool requirement fallback (${phase}): deterministic list+read for ${listReadInstruction.directory}`);
          try {
            const normalizedDir = listReadInstruction.directory.replace(/\/+$/, '');
            const globPattern = normalizedDir ? `${normalizedDir}/**/*` : '**/*';
            const maxResults = Math.max(50, listReadInstruction.count * 20);
            const globResult = await globExecutor({ pattern: globPattern, maxResults });
            const matches = (
              globResult &&
              typeof globResult === 'object' &&
              Array.isArray((globResult as { matches?: unknown }).matches)
                ? (globResult as { matches: unknown[] }).matches
                : []
            ).map((item) => String(item || '').trim()).filter(Boolean);

            const rankedFiles = Array.from(new Set(matches))
              .map((candidatePath) => {
                try {
                  const stat = fs.statSync(candidatePath);
                  if (!stat.isFile()) return null;
                  return { path: candidatePath, mtimeMs: stat.mtimeMs };
                } catch {
                  return null;
                }
              })
              .filter((entry): entry is { path: string; mtimeMs: number } => !!entry)
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, listReadInstruction.count);

            if (rankedFiles.length === 0) {
              responseText = [
                `- No files were found under \`${listReadInstruction.directory}\`.`,
                '- I could not read a newest file because the directory appears empty.'
              ].join('\n');
              writeStreamChunk(responseText);
              return true;
            }

            const newest = rankedFiles[0];
            const readResult = await readExecutor({ path: newest.path });
            const readContent = (
              readResult &&
              typeof readResult === 'object' &&
              typeof (readResult as { content?: unknown }).content === 'string'
                ? (readResult as { content: string }).content
                : ''
            ).trim();
            const preview = readContent
              ? readContent.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3).join(' | ')
              : '[empty file]';
            const relativePath = newest.path.startsWith(`${GROUP_DIR}/`)
              ? newest.path.slice(GROUP_DIR.length + 1)
              : newest.path;
            const newestBasenames = rankedFiles.map(entry => path.basename(entry.path)).join(', ');
            const bulletCount = listReadInstruction.bulletCount || 2;
            const bulletLines = [
              `- Newest file: \`${relativePath}\` (top ${rankedFiles.length} files from \`${listReadInstruction.directory}\`).`,
              `- Preview: ${preview}.`,
              `- Newest set: ${newestBasenames}.`
            ].slice(0, bulletCount);

            responseText = bulletLines.join('\n');
            writeStreamChunk(responseText);
            return true;
          } catch (fallbackErr) {
            log(`Deterministic list+read fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
            return false;
          }
        };

        while (toolExecutionRequirement.required && pendingCalls.length === 0 && toolCalls.length === 0 && toolRequirementNudgeAttempt < maxToolRequirementNudges) {
          toolRequirementNudgeAttempt += 1;
          runOutcomeVerificationForced = true;
          log(`Tool requirement nudge triggered (${nudgeReason}, attempt ${toolRequirementNudgeAttempt}/${maxToolRequirementNudges})`);
          const nudgePrompt = buildToolExecutionNudgePrompt({
            reason: nudgeReason,
            attempt: toolRequirementNudgeAttempt
          });
          const responseItems = Array.isArray(lastResponse?.output) ? lastResponse.output : [];
          conversationInput = [...conversationInput, ...responseItems, { role: 'user', content: nudgePrompt }];
          try {
            const nudgeResult = openrouter.callModel({
              model: currentModel,
              instructions: resolvedInstructions,
              input: conversationInput,
              tools: schemaTools,
              maxOutputTokens: effectiveMaxOutputTokens,
              temperature: Math.min(config.temperature, 0.1),
              reasoning: { effort: 'low' as const }
            });
            lastResponse = await nudgeResult.getResponse();
            const nudgeText = extractTextFromApiResponse(lastResponse);
            if (nudgeText) {
              responseText = nudgeText;
              writeStreamChunk(nudgeText);
            }
            pendingCalls = extractFunctionCalls(lastResponse);
          } catch (nudgeErr) {
            log(`Tool requirement nudge failed: ${nudgeErr instanceof Error ? nudgeErr.message : String(nudgeErr)}`);
            break;
          }
        }

        if (toolExecutionRequirement.required && pendingCalls.length === 0 && toolCalls.length === 0) {
          await runDeterministicToolRequirementFallback('pre_loop');
        }

        // Tool execution loop — execute tools ourselves, include full context in follow-ups
        while (pendingCalls.length > 0 && step < maxToolSteps) {
          const roundSignature = normalizeToolRoundSignature(pendingCalls);
          if (roundSignature && roundSignature === previousRoundSignature) {
            repeatedRoundCount += 1;
          } else {
            repeatedRoundCount = 1;
            previousRoundSignature = roundSignature;
          }
          if (roundSignature && repeatedRoundCount >= repeatedRoundThreshold) {
            runToolLoopBreakerTriggered = true;
            runToolLoopBreakerReason = `repeated_round_signature(${repeatedRoundCount})`;
            log(`Tool loop breaker triggered: ${runToolLoopBreakerReason}`);
            break;
          }
          for (const fc of pendingCalls) {
            const signature = normalizeToolCallSignature(fc);
            const nextCount = (callSignatureCounts.get(signature) || 0) + 1;
            callSignatureCounts.set(signature, nextCount);
            if (nextCount >= repeatedSignatureThreshold) {
              runToolLoopBreakerTriggered = true;
              runToolLoopBreakerReason = `repeated_call_signature(${nextCount}): ${fc.name}`;
              break;
            }
          }
          if (runToolLoopBreakerTriggered) {
            log(`Tool loop breaker triggered: ${runToolLoopBreakerReason || 'unknown_reason'}`);
            break;
          }

          log(`Step ${step}: executing ${pendingCalls.length} tool call(s): ${pendingCalls.map(c => c.name).join(', ')}`);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const toolResults: any[] = [];
          for (const fc of pendingCalls) {
            const executor = toolExecutors.get(fc.name);
            if (!executor) {
              log(`Unknown tool: ${fc.name}`);
              toolResults.push({
                type: 'function_call_output',
                callId: fc.id,
                output: JSON.stringify({ error: `Unknown tool: ${fc.name}` })
              });
              step++;
              continue;
            }

            const normalizedArgs = normalizeToolCallArguments({
              toolName: fc.name,
              rawArguments: fc.arguments
            });
            if (normalizedArgs.malformedReason) {
              const error = `Malformed arguments for ${fc.name}: ${normalizedArgs.malformedReason}`;
              toolResults.push({
                type: 'function_call_output',
                callId: fc.id,
                output: JSON.stringify({ error })
              });
              toolOutputs.push({ name: fc.name, ok: false, error });
              runNonRetryableFailures += 1;
              if (runNonRetryableFailures >= nonRetryableFailureThreshold) {
                runToolLoopBreakerTriggered = true;
                runToolLoopBreakerReason = `non_retryable_failures(${runNonRetryableFailures})`;
              }
              step++;
              if (runToolLoopBreakerTriggered) break;
              continue;
            }

            let attemptNumber = 1;
            // Retry only read/idempotent tools on transient failures.
            for (;;) {
              try {
                // Calling the wrapped execute fires onToolCall/onToolResult callbacks.
                const result = await executor(normalizedArgs.arguments);
                toolResults.push({
                  type: 'function_call_output',
                  callId: fc.id,
                  output: JSON.stringify(result)
                });
                break;
              } catch (err) {
                if (shouldRetryIdempotentToolCall({
                  toolName: fc.name,
                  error: err,
                  attempt: attemptNumber,
                  maxAttempts: idempotentRetryAttempts
                })) {
                  runToolRetryAttempts += 1;
                  const delayMs = Math.min(2_000, idempotentRetryBackoffMs * attemptNumber);
                  log(`Retrying idempotent tool ${fc.name} after transient error (attempt ${attemptNumber + 1}/${idempotentRetryAttempts})`);
                  if (delayMs > 0) {
                    await sleep(delayMs);
                  }
                  attemptNumber += 1;
                  continue;
                }
                const error = err instanceof Error ? err.message : String(err);
                toolResults.push({
                  type: 'function_call_output',
                  callId: fc.id,
                  output: JSON.stringify({ error })
                });
                if (isNonRetryableToolError(error)) {
                  runNonRetryableFailures += 1;
                  if (runNonRetryableFailures >= nonRetryableFailureThreshold) {
                    runToolLoopBreakerTriggered = true;
                    runToolLoopBreakerReason = `non_retryable_failures(${runNonRetryableFailures})`;
                  }
                }
                break;
              }
            }
            step++;
            if (runToolLoopBreakerTriggered) break;
          }
          if (runToolLoopBreakerTriggered) {
            log(`Tool loop breaker triggered: ${runToolLoopBreakerReason || 'unknown_reason'}`);
            break;
          }

          // Build follow-up input with FULL conversation context:
          // original messages + model output + tool results (accumulated each round)
          conversationInput = [...conversationInput, ...lastResponse.output, ...toolResults];

          // Compact oversized tool payloads before follow-up calls to reduce context bloat.
          const compactedConversation = compactToolConversationItems(conversationInput, {
            maxOutputChars: followupOutputMaxChars,
            outputHeadChars: Math.min(toolSoftTrimHead, Math.floor(followupOutputMaxChars * 0.6)),
            outputTailChars: Math.min(toolSoftTrimTail, Math.floor(followupOutputMaxChars * 0.3)),
            maxArgumentChars: followupArgumentMaxChars,
          });
          conversationInput = compactedConversation.items as typeof conversationInput;
          if (compactedConversation.compacted > 0) {
            log(`Tool loop: compacted ${compactedConversation.compacted} oversized payload(s)`);
          }

          // Phase 1: Soft-trim oversized tool results (like OpenClaw's context-pruning extension).
          // Replace large tool result content with head+tail, preserving pair integrity.
          // PROTECT the most recent round's tool results — only trim older ones.
          const protectedStart = conversationInput.length - toolResults.length;
          for (let idx = 0; idx < protectedStart; idx++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const anyItem = conversationInput[idx] as any;
            if (anyItem?.type === 'function_call_output' && typeof anyItem.output === 'string' && anyItem.output.length > toolSoftTrimMaxChars) {
              const orig = anyItem.output;
              anyItem.output = orig.slice(0, toolSoftTrimHead) + '\n...\n' + orig.slice(-toolSoftTrimTail)
                + `\n[Tool result trimmed: kept first ${toolSoftTrimHead} and last ${toolSoftTrimTail} of ${orig.length} chars.]`;
            }
          }

          // Phase 2: If still over budget, remove only initial context messages (role/content items
          // without a 'type' field). NEVER remove function_call or function_call_output items —
          // orphaning either side of a pair causes API 400 errors.
          const followupTokenLimit = Math.floor(config.maxContextTokens * 0.45);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const estimateInputTokens = (items: any[]) => items.reduce((sum: number, item: any) => {
            const content = typeof item === 'string' ? item : JSON.stringify(item);
            return sum + estimateTokensForModel(content, tokenEstimate.tokensPerChar);
          }, 0);
          let followupInputTokens = estimateInputTokens(conversationInput);
          if (followupInputTokens > followupTokenLimit) {
            // Only remove initial context messages (no 'type' field = { role, content } format)
            let trimmed = 0;
            while (conversationInput.length > 2 && followupInputTokens > followupTokenLimit) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const first = conversationInput[0] as any;
              if (first?.type) break; // Hit function_call/function_call_output territory — stop
              conversationInput.splice(0, 1);
              trimmed++;
            }
            if (trimmed > 0) {
              followupInputTokens = estimateInputTokens(conversationInput);
              log(`Tool loop: trimmed ${trimmed} context messages, now ${followupInputTokens} tokens`);
            }
          }

          // Follow-up call with complete context — model sees the full conversation
          const followupResult = openrouter.callModel({
            model: currentModel,
            instructions: resolvedInstructions,
            input: conversationInput,
            tools: schemaTools,
            maxOutputTokens: effectiveMaxOutputTokens,
            temperature: config.temperature,
            reasoning: resolvedReasoning
          });

          try {
            lastResponse = await followupResult.getResponse();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Context overflow in tool loop: aggressively trim tool results, then retry.
            // NEVER splice items — that breaks function_call/function_call_output pairs.
            if (classifyError(err) === 'context_overflow') {
              log(`Context overflow in tool loop at step ${step}, hard-clearing old tool results`);
              // Hard-clear all function_call_output content except the most recent round
              let cleared = 0;
              for (let i = 0; i < conversationInput.length - toolResults.length; i++) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const item = conversationInput[i] as any;
                if (item?.type === 'function_call_output' && typeof item.output === 'string' && item.output.length > 200) {
                  item.output = '[Old tool result cleared to reduce context size.]';
                  cleared++;
                }
              }
              // Also remove initial context messages (safe — no type field)
              while (conversationInput.length > 2) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if ((conversationInput[0] as any)?.type) break;
                conversationInput.splice(0, 1);
              }
              if (cleared > 0) {
                log(`Hard-cleared ${cleared} tool results, retrying`);
                try {
                  const retryResult = openrouter.callModel({
                    model: currentModel,
                    instructions: resolvedInstructions,
                    input: conversationInput,
                    tools: schemaTools,
                    maxOutputTokens: effectiveMaxOutputTokens,
                    temperature: config.temperature,
                    reasoning: resolvedReasoning
                  });
                  lastResponse = await retryResult.getResponse();
                  const retryText = extractTextFromApiResponse(lastResponse);
                  if (retryText) {
                    responseText = retryText;
                    writeStreamChunk(retryText);
                  }
                  pendingCalls = extractFunctionCalls(lastResponse);
                  continue;
                } catch (retryErr) {
                  log(`Context overflow retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
                  break;
                }
              }
              log(`No tool results to clear, giving up`);
              break;
            }
            log(`Follow-up getResponse failed at step ${step}: ${message}`);
            break;
          }

          const followupText = extractTextFromApiResponse(lastResponse);
          if (followupText) {
            responseText = followupText;
            writeStreamChunk(followupText);
          }

          pendingCalls = extractFunctionCalls(lastResponse);
        }

        if (toolExecutionRequirement.required && toolCalls.length === 0) {
          const fallbackApplied = await runDeterministicToolRequirementFallback('post_loop');
          if (fallbackApplied) {
            pendingCalls = [];
          }
        }

        if (toolExecutionRequirement.required && toolCalls.length === 0) {
          runOutcomeVerificationForced = true;
          responseText = 'I could not execute the required tools for this request, so I cannot safely claim completion.';
          writeStreamChunk(responseText);
        }

        const unresolvedCalls = pendingCalls.slice();
        if (forceSynthesisAfterTools && toolCalls.length > 0 && (runToolLoopBreakerTriggered || unresolvedCalls.length > 0 || !responseText.trim())) {
          runOutcomeVerificationForced = true;
          const synthesisReason = runToolLoopBreakerTriggered
            ? `stuck_loop:${runToolLoopBreakerReason || 'unknown'}`
            : (unresolvedCalls.length > 0 ? 'unresolved_tool_calls' : 'empty_after_tools');
          log(`Tool outcome verifier forcing synthesis (${synthesisReason})`);
          const continuationPrompt = buildForcedSynthesisPrompt({
            reason: synthesisReason,
            pendingCalls: unresolvedCalls,
            toolOutputs
          });
          conversationInput = [...conversationInput, { role: 'user', content: continuationPrompt }];
          try {
            const synthesisResult = openrouter.callModel({
              model: currentModel,
              instructions: resolvedInstructions,
              input: conversationInput,
              maxOutputTokens: effectiveMaxOutputTokens,
              temperature: config.temperature,
              reasoning: resolvedReasoning
            });
            const synthesisResponse = await synthesisResult.getResponse();
            const synthesisText = extractTextFromApiResponse(synthesisResponse);
            if (synthesisText && synthesisText.trim()) {
              responseText = synthesisText;
              writeStreamChunk(synthesisText);
            }
          } catch (synthesisErr) {
            log(`Forced synthesis failed: ${synthesisErr instanceof Error ? synthesisErr.message : String(synthesisErr)}`);
          }

          if (!responseText || !responseText.trim()) {
            responseText = buildToolOutcomeFallback({
              reason: synthesisReason,
              toolOutputs,
              pendingCalls: unresolvedCalls
            });
            writeStreamChunk(responseText);
          }
        }

        if (!responseText || !responseText.trim()) {
          responseText = toolCalls.length > 0
            ? 'I completed tool execution but received an empty model response. Please retry, and I will continue from this context.'
            : 'I could not produce a response for that request. Please retry, and I will continue from this context.';
          writeStreamChunk(responseText);
        }

        finalizeStream();
        latencyMs = Date.now() - startedAt;
        toolRetryAttempts += runToolRetryAttempts;
        if (runOutcomeVerificationForced) {
          toolOutcomeVerificationForced = true;
        }
        if (runToolLoopBreakerTriggered) {
          toolLoopBreakerTriggered = true;
          toolLoopBreakerReason = runToolLoopBreakerReason;
        }

        if (responseText && responseText.trim()) {
          log(`Model returned text response (${responseText.length} chars, ${step} tool steps)`);
        } else if (toolCalls.length > 0) {
          log(`Warning: Model returned empty response after ${toolCalls.length} tool call(s) and ${step} steps`);
        } else {
          log(`Warning: Model returned empty/whitespace response`);
        }

        completionTokens = estimateTokensForModel(responseText || '', tokenEstimate.tokensPerChar);
        promptTokens = resolvedPromptTokens;
        lastError = null;
        break; // Success
      } catch (err) {
        lastError = err;
        const errClass = classifyError(err);
        // Context overflow: don't try fallback models (same context = same problem).
        // Emergency compaction: summarize older messages to preserve information,
        // rebuild system prompt at max trim level, then retry.
        if (errClass === 'context_overflow' && contextMessages.length > 4) {
          log(`Context overflow on ${currentModel}, emergency compaction + max trim`);
          const recoveryPlan = buildContextOverflowRecoveryPlan({
            contextMessages: contextMessages.map(msg => ({ role: msg.role, content: msg.content })),
            emergencySummary: null,
            keepRecentCount: 4
          });
          const toCompact = recoveryPlan.toCompact;
          const toKeep = recoveryPlan.toKeep;
          let emergencySummary = '';
          if (toCompact.length > 0) {
            try {
              const compactResult = await updateMemorySummary({
                openrouter,
                model: summaryModel,
                existingSummary: sessionCtx.state.summary,
                existingFacts: sessionCtx.state.facts,
                newMessages: toCompact.map((m, i) => ({ role: m.role as 'user' | 'assistant', content: m.content, timestamp: '', seq: i })),
                maxOutputTokens: config.summaryMaxOutputTokens
              });
              if (compactResult) {
                emergencySummary = compactResult.summary;
                sessionCtx.state.summary = compactResult.summary;
                const cappedFacts = compactResult.facts.length > 30 ? compactResult.facts.slice(-30) : compactResult.facts;
                sessionCtx.state.facts = cappedFacts;
                saveMemoryState(sessionCtx);
                log(`Emergency compaction: summarized ${toCompact.length} messages`);
              }
            } catch (compactErr) {
              log(`Emergency compaction failed: ${compactErr instanceof Error ? compactErr.message : String(compactErr)}`);
            }
          }
          // Rebuild system prompt at max trim level (includes updated summary)
          const minInstructions = resolveInstructions(4);
          const compactedInput = buildContextOverflowRecoveryPlan({
            contextMessages: toKeep,
            emergencySummary,
            keepRecentCount: Math.max(1, toKeep.length)
          }).retryInput;
          try {
            const retryResult = openrouter.callModel({
              model: currentModel,
              instructions: minInstructions,
              input: compactedInput,
              tools: schemaTools,
              maxOutputTokens: effectiveMaxOutputTokens,
              temperature: config.temperature,
              reasoning: resolvedReasoning
            });
            const retryResponse = await retryResult.getResponse();
            responseText = extractTextFromApiResponse(retryResponse) || '';
            if (responseText) {
              writeStreamChunk(responseText);
            }
            finalizeStream();
            latencyMs = Date.now() - startedAt;
            completionTokens = estimateTokensForModel(responseText || '', tokenEstimate.tokensPerChar);
            promptTokens = resolvedPromptTokens;
            lastError = null;
            break;
          } catch (retryErr) {
            log(`Context overflow retry after compaction failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
            throw retryErr;
          }
        }
        if (errClass) {
          cooldownModel(currentModel, err);
          if (attempt < modelChain.length - 1) {
            log(`${currentModel} failed (${errClass}): ${err instanceof Error ? err.message : err}`);
            continue;
          }
        }
        throw err; // Non-retryable or last model — propagate
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const allFailed = modelChain.length > 1 ? `All models failed. Last error: ${errorMessage}` : errorMessage;
    log(`Agent error: ${allFailed}`);
    markStreamError(allFailed);
    await cleanupMcpConnections();
    return {
      status: 'error',
      result: null,
      newSessionId: isNew ? sessionCtx.sessionId : undefined,
      error: allFailed,
      model: currentModel,
      prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
      memory_summary: sessionCtx.state.summary,
      memory_facts: sessionCtx.state.facts,
      tokens_prompt: promptTokens,
      tokens_completion: completionTokens,
      memory_recall_count: memoryRecallCountForOutput,
      session_recall_count: sessionRecallCount,
      memory_items_upserted: memoryItemsUpserted,
      memory_items_extracted: memoryItemsExtracted,
      timings: Object.keys(timings).length > 0 ? timings : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      tool_retry_attempts: toolRetryAttempts || undefined,
      tool_outcome_verification_forced: toolOutcomeVerificationForced || undefined,
      tool_loop_breaker_triggered: toolLoopBreakerTriggered || undefined,
      tool_loop_breaker_reason: toolLoopBreakerReason,
      latency_ms: latencyMs
    };
  }

  // Parse reply tags from response before saving to history
  let replyToId: string | undefined;
  if (responseText) {
    const parsed = parseReplyTags(responseText);
    responseText = parsed.cleanText;
    replyToId = parsed.replyToId;
  }

  appendHistory(sessionCtx, 'assistant', responseText || '');
  history = loadHistory(sessionCtx);

  const runMemoryExtraction = async () => {
    const extractionMessages = history.slice(-memoryExtractionMaxMessages);
    if (extractionMessages.length === 0) return;
    const extractionStartedAt = Date.now();
    const extractionPrompt = buildMemoryExtractionPrompt({
      assistantName,
      userId: input.userId,
      userName: input.userName,
      messages: extractionMessages,
      memoryPolicyPack: memoryPolicyResult?.pack || null
    });
    const extractionResult = openrouter.callModel({
      model: memoryModel,
      instructions: extractionPrompt.instructions,
      input: extractionPrompt.input,
      maxOutputTokens: memoryExtractionMaxOutputTokens,
      temperature: 0.1,
      reasoning: { effort: 'low' as const }
    });
    const { text: extractionText } = await getResponseText(extractionResult, 'memory_extraction');
    const extractedItems = parseMemoryExtraction(extractionText);
    if (extractedItems.length === 0) return;

    const behaviorThreshold = typeof input.behaviorConfig?.memory_importance_threshold === 'number'
      ? Number(input.behaviorConfig?.memory_importance_threshold)
      : null;
    const normalizedItems = extractedItems
      .filter((item) => {
        if (behaviorThreshold === null) return true;
        const importance = typeof item.importance === 'number' ? item.importance : null;
        if (importance === null) return true;
        return importance >= behaviorThreshold;
      })
      .map((item) => {
        const scope = typeof item.scope === 'string' ? item.scope : '';
        const subject = item.subject_id;
        if (scope === 'user' && !subject && input.userId) {
          return { ...item, subject_id: input.userId };
        }
        return item;
      });

    if (normalizedItems.length > 0) {
      await ipc.memoryUpsert({
        items: normalizedItems as unknown[],
        source: 'agent-extraction'
      });
      memoryItemsExtracted += normalizedItems.length;
      memoryItemsUpserted += normalizedItems.length;
    }
    timings.memory_extraction_ms = (timings.memory_extraction_ms ?? 0) + (Date.now() - extractionStartedAt);
  };

  if (memoryExtractionEnabled && isDaemon && (!input.isScheduledTask || memoryExtractScheduled)) {
    // Fire-and-forget in daemon mode; skip entirely in ephemeral mode
    void runMemoryExtraction().catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Memory extraction failed: ${errMsg}`);
      // Write error to IPC status file so host can detect the failure
      try {
        const statusPath = path.join(IPC_DIR, 'memory_extraction_error.json');
        fs.writeFileSync(statusPath, JSON.stringify({
          error: errMsg,
          timestamp: new Date().toISOString(),
        }));
      } catch { /* best-effort status write */ }
    });
  }

  // Normalize empty/whitespace-only responses to null
  const finalResult = responseText && responseText.trim() ? responseText : null;
  if (toolCalls.length > 0) {
    const totalToolMs = toolCalls.reduce((sum, call) => sum + (call.duration_ms || 0), 0);
    if (totalToolMs > 0) {
      timings.tool_ms = totalToolMs;
    }
  }

  await cleanupMcpConnections();

  return {
    status: 'success',
    result: finalResult,
    newSessionId: isNew ? sessionCtx.sessionId : undefined,
    model: currentModel,
    prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
    memory_summary: sessionCtx.state.summary,
    memory_facts: sessionCtx.state.facts,
    tokens_prompt: promptTokens,
    tokens_completion: completionTokens,
    memory_recall_count: memoryRecallCountForOutput,
    session_recall_count: sessionRecallCount,
    memory_items_upserted: memoryItemsUpserted,
    memory_items_extracted: memoryItemsExtracted,
    timings: Object.keys(timings).length > 0 ? timings : undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    tool_retry_attempts: toolRetryAttempts || undefined,
    tool_outcome_verification_forced: toolOutcomeVerificationForced || undefined,
    tool_loop_breaker_triggered: toolLoopBreakerTriggered || undefined,
    tool_loop_breaker_reason: toolLoopBreakerReason,
    latency_ms: latencyMs,
    replyToId
  };
}

async function main(): Promise<void> {
  try {
    const stdinData = await readStdin();
    const input = JSON.parse(stdinData) as ContainerInput;
    const output = await runAgentOnce(input);
    writeOutput(output);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch(err => {
    log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  });
}
