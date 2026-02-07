---
title: Model Selection
---

# Model Selection

Model selection is stored in `~/.dotclaw/config/model.json`.

## Example

```json
{
  "model": "moonshotai/kimi-k2.5",
  "allowlist": [
    "moonshotai/kimi-k2.5",
    "deepseek/deepseek-v3.2",
    "google/gemini-2.5-flash"
  ],
  "overrides": {
    "moonshotai/kimi-k2.5": {
      "context_window": 32000,
      "max_output_tokens": 2048
    }
  },
  "per_group": {
    "main": { "model": "deepseek/deepseek-v3.2" }
  },
  "per_user": {
    "123456789": { "model": "moonshotai/kimi-k2.5" }
  },
  "updated_at": "2026-02-04T00:00:00.000Z"
}
```

## How it works

- `model` sets the global default.
- `allowlist` restricts selectable models. Empty or missing means allow all.
- `overrides` sets per-model runtime overrides (e.g. context window, max output tokens).
- `per_group` and `per_user` override the default for specific groups or users.

## Resolution cascade

Model resolution follows a priority cascade (highest wins):

1. `routing.model` from runtime.json (base default)
2. `model` in model.json (global override)
3. `per_group` override for the current group
4. `per_user` override for the current user
5. Routing rules (keyword-based, see below)

The allowlist is enforced at each level — if a resolved model isn't in the allowlist, it falls back to the next level.

## Task-type routing rules

Per-user and per-group entries can include `routing_rules` for automatic model selection based on message content:

```json
{
  "per_user": {
    "123456789": {
      "model": "moonshotai/kimi-k2.5",
      "routing_rules": [
        { "task_type": "coding", "model": "deepseek/deepseek-v3.2", "keywords": ["code", "debug", "fix", "implement"], "priority": 10 },
        { "task_type": "research", "model": "google/gemini-2.5-flash", "keywords": ["research", "search", "find"], "priority": 5 }
      ]
    }
  }
}
```

Rules are matched by scanning the message text for keywords (case-insensitive). Higher priority rules are checked first. If no rule matches, the default model for that user/group is used. The matched model must pass the allowlist.

## Updating the model

- Use `npm run configure` to update the default model and allowlist.
- From Telegram (main/admin chat), you can set models with commands like:

```
set model to moonshotai/kimi-k2.5
set model to deepseek/deepseek-v3.2 for group main
set model to moonshotai/kimi-k2.5 for user 123456789
```

