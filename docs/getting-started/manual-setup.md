---
title: Manual Setup
---

# Manual Setup

Use this path if you want full control over each step.

## 1. Install dependencies

```bash
npm install
```

## 2. Initialize runtime files

```bash
npm run init
```

This creates the following in `~/.dotclaw/`:

- `config/runtime.json`
- `config/model.json`
- `config/tool-policy.json`
- `config/tool-budgets.json`
- `data/registered_groups.json`
- `.env`

## 3. Configure secrets and model

Interactive:

```bash
npm run configure
```

Non-interactive:

```bash
DOTCLAW_CONFIGURE_NONINTERACTIVE=1 \
TELEGRAM_BOT_TOKEN=your_bot_token_here \
OPENROUTER_API_KEY=your_openrouter_api_key \
BRAVE_SEARCH_API_KEY=your_brave_search_api_key \
npm run configure
```

## 4. Customize runtime settings (optional)

Edit `~/.dotclaw/config/runtime.json` to tune container behavior, memory, tools, and metrics. See `configuration/runtime` for details.

## 5. Build the container image

```bash
./container/build.sh
```

## 6. Register your main chat

Find your chat ID. For Telegram, message your bot and use @userinfobot or @get_id_bot. For Discord, enable Developer Mode in settings, then right-click a channel and copy the ID. Register using the CLI:

```bash
dotclaw register
```

Or manually add it to `~/.dotclaw/data/registered_groups.json`:

```json
{
  "telegram:-123456789": {
    "name": "family-chat",
    "folder": "family-chat",
    "added_at": "2026-02-04T00:00:00.000Z"
  }
}
```

Folder names must be lowercase letters, numbers, and hyphens only.

## 7. Build and run

```bash
npm run build
npm start
```
