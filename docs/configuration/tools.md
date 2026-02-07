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
      "mcp__dotclaw__memory_stats"
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
- `Browser` — In-container Chromium automation (navigate, screenshot, click, fill, extract)

## Built-in DotClaw tools

DotClaw injects MCP tools prefixed with `mcp__dotclaw__...` in addition to standard coding tools.

Messaging output tools:

- `mcp__dotclaw__send_message`
- `mcp__dotclaw__send_file`
- `mcp__dotclaw__send_photo`
- `mcp__dotclaw__send_voice`
- `mcp__dotclaw__send_audio`
- `mcp__dotclaw__send_location`
- `mcp__dotclaw__send_contact`
- `mcp__dotclaw__send_poll`
- `mcp__dotclaw__send_buttons`
- `mcp__dotclaw__edit_message`
- `mcp__dotclaw__delete_message`

Scheduling:

- `mcp__dotclaw__schedule_task`
- `mcp__dotclaw__update_task`
- `mcp__dotclaw__pause_task`
- `mcp__dotclaw__resume_task`
- `mcp__dotclaw__cancel_task`
- `mcp__dotclaw__list_tasks`
- `mcp__dotclaw__run_task`

Memory:

- `mcp__dotclaw__memory_upsert`
- `mcp__dotclaw__memory_search`
- `mcp__dotclaw__memory_list`
- `mcp__dotclaw__memory_forget`
- `mcp__dotclaw__memory_stats`

Group management (main group only):

- `mcp__dotclaw__register_group`
- `mcp__dotclaw__remove_group`
- `mcp__dotclaw__list_groups`
- `mcp__dotclaw__set_model`

Utility:

- `mcp__dotclaw__download_url` (enabled when WebFetch is enabled)
- `mcp__dotclaw__text_to_speech` (convert text to speech audio)

Most send tools support `reply_to_message_id` for threaded replies.
