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
      "mode": "daemon"
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
      "inlineMaxChars": 8000,
      "contextModeDefault": "group",
      "autoSpawn": {
        "enabled": true,
        "foregroundTimeoutMs": 180000,
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
    }
  }
}
```

## Key sections

- `host.container` controls Docker image, timeouts, resource limits, and mode.
- `host.metrics.enabled` and `host.metrics.port` expose Prometheus metrics on `http://localhost:<port>/metrics`.
- `host.dashboard.enabled` serves a basic status page on `http://localhost:<port+1>/`.
- `host.timezone` overrides the scheduler timezone.
- `host.heartbeat` controls automated heartbeat runs (disable if you don't want background activity).
- `host.backgroundJobs` controls the background job queue (long-running async work).
- `host.trace.dir` and `host.promptPacksDir` control Autotune outputs.
- `host.memory.embeddings` configures optional embeddings for recall.
- `agent.assistantName` sets the assistant display name.
- `agent.promptPacks` enables prompt pack loading and canary rate.
- `agent.tools` controls access to built-in tools (bash, web search, web fetch).

## Tips

- Keep secrets out of this file.
- Match types and structure to the defaults or overrides will be ignored.
- Restart DotClaw after changes.

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
      "toolAllow": [],
      "toolDeny": ["mcp__dotclaw__schedule_task"],
      "autoSpawn": {
        "enabled": true,
        "foregroundTimeoutMs": 180000,
        "onTimeout": true,
        "onToolLimit": true
      }
    }
  }
}
```

## Heartbeat

`host.heartbeat` controls periodic background runs for checking scheduled tasks and pending work.
Set `enabled` to `false` to disable heartbeats.
