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
    "allow": ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "Bash"],
    "deny": [],
    "max_per_run": { "Bash": 4, "WebSearch": 5, "WebFetch": 6 },
    "default_max_per_run": 32
  },
  "groups": {
    "main": { "allow": ["Bash", "WebSearch", "WebFetch"] }
  },
  "users": {
    "123456789": { "deny": ["Bash"] }
  }
}
```

## Tool budgets

`~/.dotclaw/config/tool-budgets.json` sets daily limits per tool.

```json
{
  "default": {
    "per_day": {
      "WebSearch": 50,
      "WebFetch": 50,
      "Bash": 20
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

`dotclaw setup` (or `npm run init`) creates a locked-down template with
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

## Built-in DotClaw tools

DotClaw injects MCP tools prefixed with `mcp__dotclaw__...` in addition to standard coding tools.

Telegram output tools:

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

Utility:

- `mcp__dotclaw__download_url` (enabled when WebFetch is enabled)

Most send tools support `reply_to_message_id` for threaded replies.
