---
title: Concepts
---

# Concepts

## Groups and chats

DotClaw treats each messaging chat (Telegram or Discord) as a group with its own context and files. Group registration is stored in `~/.dotclaw/data/registered_groups.json`, and each group gets a folder under `~/.dotclaw/groups/<group-folder>`. Chat IDs are provider-prefixed (e.g., `telegram:123456789` or `discord:987654321`).

## Memory

DotClaw keeps long-term memory in a SQLite database at `~/.dotclaw/data/store/memory.db`. The agent automatically extracts important facts from conversations and recalls them when relevant.

Memory features:
- **Automatic extraction**: Facts, preferences, and instructions are extracted from conversations
- **Semantic search**: Optional vector embeddings for meaning-based retrieval
- **Per-group isolation**: Each group's memory is kept separate

See [Memory](/operations/memory) for configuration options.

## Containers and isolation

Each request runs inside a Docker container. The container only sees mounted directories that you explicitly allow.
By default, containers run in privileged mode for maximum in-container autonomy; you can disable this with
`host.container.privileged=false` in runtime config.

Container mode:

- `ephemeral`: a new container per request
- `daemon`: a persistent container for lower latency

## Tools and policy

Tools are governed by `~/.dotclaw/config/tool-policy.json`. You can allow or deny tools by default and override by group or user. Optional budgets in `~/.dotclaw/config/tool-budgets.json` limit daily tool usage.

In addition to code tools, DotClaw exposes messaging action tools (send/edit/delete messages, media, polls, buttons, etc.)
that can be allowed or denied through the same policy file. These tools work across all connected providers (Telegram, Discord).

## Scheduler

The task scheduler runs cron-based or one-off tasks and executes them in the target group's context. Scheduling uses the timezone defined in `~/.dotclaw/config/runtime.json` or the system timezone by default.

## Background jobs

Background jobs run long-lived work asynchronously and report back when finished. Jobs are durable and tracked in the database. Large outputs are written to `~/.dotclaw/groups/<group>/jobs/<job_id>/` and summarized in chat.

## Progress and planning

For long-running requests, DotClaw sends staged progress updates (planning, searching, coding, drafting, finalizing). When a lightweight planner probe detects multi-step work, progress updates and background job acknowledgements can include a short preview of the planned steps.

## Voice

DotClaw supports incoming voice messages and text-to-speech output. Voice messages are automatically transcribed using a configurable model (default: Gemini Flash). The agent can reply with voice using the `send_voice` or `send_audio` tools, and text-to-speech is available via Edge TTS. Configure in `host.voice` in runtime config.

## Browser automation

Containers include Chromium for browser automation via the `agent-browser` tool. The agent can navigate pages, take screenshots, fill forms, and extract data. Enable/disable via `agent.browser.enabled` in runtime config.

## MCP servers

DotClaw can connect to MCP (Model Context Protocol) servers using stdio transport. This allows the agent to use external tools provided by MCP servers. Configure servers in `agent.mcp` in runtime config.

## Hooks

Lifecycle hooks let you run custom scripts when events occur (message received, agent started, job completed, etc.). Hooks can be blocking (awaited, with optional cancellation) or async (fire-and-forget). Configure in `hooks` in runtime config.

## Orchestration

The `orchestrate` tool enables multi-agent fan-out: run multiple agent tasks in parallel with concurrency control and optional result aggregation. Useful for research, multi-perspective analysis, and divide-and-conquer workflows.

## Workflows

Declarative YAML or JSON workflows define multi-step pipelines with dependency tracking, conditional execution, retry policies, and step result interpolation. Place workflow files in `~/.dotclaw/groups/<group>/workflows/`. The agent can start, monitor, and cancel workflows via IPC tools.

## Canceling requests

If a request is taking too long, you can send `cancel`, `stop`, or `abort` in the same chat to cancel the active foreground run.
