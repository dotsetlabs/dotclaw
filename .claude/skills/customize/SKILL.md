---
name: customize
description: Add new capabilities or modify DotClaw behavior. Use when user wants to add channels (Telegram, Discord, Slack, email input), change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# DotClaw Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** - Ask clarifying questions
2. **Plan the changes** - Identify files to modify
3. **Implement** - Make changes directly to the code
4. **Test guidance** - Tell user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/runtime-config.ts` | Runtime configuration defaults and types |
| `src/index.ts` | Main orchestrator: provider setup, message routing, wake recovery |
| `src/message-pipeline.ts` | SQLite-backed message queue and batching |
| `src/ipc-dispatcher.ts` | IPC file watching and message dispatch |
| `src/providers/registry.ts` | Provider registry (maps provider-prefixed chatIds to providers) |
| `src/providers/telegram/telegram-provider.ts` | Telegram provider |
| `src/providers/discord/discord-provider.ts` | Discord provider |
| `src/providers/types.ts` | Provider interfaces (MessagingProvider, ProviderEventHandlers) |
| `src/db.ts` | Database initialization and queries |
| `src/types.ts` | TypeScript interfaces |
| `~/.dotclaw/groups/global/CLAUDE.md` | Global memory/persona |

## Common Customization Patterns

### Adding a New Messaging Provider

Questions to ask:
- Which platform? (Slack, SMS, email, etc.)
- Same trigger word or different?
- Same memory hierarchy or separate?
- Should messages from this channel go to existing groups or new ones?

Implementation pattern:
1. Create `src/providers/<name>/<name>-provider.ts` implementing `MessagingProvider` interface
2. Create `src/providers/<name>/<name>-format.ts` for message formatting
3. Register the provider in `src/index.ts` via `providerRegistry.register()`
4. Add provider prefix to `VALID_PREFIXES` in `src/providers/registry.ts`
5. Add any new env vars to `.env.example` and `src/index.ts` startup checks
6. Store messages in the database (update `src/db.ts` if needed)

### Adding a New MCP Integration

Questions to ask:
- What service? (Calendar, Notion, database, etc.)
- What operations needed? (read, write, both)
- Which groups should have access?

Implementation:
1. Add MCP server config to `container/agent-runner/src/index.ts`
2. Add tools to allowed tools list
3. Document in `~/.dotclaw/groups/global/CLAUDE.md`

### Changing Assistant Behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all groups or specific ones?

Name/trigger → edit `~/.dotclaw/config/runtime.json` (`agent.assistantName`)
Persona → edit `~/.dotclaw/groups/global/CLAUDE.md`
Per-group behavior → edit specific group's `CLAUDE.md`

### Adding New Admin Commands

Questions to ask:
- What should the command do?
- Available in all groups or main only?
- Does it need new MCP tools?

Implementation:
1. Add command handling in the admin command section of `src/index.ts`
2. Check for the command in the `onMessage` handler before agent invocation

### Changing Deployment

Questions to ask:
- Target platform? (Linux server, Docker, different Mac)
- Service manager? (systemd, launchd, Docker, supervisord)

Implementation:
1. Use templates in `systemd/` (Linux) or `launchd/` (macOS)
2. Update paths in config
3. Provide setup instructions

## After Changes

Always tell the user:
```bash
# Rebuild and restart
npm run build
dotclaw restart

# If container/agent-runner code changed, also rebuild the container:
./container/build.sh
```

## Example Interaction

User: "Add Slack as an input channel"

1. Ask: "Should Slack use the same trigger word, or a different one?"
2. Ask: "Should Slack messages create separate conversation contexts, or share with existing groups?"
3. Create provider files following the `MessagingProvider` interface pattern
4. Register the provider in the main orchestrator
5. Tell user how to configure and test
