---
title: Concepts
---

# Concepts

## Groups and chats

DotClaw treats each Telegram chat as a group with its own context and files. Group registration is stored in `~/.dotclaw/data/registered_groups.json`, and each group gets a folder under `~/.dotclaw/groups/<group-folder>`.

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

In addition to code tools, DotClaw exposes Telegram action tools (send/edit/delete messages, media, polls, buttons, etc.)
that can be allowed or denied through the same policy file.

## Scheduler

The task scheduler runs cron-based or one-off tasks and executes them in the target group's context. Scheduling uses the timezone defined in `~/.dotclaw/config/runtime.json` or the system timezone by default.

## Background jobs

Background jobs run long-lived work asynchronously and report back when finished. Jobs are durable and tracked in the database. Large outputs are written to `~/.dotclaw/groups/<group>/jobs/<job_id>/` and summarized in chat.

## Progress and planning

For long-running requests, DotClaw sends staged progress updates (planning, searching, coding, drafting, finalizing). When a lightweight planner probe detects multi-step work, progress updates and background job acknowledgements can include a short preview of the planned steps.

## Canceling requests

If a request is taking too long, you can send `cancel`, `stop`, or `abort` in the same chat to cancel the active foreground run.
