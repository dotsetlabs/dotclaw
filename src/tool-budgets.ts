import path from 'path';
import { DATA_DIR } from './config.js';
import { loadJson } from './utils.js';
import { getToolUsageCounts } from './db.js';
import { ToolPolicy } from './tool-policy.js';

export interface ToolBudget {
  per_day?: Record<string, number>;
}

export interface ToolBudgetConfig {
  default?: ToolBudget;
  groups?: Record<string, ToolBudget>;
  users?: Record<string, ToolBudget>;
}

const DEFAULT_PATH = path.join(DATA_DIR, 'tool-budgets.json');

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeBudgetMap(map?: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  if (!map) return normalized;
  for (const [key, value] of Object.entries(map)) {
    if (!Number.isFinite(value)) continue;
    normalized[normalizeToolName(key)] = Math.max(0, Math.floor(value));
  }
  return normalized;
}

function mergeBudgets(base: ToolBudget, override?: ToolBudget): ToolBudget {
  if (!override) return base;
  const basePerDay = normalizeBudgetMap(base.per_day);
  const overridePerDay = normalizeBudgetMap(override.per_day);
  return {
    per_day: { ...basePerDay, ...overridePerDay }
  };
}

export function loadToolBudgetConfig(): ToolBudgetConfig {
  return loadJson<ToolBudgetConfig>(process.env.DOTCLAW_TOOL_BUDGETS_PATH || DEFAULT_PATH, {});
}

export function applyToolBudgets(params: {
  groupFolder: string;
  userId?: string | null;
  toolPolicy: ToolPolicy;
}): ToolPolicy {
  const enabled = !['0', 'false', 'no', 'off'].includes((process.env.DOTCLAW_TOOL_BUDGETS_ENABLED || '').toLowerCase());
  if (!enabled) return params.toolPolicy;

  const config = loadToolBudgetConfig();
  const base = mergeBudgets({ per_day: {} }, config.default);
  const groupBudget = config.groups?.[params.groupFolder];
  const userBudget = params.userId ? config.users?.[params.userId] : undefined;
  const merged = mergeBudgets(mergeBudgets(base, groupBudget), userBudget);
  const perDay = merged.per_day || {};
  const budgetEntries = Object.entries(perDay);
  if (budgetEntries.length === 0) return params.toolPolicy;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const usage = getToolUsageCounts({
    groupFolder: params.groupFolder,
    userId: params.userId,
    since: startOfDay.toISOString()
  });
  const usageMap = new Map<string, number>();
  for (const row of usage) {
    usageMap.set(normalizeToolName(row.tool_name), row.count);
  }

  const denyList = new Set((params.toolPolicy.deny || []).map(normalizeToolName));
  for (const [toolName, limit] of budgetEntries) {
    if (limit <= 0) {
      denyList.add(toolName);
      continue;
    }
    const used = usageMap.get(toolName) || 0;
    if (used >= limit) {
      denyList.add(toolName);
    }
  }

  return {
    ...params.toolPolicy,
    deny: Array.from(denyList)
  };
}
