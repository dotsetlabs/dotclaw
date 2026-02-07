/**
 * Structured system prompt builder for DotClaw agent.
 *
 * Organizes the system prompt into clear sections with a consistent
 * format. Supports "full" mode for user-facing calls and "minimal"
 * mode for background tasks (summaries, memory extraction).
 */

import type { SkillCatalog } from './skill-loader.js';
import type { PromptPack } from './prompt-packs.js';
import { formatSkillCatalog } from './skill-loader.js';
import { formatPromptPack } from './prompt-packs.js';

export type PromptMode = 'full' | 'minimal';

export interface SystemPromptParams {
  mode: PromptMode;
  assistantName: string;

  // Identity & context
  messagingPlatform?: string;
  hostPlatform?: string;
  timezone?: string;

  // Scheduled task context
  isScheduledTask: boolean;
  taskId?: string;

  // Notes & skills
  groupNotes?: string | null;
  globalNotes?: string | null;
  skillCatalog?: SkillCatalog | null;

  // Memory
  memorySummary: string;
  memoryFacts: string[];
  sessionRecall: string[];
  longTermRecall: string[];
  userProfile?: string | null;
  memoryStats?: { total: number; user: number; group: number; global: number };

  // Groups
  availableGroups?: Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }>;

  // Tool reliability
  toolReliability?: Array<{ name: string; success_rate: number; count: number; avg_duration_ms: number | null }>;

  // Behavior
  behaviorConfig?: Record<string, unknown>;

  // Prompt packs
  taskExtractionPack?: PromptPack | null;
  responseQualityPack?: PromptPack | null;
  toolCallingPack?: PromptPack | null;
  toolOutcomePack?: PromptPack | null;
  memoryPolicyPack?: PromptPack | null;
  memoryRecallPack?: PromptPack | null;

  // Budget
  maxToolSteps?: number;

  // Tool config
  browserEnabled: boolean;

  // Pack limits
  promptPacksMaxChars: number;
  promptPacksMaxDemos: number;
}

const MEMORY_SUMMARY_MAX_CHARS = 2000;
const PROMPT_PACKS_TOTAL_BUDGET_FACTOR = 3;

/** Build a section with a heading, only if content is present */
function section(heading: string, content: string): string {
  if (!content.trim()) return '';
  return `## ${heading}\n${content}`;
}

function buildIdentitySection(params: SystemPromptParams): string {
  const parts = [
    `You are ${params.assistantName}, a personal assistant running inside DotClaw.`
  ];
  if (params.messagingPlatform) {
    parts[0] += ` You are currently connected via ${params.messagingPlatform}.`;
  }
  return parts.join('\n');
}

function buildPlatformSection(params: SystemPromptParams): string {
  if (!params.hostPlatform) return '';
  if (params.hostPlatform.startsWith('linux')) {
    return `Host platform: ${params.hostPlatform} (matches container).`;
  }
  return [
    `You are running inside a Linux container, but the user's host machine is ${params.hostPlatform}.`,
    'Prefer pnpm over npm for installing packages — it generates cross-platform lockfiles.',
    'node_modules and package-lock.json are automatically cleaned up after your run finishes (pnpm-lock.yaml is preserved).',
    'You do NOT need to delete them yourself. The user will need to run `pnpm install` (or `npx pnpm install`) on their machine before building.',
    'Use node_modules freely during your run for builds and tests.'
  ].join(' ');
}

function buildScheduledSection(params: SystemPromptParams): string {
  if (!params.isScheduledTask) return '';
  return `You are running as a scheduled task${params.taskId ? ` (task id: ${params.taskId})` : ''}. If you need to communicate, use \`mcp__dotclaw__send_message\`.`;
}

function buildResponseGuidanceSection(): string {
  return [
    '- Always answer the user\'s question directly before reaching for tools.',
    '- If the user asks about your previous actions (e.g., "did you use X tool?"), reflect on the conversation history — do not re-execute the task.',
    '- If the user asks a simple factual question, answer from your knowledge — do not call tools unless you need to verify or act.',
    '- When you have genuinely nothing to say, respond with ONLY: NO_REPLY (your entire message must be just this token, nothing else).'
  ].join('\n');
}

function buildToolCallStyleSection(): string {
  return [
    'Default: do not narrate routine, low-risk tool calls — just call the tool.',
    'Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions, or when the user explicitly asks.',
    'Keep narration brief and value-dense; avoid repeating obvious steps.'
  ].join('\n');
}

function buildToolGuidanceSection(params: SystemPromptParams): string {
  const lines = [
    'Key tool rules:',
    '- User attachments arrive in /workspace/group/inbox/ (see <attachment> tags). Process with Read/Bash/Python.',
    '- To send media from the web: download_url → send_photo/send_file/send_audio.',
    '- Charts/plots: matplotlib → savefig → send_photo. Graphviz → dot -Tpng → send_photo.',
    '- Voice messages are auto-transcribed (<transcript> in <attachment>). Reply with normal text — the host auto-converts to voice.',
    '- GitHub CLI (`gh`) is available if GH_TOKEN is set.',
    '- plugin__* and mcp_ext__* tools may be available if configured.',
    '- Use [[reply_to_current]] to reply to the message that triggered this run, or [[reply_to:<id>]] to reply to a specific message ID.'
  ];

  if (params.browserEnabled) {
    lines.push(
      'Browser Tool: actions: navigate, snapshot, click, fill, screenshot, extract, evaluate, close.',
      'Use snapshot with interactive=true for clickable refs (@e1, @e2). Screenshots → /workspace/group/screenshots/.'
    );
  }

  lines.push(
    'Process Tool: for commands that run longer than ~2 minutes (builds, servers, data pipelines, web scrapers).',
    'Use Process start to launch, poll to check output, write for stdin, kill to stop, remove to clean up.',
    'AnalyzeImage Tool: analyze image files in the workspace using a vision model.',
    'Use `pdftotext file.pdf -` via Bash to extract text from PDFs. poppler-utils is installed.',
    'Skill authoring: create skills by writing .md files to /workspace/group/skills/ with YAML frontmatter (name, description). Skills are auto-discovered on next run.',
    'Plugin authoring: create plugins by writing JSON files to /workspace/group/plugins/ following the plugin schema (name, description, type: http|bash, url|command, input, required).',
    'Config tools: use mcp__dotclaw__get_config to inspect current configuration and mcp__dotclaw__set_tool_policy / set_behavior / set_mcp_config to self-configure.',
    'Sub-agents: use mcp__dotclaw__subagent to spawn parallel tasks with different models. Spawn for parallel research, long computations, or tasks requiring a different model.'
  );

  return lines.join('\n');
}

function buildMemorySection(params: SystemPromptParams): string {
  const parts: string[] = [];
  const hasAny = params.memorySummary || params.memoryFacts.length > 0 ||
    params.longTermRecall.length > 0 || params.userProfile;

  if (hasAny) {
    parts.push('The following memories may or may not be relevant to the current conversation. Use them only if they directly answer the user\'s question.');
    if (params.memorySummary) {
      parts.push('Long-term memory summary:');
      parts.push(params.memorySummary.slice(0, MEMORY_SUMMARY_MAX_CHARS));
    }
    if (params.memoryFacts.length > 0) {
      parts.push('Long-term facts:');
      parts.push(params.memoryFacts.map(f => `- ${f}`).join('\n'));
    }
    if (params.userProfile) {
      parts.push('User profile:');
      parts.push(params.userProfile);
    }
    if (params.longTermRecall.length > 0) {
      parts.push('What you remember about the user (long-term):');
      parts.push(params.longTermRecall.map(item => `- ${item}`).join('\n'));
    }
    if (params.memoryStats) {
      parts.push(`Memory stats: Total: ${params.memoryStats.total}, User: ${params.memoryStats.user}, Group: ${params.memoryStats.group}, Global: ${params.memoryStats.global}`);
    }
  } else {
    parts.push('No long-term memory available yet.');
  }

  if (params.sessionRecall.length > 0) {
    parts.push('Recent conversation context:');
    parts.push(params.sessionRecall.map(item => `- ${item}`).join('\n'));
  }

  return parts.join('\n');
}

function buildBehaviorSection(params: SystemPromptParams): string {
  const notes: string[] = [];
  const responseStyle = typeof params.behaviorConfig?.response_style === 'string'
    ? String(params.behaviorConfig.response_style) : '';
  if (responseStyle === 'concise') {
    notes.push('Keep responses short and to the point.');
  } else if (responseStyle === 'detailed') {
    notes.push('Give detailed, step-by-step responses when helpful.');
  }
  const toolBias = typeof params.behaviorConfig?.tool_calling_bias === 'number'
    ? Number(params.behaviorConfig.tool_calling_bias) : null;
  if (toolBias !== null && toolBias < 0.4) {
    notes.push('Ask before using tools unless the intent is obvious.');
  } else if (toolBias !== null && toolBias > 0.6) {
    notes.push('Use tools proactively when they add accuracy or save time.');
  }
  const cautionBias = typeof params.behaviorConfig?.caution_bias === 'number'
    ? Number(params.behaviorConfig.caution_bias) : null;
  if (cautionBias !== null && cautionBias > 0.6) {
    notes.push('Double-check uncertain facts and flag limitations.');
  }
  return notes.join('\n');
}

function buildPromptPackSections(params: SystemPromptParams): string[] {
  const totalBudget = params.promptPacksMaxChars * PROMPT_PACKS_TOTAL_BUDGET_FACTOR;
  const fmtPack = (label: string, pack: PromptPack | null | undefined) =>
    pack ? formatPromptPack({ label, pack, maxDemos: params.promptPacksMaxDemos, maxChars: params.promptPacksMaxChars }) : '';

  const packEntries: Array<[string, PromptPack | null | undefined]> = [
    ['Tool Calling Guidelines', params.toolCallingPack],
    ['Tool Outcome Guidelines', params.toolOutcomePack],
    ['Task Extraction Guidelines', params.taskExtractionPack],
    ['Response Quality Guidelines', params.responseQualityPack],
    ['Memory Policy Guidelines', params.memoryPolicyPack],
    ['Memory Recall Guidelines', params.memoryRecallPack],
  ];
  const blocks: string[] = [];
  let totalChars = 0;
  for (const [label, pack] of packEntries) {
    const block = fmtPack(label, pack);
    if (!block) continue;
    if (totalChars + block.length > totalBudget) break;
    blocks.push(block);
    totalChars += block.length;
  }
  return blocks;
}

/**
 * Build a complete system prompt from structured parameters.
 *
 * "full" mode includes all sections for user-facing agent calls.
 * "minimal" mode includes only identity + essential context for background tasks.
 */
export function buildSystemPrompt(params: SystemPromptParams): string {
  if (params.mode === 'minimal') {
    return [
      buildIdentitySection(params),
      buildScheduledSection(params),
      'Be concise and helpful.'
    ].filter(Boolean).join('\n\n');
  }

  const timezoneNote = params.timezone
    ? `Timezone: ${params.timezone}. Use this timezone when interpreting or presenting timestamps unless the user specifies another.`
    : '';

  const groupNotes = params.groupNotes ? `Group notes:\n${params.groupNotes}` : '';
  const globalNotes = params.globalNotes ? `Global notes:\n${params.globalNotes}` : '';
  const skillNotes = params.skillCatalog ? formatSkillCatalog(params.skillCatalog) : '';

  const availableGroups = params.availableGroups && params.availableGroups.length > 0
    ? params.availableGroups
      .map(g => `- ${g.name} (chat ${g.jid}, last: ${g.lastActivity})`)
      .join('\n')
    : '';

  const toolReliability = params.toolReliability && params.toolReliability.length > 0
    ? params.toolReliability
      .sort((a, b) => a.success_rate - b.success_rate)
      .slice(0, 20)
      .map(t => {
        const pct = `${Math.round(t.success_rate * 100)}%`;
        const avg = Number.isFinite(t.avg_duration_ms) ? `${Math.round(t.avg_duration_ms!)}ms` : 'n/a';
        return `- ${t.name}: success ${pct} over ${t.count} calls (avg ${avg})`;
      })
      .join('\n')
    : '';

  const packBlocks = buildPromptPackSections(params);

  const sections = [
    buildIdentitySection(params),
    buildPlatformSection(params),
    buildScheduledSection(params),
    section('Response Guidelines', buildResponseGuidanceSection()),
    section('Tools', buildToolGuidanceSection(params)),
    section('Tool Call Style', buildToolCallStyleSection()),
    groupNotes,
    globalNotes,
    skillNotes,
    timezoneNote,
    ...packBlocks,
    availableGroups ? section('Available Groups', availableGroups) : '',
    toolReliability ? section('Tool Reliability', toolReliability) : '',
    buildBehaviorSection(params) ? section('Behavior', buildBehaviorSection(params)) : '',
    section('Memory', buildMemorySection(params)),
    params.maxToolSteps
      ? `You have a budget of ${params.maxToolSteps} tool steps per request. If a task is large, break your work into phases and always finish with a text summary of what you accomplished — never end on a tool call without a response.`
      : '',
    'Be concise and helpful. When you use tools, summarize what happened rather than dumping raw output.'
  ];

  return sections.filter(Boolean).join('\n\n');
}
