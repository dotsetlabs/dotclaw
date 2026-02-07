---
title: Tools, Budgets, Plugins
---

# Tools, Budgets, Plugins

## Tool policy

Tool permissions live in `~/.dotclaw/config/tool-policy.json`. Policies are applied in this order:

1. Default policy
2. Group overrides
3. User overrides

Example:

```json
{
  "default": {
    "allow": [
      "Read", "Write", "Edit", "Glob", "Grep", "GitClone", "PackageInstall",
      "WebSearch", "WebFetch", "Bash", "Python", "Browser",
      "mcp__dotclaw__send_message", "mcp__dotclaw__send_file",
      "mcp__dotclaw__send_photo", "mcp__dotclaw__send_voice",
      "mcp__dotclaw__send_audio", "mcp__dotclaw__send_location",
      "mcp__dotclaw__send_contact", "mcp__dotclaw__send_poll",
      "mcp__dotclaw__send_buttons", "mcp__dotclaw__edit_message",
      "mcp__dotclaw__delete_message", "mcp__dotclaw__download_url",
      "mcp__dotclaw__text_to_speech",
      "mcp__dotclaw__schedule_task", "mcp__dotclaw__run_task",
      "mcp__dotclaw__list_tasks", "mcp__dotclaw__pause_task",
      "mcp__dotclaw__resume_task", "mcp__dotclaw__cancel_task",
      "mcp__dotclaw__update_task",
      "mcp__dotclaw__register_group", "mcp__dotclaw__remove_group",
      "mcp__dotclaw__list_groups", "mcp__dotclaw__set_model",
      "mcp__dotclaw__memory_upsert", "mcp__dotclaw__memory_forget",
      "mcp__dotclaw__memory_list", "mcp__dotclaw__memory_search",
      "mcp__dotclaw__memory_stats",
      "mcp__dotclaw__get_config", "mcp__dotclaw__set_tool_policy",
      "mcp__dotclaw__set_behavior", "mcp__dotclaw__set_mcp_config",
      "mcp__dotclaw__subagent"
    ],
    "deny": [],
    "max_per_run": { "Bash": 128, "Python": 64, "WebSearch": 40, "WebFetch": 60 },
    "default_max_per_run": 256
  }
}
```

**Warning:** Adding a `groups` override with an `allow` list restricts that group to **only** the listed tools (intersection with default). A group override like `"main": { "allow": ["Bash"] }` would block all other tools including Read, Write, and Edit. Only add group overrides when you intentionally want to restrict a group. To deny specific tools, use `deny` instead:

```json
{
  "groups": {
    "restricted-chat": { "deny": ["Bash", "Python"] }
  }
}
```

## Tool budgets

`~/.dotclaw/config/tool-budgets.json` sets daily limits per tool.

```json
{
  "default": {
    "per_day": {
      "WebSearch": 1000,
      "WebFetch": 1500,
      "Bash": 2000,
      "Python": 1500
    }
  }
}
```

You can disable budgets in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "toolBudgets": {
      "enabled": false
    }
  }
}
```

## Plugin tools

Drop JSON manifests into:

- `~/.dotclaw/groups/<group>/plugins/`
- `~/.dotclaw/groups/global/plugins/`

Example HTTP plugin:

```json
{
  "name": "github_search",
  "description": "Search GitHub repositories",
  "type": "http",
  "method": "GET",
  "url": "https://api.github.com/search/repositories",
  "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" },
  "query_params": { "q": "{{query}}", "per_page": "5" },
  "input": { "query": "string" },
  "required": ["query"]
}
```

The tool will be exposed as `plugin__github_search` and must be allowed by tool policy.

To pass secrets used by plugin manifests, set per-group env vars in
`~/.dotclaw/data/registered_groups.json` under `containerConfig.env`.
Those keys are injected into the container at runtime.

## Mount allowlist

Container mount allowlist lives outside the repo:

`~/.config/dotclaw/mount-allowlist.json`

`dotclaw setup` creates a locked-down template with
empty `allowedRoots`. Edit it to enable additional mounts.

Example:

```json
{
  "allowedRoots": [
    { "path": "~/projects", "allowReadWrite": true, "description": "Development projects" }
  ],
  "blockedPatterns": ["password", "secret", "token"],
  "nonMainReadOnly": true
}
```

## Standard coding tools

The agent has access to the following coding tools:

- `Read` — Read file contents
- `Write` — Write files
- `Edit` — Replace text in files
- `Glob` — Search for files by name pattern
- `Grep` — Search file contents by regex
- `Bash` — Run shell commands
- `Python` — Execute Python code (sandboxed inside the container)
- `WebSearch` — Search the web via Brave Search API
- `WebFetch` — Fetch and extract content from a URL
- `GitClone` — Clone a git repository
- `PackageInstall` — Install packages using pnpm
- `Browser` — In-container Chromium automation (navigate, snapshot, click, fill, screenshot, extract, evaluate, close)
- `AnalyzeImage` — Analyze an image file using a vision-capable model (uses `DOTCLAW_VISION_MODEL` env var, default: `openai/gpt-4o`)
- `Process` — Manage background processes (start, list, poll, log, write, kill, remove). Useful for long-running commands like builds, servers, or data pipelines.

## Built-in DotClaw tools

DotClaw injects MCP tools prefixed with `mcp__dotclaw__...` in addition to standard coding tools.

### Messaging

- `mcp__dotclaw__send_message` — Send a text message
- `mcp__dotclaw__send_file` — Send a file attachment
- `mcp__dotclaw__send_photo` — Send an image
- `mcp__dotclaw__send_voice` — Send a voice message
- `mcp__dotclaw__send_audio` — Send an audio file (with optional performer/title metadata)
- `mcp__dotclaw__send_location` — Send a GPS location
- `mcp__dotclaw__send_contact` — Send a contact card
- `mcp__dotclaw__send_poll` — Send a poll (supports quiz mode with `correct_option_id`)
- `mcp__dotclaw__send_buttons` — Send a message with inline keyboard buttons
- `mcp__dotclaw__edit_message` — Edit an existing message
- `mcp__dotclaw__delete_message` — Delete a message

Most send tools support `reply_to_message_id` for threaded replies.

### Scheduling

- `mcp__dotclaw__schedule_task` — Create a scheduled task (cron, interval, or one-off)
- `mcp__dotclaw__update_task` — Update a task's prompt, schedule, timezone, context_mode, state_json, or status
- `mcp__dotclaw__pause_task` — Pause a scheduled task
- `mcp__dotclaw__resume_task` — Resume a paused task
- `mcp__dotclaw__cancel_task` — Cancel and remove a task
- `mcp__dotclaw__list_tasks` — List all tasks (main group sees all; other groups see their own)
- `mcp__dotclaw__run_task` — Immediately run a scheduled task without changing its schedule

### Memory

- `mcp__dotclaw__memory_upsert` — Save durable memories. See [Memory item fields](#memory-item-fields) below.
- `mcp__dotclaw__memory_search` — Search long-term memory by query (hybrid FTS + embedding search)
- `mcp__dotclaw__memory_list` — List memory items, filtered by scope/type/userId
- `mcp__dotclaw__memory_forget` — Delete memory items by ID or content match
- `mcp__dotclaw__memory_stats` — Get memory store statistics

### Group management (main group only)

- `mcp__dotclaw__register_group` — Register a new chat group
- `mcp__dotclaw__remove_group` — Unregister a group
- `mcp__dotclaw__list_groups` — List all registered groups

### Model configuration (main group only)

- `mcp__dotclaw__set_model` — Set the active model or configure routing rules. Supports three actions:
  - `action: "set"` (default) — Set a static model. Requires `model`. Optional: `scope` (`global`/`group`/`user`), `target_id`.
  - `action: "set_routing_rules"` — Configure keyword-based model routing. Requires `scope`, `target_id`, and `routing_rules`.
  - `action: "clear_routing_rules"` — Remove all routing rules for a target. Requires `scope` and `target_id`.

Routing rules example:

```json
{
  "action": "set_routing_rules",
  "scope": "user",
  "target_id": "123456789",
  "routing_rules": [
    { "task_type": "coding", "model": "deepseek/deepseek-v3.2", "keywords": ["code", "debug", "fix"], "priority": 10 },
    { "task_type": "research", "model": "google/gemini-2.5-flash", "keywords": ["research", "search"], "priority": 5 }
  ]
}
```

### Configuration tools (main group only)

- `mcp__dotclaw__get_config` — Inspect current configuration. Optional `section` parameter: `model`, `tools`, `behavior`, `mcp`, `routing`, or `all` (default).
- `mcp__dotclaw__set_tool_policy` — Modify tool policy. Actions: `allow_tool`, `deny_tool`, `set_limit` (with `tool_name` and optional `limit`), `reset`.
- `mcp__dotclaw__set_behavior` — Adjust agent behavior: `response_style` (`concise`/`balanced`/`detailed`), `tool_calling_bias` (0-1), `caution_bias` (0-1).
- `mcp__dotclaw__set_mcp_config` — Manage MCP servers. Actions: `enable`, `disable`, `add_server` (with `name`, `command`, `args_list`, `env`), `remove_server` (with `name`). Changes take effect on next daemon restart.

### Sub-agents

- `mcp__dotclaw__subagent` — Spawn and manage sub-agent tasks that run in parallel with their own tool budgets. Actions:
  - `spawn` — Launch a sub-agent with `prompt`, optional `model`, `label`, `maxToolSteps` (default 50), `timeoutMs`
  - `list` — List all sub-agents
  - `status` — Check status of a sub-agent by `subagentId`
  - `result` — Wait for and retrieve the result of a sub-agent by `subagentId`

### Utility

- `mcp__dotclaw__download_url` — Download a file from a URL (enabled when WebFetch is enabled)
- `mcp__dotclaw__text_to_speech` — Convert text to speech audio

## Memory item fields

The `mcp__dotclaw__memory_upsert` tool accepts an array of `items`, each with:

| Field | Required | Description |
|-------|----------|-------------|
| `scope` | Yes | `user`, `group`, or `global` |
| `content` | Yes | The memory text |
| `type` | Yes | `identity`, `preference`, `fact`, `relationship`, `project`, `task`, `note`, or `archive` |
| `kind` | No | `semantic`, `episodic`, `procedural`, or `preference` |
| `subject_id` | No | User ID (for user-scoped memories) |
| `conflict_key` | No | Unique key — upserts instead of duplicating when matched |
| `importance` | No | 0-1, controls recall priority (default varies by type) |
| `confidence` | No | 0-1, extraction confidence |
| `tags` | No | Array of string tags |
| `ttl_days` | No | Auto-expire after this many days |

Optional top-level fields: `source` (extraction source label), `target_group` (store in a different group's memory).
