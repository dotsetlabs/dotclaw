/**
 * DotClaw Agent Runner (OpenRouter)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { OpenRouter, stepCountIs } from '@openrouter/sdk';
import { createTools, ToolCallRecord } from './tools.js';
import {
  createSessionContext,
  appendHistory,
  loadHistory,
  splitRecentHistory,
  shouldCompact,
  archiveConversation,
  buildSummaryPrompt,
  parseSummaryResponse,
  retrieveRelevantMemories,
  estimateTokens,
  saveMemoryState,
  writeHistory,
  MemoryConfig,
  Message
} from './memory.js';
import { loadPromptPackWithCanary, formatTaskExtractionPack, formatResponseQualityPack, formatToolCallingPack, formatMemoryPolicyPack, PromptPack } from './prompt-packs.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
  prompt_pack_versions?: Record<string, string>;
  memory_summary?: string;
  memory_facts?: string[];
  tool_calls?: ToolCallRecord[];
  latency_ms?: number;
}

const OUTPUT_START_MARKER = '---DOTCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DOTCLAW_OUTPUT_END---';

const SESSION_ROOT = '/workspace/session';
const GROUP_DIR = '/workspace/group';
const IPC_DIR = '/workspace/ipc';
const GLOBAL_DIR = '/workspace/global';
const PROMPTS_DIR = '/workspace/prompts';

const PROMPT_PACKS_ENABLED = !['0', 'false', 'no', 'off'].includes((process.env.DOTCLAW_PROMPT_PACKS_ENABLED || '').toLowerCase());
const PROMPT_PACKS_MAX_CHARS = parseInt(process.env.DOTCLAW_PROMPT_PACKS_MAX_CHARS || '6000', 10);
const PROMPT_PACKS_MAX_DEMOS = parseInt(process.env.DOTCLAW_PROMPT_PACKS_MAX_DEMOS || '4', 10);
const PROMPT_PACKS_CANARY_RATE = parseFloat(process.env.DOTCLAW_PROMPT_PACKS_CANARY_RATE || '0.1');

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
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
  if (process.env.OPENROUTER_SITE_URL) {
    headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
  }
  if (process.env.OPENROUTER_SITE_NAME) {
    headers['X-Title'] = process.env.OPENROUTER_SITE_NAME;
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

function getConfig(): MemoryConfig & {
  maxOutputTokens: number;
  summaryMaxOutputTokens: number;
  temperature: number;
} {
  return {
    maxContextTokens: parseInt(process.env.DOTCLAW_MAX_CONTEXT_TOKENS || '200000', 10),
    compactionTriggerTokens: parseInt(process.env.DOTCLAW_COMPACTION_TRIGGER_TOKENS || '180000', 10),
    recentContextTokens: parseInt(process.env.DOTCLAW_RECENT_CONTEXT_TOKENS || '80000', 10),
    summaryUpdateEveryMessages: parseInt(process.env.DOTCLAW_SUMMARY_UPDATE_EVERY_MESSAGES || '12', 10),
    memoryMaxResults: parseInt(process.env.DOTCLAW_MEMORY_MAX_RESULTS || '6', 10),
    memoryMaxTokens: parseInt(process.env.DOTCLAW_MEMORY_MAX_TOKENS || '2000', 10),
    maxOutputTokens: parseInt(process.env.DOTCLAW_MAX_OUTPUT_TOKENS || '4096', 10),
    summaryMaxOutputTokens: parseInt(process.env.DOTCLAW_SUMMARY_MAX_OUTPUT_TOKENS || '1200', 10),
    temperature: parseFloat(process.env.DOTCLAW_TEMPERATURE || '0.2')
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabledEnv(name: string, defaultValue = true): boolean {
  const value = (process.env[name] || '').toLowerCase().trim();
  if (!value) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(value);
}

function getOpenRouterOptions() {
  const timeoutMs = parsePositiveInt(process.env.DOTCLAW_OPENROUTER_TIMEOUT_MS, 240_000);
  const retryEnabled = isEnabledEnv('DOTCLAW_OPENROUTER_RETRY', true);
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
    httpReferer: process.env.OPENROUTER_SITE_URL,
    xTitle: process.env.OPENROUTER_SITE_NAME
  };
}

function buildSystemInstructions(params: {
  assistantName: string;
  memorySummary: string;
  memoryFacts: string[];
  memoryRecall: string[];
  isScheduledTask: boolean;
  taskExtractionPack?: PromptPack | null;
  responseQualityPack?: PromptPack | null;
  toolCallingPack?: PromptPack | null;
  memoryPolicyPack?: PromptPack | null;
}): string {
  const toolsDoc = [
    'Tools available (use with care):',
    '- `Bash`: run shell commands in `/workspace/group`.',
    '- `Read`, `Write`, `Edit`, `Glob`, `Grep`: filesystem operations within mounted paths.',
    '- `WebSearch`: Brave Search API (requires `BRAVE_SEARCH_API_KEY`).',
    '- `WebFetch`: fetch URLs (limit payload sizes).',
    '- `mcp__dotclaw__send_message`: send Telegram messages.',
    '- `mcp__dotclaw__schedule_task`: schedule tasks.',
    '- `mcp__dotclaw__list_tasks`, `mcp__dotclaw__pause_task`, `mcp__dotclaw__resume_task`, `mcp__dotclaw__cancel_task`.',
    '- `mcp__dotclaw__register_group`: main group only.',
    '- `mcp__dotclaw__set_model`: main group only.'
  ].join('\n');

  const memorySummary = params.memorySummary ? params.memorySummary : 'None yet.';
  const memoryFacts = params.memoryFacts.length > 0
    ? params.memoryFacts.map(fact => `- ${fact}`).join('\n')
    : 'None yet.';
  const memoryRecall = params.memoryRecall.length > 0
    ? params.memoryRecall.map(item => `- ${item}`).join('\n')
    : 'None.';

  const scheduledNote = params.isScheduledTask
    ? 'You are running as a scheduled task. If you need to communicate, use `mcp__dotclaw__send_message`.'
    : '';

  const taskExtractionBlock = params.taskExtractionPack
    ? formatTaskExtractionPack({
      pack: params.taskExtractionPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const responseQualityBlock = params.responseQualityPack
    ? formatResponseQualityPack({
      pack: params.responseQualityPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const toolCallingBlock = params.toolCallingPack
    ? formatToolCallingPack({
      pack: params.toolCallingPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  const memoryPolicyBlock = params.memoryPolicyPack
    ? formatMemoryPolicyPack({
      pack: params.memoryPolicyPack,
      maxDemos: PROMPT_PACKS_MAX_DEMOS,
      maxChars: PROMPT_PACKS_MAX_CHARS
    })
    : '';

  return [
    `You are ${params.assistantName}, a personal assistant running inside DotClaw.`,
    scheduledNote,
    toolsDoc,
    toolCallingBlock,
    taskExtractionBlock,
    responseQualityBlock,
    memoryPolicyBlock,
    'Long-term memory summary:',
    memorySummary,
    'Long-term facts:',
    memoryFacts,
    'Relevant recalled context:',
    memoryRecall,
    'Respond succinctly and helpfully. If you perform tool actions, summarize the results.'
  ].filter(Boolean).join('\n\n');
}

function extractQueryFromPrompt(prompt: string): string {
  if (!prompt) return '';
  const messageMatches = [...prompt.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  if (messageMatches.length > 0) {
    const last = messageMatches[messageMatches.length - 1][1];
    return decodeXml(last).trim();
  }
  return prompt.trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function messagesToOpenRouter(messages: Message[]) {
  return messages.map(message => ({
    role: message.role,
    content: message.content
  }));
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
    temperature: 0.1
  });
  const text = await result.getText();
  return parseSummaryResponse(text);
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    writeOutput({
      status: 'error',
      result: null,
      error: 'OPENROUTER_API_KEY is not set'
    });
    process.exit(1);
  }

  const model = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
  const summaryModel = process.env.DOTCLAW_SUMMARY_MODEL || model;
  const assistantName = process.env.ASSISTANT_NAME || 'Rain';
  const config = getConfig();
  const openrouterOptions = getOpenRouterOptions();
  const maxToolSteps = parsePositiveInt(process.env.DOTCLAW_MAX_TOOL_STEPS, 12);

  const openrouter = new OpenRouter({
    apiKey,
    ...openrouterOptions
  });

  const { ctx: sessionCtx, isNew } = createSessionContext(SESSION_ROOT, input.sessionId);
  const toolCalls: ToolCallRecord[] = [];
  const tools = createTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  }, {
    onToolCall: (call) => {
      toolCalls.push(call);
    }
  });

  if (process.env.DOTCLAW_SELF_CHECK === '1') {
    try {
      const details = await runSelfCheck({ model });
      writeOutput({
        status: 'success',
        result: `Self-check passed: ${details.join(', ')}`,
        newSessionId: isNew ? sessionCtx.sessionId : undefined
      });
      return;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Self-check failed: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: isNew ? sessionCtx.sessionId : undefined,
        error: errorMessage
      });
      process.exit(1);
    }
  }

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - You are running automatically, not in response to a user message. Use mcp__dotclaw__send_message if needed to communicate with the user.]\n\n${input.prompt}`;
  }

  appendHistory(sessionCtx, 'user', prompt);
  let history = loadHistory(sessionCtx);

  const totalTokens = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  let { recentMessages, olderMessages } = splitRecentHistory(history, config.recentContextTokens);

  if (shouldCompact(totalTokens, config)) {
    log(`Compacting history: ${totalTokens} tokens`);
    archiveConversation(history, sessionCtx.state.summary || null, GROUP_DIR);

    const summaryUpdate = await updateMemorySummary({
      openrouter,
      model: summaryModel,
      existingSummary: sessionCtx.state.summary,
      existingFacts: sessionCtx.state.facts,
      newMessages: olderMessages,
      maxOutputTokens: config.summaryMaxOutputTokens
    });

    if (summaryUpdate) {
      sessionCtx.state.summary = summaryUpdate.summary;
      sessionCtx.state.facts = summaryUpdate.facts;
      sessionCtx.state.lastSummarySeq = olderMessages.length > 0
        ? olderMessages[olderMessages.length - 1].seq
        : sessionCtx.state.lastSummarySeq;
      saveMemoryState(sessionCtx);
    }

    writeHistory(sessionCtx, recentMessages);
    history = recentMessages;
  }

  // Recompute split after possible compaction
  ({ recentMessages, olderMessages } = splitRecentHistory(history, config.recentContextTokens));

  const query = extractQueryFromPrompt(prompt);
  const memoryRecall = retrieveRelevantMemories({
    query,
    summary: sessionCtx.state.summary,
    facts: sessionCtx.state.facts,
    olderMessages,
    config
  });

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
  const memoryPolicyResult = PROMPT_PACKS_ENABLED
    ? loadPromptPackWithCanary({ behavior: 'memory-policy', groupDir: GROUP_DIR, globalDir: GLOBAL_DIR, sharedDir: sharedPromptDir, canaryRate: PROMPT_PACKS_CANARY_RATE })
    : null;

  const logPack = (label: string, result: { pack: PromptPack; source: string; isCanary?: boolean } | null) => {
    if (!result) return;
    const canaryNote = result.isCanary ? ' (canary)' : '';
    log(`Loaded prompt pack (${label}${canaryNote}): ${result.pack.name}@${result.pack.version}`);
  };
  logPack(taskPackResult?.source || 'unknown', taskPackResult);
  logPack(responseQualityResult?.source || 'unknown', responseQualityResult);
  logPack(toolCallingResult?.source || 'unknown', toolCallingResult);
  logPack(memoryPolicyResult?.source || 'unknown', memoryPolicyResult);

  const promptPackVersions: Record<string, string> = {};
  if (taskPackResult) promptPackVersions['task-extraction'] = taskPackResult.pack.version;
  if (responseQualityResult) promptPackVersions['response-quality'] = responseQualityResult.pack.version;
  if (toolCallingResult) promptPackVersions['tool-calling'] = toolCallingResult.pack.version;
  if (memoryPolicyResult) promptPackVersions['memory-policy'] = memoryPolicyResult.pack.version;

  const instructions = buildSystemInstructions({
    assistantName,
    memorySummary: sessionCtx.state.summary,
    memoryFacts: sessionCtx.state.facts,
    memoryRecall,
    isScheduledTask: !!input.isScheduledTask,
    taskExtractionPack: taskPackResult?.pack || null,
    responseQualityPack: responseQualityResult?.pack || null,
    toolCallingPack: toolCallingResult?.pack || null,
    memoryPolicyPack: memoryPolicyResult?.pack || null
  });

  const instructionsTokens = estimateTokens(instructions);
  const maxContextTokens = Math.max(config.maxContextTokens - config.maxOutputTokens - instructionsTokens, 2000);
  const { recentMessages: contextMessages } = splitRecentHistory(recentMessages, maxContextTokens, 6);

  let responseText = '';

  let latencyMs: number | undefined;
  try {
    log('Starting OpenRouter call...');
    const startedAt = Date.now();
    const result = await openrouter.callModel({
      model,
      instructions,
      input: messagesToOpenRouter(contextMessages),
      tools,
      stopWhen: stepCountIs(maxToolSteps),
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature
    });
    latencyMs = Date.now() - startedAt;
    // Get tool calls to see what the model did
    const modelToolCalls = await result.getToolCalls();
    if (modelToolCalls.length > 0) {
      log(`Model made ${modelToolCalls.length} tool call(s): ${modelToolCalls.map(t => t.name).join(', ')}`);
    }

    responseText = await result.getText();

    if (!responseText || !responseText.trim()) {
      log(`Warning: Model returned empty/whitespace response. Raw length: ${responseText?.length ?? 0}, tool calls: ${modelToolCalls.length}`);
    } else {
      log(`Model returned text response (${responseText.length} chars)`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: isNew ? sessionCtx.sessionId : undefined,
      error: errorMessage,
      model,
      prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
      memory_summary: sessionCtx.state.summary,
      memory_facts: sessionCtx.state.facts,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      latency_ms: latencyMs
    });
    process.exit(1);
  }

  appendHistory(sessionCtx, 'assistant', responseText || '');

  history = loadHistory(sessionCtx);
  const newMessages = history.filter(m => m.seq > sessionCtx.state.lastSummarySeq);
  if (newMessages.length >= config.summaryUpdateEveryMessages) {
    const summaryUpdate = await updateMemorySummary({
      openrouter,
      model: summaryModel,
      existingSummary: sessionCtx.state.summary,
      existingFacts: sessionCtx.state.facts,
      newMessages,
      maxOutputTokens: config.summaryMaxOutputTokens
    });
    if (summaryUpdate) {
      sessionCtx.state.summary = summaryUpdate.summary;
      sessionCtx.state.facts = summaryUpdate.facts;
      sessionCtx.state.lastSummarySeq = newMessages[newMessages.length - 1].seq;
      saveMemoryState(sessionCtx);
    }
  }

  // Normalize empty/whitespace-only responses to null
  const finalResult = responseText && responseText.trim() ? responseText : null;

  writeOutput({
    status: 'success',
    result: finalResult,
    newSessionId: isNew ? sessionCtx.sessionId : undefined,
    model,
    prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
    memory_summary: sessionCtx.state.summary,
    memory_facts: sessionCtx.state.facts,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    latency_ms: latencyMs
  });
}

main().catch(err => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  writeOutput({
    status: 'error',
    result: null,
    error: err instanceof Error ? err.message : String(err)
  });
  process.exit(1);
});
