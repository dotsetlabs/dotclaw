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

## Targeting other groups

Tasks run in the context of the group they are created in. To schedule for another group, use the `target_group` parameter when calling scheduler tools.
