---
title: Concepts
---

# Concepts

## Groups and chats

DotClaw treats each messaging chat (Telegram or Discord) as a group with its own context and files. Group registration is stored in `~/.dotclaw/data/registered_groups.json`, and each group gets a folder under `~/.dotclaw/groups/<group-folder>`. Chat IDs are provider-prefixed (e.g., `telegram:123456789` or `discord:987654321`).

## Memory

DotClaw keeps long-term memory in a SQLite database at `~/.dotclaw/data/store/memory.db`. The agent automatically extracts important facts from conversations and recalls them on demand using the `mcp__dotclaw__memory_search` tool.

Memory features:
- **Automatic extraction**: Facts, preferences, and instructions are extracted from conversations
- **Tool-based recall**: The agent searches memory when needed (not pre-injected into every prompt)
- **Hybrid search**: FTS5 keyword matching combined with optional vector embeddings for meaning-based retrieval
- **Session context**: Conversation summary, key facts, and user profile are always available in the system prompt
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

## Streaming responses

DotClaw streams agent responses in real time using edit-in-place delivery. As the model generates output, partial responses are sent to the chat and progressively updated until the final response is complete. This provides immediate feedback without waiting for the full response to generate.

## Voice

DotClaw supports incoming voice messages and text-to-speech output. Voice messages are automatically transcribed using a configurable model (default: Gemini Flash). The agent can reply with voice using the `send_voice` or `send_audio` tools, and text-to-speech is available via Edge TTS. Configure in `host.voice` in runtime config.

## Browser automation

Containers include Chromium for browser automation via the `Browser` tool. The agent can navigate pages, take screenshots, fill forms, extract data, and run JavaScript. Enable/disable via `agent.browser.enabled` in runtime config.

## MCP servers

DotClaw can connect to MCP (Model Context Protocol) servers using stdio transport. This allows the agent to use external tools provided by MCP servers. Configure servers in `agent.mcp` in runtime config.

## Hooks

Lifecycle hooks let you run custom scripts when events occur (message received, agent started, task completed, etc.). Hooks can be blocking (awaited, with optional cancellation) or async (fire-and-forget). Configure in `hooks` in runtime config.

## Model fallback chain

When the primary model fails (rate limit, outage, timeout), DotClaw automatically retries with fallback models. Configure fallbacks in `host.routing.fallbacks` — an array of model IDs tried in order. Only retryable errors (429, 5xx, timeouts, model unavailable) trigger fallback; auth errors and content policy violations fail immediately.

## Configurable reasoning

Control how much internal reasoning the model uses via `agent.reasoning.effort`: `off`, `low`, `medium`, or `high`. Higher effort produces better answers on complex questions but uses more tokens. Default is `medium`. Summary and memory extraction calls always use `low` regardless of this setting.

## Image and vision

DotClaw supports multi-modal input. When a user sends a photo, the agent receives it as base64-encoded image content alongside the text message. The agent can describe, analyze, or act on images. Supported formats: JPEG, PNG, GIF, WebP (up to 5 MB).

## Message interrupt

When `host.messageQueue.interruptOnNewMessage` is enabled (default), sending a new message while the agent is processing automatically cancels the active run and starts processing the new message. Any partial streaming response is deleted. This ensures the agent always works on the most recent request.

## Canceling requests

If a request is taking too long, you can send `cancel`, `stop`, or `abort` in the same chat to cancel the active foreground run.

## Rate limiting

DotClaw enforces a per-user rate limit of 20 messages per 60-second window. If a user exceeds this limit, their messages are silently dropped until the window resets. This prevents runaway message floods from overwhelming the agent pipeline.

## Sub-agents

The agent can spawn sub-agents that run in parallel using the `mcp__dotclaw__subagent` tool. Sub-agents get their own tool budgets and can use a different model. This is useful for parallel research, long-running computations, or tasks that benefit from a specialized model. The parent agent can check status and retrieve results asynchronously.

## Context overflow handling

When conversation history approaches the model's context window limit, DotClaw applies several strategies:

1. **Context pruning**: Old assistant messages over 4K characters are soft-trimmed (keeping the first 1500 and last 1500 characters)
2. **History turn limit**: Only the most recent 40 user turns (~80 messages) are included
3. **Context compaction**: When older messages exceed the token budget, they are summarized into a compact representation using a summary model. For very long histories, multi-part compaction splits and summarizes in segments.
4. **Emergency compaction**: If a context overflow occurs at API call time, older messages are summarized on the fly instead of being dropped

## Model cooldowns

When a model returns a rate limit (429) or server error (5xx/timeout), it enters a cooldown period (60s for rate limits, 300s for server errors). During cooldown, the model is skipped in the fallback chain unless it's the last resort. This prevents hammering an overloaded endpoint.

## Task-type routing

Per-user and per-group model selection can include keyword-based routing rules. When a message contains keywords matching a routing rule, the agent automatically uses the rule's specified model. Rules are checked in priority order. See [Model Selection](/configuration/model) for details.
