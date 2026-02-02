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
  const routerStatePath = path.join(DATA_DIR, 'router_state.json');
  const modelConfigPath = path.join(DATA_DIR, 'model.json');

  const createdRegistered = ensureFile(registeredGroupsPath, '{}\n');
  const createdSessions = ensureFile(sessionsPath, '{}\n');
  const createdRouter = ensureFile(routerStatePath, '{"last_agent_timestamp":{}}\n');
  const createdModelConfig = ensureFile(modelConfigPath, JSON.stringify({
    model: 'moonshotai/kimi-k2.5',
    allowlist: [],
    updated_at: new Date().toISOString()
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
  log(`router_state.json: ${createdRouter ? 'created' : 'exists'}`);
  log(`model.json: ${createdModelConfig ? 'created' : 'exists'}`);
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
