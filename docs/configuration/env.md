---
title: Environment (.env)
---

# Environment (.env)

Secrets live in `~/.dotclaw/.env`. Only set secrets here; non-secret runtime settings go in `~/.dotclaw/config/runtime.json`.

::: tip File Location
The `.env` file must be placed at `~/.dotclaw/.env` (or `$DOTCLAW_HOME/.env` if you've customized the home directory).
:::

## Required

- `TELEGRAM_BOT_TOKEN`
- `OPENROUTER_API_KEY`

## Optional

- `DISCORD_BOT_TOKEN` (enables Discord provider)
- `BRAVE_SEARCH_API_KEY` (enables WebSearch)
- `TZ` (override host timezone; affects scheduler timing and agent timestamp interpretation)
- `DOTCLAW_HOME` (override config/data directory, default: `~/.dotclaw`)
- `DOTCLAW_VISION_MODEL` (model for the `AnalyzeImage` tool, default: `openai/gpt-4o`)

## Example

```bash
TELEGRAM_BOT_TOKEN=123456789:replace-with-real-token
OPENROUTER_API_KEY=sk-or-replace-with-real-key
DISCORD_BOT_TOKEN=replace-with-discord-token
BRAVE_SEARCH_API_KEY=replace-with-brave-key
```

## Non-interactive setup variables

These are read by `npm run bootstrap` and `npm run configure` when running non-interactively:

- `DOTCLAW_BOOTSTRAP_NONINTERACTIVE=1`
- `DOTCLAW_CONFIGURE_NONINTERACTIVE=1`
- `DOTCLAW_BOOTSTRAP_PROVIDER` — `telegram` or `discord` (auto-detected if omitted)
- `DOTCLAW_BOOTSTRAP_CHAT_ID`
- `DOTCLAW_BOOTSTRAP_GROUP_NAME`
- `DOTCLAW_BOOTSTRAP_GROUP_FOLDER`
- `DOTCLAW_BOOTSTRAP_BUILD`
- `DOTCLAW_BOOTSTRAP_SELF_CHECK`
