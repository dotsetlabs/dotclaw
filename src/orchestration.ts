/**
 * Subagent orchestration — fan-out/fan-in multi-agent coordination.
 * Decomposes tasks into parallel sub-tasks (background jobs), polls completion, aggregates results.
 */

import { generateId } from './id.js';
import { spawnBackgroundJob, cancelBackgroundJob } from './background-jobs.js';
import { getBackgroundJobById } from './db.js';
import { executeAgentRun } from './agent-execution.js';
import { emitHook } from './hooks.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

export interface OrchestrationTask {
  name: string;
  prompt: string;
  model_override?: string;
  timeout_ms?: number;
  tool_allow?: string[];
  tool_deny?: string[];
}

export interface OrchestrationParams {
  tasks: OrchestrationTask[];
  max_concurrent?: number;
  timeout_ms?: number;
  aggregation_prompt?: string;
  groupFolder: string;
  chatJid: string;
}

export interface OrchestrationResult {
  ok: boolean;
  group_id: string;
  results: Array<{
    name: string;
    status: string;
    result?: string | null;
    error?: string | null;
  }>;
  aggregated_result?: string | null;
  error?: string;
}

const POLL_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runOrchestration(
  params: OrchestrationParams,
  deps: {
    registeredGroups: () => Record<string, RegisteredGroup>;
    getSessions: () => Record<string, string>;
    setSession: (groupFolder: string, sessionId: string) => void;
  }
): Promise<OrchestrationResult> {
  const groupId = generateId('orch');
  const timeoutMs = params.timeout_ms || 600_000;
  const maxConcurrent = params.max_concurrent || params.tasks.length;
  const deadline = Date.now() + timeoutMs;

  logger.info({ groupId, taskCount: params.tasks.length }, 'Starting orchestration');

  // Spawn all sub-tasks as background jobs with group ID
  const jobMap = new Map<string, string>(); // jobId -> task name
  const results: OrchestrationResult['results'] = [];

  // Spawn up to maxConcurrent initially
  const pending = [...params.tasks];
  const activeJobIds = new Set<string>();

  while (pending.length > 0 || activeJobIds.size > 0) {
    // Spawn more tasks if under limit
    while (pending.length > 0 && activeJobIds.size < maxConcurrent) {
      const task = pending.shift()!;
      const result = spawnBackgroundJob({
        prompt: task.prompt,
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        modelOverride: task.model_override,
        timeoutMs: task.timeout_ms,
        toolAllow: task.tool_allow,
        toolDeny: task.tool_deny,
        tags: ['orchestration', groupId]
      });

      if (result.ok && result.jobId) {
        jobMap.set(result.jobId, task.name);
        activeJobIds.add(result.jobId);
      } else {
        logger.warn({ taskName: task.name, error: result.error }, 'Failed to spawn orchestration sub-task');
        // Record the failure so it appears in results
        results.push({
          name: task.name,
          status: 'failed',
          result: null,
          error: result.error || 'Failed to spawn'
        });
      }
    }

    if (activeJobIds.size === 0) break;

    // Check for timeout
    if (Date.now() > deadline) {
      // Cancel remaining active jobs (properly aborts their containers)
      for (const jobId of activeJobIds) {
        try {
          cancelBackgroundJob(jobId);
        } catch { /* ignore */ }
      }
      break;
    }

    // Poll for completed jobs
    await sleep(POLL_INTERVAL_MS);

    for (const jobId of [...activeJobIds]) {
      const job = getBackgroundJobById(jobId);
      if (!job) {
        activeJobIds.delete(jobId);
        continue;
      }
      if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled' || job.status === 'timed_out') {
        activeJobIds.delete(jobId);
      }
    }
  }

  // Collect results from completed jobs
  for (const [jobId, taskName] of jobMap) {
    const job = getBackgroundJobById(jobId);
    results.push({
      name: taskName,
      status: job?.status || 'unknown',
      result: job?.result_summary || null,
      error: job?.last_error || null
    });
  }

  void emitHook('job:completed', {
    orchestration_group_id: groupId,
    task_count: params.tasks.length,
    completed: results.filter(r => r.status === 'succeeded').length,
    failed: results.filter(r => r.status !== 'succeeded').length
  });

  // Aggregation step: run one final agent call to synthesize results
  let aggregatedResult: string | null = null;
  if (params.aggregation_prompt && results.some(r => r.result)) {
    try {
      const groups = deps.registeredGroups();
      const group = Object.values(groups).find(g => g.folder === params.groupFolder);
      if (group) {
        const resultsSummary = results.map(r =>
          `## ${r.name}\nStatus: ${r.status}\n${r.result || r.error || 'No output'}`
        ).join('\n\n');

        const prompt = `${params.aggregation_prompt}\n\n---\nSub-task results:\n${resultsSummary}`;

        const { output } = await executeAgentRun({
          group,
          prompt,
          chatJid: params.chatJid,
          recallQuery: '',
          recallMaxResults: 0,
          recallMaxTokens: 0,
          useSemaphore: false,
          useGroupLock: false,
          disablePlanner: true,
          disableResponseValidation: true,
          disableMemoryExtraction: true,
          maxToolSteps: 0,
          timeoutMs: 120_000
        });

        aggregatedResult = output.result;
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Orchestration aggregation failed');
    }
  }

  return {
    ok: true,
    group_id: groupId,
    results,
    aggregated_result: aggregatedResult
  };
}
