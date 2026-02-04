import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import readline from 'readline';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const REGISTERED_GROUPS = path.join(DATA_DIR, 'registered_groups.json');

function runScript(scriptName) {
  const result = spawnSync('node', [scriptName], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function loadJson(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return fallback;
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function isSafeFolder(folder) {
  return /^[a-z0-9-]+$/.test(folder);
}

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return new Map();
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const map = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    map.set(key, value);
  }
  return map;
}

function filterEnv(envMap) {
  const allowedVars = new Set([
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'OPENROUTER_SITE_URL',
    'OPENROUTER_SITE_NAME',
    'BRAVE_SEARCH_API_KEY',
    'ASSISTANT_NAME',
    'CONTAINER_IMAGE',
    'CONTAINER_PIDS_LIMIT',
    'CONTAINER_MEMORY',
    'CONTAINER_CPUS',
    'CONTAINER_READONLY_ROOT',
    'CONTAINER_TMPFS_SIZE',
    'CONTAINER_RUN_UID',
    'CONTAINER_RUN_GID'
  ]);

  const filtered = new Map();
  for (const [key, value] of envMap.entries()) {
    if (allowedVars.has(key) || key.startsWith('DOTCLAW_')) {
      filtered.set(key, value);
    }
  }
  return filtered;
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).toLowerCase().trim();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function runSelfCheck({
  image,
  envVars,
  groupFolder
}) {
  const uid = envVars.get('CONTAINER_RUN_UID') || (typeof process.getuid === 'function' ? String(process.getuid()) : '');
  const gid = envVars.get('CONTAINER_RUN_GID') || (typeof process.getgid === 'function' ? String(process.getgid()) : '');
  const pidsLimit = envVars.get('CONTAINER_PIDS_LIMIT') || '256';
  const memory = envVars.get('CONTAINER_MEMORY') || '';
  const cpus = envVars.get('CONTAINER_CPUS') || '';
  const readOnlyRoot = parseBool(envVars.get('CONTAINER_READONLY_ROOT'), false);
  const tmpfsSize = envVars.get('CONTAINER_TMPFS_SIZE') || '64m';

  const groupDir = path.join(PROJECT_ROOT, 'groups', groupFolder);
  const sessionDir = path.join(DATA_DIR, 'sessions', groupFolder, 'openrouter');
  const ipcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(messagesDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const args = ['run', '-i', '--rm'];
  args.push('--cap-drop=ALL');
  args.push('--security-opt=no-new-privileges');
  args.push(`--pids-limit=${pidsLimit}`);
  if (uid) {
    args.push('--user', gid ? `${uid}:${gid}` : uid);
  }
  args.push('--env', 'HOME=/tmp');
  if (memory) args.push(`--memory=${memory}`);
  if (cpus) args.push(`--cpus=${cpus}`);
  if (readOnlyRoot) {
    const tmpfsOptions = ['rw', 'noexec', 'nosuid', `size=${tmpfsSize}`];
    if (uid) tmpfsOptions.push(`uid=${uid}`);
    if (gid) tmpfsOptions.push(`gid=${gid}`);
    args.push('--read-only');
    args.push('--tmpfs', `/tmp:${tmpfsOptions.join(',')}`);
    args.push('--tmpfs', `/home/node:${tmpfsOptions.join(',')}`);
  }

  args.push('-v', `${groupDir}:/workspace/group`);
  args.push('-v', `${sessionDir}:/workspace/session`);
  args.push('-v', `${ipcDir}:/workspace/ipc`);

  for (const [key, value] of envVars.entries()) {
    if (!value) continue;
    args.push('--env', `${key}=${value}`);
  }
  args.push('--env', 'DOTCLAW_SELF_CHECK=1');

  args.push(image);

  const input = JSON.stringify({
    prompt: 'self-check',
    groupFolder,
    chatJid: 'self-check',
    isMain: true
  });

  const result = spawnSync('docker', args, {
    input,
    encoding: 'utf-8'
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const startMarker = '---DOTCLAW_OUTPUT_START---';
  const endMarker = '---DOTCLAW_OUTPUT_END---';
  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    console.log('Self-check output could not be parsed.');
    if (stderr.trim()) console.log(stderr.trim());
    if (stdout.trim()) console.log(stdout.trim());
    return false;
  }

  const jsonText = stdout.slice(startIdx + startMarker.length, endIdx).trim();
  try {
    const payload = JSON.parse(jsonText);
    if (payload.status !== 'success') {
      console.log('Self-check reported error:', payload.error || 'unknown');
      if (stderr.trim()) console.log(stderr.trim());
      return false;
    }
    console.log(payload.result || 'Self-check passed.');
    return true;
  } catch (err) {
    console.log('Self-check output parse error:', err instanceof Error ? err.message : String(err));
    if (stderr.trim()) console.log(stderr.trim());
    return false;
  }
}

async function prompt(question, defaultValue = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `, answer => {
      rl.close();
      const value = answer.trim();
      resolve(value || defaultValue);
    });
  });
}

function parseBoolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).toLowerCase().trim();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  console.log('DotClaw bootstrap starting...\n');

  runScript('scripts/init.js');

  const nonInteractive = parseBoolEnv(process.env.DOTCLAW_BOOTSTRAP_NONINTERACTIVE, false);
  if (nonInteractive) {
    process.env.DOTCLAW_CONFIGURE_NONINTERACTIVE = '1';
  }
  runScript('scripts/configure.js');

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('Warning: You are running bootstrap as root. For best security, run as a non-root user.');
  }

  try {
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    fs.accessSync(path.join(PROJECT_ROOT, 'groups'), fs.constants.W_OK);
  } catch {
    console.log('Warning: data/ or groups/ is not writable by the current user.');
    console.log('If you encounter permission errors, run: sudo chown -R $USER data/ groups/');
  }

  console.log('\nNow register your main chat.');
  console.log('If you do not know your Telegram chat ID, use @userinfobot or @get_id_bot in Telegram.\n');

  let chatId = '';
  let name = 'main';
  let folder = 'main';

  if (nonInteractive) {
    chatId = requireEnv('DOTCLAW_BOOTSTRAP_CHAT_ID');
    name = process.env.DOTCLAW_BOOTSTRAP_GROUP_NAME || 'main';
    folder = process.env.DOTCLAW_BOOTSTRAP_GROUP_FOLDER || 'main';
    if (!isSafeFolder(folder)) {
      console.error('DOTCLAW_BOOTSTRAP_GROUP_FOLDER must be lowercase letters, numbers, and hyphens only.');
      process.exit(1);
    }
  } else {
    chatId = await prompt('Telegram chat ID');
    if (!chatId) {
      console.error('Chat ID is required to register the main group.');
      process.exit(1);
    }
    name = await prompt('Group name', 'main');
    folder = await prompt('Folder name (lowercase, hyphens)', 'main');
    while (!isSafeFolder(folder)) {
      console.log('Folder name must be lowercase letters, numbers, and hyphens only.');
      folder = await prompt('Folder name (lowercase, hyphens)', 'main');
    }
  }
  const groups = loadJson(REGISTERED_GROUPS, {});
  groups[String(chatId)] = {
    name,
    folder,
    added_at: new Date().toISOString()
  };
  saveJson(REGISTERED_GROUPS, groups);

  console.log('\nMain group registered.');
  let buildNow = 'yes';
  if (nonInteractive) {
    buildNow = parseBoolEnv(process.env.DOTCLAW_BOOTSTRAP_BUILD, true) ? 'yes' : 'no';
  } else {
    buildNow = await prompt('Build the container now? (yes/no)', 'yes');
  }
  if (buildNow.toLowerCase().startsWith('y')) {
    const result = spawnSync('./container/build.sh', { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      console.log('Container build failed. You can retry with: ./container/build.sh');
    }
  } else {
    console.log('Skipped container build.');
  }

  const envMap = parseEnv(path.join(PROJECT_ROOT, '.env'));
  const filteredEnv = filterEnv(envMap);
  if (!filteredEnv.get('OPENROUTER_MODEL')) {
    const modelConfig = loadJson(path.join(DATA_DIR, 'model.json'), {});
    if (modelConfig && typeof modelConfig.model === 'string') {
      filteredEnv.set('OPENROUTER_MODEL', modelConfig.model);
    }
  }
  const image = filteredEnv.get('CONTAINER_IMAGE') || 'dotclaw-agent:latest';
  if (!filteredEnv.get('OPENROUTER_API_KEY')) {
    console.log('Self-check skipped: OPENROUTER_API_KEY is not set in .env.');
  } else {
    let runCheck = 'yes';
    if (nonInteractive) {
      runCheck = parseBoolEnv(process.env.DOTCLAW_BOOTSTRAP_SELF_CHECK, true) ? 'yes' : 'no';
    } else {
      runCheck = await prompt('Run container self-check now? (yes/no)', 'yes');
    }
    if (runCheck.toLowerCase().startsWith('y')) {
      const ok = runSelfCheck({
        image,
        envVars: filteredEnv,
        groupFolder: folder
      });
      if (!ok) {
        console.log('Self-check failed. Fix issues before starting the app.');
        process.exit(1);
      }
    } else {
      console.log('Skipped self-check.');
    }
  }

  console.log('\nNext: start the app.');
  console.log('  npm run build && npm start');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
