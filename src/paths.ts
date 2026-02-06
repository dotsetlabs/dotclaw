/**
 * Centralized path definitions for DotClaw.
 *
 * All runtime data is stored in DOTCLAW_HOME (defaults to ~/.dotclaw).
 * This can be overridden via the DOTCLAW_HOME environment variable.
 *
 * Directory structure:
 * ~/.dotclaw/
 * ├── config/           # User configuration files
 * │   ├── runtime.json
 * │   ├── model.json
 * │   ├── behavior.json
 * │   ├── tool-policy.json
 * │   └── tool-budgets.json
 * ├── data/             # Runtime data (databases, sessions, IPC)
 * │   ├── store/
 * │   │   ├── messages.db
 * │   │   └── memory.db
 * │   ├── registered_groups.json
 * │   ├── sessions/
 * │   └── ipc/
 * ├── groups/           # Per-group workspaces
 * │   ├── main/
 * │   └── global/
 * ├── logs/             # Log files
 * ├── traces/           # Trace files for autotune
 * ├── prompts/          # Prompt packs for autotune
 * └── .env              # Environment secrets
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the DotClaw home directory.
 * Defaults to ~/.dotclaw, can be overridden via DOTCLAW_HOME env var.
 */
export function getDotclawHome(): string {
  if (process.env.DOTCLAW_HOME) {
    return path.resolve(process.env.DOTCLAW_HOME);
  }
  return path.join(os.homedir(), '.dotclaw');
}

/**
 * Get the package root directory (where package.json lives).
 * This is used for finding the container build script and other package assets.
 */
export function getPackageRoot(): string {
  // When running from dist/, go up one level
  // When running from src/, also go up one level
  return path.resolve(__dirname, '..');
}

// Base directories
export const DOTCLAW_HOME = getDotclawHome();
export const PACKAGE_ROOT = getPackageRoot();

// Config directory - user configuration files
export const CONFIG_DIR = path.join(DOTCLAW_HOME, 'config');

// Data directory - runtime data (databases, sessions, IPC)
export const DATA_DIR = path.join(DOTCLAW_HOME, 'data');

// Store directory - databases
export const STORE_DIR = path.join(DATA_DIR, 'store');

// Groups directory - per-group workspaces
export const GROUPS_DIR = path.join(DOTCLAW_HOME, 'groups');

// Logs directory
export const LOGS_DIR = path.join(DOTCLAW_HOME, 'logs');

// Traces directory (for autotune)
export const TRACES_DIR = path.join(DOTCLAW_HOME, 'traces');

// Prompts directory (for prompt packs)
export const PROMPTS_DIR = path.join(DOTCLAW_HOME, 'prompts');

// Environment file
export const ENV_PATH = path.join(DOTCLAW_HOME, '.env');

// Config files
export const RUNTIME_CONFIG_PATH = path.join(CONFIG_DIR, 'runtime.json');
export const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
export const BEHAVIOR_CONFIG_PATH = path.join(CONFIG_DIR, 'behavior.json');
export const TOOL_POLICY_PATH = path.join(CONFIG_DIR, 'tool-policy.json');
export const TOOL_BUDGETS_PATH = path.join(CONFIG_DIR, 'tool-budgets.json');

// Data files
export const REGISTERED_GROUPS_PATH = path.join(DATA_DIR, 'registered_groups.json');
export const MESSAGES_DB_PATH = path.join(STORE_DIR, 'messages.db');
export const MEMORY_DB_PATH = path.join(STORE_DIR, 'memory.db');

// IPC directory
export const IPC_DIR = path.join(DATA_DIR, 'ipc');

// Sessions directory
export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// Mount security: allowlist stored in a separate location for extra security
export const MOUNT_ALLOWLIST_PATH = path.join(os.homedir(), '.config', 'dotclaw', 'mount-allowlist.json');

// Container assets (from package)
export const CONTAINER_DIR = path.join(PACKAGE_ROOT, 'container');
export const CONTAINER_BUILD_SCRIPT = path.join(CONTAINER_DIR, 'build.sh');

// Scripts directory (from package)
export const SCRIPTS_DIR = path.join(PACKAGE_ROOT, 'scripts');

// Config examples (from package)
export const CONFIG_EXAMPLES_DIR = path.join(PACKAGE_ROOT, 'config-examples');

/**
 * Ensure the DotClaw home directory structure exists.
 * Creates all necessary directories with appropriate permissions.
 */
export function ensureDirectoryStructure(): void {
  const dirs = [
    DOTCLAW_HOME,
    CONFIG_DIR,
    DATA_DIR,
    STORE_DIR,
    GROUPS_DIR,
    path.join(GROUPS_DIR, 'main'),
    path.join(GROUPS_DIR, 'main', 'skills'),
    path.join(GROUPS_DIR, 'global'),
    path.join(GROUPS_DIR, 'global', 'skills'),
    LOGS_DIR,
    TRACES_DIR,
    PROMPTS_DIR,
    IPC_DIR,
    SESSIONS_DIR,
    // Mount allowlist parent directory (~/.config/dotclaw)
    path.dirname(MOUNT_ALLOWLIST_PATH),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Set restrictive permissions on sensitive directories
  try {
    fs.chmodSync(DOTCLAW_HOME, 0o700);
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.chmodSync(DATA_DIR, 0o700);
    // Also restrict the config directory for mount allowlist
    fs.chmodSync(path.dirname(MOUNT_ALLOWLIST_PATH), 0o700);
  } catch {
    // Best-effort; permissions may be controlled by the OS or user policy
  }
}

/**
 * Get the path for a group's workspace directory.
 */
export function getGroupDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder);
}

/**
 * Get the path for a group's IPC directory.
 */
export function getGroupIpcDir(groupFolder: string): string {
  return path.join(IPC_DIR, groupFolder);
}

/**
 * Get the path for a group's session directory.
 */
export function getGroupSessionDir(groupFolder: string): string {
  return path.join(SESSIONS_DIR, groupFolder);
}
