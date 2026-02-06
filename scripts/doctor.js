import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

// Get DOTCLAW_HOME from environment or default to ~/.dotclaw
const DOTCLAW_HOME = process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
const CONFIG_DIR = path.join(DOTCLAW_HOME, 'config');
const DATA_DIR = path.join(DOTCLAW_HOME, 'data');
const GROUPS_DIR = path.join(DOTCLAW_HOME, 'groups');
const STORE_DIR = path.join(DATA_DIR, 'store');
const LOGS_DIR = path.join(DOTCLAW_HOME, 'logs');
const TRACES_DIR = path.join(DOTCLAW_HOME, 'traces');
const PROMPTS_DIR = path.join(DOTCLAW_HOME, 'prompts');

function log(label, value) {
  console.log(`${label}: ${value}`);
}

function checkDocker() {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    log('Docker', 'OK');
  } catch {
    log('Docker', 'NOT RUNNING');
  }
}

function checkPathAccess(label, dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    log(label, 'read/write OK');
  } catch (err) {
    log(label, `permission error (${err instanceof Error ? err.message : String(err)})`);
  }
}

function countFiles(dir) {
  try {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function checkSystemd(service) {
  try {
    const output = execSync(`systemctl is-active ${service}`, { stdio: 'pipe' }).toString().trim();
    log(`systemd ${service}`, output);
  } catch {
    log(`systemd ${service}`, 'not available');
  }
}

function diskSpace(dir) {
  try {
    const output = execSync(`df -k "${dir}"`, { stdio: 'pipe' }).toString();
    const lines = output.trim().split('\n');
    const last = lines[lines.length - 1];
    const parts = last.split(/\s+/);
    const availKb = parseInt(parts[3], 10);
    if (Number.isFinite(availKb)) {
      const availGb = (availKb / (1024 * 1024)).toFixed(2);
      return `${availGb} GB available`;
    }
    return 'unknown';
  } catch (err) {
    return `error (${err instanceof Error ? err.message : String(err)})`;
  }
}

function loadRuntimeConfig() {
  const runtimePath = path.join(CONFIG_DIR, 'runtime.json');
  if (!fs.existsSync(runtimePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
  } catch {
    return null;
  }
}

log('Node', process.version);
if (typeof process.getuid === 'function') {
  log('UID', String(process.getuid()));
}
if (typeof process.getgid === 'function') {
  log('GID', String(process.getgid()));
}
checkDocker();
log('DOTCLAW_HOME', DOTCLAW_HOME);
checkPathAccess('config/', CONFIG_DIR);
checkPathAccess('data/', DATA_DIR);
checkPathAccess('groups/', GROUPS_DIR);
checkPathAccess('data/store/', STORE_DIR);
checkPathAccess('logs/', LOGS_DIR);
log('Disk space', diskSpace(DOTCLAW_HOME));

const runtimeConfig = loadRuntimeConfig();
if (runtimeConfig) {
  log('runtime.json', 'present');
  const containerMode = runtimeConfig?.host?.container?.mode;
  if (containerMode) {
    log('Container mode', String(containerMode));
  }
  const maxAgents = runtimeConfig?.host?.concurrency?.maxAgents;
  if (Number.isFinite(maxAgents)) {
    log('Max concurrent agents', String(maxAgents));
  }
  const warmStart = runtimeConfig?.host?.concurrency?.warmStart;
  if (typeof warmStart === 'boolean') {
    log('Warm start', String(warmStart));
  }
  const blockPrivate = runtimeConfig?.agent?.tools?.webfetch?.blockPrivate;
  if (typeof blockPrivate === 'boolean') {
    log('WebFetch block private', String(blockPrivate));
  }
  const traceDir = runtimeConfig?.host?.trace?.dir || TRACES_DIR;
  const promptsDir = runtimeConfig?.host?.promptPacksDir || PROMPTS_DIR;
  log('Trace files', String(countFiles(traceDir)));
  log('Prompt packs', String(countFiles(promptsDir)));
} else {
  log('runtime.json', 'missing');
}

const envPath = path.join(DOTCLAW_HOME, '.env');
log('.env', fs.existsSync(envPath) ? 'present' : 'missing');

if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  // Parse actual values (not just key presence) to distinguish real tokens from commented/placeholder lines
  const envLines = envContent.split('\n');
  const envValues = new Map();
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (value && !value.startsWith('your_')) envValues.set(key, value);
  }

  const hasTelegram = envValues.has('TELEGRAM_BOT_TOKEN');
  const hasDiscord = envValues.has('DISCORD_BOT_TOKEN');
  const hasOpenRouter = envValues.has('OPENROUTER_API_KEY');
  const hasBrave = envValues.has('BRAVE_SEARCH_API_KEY');

  // Provider status from runtime config
  const telegramEnabled = runtimeConfig?.host?.telegram?.enabled !== false;
  const discordEnabled = runtimeConfig?.host?.discord?.enabled === true;

  log('Telegram', `${telegramEnabled ? 'enabled' : 'disabled'} (token: ${hasTelegram ? 'set' : 'missing'})`);
  if (telegramEnabled && !hasTelegram) {
    log('Warning', 'Telegram is enabled but TELEGRAM_BOT_TOKEN is missing');
  }
  log('Discord', `${discordEnabled ? 'enabled' : 'disabled'} (token: ${hasDiscord ? 'set' : 'missing'})`);
  if (discordEnabled && !hasDiscord) {
    log('Warning', 'Discord is enabled but DISCORD_BOT_TOKEN is missing');
  }
  log('OPENROUTER_API_KEY', hasOpenRouter ? 'set' : 'missing');
  log('BRAVE_SEARCH_API_KEY', hasBrave ? 'set (optional, enables WebSearch)' : 'missing');
}

checkSystemd('dotclaw.service');
checkSystemd('autotune.timer');

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  log('Warning', 'Running as root. For best security, run as a non-root user.');
}

const modelConfigPath = path.join(CONFIG_DIR, 'model.json');
if (fs.existsSync(modelConfigPath)) {
  try {
    const modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8'));
    log('Model', modelConfig.model || 'missing');
    log('Model allowlist', Array.isArray(modelConfig.allowlist) && modelConfig.allowlist.length > 0 ? modelConfig.allowlist.join(', ') : 'none (allow all)');
  } catch (err) {
    log('Model config', `error (${err instanceof Error ? err.message : String(err)})`);
  }
} else {
  log('Model config', 'missing');
}

const behaviorConfigPath = path.join(CONFIG_DIR, 'behavior.json');
log('Behavior config', fs.existsSync(behaviorConfigPath) ? behaviorConfigPath : 'missing');

const memoryDbPath = path.join(STORE_DIR, 'memory.db');
log('Memory DB', fs.existsSync(memoryDbPath) ? 'present' : 'missing');
