---
title: Development
---

# Development

## Commands

```bash
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript (host)
npm run typecheck    # Type-check without emitting
npm run lint         # Run ESLint
npm test             # Build + Node tests + agent runner test
```

## Agent container

The agent runtime runs inside Docker. Rebuild the image when you change anything under `container/`:

```bash
./container/build.sh
```

`npm run build` only compiles the host TypeScript — it does **not** rebuild the Docker image. If you change container code (e.g. `container/agent-runner/src/`), you must run `./container/build.sh`.

In daemon mode, stale containers cache old code. After rebuilding, `npm run dev:up` automatically removes old daemon containers. If running manually, use `docker rm -f` on any running daemon containers.

## Project structure

```
src/                          # Host process (Node.js)
├── index.ts                  # Main app: provider setup, admin commands, wake recovery
├── message-pipeline.ts       # Message queue, batching, agent invocation
├── agent-execution.ts        # Shared agent run logic (container invocation, telemetry)
├── container-runner.ts       # Spawns agent containers with mounts
├── ipc-dispatcher.ts         # Container IPC file watcher and dispatch
├── request-router.ts         # Request routing configuration
├── task-scheduler.ts         # Scheduled task execution
├── streaming.ts              # Streaming delivery for real-time message updates
├── db.ts                     # SQLite operations
├── memory-store.ts           # Long-term memory storage (SQLite + FTS + embeddings)
├── runtime-config.ts         # Runtime configuration type and loading
├── config.ts                 # Paths, intervals, routing defaults
├── hooks.ts                  # Lifecycle event hooks
├── transcription.ts          # Voice message transcription
├── error-messages.ts         # User-friendly error mapping
├── providers/
│   ├── registry.ts           # Provider registry (prefix routing)
│   ├── types.ts              # MessagingProvider interface
│   ├── telegram/             # Telegram provider implementation
│   └── discord/              # Discord provider implementation
└── ...

container/                    # Agent container
├── build.sh                  # Docker image build script
├── Dockerfile                # Container image definition
└── agent-runner/
    └── src/
        ├── index.ts          # Main agent loop: OpenRouter calls, tool dispatch
        ├── container-protocol.ts  # Input/output types for host<->container IPC
        ├── tools.ts          # Tool definitions and execution
        └── ...

scripts/                      # Setup and utility scripts
├── init.js                   # Directory and config file initialization
├── bootstrap.js              # First-time setup wizard
├── configure.js              # Provider and API key configuration
├── doctor.js                 # Diagnostic checks
└── autotune.js               # Behavior optimization

config-examples/              # Seed files copied on first init
├── groups/
│   ├── main/CLAUDE.md        # Per-group agent instructions (main group)
│   └── global/CLAUDE.md      # Global agent instructions
└── ...

docs/                         # Documentation
```

## Provider architecture

Providers implement the `MessagingProvider` interface (`src/providers/types.ts`) which defines methods for sending messages, files, buttons, polls, and handling reactions.

The `ProviderRegistry` (`src/providers/registry.ts`) routes messages by chat ID prefix (`telegram:`, `discord:`). Each provider is registered at startup if enabled in runtime config.

Key provider interface methods:
- `start(handlers)` / `stop()` — lifecycle
- `sendMessage()`, `sendPhoto()`, `sendDocument()`, etc. — outbound messaging
- `isBotMentioned()`, `isBotReplied()` — trigger detection
- `downloadFile()` — incoming attachment downloads
- `setTyping()` — typing indicators

## Message flow

1. Provider receives message → calls `handlers.onMessage(incoming)`
2. Host checks trigger/mention/reply logic in `src/index.ts`
3. Message is enqueued in SQLite message queue
4. `drainQueue()` claims a batch within the batch window
5. `executeAgentRun()` in `src/agent-execution.ts` invokes the container
6. Container runs the agent loop (OpenRouter calls + tool execution)
7. IPC dispatcher watches for responses and tool requests
8. Final response is sent back via the provider

## Testing

`npm test` runs:
1. Host TypeScript build
2. Node.js test suite
3. Agent runner unit tests (inside the container build)

For faster iteration during development, run individual tests:

```bash
npm run build && node --test test/*.test.js     # Host tests only
```

## Adding a new provider

1. Create `src/providers/<name>/` with a class implementing `MessagingProvider`
2. Add a `create<Name>Provider(runtime: RuntimeConfig)` factory function
3. Add the provider config to `RuntimeConfig` in `src/runtime-config.ts`
4. Register the provider in `src/index.ts` startup logic
5. Use the provider prefix (e.g. `myapp:`) for chat IDs in `registered_groups.json`
