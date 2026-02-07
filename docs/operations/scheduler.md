---
title: Scheduler
---

# Scheduler

DotClaw supports one-off and recurring tasks.

## Timezone

Set `host.timezone` in `~/.dotclaw/config/runtime.json` to override the system default timezone:

```json
{
  "host": {
    "timezone": "America/New_York"
  }
}
```

This timezone is also passed to the agent so it can interpret and present timestamps consistently.

You can override timezone per scheduled task by providing a `timezone` value (IANA format, for example `America/New_York`) when calling `mcp__dotclaw__schedule_task` or `mcp__dotclaw__update_task`.

## Scheduling tasks

Create tasks with natural language prompts in Telegram:

```
remind me every Monday at 9am to check my emails
schedule a daily standup summary at 9:30am
```

Ask the assistant to list, pause, resume, or cancel tasks when needed.
You can also ask it to run a scheduled task immediately without changing its schedule.

Each scheduled run sends a completion or failure notification message to the task chat.

## Failure handling

When a scheduled task fails, DotClaw retries with exponential backoff (configurable via `host.scheduler.taskRetryBaseMs` and `host.scheduler.taskRetryMaxMs`).

If a task exhausts its retry limit (`host.scheduler.taskMaxRetries`, default 3), or if its schedule is invalid, the task is **automatically paused** and a notification is sent to the chat. This circuit breaker prevents runaway loops where a broken task keeps retrying indefinitely. Use the task tool to resume a paused task after fixing the underlying issue.

Recurring tasks use fresh sessions for each run, so a failure in one run doesn't corrupt context for the next.

## Targeting other groups

Tasks run in the context of the group they are created in. To schedule for another group, use the `target_group` parameter when calling scheduler tools.
