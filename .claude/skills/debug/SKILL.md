---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, or to understand how the container system works. Covers logs, environment variables, mounts, and common issues.
---

# DotClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

```
Host (macOS/Linux)                    Container (Docker)
─────────────────────────────────────────────────────────────
src/container-runner.ts               container/agent-runner/
    │                                      │
    │ spawns Docker container              │ runs OpenRouter agent
    │ with volume mounts                   │ with MCP tools
    │                                      │
    ├── data/env/env ──────────────> /workspace/env-dir/env
    ├── groups/{folder} ───────────> /workspace/group
    ├── data/ipc/{folder} ────────> /workspace/ipc
    ├── data/sessions/{folder}/.claude/ ──> /home/node/.claude/ (isolated per-group)
    └── (main only) project root ──> /workspace/project
```

**Important:** The container runs as user `node` with `HOME=/home/node`. Session files must be mounted to `/home/node/.claude/` (not `/root/.claude/`) for session resumption to work.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Main app logs** | `~/.dotclaw/logs/dotclaw.log` | Host-side messaging, routing, container spawning |
| **Main app errors** | `~/.dotclaw/logs/dotclaw.error.log` | Host-side errors |
| **Container run logs** | `~/.dotclaw/groups/{folder}/logs/container-*.log` | Per-run: input, mounts, stderr, stdout |

## Enabling Debug Logging

Set log level in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "logLevel": "debug"
  }
}
```

Or for development:

```bash
LOG_LEVEL=debug npm run dev
```

Debug level shows:
- Full mount configurations
- Container command arguments
- Real-time container stderr

## Common Issues

### 1. Container agent exits with error

**Check the container log file** in `~/.dotclaw/groups/{folder}/logs/container-*.log`

Common causes:

#### Missing API Key
```
OPENROUTER_API_KEY is not set
```
**Fix:** Ensure `~/.dotclaw/.env` has `OPENROUTER_API_KEY`:
```bash
cat ~/.dotclaw/.env  # Should show:
# OPENROUTER_API_KEY=sk-or-...
```

#### Root User Restriction
```
--dangerously-skip-permissions cannot be used with root/sudo privileges
```
**Fix:** Container must run as non-root user. Check Dockerfile has `USER node`.

### 2. Environment Variables Not Passing

The system extracts `OPENROUTER_API_KEY` (and optionally `BRAVE_SEARCH_API_KEY`) from `~/.dotclaw/.env` and mounts them for sourcing inside the container at `/workspace/env-dir/env`. This keeps credentials out of process listings. Other env vars are not exposed unless set in per-group `containerConfig.env`.

To verify env vars are reaching the container:
```bash
echo '{}' | docker run -i \
  -v ~/.dotclaw/data/env:/workspace/env-dir:ro \
  --entrypoint /bin/bash dotclaw-agent:latest \
  -c 'export $(cat /workspace/env-dir/env | xargs); echo "API Key: ${#OPENROUTER_API_KEY} chars"'
```

### 3. Mount Issues

Docker bind mount syntax:
```bash
# Readonly: -v with :ro suffix
-v /path:/container/path:ro

# Read-write: -v without suffix
-v /path:/container/path
```

To check what's mounted inside a container:
```bash
docker run --rm --entrypoint /bin/bash dotclaw-agent:latest -c 'ls -la /workspace/'
```

Expected structure:
```
/workspace/
├── env-dir/env           # Environment file (OPENROUTER_API_KEY, etc.)
├── group/                # Current group folder (cwd)
├── project/              # Project root (main channel only)
├── global/               # Global CLAUDE.md (non-main only)
├── ipc/                  # Inter-process communication
│   ├── messages/         # Outgoing messages (sent via provider)
│   ├── tasks/            # Scheduled task commands
│   ├── requests/         # Request/response IPC (daemon mode)
│   ├── current_tasks.json    # Read-only: scheduled tasks visible to this group
│   └── available_groups.json # Read-only: registered groups for activation (main only)
└── extra/                # Additional custom mounts
```

### 4. Permission Issues

The container runs as user `node` (uid 1000). Check ownership:
```bash
docker run --rm --entrypoint /bin/bash dotclaw-agent:latest -c '
  whoami
  ls -la /workspace/
  ls -la /app/
'
```

All of `/workspace/` and `/app/` should be owned by `node`.

### 5. Session Not Resuming

If sessions aren't being resumed (new session ID every time):

**Root cause:** Session files are stored per-group in `~/.dotclaw/data/sessions/{group}/.claude/`. Inside the container, `HOME=/home/node`, so they are mounted at `/home/node/.claude/`.

**Verify sessions are accessible:**
```bash
docker run --rm --entrypoint /bin/bash \
  -v ~/.dotclaw/data/sessions/main/.claude:/home/node/.claude \
  dotclaw-agent:latest -c '
echo "HOME=$HOME"
ls -la $HOME/.claude/ 2>&1 | head -5
'
```

### 6. MCP Server Failures

If an MCP server fails to start, the agent may exit. Check the container logs for MCP initialization errors.

## Manual Container Testing

### Test the full agent flow:
```bash
echo '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"telegram:test","isMain":false}' | \
  docker run -i \
  -v ~/.dotclaw/data/env:/workspace/env-dir:ro \
  -v ~/.dotclaw/groups/test:/workspace/group \
  -v ~/.dotclaw/data/ipc/test:/workspace/ipc \
  dotclaw-agent:latest
```

### Interactive shell in container:
```bash
docker run --rm -it --entrypoint /bin/bash dotclaw-agent:latest
```

## Rebuilding After Changes

```bash
# Rebuild main app
npm run build

# Rebuild container (required after changes to container/agent-runner/)
./container/build.sh

# Or force full rebuild
docker builder prune -af
./container/build.sh
```

**Important:** After rebuilding the container image, remove any stale daemon containers so they pick up the new code:
```bash
npm run dev:up  # Handles cleanup automatically
# Or manually: docker rm -f $(docker ps -aq --filter ancestor=dotclaw-agent:latest)
```

## Checking Container Image

```bash
# List images
docker images | grep dotclaw

# Check what's in the image
docker run --rm --entrypoint /bin/bash dotclaw-agent:latest -c '
  echo "=== Node version ==="
  node --version
  echo "=== Installed packages ==="
  ls /app/node_modules/ | head -20
'
```

## Session Persistence

Sessions are stored per-group in `~/.dotclaw/data/sessions/{group}/.claude/` for security isolation. Each group has its own session directory, preventing cross-group access to conversation history.

**Critical:** The mount path must match the container user's HOME directory:
- Container user: `node`
- Container HOME: `/home/node`
- Mount target: `/home/node/.claude/` (NOT `/root/.claude/`)

## IPC Debugging

The container communicates back to the host via files in `/workspace/ipc/`:

```bash
# Check pending messages
ls -la ~/.dotclaw/data/ipc/*/messages/

# Check pending task operations
ls -la ~/.dotclaw/data/ipc/*/tasks/

# Read a specific IPC file
cat ~/.dotclaw/data/ipc/*/messages/*.json

# Check available groups (main channel only)
cat ~/.dotclaw/data/ipc/main/available_groups.json

# Check current tasks snapshot
cat ~/.dotclaw/data/ipc/{groupFolder}/current_tasks.json
```

**IPC file types:**
- `messages/*.json` - Agent writes: outgoing messages (routed to originating provider)
- `tasks/*.json` - Agent writes: task operations (schedule, pause, resume, cancel, refresh_groups)
- `requests/*.json` - Agent writes: request/response pairs (daemon mode)
- `current_tasks.json` - Host writes: read-only snapshot of scheduled tasks
- `available_groups.json` - Host writes: read-only list of registered groups (main only)

## Quick Diagnostic Script

```bash
dotclaw doctor
```

Or manually:

```bash
echo "=== Checking DotClaw Setup ==="

echo -e "\n1. API key configured?"
[ -f ~/.dotclaw/.env ] && grep -q "OPENROUTER_API_KEY=sk-" ~/.dotclaw/.env && echo "OK" || echo "MISSING - add OPENROUTER_API_KEY to ~/.dotclaw/.env"

echo -e "\n2. Telegram token configured?"
[ -f ~/.dotclaw/.env ] && grep -q "TELEGRAM_BOT_TOKEN=" ~/.dotclaw/.env && echo "OK" || echo "MISSING"

echo -e "\n3. Docker daemon running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING"

echo -e "\n4. Container image exists?"
docker images | grep -q dotclaw-agent && echo "OK" || echo "MISSING - run ./container/build.sh"

echo -e "\n5. Groups registered?"
cat ~/.dotclaw/data/registered_groups.json 2>/dev/null | head -5 || echo "No groups registered"

echo -e "\n6. Recent container logs?"
ls -t ~/.dotclaw/groups/*/logs/container-*.log 2>/dev/null | head -3 || echo "No container logs yet"
```
