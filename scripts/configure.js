import fs from 'fs';
import path from 'path';
import readline from 'readline';

const PROJECT_ROOT = process.cwd();
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const MODEL_CONFIG_PATH = path.join(DATA_DIR, 'model.json');

function parseEnv(content) {
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

function updateEnvContent(existing, updates) {
  const lines = existing.split('\n');
  const keys = new Set(Object.keys(updates));
  const output = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx).trim();
    if (!keys.has(key)) return line;
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    const exists = lines.some(line => line.trim().startsWith(`${key}=`));
    if (!exists) {
      output.push(`${key}=${value}`);
    }
  }

  return output.join('\n').replace(/\n+$/, '\n');
}

function mask(value) {
  if (!value) return 'missing';
  if (value.length <= 8) return 'set';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

async function promptForValue(rl, label, currentValue, optional = false) {
  const suffix = optional ? ' (optional)' : '';
  const prompt = `${label}${suffix} [current: ${mask(currentValue)}]: `;
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      const value = answer.trim();
      if (!value) {
        resolve(currentValue || '');
        return;
      }
      resolve(value);
    });
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  const envMap = parseEnv(envContent);

  const nonInteractive = ['1', 'true', 'yes'].includes((process.env.DOTCLAW_CONFIGURE_NONINTERACTIVE || process.env.DOTCLAW_BOOTSTRAP_NONINTERACTIVE || '').toLowerCase());

  let modelConfig = {
    model: 'moonshotai/kimi-k2.5',
    allowlist: [],
    updated_at: new Date().toISOString()
  };
  if (fs.existsSync(MODEL_CONFIG_PATH)) {
    try {
      modelConfig = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8'));
    } catch {
      // keep defaults
    }
  }

  let telegramToken = envMap.get('TELEGRAM_BOT_TOKEN') || '';
  let openrouterKey = envMap.get('OPENROUTER_API_KEY') || '';
  let openrouterModel = envMap.get('OPENROUTER_MODEL') || modelConfig.model;
  let openrouterSiteUrl = envMap.get('OPENROUTER_SITE_URL') || '';
  let openrouterSiteName = envMap.get('OPENROUTER_SITE_NAME') || '';
  let braveKey = envMap.get('BRAVE_SEARCH_API_KEY') || '';
  let allowlistInput = '';

  if (nonInteractive) {
    telegramToken = process.env.TELEGRAM_BOT_TOKEN || telegramToken;
    openrouterKey = process.env.OPENROUTER_API_KEY || openrouterKey;
    openrouterModel = process.env.OPENROUTER_MODEL || openrouterModel;
    openrouterSiteUrl = process.env.OPENROUTER_SITE_URL || openrouterSiteUrl;
    openrouterSiteName = process.env.OPENROUTER_SITE_NAME || openrouterSiteName;
    braveKey = process.env.BRAVE_SEARCH_API_KEY || braveKey;
    allowlistInput = process.env.DOTCLAW_MODEL_ALLOWLIST || '';

    if (!telegramToken) {
      console.error('TELEGRAM_BOT_TOKEN is required for non-interactive configuration.');
      process.exit(1);
    }
    if (!openrouterKey) {
      console.error('OPENROUTER_API_KEY is required for non-interactive configuration.');
      process.exit(1);
    }
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    telegramToken = await promptForValue(rl, 'TELEGRAM_BOT_TOKEN', telegramToken);
    openrouterKey = await promptForValue(rl, 'OPENROUTER_API_KEY', openrouterKey);
    openrouterModel = await promptForValue(rl, 'OPENROUTER_MODEL', openrouterModel);
    openrouterSiteUrl = await promptForValue(rl, 'OPENROUTER_SITE_URL', openrouterSiteUrl, true);
    openrouterSiteName = await promptForValue(rl, 'OPENROUTER_SITE_NAME', openrouterSiteName, true);
    braveKey = await promptForValue(rl, 'BRAVE_SEARCH_API_KEY', braveKey, true);

    allowlistInput = await new Promise(resolve => {
      rl.question('Model allowlist (comma-separated, blank = allow all): ', answer => {
        resolve(answer.trim());
      });
    });

    rl.close();
  }

  const updates = {
    TELEGRAM_BOT_TOKEN: telegramToken,
    OPENROUTER_API_KEY: openrouterKey,
    OPENROUTER_MODEL: openrouterModel
  };
  if (openrouterSiteUrl) updates.OPENROUTER_SITE_URL = openrouterSiteUrl;
  if (openrouterSiteName) updates.OPENROUTER_SITE_NAME = openrouterSiteName;
  if (braveKey) updates.BRAVE_SEARCH_API_KEY = braveKey;

  const nextEnv = updateEnvContent(envContent || '', updates);
  fs.writeFileSync(ENV_PATH, nextEnv);
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    // best-effort
  }

  const allowlist = allowlistInput
    ? allowlistInput.split(',').map(item => item.trim()).filter(Boolean)
    : (Array.isArray(modelConfig.allowlist) ? modelConfig.allowlist : []);

  const nextModelConfig = {
    ...modelConfig,
    model: openrouterModel,
    allowlist,
    updated_at: new Date().toISOString()
  };

  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(nextModelConfig, null, 2) + '\n');

  console.log('Configuration updated.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
