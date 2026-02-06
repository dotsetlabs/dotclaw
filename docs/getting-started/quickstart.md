---
title: Quickstart
---

# Quickstart

This path uses the bootstrap script to initialize config, prompt for secrets, register your main chat, and build the container.

## 1. Install dependencies

```bash
git clone <repo-url>
cd dotclaw
npm install
```

If using Discord, also install the optional dependency:

```bash
npm install discord.js
```

## 2. Set up a bot

Before running the bootstrap, create a bot on your messaging platform:

- [Telegram Setup](telegram-setup.md) — create a bot via @BotFather
- [Discord Setup](discord-setup.md) — create an app in the Discord Developer Portal

You'll need the bot token for the next step.

## 3. Run the bootstrap

```bash
npm run bootstrap
```

The bootstrap will:

- Create runtime directories and config files
- Prompt for `.env` secrets (bot token, OpenRouter API key)
- Ask which provider to register (Telegram or Discord, if both are enabled)
- Register your main chat
- Optionally build the Docker image
- Optionally run a container self-check

## 4. Build and start

```bash
npm run build
npm start
```

## Non-interactive bootstrap

```bash
DOTCLAW_BOOTSTRAP_NONINTERACTIVE=1 \
TELEGRAM_BOT_TOKEN=your_bot_token_here \
OPENROUTER_API_KEY=your_openrouter_api_key \
DOTCLAW_BOOTSTRAP_CHAT_ID=123456789 \
npm run bootstrap
```

Optional variables:

- `DOTCLAW_BOOTSTRAP_PROVIDER` — `telegram` or `discord` (default: auto-detect from enabled providers)
- `DOTCLAW_BOOTSTRAP_GROUP_NAME` (default `main`)
- `DOTCLAW_BOOTSTRAP_GROUP_FOLDER` (default `main`)
- `DOTCLAW_BOOTSTRAP_BUILD` (`true` or `false`)
- `DOTCLAW_BOOTSTRAP_SELF_CHECK` (`true` or `false`)

## Running multiple providers

See [Multi-Provider Setup](multi-provider.md) for running Telegram and Discord together.
