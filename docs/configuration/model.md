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
- `overrides` sets per-model runtime overrides.
- `per_group` and `per_user` override the default for specific groups or users.

## Updating the model

- Use `npm run configure` to update the default model and allowlist.
- From Telegram (main/admin chat), you can set models with commands like:

```
set model to moonshotai/kimi-k2.5
set model to deepseek/deepseek-v3.2 for group main
set model to moonshotai/kimi-k2.5 for user 123456789
```

