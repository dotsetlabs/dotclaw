import fs from 'fs';
import os from 'os';
import path from 'path';

export type FailoverCategory =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'overloaded'
  | 'transport'
  | 'invalid_response'
  | 'context_overflow'
  | 'aborted'
  | 'non_retryable';

export type HostFailoverConfig = {
  enabled: boolean;
  maxRetries: number;
  cooldownRateLimitMs: number;
  cooldownTransientMs: number;
  cooldownInvalidResponseMs: number;
};

export type FailoverEnvelope = {
  category: FailoverCategory;
  retryable: boolean;
  source: 'container_output' | 'runtime_exception';
  attempt: number;
  model: string | null;
  statusCode?: number;
  message: string;
  timestamp: string;
};

const modelCooldowns = new Map<string, number>();
const TIMEOUT_COOLDOWN_MIN_MS = 15 * 60 * 1000;
const TIMEOUT_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_COOLDOWN_MULTIPLIER = 3;
const COOLDOWN_STORE_FILE = 'failover-cooldowns.json';
const MAX_PERSISTED_COOLDOWNS = 128;
const MIN_PERSIST_TIMESTAMP_MS = 1_000_000_000_000;
let cooldownsLoaded = false;

function normalizeMessage(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;
  return message || '';
}

function getCooldownStorePath(): string | null {
  if (process.env.DOTCLAW_DISABLE_FAILOVER_COOLDOWN_PERSISTENCE === '1') {
    return null;
  }
  const override = String(process.env.DOTCLAW_FAILOVER_COOLDOWN_PATH || '').trim();
  if (override) return path.resolve(override);
  const dotclawHome = process.env.DOTCLAW_HOME
    ? path.resolve(process.env.DOTCLAW_HOME)
    : path.join(os.homedir(), '.dotclaw');
  return path.join(dotclawHome, 'data', COOLDOWN_STORE_FILE);
}

function hydrateCooldowns(nowMs: number): void {
  if (cooldownsLoaded) return;
  cooldownsLoaded = true;
  const storePath = getCooldownStorePath();
  if (!storePath) return;
  try {
    if (!fs.existsSync(storePath)) return;
    const raw = fs.readFileSync(storePath, 'utf-8').trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      model_cooldowns?: Record<string, unknown>;
    };
    const entries = parsed?.model_cooldowns && typeof parsed.model_cooldowns === 'object'
      ? Object.entries(parsed.model_cooldowns)
      : [];
    for (const [model, untilRaw] of entries) {
      const normalizedModel = String(model || '').trim();
      const until = Number(untilRaw);
      if (!normalizedModel || !Number.isFinite(until)) continue;
      if (until > nowMs) {
        modelCooldowns.set(normalizedModel, until);
      }
    }
  } catch {
    // Ignore invalid/partial state file and continue with in-memory cooldown map.
  }
}

function persistCooldowns(nowMs: number): void {
  const storePath = getCooldownStorePath();
  if (!storePath) return;
  try {
    const entries = Array.from(modelCooldowns.entries())
      .filter(([, until]) => Number.isFinite(until) && until > nowMs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PERSISTED_COOLDOWNS);
    const payload = {
      version: 1,
      updated_at: new Date(nowMs).toISOString(),
      model_cooldowns: Object.fromEntries(entries.map(([model, until]) => [model, Math.floor(until)]))
    };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, storePath);
  } catch {
    // Persistence is best-effort; runtime behavior should continue regardless.
  }
}

function compactMessage(message: string, maxChars = 240): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function hasBoundaryCode(message: string, code: string): boolean {
  return new RegExp(`\\b${code}\\b`).test(message);
}

function extractStatusCode(message: string): number | undefined {
  const match = message.match(/\b([1-5][0-9]{2})\b/);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

export function classifyFailoverError(error: Error | string): FailoverCategory {
  const message = normalizeMessage(error);
  const lower = message.toLowerCase();

  if (/preempted|aborted|interrupted|cancelled|canceled/.test(lower)) {
    return 'aborted';
  }
  if (/invalid.?api.?key|unauthorized|forbidden|insufficient.?credit|payment.?required/.test(lower)
    || hasBoundaryCode(message, '401')
    || hasBoundaryCode(message, '402')
    || hasBoundaryCode(message, '403')) {
    return 'auth';
  }
  if (/maximum.?context|context.?length|too many tokens|token.?limit/.test(lower)) {
    return 'context_overflow';
  }
  if (/rate.?limit|too many requests/.test(lower) || hasBoundaryCode(message, '429')) {
    return 'rate_limit';
  }
  if (/timeout|timed out|deadline/.test(lower) || /daemon response timeout/i.test(message)) {
    return 'timeout';
  }
  if (/overloaded|server error|bad gateway|unavailable|provider error|model.?not.?available|no endpoints/.test(lower)
    || hasBoundaryCode(message, '500')
    || hasBoundaryCode(message, '502')
    || hasBoundaryCode(message, '503')
    || hasBoundaryCode(message, '504')) {
    return 'overloaded';
  }
  if (/failed to parse daemon response|invalid json in container output|output missing sentinel|missing required "status"/i.test(message)) {
    return 'invalid_response';
  }
  if (/econnrefused|econnreset|eai_again|enotfound|container spawn error|daemon response/i.test(lower)) {
    return 'transport';
  }
  return 'non_retryable';
}

export function isRetryableFailoverCategory(category: FailoverCategory): boolean {
  return category === 'rate_limit'
    || category === 'timeout'
    || category === 'overloaded'
    || category === 'transport'
    || category === 'invalid_response';
}

export function buildFailoverEnvelope(params: {
  error: Error | string;
  source: FailoverEnvelope['source'];
  attempt: number;
  model?: string | null;
  timestampMs?: number;
}): FailoverEnvelope {
  const message = normalizeMessage(params.error);
  const category = classifyFailoverError(message);
  return {
    category,
    retryable: isRetryableFailoverCategory(category),
    source: params.source,
    attempt: Math.max(1, Math.floor(params.attempt)),
    model: (params.model || '').trim() || null,
    statusCode: extractStatusCode(message),
    message: compactMessage(message),
    timestamp: new Date(params.timestampMs ?? Date.now()).toISOString()
  };
}

function cooldownMsForCategory(category: FailoverCategory, config: HostFailoverConfig): number {
  if (category === 'rate_limit') return Math.max(0, config.cooldownRateLimitMs);
  if (category === 'invalid_response') return Math.max(0, config.cooldownInvalidResponseMs);
  if (category === 'timeout') {
    const base = Math.max(0, config.cooldownTransientMs);
    const scaled = Math.max(TIMEOUT_COOLDOWN_MIN_MS, Math.floor(base * TIMEOUT_COOLDOWN_MULTIPLIER));
    return Math.min(TIMEOUT_COOLDOWN_MAX_MS, scaled);
  }
  if (category === 'overloaded' || category === 'transport') {
    return Math.max(0, config.cooldownTransientMs);
  }
  return 0;
}

function cleanupExpiredCooldowns(nowMs: number, options?: { persist?: boolean }): void {
  hydrateCooldowns(nowMs);
  let changed = false;
  for (const [model, until] of modelCooldowns.entries()) {
    if (until <= nowMs) {
      modelCooldowns.delete(model);
      changed = true;
    }
  }
  if (changed && options?.persist !== false) {
    persistCooldowns(nowMs);
  }
}

export function registerModelFailureCooldown(
  model: string | null | undefined,
  category: FailoverCategory,
  config: HostFailoverConfig,
  nowMs: number = Date.now()
): number {
  hydrateCooldowns(nowMs);
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return 0;
  const durationMs = cooldownMsForCategory(category, config);
  if (durationMs <= 0) return 0;
  cleanupExpiredCooldowns(nowMs, { persist: false });
  modelCooldowns.set(normalizedModel, nowMs + durationMs);
  if (nowMs >= MIN_PERSIST_TIMESTAMP_MS) {
    persistCooldowns(nowMs);
  }
  return durationMs;
}

export function isModelInHostCooldown(model: string | null | undefined, nowMs: number = Date.now()): boolean {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return false;
  cleanupExpiredCooldowns(nowMs, { persist: false });
  const until = modelCooldowns.get(normalizedModel);
  return typeof until === 'number' && until > nowMs;
}

function uniqNonEmpty(models: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const normalized = (model || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

export function chooseNextHostModelChain(params: {
  modelChain: string[];
  attemptedPrimaryModels: Set<string>;
  nowMs?: number;
}): { model: string; fallbacks: string[] } | null {
  const nowMs = params.nowMs ?? Date.now();
  cleanupExpiredCooldowns(nowMs, { persist: false });
  const chain = uniqNonEmpty(params.modelChain)
    .filter(model => !isModelInHostCooldown(model, nowMs));
  for (let i = 0; i < chain.length; i += 1) {
    const primary = chain[i];
    if (params.attemptedPrimaryModels.has(primary)) continue;
    return {
      model: primary,
      fallbacks: chain.filter((_, idx) => idx !== i),
    };
  }
  return null;
}

export function downgradeReasoningEffort(
  effort: 'off' | 'low' | 'medium' | 'high' | undefined
): 'off' | 'low' | 'medium' | 'high' | undefined {
  if (effort === 'high') return 'medium';
  if (effort === 'medium') return 'low';
  if (effort === 'low') return 'off';
  return effort;
}

export function reduceToolStepBudget(maxToolSteps: number | undefined): number | undefined {
  if (!Number.isFinite(maxToolSteps) || !maxToolSteps || maxToolSteps <= 0) return maxToolSteps;
  return Math.max(8, Math.floor(maxToolSteps * 0.7));
}

export function resetFailoverCooldownsForTests(): void {
  modelCooldowns.clear();
  cooldownsLoaded = true;
  const storePath = getCooldownStorePath();
  if (storePath && process.env.DOTCLAW_FAILOVER_COOLDOWN_PATH) {
    try { fs.rmSync(storePath, { force: true }); } catch { /* ignore */ }
  }
}
