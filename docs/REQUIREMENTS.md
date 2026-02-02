# DotClaw Requirements

Original requirements and design decisions from the project creator.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

DotClaw gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in Docker containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

On Linux/VPS, containers run with the host UID/GID by default so file permissions work out-of-the-box while keeping isolation intact.

### Built for One User

This isn't a framework or a platform. It's working software for my specific needs. I use Telegram, so it supports Telegram. I add the integrations I actually want, not every possible integration.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - the assistant guides the setup. I don't need a monitoring dashboard - I ask the assistant what's happening. I don't need elaborate logging UIs - I ask the assistant to read the logs. I don't need debugging tools - I describe the problem and the assistant fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because the assistant is always there.

### Skills Over Features

When people contribute, they shouldn't add "Slack support alongside Telegram." They should contribute a skill like `/add-slack` that transforms the codebase. Users fork the repo, run skills to customize, and end up with clean code that does exactly what they need - not a bloated system trying to support everyone's use case simultaneously.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-whatsapp` - Add WhatsApp as an input channel
- `/add-sms` - Add SMS via Twilio or similar

### Container Runtime
The project uses Docker for cross-platform support (macOS and Linux).

### Platform Support
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal OpenRouter-based assistant accessible via Telegram, with minimal custom code.

**Core components:**
- **OpenRouter SDK** as the core agent with model switching
- **Docker** for isolated agent execution
- **Telegram** as the primary I/O channel
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run the agent and can message back
- **Web access** for search and browsing
- **Browser automation** via agent-browser

**Implementation approach:**
- Use existing tools (Telegram bot API, OpenRouter SDK, IPC tools)
- Minimal glue code
- File-based systems where possible (CLAUDE.md for memory, folders for groups)

---

## Architecture Decisions

### Message Routing
- A router listens to Telegram and routes messages based on configuration
- Only messages from registered chats are processed
- Trigger: `@Rain` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered chats are silently ignored

### Memory System
- **Per-group memory**: Each group has a folder with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all groups, but only writable from "main" (personal chat)
- **Files**: Groups can create/read files in their folder and reference them
- Agent runs in the group's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each group maintains a conversation session (DotClaw-managed)
- Sessions auto-compact when context gets too long, preserving critical information

### Container Isolation
- All agents run inside Docker containers
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation - agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser with Chromium in the container

### Scheduled Tasks
- Users can ask the assistant to schedule recurring or one-time tasks from any group
- Tasks run as full agents in the context of the group that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their group via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any group, view/manage all tasks
- From other groups: can only manage that group's tasks

### Group Management
- New groups are added explicitly via the main channel
- Groups are registered by editing `data/registered_groups.json`
- Each group gets a dedicated folder under `groups/`
- Groups can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control group (typically your personal Telegram chat)
- Can write to global memory (`groups/CLAUDE.md`)
- Can schedule tasks for any group
- Can view and manage tasks from all groups
- Can configure additional directory mounts for any group

---

## Integration Points

### Telegram
- Using Telegraf library for Telegram Bot API
- Messages stored in SQLite, processed via event handler
- Bot token authentication via @BotFather

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `dotclaw` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute the OpenRouter agent runtime in containerized group context

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard agent capabilities (tools, web access, browser automation)

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Customization

### Philosophy
- Minimal configuration files
- Setup and customization done via the assistant
- Users clone the repo and run the assistant to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, configure Telegram bot, start services
- `/customize` - General-purpose skill for adding capabilities (new channels, new integrations, behavior changes)

### Deployment
- Runs on local Mac via launchd
- Single Node.js process handles everything

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Rain` (case insensitive)
- **Response prefix**: None (Telegram bots send as themselves)
- **Persona**: Default assistant (no custom personality)
- **Main channel**: Personal Telegram chat with the bot

---

## Project Name

**DotClaw** - A reference to Clawdbot (now OpenClaw).
