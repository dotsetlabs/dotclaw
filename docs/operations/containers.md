---
title: Containers
---

# Containers

DotClaw runs each request inside a Docker container for isolation.

## Modes

- `daemon` (default): a persistent container for lower latency
- `ephemeral`: one container per request

Set this in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "container": {
      "mode": "daemon"
    }
  }
}
```

## Privilege mode

`host.container.privileged` controls Docker privilege mode:

- `true` (default): containers run `--privileged` as root for maximum in-container command capability.
- `false`: containers run with a reduced capability set (`--cap-drop=ALL` plus required caps).

Set this in `~/.dotclaw/config/runtime.json`:

```json
{
  "host": {
    "container": {
      "privileged": true
    }
  }
}
```

## Browser automation

The container image includes `agent-browser`, which can be invoked via the `Bash` tool
for interactive web automation (open, snapshot, click, fill, screenshot).

## Resource limits

You can tune resource limits in `~/.dotclaw/config/runtime.json`:

- `host.container.pidsLimit`
- `host.container.memory`
- `host.container.cpus`
- `host.container.timeoutMs`
- `host.container.maxOutputBytes`

## Workspace file exchange

- Incoming Telegram media (photo/document/voice/video/audio) is downloaded to
  `~/.dotclaw/groups/<group>/inbox/` and exposed in-container as `/workspace/group/inbox/`.
- The `mcp__dotclaw__download_url` tool saves files to `/workspace/group/downloads/` by default.
- Maintenance cleanup prunes inbox files older than 14 days and enforces a 500MB per-group inbox budget.

## Read-only root

Enable a read-only root with tmpfs:

```json
{
  "host": {
    "container": {
      "readOnlyRoot": true,
      "tmpfsSize": "64m"
    }
  }
}
```

## Additional mounts per group

Add mounts in `~/.dotclaw/data/registered_groups.json`:

```json
{
  "-987654321": {
    "name": "dev-team",
    "folder": "dev-team",
    "added_at": "2026-02-04T00:00:00Z",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/Users/you/projects/webapp",
          "containerPath": "webapp",
          "readonly": false
        }
      ]
    }
  }
}
```

The directory will appear at `/workspace/extra/webapp` inside that group's container.

You must also allow the host path in `~/.config/dotclaw/mount-allowlist.json`.

## Group triggers

You can set `trigger` in `registered_groups.json` to allow the bot to respond
in group chats without an explicit mention when the message matches a regex.

```json
{
  "-987654321": {
    "name": "dev-team",
    "folder": "dev-team",
    "added_at": "2026-02-04T00:00:00Z",
    "trigger": "(build|deploy|incident)"
  }
}
```

## Per-group environment variables

You can inject per-group secrets (for plugin tools, API keys, etc.) in the same file:

```json
{
  "-987654321": {
    "name": "dev-team",
    "folder": "dev-team",
    "added_at": "2026-02-04T00:00:00Z",
    "containerConfig": {
      "env": {
        "GITHUB_TOKEN": "ghp_xxx",
        "LINEAR_API_KEY": "lin_xxx"
      }
    }
  }
}
```

These values are written into the container’s `/workspace/env-dir/env` and loaded at runtime.
