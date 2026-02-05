# DotClaw

Personal OpenRouter-based assistant for Telegram. Each request runs inside an isolated Docker container with long-term memory, scheduling, and tool governance.

## Features

- Telegram bot interface with per-group isolation
- Containerized agent runtime with strict mounts
- Rich Telegram I/O tools (file/photo/voice/audio/location/contact/poll/buttons/edit/delete)
- Incoming media ingestion to workspace (`/workspace/group/inbox`) for agent processing
- Long-term memory with embeddings and semantic search
- Scheduled tasks (cron and one-off)
- Background jobs for long-running work
- Tool policies and daily budgets
- Plugin tools and Autotune optimization
- Prometheus-compatible metrics

## Prerequisites

- Node.js 20+
- Docker (running)
- Telegram bot token (from @BotFather)
- OpenRouter API key

## Quick Start

```bash
# Clone and install
git clone <repo-url>
cd dotclaw
npm install

# Interactive setup (prompts for API keys, registers your main chat)
npm run bootstrap

# Build and start
npm run build
npm start
```

The bootstrap will create configuration in `~/.dotclaw/` and optionally build the Docker image.

## CLI Commands

After installation, use the `dotclaw` CLI:

```bash
dotclaw setup        # Full setup (init + configure + build + install service)
dotclaw configure    # Re-configure API keys and model
dotclaw start        # Start the service
dotclaw stop         # Stop the service
dotclaw restart      # Restart the service
dotclaw logs         # View logs (add --follow to tail)
dotclaw status       # Show service status
dotclaw doctor       # Run diagnostics
dotclaw register     # Register a new Telegram chat
dotclaw unregister   # Remove a registered Telegram chat
dotclaw groups       # List registered Telegram chats
dotclaw build        # Build the Docker container image
dotclaw add-instance # Create and start an isolated instance
dotclaw instances    # List discovered instances
dotclaw version      # Show installed version
```

Instance flags:

```bash
dotclaw status --id dev   # Run against a specific instance (~/.dotclaw-dev)
dotclaw restart --all     # Restart all instances
```

## Configuration

All configuration and data is stored in `~/.dotclaw/`:

```
~/.dotclaw/
  .env                    # Secrets (Telegram, OpenRouter keys)
  config/
    runtime.json          # Runtime overrides
    model.json            # Model selection
    behavior.json         # Agent behavior tuning
    tool-policy.json      # Tool allow/deny rules
    tool-budgets.json     # Daily tool limits
  data/
    registered_groups.json
    store/                # SQLite databases
  groups/
    main/CLAUDE.md        # Main group memory
    global/CLAUDE.md      # Global memory
  logs/
  groups/<group>/logs/    # Per-group container logs
```

Mount allowlist (for additional container mounts) lives at:

```
~/.config/dotclaw/mount-allowlist.json
```

## Documentation

Full documentation lives in `docs/`. View it locally:

```bash
npm run docs:dev
```

Or see:
- Getting started: `docs/getting-started/quickstart.md`
- Configuration: `docs/configuration/index.md`
- Operations: `docs/operations/index.md`

## Development

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
npm run lint         # Run ESLint
npm test             # Run tests
./container/build.sh # Rebuild agent container
```

## License

MIT
