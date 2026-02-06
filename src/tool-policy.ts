import { TOOL_POLICY_PATH } from './paths.js';
import { loadJson } from './utils.js';

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
  max_per_run?: Record<string, number>;
  default_max_per_run?: number;
}

export interface ToolPolicyConfig {
  default?: ToolPolicy;
  groups?: Record<string, ToolPolicy>;
  users?: Record<string, ToolPolicy>;
}

const DEFAULT_POLICY: ToolPolicy = {
  allow: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'GitClone',
    'NpmInstall',
    'WebSearch',
    'WebFetch',
    'Bash',
    'Python',
    'Browser',
    'mcp__dotclaw__send_message',
    'mcp__dotclaw__send_file',
    'mcp__dotclaw__send_photo',
    'mcp__dotclaw__send_voice',
    'mcp__dotclaw__send_audio',
    'mcp__dotclaw__send_location',
    'mcp__dotclaw__send_contact',
    'mcp__dotclaw__send_poll',
    'mcp__dotclaw__send_buttons',
    'mcp__dotclaw__edit_message',
    'mcp__dotclaw__delete_message',
    'mcp__dotclaw__download_url',
    'mcp__dotclaw__text_to_speech',
    'mcp__dotclaw__schedule_task',
    'mcp__dotclaw__run_task',
    'mcp__dotclaw__list_tasks',
    'mcp__dotclaw__pause_task',
    'mcp__dotclaw__resume_task',
    'mcp__dotclaw__cancel_task',
    'mcp__dotclaw__update_task',
    'mcp__dotclaw__register_group',
    'mcp__dotclaw__remove_group',
    'mcp__dotclaw__list_groups',
    'mcp__dotclaw__set_model',
    'mcp__dotclaw__memory_upsert',
    'mcp__dotclaw__memory_forget',
    'mcp__dotclaw__memory_list',
    'mcp__dotclaw__memory_search',
    'mcp__dotclaw__memory_stats'
  ],
  deny: [],
  max_per_run: {
    Bash: 128,
    Python: 64,
    WebSearch: 40,
    WebFetch: 60
  },
  default_max_per_run: 256
};

const POLICY_PATH = TOOL_POLICY_PATH;

export function loadToolPolicyConfig(): ToolPolicyConfig {
  return loadJson<ToolPolicyConfig>(POLICY_PATH, {});
}

function normalizeList(value?: string[]): string[] {
  if (!value) return [];
  return value.map(item => item.trim()).filter(Boolean);
}

function mergePolicy(base: ToolPolicy, override?: ToolPolicy): ToolPolicy {
  if (!override) return base;
  const baseAllow = normalizeList(base.allow);
  const overrideAllow = normalizeList(override.allow);
  const allow = baseAllow.length > 0
    ? (overrideAllow.length > 0 ? baseAllow.filter(item => overrideAllow.includes(item)) : baseAllow)
    : overrideAllow;

  const deny = Array.from(new Set([...normalizeList(base.deny), ...normalizeList(override.deny)]));
  const maxPerRun = { ...(base.max_per_run || {}), ...(override.max_per_run || {}) };
  const defaultMax = override.default_max_per_run ?? base.default_max_per_run;

  return {
    allow,
    deny,
    max_per_run: maxPerRun,
    default_max_per_run: defaultMax
  };
}

export function getEffectiveToolPolicy(params: {
  groupFolder: string;
  userId?: string | null;
}): ToolPolicy {
  const config = loadToolPolicyConfig();
  const base = mergePolicy(DEFAULT_POLICY, config.default);
  const groupPolicy = config.groups?.[params.groupFolder];
  const userPolicy = params.userId ? config.users?.[params.userId] : undefined;
  const merged = mergePolicy(mergePolicy(base, groupPolicy), userPolicy);
  return merged;
}


export function mergeToolPolicyDeny(policy: ToolPolicy, denyList: string[]): ToolPolicy {
  if (!denyList.length) return policy;
  const existing = Array.isArray(policy.deny) ? policy.deny : [];
  const merged = Array.from(new Set([...existing, ...denyList]));
  return { ...policy, deny: merged };
}
