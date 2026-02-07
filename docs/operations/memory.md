---
title: Memory
---

# Memory

DotClaw stores long-term memory in a SQLite database at `~/.dotclaw/data/store/memory.db`. Memory items are extracted from conversations and can be recalled when relevant to future interactions.

## Memory extraction

The agent automatically extracts important facts, preferences, and instructions from conversations. In daemon mode, extraction runs asynchronously as a fire-and-forget background task after the response is delivered. In ephemeral mode, extraction is skipped to avoid blocking the container.

## Memory recall

Memory recall is **tool-based**: the agent calls the `mcp__dotclaw__memory_search` tool on demand when it needs to recall past conversations, preferences, or stored knowledge. This approach keeps memory out of the system prompt (preventing context bloat from irrelevant memories) and lets the agent decide when recall is needed.

The system prompt instructs the agent to search memory before answering questions about prior decisions, dates, people, projects, or anything not visible in the current conversation. Session-level context (conversation summary, key facts, user profile) is always pre-injected into the system prompt for continuity.

The memory search tool uses hybrid recall combining:

- **FTS5 keyword search**: Fast full-text search over memory content
- **Semantic embeddings** (optional): Vector similarity search for meaning-based retrieval

Results are filtered by `host.memory.recall.minScore` (default: 0.35) and limited by `host.memory.recall.maxResults` and `host.memory.recall.maxTokens`.

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

## Memory taxonomy

Each memory item has structured metadata:

**Scope** — who the memory belongs to:
- `user` — Specific to one user (requires `subject_id`)
- `group` — Shared within a group
- `global` — Available across all groups

**Type** — what the memory represents:
- `identity` — Who someone is
- `preference` — User preferences and settings
- `fact` — Factual information
- `relationship` — Connections between entities
- `project` — Project context and details
- `task` — Task-related information
- `note` — General notes
- `archive` — Archived/historical data

**Kind** (optional) — how the memory is structured:
- `semantic` — Factual knowledge
- `episodic` — Event-based (what happened)
- `procedural` — How-to knowledge
- `preference` — User preferences

**Other fields:**
- `conflict_key` — When set, upserts update existing items with the same key instead of creating duplicates
- `importance` (0-1) — Controls recall priority
- `ttl_days` — Auto-expire after the specified number of days
- `target_group` — Store in a different group's memory

See [Tools: Memory item fields](/configuration/tools#memory-item-fields) for the full field reference.

## Per-group isolation

Memory items are tagged with their source group. Each group's agent only sees memory from:
- Its own group
- Memory explicitly shared across groups (global scope)

This maintains privacy boundaries between different chats.
