import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Rain';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'dotclaw', 'mount-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';
export const MODEL_CONFIG_PATH = path.join(DATA_DIR, 'model.json');

export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'dotclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '300000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const CONTAINER_PIDS_LIMIT = parseInt(process.env.CONTAINER_PIDS_LIMIT || '256', 10);
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '';
export const CONTAINER_CPUS = process.env.CONTAINER_CPUS || '';
export const CONTAINER_READONLY_ROOT = ['1', 'true', 'yes'].includes((process.env.CONTAINER_READONLY_ROOT || '').toLowerCase());
export const CONTAINER_TMPFS_SIZE = process.env.CONTAINER_TMPFS_SIZE || '64m';

const DEFAULT_UID = typeof process.getuid === 'function' ? process.getuid() : undefined;
const DEFAULT_GID = typeof process.getgid === 'function' ? process.getgid() : undefined;
export const CONTAINER_RUN_UID = process.env.CONTAINER_RUN_UID || (DEFAULT_UID !== undefined ? String(DEFAULT_UID) : '');
export const CONTAINER_RUN_GID = process.env.CONTAINER_RUN_GID || (DEFAULT_GID !== undefined ? String(DEFAULT_GID) : '');

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(ASSISTANT_NAME)}\\b`, 'i');

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
