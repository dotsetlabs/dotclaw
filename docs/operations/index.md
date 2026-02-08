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
npm run dev          # Run with hot reload
npm run dev:up       # Full dev cycle: rebuild container + kill stale daemons + start dev
npm run dev:down     # Remove all running dotclaw agent containers
```

## Build the agent container

```bash
dotclaw build        # Or: ./container/build.sh
npm run build:all    # Build both host and container
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

## Release hardening

Pre-publish SLO checks:

- `operations/release-checklist`

## Baseline benchmark report

Generate a baseline quality/latency report from trace files:

```bash
npm run bench:baseline -- --days 7
```

Optional custom trace directory:

```bash
npm run bench:baseline -- --days 14 --dir /path/to/traces
```

Live-window filtering (for canary windows and production-weighted comparisons):

```bash
npm run bench:baseline -- --since <iso-start> --until <iso-end> --source dotclaw,live-canary
```

## Tranche benchmark harness

Capture tranche before/after snapshots and generate statistically tested comparisons:

```bash
npm run bench:harness -- init --run-id <run-id> --days 14
npm run bench:harness -- capture --run-id <run-id> --label tranche1_before --days 14
# implement tranche 1 changes
npm run bench:harness -- capture --run-id <run-id> --label tranche1_after --days 14
npm run bench:harness -- capture --run-id <run-id> --label overall_end --days 14
npm run bench:harness -- report --run-id <run-id> --enforce
```

For real canary/live windows, capture snapshots by timestamp + source filters:

```bash
npm run bench:harness -- capture --run-id <run-id> --label tranche5_before \
  --since <iso-start> --until <iso-end> --source dotclaw,live-canary
npm run bench:harness -- capture --run-id <run-id> --label tranche5_after \
  --since <iso-start> --until <iso-end> --source dotclaw,live-canary
```

Comparison output now includes `comparisons.production_weighted`, which applies the before-snapshot source mix to after metrics.

Run optional baseline-vs-candidate head-to-head comparison with enforceable gate:

```bash
npm run bench:harness -- capture --run-id <run-id> --label baseline_snapshot --days 7 --source baseline
npm run bench:harness -- capture --run-id <run-id> --label candidate_snapshot --days 7 --source dotclaw
npm run bench:harness -- headtohead --run-id <run-id> \
  --baseline baseline_snapshot \
  --candidate candidate_snapshot \
  --latency-tolerance 0.05 \
  --token-tolerance 0.05 \
  --enforce
```

Head-to-head output includes:
- production-weighted success/error/tool/empty deltas
- latency deltas (`p50`, `p95`, `p99`)
- token-per-success deltas (prompt, completion, total)
- `superiority_gate` pass/fail with concrete failure reasons

By default, harness data is written under `~/.dotclaw/reports/benchmark-harness/<run-id>/`.
Use `--output-dir <path>` to override the storage root.

Generate reproducible controlled traffic traces (seed + scenario replay) for before/after tranche measurements:

```bash
npm run bench:traffic -- --dir ./tmp/benchmark-traffic/traces --reset \
  --seed-dir ~/.dotclaw/traces --seed-days 14 --seed-limit 400 --repeat 8
```

Then point harness commands at `--dir ./tmp/benchmark-traffic/traces`.

Run scenario-focused reliability metrics (memory carryover, tool-heavy completion, transient/context recovery):

```bash
npm run bench:scenarios -- --days 7
```

Enforce thresholds (non-zero exit on failure):

```bash
npm run bench:scenarios -- --days 7 --enforce
```

Run the periodic canary suite against expected benchmark outcomes:

```bash
npm run canary -- --enforce
```

Run real live canary traffic (non-fixture) through the full container execution path:

```bash
npm run canary:live -- --rounds 6 --group-folder main
```

Run release SLO checks before publishing:

```bash
npm run release:slo -- --days 7 --enforce
```
