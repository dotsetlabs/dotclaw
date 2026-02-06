/**
 * DotClaw Agent Runner (OpenRouter)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OpenRouter, stepCountIs } from '@openrouter/sdk';
import { createTools, discoverMcpTools, ToolCallRecord } from './tools.js';
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
  parseSummaryResponse,
  retrieveRelevantMemories,
  saveMemoryState,
  writeHistory,
  MemoryConfig,
  Message
} from './memory.js';
import { loadPromptPackWithCanary, formatPromptPack, PromptPack } from './prompt-packs.js';
import { buildSkillCatalog, formatSkillCatalog, type SkillCatalog } from './skill-loader.js';

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

let cachedOpenRouter: OpenRouter | null = null;
let cachedOpenRouterKey = '';
let cachedOpenRouterOptions = '';

function getCachedOpenRouter(apiKey: string, options: ReturnType<typeof getOpenRouterOptions>): OpenRouter {
  const optionsKey = JSON.stringify(options);
  if (cachedOpenRouter && cachedOpenRouterKey === apiKey && cachedOpenRouterOptions === optionsKey) {
    return cachedOpenRouter;
  }
  cachedOpenRouter = new OpenRouter({
    apiKey,
    ...options
  });
  cachedOpenRouterKey = apiKey;
  cachedOpenRouterOptions = optionsKey;
  return cachedOpenRouter;
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ── Response text extraction ─────────────────────────────────────────

async function getResponseText(result: OpenRouterResult, context: string): Promise<string> {
  try {
    const text = await result.getText();
    if (typeof text === 'string' && text.trim()) {
      return text;
    }
  } catch (err) {
    log(`getText failed (${context}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return '';
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

function buildPlannerPrompt(messages: Message[]): { instructions: string; input: string } {
  const transcript = messages.map(msg => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n\n');
  const instructions = [
    'You are a planning module for a personal assistant.',
    'Given the conversation, produce a concise plan in JSON.',
    'Return JSON only with keys:',
    '- steps: array of short action steps',
    '- tools: array of tool names you expect to use (if any)',
    '- risks: array of potential pitfalls or missing info',
    '- questions: array of clarifying questions (if any)',
    'Keep each array short. Use empty arrays if not needed.'
  ].join('\n');
  const input = `Conversation:\n${transcript}`;
  return { instructions, input };
}

function parsePlannerResponse(text: string): { steps: string[]; tools: string[]; risks: string[]; questions: string[] } | null {
  const trimmed = text.trim();
  let jsonText = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const steps = Array.isArray(parsed.steps) ? parsed.steps.filter(item => typeof item === 'string') : [];
    const tools = Array.isArray(parsed.tools) ? parsed.tools.filter(item => typeof item === 'string') : [];
    const risks = Array.isArray(parsed.risks) ? parsed.risks.filter(item => typeof item === 'string') : [];
    const questions = Array.isArray(parsed.questions) ? parsed.questions.filter(item => typeof item === 'string') : [];
    return { steps, tools, risks, questions };
  } catch {
    return null;
  }
}

function formatPlanBlock(plan: { steps: string[]; tools: string[]; risks: string[]; questions: string[] }): string {
  const lines: string[] = ['Planned approach (planner):'];
  if (plan.steps.length > 0) {
    lines.push('Steps:');
    for (const step of plan.steps) lines.push(`- ${step}`);
  }
  if (plan.tools.length > 0) {
    lines.push('Tools:');
    for (const tool of plan.tools) lines.push(`- ${tool}`);
  }
  if (plan.risks.length > 0) {
    lines.push('Risks:');
    for (const risk of plan.risks) lines.push(`- ${risk}`);
  }
  if (plan.questions.length > 0) {
    lines.push('Questions:');
    for (const question of plan.questions) lines.push(`- ${question}`);
  }
  return lines.join('\n');
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

const MEMORY_SUMMARY_MAX_CHARS = 2000;

const compactToolsDoc = [
  'Tools: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, GitClone, NpmInstall,',
  'mcp__dotclaw__send_message, send_file, send_photo, send_voice, send_audio, send_location,',
  'send_contact, send_poll, send_buttons, edit_message, delete_message, download_url,',
  'schedule_task, run_task, list_tasks, pause_task, resume_task, cancel_task, update_task,',
  'spawn_job, job_status, list_jobs, cancel_job, job_update, register_group, remove_group,',
  'list_groups, set_model, memory_upsert, memory_search, memory_list, memory_forget, memory_stats.',
  'plugin__* (plugins), mcp_ext__* (external MCP).'
].join('\n');

function buildSystemInstructions(params: {
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
  isBackgroundTask: boolean;
  taskId?: string;
  isBackgroundJob: boolean;
  jobId?: string;
  timezone?: string;
  hostPlatform?: string;
  messagingPlatform?: string;
  planBlock?: string;
  profile?: 'fast' | 'standard' | 'deep' | 'background';
  taskExtractionPack?: PromptPack | null;
  responseQualityPack?: PromptPack | null;
  toolCallingPack?: PromptPack | null;
  toolOutcomePack?: PromptPack | null;
  memoryPolicyPack?: PromptPack | null;
  memoryRecallPack?: PromptPack | null;
}): string {
  const profile = params.profile || 'standard';
  const isFast = profile === 'fast';

  // Tool descriptions are already in each tool's schema — only add essential guidance here
  const toolGuidance = isFast ? '' : [
    'Key tool rules:',
    '- User attachments arrive in /workspace/group/inbox/ (see <attachment> tags). Process with Read/Bash/Python.',
    '- To send media from the web: download_url → send_photo/send_file/send_audio. Always foreground.',
    '- Charts/plots: matplotlib → savefig → send_photo. Graphviz → dot -Tpng → send_photo.',
    '- Voice messages are auto-transcribed (<transcript> in <attachment>). Reply with normal text — the host auto-converts to voice.',
    '- GitHub CLI (`gh`) is available if GH_TOKEN is set.',
    '- Use spawn_job ONLY for tasks >2 minutes (deep research, large projects). Everything else: foreground.',
    '- When you spawn a job, reply minimally (e.g. "Working on it"). No job IDs, bullet plans, or status offers.',
    '- plugin__* and mcp_ext__* tools may be available if configured.'
  ].join('\n');

  const toolsSection = isFast ? compactToolsDoc : toolGuidance;

  const browserAutomation = !isFast && agentConfig.agent.browser.enabled ? [
    'Browser Tool: actions: navigate, snapshot, click, fill, screenshot, extract, evaluate, close.',
    'Use snapshot with interactive=true for clickable refs (@e1, @e2). Screenshots → /workspace/group/screenshots/.'
  ].join('\n') : '';

  // Memory section: skip for fast profile, consolidate empty placeholders for other profiles
  const includeMemory = !isFast;
  const hasAnyMemory = params.memorySummary || params.memoryFacts.length > 0 ||
    params.longTermRecall.length > 0 || params.userProfile;

  const memorySummary = params.memorySummary
    ? params.memorySummary.slice(0, MEMORY_SUMMARY_MAX_CHARS)
    : '';
  const memoryFacts = params.memoryFacts.length > 0
    ? params.memoryFacts.map(fact => `- ${fact}`).join('\n')
    : '';
  const sessionRecall = params.sessionRecall.length > 0
    ? params.sessionRecall.map(item => `- ${item}`).join('\n')
    : '';
  const longTermRecall = params.longTermRecall.length > 0
    ? params.longTermRecall.map(item => `- ${item}`).join('\n')
    : '';
  const userProfile = params.userProfile || '';
  const memoryStats = params.memoryStats
    ? `Total: ${params.memoryStats.total}, User: ${params.memoryStats.user}, Group: ${params.memoryStats.group}, Global: ${params.memoryStats.global}`
    : '';

  const availableGroups = params.availableGroups && params.availableGroups.length > 0
    ? params.availableGroups
      .map(group => `- ${group.name} (chat ${group.jid}, last: ${group.lastActivity})`)
      .join('\n')
    : '';

  const groupNotes = params.groupNotes ? `Group notes:\n${params.groupNotes}` : '';
  const globalNotes = params.globalNotes ? `Global notes:\n${params.globalNotes}` : '';
  const skillNotes = params.skillCatalog ? formatSkillCatalog(params.skillCatalog) : '';

  const toolReliability = !isFast && params.toolReliability && params.toolReliability.length > 0
    ? params.toolReliability
      .sort((a, b) => a.success_rate - b.success_rate)
      .slice(0, 20)
      .map(tool => {
        const pct = `${Math.round(tool.success_rate * 100)}%`;
        const avg = Number.isFinite(tool.avg_duration_ms) ? `${Math.round(tool.avg_duration_ms!)}ms` : 'n/a';
        return `- ${tool.name}: success ${pct} over ${tool.count} calls (avg ${avg})`;
      })
      .join('\n')
    : '';

  const behaviorNotes: string[] = [];
  const responseStyle = typeof params.behaviorConfig?.response_style === 'string'
    ? String(params.behaviorConfig.response_style)
    : '';
  if (responseStyle === 'concise') {
    behaviorNotes.push('Keep responses short and to the point.');
  } else if (responseStyle === 'detailed') {
    behaviorNotes.push('Give detailed, step-by-step responses when helpful.');
  }
  const toolBias = typeof params.behaviorConfig?.tool_calling_bias === 'number'
    ? Number(params.behaviorConfig.tool_calling_bias)
    : null;
  if (toolBias !== null && toolBias < 0.4) {
    behaviorNotes.push('Ask before using tools unless the intent is obvious.');
  } else if (toolBias !== null && toolBias > 0.6) {
    behaviorNotes.push('Use tools proactively when they add accuracy or save time.');
  }
  const cautionBias = typeof params.behaviorConfig?.caution_bias === 'number'
    ? Number(params.behaviorConfig.caution_bias)
    : null;
  if (cautionBias !== null && cautionBias > 0.6) {
    behaviorNotes.push('Double-check uncertain facts and flag limitations.');
  }

  const timezoneNote = params.timezone
    ? `Timezone: ${params.timezone}. Use this timezone when interpreting or presenting timestamps unless the user specifies another.`
    : '';

  const hostPlatformNote = params.hostPlatform
    ? (params.hostPlatform.startsWith('linux')
      ? `Host platform: ${params.hostPlatform} (matches container).`
      : `You are running inside a Linux container, but the user's host machine is ${params.hostPlatform}. Packages with platform-specific native binaries (e.g. esbuild, swc, sharp) installed here won't work on the host. When you create projects with dependencies, delete node_modules before finishing and tell the user to run the install command on their machine.`)
    : '';

  const scheduledNote = params.isScheduledTask
    ? `You are running as a scheduled task${params.taskId ? ` (task id: ${params.taskId})` : ''}. If you need to communicate, use \`mcp__dotclaw__send_message\`.`
    : '';
  const backgroundNote = params.isBackgroundTask
    ? 'You are running in the background for a user request. Focus on completing the task and return a complete response without asking follow-up questions unless strictly necessary.'
    : '';
  const jobNote = params.isBackgroundJob
    ? `You are running as a background job${params.jobId ? ` (job id: ${params.jobId})` : ''}. Complete the task silently and return the result. Do NOT call \`mcp__dotclaw__job_update\` for routine progress — only for critical blockers or required user decisions. Do NOT send messages to the chat about your progress. Just do the work and return the final result. The system will deliver your result to the user automatically.`
    : '';
  const jobArtifactsNote = params.isBackgroundJob && params.jobId
    ? `Job artifacts directory: /workspace/group/jobs/${params.jobId}`
    : '';

  const fmtPack = (label: string, pack: PromptPack | null | undefined) =>
    pack ? formatPromptPack({ label, pack, maxDemos: PROMPT_PACKS_MAX_DEMOS, maxChars: PROMPT_PACKS_MAX_CHARS }) : '';

  // Skip prompt packs for fast profile; enforce aggregate budget for others
  const PROMPT_PACKS_TOTAL_BUDGET = PROMPT_PACKS_MAX_CHARS * 3; // Aggregate cap across all packs
  const allPackBlocks: string[] = [];
  if (!isFast) {
    const packEntries: Array<[string, PromptPack | null | undefined]> = [
      ['Tool Calling Guidelines', params.toolCallingPack],
      ['Tool Outcome Guidelines', params.toolOutcomePack],
      ['Task Extraction Guidelines', params.taskExtractionPack],
      ['Response Quality Guidelines', params.responseQualityPack],
      ['Memory Policy Guidelines', params.memoryPolicyPack],
      ['Memory Recall Guidelines', params.memoryRecallPack],
    ];
    let totalChars = 0;
    for (const [label, pack] of packEntries) {
      const block = fmtPack(label, pack);
      if (!block) continue;
      if (totalChars + block.length > PROMPT_PACKS_TOTAL_BUDGET) break;
      allPackBlocks.push(block);
      totalChars += block.length;
    }
  }
  const taskExtractionBlock = allPackBlocks.find(b => b.includes('Task Extraction')) || '';
  const responseQualityBlock = allPackBlocks.find(b => b.includes('Response Quality')) || '';
  const toolCallingBlock = allPackBlocks.find(b => b.includes('Tool Calling')) || '';
  const toolOutcomeBlock = allPackBlocks.find(b => b.includes('Tool Outcome')) || '';
  const memoryPolicyBlock = allPackBlocks.find(b => b.includes('Memory Policy')) || '';
  const memoryRecallBlock = allPackBlocks.find(b => b.includes('Memory Recall')) || '';

  // Build memory sections — omit entirely for fast, consolidate empty placeholders for others
  const memorySections: string[] = [];
  if (includeMemory) {
    if (hasAnyMemory) {
      if (memorySummary) {
        memorySections.push('Long-term memory summary:', memorySummary);
      }
      if (memoryFacts) {
        memorySections.push('Long-term facts:', memoryFacts);
      }
      if (userProfile) {
        memorySections.push('User profile (if available):', userProfile);
      }
      if (longTermRecall) {
        memorySections.push('What you remember about the user (long-term):', longTermRecall);
      }
      if (memoryStats) {
        memorySections.push('Memory stats:', memoryStats);
      }
    } else {
      memorySections.push('No long-term memory available yet.');
    }
  }

  // Session recall is always included (local context from current conversation)
  if (sessionRecall) {
    memorySections.push('Recent conversation context:', sessionRecall);
  }

  return [
    `You are ${params.assistantName}, a personal assistant running inside DotClaw.${params.messagingPlatform ? ` You are currently connected via ${params.messagingPlatform}.` : ''}`,
    hostPlatformNote,
    scheduledNote,
    backgroundNote,
    jobNote,
    jobArtifactsNote,
    toolsSection,
    browserAutomation,
    groupNotes,
    globalNotes,
    skillNotes,
    timezoneNote,
    params.planBlock || '',
    toolCallingBlock,
    toolOutcomeBlock,
    taskExtractionBlock,
    responseQualityBlock,
    memoryPolicyBlock,
    memoryRecallBlock,
    ...memorySections,
    availableGroups ? `Available groups (main group only):\n${availableGroups}` : '',
    toolReliability ? `Tool reliability (recent):\n${toolReliability}` : '',
    behaviorNotes.length > 0 ? `Behavior notes:\n${behaviorNotes.join('\n')}` : '',
    'Be concise and helpful. When you use tools, summarize what happened rather than dumping raw output.'
  ].filter(Boolean).join('\n\n');
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
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
  const text = await getResponseText(result, 'summary');
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

type ResponseValidation = {
  verdict: 'pass' | 'fail';
  issues: string[];
  missing: string[];
};

function buildResponseValidationPrompt(params: { userPrompt: string; response: string }): { instructions: string; input: string } {
  const instructions = [
    'You are a strict response quality checker.',
    'Given a user request and an assistant response, decide if the response fully addresses the request.',
    'Fail if the response is empty, generic, deflects, promises work without results, or ignores any explicit questions.',
    'Pass only if the response directly answers all parts with concrete, relevant content.',
    'Return JSON only with keys: verdict ("pass"|"fail"), issues (array of strings), missing (array of strings).'
  ].join('\n');

  const input = [
    'User request:',
    params.userPrompt,
    '',
    'Assistant response:',
    params.response
  ].join('\n');

  return { instructions, input };
}

function parseResponseValidation(text: string): ResponseValidation | null {
  const trimmed = text.trim();
  let jsonText = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    jsonText = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonText);
    const verdict = parsed?.verdict;
    if (verdict !== 'pass' && verdict !== 'fail') return null;
    const issues = Array.isArray(parsed?.issues)
      ? parsed.issues.filter((issue: unknown) => typeof issue === 'string')
      : [];
    const missing = Array.isArray(parsed?.missing)
      ? parsed.missing.filter((item: unknown) => typeof item === 'string')
      : [];
    return { verdict, issues, missing };
  } catch {
    return null;
  }
}

async function validateResponseQuality(params: {
  openrouter: OpenRouter;
  model: string;
  userPrompt: string;
  response: string;
  maxOutputTokens: number;
  temperature: number;
}): Promise<ResponseValidation | null> {
  const prompt = buildResponseValidationPrompt({
    userPrompt: params.userPrompt,
    response: params.response
  });
  const result = await params.openrouter.callModel({
    model: params.model,
    instructions: prompt.instructions,
    input: prompt.input,
    maxOutputTokens: params.maxOutputTokens,
    temperature: params.temperature,
    reasoning: { effort: 'low' as const }
  });
  const text = await getResponseText(result, 'response_validation');
  return parseResponseValidation(text);
}

function buildRetryGuidance(validation: ResponseValidation | null): string {
  const issues = validation?.issues || [];
  const missing = validation?.missing || [];
  const points = [...issues, ...missing].filter(Boolean).slice(0, 8);
  const details = points.length > 0
    ? points.map(item => `- ${item}`).join('\n')
    : '- The previous response did not fully address the request.';
  return [
    'IMPORTANT: Your previous response did not fully answer the user request.',
    'Provide a direct, complete answer now. Do not mention this retry.',
    'Issues to fix:',
    details
  ].join('\n');
}

function buildPlannerTrigger(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function shouldRunPlanner(params: {
  enabled: boolean;
  mode: string;
  prompt: string;
  tokensPerChar: number;
  minTokens: number;
  trigger: RegExp | null;
}): boolean {
  if (!params.enabled) return false;
  const mode = params.mode.toLowerCase();
  if (mode === 'always') return true;
  if (mode === 'off') return false;

  const estimatedTokens = estimateTokensForModel(params.prompt, params.tokensPerChar);
  if (params.minTokens > 0 && estimatedTokens >= params.minTokens) return true;
  if (params.trigger && params.trigger.test(params.prompt)) return true;
  return false;
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
  if (input.modelContextTokens && Number.isFinite(input.modelContextTokens)) {
    config.maxContextTokens = Math.min(config.maxContextTokens, input.modelContextTokens);
    const compactionTarget = input.modelContextTokens - config.maxOutputTokens;
    config.compactionTriggerTokens = Math.max(1000, Math.min(config.compactionTriggerTokens, compactionTarget));
  }
  if (input.modelMaxOutputTokens && Number.isFinite(input.modelMaxOutputTokens)) {
    config.maxOutputTokens = Math.min(config.maxOutputTokens, input.modelMaxOutputTokens);
  }
  if (input.modelTemperature && Number.isFinite(input.modelTemperature)) {
    config.temperature = input.modelTemperature;
  }
  const openrouterOptions = getOpenRouterOptions(agentConfig);
  const maxToolSteps = Number.isFinite(input.maxToolSteps)
    ? Math.max(1, Math.floor(input.maxToolSteps as number))
    : agent.tools.maxToolSteps;
  const memoryExtractionEnabled = agent.memory.extraction.enabled && !input.disableMemoryExtraction;
  const isDaemon = process.env.DOTCLAW_DAEMON === '1';
  const memoryExtractionAsync = agent.memory.extraction.async;
  const memoryExtractionMaxMessages = agent.memory.extraction.maxMessages;
  const memoryExtractionMaxOutputTokens = agent.memory.extraction.maxOutputTokens;
  const memoryExtractScheduled = agent.memory.extractScheduled;
  const memoryArchiveSync = agent.memory.archiveSync;
  const plannerEnabled = agent.planner.enabled && !input.disablePlanner;
  const plannerMode = String(agent.planner.mode || 'auto').toLowerCase();
  const plannerMinTokens = agent.planner.minTokens;
  const plannerTrigger = buildPlannerTrigger(agent.planner.triggerRegex);
  const plannerModel = agent.models.planner;
  const plannerMaxOutputTokens = agent.planner.maxOutputTokens;
  const plannerTemperature = agent.planner.temperature;
  const responseValidateEnabled = agent.responseValidation.enabled && !input.disableResponseValidation;
  const responseValidateModel = agent.models.responseValidation;
  const responseValidateMaxOutputTokens = agent.responseValidation.maxOutputTokens;
  const responseValidateTemperature = agent.responseValidation.temperature;
  const responseValidateMaxRetries = Number.isFinite(input.responseValidationMaxRetries)
    ? Math.max(0, Math.floor(input.responseValidationMaxRetries as number))
    : agent.responseValidation.maxRetries;
  const responseValidateAllowToolCalls = agent.responseValidation.allowToolCalls;
  const responseValidateMinPromptTokens = agent.responseValidation.minPromptTokens || 0;
  const responseValidateMinResponseTokens = agent.responseValidation.minResponseTokens || 0;
  const maxContextMessageTokens = agent.context.maxContextMessageTokens;

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
  let memoryItemsUpserted = 0;
  let memoryItemsExtracted = 0;
  const timings: { planner_ms?: number; response_validation_ms?: number; memory_extraction_ms?: number; tool_ms?: number } = {};
  const ipc = createIpcHandlers({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  }, agent.ipc);
  const tools = createTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain
  }, agent, {
    onToolCall: (call) => {
      toolCalls.push(call);
    },
    policy: input.toolPolicy,
    jobProgress: {
      jobId: input.jobId,
      enabled: Boolean(input.isBackgroundJob)
    }
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
      tools.push(...mcp.tools);
      mcpCleanup = mcp.cleanup;
      if (mcp.tools.length > 0) {
        log(`MCP: discovered ${mcp.tools.length} external tools`);
      }
    } catch (err) {
      log(`MCP discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (process.env.DOTCLAW_SELF_CHECK === '1') {
    try {
      const details = await runSelfCheck({ model });
      return {
        status: 'success',
        result: `Self-check passed: ${details.join(', ')}`,
        newSessionId: isNew ? sessionCtx.sessionId : undefined
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`Self-check failed: ${errorMessage}`);
      return {
        status: 'error',
        result: null,
        newSessionId: isNew ? sessionCtx.sessionId : undefined,
        error: errorMessage
      };
    }
  }

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

  appendHistory(sessionCtx, 'user', prompt);
  let history = loadHistory(sessionCtx);

  const tokenRatio = tokenEstimate.tokensPerChar > 0 ? (0.25 / tokenEstimate.tokensPerChar) : 1;
  const adjustedRecentTokens = Math.max(1000, Math.floor(config.recentContextTokens * tokenRatio));

  const totalTokens = history.reduce(
    (sum, message) => sum + estimateTokensForModel(message.content, tokenEstimate.tokensPerChar) + tokenEstimate.tokensPerMessage,
    0
  );
  let { recentMessages, olderMessages } = splitRecentHistory(history, adjustedRecentTokens);

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

  const query = extractQueryFromPrompt(prompt);
  const sessionRecall = retrieveRelevantMemories({
    query,
    summary: sessionCtx.state.summary,
    facts: sessionCtx.state.facts,
    olderMessages,
    config
  });
  const sessionRecallCount = sessionRecall.length;
  const memoryRecallCount = input.memoryRecall ? input.memoryRecall.length : 0;

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

  const buildInstructions = (planBlockValue: string) => buildSystemInstructions({
    assistantName,
    groupNotes: claudeNotes.group,
    globalNotes: claudeNotes.global,
    skillCatalog,
    memorySummary: sessionCtx.state.summary,
    memoryFacts: sessionCtx.state.facts,
    sessionRecall,
    longTermRecall: input.memoryRecall || [],
    userProfile: input.userProfile ?? null,
    memoryStats: input.memoryStats,
    availableGroups,
    toolReliability: input.toolReliability,
    behaviorConfig: input.behaviorConfig,
    isScheduledTask: !!input.isScheduledTask,
    isBackgroundTask: !!input.isBackgroundTask,
    taskId: input.taskId,
    isBackgroundJob: !!input.isBackgroundJob,
    jobId: input.jobId,
    timezone: typeof input.timezone === 'string' ? input.timezone : undefined,
    hostPlatform: typeof input.hostPlatform === 'string' ? input.hostPlatform : undefined,
    messagingPlatform: input.chatJid?.includes(':') ? input.chatJid.split(':')[0] : undefined,
    planBlock: planBlockValue,
    profile: input.profile,
    taskExtractionPack: taskPackResult?.pack || null,
    responseQualityPack: responseQualityResult?.pack || null,
    toolCallingPack: toolCallingResult?.pack || null,
    toolOutcomePack: toolOutcomeResult?.pack || null,
    memoryPolicyPack: memoryPolicyResult?.pack || null,
    memoryRecallPack: memoryRecallResult?.pack || null
  });

  let planBlock = '';
  let instructions = buildInstructions(planBlock);
  let instructionsTokens = estimateTokensForModel(instructions, tokenEstimate.tokensPerChar);
  let maxContextTokens = Math.max(config.maxContextTokens - config.maxOutputTokens - instructionsTokens, 2000);
  let adjustedContextTokens = Math.max(1000, Math.floor(maxContextTokens * tokenRatio));
  let { recentMessages: plannerContextMessages } = splitRecentHistory(recentMessages, adjustedContextTokens, 6);
  plannerContextMessages = clampContextMessages(plannerContextMessages, tokenEstimate.tokensPerChar, maxContextMessageTokens);

  if (shouldRunPlanner({
    enabled: plannerEnabled,
    mode: plannerMode,
    prompt,
    tokensPerChar: tokenEstimate.tokensPerChar,
    minTokens: plannerMinTokens,
    trigger: plannerTrigger
  })) {
    try {
      const plannerStartedAt = Date.now();
      const plannerPrompt = buildPlannerPrompt(plannerContextMessages);
      const plannerResult = await openrouter.callModel({
        model: plannerModel,
        instructions: plannerPrompt.instructions,
        input: plannerPrompt.input,
        maxOutputTokens: plannerMaxOutputTokens,
        temperature: plannerTemperature,
        reasoning: { effort: 'low' as const }
      });
      const plannerText = await getResponseText(plannerResult, 'planner');
      const plan = parsePlannerResponse(plannerText);
      if (plan) {
        planBlock = formatPlanBlock(plan);
      }
      timings.planner_ms = Date.now() - plannerStartedAt;
    } catch (err) {
      log(`Planner failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (planBlock) {
    instructions = buildInstructions(planBlock);
    instructionsTokens = estimateTokensForModel(instructions, tokenEstimate.tokensPerChar);
    maxContextTokens = Math.max(config.maxContextTokens - config.maxOutputTokens - instructionsTokens, 2000);
    adjustedContextTokens = Math.max(1000, Math.floor(maxContextTokens * tokenRatio));
    ({ recentMessages: plannerContextMessages } = splitRecentHistory(recentMessages, adjustedContextTokens, 6));
    plannerContextMessages = clampContextMessages(plannerContextMessages, tokenEstimate.tokensPerChar, maxContextMessageTokens);
  }

  const buildContext = (extraInstruction?: string) => {
    let resolvedInstructions = buildInstructions(planBlock);
    if (extraInstruction) {
      resolvedInstructions = `${resolvedInstructions}\n\n${extraInstruction}`;
    }
    const resolvedInstructionTokens = estimateTokensForModel(resolvedInstructions, tokenEstimate.tokensPerChar);
    const resolvedMaxContext = Math.max(config.maxContextTokens - config.maxOutputTokens - resolvedInstructionTokens, 2000);
    const resolvedAdjusted = Math.max(1000, Math.floor(resolvedMaxContext * tokenRatio));
    let { recentMessages: contextMessages } = splitRecentHistory(recentMessages, resolvedAdjusted, 6);
    contextMessages = clampContextMessages(contextMessages, tokenEstimate.tokensPerChar, maxContextMessageTokens);
    return {
      instructions: resolvedInstructions,
      instructionsTokens: resolvedInstructionTokens,
      contextMessages
    };
  };

  let responseText = '';
  let completionTokens = 0;
  let promptTokens = 0;
  let modelToolCalls: Array<{ name: string }> = [];

  let latencyMs: number | undefined;
  const runCompletion = async (extraInstruction?: string): Promise<{
    responseText: string;
    completionTokens: number;
    promptTokens: number;
    latencyMs?: number;
    modelToolCalls: Array<{ name: string }>;
  }> => {
    const { instructions: resolvedInstructions, instructionsTokens: resolvedInstructionTokens, contextMessages } = buildContext(extraInstruction);
    const resolvedPromptTokens = resolvedInstructionTokens
      + estimateMessagesTokens(contextMessages, tokenEstimate.tokensPerChar, tokenEstimate.tokensPerMessage)
      + tokenEstimate.tokensPerRequest;

    const safeLimit = Math.floor(config.maxContextTokens * 0.9);
    if (resolvedPromptTokens > safeLimit && contextMessages.length > 2) {
      log(`Estimated ${resolvedPromptTokens} tokens exceeds safe limit ${safeLimit}, truncating`);
      while (contextMessages.length > 2) {
        const currentTokens = resolvedInstructionTokens + estimateMessagesTokens(contextMessages, tokenEstimate.tokensPerChar, tokenEstimate.tokensPerMessage) + tokenEstimate.tokensPerRequest;
        if (currentTokens <= safeLimit) break;
        contextMessages.splice(0, 1);
      }
    }

    log('Starting OpenRouter call...');
    const startedAt = Date.now();
    const callParams = {
      model,
      instructions: resolvedInstructions,
      input: messagesToOpenRouter(contextMessages),
      tools,
      stopWhen: stepCountIs(maxToolSteps),
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      reasoning: { effort: 'low' as const }
    };
    const result = await openrouter.callModel(callParams);
    const localLatencyMs = Date.now() - startedAt;

    // Get the complete response text via the SDK's proper getText() path
    let localResponseText = await getResponseText(result, 'completion');

    const toolCallsFromModel = await result.getToolCalls();
    if (toolCallsFromModel.length > 0) {
      log(`Model made ${toolCallsFromModel.length} tool call(s): ${toolCallsFromModel.map(t => t.name).join(', ')}`);
    }

    if (!localResponseText || !localResponseText.trim()) {
      if (toolCallsFromModel.length > 0) {
        localResponseText = 'I started running tool calls but did not get a final response. If you want me to continue, please ask a narrower subtask or say "continue".';
      } else {
        log(`Warning: Model returned empty/whitespace response. tool calls: ${toolCallsFromModel.length}`);
      }
    } else {
      log(`Model returned text response (${localResponseText.length} chars)`);
    }

    const localCompletionTokens = estimateTokensForModel(localResponseText || '', tokenEstimate.tokensPerChar);
    return {
      responseText: localResponseText,
      completionTokens: localCompletionTokens,
      promptTokens: resolvedPromptTokens,
      latencyMs: localLatencyMs,
      modelToolCalls: toolCallsFromModel
    };
  };

  try {
    const firstAttempt = await runCompletion();
    responseText = firstAttempt.responseText;
    completionTokens = firstAttempt.completionTokens;
    promptTokens = firstAttempt.promptTokens;
    latencyMs = firstAttempt.latencyMs;
    modelToolCalls = firstAttempt.modelToolCalls;

    const shouldValidate = responseValidateEnabled
      && promptTokens >= responseValidateMinPromptTokens
      && completionTokens >= responseValidateMinResponseTokens
      && (responseValidateAllowToolCalls || modelToolCalls.length === 0);
    if (shouldValidate) {
      const MAX_VALIDATION_ITERATIONS = 5;
      let retriesLeft = responseValidateMaxRetries;
      for (let _validationIter = 0; _validationIter < MAX_VALIDATION_ITERATIONS; _validationIter++) {
        if (!responseValidateAllowToolCalls && modelToolCalls.length > 0) {
          break;
        }
        let validationResult: ResponseValidation | null = null;
        if (!responseText || !responseText.trim()) {
          validationResult = { verdict: 'fail', issues: ['Response was empty.'], missing: [] };
        } else {
          try {
            const validationStartedAt = Date.now();
            validationResult = await validateResponseQuality({
              openrouter,
              model: responseValidateModel,
              userPrompt: query,
              response: responseText,
              maxOutputTokens: responseValidateMaxOutputTokens,
              temperature: responseValidateTemperature
            });
            timings.response_validation_ms = (timings.response_validation_ms ?? 0) + (Date.now() - validationStartedAt);
          } catch (err) {
            log(`Response validation failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!validationResult || validationResult.verdict === 'pass') {
          break;
        }
        if (retriesLeft <= 0) {
          break;
        }
        retriesLeft -= 1;
        log(`Response validation failed; retrying (${retriesLeft} retries left)`);
        const retryGuidance = buildRetryGuidance(validationResult);
        const retryAttempt = await runCompletion(retryGuidance);
        responseText = retryAttempt.responseText;
        completionTokens = retryAttempt.completionTokens;
        promptTokens = retryAttempt.promptTokens;
        latencyMs = retryAttempt.latencyMs;
        modelToolCalls = retryAttempt.modelToolCalls;
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    return {
      status: 'error',
      result: null,
      newSessionId: isNew ? sessionCtx.sessionId : undefined,
      error: errorMessage,
      model,
      prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
      memory_summary: sessionCtx.state.summary,
      memory_facts: sessionCtx.state.facts,
      tokens_prompt: promptTokens,
      tokens_completion: completionTokens,
      memory_recall_count: memoryRecallCount,
      session_recall_count: sessionRecallCount,
      memory_items_upserted: memoryItemsUpserted,
      memory_items_extracted: memoryItemsExtracted,
      timings: Object.keys(timings).length > 0 ? timings : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      latency_ms: latencyMs
    };
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
    const extractionResult = await openrouter.callModel({
      model: memoryModel,
      instructions: extractionPrompt.instructions,
      input: extractionPrompt.input,
      maxOutputTokens: memoryExtractionMaxOutputTokens,
      temperature: 0.1,
      reasoning: { effort: 'low' as const }
    });
    const extractionText = await getResponseText(extractionResult, 'memory_extraction');
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

  if (memoryExtractionEnabled && (!input.isScheduledTask || memoryExtractScheduled)) {
    const runMemoryExtractionWithRetry = async (maxRetries = 2): Promise<void> => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          await runMemoryExtraction();
          return;
        } catch (err) {
          log(`Memory extraction attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
      }
      log('Memory extraction failed after all retries');
    };

    if (memoryExtractionAsync && isDaemon) {
      void runMemoryExtractionWithRetry().catch(() => {});
    } else {
      await runMemoryExtractionWithRetry();
    }
  }

  // Normalize empty/whitespace-only responses to null
  const finalResult = responseText && responseText.trim() ? responseText : null;
  if (toolCalls.length > 0) {
    const totalToolMs = toolCalls.reduce((sum, call) => sum + (call.duration_ms || 0), 0);
    if (totalToolMs > 0) {
      timings.tool_ms = totalToolMs;
    }
  }

  // Cleanup MCP connections
  if (mcpCleanup) {
    try { await mcpCleanup(); } catch { /* ignore cleanup errors */ }
  }

  return {
    status: 'success',
    result: finalResult,
    newSessionId: isNew ? sessionCtx.sessionId : undefined,
    model,
    prompt_pack_versions: Object.keys(promptPackVersions).length > 0 ? promptPackVersions : undefined,
    memory_summary: sessionCtx.state.summary,
    memory_facts: sessionCtx.state.facts,
    tokens_prompt: promptTokens,
    tokens_completion: completionTokens,
    memory_recall_count: memoryRecallCount,
    session_recall_count: sessionRecallCount,
    memory_items_upserted: memoryItemsUpserted,
    memory_items_extracted: memoryItemsExtracted,
    timings: Object.keys(timings).length > 0 ? timings : undefined,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    latency_ms: latencyMs
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
