---
title: Multi-Provider Setup
---

# Multi-Provider Setup

DotClaw supports running Telegram and Discord simultaneously. Each provider connects to the same agent runtime, memory store, and scheduled tasks.

## Provider defaults

| Provider | Default state | Token variable |
|----------|--------------|----------------|
| Telegram | Enabled | `TELEGRAM_BOT_TOKEN` |
| Discord | Disabled | `DISCORD_BOT_TOKEN` |

## Running both providers

1. Set up each provider individually:
   - [Telegram Setup](telegram-setup.md)
   - [Discord Setup](discord-setup.md)

2. Enable Discord in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "telegram": { "enabled": true },
    "discord": { "enabled": true }
  }
}
```

3. Add both tokens to `~/.dotclaw/.env`:

```bash
TELEGRAM_BOT_TOKEN=your_telegram_token
DISCORD_BOT_TOKEN=your_discord_token
```

4. Register channels for each provider in `~/.dotclaw/data/registered_groups.json`:

```json
{
  "telegram:123456789": {
    "name": "main",
    "folder": "main",
    "added_at": "2026-01-01T00:00:00.000Z"
  },
  "discord:9876543210123456": {
    "name": "discord-main",
    "folder": "discord-main",
    "added_at": "2026-01-01T00:00:00.000Z"
  }
}
```

## Chat ID prefixes

All chat IDs in `registered_groups.json` must be prefixed with their provider name:

| Provider | Prefix | Example |
|----------|--------|---------|
| Telegram | `telegram:` | `telegram:123456789` |
| Discord | `discord:` | `discord:1234567890123456789` |

## Shared vs isolated groups

Multiple provider channels can share the same `folder`, giving them access to the same agent workspace, memory, and CLAUDE.md instructions. Or each can have its own folder for full isolation.

**Shared folder** — both channels see the same memory and files:
```json
{
  "telegram:123456789": { "name": "main", "folder": "main" },
  "discord:9876543210123456": { "name": "main-discord", "folder": "main" }
}
```

**Isolated folders** — separate memory and workspace per provider:
```json
{
  "telegram:123456789": { "name": "main", "folder": "main" },
  "discord:9876543210123456": { "name": "discord-main", "folder": "discord-main" }
}
```

## Bootstrap with a specific provider

When running `npm run bootstrap`, if both providers are enabled it will prompt you to choose. For non-interactive bootstrap, set `DOTCLAW_BOOTSTRAP_PROVIDER`:

```bash
DOTCLAW_BOOTSTRAP_NONINTERACTIVE=1 \
DOTCLAW_BOOTSTRAP_PROVIDER=discord \
DISCORD_BOT_TOKEN=your_token \
OPENROUTER_API_KEY=your_key \
DOTCLAW_BOOTSTRAP_CHAT_ID=1234567890123456789 \
npm run bootstrap
```

## Disabling a provider

To disable a provider without removing its configuration:

```json
{
  "host": {
    "telegram": { "enabled": false }
  }
}
```

The bot token can remain in `.env` — it won't be used if the provider is disabled.
