---
title: Admin Commands
---

# Admin Commands

Admin commands are available via `/dotclaw` (or the shorthand `/dc`). Group management and skill commands only work in the main group.

## Commands

- `/dotclaw help`
- `/dotclaw groups` (main only)
- `/dotclaw add-group <chat_id> <name> [folder]` (main only)
- `/dotclaw remove-group <chat_id|name|folder>` (main only)
- `/dotclaw set-model <model> [global|group|user] [target_id]` (main only)
- `/dotclaw remember <fact>` (main only)
- `/dotclaw style <concise|balanced|detailed>`
- `/dotclaw tools <conservative|balanced|proactive>`
- `/dotclaw caution <low|balanced|high>`
- `/dotclaw memory <strict|balanced|loose>`
- `/dotclaw skill install <url> [--global]` (main only)
- `/dotclaw skill remove <name> [--global]` (main only)
- `/dotclaw skill list [--global]` (main only)
- `/dotclaw skill update <name> [--global]` (main only)

## Command aliases

Many commands accept natural-language aliases:

| Alias | Equivalent |
|-------|------------|
| `/dc` | `/dotclaw` |
| `/dotclaw set model <model>` | `/dotclaw set-model <model>` |
| `/dotclaw model <model>` | `/dotclaw set-model <model>` (global shorthand) |
| `/dotclaw add group ...` | `/dotclaw add-group ...` |
| `/dotclaw delete group ...` | `/dotclaw remove-group ...` |
| `/dotclaw list groups` | `/dotclaw groups` |
| `/dotclaw skill uninstall <name>` | `/dotclaw skill remove <name>` |
| `/dotclaw skill ls` | `/dotclaw skill list` |
| `/help` | `/dotclaw help` |
| `/groups` | `/dotclaw groups` |

## Mention-based commands

You can also trigger admin commands by mentioning the bot:

```
@botname groups
@botname set model deepseek/deepseek-v3.2
@botname remember User prefers dark mode
```

This uses the same command parser as `/dotclaw`.
