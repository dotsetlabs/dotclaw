import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

// Get DOTCLAW_HOME from environment or default to ~/.dotclaw
const DOTCLAW_HOME = process.env.DOTCLAW_HOME || path.join(os.homedir(), '.dotclaw');
const CONFIG_DIR = path.join(DOTCLAW_HOME, 'config');
const DATA_DIR = path.join(DOTCLAW_HOME, 'data');
const ENV_PATH = path.join(DOTCLAW_HOME, '.env');
const MODEL_CONFIG_PATH = path.join(CONFIG_DIR, 'model.json');
const RUNTIME_CONFIG_PATH = path.join(CONFIG_DIR, 'runtime.json');
const REGISTERED_GROUPS_PATH = path.join(DATA_DIR, 'registered_groups.json');

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

function loadRuntimeConfig() {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveRuntimeConfig(config) {
  fs.mkdirSync(path.dirname(RUNTIME_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

async function main() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf-8') : '';
  const envMap = parseEnv(envContent);
  const runtimeConfig = loadRuntimeConfig();

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

  const runtimeAgent = runtimeConfig.agent || {};
  const runtimeOpenrouter = runtimeAgent.openrouter || {};
  const runtimeHost = runtimeConfig.host || {};

  let telegramToken = envMap.get('TELEGRAM_BOT_TOKEN') || '';
  let discordToken = envMap.get('DISCORD_BOT_TOKEN') || '';
  let openrouterKey = envMap.get('OPENROUTER_API_KEY') || '';
  let openrouterModel = modelConfig.model;
  let openrouterSiteUrl = runtimeOpenrouter.siteUrl || '';
  let openrouterSiteName = runtimeOpenrouter.siteName || '';
  let braveKey = envMap.get('BRAVE_SEARCH_API_KEY') || '';
  let allowlistInput = '';
  let telegramEnabled = runtimeHost.telegram?.enabled !== false;
  let discordEnabled = runtimeHost.discord?.enabled === true;

  if (nonInteractive) {
    telegramToken = process.env.TELEGRAM_BOT_TOKEN || telegramToken;
    discordToken = process.env.DISCORD_BOT_TOKEN || discordToken;
    openrouterKey = process.env.OPENROUTER_API_KEY || openrouterKey;
    braveKey = process.env.BRAVE_SEARCH_API_KEY || braveKey;

    // Auto-detect provider from tokens
    const hasTelegram = !!telegramToken;
    const hasDiscord = !!discordToken;
    if (!hasTelegram && !hasDiscord) {
      console.error('At least one provider token is required (TELEGRAM_BOT_TOKEN or DISCORD_BOT_TOKEN).');
      process.exit(1);
    }
    telegramEnabled = hasTelegram;
    discordEnabled = hasDiscord;

    if (!openrouterKey) {
      console.error('OPENROUTER_API_KEY is required for non-interactive configuration.');
      process.exit(1);
    }
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Determine current default for provider selection
    let currentDefault = '1';
    if (telegramEnabled && discordEnabled) currentDefault = '3';
    else if (discordEnabled) currentDefault = '2';

    const providerChoice = await new Promise(resolve => {
      console.log('\nWhich messaging provider(s) will you use?');
      console.log('  1. Telegram');
      console.log('  2. Discord');
      console.log('  3. Both');
      rl.question(`Choice [${currentDefault}]: `, answer => {
        resolve(answer.trim() || currentDefault);
      });
    });

    telegramEnabled = providerChoice === '1' || providerChoice === '3';
    discordEnabled = providerChoice === '2' || providerChoice === '3';

    if (telegramEnabled) {
      telegramToken = await promptForValue(rl, 'TELEGRAM_BOT_TOKEN', telegramToken);
    }
    if (discordEnabled) {
      discordToken = await promptForValue(rl, 'DISCORD_BOT_TOKEN', discordToken);
    }
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

  const updates = {};
  if (telegramEnabled && telegramToken) updates.TELEGRAM_BOT_TOKEN = telegramToken;
  if (discordEnabled && discordToken) updates.DISCORD_BOT_TOKEN = discordToken;
  updates.OPENROUTER_API_KEY = openrouterKey;
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

  const nextRuntimeConfig = { ...runtimeConfig };
  if (!nextRuntimeConfig.agent) nextRuntimeConfig.agent = {};
  if (!nextRuntimeConfig.agent.openrouter) nextRuntimeConfig.agent.openrouter = {};
  nextRuntimeConfig.agent.openrouter.siteUrl = openrouterSiteUrl || '';
  nextRuntimeConfig.agent.openrouter.siteName = openrouterSiteName || '';

  if (!nextRuntimeConfig.host) nextRuntimeConfig.host = {};

  // Provider enabled flags
  if (!nextRuntimeConfig.host.telegram) nextRuntimeConfig.host.telegram = {};
  nextRuntimeConfig.host.telegram.enabled = telegramEnabled;
  if (!nextRuntimeConfig.host.discord) nextRuntimeConfig.host.discord = {};
  nextRuntimeConfig.host.discord.enabled = discordEnabled;

  if (!nextRuntimeConfig.host.memory) nextRuntimeConfig.host.memory = {};
  if (!nextRuntimeConfig.host.memory.embeddings) nextRuntimeConfig.host.memory.embeddings = {};
  nextRuntimeConfig.host.memory.embeddings.openrouterSiteUrl = openrouterSiteUrl || '';
  nextRuntimeConfig.host.memory.embeddings.openrouterSiteName = openrouterSiteName || '';

  saveRuntimeConfig(nextRuntimeConfig);

  // ── Migrate registered groups when providers change ──
  const enabledProviders = new Set();
  if (telegramEnabled) enabledProviders.add('telegram');
  if (discordEnabled) enabledProviders.add('discord');

  const groups = loadJson(REGISTERED_GROUPS_PATH, {});
  const staleEntries = Object.entries(groups).filter(([chatId]) => {
    const prefix = chatId.split(':')[0];
    return !enabledProviders.has(prefix);
  });

  if (staleEntries.length > 0) {
    // Determine what provider to migrate to
    const targetProvider = discordEnabled ? 'discord' : 'telegram';

    for (const [oldChatId, groupData] of staleEntries) {
      const oldPrefix = oldChatId.split(':')[0];

      if (nonInteractive) {
        const newId = process.env.DOTCLAW_CONFIGURE_CHAT_ID;
        if (newId) {
          const newChatId = `${targetProvider}:${newId}`;
          groups[newChatId] = groupData;
          delete groups[oldChatId];
          console.log(`Migrated group "${groupData.name}" from ${oldPrefix} to ${newChatId}`);
        } else {
          console.warn(
            `Warning: Group "${groupData.name}" is registered under ${oldPrefix} (${oldChatId}), ` +
            `but ${oldPrefix} is now disabled. Set DOTCLAW_CONFIGURE_CHAT_ID to migrate it.`
          );
        }
      } else {
        const migrateRl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const idLabel = targetProvider === 'discord' ? 'Discord channel ID' : 'Telegram chat ID';
        const idHint = targetProvider === 'discord'
          ? '(Right-click channel -> Copy Channel ID)'
          : '(Use @userinfobot or @get_id_bot)';

        console.log(
          `\nGroup "${groupData.name}" is registered under ${oldPrefix} (${oldChatId}), ` +
          `but ${oldPrefix} is now disabled.`
        );
        const newId = await new Promise(resolve => {
          migrateRl.question(
            `${idLabel} to re-register this group ${idHint}, or press Enter to skip: `,
            answer => resolve(answer.trim())
          );
        });
        migrateRl.close();

        if (newId) {
          const newChatId = `${targetProvider}:${newId}`;
          groups[newChatId] = groupData;
          delete groups[oldChatId];
          console.log(`Migrated group "${groupData.name}" to ${newChatId}`);
        } else {
          console.log(`Skipped migration for "${groupData.name}". You can update registered_groups.json manually.`);
        }
      }
    }

    saveJson(REGISTERED_GROUPS_PATH, groups);
  }

  console.log('Configuration updated.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
