import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get DOTCLAW_HOME from environment or default to ~/.dotclaw
const DOTCLAW_HOME = process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
const CONFIG_DIR = path.join(DOTCLAW_HOME, 'config');
const DATA_DIR = path.join(DOTCLAW_HOME, 'data');
const STORE_DIR = path.join(DATA_DIR, 'store');
const GROUPS_DIR = path.join(DOTCLAW_HOME, 'groups');
const LOGS_DIR = path.join(DOTCLAW_HOME, 'logs');
const TRACES_DIR = path.join(DOTCLAW_HOME, 'traces');
const PROMPTS_DIR = path.join(DOTCLAW_HOME, 'prompts');
const ENV_PATH = path.join(DOTCLAW_HOME, '.env');
const MOUNT_ALLOWLIST_DIR = path.join(os.homedir(), '.config', 'dotclaw');
const MOUNT_ALLOWLIST_PATH = path.join(MOUNT_ALLOWLIST_DIR, 'mount-allowlist.json');

// Package root for copying example configs
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CONFIG_EXAMPLES_DIR = path.join(PACKAGE_ROOT, 'config-examples');

function log(message) {
  console.log(message);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath, contents) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return true;
  }
  return false;
}

function checkDocker() {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    log('Docker: OK');
  } catch {
    log('Docker: NOT RUNNING');
    log('Start Docker Desktop (macOS) or run: sudo systemctl start docker (Linux)');
  }
}

function initFiles() {
  // Create directory structure
  ensureDir(DOTCLAW_HOME);
  ensureDir(CONFIG_DIR);
  ensureDir(DATA_DIR);
  ensureDir(STORE_DIR);
  ensureDir(GROUPS_DIR);
  ensureDir(path.join(GROUPS_DIR, 'main'));
  ensureDir(path.join(GROUPS_DIR, 'main', 'skills'));
  ensureDir(path.join(GROUPS_DIR, 'global'));
  ensureDir(path.join(GROUPS_DIR, 'global', 'skills'));
  ensureDir(LOGS_DIR);
  ensureDir(TRACES_DIR);
  ensureDir(PROMPTS_DIR);
  ensureDir(MOUNT_ALLOWLIST_DIR);

  // Set restrictive permissions
  try {
    fs.chmodSync(DOTCLAW_HOME, 0o700);
    fs.chmodSync(CONFIG_DIR, 0o700);
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {
    // Best-effort; permissions may be controlled by the OS or user policy.
  }

  // Config files
  const registeredGroupsPath = path.join(DATA_DIR, 'registered_groups.json');
  const modelConfigPath = path.join(CONFIG_DIR, 'model.json');
  const behaviorConfigPath = path.join(CONFIG_DIR, 'behavior.json');
  const toolPolicyPath = path.join(CONFIG_DIR, 'tool-policy.json');
  const toolBudgetsPath = path.join(CONFIG_DIR, 'tool-budgets.json');
  const runtimeConfigPath = path.join(CONFIG_DIR, 'runtime.json');

  // Seed CLAUDE.md templates if missing
  const mainClaudePath = path.join(GROUPS_DIR, 'main', 'CLAUDE.md');
  const globalClaudePath = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  const mainClaudeExample = path.join(CONFIG_EXAMPLES_DIR, 'groups', 'main', 'CLAUDE.md');
  const globalClaudeExample = path.join(CONFIG_EXAMPLES_DIR, 'groups', 'global', 'CLAUDE.md');
  if (!fs.existsSync(mainClaudePath) && fs.existsSync(mainClaudeExample)) {
    fs.copyFileSync(mainClaudeExample, mainClaudePath);
  }
  if (!fs.existsSync(globalClaudePath) && fs.existsSync(globalClaudeExample)) {
    fs.copyFileSync(globalClaudeExample, globalClaudePath);
  }

  const createdRegistered = ensureFile(registeredGroupsPath, '{}\n');
  const createdModelConfig = ensureFile(modelConfigPath, JSON.stringify({
    model: 'moonshotai/kimi-k2.5',
    allowlist: [
      'moonshotai/kimi-k2.5',
      'deepseek/deepseek-v3.2',
      'google/gemini-2.5-flash'
    ],
    overrides: {
      'moonshotai/kimi-k2.5': {
        context_window: 32000,
        max_output_tokens: 2048,
        tokens_per_char: 0.6,
        tokens_per_message: 4,
        tokens_per_request: 50
      }
    },
    updated_at: new Date().toISOString()
  }, null, 2) + '\n');
  const createdBehaviorConfig = ensureFile(behaviorConfigPath, JSON.stringify({
    tool_calling_bias: 0.5,
    memory_importance_threshold: 0.55,
    response_style: 'balanced',
    caution_bias: 0.5,
    last_updated: new Date().toISOString()
  }, null, 2) + '\n');
  const toolPolicyExamplePath = path.join(CONFIG_EXAMPLES_DIR, 'tool-policy.json');
  const toolPolicyPayload = fs.existsSync(toolPolicyExamplePath)
    ? fs.readFileSync(toolPolicyExamplePath, 'utf-8')
    : JSON.stringify({ default: {} }, null, 2);
  const createdToolPolicy = ensureFile(
    toolPolicyPath,
    toolPolicyPayload.endsWith('\n') ? toolPolicyPayload : toolPolicyPayload + '\n'
  );

  const toolBudgetsExamplePath = path.join(CONFIG_EXAMPLES_DIR, 'tool-budgets.json');
  const toolBudgetsPayload = fs.existsSync(toolBudgetsExamplePath)
    ? fs.readFileSync(toolBudgetsExamplePath, 'utf-8')
    : JSON.stringify({ default: { per_day: {} } }, null, 2);
  const createdToolBudgets = ensureFile(
    toolBudgetsPath,
    toolBudgetsPayload.endsWith('\n') ? toolBudgetsPayload : toolBudgetsPayload + '\n'
  );

  // Copy runtime config from examples if available
  const runtimeExamplePath = path.join(CONFIG_EXAMPLES_DIR, 'runtime.json');
  const runtimePayload = fs.existsSync(runtimeExamplePath)
    ? fs.readFileSync(runtimeExamplePath, 'utf-8')
    : '{\n  "host": {},\n  "agent": {}\n}\n';
  const createdRuntimeConfig = ensureFile(
    runtimeConfigPath,
    runtimePayload.endsWith('\n') ? runtimePayload : runtimePayload + '\n'
  );

  // Mount allowlist template (kept outside DotClaw home)
  const allowlistTemplate = JSON.stringify({
    allowedRoots: [],
    blockedPatterns: [],
    nonMainReadOnly: true
  }, null, 2) + '\n';
  const createdAllowlist = ensureFile(MOUNT_ALLOWLIST_PATH, allowlistTemplate);
  if (createdAllowlist) {
    try {
      fs.chmodSync(MOUNT_ALLOWLIST_PATH, 0o600);
    } catch {
      // best-effort
    }
  }

  // Environment file
  const envSample = [
    '# DotClaw Secrets',
    '# Set the token for your chosen provider(s).',
    '',
    '# Telegram (get from @BotFather)',
    '# TELEGRAM_BOT_TOKEN=your_bot_token_here',
    '',
    '# Discord (get from Discord Developer Portal)',
    '# DISCORD_BOT_TOKEN=your_discord_bot_token_here',
    '',
    'OPENROUTER_API_KEY=your_openrouter_api_key',
    '',
    '# Optional: Brave Search for web search capability',
    '# BRAVE_SEARCH_API_KEY=your_brave_search_api_key'
  ].join('\n');

  const createdEnv = ensureFile(ENV_PATH, envSample);
  if (createdEnv) {
    try {
      fs.chmodSync(ENV_PATH, 0o600);
    } catch {
      // Best-effort; permissions may be controlled by the OS or user policy.
    }
  }

  log(`DOTCLAW_HOME: ${DOTCLAW_HOME}`);
  log(`registered_groups.json: ${createdRegistered ? 'created' : 'exists'}`);
  log(`model.json: ${createdModelConfig ? 'created' : 'exists'}`);
  log(`behavior.json: ${createdBehaviorConfig ? 'created' : 'exists'}`);
  log(`tool-policy.json: ${createdToolPolicy ? 'created' : 'exists'}`);
  log(`tool-budgets.json: ${createdToolBudgets ? 'created' : 'exists'}`);
  log(`runtime.json: ${createdRuntimeConfig ? 'created' : 'exists'}`);
  log(`.env: ${createdEnv ? 'created (edit this file)' : 'exists'}`);
  log(`mount-allowlist.json: ${createdAllowlist ? 'created (edit to enable mounts)' : 'exists'}`);
}

function printNextSteps() {
  log('\nNext steps:');
  log(`1) Run: dotclaw configure  (or edit ${ENV_PATH})`);
  log(`2) (Optional) Edit ${path.join(CONFIG_DIR, 'runtime.json')} for tuning`);
  log('3) Build the container: dotclaw build');
  log('4) Register your chat: dotclaw register');
  log('5) Start the service: dotclaw start');
}

checkDocker();
initFiles();
printNextSteps();
