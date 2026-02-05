---
title: Background Jobs
---

# Background Jobs

DotClaw supports durable background jobs for long-running work that should finish asynchronously and report results back to the chat.

## When to use

- Large research or analysis tasks
- Multi-step coding or refactoring work
- Anything that may take 10+ minutes

## How it works

- The agent starts a background job via `mcp__dotclaw__spawn_job`.
- The job runs outside the main chat flow and reports completion when finished.
- Long outputs are saved to job artifacts under `~/.dotclaw/groups/<group>/jobs/<job_id>/`.

Useful tools:

- `mcp__dotclaw__job_status`
- `mcp__dotclaw__list_jobs`
- `mcp__dotclaw__cancel_job`
- `mcp__dotclaw__job_update`

## Configuration

Background jobs are controlled by `host.backgroundJobs` in `~/.dotclaw/config/runtime.json`.

Key fields:

- `enabled`: toggle the background job runner
- `pollIntervalMs`: queue poll interval
- `maxConcurrent`: maximum concurrent background jobs
- `maxRuntimeMs`: per-job timeout
- `maxToolSteps`: per-job tool step limit
- `inlineMaxChars`: inline output limit before artifacts are used
- `contextModeDefault`: `group` or `isolated`
- `toolAllow` and `toolDeny`: job-specific tool policy
- `autoSpawn.enabled`: toggle auto-spawn (queue background jobs when foreground runs stall)
- `autoSpawn.foregroundTimeoutMs`: max foreground runtime before auto-queue
- `autoSpawn.onTimeout`: enqueue on timeouts
- `autoSpawn.onToolLimit`: enqueue on tool-call step limits
- `autoSpawn.classifier`: LLM router settings for immediate queueing
- `autoSpawn.classifier.enabled`: toggle the classifier
- `autoSpawn.classifier.model`: classifier model id
- `autoSpawn.classifier.timeoutMs`: classifier timeout
- `autoSpawn.classifier.maxOutputTokens`: classifier max output tokens
- `autoSpawn.classifier.temperature`: classifier temperature
- `autoSpawn.classifier.confidenceThreshold`: minimum confidence to queue
