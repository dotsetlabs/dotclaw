/**
 * Container Runner for DotClaw
 * Spawns agent execution in Docker container and handles IPC
 */

import { spawn, execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import {
  CONTAINER_IMAGE,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_MEMORY,
  CONTAINER_CPUS,
  CONTAINER_READONLY_ROOT,
  CONTAINER_TMPFS_SIZE,
  CONTAINER_RUN_UID,
  CONTAINER_RUN_GID,
  CONTAINER_MODE,
  CONTAINER_DAEMON_POLL_MS,
  GROUPS_DIR,
  DATA_DIR,
  MODEL_CONFIG_PATH,
  PROMPT_PACKS_DIR
} from './config.js';
import { RegisteredGroup } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';
import { loadModelConfig } from './utils.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---DOTCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---DOTCLAW_OUTPUT_END---';
const CONTAINER_ID_DIR = path.join(DATA_DIR, 'tmp');


export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  taskId?: string;
  userId?: string;
  userName?: string;
  memoryRecall?: string[];
  userProfile?: string | null;
  memoryStats?: {
    total: number;
    user: number;
    group: number;
    global: number;
  };
  tokenEstimate?: {
    tokens_per_char: number;
    tokens_per_message: number;
    tokens_per_request: number;
  };
  toolReliability?: Array<{
    name: string;
    success_rate: number;
    count: number;
    avg_duration_ms: number | null;
  }>;
  behaviorConfig?: Record<string, unknown>;
  toolPolicy?: Record<string, unknown>;
  modelOverride?: string;
  modelContextTokens?: number;
  modelMaxOutputTokens?: number;
  modelTemperature?: number;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  model?: string;
  prompt_pack_versions?: Record<string, string>;
  memory_summary?: string;
  memory_facts?: string[];
  tokens_prompt?: number;
  tokens_completion?: number;
  memory_recall_count?: number;
  session_recall_count?: number;
  memory_items_upserted?: number;
  memory_items_extracted?: number;
  tool_calls?: Array<{
    name: string;
    args?: unknown;
    ok: boolean;
    duration_ms?: number;
    error?: string;
    output_bytes?: number;
    output_truncated?: boolean;
  }>;
  latency_ms?: number;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false
    });

    // Mask .env inside the project root to avoid leaking secrets to the container
    const envMaskDir = path.join(DATA_DIR, 'env');
    const envMaskFile = path.join(envMaskDir, '.env-mask');
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
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
    logger.warn({ path: groupIpcDir }, 'Could not chmod IPC directories - run: sudo chown -R $USER data/');
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

  // Environment file directory (keeps credentials out of process listings)
  // Only expose specific auth/config variables needed by the agent, not the entire .env
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  try {
    fs.chmodSync(envDir, 0o700);
  } catch {
    logger.warn({ path: envDir }, 'Could not chmod env directory');
  }
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = [
      'OPENROUTER_API_KEY',
      'OPENROUTER_MODEL',
      'OPENROUTER_SITE_URL',
      'OPENROUTER_SITE_NAME',
      'BRAVE_SEARCH_API_KEY',
      'ASSISTANT_NAME'
    ];
    const allowedPrefixes = ['DOTCLAW_'];
    const filteredLines = envContent
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        if (allowedVars.some(v => trimmed.startsWith(`${v}=`))) return true;
        return allowedPrefixes.some(prefix => trimmed.startsWith(prefix));
      });

    const envLines = new Map<string, string>();
    for (const line of filteredLines) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      envLines.set(key, line);
    }

    const modelConfig = loadModelConfig(
      MODEL_CONFIG_PATH,
      process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5'
    );
    if (modelConfig.model) {
      envLines.set('OPENROUTER_MODEL', `OPENROUTER_MODEL=${modelConfig.model}`);
    }

    if (envLines.size > 0) {
      const mergedLines = Array.from(envLines.values());
      const envOutPath = path.join(envDir, 'env');
      fs.writeFileSync(envOutPath, mergedLines.join('\n') + '\n');
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

  // Security hardening
  args.push('--cap-drop=ALL');
  args.push('--security-opt=no-new-privileges');
  args.push(`--pids-limit=${CONTAINER_PIDS_LIMIT}`);
  if (cidFile) {
    args.push('--cidfile', cidFile);
  }

  const runUid = CONTAINER_RUN_UID ? CONTAINER_RUN_UID.trim() : '';
  const runGid = CONTAINER_RUN_GID ? CONTAINER_RUN_GID.trim() : '';
  if (runUid) {
    args.push('--user', runGid ? `${runUid}:${runGid}` : runUid);
  }
  args.push('--env', 'HOME=/tmp');

  if (CONTAINER_MEMORY) {
    args.push(`--memory=${CONTAINER_MEMORY}`);
  }
  if (CONTAINER_CPUS) {
    args.push(`--cpus=${CONTAINER_CPUS}`);
  }
  if (CONTAINER_READONLY_ROOT) {
    args.push('--read-only');
    const tmpfsOptions = ['rw', 'noexec', 'nosuid', `size=${CONTAINER_TMPFS_SIZE}`];
    if (runUid) tmpfsOptions.push(`uid=${runUid}`);
    if (runGid) tmpfsOptions.push(`gid=${runGid}`);
    args.push('--tmpfs', `/tmp:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/home/node:${tmpfsOptions.join(',')}`);
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

  // Security hardening
  args.push('--cap-drop=ALL');
  args.push('--security-opt=no-new-privileges');
  args.push(`--pids-limit=${CONTAINER_PIDS_LIMIT}`);

  const runUid = CONTAINER_RUN_UID ? CONTAINER_RUN_UID.trim() : '';
  const runGid = CONTAINER_RUN_GID ? CONTAINER_RUN_GID.trim() : '';
  if (runUid) {
    args.push('--user', runGid ? `${runUid}:${runGid}` : runUid);
  }
  args.push('--env', 'HOME=/tmp');
  args.push('--env', 'DOTCLAW_DAEMON=1');
  args.push('--env', `DOTCLAW_DAEMON_POLL_MS=${CONTAINER_DAEMON_POLL_MS}`);

  if (CONTAINER_MEMORY) {
    args.push(`--memory=${CONTAINER_MEMORY}`);
  }
  if (CONTAINER_CPUS) {
    args.push(`--cpus=${CONTAINER_CPUS}`);
  }
  if (CONTAINER_READONLY_ROOT) {
    args.push('--read-only');
    const tmpfsOptions = ['rw', 'noexec', 'nosuid', `size=${CONTAINER_TMPFS_SIZE}`];
    if (runUid) tmpfsOptions.push(`uid=${runUid}`);
    if (runGid) tmpfsOptions.push(`gid=${runGid}`);
    args.push('--tmpfs', `/tmp:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/home/node:${tmpfsOptions.join(',')}`);
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
  return `dotclaw-agent-${groupFolder}`;
}

function isContainerRunning(name: string): boolean {
  try {
    const output = execSync(`docker ps --filter "name=${name}" --format "{{.ID}}"`, { stdio: 'pipe' })
      .toString()
      .trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function ensureDaemonContainer(mounts: VolumeMount[], groupFolder: string): void {
  const containerName = getDaemonContainerName(groupFolder);
  if (isContainerRunning(containerName)) return;

  try {
    execSync(`docker rm -f ${containerName}`, { stdio: 'ignore' });
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
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

async function waitForAgentResponse(responsePath: string, timeoutMs: number): Promise<ContainerOutput> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, 'utf-8');
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
  input: ContainerInput
): Promise<ContainerOutput> {
  if (CONTAINER_MODE === 'daemon') {
    return runContainerAgentDaemon(group, input);
  }

  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  fs.mkdirSync(CONTAINER_ID_DIR, { recursive: true });
  const cidFile = path.join(CONTAINER_ID_DIR, `container-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cid`);
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

    const timeoutMs = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing');
      stopContainer('timeout');
      container.kill('SIGKILL');
      resolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    container.on('close', (code) => {
      clearTimeout(timeout);
      cleanupCid();
      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

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
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

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
      clearTimeout(timeout);
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
  input: ContainerInput
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  ensureDaemonContainer(mounts, group.folder);

  const { responsePath, requestPath } = writeAgentRequest(group.folder, input);
  const timeoutMs = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

  try {
    const output = await waitForAgentResponse(responsePath, timeoutMs);
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
      const containerName = getDaemonContainerName(group.folder);
      spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
    } catch {
      // ignore cleanup failure
    }
    return {
      status: 'error',
      result: null,
      error: errorMessage
    };
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
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
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
  fs.writeFileSync(groupsFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
}
