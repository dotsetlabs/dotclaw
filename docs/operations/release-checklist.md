---
title: Release Checklist
---

# Release Checklist

Use this checklist before publishing a DotClaw release.

## 1) Core quality gates

```bash
npm run build
npm run lint
npm test
```

## 2) Regression benchmark gates

```bash
npm run bench:scenarios -- --input test/fixtures/benchmark/scenario-traces.jsonl --enforce
npm run canary -- --enforce
npm run bench:harness -- report --run-id <active-run-id> --enforce
```

## 3) Runtime SLO gate

Run SLO checks against recent traces (default: 7 days):

```bash
npm run release:slo -- --days 7 --enforce
```

Optional custom trace dir:

```bash
npm run release:slo -- --days 14 --dir /path/to/traces --enforce
```

## 4) Manual release checks

- Confirm no new high-frequency error class appears in the SLO report.
- Confirm `top_models` and routing behavior match intended defaults.
- Confirm docs/config examples reflect any new runtime keys.
- Confirm canary and CI workflows are green on `main`.

## 5) Optional head-to-head gate

```bash
npm run bench:harness -- headtohead --run-id <run-id> \
  --baseline <baseline-snapshot-label> \
  --candidate <candidate-snapshot-label> \
  --latency-tolerance 0.05 \
  --token-tolerance 0.05 \
  --enforce
```

The command fails on any reliability regression, latency tolerance breach, or token-efficiency tolerance breach.
