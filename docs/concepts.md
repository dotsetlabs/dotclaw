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

Containers include Chromium for browser automation via the `agent-browser` tool. The agent can navigate pages, take screenshots, fill forms, and extract data. Enable/disable via `agent.browser.enabled` in runtime config.

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
