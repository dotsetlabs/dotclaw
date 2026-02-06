---
title: Memory
---

# Memory

DotClaw stores long-term memory in a SQLite database at `~/.dotclaw/data/store/memory.db`. Memory items are extracted from conversations and can be recalled when relevant to future interactions.

## Memory extraction

The agent automatically extracts important facts, preferences, and instructions from conversations. In daemon mode, extraction runs asynchronously as a fire-and-forget background task after the response is delivered. In ephemeral mode, extraction is skipped to avoid blocking the container.

## Memory recall

When processing a message, DotClaw recalls relevant memories using a combination of:

- **Keyword matching**: Fast lookup based on text overlap
- **Semantic search**: Vector embeddings for meaning-based retrieval (when enabled)

The number of recalled items is controlled by `host.memory.recall.maxResults` and `host.memory.recall.maxTokens`.

## Memory controls

In the main/admin chat:

- `/dotclaw remember <fact>` - Manually add a memory item
- `/dotclaw memory <strict|balanced|loose>` - Adjust recall sensitivity

You can also ask the assistant to recall or summarize what it knows.

## Hybrid recall

Memory recall uses a two-stage approach:

1. **FTS5 keyword search**: Full-text search over memory content for fast keyword-based retrieval
2. **Semantic embeddings** (optional): Vector similarity search using OpenAI-compatible embeddings

When both signals are available, memories that appear in both keyword and semantic results are boosted in the final ranking. This hybrid approach improves recall accuracy compared to either method alone.

Enable embeddings in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "memory": {
      "embeddings": {
        "enabled": true
      }
    }
  }
}
```

The embedding worker runs in the background and processes new memory items asynchronously.

## Per-group isolation

Memory items are tagged with their source group. Each group's agent only sees memory from:
- Its own group
- Memory explicitly shared across groups

This maintains privacy boundaries between different chats.
