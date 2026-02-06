---
title: Configuration Overview
---

# Configuration Overview

DotClaw splits configuration between secret environment variables and runtime JSON files. All configuration and data is stored in `~/.dotclaw` (configurable via the `DOTCLAW_HOME` environment variable).

## Files and purpose

| File | Purpose |
| --- | --- |
| `~/.dotclaw/.env` | Secrets: Telegram token, Discord token, OpenRouter key, Brave Search key |
| `~/.dotclaw/config/runtime.json` | Non-secret runtime overrides |
| `~/.dotclaw/config/model.json` | Active model, allowlist, and overrides |
| `~/.dotclaw/config/tool-policy.json` | Tool allow/deny rules |
| `~/.dotclaw/config/tool-budgets.json` | Optional daily tool budgets |
| `~/.dotclaw/config/behavior.json` | Autotune behavior outputs |
| `~/.dotclaw/data/registered_groups.json` | Registered chat IDs, folders, and optional `containerConfig` (mounts/env) |
| `~/.dotclaw/groups/<group>/CLAUDE.md` | Per-group instructions loaded into agent prompt |
| `~/.dotclaw/groups/global/CLAUDE.md` | Global instructions applied to all groups |
| `~/.config/dotclaw/mount-allowlist.json` | Host path allowlist for mounts |

## How runtime overrides work

`~/.dotclaw/config/runtime.json` overrides defaults defined in `src/runtime-config.ts`. Unknown keys are ignored, and types must match the defaults or they will be skipped.
