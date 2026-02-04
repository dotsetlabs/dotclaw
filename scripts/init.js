import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

function log(message) {
  console.log(message);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function ensureFile(filePath, contents) {
  if (!fs.existsSync(filePath)) {
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
  ensureDir(DATA_DIR);
  ensureDir(GROUPS_DIR);
  ensureDir(path.join(GROUPS_DIR, 'main'));
  ensureDir(path.join(GROUPS_DIR, 'global'));

  try {
    fs.chmodSync(DATA_DIR, 0o700);
    fs.chmodSync(GROUPS_DIR, 0o700);
  } catch {
    // Best-effort; permissions may be controlled by the OS or user policy.
  }

  const registeredGroupsPath = path.join(DATA_DIR, 'registered_groups.json');
  const sessionsPath = path.join(DATA_DIR, 'sessions.json');
  const modelConfigPath = path.join(DATA_DIR, 'model.json');
  const homeDir = process.env.HOME || PROJECT_ROOT;
  const dotclawConfigDir = path.join(homeDir, '.config', 'dotclaw');
  const behaviorConfigPath = path.join(dotclawConfigDir, 'behavior.json');
  const toolPolicyPath = path.join(DATA_DIR, 'tool-policy.json');

  const createdRegistered = ensureFile(registeredGroupsPath, '{}\n');
  const createdSessions = ensureFile(sessionsPath, '{}\n');
  const createdModelConfig = ensureFile(modelConfigPath, JSON.stringify({
    model: 'moonshotai/kimi-k2.5',
    allowlist: [],
    updated_at: new Date().toISOString()
  }, null, 2) + '\n');
  fs.mkdirSync(dotclawConfigDir, { recursive: true });
  const createdBehaviorConfig = ensureFile(behaviorConfigPath, JSON.stringify({
    tool_calling_bias: 0.5,
    memory_importance_threshold: 0.55,
    response_style: 'balanced',
    caution_bias: 0.5,
    last_updated: new Date().toISOString()
  }, null, 2) + '\n');
  const createdToolPolicy = ensureFile(toolPolicyPath, JSON.stringify({
    default: {
      allow: [
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'GitClone',
        'NpmInstall',
        'WebSearch',
        'WebFetch',
        'Bash',
        'mcp__dotclaw__send_message',
        'mcp__dotclaw__schedule_task',
        'mcp__dotclaw__list_tasks',
        'mcp__dotclaw__pause_task',
        'mcp__dotclaw__resume_task',
        'mcp__dotclaw__cancel_task',
        'mcp__dotclaw__update_task',
        'mcp__dotclaw__register_group',
        'mcp__dotclaw__remove_group',
        'mcp__dotclaw__list_groups',
        'mcp__dotclaw__set_model',
        'mcp__dotclaw__memory_upsert',
        'mcp__dotclaw__memory_forget',
        'mcp__dotclaw__memory_list',
        'mcp__dotclaw__memory_search',
        'mcp__dotclaw__memory_stats'
      ],
      deny: [],
      max_per_run: {
        Bash: 4,
        WebSearch: 5,
        WebFetch: 6
      },
      default_max_per_run: 32
    }
  }, null, 2) + '\n');

  const envPath = path.join(PROJECT_ROOT, '.env');
  const envSample = [
    '# Telegram bot token from @BotFather',
    'TELEGRAM_BOT_TOKEN=your_bot_token_here',
    '',
    '# OpenRouter authentication',
    'OPENROUTER_API_KEY=your_openrouter_api_key',
    'OPENROUTER_MODEL=moonshotai/kimi-k2.5',
    '# Optional attribution headers (recommended by OpenRouter)',
    'OPENROUTER_SITE_URL=https://your-domain.example',
    'OPENROUTER_SITE_NAME=DotClaw',
    '',
    '# Brave Search API (for WebSearch tool)',
    'BRAVE_SEARCH_API_KEY=your_brave_search_api_key',
    '',
    '# Optional memory tuning (defaults are solid)',
    'DOTCLAW_MAX_CONTEXT_TOKENS=200000',
    'DOTCLAW_RECENT_CONTEXT_TOKENS=80000',
    'DOTCLAW_MAX_OUTPUT_TOKENS=4096',
    'DOTCLAW_SUMMARY_UPDATE_EVERY_MESSAGES=12',
    'DOTCLAW_SUMMARY_MAX_OUTPUT_TOKENS=1200',
    'DOTCLAW_SUMMARY_MODEL=moonshotai/kimi-k2.5',
    '',
    '# Long-term memory v2',
    'DOTCLAW_MEMORY_RECALL_MAX_RESULTS=8',
    'DOTCLAW_MEMORY_RECALL_MAX_TOKENS=1200',
    'DOTCLAW_MEMORY_EXTRACTION_ENABLED=true',
    'DOTCLAW_MEMORY_EXTRACTION_MESSAGES=8',
    'DOTCLAW_MEMORY_EXTRACTION_MAX_OUTPUT_TOKENS=900',
    'DOTCLAW_MEMORY_MODEL=moonshotai/kimi-k2.5',
    'DOTCLAW_MEMORY_EMBEDDINGS_ENABLED=true',
    'DOTCLAW_MEMORY_EMBEDDING_MODEL=openai/text-embedding-3-small',
    'DOTCLAW_MEMORY_EMBEDDING_BATCH_SIZE=8',
    'DOTCLAW_MEMORY_EMBEDDING_INTERVAL_MS=300000',
    '',
    '# Prompt packs (Autotune output)',
    'DOTCLAW_PROMPT_PACKS_ENABLED=true',
    'DOTCLAW_PROMPT_PACKS_DIR=~/.config/dotclaw/prompts',
    'DOTCLAW_PROMPT_PACKS_CANARY_RATE=0.1',
    '',
    '# Tracing (Autotune input)',
    'DOTCLAW_TRACE_DIR=~/.config/dotclaw/traces',
    'DOTCLAW_TRACE_SAMPLE_RATE=1',
    '',
    '# Tool budgets (optional)',
    'DOTCLAW_TOOL_BUDGETS_ENABLED=false',
    'DOTCLAW_TOOL_BUDGETS_PATH=./data/tool-budgets.json',
    '',
    '# Performance + observability',
    'DOTCLAW_CONTAINER_MODE=daemon',
    'DOTCLAW_CONTAINER_DAEMON_POLL_MS=200',
    'CONTAINER_TIMEOUT=900000',
    'CONTAINER_MAX_OUTPUT_SIZE=20971520',
    'DOTCLAW_MAX_CONCURRENT_AGENTS=4',
    'DOTCLAW_WARM_START=true',
    'DOTCLAW_MAX_TOOL_STEPS=32',
    'DOTCLAW_TOOL_OUTPUT_LIMIT_BYTES=1500000',
    'DOTCLAW_WEBFETCH_MAX_BYTES=1500000',
    'DOTCLAW_METRICS_PORT=3001',
    'DOTCLAW_PROGRESS_ENABLED=true',
    'DOTCLAW_PROGRESS_INITIAL_MS=30000',
    'DOTCLAW_PROGRESS_INTERVAL_MS=60000',
    'DOTCLAW_PROGRESS_MAX_UPDATES=3',
    'DOTCLAW_PROGRESS_MESSAGES="Working on it.|Still working.|Almost there."',
    '',
    '# Personalization',
    `DOTCLAW_BEHAVIOR_CONFIG_PATH=${behaviorConfigPath}`,
    'DOTCLAW_PERSONALIZATION_CACHE_MS=300000',
    ''
  ].join('\n');

  const createdEnv = ensureFile(envPath, envSample);
  if (createdEnv) {
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // Best-effort; permissions may be controlled by the OS or user policy.
    }
  }

  log(`registered_groups.json: ${createdRegistered ? 'created' : 'exists'}`);
  log(`sessions.json: ${createdSessions ? 'created' : 'exists'}`);
  log(`model.json: ${createdModelConfig ? 'created' : 'exists'}`);
  log(`behavior.json: ${createdBehaviorConfig ? 'created' : 'exists'} (${behaviorConfigPath})`);
  log(`tool-policy.json: ${createdToolPolicy ? 'created' : 'exists'}`);
  log(`.env: ${createdEnv ? 'created (edit this file)' : 'exists'}`);
}

function printNextSteps() {
  log('\nNext steps:');
  log('1) Edit .env with your Telegram bot token and OpenRouter auth');
  log('2) Build the container: ./container/build.sh');
  log('3) Register your chat in data/registered_groups.json');
  log('4) npm run build && npm start');
}

checkDocker();
initFiles();
printNextSteps();
