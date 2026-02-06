---
title: Running DotClaw
---

# Running DotClaw

## Build and start

```bash
npm run build
npm start
```

## Development mode

```bash
npm run dev
```

## Build the agent container

```bash
./container/build.sh
```

## Logs

Logs are written to `~/.dotclaw/logs/` by default:

- `~/.dotclaw/logs/dotclaw.log`
- `~/.dotclaw/logs/dotclaw.error.log`

Or use the CLI to follow logs:

```bash
dotclaw logs --follow
```

## Multiple instances

To create a second isolated instance on the same machine:

```bash
dotclaw add-instance dev
```

Target a specific instance or all instances:

```bash
dotclaw status --id dev
dotclaw restart --all
```

List available instances:

```bash
dotclaw instances
```

## Metrics

Prometheus metrics are exposed at:

```
http://localhost:3001/metrics
```

Override the port in `~/.dotclaw/config/runtime.json` with `host.metrics.port`.

## Health and diagnostics

Run the doctor script to check common issues:

```bash
dotclaw doctor
```
