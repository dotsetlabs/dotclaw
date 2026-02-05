/**
 * Container Runner for DotClaw
 * Spawns agent execution in Docker container and handles IPC
 */

import { spawn, execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_MEMORY,
  CONTAINER_CPUS,
  CONTAINER_PRIVILEGED,
  CONTAINER_READONLY_ROOT,
  CONTAINER_TMPFS_SIZE,
  CONTAINER_RUN_UID,
  CONTAINER_RUN_GID,
  CONTAINER_MODE,
  CONTAINER_DAEMON_POLL_MS,
  GROUPS_DIR,
  CONFIG_DIR,
  DATA_DIR,
  ENV_PATH,
  PROMPT_PACKS_DIR
} from './config.js';
import { PACKAGE_ROOT } from './paths.js';
import { RegisteredGroup } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { generateId } from './id.js';
import { OUTPUT_START_MARKER, OUTPUT_END_MARKER } from './container-protocol.js';
import type { ContainerInput, ContainerOutput } from './container-protocol.js';
import { logger } from './logger.js';

const runtime = loadRuntimeConfig();
const CONTAINER_INSTANCE_ID_RAW = runtime.host.container.instanceId || '';
const CONTAINER_INSTANCE_ID = CONTAINER_INSTANCE_ID_RAW.trim()
  ? CONTAINER_INSTANCE_ID_RAW.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  : '';

// Sentinel markers for robust output parsing (must match agent-runner)
const CONTAINER_ID_DIR = path.join(DATA_DIR, 'tmp');

const SAFE_FOLDER_RE = /^[a-zA-Z0-9_-]+$/;
function sanitizeGroupFolder(folder: string): string {
  if (!SAFE_FOLDER_RE.test(folder)) {
    throw new Error(`Invalid group folder name: ${folder}`);
  }
  return folder;
}


interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const envFile = ENV_PATH;

  if (isMain) {
    // Main gets the package root mounted (read-only for safety)
    mounts.push({
      hostPath: PACKAGE_ROOT,
      containerPath: '/workspace/project',
      readonly: true
    });

    // Mask .env inside the package root to avoid leaking secrets to the container
    const packageEnvFile = path.join(PACKAGE_ROOT, '.env');
    if (fs.existsSync(packageEnvFile)) {
      const envMaskDir = path.join(DATA_DIR, 'env');
      const envMaskFile = path.join(envMaskDir, '.env-mask');
      fs.mkdirSync(envMaskDir, { recursive: true });
      if (!fs.existsSync(envMaskFile)) {
        fs.writeFileSync(envMaskFile, '');
      }
      mounts.push({
        hostPath: envMaskFile,
        containerPath: '/workspace/project/.env',
        readonly: true
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    // Global memory/prompts directory (read-only)
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false
    });

    // Global memory directory (read-only for non-main)
    // Docker bind mounts work with both files and directories
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true
      });
    }
  }

  // Per-group OpenRouter sessions directory (isolated from other groups)
  // Each group gets their own session store to prevent cross-group access
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', group.folder, 'openrouter');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  try {
    fs.chmodSync(groupSessionsDir, 0o700);
  } catch {
    logger.warn({ path: groupSessionsDir }, 'Could not chmod sessions directory');
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/workspace/session',
    readonly: false
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
  const messagesDir = path.join(groupIpcDir, 'messages');
  const tasksDir = path.join(groupIpcDir, 'tasks');
  const requestsDir = path.join(groupIpcDir, 'requests');
  const responsesDir = path.join(groupIpcDir, 'responses');
  const agentRequestsDir = path.join(groupIpcDir, 'agent_requests');
  const agentResponsesDir = path.join(groupIpcDir, 'agent_responses');
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.mkdirSync(agentRequestsDir, { recursive: true });
  fs.mkdirSync(agentResponsesDir, { recursive: true });
  // Ensure container user can write to IPC directories on Linux
  // On macOS/Docker Desktop this is handled by file sharing, but on native Linux
  // the container user needs explicit write permission to the mounted volume
  // Use try/catch in case directories are owned by a different user (e.g., root)
  try {
    fs.chmodSync(groupIpcDir, 0o770);
    fs.chmodSync(messagesDir, 0o770);
    fs.chmodSync(tasksDir, 0o770);
    fs.chmodSync(requestsDir, 0o770);
    fs.chmodSync(responsesDir, 0o770);
    fs.chmodSync(agentRequestsDir, 0o770);
    fs.chmodSync(agentResponsesDir, 0o770);
  } catch {
    // Permissions may already be correct, or user needs to fix ownership manually
    logger.warn({ path: groupIpcDir, dataDir: DATA_DIR }, 'Could not chmod IPC directories - run: sudo chown -R $USER ~/.dotclaw/data/ipc');
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false
  });

  // Shared prompt packs directory (autotune output)
  if (PROMPT_PACKS_DIR && fs.existsSync(PROMPT_PACKS_DIR)) {
    mounts.push({
      hostPath: PROMPT_PACKS_DIR,
      containerPath: '/workspace/prompts',
      readonly: true
    });
  }

  // Config directory (read-only) - contains runtime.json and other config files
  if (fs.existsSync(CONFIG_DIR)) {
    mounts.push({
      hostPath: CONFIG_DIR,
      containerPath: '/workspace/config',
      readonly: true
    });
  }

  // Data directory (read-only) - contains databases, sessions, etc.
  // Note: do NOT mount the full data directory into containers.
  // This prevents cross-group leakage of sessions, IPC, and databases.

  // Environment file directory (keeps credentials out of process listings)
  // Inject only secrets from .env
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  try {
    fs.chmodSync(envDir, 0o700);
  } catch {
    logger.warn({ path: envDir }, 'Could not chmod env directory');
  }

  const envVars = new Map<string, string>();
  const setEnvVar = (key: string, value: string, source: string) => {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      logger.warn({ key, source }, 'Skipping invalid env var name for container');
      return;
    }
    if (value.includes('\n')) {
      logger.warn({ key, source }, 'Skipping env var with newline for container');
      return;
    }
    envVars.set(key, value);
  };

  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const secretVars = new Set([
      'OPENROUTER_API_KEY',
      'BRAVE_SEARCH_API_KEY'
    ]);
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      if (!secretVars.has(key)) continue;
      const value = trimmed.slice(idx + 1);
      setEnvVar(key, value, 'dotenv');
    }
  }

  if (group.containerConfig?.env) {
    for (const [key, value] of Object.entries(group.containerConfig.env)) {
      if (typeof value !== 'string') continue;
      setEnvVar(key, value, 'containerConfig');
    }
  }


  if (envVars.size > 0) {
    const mergedLines = Array.from(envVars.entries()).map(([key, value]) => `${key}=${value}`);
    const envOutPath = path.join(envDir, 'env');
    const tmpEnvPath = envOutPath + '.tmp';
    fs.writeFileSync(tmpEnvPath, mergedLines.join('\n') + '\n');
    fs.renameSync(tmpEnvPath, envOutPath);
    try {
      fs.chmodSync(envOutPath, 0o600);
    } catch {
      logger.warn({ path: envOutPath }, 'Could not chmod env file');
    }
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], cidFile?: string): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  // Privileged mode is intentionally default for full agent command capability.
  if (CONTAINER_PRIVILEGED) {
    args.push('--privileged');
  } else {
    args.push('--cap-drop=ALL');
    args.push('--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--cap-add=SETUID', '--cap-add=SETGID');
  }
  args.push(`--pids-limit=${CONTAINER_PIDS_LIMIT}`);
  if (cidFile) {
    args.push('--cidfile', cidFile);
  }

  const runUid = CONTAINER_RUN_UID ? CONTAINER_RUN_UID.trim() : '';
  const runGid = CONTAINER_RUN_GID ? CONTAINER_RUN_GID.trim() : '';
  if (CONTAINER_PRIVILEGED) {
    args.push('--user', '0:0');
  } else if (runUid) {
    args.push('--user', runGid ? `${runUid}:${runGid}` : runUid);
  }
  args.push('--env', CONTAINER_PRIVILEGED ? 'HOME=/root' : 'HOME=/tmp');

  if (CONTAINER_MEMORY) {
    args.push(`--memory=${CONTAINER_MEMORY}`);
  }
  if (CONTAINER_CPUS) {
    args.push(`--cpus=${CONTAINER_CPUS}`);
  }
  if (CONTAINER_READONLY_ROOT) {
    args.push('--read-only');
    const tmpfsOptions = ['rw', 'nosuid', `size=${CONTAINER_TMPFS_SIZE}`];
    if (runUid) tmpfsOptions.push(`uid=${runUid}`);
    if (runGid) tmpfsOptions.push(`gid=${runGid}`);
    args.push('--tmpfs', `/tmp:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/home/node:${tmpfsOptions.join(',')}`);
    // Writable overlays for package management (apt-get / dpkg)
    args.push('--tmpfs', `/var/lib/dpkg:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/cache/apt:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/lib/apt:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/log:${tmpfsOptions.join(',')}`);
  }

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

function buildDaemonArgs(mounts: VolumeMount[], containerName: string, groupFolder: string): string[] {
  const args: string[] = ['run', '-d', '--rm', '--name', containerName, '--label', `dotclaw.group=${groupFolder}`];
  if (CONTAINER_INSTANCE_ID) {
    args.push('--label', `dotclaw.instance=${CONTAINER_INSTANCE_ID}`);
  }

  // Privileged mode is intentionally default for full agent command capability.
  if (CONTAINER_PRIVILEGED) {
    args.push('--privileged');
  } else {
    args.push('--cap-drop=ALL');
    args.push('--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--cap-add=SETUID', '--cap-add=SETGID');
  }
  args.push(`--pids-limit=${CONTAINER_PIDS_LIMIT}`);

  const runUid = CONTAINER_RUN_UID ? CONTAINER_RUN_UID.trim() : '';
  const runGid = CONTAINER_RUN_GID ? CONTAINER_RUN_GID.trim() : '';
  if (CONTAINER_PRIVILEGED) {
    args.push('--user', '0:0');
  } else if (runUid) {
    args.push('--user', runGid ? `${runUid}:${runGid}` : runUid);
  }
  args.push('--env', CONTAINER_PRIVILEGED ? 'HOME=/root' : 'HOME=/tmp');
  args.push('--env', 'DOTCLAW_DAEMON=1');

  if (CONTAINER_MEMORY) {
    args.push(`--memory=${CONTAINER_MEMORY}`);
  }
  if (CONTAINER_CPUS) {
    args.push(`--cpus=${CONTAINER_CPUS}`);
  }
  if (CONTAINER_READONLY_ROOT) {
    args.push('--read-only');
    const tmpfsOptions = ['rw', 'nosuid', `size=${CONTAINER_TMPFS_SIZE}`];
    if (runUid) tmpfsOptions.push(`uid=${runUid}`);
    if (runGid) tmpfsOptions.push(`gid=${runGid}`);
    args.push('--tmpfs', `/tmp:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/home/node:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/lib/dpkg:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/cache/apt:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/lib/apt:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/var/log:${tmpfsOptions.join(',')}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);
  return args;
}

function getDaemonContainerName(groupFolder: string): string {
  const instance = CONTAINER_INSTANCE_ID ? `-${CONTAINER_INSTANCE_ID}` : '';
  return `dotclaw-agent${instance}-${groupFolder}`;
}

function isContainerRunning(name: string): boolean {
  try {
    const output = execSync(`docker ps --filter "name=^${name}$" --format "{{.Names}}"`, { stdio: 'pipe', timeout: 15_000 })
      .toString()
      .trim();
    if (!output) return false;
    return output.split('\n').some(n => n.trim() === name);
  } catch {
    return false;
  }
}

const daemonConfig = runtime.host.container.daemon;

type DaemonHealthState = 'healthy' | 'busy' | 'dead';

interface DaemonStatus {
  state: 'idle' | 'processing';
  ts: number;
  request_id: string | null;
  started_at: number | null;
  pid: number;
}

interface DaemonHealthResult {
  state: DaemonHealthState;
  lastHeartbeat?: number;
  ageMs?: number;
  daemonState?: string;
  processingMs?: number;
}

function readDaemonStatus(groupFolder: string): DaemonStatus | null {
  const statusPath = path.join(DATA_DIR, 'ipc', groupFolder, 'daemon_status.json');
  try {
    if (!fs.existsSync(statusPath)) return null;
    const raw = fs.readFileSync(statusPath, 'utf-8').trim();
    return JSON.parse(raw) as DaemonStatus;
  } catch {
    return null;
  }
}

/**
 * 3-state health check: healthy / busy / dead
 *
 * - Fresh heartbeat → healthy (regardless of state)
 * - Stale heartbeat + processing state → busy (tolerated up to container timeout)
 * - Stale heartbeat + idle/missing state → dead
 */
export function checkDaemonHealth(groupFolder: string): DaemonHealthResult {
  const heartbeatPath = path.join(DATA_DIR, 'ipc', groupFolder, 'heartbeat');
  try {
    if (!fs.existsSync(heartbeatPath)) {
      return { state: 'dead' };
    }
    const content = fs.readFileSync(heartbeatPath, 'utf-8').trim();
    const lastHeartbeat = parseInt(content, 10);
    if (!Number.isFinite(lastHeartbeat)) {
      return { state: 'dead' };
    }
    const ageMs = Date.now() - lastHeartbeat;

    // Fresh heartbeat → healthy
    if (ageMs < daemonConfig.heartbeatMaxAgeMs) {
      return { state: 'healthy', lastHeartbeat, ageMs };
    }

    // Stale heartbeat — check daemon_status.json for processing state
    const status = readDaemonStatus(groupFolder);

    if (status && status.state === 'processing' && status.started_at) {
      const processingMs = Date.now() - status.started_at;
      return {
        state: 'busy',
        lastHeartbeat,
        ageMs,
        daemonState: 'processing',
        processingMs,
      };
    }

    // Stale heartbeat + idle or no status file → dead
    return { state: 'dead', lastHeartbeat, ageMs, daemonState: status?.state };
  } catch {
    return { state: 'dead' };
  }
}

/**
 * Graceful restart: docker stop (SIGTERM + grace period), then docker rm -f fallback
 */
export function gracefulRestartDaemonContainer(group: RegisteredGroup, isMain: boolean): void {
  const containerName = getDaemonContainerName(group.folder);
  const graceSeconds = Math.ceil(daemonConfig.gracePeriodMs / 1000);

  try {
    execSync(`docker stop -t ${graceSeconds} ${containerName}`, { stdio: 'ignore', timeout: (daemonConfig.gracePeriodMs + 5000) });
  } catch {
    // docker stop failed or timed out — force remove
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: 'ignore', timeout: 15_000 });
    } catch {
      // ignore
    }
  }

  // Start new container
  const mounts = buildVolumeMounts(group, isMain);
  ensureDaemonContainer(mounts, group.folder);
  logger.info({ groupFolder: group.folder }, 'Daemon container restarted (graceful)');
}

/**
 * Force restart (kept for programmatic use where graceful isn't needed)
 */
export function restartDaemonContainer(group: RegisteredGroup, isMain: boolean): void {
  const containerName = getDaemonContainerName(group.folder);

  try {
    execSync(`docker rm -f ${containerName}`, { stdio: 'ignore', timeout: 15_000 });
  } catch {
    // Ignore if container doesn't exist
  }

  const mounts = buildVolumeMounts(group, isMain);
  ensureDaemonContainer(mounts, group.folder);
  logger.info({ groupFolder: group.folder }, 'Daemon container restarted (force)');
}

// Track daemon health check state
let healthCheckInterval: NodeJS.Timeout | null = null;
const unhealthyDaemons = new Map<string, number>(); // Track consecutive dead checks

/**
 * Perform health check on all daemon containers and restart if needed.
 * Uses 3-state model: healthy resets counter, busy is tolerated up to
 * container timeout, dead increments failure counter.
 */
export function performDaemonHealthChecks(
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
  mainGroupFolder: string
): void {
  if (CONTAINER_MODE !== 'daemon') return;

  const groups = getRegisteredGroups();

  for (const [, group] of Object.entries(groups)) {
    const containerName = getDaemonContainerName(group.folder);

    // Skip if container isn't running (may be intentionally stopped)
    if (!isContainerRunning(containerName)) {
      unhealthyDaemons.delete(group.folder);
      continue;
    }

    const health = checkDaemonHealth(group.folder);

    if (health.state === 'healthy') {
      unhealthyDaemons.delete(group.folder);
    } else if (health.state === 'busy') {
      // Tolerate busy daemons up to container timeout
      if (health.processingMs && health.processingMs > CONTAINER_TIMEOUT) {
        logger.warn({
          groupFolder: group.folder,
          processingMs: health.processingMs,
          containerTimeout: CONTAINER_TIMEOUT
        }, 'Daemon processing exceeded container timeout, restarting');
        gracefulRestartDaemonContainer(group, group.folder === mainGroupFolder);
        unhealthyDaemons.delete(group.folder);
      } else {
        // Still within timeout — reset failure counter, don't restart
        unhealthyDaemons.delete(group.folder);
        logger.debug({
          groupFolder: group.folder,
          processingMs: health.processingMs
        }, 'Daemon busy but within timeout');
      }
    } else {
      // dead
      const consecutiveFailures = (unhealthyDaemons.get(group.folder) || 0) + 1;
      unhealthyDaemons.set(group.folder, consecutiveFailures);

      logger.warn({
        groupFolder: group.folder,
        consecutiveFailures,
        ageMs: health.ageMs,
        daemonState: health.daemonState
      }, 'Daemon container appears dead');

      // Restart after 2 consecutive dead checks
      if (consecutiveFailures >= 2) {
        logger.info({ groupFolder: group.folder }, 'Restarting dead daemon');
        gracefulRestartDaemonContainer(group, group.folder === mainGroupFolder);
        unhealthyDaemons.delete(group.folder);
      }
    }
  }
}

/**
 * Start the daemon health check loop
 */
export function startDaemonHealthCheckLoop(
  getRegisteredGroups: () => Record<string, RegisteredGroup>,
  mainGroupFolder: string
): void {
  if (CONTAINER_MODE !== 'daemon') return;
  if (healthCheckInterval) return;

  healthCheckInterval = setInterval(() => {
    performDaemonHealthChecks(getRegisteredGroups, mainGroupFolder);
  }, daemonConfig.healthCheckIntervalMs);

  logger.info({ intervalMs: daemonConfig.healthCheckIntervalMs }, 'Daemon health check loop started');
}

/**
 * Stop the daemon health check loop
 */
export function stopDaemonHealthCheckLoop(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

function ensureDaemonContainer(mounts: VolumeMount[], groupFolder: string): void {
  const containerName = getDaemonContainerName(groupFolder);
  if (isContainerRunning(containerName)) return;

  try {
    execSync(`docker rm -f ${containerName}`, { stdio: 'ignore', timeout: 15_000 });
  } catch {
    // ignore if container doesn't exist
  }

  const args = buildDaemonArgs(mounts, containerName, groupFolder);
  const result = spawnSync('docker', args, { stdio: 'ignore' });
  if (result.status !== 0) {
    logger.error({ groupFolder, status: result.status }, 'Failed to start daemon container');
    throw new Error(`Failed to start daemon container for ${groupFolder}`);
  }
}

export function warmGroupContainer(group: RegisteredGroup, isMain: boolean): void {
  if (CONTAINER_MODE !== 'daemon') return;
  const mounts = buildVolumeMounts(group, isMain);
  ensureDaemonContainer(mounts, group.folder);
}

function writeAgentRequest(groupFolder: string, payload: object): { id: string; requestPath: string; responsePath: string } {
  const id = generateId('agent');
  const requestsDir = path.join(DATA_DIR, 'ipc', groupFolder, 'agent_requests');
  const responsesDir = path.join(DATA_DIR, 'ipc', groupFolder, 'agent_responses');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.mkdirSync(responsesDir, { recursive: true });
  const requestPath = path.join(requestsDir, `${id}.json`);
  const responsePath = path.join(responsesDir, `${id}.json`);
  const tempPath = `${requestPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({ id, input: payload }, null, 2));
  fs.renameSync(tempPath, requestPath);
  return { id, requestPath, responsePath };
}

async function waitForAgentResponse(
  responsePath: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<ContainerOutput> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (abortSignal?.aborted) {
      throw new Error('Agent run preempted');
    }
    if (fs.existsSync(responsePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(responsePath, 'utf-8');
      } catch (readErr: unknown) {
        const code = (readErr as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // File disappeared between existsSync and readFileSync; continue polling
          await new Promise(resolve => setTimeout(resolve, CONTAINER_DAEMON_POLL_MS));
          continue;
        }
        throw readErr;
      }
      fs.unlinkSync(responsePath);
      try {
        return JSON.parse(raw) as ContainerOutput;
      } catch (err) {
        throw new Error(`Failed to parse daemon response: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, CONTAINER_DAEMON_POLL_MS));
  }
  throw new Error(`Daemon response timeout after ${timeoutMs}ms`);
}

function readContainerId(cidFile: string): string | null {
  try {
    const id = fs.readFileSync(cidFile, 'utf-8').trim();
    return id ? id : null;
  } catch {
    return null;
  }
}

function removeContainerById(containerId: string, reason: string): void {
  if (!containerId) return;
  logger.warn({ containerId, reason }, 'Removing container');
  spawn('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number }
): Promise<ContainerOutput> {
  sanitizeGroupFolder(group.folder);

  if (CONTAINER_MODE === 'daemon') {
    return runContainerAgentDaemon(group, input, options);
  }

  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  fs.mkdirSync(CONTAINER_ID_DIR, { recursive: true });
  const cidFile = path.join(CONTAINER_ID_DIR, `${generateId('container')}.cid`);
  try {
    fs.rmSync(cidFile, { force: true });
  } catch {
    // ignore cleanup failure
  }
  const containerArgs = buildContainerArgs(mounts, cidFile);

  logger.debug({
    group: group.name,
    mounts: mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`),
    containerArgs: containerArgs.join(' ')
  }, 'Container mount configuration');

  logger.info({
    group: group.name,
    mountCount: mounts.length,
    isMain: input.isMain
  }, 'Spawning container agent');

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('docker', containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let resolved = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
        logger.warn({ group: group.name, size: stdout.length }, 'Container stdout truncated due to size limit');
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn({ group: group.name, size: stderr.length }, 'Container stderr truncated due to size limit');
      } else {
        stderr += chunk;
      }
    });

    const cleanupCid = () => {
      try {
        fs.rmSync(cidFile, { force: true });
      } catch {
        // ignore cleanup failure
      }
    };

    const stopContainer = (reason: string) => {
      const containerId = readContainerId(cidFile);
      if (containerId) {
        removeContainerById(containerId, reason);
      }
    };

    const timeoutMs = options?.timeoutMs || group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      stopContainer('timeout');
      container.kill('SIGKILL');
      if (resolved) return;
      resolved = true;
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    const abortSignal = options?.abortSignal;
    const abortHandler = () => {
      if (resolved) return;
      resolved = true;
      logger.warn({ group: group.name }, 'Container run preempted');
      stopContainer('preempted');
      container.kill('SIGKILL');
      clearTimeout(timeout);
      cleanupCid();
      resolve({
        status: 'error',
        result: null,
        error: 'Container run preempted'
      });
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        abortHandler();
      } else {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    container.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      cleanupCid();
      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = runtime.host.logLevel === 'debug' || runtime.host.logLevel === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``
      ];

      if (isVerbose) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts.map(m => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts.map(m => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'),
          ``
        );

        if (code !== 0) {
          logLines.push(
            `=== Stderr (last 500 chars) ===`,
            stderr.slice(-500),
            ``
          );
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error({
          group: group.name,
          code,
          duration,
          stderr: stderr.slice(-500),
          logFile
        }, 'Container exited with error');

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`
        });
        return;
      }

      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.lastIndexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        let output: ContainerOutput;
        try {
          output = JSON.parse(jsonLine) as ContainerOutput;
        } catch (parseErr) {
          throw new Error(`Invalid JSON in container output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
        }
        if (!output || typeof output.status !== 'string') {
          throw new Error('Container output missing required "status" field');
        }

        logger.info({
          group: group.name,
          duration,
          status: output.status,
          hasResult: !!output.result
        }, 'Container completed');

        resolve(output);
      } catch (err) {
        logger.error({
          group: group.name,
          stdout: stdout.slice(-500),
          error: err
        }, 'Failed to parse container output');

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    });

    container.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', abortHandler);
      }
      cleanupCid();
      logger.error({ group: group.name, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`
      });
    });
  });
}

async function runContainerAgentDaemon(
  group: RegisteredGroup,
  input: ContainerInput,
  options?: { abortSignal?: AbortSignal; timeoutMs?: number }
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  ensureDaemonContainer(mounts, group.folder);

  const { id: requestId, responsePath, requestPath } = writeAgentRequest(group.folder, input);
  const requestsDir = path.join(DATA_DIR, 'ipc', group.folder, 'agent_requests');
  const timeoutMs = options?.timeoutMs || group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const abortSignal = options?.abortSignal;

  const abortHandler = () => {
    logger.warn({ group: group.name }, 'Daemon run preempted');
    // Write cancel sentinel so daemon can detect the abort
    const cancelPath = path.join(requestsDir, `${requestId}.cancel`);
    try { fs.writeFileSync(cancelPath, ''); } catch { /* ignore */ }
    try {
      if (fs.existsSync(requestPath)) fs.unlinkSync(requestPath);
    } catch {
      // ignore cleanup failure
    }
    try {
      if (fs.existsSync(responsePath)) fs.unlinkSync(responsePath);
    } catch {
      // ignore cleanup failure
    }
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      abortHandler();
      return {
        status: 'error',
        result: null,
        error: 'Daemon run preempted'
      };
    }
    abortSignal.addEventListener('abort', abortHandler, { once: true });
  }

  try {
    const output = await waitForAgentResponse(responsePath, timeoutMs, abortSignal);
    return {
      ...output,
      latency_ms: output.latency_ms ?? (Date.now() - startTime)
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, error: errorMessage }, 'Daemon agent error');
    try {
      if (fs.existsSync(requestPath)) fs.unlinkSync(requestPath);
    } catch {
      // ignore cleanup failure
    }
    try {
      if (fs.existsSync(responsePath)) fs.unlinkSync(responsePath);
    } catch {
      // ignore cleanup failure
    }
    return {
      status: 'error',
      result: null,
      error: errorMessage
    };
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', abortHandler);
    }
  }
}

/**
 * Stop all Docker containers belonging to this instance.
 * Uses Docker labels to identify containers.
 */
export function cleanupInstanceContainers(): void {
  try {
    let filterArgs: string;
    if (CONTAINER_INSTANCE_ID) {
      filterArgs = `--filter "label=dotclaw.instance=${CONTAINER_INSTANCE_ID}"`;
    } else {
      filterArgs = '--filter "label=dotclaw.group"';
    }

    const ids = execSync(`docker ps -q ${filterArgs}`, { encoding: 'utf-8', stdio: 'pipe', timeout: 15_000 }).trim();
    if (!ids) return;

    const containerIds = ids.split('\n').filter(Boolean);

    // For the default instance (no CONTAINER_INSTANCE_ID), exclude containers that have a dotclaw.instance label
    let toRemove = containerIds;
    if (!CONTAINER_INSTANCE_ID && containerIds.length > 0) {
      toRemove = containerIds.filter(id => {
        try {
          const label = execSync(`docker inspect --format '{{index .Config.Labels "dotclaw.instance"}}' ${id}`, {
            encoding: 'utf-8', stdio: 'pipe', timeout: 15_000
          }).trim();
          return !label;
        } catch {
          return true;
        }
      });
    }

    if (toRemove.length > 0) {
      const graceSeconds = Math.ceil(daemonConfig.gracePeriodMs / 1000);
      try {
        execSync(`docker stop -t ${graceSeconds} ${toRemove.join(' ')}`, {
          stdio: 'ignore',
          timeout: (daemonConfig.gracePeriodMs + 5000)
        });
      } catch {
        // Graceful stop failed or timed out — force remove
        execSync(`docker rm -f ${toRemove.join(' ')}`, { stdio: 'ignore', timeout: 15_000 });
      }
      logger.info({ count: toRemove.length }, 'Cleaned up instance containers');
    }
  } catch {
    // Docker may not be running or no containers to clean up
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
    state_json?: string | null;
    retry_count?: number | null;
    last_error?: string | null;
  }>
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter(t => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  const tasksTmpFile = tasksFile + '.tmp';
  fs.writeFileSync(tasksTmpFile, JSON.stringify(filteredTasks, null, 2));
  fs.renameSync(tasksTmpFile, tasksFile);
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[]
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  const groupsTmpFile = groupsFile + '.tmp';
  fs.writeFileSync(groupsTmpFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
  fs.renameSync(groupsTmpFile, groupsFile);
}
