# DotClaw

A personal OpenRouter-based assistant accessible via Telegram. Runs an OpenRouter agent runtime in isolated Docker containers with persistent memory, scheduled tasks, and web access.

Forked from [NanoClaw](https://github.com/gavrielc/nanoclaw).

## Features

- **Telegram Integration** - Chat with your assistant from your phone via Telegram bot
- **Container Isolation** - Each conversation runs in a Docker container with only explicitly mounted directories accessible
- **Persistent Memory** - Per-group `CLAUDE.md` files store context that persists across sessions
- **Scheduled Tasks** - Set up recurring or one-time tasks with cron expressions, intervals, or timestamps
- **Web Access** - Search the web (Brave) and fetch content from URLs
- **Multi-Group Support** - Register multiple Telegram chats with isolated contexts

## Requirements

- macOS or Linux
- Node.js 20+
- [Docker](https://docker.com/products/docker-desktop)
- OpenRouter API key
- Brave Search API key (for WebSearch tool)
- Telegram bot token (create via [@BotFather](https://t.me/botfather))

## Installation

```bash
git clone https://github.com/yourusername/dotclaw.git
cd dotclaw
npm install
```

### Configuration

1. Create a `.env` file with your credentials:

```bash
# Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=your_bot_token_here

# OpenRouter authentication
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=moonshotai/kimi-k2.5
# Optional attribution headers (recommended by OpenRouter)
OPENROUTER_SITE_URL=https://your-domain.example
OPENROUTER_SITE_NAME=DotClaw

# Brave Search API (for WebSearch tool)
BRAVE_SEARCH_API_KEY=your_brave_search_api_key
```

Optional memory tuning (defaults are balanced):
```bash
DOTCLAW_MAX_CONTEXT_TOKENS=200000
DOTCLAW_RECENT_CONTEXT_TOKENS=80000
DOTCLAW_MAX_OUTPUT_TOKENS=4096
DOTCLAW_SUMMARY_UPDATE_EVERY_MESSAGES=12
DOTCLAW_SUMMARY_MAX_OUTPUT_TOKENS=1200
DOTCLAW_SUMMARY_MODEL=moonshotai/kimi-k2.5
```

Optional safety/tool controls:
```bash
DOTCLAW_ENABLE_BASH=true
DOTCLAW_ENABLE_WEBSEARCH=true
DOTCLAW_ENABLE_WEBFETCH=true
DOTCLAW_WEBFETCH_ALLOWLIST=example.com,developer.mozilla.org
DOTCLAW_WEBFETCH_BLOCKLIST=localhost,127.0.0.1
```

Optional Docker hardening:
```bash
CONTAINER_PIDS_LIMIT=256
CONTAINER_MEMORY=2g
CONTAINER_CPUS=2
CONTAINER_READONLY_ROOT=true
CONTAINER_TMPFS_SIZE=64m
CONTAINER_RUN_UID=1000
CONTAINER_RUN_GID=1000
```

2. Build the Docker container:

```bash
./container/build.sh
```

3. Register your Telegram chat in `data/registered_groups.json`:

```json
{
  "YOUR_CHAT_ID": {
    "name": "main",
    "folder": "main",
    "trigger": "@Rain",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

### First Group Setup (Telegram)

To find your chat ID:

1. Message your bot (or create a group and add the bot).
2. Use @userinfobot or @get_id_bot in Telegram to get the chat ID.
3. Add the entry to `data/registered_groups.json` and restart the app.

Example entry:

```json
{
  "-123456789": {
    "name": "family-chat",
    "folder": "family-chat",
    "trigger": "@Rain",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

4. Build and run:

```bash
npm run build
npm start
```

### Quick Configure Script

You can run an interactive setup that updates `.env` and `data/model.json`:
```bash
npm run configure
```

### Bootstrap (Recommended)

For a one-shot setup (init + configure + register main chat):
```bash
npm run bootstrap
```

The bootstrap script can also run a container self-check to validate permissions and OpenRouter connectivity before you start the app.

### VPS/Linux Permissions

By default the container runs with your host UID/GID to avoid permission issues on Linux.  
If you need to override, set:
```bash
CONTAINER_RUN_UID=1000
CONTAINER_RUN_GID=1000
```

If you see permission errors, ensure the host user owns `data/` and `groups/`:
```bash
sudo chown -R $USER data/ groups/
```

### Model Switching

The active model is stored in `data/model.json` and can be updated without editing `.env`.
You can also allow chat-time switching (main group only) by using:
```
@Rain set model to moonshotai/kimi-k2.5
```

If you want to restrict which models can be used, add an allowlist in `data/model.json`:
```json
{
  "model": "moonshotai/kimi-k2.5",
  "allowlist": ["moonshotai/kimi-k2.5", "openai/gpt-4.1-mini"],
  "updated_at": "2026-02-02T00:00:00.000Z"
}
```

### Running as a Service (macOS)

```bash
# Copy and configure the launchd plist
cp launchd/com.dotclaw.plist ~/Library/LaunchAgents/

# Edit the plist to set correct paths (NODE_PATH, PROJECT_ROOT, HOME)

# Load the service
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
```

## Usage

Message your bot with the trigger word (default: `@Rain`):

```
@Rain what's the weather in New York?
@Rain remind me every Monday at 9am to check my emails
@Rain search for recent news about AI
```

In your main channel, you can manage groups and tasks:

```
@Rain list all scheduled tasks
@Rain pause task [id]
@Rain add a new group for "Family Chat" with chat ID -123456789
```

## Project Structure

```
dotclaw/
├── src/
│   ├── index.ts           # Main app: Telegram, routing, IPC
│   ├── config.ts          # Configuration constants
│   ├── container-runner.ts # Spawns Docker containers
│   ├── task-scheduler.ts  # Runs scheduled tasks
│   └── db.ts              # SQLite operations
├── container/
│   ├── Dockerfile         # Agent container image
│   ├── build.sh           # Build script
│   └── agent-runner/      # Code that runs inside containers
├── groups/
│   ├── global/CLAUDE.md   # Shared memory (read by all groups)
│   └── main/CLAUDE.md     # Main channel memory
├── data/
│   ├── registered_groups.json
│   └── sessions.json
└── store/
    └── messages.db        # SQLite database
```

## Architecture

```
Telegram (Telegraf) → SQLite → Event Handler → Docker Container (OpenRouter Agent Runtime) → Response
```

- Single Node.js process handles Telegram connection, message routing, and scheduling
- Each agent invocation spawns an isolated Docker container
- Containers communicate back via filesystem-based IPC
- Memory persists in `CLAUDE.md` files per group

## Development

```bash
npm run dev      # Run with hot reload
npm run build    # Compile TypeScript
npm run typecheck # Type check without emitting
```

## License

MIT
