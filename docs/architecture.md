---
title: Architecture
---

# Architecture

## Data flow

```
Telegram (Telegraf)
  -> DotClaw host process
  -> SQLite (messages.db)
  -> Docker container (agent runtime)
  -> Response back to Telegram

Background jobs follow the same path but run asynchronously and report completion when finished.
```

## Key directories

```
dotclaw/                 (project root)
  src/                   Main application
  container/             Agent container image + runner
  config-examples/       Reference configuration
  scripts/               Setup and utility scripts
  systemd/               Linux service template
  launchd/               macOS service template

~/.dotclaw/              (user data, created at runtime)
  config/                Configuration files
  data/                  Runtime data (database, IPC)
  groups/                Per-group workspaces
  logs/                  Application logs
```

## Runtime layout

All runtime data is stored in `~/.dotclaw` (configurable via `DOTCLAW_HOME` environment variable):

```
~/.dotclaw/
  config/
    runtime.json          Non-secret overrides
    model.json            Active model and allowlist
    tool-policy.json      Tool allow/deny lists
    tool-budgets.json     Optional tool budgets
    behavior.json         Autotune behavior outputs
  data/
    registered_groups.json
    store/
      messages.db         Message history
      memory.db           Long-term memory
    ipc/                  Container communication (messages/tasks/requests + daemon agent_requests)
    sessions/             Per-group session state
  groups/
    main/CLAUDE.md        Main group memory
    global/CLAUDE.md      Global memory
    <group>/CLAUDE.md     Group memory
    <group>/inbox/        Downloaded incoming Telegram media
    <group>/downloads/    Files downloaded by mcp__dotclaw__download_url
    <group>/jobs/         Background job artifacts
  logs/
  prompts/
  traces/
  .env                    Secrets (Telegram, OpenRouter keys)
```
