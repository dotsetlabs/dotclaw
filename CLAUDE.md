# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DotClaw is a personal OpenRouter-based assistant for Telegram and Discord. A single Node.js host process connects to messaging providers, routes messages through a pipeline, and executes agent requests inside isolated Docker containers. Each group gets its own filesystem, memory, and session state.

## Development Commands

```bash
npm run build              # Compile host TypeScript (src/ → dist/)
npm run dev                # Run host with hot reload (tsx, no container rebuild)
npm run dev:up             # Full dev cycle: rebuild container + kill stale daemons + start dev
npm run dev:down           # Remove all running dotclaw agent containers
npm run lint               # ESLint (flat config, zero warnings allowed)
npm run typecheck          # Type-check without emitting
npm test                   # Build + run all tests (host + container agent-runner)
./container/build.sh       # Rebuild Docker image (run after container code changes)
```

Run a single host test:
```bash
npm run build && node --test test/memory-store.test.js
```

Run container agent-runner tests only:
```bash
npm run test:agent-runner
```

Service management (macOS):
```bash
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
launchctl unload ~/Library/LaunchAgents/com.dotclaw.plist
```

Run commands directly — don't tell the user to run them.

## Build System: What to Rebuild When

| Changed | Command | Why |
|---------|---------|-----|
| `src/` (host code) | `npm run build` | Recompiles to `dist/` |
| `container/agent-runner/src/` | `./container/build.sh` | Agent code is baked into Docker image |
| `container/Dockerfile` | `./container/build.sh` | Rebuilds image with new system deps |
| Both host + container | `npm run build:all` then `./container/build.sh` | Full rebuild |

**Critical**: Daemon containers cache old code. After rebuilding the image, run `npm run dev:down` to remove stale containers. The `dev:up` script does this automatically.

## Architecture

### Two-Process Model

```
Host process (Node.js)              Docker container (agent-runner)
─────────────────────               ──────────────────────────────
Providers (Telegram/Discord)        OpenRouter SDK calls
Message pipeline (SQLite queue)     Tool execution (bash, browser, MCP)
Request router                      Session management
Container runner                    Memory extraction
IPC dispatcher          ←──IPC──→   Skill loading
Telemetry + traces                  Streaming delivery
```

**IPC modes:**
- **Daemon** (default): Long-lived container per group. Host writes request files to `~/.dotclaw/data/ipc/<group>/agent_requests/`, container polls and writes responses to `agent_responses/`. Heartbeat worker thread writes health every 1s.
- **Ephemeral**: Container spawns per request, reads JSON from stdin, writes to stdout between sentinel markers (`---DOTCLAW_OUTPUT_START---` / `---DOTCLAW_OUTPUT_END---`).

### Message Flow

1. Provider receives message → downloads attachments to `groups/<group>/inbox/`
2. `enqueueMessage()` → SQLite `message_queue` (status: pending)
3. `drainQueue()` → `claimBatchForChat()` groups rapid messages within `BATCH_WINDOW_MS` (2s)
4. `routeRequest()` applies flat routing config (model, token limits, max tool steps)
5. `executeAgentRun()` builds context (memory recall, tool policy) → `runContainerAgent()`
6. Container agent-runner calls OpenRouter with streaming, iterates tool calls up to `maxToolSteps` (default 50)
7. Streaming response delivered via edit-in-place → sent back through provider → telemetry recorded

Transient failures re-queue with exponential backoff (base 3s, max 60s, up to 4 retries).

### Provider System

Chat IDs are prefixed: `telegram:123456`, `discord:789012`. The provider registry (`src/providers/registry.ts`) routes by prefix. Both providers implement a common interface with send/edit/delete operations and media support.

### Container Mounts

- Main group: `/workspace/project` (readonly, package root) + `/workspace/group` (RW) + `/workspace/global` (readonly)
- Other groups: `/workspace/group` (RW) + `/workspace/global` (readonly) — no project access
- Shared (readonly): `/workspace/prompts`, `/workspace/config`, `/workspace/env-dir`
- Per-group: `/workspace/session` (sessions), `/workspace/ipc` (IPC namespace)

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: provider setup, admin commands, wake recovery |
| `src/message-pipeline.ts` | SQLite message queue, batching, agent invocation |
| `src/agent-execution.ts` | Context building, container invocation, telemetry |
| `src/container-runner.ts` | Docker container lifecycle, mounts, daemon management |
| `src/container-protocol.ts` | `ContainerInput`/`ContainerOutput` interfaces (shared with container) |
| `src/ipc-dispatcher.ts` | File-watcher for container→host async messages |
| `src/request-router.ts` | Request routing configuration |
| `src/runtime-config.ts` | Runtime config type definition and loader (with validation) |
| `src/streaming.ts` | Streaming delivery for real-time message updates |
| `src/providers/registry.ts` | Provider registry (prefix-based routing) |
| `src/task-scheduler.ts` | Cron and one-off scheduled tasks |
| `src/db.ts` | SQLite schema and operations |
| `src/memory-store.ts` | Long-term memory with embeddings and FTS |
| `container/agent-runner/src/index.ts` | Agent entry point (OpenRouter calls, tool loop) |
| `container/agent-runner/src/daemon.ts` | Daemon mode: request polling, worker threads, heartbeat |
| `container/agent-runner/src/tools.ts` | Tool definitions and execution |
| `container/agent-runner/src/skill-loader.ts` | Skill discovery and catalog building |
| `container/agent-runner/src/agent-config.ts` | Container-side config (reads mounted runtime.json) |

## Configuration

All runtime data lives in `~/.dotclaw/` (override with `DOTCLAW_HOME`).

| File | Purpose |
|------|---------|
| `.env` | Secrets (API keys, bot tokens) |
| `config/runtime.json` | Host runtime overrides (timeouts, concurrency, routing) |
| `config/model.json` | Active model, allowlist, per-user/per-group overrides |
| `config/behavior.json` | Autotune optimization outputs |
| `config/tool-policy.json` | Tool allow/deny lists |
| `config/tool-budgets.json` | Daily tool usage limits |

The container reads `runtime.json` via readonly mount at `/workspace/config/runtime.json`. Container-side config is in `agent-config.ts` which reads the `agent.*` fields.

## Code Conventions

- **ESM only**: `"type": "module"` — use `import`/`export`, file extensions required in imports (e.g., `'./bar.js'`)
- **TypeScript**: Strict mode, ES2022 target, NodeNext module resolution
- **Tests**: Node.js built-in test runner (`node:test` + `node:assert/strict`). Host tests import from `dist/` (build first). Test helpers: `withTempHome()`, `importFresh()` in `test/test-helpers.js`
- **Linting**: ESLint flat config with typescript-eslint recommended. Zero warnings threshold.

## Skills

Skills are markdown files discovered at runtime from `/workspace/group/skills/` and `/workspace/global/skills/`. Two forms: `skills/<name>/SKILL.md` (directory with optional `plugins/`) or `skills/<name>.md` (single file). YAML frontmatter defines name, description, and plugin references.

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
