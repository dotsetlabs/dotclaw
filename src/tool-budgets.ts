import { TOOL_BUDGETS_PATH } from './paths.js';
import { loadJson } from './utils.js';
import { loadRuntimeConfig } from './runtime-config.js';
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

const runtime = loadRuntimeConfig();

const DEFAULT_PATH = runtime.host.toolBudgets.path || TOOL_BUDGETS_PATH;

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
  const fallback: ToolBudgetConfig = {
    default: {
      per_day: {
        WebSearch: 1000,
        WebFetch: 1500,
        Bash: 2000,
        Python: 1500,
        GitClone: 400,
        PackageInstall: 300
      }
    }
  };
  return loadJson<ToolBudgetConfig>(DEFAULT_PATH, fallback);
}

export function applyToolBudgets(params: {
  groupFolder: string;
  userId?: string | null;
  toolPolicy: ToolPolicy;
}): ToolPolicy {
  if (!runtime.host.toolBudgets.enabled) return params.toolPolicy;

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
