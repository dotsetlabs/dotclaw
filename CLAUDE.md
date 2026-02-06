# DotClaw

Personal OpenRouter-based assistant. See [README.md](README.md) for philosophy and setup. See [docs/architecture.md](docs/architecture.md) and [docs/getting-started/requirements.md](docs/getting-started/requirements.md).

## Quick Context

Single Node.js process that connects to messaging providers (Telegram + optional Discord), routes messages through a pipeline to an OpenRouter agent runtime running in Docker containers. Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: provider setup, admin commands, wake recovery |
| `src/message-pipeline.ts` | Message queue, batching, agent invocation |
| `src/ipc-dispatcher.ts` | Container IPC file watcher and dispatch |
| `src/providers/registry.ts` | Provider registry (prefix routing) |
| `src/providers/telegram/telegram-provider.ts` | Telegram provider |
| `src/providers/discord/discord-provider.ts` | Discord provider |
| `src/config.ts` | Paths, intervals, routing defaults |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/agent-execution.ts` | Shared agent run logic (container invocation, telemetry) |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/background-jobs.ts` | Durable background job queue |
| `src/db.ts` | SQLite operations |
| `src/memory-store.ts` | Long-term memory storage (SQLite) |
| `src/error-messages.ts` | User-friendly error mapping |
| `src/runtime-config.ts` | Runtime configuration type and loading |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
launchctl unload ~/Library/LaunchAgents/com.dotclaw.plist
```
