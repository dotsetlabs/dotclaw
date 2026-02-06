import dotenv from 'dotenv';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAIN_GROUP_FOLDER,
  GROUPS_DIR,
  CONTAINER_MODE,
  CONTAINER_PRIVILEGED,
  WARM_START_ENABLED,
  ENV_PATH,
} from './config.js';

// Load .env from the canonical location (~/.dotclaw/.env)
dotenv.config({ path: ENV_PATH });
import { RegisteredGroup, Session, MessageAttachment } from './types.js';
import {
  initDatabase,
  closeDatabase,
  storeMessage,
  upsertChat,
  getChatState,
  getAllGroupSessions,
  setGroupSession,
  deleteGroupSession,
  pauseTasksForGroup,
  getTraceIdForMessage,
  recordUserFeedback,
  getChatsWithPendingMessages,
  resetStalledMessages,
  resetStalledBackgroundJobs,
} from './db.js';
import { startSchedulerLoop, stopSchedulerLoop } from './task-scheduler.js';
import {
  startBackgroundJobLoop,
  stopBackgroundJobLoop,
} from './background-jobs.js';
import type { ContainerOutput } from './container-protocol.js';
import type { AgentContext } from './agent-context.js';
import { loadJson, saveJson, isSafeGroupFolder } from './utils.js';
import { writeTrace } from './trace-writer.js';
import {
  initMemoryStore,
  closeMemoryStore,
  cleanupExpiredMemories,
  upsertMemoryItems,
  MemoryItemInput
} from './memory-store.js';
import { startEmbeddingWorker, stopEmbeddingWorker } from './memory-embeddings.js';
import { parseAdminCommand } from './admin-commands.js';
import { loadModelRegistry, saveModelRegistry } from './model-registry.js';
import { startMetricsServer, stopMetricsServer, recordMessage, recordRoutingDecision, recordStageLatency } from './metrics.js';
import { startMaintenanceLoop, stopMaintenanceLoop } from './maintenance.js';
import { warmGroupContainer, startDaemonHealthCheckLoop, stopDaemonHealthCheckLoop, cleanupInstanceContainers, suppressHealthChecks, resetUnhealthyDaemons } from './container-runner.js';
import { startWakeDetector, stopWakeDetector } from './wake-detector.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { transcribeVoice } from './transcription.js';
import { emitHook } from './hooks.js';
import { closeWorkflowStore } from './workflow-store.js';
import { invalidatePersonalizationCache } from './personalization.js';
import { installSkill, removeSkill, listSkills, updateSkill } from './skill-manager.js';
import { createTraceBase, executeAgentRun, recordAgentTelemetry, AgentExecutionError } from './agent-execution.js';
import { logger } from './logger.js';
import { startDashboard, stopDashboard, setTelegramConnected, setLastMessageTime } from './dashboard.js';
import { routePrompt } from './request-router.js';

// Provider system
import { ProviderRegistry } from './providers/registry.js';
import { createTelegramProvider } from './providers/telegram/index.js';
import type { IncomingMessage, MessagingProvider } from './providers/types.js';
import { createMessagePipeline, getActiveDrains, getActiveRuns, providerAttachmentToMessageAttachment } from './message-pipeline.js';
import { startIpcWatcher, stopIpcWatcher } from './ipc-dispatcher.js';

const runtime = loadRuntimeConfig();

// ───────────────────────── State ─────────────────────────

let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};

// ───────────────────────── Helpers ─────────────────────────

function buildTriggerRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function buildAvailableGroupsSnapshot(): Array<{ jid: string; name: string; lastActivity: string; isRegistered: boolean }> {
  return Object.entries(registeredGroups).map(([jid, info]) => ({
    jid,
    name: info.name,
    lastActivity: getChatState(jid)?.last_agent_timestamp || info.added_at,
    isRegistered: true
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ───────────────────────── Rate Limiter ─────────────────────────

const RATE_LIMIT_MAX_MESSAGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const rateLimiter = new Map<string, RateLimitEntry>();

function checkRateLimit(userId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const entry = rateLimiter.get(userId);

  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX_MESSAGES) {
    return { allowed: false, retryAfterMs: entry.resetAt - now };
  }

  entry.count += 1;
  return { allowed: true };
}

function cleanupRateLimiter(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimiter.entries()) {
    if (now > entry.resetAt) {
      rateLimiter.delete(key);
    }
  }
}

const rateLimiterInterval = setInterval(cleanupRateLimiter, 60_000);

// ───────────────────────── Config Constants ─────────────────────────

const MEMORY_RECALL_MAX_RESULTS = runtime.host.memory.recall.maxResults;
const MEMORY_RECALL_MAX_TOKENS = runtime.host.memory.recall.maxTokens;
const HEARTBEAT_ENABLED = runtime.host.heartbeat.enabled;
const HEARTBEAT_INTERVAL_MS = runtime.host.heartbeat.intervalMs;
const HEARTBEAT_GROUP_FOLDER = (runtime.host.heartbeat.groupFolder || MAIN_GROUP_FOLDER).trim() || MAIN_GROUP_FOLDER;

// ───────────────────────── State Management ─────────────────────────

function loadState(): void {
  sessions = {};
  const rawGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {}) as Record<string, RegisteredGroup>;

  // Migrate: prefix unprefixed chat IDs with 'telegram:'
  let migrated = false;
  const loadedGroups: Record<string, RegisteredGroup> = {};
  for (const [chatId, group] of Object.entries(rawGroups)) {
    if (!chatId.includes(':')) {
      // Unprefixed — add telegram: prefix
      loadedGroups[ProviderRegistry.addPrefix('telegram', chatId)] = group;
      migrated = true;
    } else {
      loadedGroups[chatId] = group;
    }
  }
  if (migrated) {
    saveJson(path.join(DATA_DIR, 'registered_groups.json'), loadedGroups);
    logger.info('Migrated registered_groups.json chat IDs with telegram: prefix');
  }

  const sanitizedGroups: Record<string, RegisteredGroup> = {};
  const usedFolders = new Set<string>();
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const [chatId, group] of Object.entries(loadedGroups)) {
    if (!group || typeof group !== 'object') {
      logger.warn({ chatId }, 'Skipping registered group with invalid entry');
      invalidCount += 1;
      continue;
    }
    if (typeof group.name !== 'string' || group.name.trim() === '') {
      logger.warn({ chatId }, 'Skipping registered group with invalid name');
      invalidCount += 1;
      continue;
    }
    if (!isSafeGroupFolder(group.folder, GROUPS_DIR)) {
      logger.warn({ chatId, folder: group.folder }, 'Skipping registered group with invalid folder');
      invalidCount += 1;
      continue;
    }
    if (usedFolders.has(group.folder)) {
      logger.warn({ chatId, folder: group.folder }, 'Skipping registered group with duplicate folder');
      duplicateCount += 1;
      continue;
    }
    usedFolders.add(group.folder);
    sanitizedGroups[chatId] = group;
  }

  registeredGroups = sanitizedGroups;
  if (invalidCount > 0 || duplicateCount > 0) {
    logger.error({ invalidCount, duplicateCount }, 'Registered groups contained invalid or duplicate folders');
  }
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
  const finalSessions = getAllGroupSessions();
  sessions = finalSessions.reduce<Session>((acc, row) => {
    acc[row.group_folder] = row.session_id;
    return acc;
  }, {});
}

function registerGroup(chatId: string, group: RegisteredGroup): void {
  if (!isSafeGroupFolder(group.folder, GROUPS_DIR)) {
    logger.warn({ chatId, folder: group.folder }, 'Refusing to register group with invalid folder');
    return;
  }
  const folderCollision = Object.values(registeredGroups).some(g => g.folder === group.folder);
  if (folderCollision) {
    logger.warn({ chatId, folder: group.folder }, 'Refusing to register group with duplicate folder');
    return;
  }
  registeredGroups[chatId] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group registered');

  if (CONTAINER_MODE === 'daemon' && WARM_START_ENABLED) {
    try {
      warmGroupContainer(group, group.folder === MAIN_GROUP_FOLDER);
      logger.info({ group: group.folder }, 'Warmed daemon container for new group');
    } catch (err) {
      logger.warn({ group: group.folder, err }, 'Failed to warm container for new group');
    }
  }
}

function listRegisteredGroups(): Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }> {
  return Object.entries(registeredGroups).map(([chatId, group]) => ({
    chat_id: chatId,
    name: group.name,
    folder: group.folder,
    trigger: group.trigger,
    added_at: group.added_at
  }));
}

function resolveGroupIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  for (const [chatId, group] of Object.entries(registeredGroups)) {
    if (chatId === trimmed) return chatId;
    if (group.name.toLowerCase() === normalized) return chatId;
    if (group.folder.toLowerCase() === normalized) return chatId;
  }
  return null;
}

function unregisterGroup(identifier: string): { ok: boolean; error?: string; group?: RegisteredGroup & { chat_id: string } } {
  const chatId = resolveGroupIdentifier(identifier);
  if (!chatId) {
    return { ok: false, error: 'Group not found' };
  }
  const group = registeredGroups[chatId];
  if (!group) {
    return { ok: false, error: 'Group not found' };
  }
  if (group.folder === MAIN_GROUP_FOLDER) {
    return { ok: false, error: 'Cannot remove main group' };
  }

  delete registeredGroups[chatId];
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  delete sessions[group.folder];
  deleteGroupSession(group.folder);
  pauseTasksForGroup(group.folder);

  logger.info({ chatId, name: group.name, folder: group.folder }, 'Group removed');

  return { ok: true, group: { ...group, chat_id: chatId } };
}

// ───────────────────────── Admin Commands ─────────────────────────

function formatGroups(groups: Array<{ chat_id: string; name: string; folder: string; trigger?: string; added_at: string }>): string {
  if (groups.length === 0) return 'No registered groups.';
  const lines = groups.map(group => {
    const trigger = group.trigger ? ` (trigger: ${group.trigger})` : '';
    return `- ${group.name} [${group.folder}] chat=${group.chat_id}${trigger}`;
  });
  return ['Registered groups:', ...lines].join('\n');
}

function applyModelOverride(params: { model: string; scope: 'global' | 'group' | 'user'; targetId?: string }): { ok: boolean; error?: string } {
  const defaultModel = runtime.host.defaultModel;
  const config = loadModelRegistry(defaultModel);
  const nextModel = params.model.trim();
  if (config.allowlist && config.allowlist.length > 0 && !config.allowlist.includes(nextModel)) {
    return { ok: false, error: 'Model not in allowlist' };
  }
  const scope = params.scope || 'global';
  const targetId = params.targetId;
  if (scope === 'user' && !targetId) {
    return { ok: false, error: 'Missing target_id for user scope' };
  }
  if (scope === 'group' && !targetId) {
    return { ok: false, error: 'Missing target_id for group scope' };
  }
  const nextConfig = { ...config };
  if (scope === 'global') {
    nextConfig.model = nextModel;
  } else if (scope === 'group') {
    nextConfig.per_group = nextConfig.per_group || {};
    nextConfig.per_group[targetId!] = { model: nextModel };
  } else if (scope === 'user') {
    nextConfig.per_user = nextConfig.per_user || {};
    nextConfig.per_user[targetId!] = { model: nextModel };
  }
  nextConfig.updated_at = new Date().toISOString();
  saveModelRegistry(nextConfig);
  return { ok: true };
}

async function handleAdminCommand(params: {
  chatId: string;
  senderId: string;
  senderName: string;
  content: string;
  botUsername?: string;
  threadId?: string;
}, sendReply: (chatId: string, text: string, opts?: { threadId?: string }) => Promise<void>): Promise<boolean> {
  const parsed = parseAdminCommand(params.content, params.botUsername);
  if (!parsed) return false;

  const reply = (text: string) => sendReply(params.chatId, text, { threadId: params.threadId });

  const group = registeredGroups[params.chatId];
  if (!group) {
    await reply('This chat is not registered with DotClaw.');
    return true;
  }

  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const command = parsed.command;
  const args = parsed.args;

  const requireMain = (name: string): boolean => {
    if (isMain) return false;
    reply(`${name} is only available in the main group.`).catch(() => undefined);
    return true;
  };

  if (command === 'help') {
    await reply([
      'DotClaw admin commands:',
      '- `/dotclaw help`',
      '- `/dotclaw groups` (main only)',
      '- `/dotclaw add-group <chat_id> <name> [folder]` (main only)',
      '- `/dotclaw remove-group <chat_id|name|folder>` (main only)',
      '- `/dotclaw set-model <model> [global|group|user] [target_id]` (main only)',
      '- `/dotclaw remember <fact>` (main only)',
      '- `/dotclaw skill install <url> [--global]` (main only)',
      '- `/dotclaw skill remove <name> [--global]` (main only)',
      '- `/dotclaw skill list [--global]` (main only)',
      '- `/dotclaw skill update <name> [--global]` (main only)',
      '- `/dotclaw style <concise|balanced|detailed>`',
      '- `/dotclaw tools <conservative|balanced|proactive>`',
      '- `/dotclaw caution <low|balanced|high>`',
      '- `/dotclaw memory <strict|balanced|loose>`'
    ].join('\n'));
    return true;
  }

  if (command === 'groups') {
    if (requireMain('Listing groups')) return true;
    await reply(formatGroups(listRegisteredGroups()));
    return true;
  }

  if (command === 'add-group') {
    if (requireMain('Adding groups')) return true;
    if (args.length < 2) {
      await reply('Usage: /dotclaw add-group <chat_id> <name> [folder]');
      return true;
    }
    const newChatId = args[0];
    const name = args[1];
    const folder = args[2] || name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 50);
    if (!isSafeGroupFolder(folder, GROUPS_DIR)) {
      await reply(`Invalid folder name: "${folder}"`);
      return true;
    }
    if (registeredGroups[newChatId]) {
      await reply(`Chat ${newChatId} is already registered.`);
      return true;
    }
    const newGroup: RegisteredGroup = {
      name,
      folder,
      added_at: new Date().toISOString()
    };
    registerGroup(newChatId, newGroup);
    await reply(`Group "${name}" registered (folder: ${folder}).`);
    return true;
  }

  if (command === 'remove-group') {
    if (requireMain('Removing groups')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw remove-group <chat_id|name|folder>');
      return true;
    }
    const result = unregisterGroup(args[0]);
    if (!result.ok) {
      await reply(`Failed to remove group: ${result.error}`);
      return true;
    }
    await reply(`Group "${result.group!.name}" removed.`);
    return true;
  }

  if (command === 'set-model') {
    if (requireMain('Setting models')) return true;
    if (args.length < 1) {
      await reply('Usage: /dotclaw set-model <model> [global|group|user] [target_id]');
      return true;
    }
    const model = args[0];
    const scopeCandidate = (args[1] || '').toLowerCase();
    const scope = (scopeCandidate === 'global' || scopeCandidate === 'group' || scopeCandidate === 'user')
      ? (scopeCandidate as 'global' | 'group' | 'user')
      : 'global';
    const targetId = args[2] || (scope === 'group' ? group.folder : scope === 'user' ? params.senderId : undefined);
    const result = applyModelOverride({ model, scope, targetId });
    if (!result.ok) {
      await reply(`Failed to set model: ${result.error || 'unknown error'}`);
      return true;
    }
    await reply(`Model set to ${model} (${scope}${targetId ? `:${targetId}` : ''}).`);
    return true;
  }

  if (command === 'remember') {
    if (requireMain('Remembering facts')) return true;
    const fact = args.join(' ').trim();
    if (!fact) {
      await reply('Usage: /dotclaw remember <fact>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'global',
      type: 'fact',
      content: fact,
      importance: 0.7,
      confidence: 0.8,
      tags: ['manual']
    }];
    upsertMemoryItems('global', items, 'admin-command');
    await reply(`Remembered: "${fact}"`);
    return true;
  }

  if (command === 'style') {
    const level = (args[0] || '').toLowerCase();
    const mapping: Record<string, string> = {
      concise: 'Prefers concise, short responses.',
      balanced: 'Prefers balanced-length responses.',
      detailed: 'Prefers detailed, thorough responses.'
    };
    if (!mapping[level]) {
      await reply('Usage: /dotclaw style <concise|balanced|detailed>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'response_style',
      content: mapping[level],
      importance: 0.6,
      confidence: 0.8,
      tags: [`response_style:${level}`]
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    invalidatePersonalizationCache(group.folder, params.senderId);
    await reply(`Response style set to ${level}.`);
    return true;
  }

  if (command === 'tools') {
    const level = (args[0] || '').toLowerCase();
    const mapping: Record<string, string> = {
      conservative: 'Prefers conservative tool usage.',
      balanced: 'Prefers balanced tool usage.',
      proactive: 'Prefers proactive tool usage.'
    };
    if (!mapping[level]) {
      await reply('Usage: /dotclaw tools <conservative|balanced|proactive>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'tool_usage',
      content: mapping[level],
      importance: 0.6,
      confidence: 0.8,
      tags: [`tool_usage:${level}`]
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    invalidatePersonalizationCache(group.folder, params.senderId);
    await reply(`Tool usage set to ${level}.`);
    return true;
  }

  if (command === 'caution') {
    const level = (args[0] || '').toLowerCase();
    const mapping: Record<string, string> = {
      low: 'Prefers low caution.',
      balanced: 'Prefers balanced caution.',
      high: 'Prefers high caution.'
    };
    if (!mapping[level]) {
      await reply('Usage: /dotclaw caution <low|balanced|high>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'caution_level',
      content: mapping[level],
      importance: 0.6,
      confidence: 0.8,
      tags: [`caution_level:${level}`]
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    invalidatePersonalizationCache(group.folder, params.senderId);
    await reply(`Caution level set to ${level}.`);
    return true;
  }

  if (command === 'memory') {
    const level = (args[0] || '').toLowerCase();
    const threshold = level === 'strict' ? 0.7 : level === 'balanced' ? 0.55 : level === 'loose' ? 0.45 : null;
    if (threshold === null) {
      await reply('Usage: /dotclaw memory <strict|balanced|loose>');
      return true;
    }
    const items: MemoryItemInput[] = [{
      scope: 'user',
      subject_id: params.senderId,
      type: 'preference',
      conflict_key: 'memory_importance_threshold',
      content: `Prefers memory strictness ${level}.`,
      importance: 0.6,
      confidence: 0.8,
      tags: [`memory_importance_threshold:${threshold}`],
      metadata: { memory_importance_threshold: threshold, threshold }
    }];
    upsertMemoryItems(group.folder, items, 'admin-command');
    await reply(`Memory strictness set to ${level}.`);
    return true;
  }

  if (command === 'skill-help') {
    await reply([
      'Skill commands:',
      '- `/dotclaw skill install <url> [--global]` — install from git repo or URL',
      '- `/dotclaw skill remove <name> [--global]` — remove a skill',
      '- `/dotclaw skill list [--global]` — list installed skills',
      '- `/dotclaw skill update <name> [--global]` — re-pull from source'
    ].join('\n'));
    return true;
  }

  if (command === 'skill-install') {
    if (requireMain('Installing skills')) return true;
    if (!runtime.agent.skills.installEnabled) {
      await reply('Skill installation is disabled in runtime config (`agent.skills.installEnabled`).');
      return true;
    }
    const isGlobal = args.includes('--global');
    const source = args.filter(a => a !== '--global')[0];
    if (!source) {
      await reply('Usage: /dotclaw skill install <url> [--global]');
      return true;
    }
    const scope = isGlobal ? 'global' as const : 'group' as const;
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    await reply(`Installing skill from ${source}...`);
    const result = await installSkill({ source, targetDir, scope });
    if (!result.ok) {
      await reply(`Failed to install skill: ${result.error}`);
    } else {
      await reply(`Skill "${result.name}" installed (${scope}). Available on next agent run.`);
    }
    return true;
  }

  if (command === 'skill-remove') {
    if (requireMain('Removing skills')) return true;
    const isGlobal = args.includes('--global');
    const name = args.filter(a => a !== '--global')[0];
    if (!name) {
      await reply('Usage: /dotclaw skill remove <name> [--global]');
      return true;
    }
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    const result = removeSkill({ name, targetDir });
    if (!result.ok) {
      await reply(`Failed to remove skill: ${result.error}`);
    } else {
      await reply(`Skill "${name}" removed.`);
    }
    return true;
  }

  if (command === 'skill-list') {
    if (requireMain('Listing skills')) return true;
    const isGlobal = args.includes('--global');
    const scope = isGlobal ? 'global' as const : 'group' as const;
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    const skills = listSkills(targetDir, scope);
    if (skills.length === 0) {
      await reply(`No skills installed (${scope}).`);
    } else {
      const lines = skills.map(s =>
        `- ${s.name} (v${s.version}, source: ${s.source === 'local' ? 'local' : 'remote'})`
      );
      await reply(`Installed skills (${scope}):\n${lines.join('\n')}`);
    }
    return true;
  }

  if (command === 'skill-update') {
    if (requireMain('Updating skills')) return true;
    const isGlobal = args.includes('--global');
    const name = args.filter(a => a !== '--global')[0];
    if (!name) {
      await reply('Usage: /dotclaw skill update <name> [--global]');
      return true;
    }
    const scope = isGlobal ? 'global' as const : 'group' as const;
    const targetDir = path.join(GROUPS_DIR, isGlobal ? 'global' : 'main', 'skills');
    const result = await updateSkill({ name, targetDir, scope });
    if (!result.ok) {
      await reply(`Failed to update skill: ${result.error}`);
    } else {
      await reply(`Skill "${name}" updated.`);
    }
    return true;
  }

  await reply('Unknown command. Use `/dotclaw help` for options.');
  return true;
}

// ───────────────────────── Heartbeat ─────────────────────────

async function runHeartbeatOnce(): Promise<void> {
  const entry = Object.entries(registeredGroups).find(([, group]) => group.folder === HEARTBEAT_GROUP_FOLDER);
  if (!entry) {
    logger.warn({ group: HEARTBEAT_GROUP_FOLDER }, 'Heartbeat group not registered');
    return;
  }
  const [chatId, group] = entry;
  const prompt = [
    '[HEARTBEAT]',
    'You are running automatically. Review scheduled tasks, pending reminders, and long-running work.',
    'If you need to communicate, use mcp__dotclaw__send_message. Otherwise, take no user-visible action.'
  ].join('\n');

  const traceBase = createTraceBase({
    chatId,
    groupFolder: group.folder,
    userId: null,
    inputText: prompt,
    source: 'dotclaw-heartbeat'
  });
  const routingStartedAt = Date.now();
  const routingDecision = routePrompt(prompt);
  recordRoutingDecision(routingDecision.profile);
  const routerMs = Date.now() - routingStartedAt;
  recordStageLatency('router', routerMs, 'scheduler');

  let output: ContainerOutput | null = null;
  let context: AgentContext | null = null;
  let errorMessage: string | null = null;

  const baseRecallResults = Number.isFinite(routingDecision.recallMaxResults)
    ? Math.max(0, Math.floor(routingDecision.recallMaxResults as number))
    : MEMORY_RECALL_MAX_RESULTS;
  const baseRecallTokens = Number.isFinite(routingDecision.recallMaxTokens)
    ? Math.max(0, Math.floor(routingDecision.recallMaxTokens as number))
    : MEMORY_RECALL_MAX_TOKENS;
  const recallMaxResults = routingDecision.enableMemoryRecall ? Math.max(4, baseRecallResults - 2) : 0;
  const recallMaxTokens = routingDecision.enableMemoryRecall ? Math.max(600, baseRecallTokens - 200) : 0;

  try {
    const execution = await executeAgentRun({
      group,
      prompt,
      chatJid: chatId,
      userId: null,
      recallQuery: prompt,
      recallMaxResults,
      recallMaxTokens,
      sessionId: sessions[group.folder],
      onSessionUpdate: (sessionId) => { sessions[group.folder] = sessionId; },
      isScheduledTask: true,
      availableGroups: buildAvailableGroupsSnapshot(),
      modelOverride: routingDecision.modelOverride,
      modelMaxOutputTokens: routingDecision.maxOutputTokens,
      maxToolSteps: routingDecision.maxToolSteps,
      disablePlanner: !routingDecision.enablePlanner,
      disableResponseValidation: !routingDecision.enableResponseValidation,
      responseValidationMaxRetries: routingDecision.responseValidationMaxRetries,
      disableMemoryExtraction: !routingDecision.enableMemoryExtraction,
      profile: routingDecision.profile
    });
    output = execution.output;
    context = execution.context;
    if (output.status === 'error') {
      errorMessage = output.error || 'Unknown error';
    }
  } catch (err) {
    if (err instanceof AgentExecutionError) {
      context = err.context;
      errorMessage = err.message;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
    logger.error({ err }, 'Heartbeat run failed');
  }

  if (context) {
    recordAgentTelemetry({
      traceBase,
      output,
      context,
      toolAuditSource: 'heartbeat',
      errorMessage: errorMessage ?? undefined,
      extraTimings: { router_ms: routerMs }
    });
  } else if (errorMessage) {
    writeTrace({
      trace_id: traceBase.trace_id,
      timestamp: traceBase.timestamp,
      created_at: traceBase.created_at,
      chat_id: traceBase.chat_id,
      group_folder: traceBase.group_folder,
      user_id: traceBase.user_id,
      input_text: traceBase.input_text,
      output_text: null,
      model_id: 'unknown',
      memory_recall: [],
      error_code: errorMessage,
      source: traceBase.source
    });
  }
}

let heartbeatStopped = false;

function stopHeartbeatLoop(): void {
  heartbeatStopped = true;
}

function startHeartbeatLoop(): void {
  if (!HEARTBEAT_ENABLED) return;
  heartbeatStopped = false;
  const loop = async () => {
    if (heartbeatStopped) return;
    try {
      await runHeartbeatOnce();
    } catch (err) {
      logger.error({ err }, 'Heartbeat run failed');
    }
    if (!heartbeatStopped) {
      setTimeout(loop, HEARTBEAT_INTERVAL_MS);
    }
  };
  loop();
}

// ───────────────────────── Provider Event Handlers ─────────────────────────

function createProviderHandlers(
  registry: ProviderRegistry,
  pipeline: ReturnType<typeof createMessagePipeline>
) {
  return {
    onMessage(incoming: IncomingMessage): void {
      const chatId = incoming.chatId;
      const group = registeredGroups[chatId];
      const groupFolder = group?.folder;

      // Log & persist
      const chatName = (incoming.rawProviderData as Record<string, unknown>)?.chatName as string || incoming.senderName;
      try {
        upsertChat({ chatId, name: chatName, lastMessageTime: incoming.timestamp });
        const dbAttachments: MessageAttachment[] | undefined = incoming.attachments?.map(providerAttachmentToMessageAttachment);
        storeMessage(
          incoming.messageId,
          chatId,
          incoming.senderId,
          incoming.senderName,
          incoming.content,
          incoming.timestamp,
          false,
          dbAttachments
        );
      } catch (error) {
        logger.error({ error, chatId }, 'Failed to persist message');
      }

      setLastMessageTime(new Date().toISOString());
      recordMessage(ProviderRegistry.getPrefix(chatId));

      // Admin commands (async, fire-and-forget with early return)
      const providerName = ProviderRegistry.getPrefix(chatId);
      const provider = registry.get(providerName);
      const botUsername = provider && 'botUsername' in provider ? (provider as unknown as { botUsername: string }).botUsername : undefined;

      void (async () => {
        try {
          if (incoming.content) {
            const sendReply = async (cId: string, text: string, opts?: { threadId?: string }) => {
              await registry.getProviderForChat(cId).sendMessage(cId, text, { threadId: opts?.threadId });
            };
            const adminHandled = await handleAdminCommand({
              chatId,
              senderId: incoming.senderId,
              senderName: incoming.senderName,
              content: incoming.content,
              botUsername,
              threadId: incoming.threadId,
            }, sendReply);
            if (adminHandled) return;
          }

          // Check trigger/mention/reply
          const isPrivate = incoming.chatType === 'private' || incoming.chatType === 'dm';
          const isGroup = incoming.isGroup;
          const mentioned = provider ? provider.isBotMentioned(incoming) : false;
          const replied = provider ? provider.isBotReplied(incoming) : false;
          const triggerRegex = isGroup && group?.trigger ? buildTriggerRegex(group.trigger) : null;
          const triggered = Boolean(triggerRegex && incoming.content && triggerRegex.test(incoming.content));
          const shouldProcess = isPrivate || mentioned || replied || triggered;

          if (!shouldProcess) return;

          // Rate limiting — qualify key by provider to avoid cross-provider collisions
          const rateKey = `${ProviderRegistry.getPrefix(chatId)}:${incoming.senderId}`;
          const rateCheck = checkRateLimit(rateKey);
          if (!rateCheck.allowed) {
            const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 60000) / 1000);
            logger.warn({ senderId: incoming.senderId, retryAfterSec }, 'Rate limit exceeded');
            await registry.getProviderForChat(chatId).sendMessage(
              chatId,
              `You're sending messages too quickly. Please wait ${retryAfterSec} seconds and try again.`,
              { threadId: incoming.threadId }
            );
            return;
          }

          // Download attachments
          const attachments: MessageAttachment[] = incoming.attachments?.map(providerAttachmentToMessageAttachment) ?? [];
          if (attachments.length > 0 && groupFolder) {
            let downloadedAny = false;
            const failedAttachments: Array<{ name: string; error: string }> = [];
            for (const attachment of attachments) {
              const fileRef = attachment.provider_file_ref;
              if (!fileRef) continue;
              const filename = attachment.file_name || `${attachment.type}_${incoming.messageId}`;
              const result = await provider!.downloadFile(fileRef, groupFolder, filename);
              if (result.path) {
                attachment.local_path = result.path;
                downloadedAny = true;
              } else if (result.error) {
                failedAttachments.push({ name: attachment.file_name || attachment.type, error: result.error });
              }
            }
            if (failedAttachments.length > 0) {
              const maxMB = Math.floor(provider!.capabilities.maxAttachmentBytes / (1024 * 1024));
              const messages = failedAttachments.map(f =>
                f.error === 'too_large'
                  ? `"${f.name}" is too large (over ${maxMB} MB). Try sending a smaller version.`
                  : `I couldn't download "${f.name}". Please try sending it again.`
              );
              void registry.getProviderForChat(chatId).sendMessage(chatId, messages.join('\n'), { threadId: incoming.threadId });
            }
            // Transcribe voice messages
            for (const attachment of attachments) {
              if (attachment.type === 'voice' && attachment.local_path) {
                try {
                  const transcript = await transcribeVoice(attachment.local_path);
                  if (transcript) {
                    attachment.transcript = transcript;
                  }
                } catch (err) {
                  logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Voice transcription failed');
                }
              }
            }

            if (downloadedAny) {
              try {
                storeMessage(
                  incoming.messageId,
                  chatId,
                  incoming.senderId,
                  incoming.senderName,
                  incoming.content,
                  incoming.timestamp,
                  false,
                  attachments
                );
              } catch (error) {
                logger.error({ error, chatId }, 'Failed to persist downloaded attachment paths');
              }
            }
          }

          void emitHook('message:received', {
            chat_id: chatId,
            message_id: incoming.messageId,
            sender_id: incoming.senderId,
            sender_name: incoming.senderName,
            content: incoming.content.slice(0, 500),
            is_group: isGroup,
            has_attachments: attachments.length > 0,
            has_transcript: attachments.some(a => !!a.transcript)
          });

          pipeline.enqueueMessage({
            chatId,
            messageId: incoming.messageId,
            senderId: incoming.senderId,
            senderName: incoming.senderName,
            content: incoming.content,
            timestamp: incoming.timestamp,
            isGroup,
            chatType: incoming.chatType,
            threadId: incoming.threadId,
            attachments: attachments.length > 0 ? attachments : undefined
          });
        } catch (err) {
          logger.error({ err, chatId }, 'Error processing incoming message');
        }
      })();
    },

    onReaction(chatId: string, messageId: string, userId: string | undefined, emoji: string): void {
      if (emoji !== '👍' && emoji !== '👎') return;
      const traceId = getTraceIdForMessage(messageId, chatId);
      if (!traceId) {
        logger.debug({ chatId, messageId }, 'No trace found for reacted message');
        return;
      }
      const feedbackType = emoji === '👍' ? 'positive' : 'negative';
      recordUserFeedback({
        trace_id: traceId,
        message_id: messageId,
        chat_jid: chatId,
        feedback_type: feedbackType,
        user_id: userId
      });
      logger.info({ chatId, messageId, feedbackType, traceId }, 'User feedback recorded');
    },

    onButtonClick(chatId: string, senderId: string, senderName: string, label: string, data: string, threadId?: string): void {
      const group = registeredGroups[chatId];
      if (!group) return;
      const chatType = 'private'; // Best guess for callback queries
      const isGroup = false;
      const timestamp = new Date().toISOString();
      const syntheticMessageId = String((Date.now() * 1000) + Math.floor(Math.random() * 1000));
      const syntheticContent = `[Button clicked: "${label}"] callback_data: ${data}`;

      upsertChat({ chatId, lastMessageTime: timestamp });
      storeMessage(syntheticMessageId, chatId, senderId, senderName, syntheticContent, timestamp, false);

      pipeline.enqueueMessage({
        chatId,
        messageId: syntheticMessageId,
        senderId,
        senderName,
        content: syntheticContent,
        timestamp,
        isGroup,
        chatType,
        threadId,
      });
    }
  };
}

// ───────────────────────── Wake Recovery ─────────────────────────

let providerRegistry: ProviderRegistry;
let messagePipeline: ReturnType<typeof createMessagePipeline>;

async function onWakeRecovery(sleepDurationMs: number): Promise<void> {
  logger.info({ sleepDurationMs }, 'Running wake recovery');

  // 1. Suppress daemon health check kills for 60s
  suppressHealthChecks(60_000);
  resetUnhealthyDaemons();

  // 2. Reconnect all providers (skip those that were never started)
  for (const provider of providerRegistry.getAllProviders()) {
    if (!provider.isConnected()) {
      logger.debug({ provider: provider.name }, 'Skipping wake reconnect for inactive provider');
      continue;
    }
    try {
      if (provider.name === 'telegram') setTelegramConnected(false);
      await provider.stop();
      await sleep(1_000);
      await provider.start(createProviderHandlers(providerRegistry, messagePipeline));
      if (provider.name === 'telegram') setTelegramConnected(true);
      logger.info({ provider: provider.name }, 'Provider reconnected after wake');
    } catch (err) {
      logger.error({ err, provider: provider.name }, 'Failed to reconnect provider after wake');
    }
  }

  // 3. Reset stalled messages
  try {
    const resetCount = resetStalledMessages(1_000);
    if (resetCount > 0) logger.info({ resetCount }, 'Reset stalled messages after wake');
  } catch (err) {
    logger.error({ err }, 'Failed to reset stalled messages after wake');
  }

  // 4. Reset stalled background jobs
  try {
    const resetJobCount = resetStalledBackgroundJobs();
    if (resetJobCount > 0) logger.info({ count: resetJobCount }, 'Re-queued stalled background jobs after wake');
  } catch (err) {
    logger.error({ err }, 'Failed to reset stalled background jobs after wake');
  }

  // 5. Re-drain pending message queues
  try {
    const pendingChats = getChatsWithPendingMessages();
    const activeDrains = getActiveDrains();
    for (const chatId of pendingChats) {
      if (registeredGroups[chatId] && !activeDrains.has(chatId)) {
        void messagePipeline.drainQueue(chatId);
      }
    }
  } catch (err) {
    logger.error({ err }, 'Failed to resume message drains after wake');
  }
}

// ───────────────────────── Docker Check ─────────────────────────

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }
}

// ───────────────────────── Main ─────────────────────────

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    if (err instanceof RangeError || err instanceof TypeError) {
      logger.error('Fatal uncaught exception — exiting');
      process.exit(1);
    }
  });

  const { ensureDirectoryStructure } = await import('./paths.js');
  ensureDirectoryStructure();

  try {
    const envStat = fs.existsSync(ENV_PATH) ? fs.statSync(ENV_PATH) : null;
    if (!envStat || envStat.size === 0) {
      logger.warn({ envPath: ENV_PATH }, '.env is missing or empty; run "dotclaw configure" to set up provider tokens and API keys');
    }
  } catch (err) {
    logger.warn({ envPath: ENV_PATH, err }, 'Failed to check .env file');
  }

  ensureDockerRunning();
  initDatabase();
  const resetCount = resetStalledMessages();
  if (resetCount > 0) {
    logger.info({ resetCount }, 'Reset stalled queue messages to pending');
  }
  const resetJobCount = resetStalledBackgroundJobs();
  if (resetJobCount > 0) {
    logger.info({ count: resetJobCount }, 'Re-queued running background jobs after restart');
  }
  initMemoryStore();
  startEmbeddingWorker();
  const expiredMemories = cleanupExpiredMemories();
  if (expiredMemories > 0) {
    logger.info({ expiredMemories }, 'Expired memories cleaned up');
  }
  logger.info('Database initialized');
  if (CONTAINER_PRIVILEGED) {
    logger.warn('Container privileged mode is enabled by default; agent containers run as root.');
  }
  startMetricsServer();
  loadState();

  // ──── Provider Registry ────
  providerRegistry = new ProviderRegistry();

  // Register Telegram provider (optional — only when enabled + token present)
  let telegramProvider: ReturnType<typeof createTelegramProvider> | null = null;
  if (runtime.host.telegram.enabled && process.env.TELEGRAM_BOT_TOKEN) {
    telegramProvider = createTelegramProvider(runtime, GROUPS_DIR);
    providerRegistry.register(telegramProvider);
    logger.info('Telegram provider registered');
  } else if (runtime.host.telegram.enabled && !process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn('Telegram is enabled in config but TELEGRAM_BOT_TOKEN is not set — skipping');
  }

  // Register Discord provider (optional — only when enabled + token present)
  let discordProvider: MessagingProvider | null = null;
  if (runtime.host.discord.enabled && process.env.DISCORD_BOT_TOKEN) {
    const { createDiscordProvider } = await import('./providers/discord/index.js');
    discordProvider = createDiscordProvider(runtime);
    providerRegistry.register(discordProvider);
    logger.info('Discord provider registered');
  } else if (runtime.host.discord.enabled && !process.env.DISCORD_BOT_TOKEN) {
    logger.warn('Discord is enabled in config but DISCORD_BOT_TOKEN is not set — skipping');
  }

  // ──── Message Pipeline ────
  messagePipeline = createMessagePipeline({
    registry: providerRegistry,
    registeredGroups: () => registeredGroups,
    sessions: () => sessions,
    setSession: (folder, id) => {
      sessions[folder] = id;
      setGroupSession(folder, id);
    },
    buildAvailableGroupsSnapshot,
  });

  // Warm containers
  if (CONTAINER_MODE === 'daemon' && WARM_START_ENABLED) {
    const groups = Object.values(registeredGroups);
    for (const group of groups) {
      try {
        warmGroupContainer(group, group.folder === MAIN_GROUP_FOLDER);
        logger.info({ group: group.folder }, 'Warmed daemon container');
      } catch (err) {
        logger.warn({ group: group.folder, err }, 'Failed to warm daemon container');
      }
    }
  }

  // Resume pending message queues from before restart
  const pendingChats = getChatsWithPendingMessages();
  for (const chatId of pendingChats) {
    if (registeredGroups[chatId]) {
      logger.info({ chatId }, 'Resuming message queue drain after restart');
      void messagePipeline.drainQueue(chatId);
    }
  }

  // Start dashboard
  startDashboard();

  // ──── Start Providers ────
  const handlers = createProviderHandlers(providerRegistry, messagePipeline);

  try {
    if (telegramProvider) {
      await telegramProvider.start(handlers);
      setTelegramConnected(true);
      logger.info('Telegram bot started');
    }

    if (discordProvider) {
      await discordProvider.start(handlers);
      logger.info('Discord bot started');
    }

    if (!telegramProvider && !discordProvider) {
      throw new Error('No messaging providers configured. Set TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN.');
    }

    // Graceful shutdown
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Graceful shutdown initiated');

      // 1. Stop accepting new work
      setTelegramConnected(false);
      for (const p of providerRegistry.getAllProviders()) {
        try { await p.stop(); } catch { /* ignore */ }
      }

      // 2. Stop all loops and watchers
      clearInterval(rateLimiterInterval);
      stopSchedulerLoop();
      await stopBackgroundJobLoop();
      stopIpcWatcher();
      stopMaintenanceLoop();
      stopHeartbeatLoop();
      stopDaemonHealthCheckLoop();
      stopWakeDetector();
      await stopEmbeddingWorker();

      // 3. Stop HTTP servers
      stopMetricsServer();
      stopDashboard();

      // 4. Abort active agent runs so drain loops can finish quickly
      const activeRuns = getActiveRuns();
      for (const [chatId, controller] of activeRuns.entries()) {
        logger.info({ chatId }, 'Aborting active agent run for shutdown');
        controller.abort();
      }

      // Wait for active drain loops to finish
      const activeDrains = getActiveDrains();
      const drainDeadline = Date.now() + 30_000;
      while (activeDrains.size > 0 && Date.now() < drainDeadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (activeDrains.size > 0) {
        logger.warn({ count: activeDrains.size }, 'Force-closing with active drains');
      }

      // 5. Clean up Docker containers for this instance
      cleanupInstanceContainers();

      // 6. Close databases
      closeWorkflowStore();
      closeMemoryStore();
      closeDatabase();

      logger.info('Shutdown complete');
      process.exit(0);
    };
    process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
    process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

    // ──── Start Services ────
    const sendMessageForScheduler = async (jid: string, text: string): Promise<void> => {
      const result = await providerRegistry.getProviderForChat(jid).sendMessage(jid, text);
      if (!result.success) {
        throw new Error(`Failed to send message to chat ${jid}`);
      }
    };
    startSchedulerLoop({
      sendMessage: sendMessageForScheduler,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSession: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setGroupSession(groupFolder, sessionId);
      }
    });
    startBackgroundJobLoop({
      sendMessage: sendMessageForScheduler,
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      setSession: (groupFolder, sessionId) => {
        sessions[groupFolder] = sessionId;
        setGroupSession(groupFolder, sessionId);
      }
    });
    startIpcWatcher({
      registry: providerRegistry,
      registeredGroups: () => registeredGroups,
      registerGroup,
      unregisterGroup,
      listRegisteredGroups,
      sessions: () => sessions,
      setSession: (folder, id) => {
        sessions[folder] = id;
        setGroupSession(folder, id);
      }
    });
    startMaintenanceLoop();
    startHeartbeatLoop();
    startDaemonHealthCheckLoop(() => registeredGroups, MAIN_GROUP_FOLDER);
    startWakeDetector((ms) => { void onWakeRecovery(ms); });

    logger.info('DotClaw running (responds to DMs and group mentions/replies)');
  } catch (error) {
    logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Failed to start DotClaw');
    process.exit(1);
  }
}

main().catch(err => {
  logger.error({ err }, 'Failed to start DotClaw');
  process.exit(1);
});
