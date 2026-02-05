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
      "container": {
        "mode": "daemon",
        "privileged": true,
        "instanceId": ""
      },
    "metrics": {
      "port": 3001,
      "enabled": true
    },
    "dashboard": {
      "enabled": true
    },
    "memory": {
      "embeddings": {
        "enabled": true
      }
    },
    "backgroundJobs": {
      "enabled": true,
      "maxConcurrent": 2,
      "maxRuntimeMs": 2400000,
      "progress": {
        "enabled": true,
        "startDelayMs": 30000,
        "intervalMs": 120000,
        "maxUpdates": 3
      },
      "inlineMaxChars": 8000,
      "contextModeDefault": "group",
      "autoSpawn": {
        "enabled": true,
        "foregroundTimeoutMs": 90000,
        "onTimeout": true,
        "onToolLimit": true,
        "classifier": {
          "enabled": true,
          "model": "openai/gpt-5-nano",
          "timeoutMs": 3000,
          "maxOutputTokens": 32,
          "temperature": 0,
          "confidenceThreshold": 0.6
        }
      }
    },
    "routing": {
      "enabled": true,
      "maxFastChars": 200,
      "maxStandardChars": 1200,
      "backgroundMinChars": 2000,
      "classifierFallback": { "enabled": true, "minChars": 600 },
      "plannerProbe": {
        "enabled": true,
        "model": "openai/gpt-5-nano",
        "timeoutMs": 3000,
        "maxOutputTokens": 120,
        "temperature": 0,
        "minChars": 700,
        "minSteps": 4,
        "minTools": 3
      },
      "profiles": {
        "fast": { "model": "openai/gpt-5-nano", "maxOutputTokens": 4096, "maxToolSteps": 6, "enablePlanner": false },
        "standard": { "model": "openai/gpt-5-mini", "maxOutputTokens": 4096, "maxToolSteps": 16 },
        "deep": { "model": "moonshotai/kimi-k2.5", "maxOutputTokens": 4096, "maxToolSteps": 32 },
        "background": { "model": "moonshotai/kimi-k2.5", "maxOutputTokens": 4096, "maxToolSteps": 64 }
      }
    }
  },
  "agent": {
    "assistantName": "Rain",
    "promptPacks": {
      "enabled": true
    },
    "planner": {
      "enabled": true,
      "mode": "auto"
    },
    "responseValidation": {
      "enabled": true,
      "minPromptTokens": 400,
      "minResponseTokens": 160
    },
    "tools": {
      "progress": {
        "enabled": true,
        "minIntervalMs": 30000,
        "notifyTools": ["WebSearch", "WebFetch", "Bash", "GitClone", "NpmInstall"],
        "notifyOnStart": true,
        "notifyOnError": true
      }
    }
  }
}
```

## Key sections

- `host.container` controls Docker image, timeouts, resource limits, and mode.
- `host.container.privileged` controls whether containers run in privileged mode (`true` by default).
- `host.container.instanceId` lets you run multiple DotClaw instances on the same machine by
  namespacing daemon container names.
- `host.metrics.enabled` and `host.metrics.port` expose Prometheus metrics on `http://localhost:<port>/metrics`.
- `host.dashboard.enabled` and `host.dashboard.port` serve a basic status page on `http://localhost:<port>/`.
- `host.timezone` overrides the scheduler timezone and is passed to the agent so timestamps are interpreted in the correct local time.
- `host.heartbeat` controls automated heartbeat runs (disable if you don't want background activity).
- `host.backgroundJobs` controls the background job queue (long-running async work).
- `host.messageQueue.maxRetries`, `host.messageQueue.retryBaseMs`, and `host.messageQueue.retryMaxMs` control retry behavior when queued Telegram responses fail to deliver.
- `host.routing` controls request classification, per-profile model selection, and per-profile limits.
- `host.trace.dir` and `host.promptPacksDir` control Autotune outputs.
- `host.memory.embeddings` configures optional embeddings for recall.
- `agent.assistantName` sets the assistant display name.
- `agent.promptPacks` enables prompt pack loading and canary rate.
- `agent.tools` controls access to built-in tools (bash, web search, web fetch).
- `agent.responseValidation` gates the response quality validator with minimum prompt/response sizes.
- `agent.tools.progress` controls tool-driven job progress notifications for background jobs.

## Tips

- Keep secrets out of this file.
- Match types and structure to the defaults or overrides will be ignored.
- Restart DotClaw after changes.

## Container privilege override

If you want to disable privileged containers, set:

```json
{
  "host": {
    "container": {
      "privileged": false
    }
  }
}
```

## Background jobs

`host.backgroundJobs` enables a durable background job queue for long-running tasks that should complete
asynchronously and report back when done. `autoSpawn` can promote stalled foreground requests into
background jobs automatically. The `autoSpawn.classifier` setting enables an LLM router to decide
immediately when a request should run in the background.

Example:

```json
{
  "host": {
    "backgroundJobs": {
      "enabled": true,
      "pollIntervalMs": 2000,
      "maxConcurrent": 2,
      "maxRuntimeMs": 2400000,
      "maxToolSteps": 64,
      "inlineMaxChars": 8000,
      "contextModeDefault": "group",
      "progress": {
        "enabled": true,
        "startDelayMs": 30000,
        "intervalMs": 120000,
        "maxUpdates": 3
      },
      "toolAllow": [],
      "toolDeny": ["mcp__dotclaw__schedule_task", "mcp__dotclaw__update_task", "mcp__dotclaw__pause_task", "mcp__dotclaw__resume_task", "mcp__dotclaw__cancel_task"],
      "autoSpawn": {
        "enabled": true,
        "foregroundTimeoutMs": 90000,
        "onTimeout": true,
        "onToolLimit": true,
        "classifier": {
          "enabled": true,
          "confidenceThreshold": 0.6,
          "adaptive": {
            "enabled": true,
            "minThreshold": 0.55,
            "maxThreshold": 0.65,
            "queueDepthLow": 0,
            "queueDepthHigh": 4
          }
        }
      }
    }
  }
}
```

## Routing

`host.routing` controls per-request routing profiles. Each profile can set the model, output limits, tool steps,
feature toggles (planner, validation, memory recall/extraction), and profile-specific budgets like recall limits
and response-validation retries. Use this to optimize latency and costs for simple requests while still enabling
deep work for complex prompts.

Planner probe (`host.routing.plannerProbe`) runs a lightweight planning call for borderline requests and can
promote them to background jobs if the predicted plan includes many steps or tools.

Profile fields (common):

- `model`: per-profile model override
- `maxOutputTokens`: response cap
- `maxToolSteps`: tool-call step limit
- `enablePlanner`: toggle planner
- `enableValidation`: toggle response validation
- `responseValidationMaxRetries`: per-request validation retries
- `enableMemoryRecall`: toggle recall
- `recallMaxResults`: recall item cap
- `recallMaxTokens`: recall token cap
- `enableMemoryExtraction`: toggle memory extraction
- `toolAllow` / `toolDeny`: per-profile tool policy overrides
- `progress`: optional per-profile progress settings

## Heartbeat

`host.heartbeat` controls periodic background runs for checking scheduled tasks and pending work.
Set `enabled` to `false` to disable heartbeats.
