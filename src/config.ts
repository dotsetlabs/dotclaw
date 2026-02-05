import { loadRuntimeConfig } from './runtime-config.js';
import {
  CONFIG_DIR,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  LOGS_DIR,
  TRACES_DIR,
  PROMPTS_DIR,
  MODEL_CONFIG_PATH,
  MOUNT_ALLOWLIST_PATH,
  ENV_PATH,
} from './paths.js';

const runtime = loadRuntimeConfig();

// Re-export paths for backwards compatibility
export {
  CONFIG_DIR,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  LOGS_DIR,
  MOUNT_ALLOWLIST_PATH,
  ENV_PATH,
};

export const ASSISTANT_NAME = runtime.agent.assistantName;
export const SCHEDULER_POLL_INTERVAL = runtime.host.scheduler.pollIntervalMs;

export const MAIN_GROUP_FOLDER = 'main';
export { MODEL_CONFIG_PATH };

// Use runtime config values with fallback to paths module defaults
export const PROMPT_PACKS_DIR = runtime.host.promptPacksDir || PROMPTS_DIR;
export const TRACE_DIR = runtime.host.trace.dir || TRACES_DIR;
export const TRACE_SAMPLE_RATE = runtime.host.trace.sampleRate;

export const CONTAINER_IMAGE = runtime.host.container.image;
export const CONTAINER_TIMEOUT = runtime.host.container.timeoutMs;
export const CONTAINER_MAX_OUTPUT_SIZE = runtime.host.container.maxOutputBytes;
export const IPC_POLL_INTERVAL = runtime.host.ipc.pollIntervalMs;
export const CONTAINER_MODE = runtime.host.container.mode;
export const CONTAINER_PRIVILEGED = runtime.host.container.privileged;
export const CONTAINER_DAEMON_POLL_MS = runtime.host.container.daemonPollMs;
export const CONTAINER_PIDS_LIMIT = runtime.host.container.pidsLimit;
export const CONTAINER_MEMORY = runtime.host.container.memory;
export const CONTAINER_CPUS = runtime.host.container.cpus;
export const CONTAINER_READONLY_ROOT = runtime.host.container.readOnlyRoot;
export const CONTAINER_TMPFS_SIZE = runtime.host.container.tmpfsSize;

export const CONTAINER_RUN_UID = runtime.host.container.runUid;
export const CONTAINER_RUN_GID = runtime.host.container.runGid;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = runtime.host.timezone;

export const MAX_CONCURRENT_AGENTS = runtime.host.concurrency.maxAgents;
export const AGENT_QUEUE_TIMEOUT_MS = runtime.host.concurrency.queueTimeoutMs;
export const WARM_START_ENABLED = runtime.host.concurrency.warmStart;
export const TRACE_RETENTION_DAYS = runtime.host.trace.retentionDays;
export const MAINTENANCE_INTERVAL_MS = runtime.host.maintenance.intervalMs;
export const BATCH_WINDOW_MS = runtime.host.messageQueue.batchWindowMs;
export const MAX_BATCH_SIZE = runtime.host.messageQueue.maxBatchSize ?? 50;
export const STALLED_TIMEOUT_MS = runtime.host.messageQueue.stalledTimeoutMs ?? 300_000;
export const JOB_RETENTION_MS = runtime.host.backgroundJobs.jobRetentionMs ?? 604_800_000;
export const TASK_LOG_RETENTION_MS = runtime.host.backgroundJobs.taskLogRetentionMs ?? 2_592_000_000;
