---
title: Behavior Config
---

# Behavior Config

`~/.dotclaw/config/behavior.json` controls how the agent behaves. These settings can be tuned manually or via Autotune optimization.

## Example

```json
{
  "tool_calling_bias": 0.5,
  "memory_importance_threshold": 0.55,
  "response_style": "balanced",
  "caution_bias": 0.5,
  "last_updated": "2026-02-04T00:00:00.000Z",
  "notes": "Optimized via Autotune"
}
```

## Fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `tool_calling_bias` | number (0-1) | 0.5 | Higher values encourage more tool usage; lower values prefer text-only responses |
| `memory_importance_threshold` | number (0-1) | 0.55 | Minimum importance score for memories to be recalled |
| `response_style` | string | "balanced" | One of: `concise`, `balanced`, `detailed` |
| `caution_bias` | number (0-1) | 0.5 | Higher values make the agent more cautious; lower values more confident |
| `last_updated` | ISO timestamp | - | When the config was last modified |
| `notes` | string | - | Optional notes about the config |

## How values work

- **tool_calling_bias**: At 0.0, the agent prefers text-only answers. At 1.0, it aggressively uses tools.
- **memory_importance_threshold**: Memories with importance below this threshold won't be recalled.
- **response_style**: `concise` keeps answers short; `balanced` is moderate; `detailed` provides thorough explanations.
- **caution_bias**: At 0.0, the agent takes more risks. At 1.0, it's highly cautious about uncertain actions.

## Adjusting via admin commands

From the main/admin Telegram chat:

```
/dotclaw style concise
/dotclaw style balanced
/dotclaw style detailed
/dotclaw tools conservative   # sets tool_calling_bias to 0.3
/dotclaw tools balanced       # sets tool_calling_bias to 0.5
/dotclaw tools proactive      # sets tool_calling_bias to 0.7
/dotclaw caution low          # sets caution_bias to 0.35
/dotclaw caution balanced     # sets caution_bias to 0.5
/dotclaw caution high         # sets caution_bias to 0.7
/dotclaw memory strict        # sets memory_importance_threshold to 0.7
/dotclaw memory balanced      # sets memory_importance_threshold to 0.55
/dotclaw memory loose         # sets memory_importance_threshold to 0.45
```

## Autotune integration

When running `npm run autotune`, behavior is optimized based on feedback (thumbs up/down reactions). Autotune writes updated values to this file and records notes about the optimization.
