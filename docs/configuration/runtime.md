---
title: Runtime Config
---

# Runtime Config

`~/.dotclaw/config/runtime.json` contains non-secret runtime overrides. Defaults are defined in `src/runtime-config.ts` and merged at startup.

## Example

```json
{
  "host": {
    "logLevel": "info",
    "defaultModel": "moonshotai/kimi-k2.5",
    "container": {
      "mode": "daemon",
      "privileged": true,
      "instanceId": ""
    },
    "telegram": { "enabled": true },
    "discord": { "enabled": false },
    "metrics": { "port": 3001, "enabled": true },
    "dashboard": { "enabled": true },
    "memory": { "embeddings": { "enabled": true } },
    "routing": {
      "model": "moonshotai/kimi-k2.5",
      "fallbacks": [],
      "maxOutputTokens": 0,
      "maxToolSteps": 200,
      "temperature": 0.6
    }
  },
  "agent": {
    "assistantName": "Rain"
  }
}
```

## Tips

- Keep secrets out of this file — use `~/.dotclaw/.env` for tokens and API keys.
- Types and structure must match the defaults or overrides will be ignored.
- Restart DotClaw after changes.

---

## Host settings

### `host` (general)

| Setting | Default | Description |
|---------|---------|-------------|
| `logLevel` | `"info"` | Log level: `debug`, `info`, `warn`, `error` |
| `defaultModel` | `"moonshotai/kimi-k2.5"` | Default OpenRouter model for requests |
| `timezone` | System TZ | Timezone for scheduler and agent timestamps |
| `bind` | `"127.0.0.1"` | Bind address for metrics and dashboard servers |

### `host.telegram`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable/disable the Telegram provider |
| `sendRetries` | `3` | Retry attempts for failed message sends |
| `sendRetryDelayMs` | `1000` | Base delay between send retries (ms) |
| `handlerTimeoutMs` | auto | Handler timeout; auto-calculated from container timeout + 30s |

### `host.discord`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable/disable the Discord provider |
| `sendRetries` | `3` | Retry attempts for failed message sends |
| `sendRetryDelayMs` | `1000` | Base delay between send retries (ms) |

### `host.container`

| Setting | Default | Description |
|---------|---------|-------------|
| `image` | `"dotclaw-agent:latest"` | Docker image name |
| `timeoutMs` | `900000` (15m) | Maximum container run time |
| `maxOutputBytes` | `20971520` (20 MB) | Maximum output size from container |
| `mode` | `"daemon"` | `daemon` (persistent) or `ephemeral` (per-request) |
| `privileged` | `true` | Run containers with `--privileged` |
| `daemonPollMs` | `200` | Daemon IPC poll interval |
| `pidsLimit` | `256` | Maximum PIDs in container |
| `memory` | `""` | Docker memory limit (e.g. `"512m"`) |
| `cpus` | `""` | Docker CPU limit (e.g. `"2"`) |
| `readOnlyRoot` | `false` | Read-only root filesystem |
| `tmpfsSize` | `"64m"` | tmpfs size when using read-only root |
| `runUid` | auto | UID for container process (defaults to host user's UID) |
| `runGid` | auto | GID for container process (defaults to host user's GID) |
| `instanceId` | `""` | Namespace for daemon container names (multi-instance) |
| `daemonHeartbeatIntervalMs` | `1000` | How often the daemon container writes heartbeat files |

### `host.container.daemon`

| Setting | Default | Description |
|---------|---------|-------------|
| `heartbeatMaxAgeMs` | `30000` | Maximum heartbeat age before daemon is considered stale |
| `healthCheckIntervalMs` | `20000` | How often the host checks daemon health |
| `gracePeriodMs` | `10000` | Grace period for `docker stop` |

### `host.concurrency`

| Setting | Default | Description |
|---------|---------|-------------|
| `maxAgents` | `4` | Maximum concurrent agent containers |
| `queueTimeoutMs` | `0` | Maximum queue wait time (0 = no timeout) |
| `warmStart` | `true` | Keep daemon containers warm between requests |

### `host.messageQueue`

| Setting | Default | Description |
|---------|---------|-------------|
| `batchWindowMs` | `2000` | Window to batch rapid messages into one agent run |
| `maxBatchSize` | `50` | Maximum messages per batch |
| `stalledTimeoutMs` | `300000` (5m) | Timeout for stalled messages |
| `maxRetries` | `4` | Maximum retries for failed messages |
| `retryBaseMs` | `3000` | Base delay between retries |
| `retryMaxMs` | `60000` | Maximum retry delay |
| `interruptOnNewMessage` | `true` | Auto-cancel the active run when a new message arrives in the same chat |

### `host.scheduler`

| Setting | Default | Description |
|---------|---------|-------------|
| `pollIntervalMs` | `60000` (1m) | How often scheduled tasks are checked |
| `taskMaxRetries` | `3` | Maximum retries for failed tasks |
| `taskRetryBaseMs` | `60000` (1m) | Base delay between task retries |
| `taskRetryMaxMs` | `3600000` (1h) | Maximum task retry delay |
| `taskTimeoutMs` | `900000` (15m) | Maximum task execution time |

### `host.ipc`

| Setting | Default | Description |
|---------|---------|-------------|
| `pollIntervalMs` | `1000` | IPC file watcher poll interval |

### `host.maintenance`

| Setting | Default | Description |
|---------|---------|-------------|
| `intervalMs` | `21600000` (6h) | How often maintenance runs (cleanup, pruning, vacuum) |

### `host.memory`

#### `host.memory.recall`

| Setting | Default | Description |
|---------|---------|-------------|
| `maxResults` | `8` | Maximum memory items returned per recall query |
| `maxTokens` | `1000` | Maximum tokens for recalled memory content |
| `minScore` | `0.35` | Minimum relevance score threshold (0-1) for memory recall |

#### `host.memory.embeddings`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable embedding-based semantic recall |
| `provider` | `"local"` | Embedding provider: `local` or `openrouter` |
| `model` | `"openai/text-embedding-3-small"` | OpenRouter embedding model |
| `localModel` | `"Xenova/all-MiniLM-L6-v2"` | Local embedding model (ONNX) |
| `batchSize` | `8` | Batch size for embedding generation |
| `minItems` | `50` | Minimum memory items before embeddings are used |
| `minQueryChars` | `40` | Minimum query length to trigger embedding recall |
| `maxCandidates` | `1500` | Maximum candidate items for embedding search |
| `weight` | `0.6` | Embedding score weight vs FTS score in hybrid recall |
| `intervalMs` | `600000` (10m) | Background embedding generation interval |
| `maxBacklog` | `1000` | Maximum pending items in embedding queue |
| `queryCacheTtlMs` | `600000` (10m) | Query result cache TTL |
| `queryCacheMax` | `200` | Maximum cached queries |

#### `host.memory.maintenance`

| Setting | Default | Description |
|---------|---------|-------------|
| `maxItems` | `5000` | Maximum total memory items before pruning |
| `pruneImportanceThreshold` | `0.3` | Items below this importance are pruned first |
| `vacuumEnabled` | `true` | Run SQLite VACUUM periodically |
| `vacuumIntervalDays` | `7` | Days between VACUUM runs |
| `analyzeEnabled` | `true` | Run SQLite ANALYZE periodically |

#### `host.memory` (other)

| Setting | Default | Description |
|---------|---------|-------------|
| `personalizationCacheMs` | `300000` (5m) | TTL for cached per-user personalization data |

### `host.voice`

#### `host.voice.transcription`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable voice message transcription |
| `model` | `"google/gemini-2.5-flash"` | Transcription model (via OpenRouter) |
| `language` | `""` | Language hint (empty = auto-detect) |
| `maxDurationSec` | `300` | Maximum voice message duration |

#### `host.voice.tts`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable text-to-speech |
| `model` | `"edge-tts"` | TTS engine |
| `defaultVoice` | `"en-US-AriaNeural"` | Default voice |

### `host.progress`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Send progress messages during long agent runs |
| `initialMs` | `12000` | Delay before first progress message |
| `intervalMs` | `45000` | Interval between progress messages |
| `maxUpdates` | `3` | Maximum progress messages per request |
| `messages` | `[]` | Custom progress message templates (random selection) |

### `host.metrics`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Expose Prometheus metrics endpoint |
| `port` | `3001` | Metrics server port (`http://localhost:<port>/metrics`) |

### `host.dashboard`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Serve status dashboard |
| `port` | `3002` | Dashboard server port |

### `host.heartbeat`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable periodic background runs |
| `intervalMs` | `3600000` (1h) | Interval between heartbeat runs |
| `groupFolder` | `"main"` | Group folder to use for heartbeat runs |

### `host.trace`

| Setting | Default | Description |
|---------|---------|-------------|
| `sampleRate` | `1` | Fraction of requests to trace (0-1) |
| `retentionDays` | `14` | Days to keep trace files |

### `host.toolBudgets`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable per-tool daily usage limits |

### `host.tokenEstimate`

| Setting | Default | Description |
|---------|---------|-------------|
| `tokensPerChar` | `0.25` | Estimated tokens per character |
| `tokensPerMessage` | `3` | Token overhead per message |
| `tokensPerRequest` | `0` | Additional token overhead per request |

### `host.routing`

`host.routing` controls the model and parameters used for all requests. A single flat configuration replaces the previous routing profiles.

| Setting | Default | Description |
|---------|---------|-------------|
| `model` | `"moonshotai/kimi-k2.5"` | Model for all requests |
| `fallbacks` | `[]` | Fallback models tried in order when the primary model fails (e.g. rate limit, outage) |
| `allowedModels` | `[]` | Restrict which models can be selected. Empty = allow all. The primary model is always kept regardless of this list. |
| `maxOutputTokens` | `0` | Maximum output tokens per response. `0` = auto (use model's native limit from OpenRouter API, cached 24h) |
| `maxToolSteps` | `200` | Maximum tool-call steps per request |
| `temperature` | `0.6` | Sampling temperature |
| `recallMaxResults` | `8` | Maximum memory items returned per recall query |
| `recallMaxTokens` | `1500` | Maximum tokens for recalled memory content |

### `host.streaming`

`host.streaming` controls real-time streaming delivery of agent responses with edit-in-place updates.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable streaming responses |
| `chunkFlushIntervalMs` | `200` | Interval between flushing accumulated chunks (ms) |
| `editIntervalMs` | `400` | Minimum interval between message edits (ms) |
| `maxEditLength` | `3800` | Maximum message length before truncating edits |

### `host.webhook`

Optional HTTP endpoint for programmatic agent invocation.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `false` | Enable the webhook endpoint |
| `port` | `3003` | Webhook server port |
| `token` | `""` | Bearer token for authentication (required when enabled) |

When enabled, POST to `http://localhost:<port>/webhook/<groupFolder>` with a JSON body. Include the token as `Authorization: Bearer <token>`.

Request body:

```json
{
  "message": "Your prompt text (required)",
  "userId": "optional-user-id",
  "metadata": { "key": "optional metadata" }
}
```

Response:

```json
{
  "status": "success",
  "result": "Agent's response text",
  "model": "moonshotai/kimi-k2.5"
}
```

A health check endpoint is available at `GET /webhook/health`.

---

## Agent settings

### `agent` (general)

| Setting | Default | Description |
|---------|---------|-------------|
| `assistantName` | `"Rain"` | Assistant display name |

### `agent.reasoning`

| Setting | Default | Description |
|---------|---------|-------------|
| `effort` | `"medium"` | Reasoning effort for the primary model: `off`, `low`, `medium`, `high`. Higher effort uses more reasoning tokens for better quality on complex questions. Summary and memory calls always use `low`. |

### `agent.skills`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable skill discovery and loading |
| `maxSkills` | `32` | Maximum skills to load per request |
| `maxSummaryChars` | `4000` | Maximum characters per skill summary in the catalog |
| `installEnabled` | `true` | Allow skill installation from agent |

### `agent.openrouter`

| Setting | Default | Description |
|---------|---------|-------------|
| `timeoutMs` | `180000` (3m) | OpenRouter API timeout |
| `retry` | `true` | Retry failed API calls |

### `agent.context`

These are fallback defaults. When model capabilities are available (fetched from OpenRouter API, cached 24h), the container automatically derives `maxContextTokens`, `compactionTriggerTokens`, and `maxContextMessageTokens` from the model's actual context window. Set explicit values here to override model-derived limits.

| Setting | Default | Description |
|---------|---------|-------------|
| `maxContextTokens` | `128000` | Maximum context window tokens (auto-derived from model capabilities) |
| `compactionTriggerTokens` | `120000` | Token count that triggers context compaction (auto-derived) |
| `recentContextTokens` | `0` (auto) | Tokens reserved for recent conversation history. `0` = auto (50% of the model's context window, e.g. ~64K on a 128K model). Set an explicit value to override. |
| `summaryUpdateEveryMessages` | `20` | Messages between summary updates |
| `maxOutputTokens` | `8192` | Default max output tokens |
| `summaryMaxOutputTokens` | `2048` | Max tokens for summary generation |
| `temperature` | `0.6` | Default temperature |
| `maxContextMessageTokens` | `4000` | Max tokens per individual message (auto-derived) |
| `maxHistoryTurns` | `40` | Maximum user turns to include in conversation history. Counts user messages (not total messages), so `40` means ~80 messages including assistant replies. |
| `contextPruning.softTrimMaxChars` | `4000` | Maximum characters before soft-trimming old assistant messages |
| `contextPruning.softTrimHeadChars` | `1500` | Characters to keep from the start when trimming |
| `contextPruning.softTrimTailChars` | `1500` | Characters to keep from the end when trimming |
| `contextPruning.keepLastAssistant` | `10` | Number of recent assistant messages to protect from trimming |

### `agent.memory`

| Setting | Default | Description |
|---------|---------|-------------|
| `maxResults` | `4` | Maximum memory items per recall |
| `maxTokens` | `2000` | Maximum tokens for recalled memory |
| `archiveSync` | `true` | Sync memories to archive files |
| `extractScheduled` | `false` | Extract memories from scheduled task runs |

#### `agent.memory.extraction`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable automatic memory extraction |
| `async` | `true` | Extract asynchronously (non-blocking) |
| `maxMessages` | `4` | Messages to analyze per extraction |
| `maxOutputTokens` | `1024` | Max tokens for extraction output |

### `agent.models`

Sub-models used for auxiliary tasks:

| Setting | Default | Description |
|---------|---------|-------------|
| `summary` | `"deepseek/deepseek-v3.2"` | Context summary model |
| `memory` | `"deepseek/deepseek-v3.2"` | Memory extraction model |

### `agent.tools`

| Setting | Default | Description |
|---------|---------|-------------|
| `maxToolSteps` | `200` | Default tool step limit |
| `outputLimitBytes` | `400000` | Maximum tool output size |
| `enableBash` | `true` | Enable Bash tool |
| `enableWebSearch` | `true` | Enable WebSearch tool |
| `enableWebFetch` | `true` | Enable WebFetch tool |
| `grepMaxFileBytes` | `1000000` | Maximum file size for Grep tool |

#### `agent.tools.webfetch`

| Setting | Default | Description |
|---------|---------|-------------|
| `blockPrivate` | `true` | Block private/internal IP ranges |
| `allowlist` | `[]` | Allowed domains (overrides blocklist) |
| `blocklist` | `["localhost", "127.0.0.1"]` | Blocked domains |
| `maxBytes` | `300000` | Maximum response size |
| `timeoutMs` | `20000` | Fetch timeout |

#### `agent.tools.websearch`

| Setting | Default | Description |
|---------|---------|-------------|
| `timeoutMs` | `20000` | Web search timeout |

#### `agent.tools.bash`

| Setting | Default | Description |
|---------|---------|-------------|
| `timeoutMs` | `600000` (10m) | Bash command timeout |
| `outputLimitBytes` | `200000` | Maximum Bash output size |

#### `agent.tools.plugin`

| Setting | Default | Description |
|---------|---------|-------------|
| `dirs` | `[]` | Plugin tool directories |
| `maxBytes` | `800000` | Maximum plugin output size |
| `httpTimeoutMs` | `20000` | HTTP plugin timeout |

#### `agent.tools.progress`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Send progress notifications during long tool operations |
| `minIntervalMs` | `15000` | Minimum interval between progress notifications |
| `notifyTools` | `["Bash", "WebFetch", "Browser"]` | Tools that trigger progress notifications |
| `notifyOnStart` | `false` | Notify when a tool call starts |
| `notifyOnError` | `true` | Notify when a tool call errors |

#### `agent.tools.toolSummary`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Summarize large tool outputs |
| `maxBytes` | `60000` | Threshold for summarization |
| `maxOutputTokens` | `1024` | Maximum tokens for the summarized output |
| `tools` | `["WebFetch"]` | Tools eligible for summarization |

### `agent.promptPacks`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable prompt pack loading from Autotune |
| `maxChars` | `6000` | Maximum chars per prompt pack |
| `maxDemos` | `4` | Maximum demo examples per pack |
| `canaryRate` | `0.1` | Fraction of requests using canary packs |

### `agent.tts`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable agent-side TTS |
| `model` | `"edge-tts"` | TTS engine |
| `defaultVoice` | `"en-US-AriaNeural"` | Default voice |
| `provider` | `"edge-tts"` | TTS provider: `edge-tts` or `openai` |
| `openaiModel` | `"tts-1"` | OpenAI TTS model (when provider is `openai`) |
| `openaiVoice` | `"alloy"` | OpenAI voice name (when provider is `openai`) |

### `agent.browser`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable in-container Chromium automation |
| `timeoutMs` | `30000` | Navigation timeout |
| `screenshotQuality` | `80` | JPEG quality for screenshots |

### `agent.mcp`

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable MCP server connections |
| `connectionTimeoutMs` | `10000` | Connection timeout |
| `servers` | `[]` | Array of MCP server configs |

Each server entry:

```json
{
  "name": "my-server",
  "transport": "stdio",
  "command": "node",
  "args": ["path/to/server.js"],
  "env": { "API_KEY": "..." }
}
```

### `agent.process`

| Setting | Default | Description |
|---------|---------|-------------|
| `maxSessions` | `16` | Maximum concurrent process sessions |
| `maxOutputBytes` | `1048576` (1 MB) | Maximum output size per process |
| `defaultTimeoutMs` | `1800000` (30m) | Default timeout for process sessions |

### `agent.ipc`

| Setting | Default | Description |
|---------|---------|-------------|
| `requestTimeoutMs` | `30000` | IPC request timeout |
| `requestPollMs` | `150` | IPC response poll interval |

### `agent.tokenEstimate`

| Setting | Default | Description |
|---------|---------|-------------|
| `tokensPerChar` | `0.25` | Estimated tokens per character |
| `tokensPerMessage` | `3` | Token overhead per message |
| `tokensPerRequest` | `0` | Additional token overhead per request |

---

## Hooks

`hooks` controls lifecycle event scripts:

```json
{
  "hooks": {
    "enabled": true,
    "maxConcurrent": 4,
    "defaultTimeoutMs": 5000,
    "scripts": [
      {
        "event": "message:received",
        "command": "~/scripts/log-message.sh",
        "blocking": false,
        "timeoutMs": 3000
      }
    ]
  }
}
```

Supported events: `message:received`, `message:processing`, `message:responded`, `agent:start`, `agent:complete`, `task:fired`, `task:completed`, `memory:upserted`.

| Setting | Default | Description |
|---------|---------|-------------|
| `hooks.enabled` | `true` | Enable lifecycle hooks |
| `hooks.maxConcurrent` | `4` | Maximum concurrent hook executions. Additional hooks are silently dropped when the limit is reached. |
| `hooks.defaultTimeoutMs` | `5000` | Default timeout for hook scripts |

Hook scripts receive the event payload as JSON on stdin. The `DOTCLAW_HOOK_EVENT` environment variable is set to the event name (e.g., `message:received`).

Blocking hooks can return `{"cancel": true}` on stdout to abort the operation. Non-blocking hooks run as fire-and-forget.
