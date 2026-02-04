# DotClaw Specification

A personal OpenRouter-based assistant accessible via Telegram, with persistent memory per conversation, scheduled tasks, and email integration.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder Structure](#folder-structure)
3. [Configuration](#configuration)
4. [Memory System](#memory-system)
5. [Session Management](#session-management)
6. [Message Flow](#message-flow)
7. [Commands](#commands)
8. [Scheduled Tasks](#scheduled-tasks)
9. [MCP Servers](#mcp-servers)
10. [Deployment](#deployment)
11. [Security Considerations](#security-considerations)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS)                                  │
│                   (Main Node.js Process)                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐                     ┌────────────────────┐        │
│  │   Telegram   │────────────────────▶│   SQLite Database  │        │
│  │  (telegraf)  │◀────────────────────│   (messages.db)    │        │
│  └──────────────┘   store/send        └─────────┬──────────┘        │
│                                                  │                   │
│         ┌────────────────────────────────────────┘                   │
│         │                                                            │
│         ▼                                                            │
│  ┌──────────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │  Event Handler   │    │  Scheduler Loop  │    │  IPC Watcher  │  │
│  │  (on message)    │    │  (checks tasks)  │    │  (file-based) │  │
│  └────────┬─────────┘    └────────┬─────────┘    └───────────────┘  │
│           │                       │                                  │
│           └───────────┬───────────┘                                  │
│                       │ spawns container                             │
│                       ▼                                              │
├─────────────────────────────────────────────────────────────────────┤
│                     DOCKER CONTAINER                                 │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    AGENT RUNNER                               │   │
│  │                                                                │   │
│  │  Working directory: /workspace/group (mounted from host)       │   │
│  │  Volume mounts:                                                │   │
│  │    • groups/{name}/ → /workspace/group                         │   │
│  │    • groups/global/ → /workspace/global/ (non-main only)        │   │
│  │    • data/sessions/{group}/openrouter/ → /workspace/session    │   │
│  │    • Additional dirs → /workspace/extra/*                      │   │
│  │                                                                │   │
│  │  Tools (all groups):                                           │   │
│  │    • Bash (safe - sandboxed in container!)                     │   │
│  │    • Read, Write, Edit, Glob, Grep (file operations)           │   │
│  │    • WebSearch (Brave), WebFetch (internet access)             │   │
│  │    • agent-browser (browser automation)                        │   │
│  │    • mcp__dotclaw__* (scheduler tools via IPC)                │   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Telegram Connection | Node.js (telegraf) | Connect to Telegram Bot API, send/receive messages |
| Message Storage | SQLite (better-sqlite3) | Store messages for context |
| Container Runtime | Docker | Isolated containers for agent execution |
| Agent | @openrouter/sdk | Run OpenRouter models with tool execution |
| Browser Automation | agent-browser + Chromium | Web interaction and screenshots |
| Runtime | Node.js 20+ | Host process for routing and scheduling |

---

## Folder Structure

```
dotclaw/
├── CLAUDE.md                      # Project context for the assistant
├── docs/
│   ├── SPEC.md                    # This specification document
│   ├── REQUIREMENTS.md            # Architecture decisions
│   └── SECURITY.md                # Security model
├── README.md                      # User documentation
├── package.json                   # Node.js dependencies
├── tsconfig.json                  # TypeScript configuration
├── .mcp.json                      # MCP server configuration (reference)
├── .gitignore
│
├── src/
│   ├── index.ts                   # Main application (Telegram + routing)
│   ├── config.ts                  # Configuration constants
│   ├── types.ts                   # TypeScript interfaces
│   ├── utils.ts                   # Generic utility functions
│   ├── db.ts                      # Database initialization and queries
│   ├── task-scheduler.ts          # Runs scheduled tasks when due
│   └── container-runner.ts        # Spawns agents in Docker containers
│
├── container/
│   ├── Dockerfile                 # Container image (runs as 'node' user, OpenRouter runtime)
│   ├── build.sh                   # Build script for container image
│   ├── agent-runner/              # Code that runs inside the container
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts           # Entry point (reads JSON, runs agent)
│   │       └── ipc.ts             # IPC utilities for host communication
│   └── skills/
│       └── agent-browser.md       # Browser automation skill
│
├── dist/                          # Compiled JavaScript (gitignored)
│
├── .claude/                       # Legacy Claude Code skills (optional)
│   └── skills/
│       ├── setup/
│       │   └── SKILL.md           # /setup skill
│       ├── customize/
│       │   └── SKILL.md           # /customize skill
│       └── debug/
│           └── SKILL.md           # /debug skill (container debugging)
│
├── groups/
│   ├── CLAUDE.md                  # Global memory (all groups read this)
│   ├── main/                      # Personal chat (main control channel)
│   │   ├── CLAUDE.md              # Main channel memory
│   │   └── logs/                  # Task execution logs
│   └── {Group Name}/              # Per-group folders (created on registration)
│       ├── CLAUDE.md              # Group-specific memory
│       ├── logs/                  # Task logs for this group
│       └── *.md                   # Files created by the agent
│
├── store/                         # Local data (gitignored)
│   └── messages.db                # SQLite database (messages, scheduled_tasks, task_run_logs)
│
├── data/                          # Application state (gitignored)
│   ├── sessions.json              # Active session IDs per group
│   ├── sessions/{group}/openrouter/ # Session history + summary per group
│   ├── registered_groups.json     # Chat ID → folder mapping
│   ├── router_state.json          # Last agent timestamps
│   ├── env/env                    # Copy of .env for container mounting
│   └── ipc/                       # Container IPC (messages/, tasks/)
│
├── logs/                          # Runtime logs (gitignored)
│   ├── dotclaw.log               # Host stdout
│   └── dotclaw.error.log         # Host stderr
│   # Note: Per-container logs are in groups/{folder}/logs/container-*.log
│
└── launchd/
    └── com.dotclaw.plist         # macOS service configuration
```

---

## Configuration

Configuration constants are in `src/config.ts`:

```typescript
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Rain';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Paths are absolute (required for container mounts)
const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Container configuration
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'dotclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '900000', 10);
export const IPC_POLL_INTERVAL = 1000;

```

**Note:** Paths must be absolute for Docker volume mounts to work correctly.

### Container Configuration

Groups can have additional directories mounted via `containerConfig` in `data/registered_groups.json`:

```json
{
  "-987654321": {
    "name": "Dev Team",
    "folder": "dev-team",
    "added_at": "2026-01-31T12:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/Users/gavriel/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ],
      "timeout": 600000
    }
  }
}
```

Additional mounts appear at `/workspace/extra/{containerPath}` inside the container.

**Docker mount syntax:** Both read-write (`-v host:container`) and readonly (`-v host:container:ro`) mounts use the `-v` flag.

### OpenRouter Authentication

Configure authentication in a `.env` file in the project root:

```bash
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=moonshotai/kimi-k2.5

# Optional attribution headers (recommended by OpenRouter)
OPENROUTER_SITE_URL=https://your-domain.example
OPENROUTER_SITE_NAME=DotClaw

# Brave Search (for WebSearch tool)
BRAVE_SEARCH_API_KEY=your_brave_search_api_key
```

Only the OpenRouter/Brave-related variables (and `DOTCLAW_*` tuning) are extracted from `.env` and mounted into the container at `/workspace/env-dir/env`, then sourced by the entrypoint script.

### Memory Tuning

```bash
DOTCLAW_MAX_CONTEXT_TOKENS=200000
DOTCLAW_RECENT_CONTEXT_TOKENS=80000
DOTCLAW_MAX_OUTPUT_TOKENS=4096
DOTCLAW_SUMMARY_UPDATE_EVERY_MESSAGES=12
DOTCLAW_SUMMARY_MAX_OUTPUT_TOKENS=1200
DOTCLAW_SUMMARY_MODEL=moonshotai/kimi-k2.5
```

Memory embeddings (optional, local-only storage):
```bash
DOTCLAW_MEMORY_EMBEDDINGS_ENABLED=true
DOTCLAW_MEMORY_EMBEDDING_MODEL=openai/text-embedding-3-small
DOTCLAW_MEMORY_EMBEDDING_BATCH_SIZE=8
DOTCLAW_MEMORY_EMBEDDING_INTERVAL_MS=300000
DOTCLAW_MEMORY_EMBEDDING_MIN_ITEMS=20
DOTCLAW_MEMORY_EMBEDDING_MIN_QUERY_CHARS=40
DOTCLAW_MEMORY_EMBEDDING_MAX_CANDIDATES=2000
DOTCLAW_MEMORY_EMBEDDING_WEIGHT=0.6
```

### Prompt Packs (Autotune)

Autotune writes prompt packs to `~/.config/dotclaw/prompts`:

- `task-extraction.json`
- `response-quality.json`
- `tool-calling.json`
- `tool-outcome.json`
- `memory-policy.json`
- `memory-recall.json`

Canary packs are stored as:

- `task-extraction.canary.json`
- `response-quality.canary.json`
- `tool-calling.canary.json`
- `tool-outcome.canary.json`
- `memory-policy.canary.json`
- `memory-recall.canary.json`

### Model Configuration

The active model is stored in `data/model.json`:
```json
{
  "model": "moonshotai/kimi-k2.5",
  "allowlist": ["moonshotai/kimi-k2.5", "openai/gpt-4.1-mini"],
  "updated_at": "2026-02-02T00:00:00.000Z"
}
```

If `allowlist` is empty, any model is permitted. If set, only models in the allowlist can be selected (including via chat-time switching).

### Telegram Bot Token

Add your Telegram bot token to `.env`:
```bash
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...
```

Create a bot via @BotFather on Telegram to get your token.

### Changing the Assistant Name

Set the `ASSISTANT_NAME` environment variable:

```bash
ASSISTANT_NAME=Bot npm start
```

Or edit the default in `src/config.ts`. This changes how the assistant identifies itself in prompts and logs.

### Optional Safety Controls

Tool toggles:
```bash
DOTCLAW_ENABLE_BASH=true
DOTCLAW_ENABLE_WEBSEARCH=true
DOTCLAW_ENABLE_WEBFETCH=true
DOTCLAW_WEBFETCH_BLOCK_PRIVATE=true
DOTCLAW_WEBFETCH_ALLOWLIST=example.com,developer.mozilla.org
DOTCLAW_WEBFETCH_BLOCKLIST=localhost,127.0.0.1
```

Container hardening:
```bash
CONTAINER_PIDS_LIMIT=256
CONTAINER_MEMORY=2g
CONTAINER_CPUS=2
CONTAINER_READONLY_ROOT=true
CONTAINER_TMPFS_SIZE=64m
CONTAINER_RUN_UID=1000
CONTAINER_RUN_GID=1000
```

### Placeholder Values in launchd

Files with `{{PLACEHOLDER}}` values need to be configured:
- `{{PROJECT_ROOT}}` - Absolute path to your dotclaw installation
- `{{NODE_PATH}}` - Path to node binary (detected via `which node`)
- `{{HOME}}` - User's home directory

---

## Memory System

DotClaw uses a hierarchical memory system based on CLAUDE.md files plus a session memory store.

### Memory Hierarchy

| Level | Location | Read By | Written By | Purpose |
|-------|----------|---------|------------|---------|
| **Global** | `groups/CLAUDE.md` | All groups | Main only | Preferences, facts, context shared across all conversations |
| **Group** | `groups/{name}/CLAUDE.md` | That group | That group | Group-specific context, conversation memory |
| **Files** | `groups/{name}/*.md` | That group | That group | Notes, research, documents created during conversation |

### How Memory Works

1. **Agent Context Loading**
   - Agent runs with `cwd` set to `groups/{group-name}/`
   - Agent runner reads:
     - `../CLAUDE.md` (parent directory = global memory)
     - `./CLAUDE.md` (current directory = group memory)
   - Session memory (history + summary + facts) is stored in `data/sessions/{group}/openrouter/` and injected into the system prompt.
   - Older history is compacted into summary/facts; relevant past context is retrieved per prompt.

2. **Writing Memory**
   - When user says "remember this", agent writes to `./CLAUDE.md`
   - When user says "remember this globally" (main channel only), agent writes to `../CLAUDE.md`
   - Agent can create files like `notes.md`, `research.md` in the group folder

3. **Main Channel Privileges**
   - Only the "main" group (personal chat) can write to global memory
   - Main can manage registered groups and schedule tasks for any group
   - Main can configure additional directory mounts for any group
   - All groups have Bash access (safe because it runs inside container)

---

## Session Management

Sessions enable conversation continuity with a DotClaw-managed history, summary, and compaction loop.

### How Sessions Work

1. Each group has a session ID stored in `data/sessions.json`
2. Session history + summaries are stored in `data/sessions/{group}/openrouter/{sessionId}/`
3. The agent rebuilds context from recent history + summary + memory recall each run

**data/sessions.json:**
```json
{
  "main": "session-abc123",
  "family-chat": "session-def456"
}
```

---

## Message Flow

### Incoming Message Flow

```
1. User sends Telegram message
   │
   ▼
2. Telegraf receives message via Bot API
   │
   ▼
3. Message stored in SQLite (store/messages.db)
   │
   ▼
4. Event handler processes immediately
   │
   ▼
5. Router checks:
   ├── Is chat_id in registered_groups.json? → No: ignore
   └── Does message start with @Assistant (in groups)? → No: ignore
   │
   ▼
6. Router catches up conversation:
   ├── Fetch all messages since last agent interaction
   ├── Format with timestamp and sender name
   └── Build prompt with full conversation context
   │
   ▼
7. Router invokes OpenRouter agent runner:
   ├── cwd: groups/{group-name}/
   ├── prompt: conversation history + current message
   ├── session_id: DotClaw-managed session store
   └── IPC tools: dotclaw (scheduler)
   │
   ▼
8. Agent processes message:
   ├── Reads CLAUDE.md files for context
   └── Uses tools as needed (search, etc.)
   │
   ▼
9. Router sends response via Telegram (bot sends as itself)
   │
   ▼
10. Router updates last agent timestamp and saves session ID
```

### Group Mention Matching

In groups, the bot processes messages that **mention the bot** or **reply to the bot** (Telegram privacy):
- `@dotclaw_bot what's the weather?` → ✅ Triggers assistant
- Replying to a bot message → ✅ Triggers assistant
- `What's up?` → ❌ Ignored (no mention/reply)

In private chats (DMs), all messages trigger the agent.

### Conversation Catch-Up

When a triggered message arrives, the agent receives all messages since its last interaction in that chat. Each message is formatted with timestamp and sender name:

```
[Jan 31 2:32 PM] John: hey everyone, should we do pizza tonight?
[Jan 31 2:33 PM] Sarah: sounds good to me
[Jan 31 2:35 PM] John: @dotclaw_bot what toppings do you recommend?
```

This allows the agent to understand the conversation context even if it wasn't mentioned in every message.

---

## Commands

### Commands Available in Any Group

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant [message]` | `@dotclaw_bot what's the weather?` | Talk to the assistant |

### Commands Available in Main Channel Only

| Command | Example | Effect |
|---------|---------|--------|
| `@Assistant add group [chat_id]` | `@dotclaw_bot add group "-987654321"` | Register a new group |
| `@Assistant remove group [name]` | `@dotclaw_bot remove group "work-team"` | Unregister a group |
| `@Assistant list groups` | `@dotclaw_bot list groups` | Show registered groups |
| `@Assistant remember [fact]` | `@dotclaw_bot remember I prefer dark mode` | Add to global memory |
| `@Assistant set model [model_id]` | `@dotclaw_bot set model moonshotai/kimi-k2.5` | Switch OpenRouter model (main only) |

DotClaw also supports explicit slash commands:

- `/dotclaw help`
- `/dotclaw groups`
- `/dotclaw add-group <chat_id> <name> [folder]`
- `/dotclaw remove-group <chat_id|name|folder>`
- `/dotclaw set-model <model> [global|group|user] [target_id]`
- `/dotclaw remember <fact>`

---

## Scheduled Tasks

DotClaw has a built-in scheduler that runs tasks as full agents in their group's context.
It supports persistent task state (`state_json`) and automatic retries with exponential backoff.

### How Scheduling Works

1. **Group Context**: Tasks created in a group run with that group's working directory and memory
2. **Full Agent Capabilities**: Scheduled tasks have access to all tools (WebSearch, file operations, etc.)
3. **Optional Messaging**: Tasks can send messages to their group using the `send_message` tool, or complete silently
4. **Main Channel Privileges**: The main channel can schedule tasks for any group and view all tasks

### Schedule Types

| Type | Value Format | Example |
|------|--------------|---------|
| `cron` | Cron expression | `0 9 * * 1` (Mondays at 9am) |
| `interval` | Milliseconds | `3600000` (every hour) |
| `once` | ISO timestamp (local, no Z) | `2026-02-02T09:00:00` |

### Creating a Task

```
User: @dotclaw_bot remind me every Monday at 9am to review the weekly metrics

Assistant: [calls mcp__dotclaw__schedule_task]
        {
          "prompt": "Send a reminder to review weekly metrics. Be encouraging!",
          "schedule_type": "cron",
          "schedule_value": "0 9 * * 1"
        }

Assistant: Done! I'll remind you every Monday at 9am.
```

### One-Time Tasks

```
User: @dotclaw_bot at 5pm today, send me a summary of today's emails

Assistant: [calls mcp__dotclaw__schedule_task]
        {
          "prompt": "Search for today's emails, summarize the important ones, and send the summary to the group.",
          "schedule_type": "once",
          "schedule_value": "2024-01-31T17:00:00Z"
        }
```

### Managing Tasks

From any group:
- `@dotclaw_bot list my scheduled tasks` - View tasks for this group
- `@dotclaw_bot pause task [id]` - Pause a task
- `@dotclaw_bot resume task [id]` - Resume a paused task
- `@dotclaw_bot cancel task [id]` - Delete a task

From main channel:
- `@dotclaw_bot list all tasks` - View tasks from all groups
- `@dotclaw_bot schedule task for "family-chat": [prompt]` - Schedule for another group

---

## MCP Servers

### DotClaw MCP (built-in)

The `dotclaw` MCP server is created dynamically per agent call with the current group's context.

**Available Tools:**
| Tool | Purpose |
|------|---------|
| `schedule_task` | Schedule a recurring or one-time task |
| `list_tasks` | Show tasks (group's tasks, or all if main) |
| `get_task` | Get task details and run history |
| `update_task` | Modify task prompt or schedule |
| `pause_task` | Pause a task |
| `resume_task` | Resume a paused task |
| `cancel_task` | Delete a task |
| `send_message` | Send a Telegram message to the chat |

---

## Deployment

DotClaw runs as a single macOS launchd service.

### Startup Sequence

When DotClaw starts, it:
1. **Validates Telegram token** - Checks TELEGRAM_BOT_TOKEN is set
2. **Ensures Docker is running** - Checks that Docker daemon is available
3. Initializes the SQLite database
4. Loads state (registered groups, sessions, router state)
5. Sets up Telegram message handlers
6. Launches Telegram bot
7. Starts the scheduler loop
8. Starts the IPC watcher for container messages

### Service: com.dotclaw

**launchd/com.dotclaw.plist:**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dotclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{NODE_PATH}}</string>
        <string>{{PROJECT_ROOT}}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
        <key>ASSISTANT_NAME</key>
        <string>Rain</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/dotclaw.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/dotclaw.error.log</string>
</dict>
</plist>
```

### Managing the Service

```bash
# Install service
cp launchd/com.dotclaw.plist ~/Library/LaunchAgents/

# Start service
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist

# Stop service
launchctl unload ~/Library/LaunchAgents/com.dotclaw.plist

# Check status
launchctl list | grep dotclaw

# View logs
tail -f logs/dotclaw.log
```

---

## Security Considerations

### Container Isolation

All agents run inside Docker containers, providing:
- **Filesystem isolation**: Agents can only access mounted directories
- **Safe Bash access**: Commands run inside the container, not on your Mac
- **Network isolation**: Can be configured per-container if needed
- **Process isolation**: Container processes can't affect the host
- **Non-root user**: Container runs as unprivileged `node` user (uid 1000)

### Prompt Injection Risk

Telegram messages could contain malicious instructions attempting to manipulate the assistant's behavior.

**Mitigations:**
- Container isolation limits blast radius
- Only registered chats are processed
- In groups, only mentions or replies are processed (reduces accidental processing)
- Agents can only access their group's mounted directories
- Main can configure additional directories per group
- Model's built-in safety training

**Recommendations:**
- Only register trusted chats
- Review additional directory mounts carefully
- Review scheduled tasks periodically
- Monitor logs for unusual activity

### Credential Storage

| Credential | Storage Location | Notes |
|------------|------------------|-------|
| OpenRouter Session Store | data/sessions/{group}/openrouter/ | Per-group isolation, mounted to /workspace/session |
| Telegram Bot Token | .env | Not mounted into containers |

### File Permissions

The groups/ folder contains personal memory and should be protected:
```bash
chmod 700 groups/
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No response to messages | Service not running | Check `launchctl list | grep dotclaw` |
| No response to messages | Chat not registered | Add chat ID to registered_groups.json |
| "Container exited with code 1" | Docker not running | Check Docker Desktop is running (macOS) or `sudo systemctl start docker` (Linux) |
| "Container exited with code 1" | Session mount path wrong | Ensure mount is to `/workspace/session` |
| Session not continuing | Session ID not saved | Check `data/sessions.json` |
| Session not continuing | Mount path mismatch | Sessions must be at `/workspace/session` |
| "Unauthorized" Telegram error | Bot token invalid | Check TELEGRAM_BOT_TOKEN in .env |

### Log Location

- `logs/dotclaw.log` - stdout
- `logs/dotclaw.error.log` - stderr

### Debug Mode

Run manually for verbose output:
```bash
npm run dev
# or
node dist/index.js
```
