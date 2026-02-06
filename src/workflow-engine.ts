/**
 * Declarative YAML/JSON multi-step workflow engine.
 * Supports state persistence, conditional execution, dependency checking, and retry.
 * Steps execute sequentially; use the orchestration module for parallel fan-out.
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { generateId } from './id.js';
import { executeAgentRun } from './agent-execution.js';
import { emitHook } from './hooks.js';
import { logger } from './logger.js';
import {
  createWorkflowRun,
  updateWorkflowRun,
  getWorkflowRun,
  listWorkflowRunsByGroup,
  upsertStepResult,
  getStepResults,
  type WorkflowRun
} from './workflow-store.js';
import type { RegisteredGroup } from './types.js';

export interface WorkflowStep {
  name: string;
  prompt: string;
  depends_on?: string[];
  tools?: string[];
  timeout_ms?: number;
  condition?: string;
  model_override?: string;
}

export interface WorkflowDefinition {
  name: string;
  trigger?: {
    schedule?: string;
    timezone?: string;
    pattern?: string;
  };
  steps: WorkflowStep[];
  on_error?: {
    notify?: boolean;
    retry?: number;
  };
}

interface WorkflowDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  setSession: (groupFolder: string, sessionId: string) => void;
}

// Active workflow run cancellation
const cancelledRuns = new Set<string>();

function loadWorkflowDefinition(name: string, groupFolder: string): WorkflowDefinition | null {
  const workflowsDir = path.join(GROUPS_DIR, groupFolder, 'workflows');
  const yamlPath = path.join(workflowsDir, `${name}.yml`);
  const jsonPath = path.join(workflowsDir, `${name}.json`);

  let raw: string;
  if (fs.existsSync(jsonPath)) {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } else if (fs.existsSync(yamlPath)) {
    // Simple YAML parser for basic structures
    raw = fs.readFileSync(yamlPath, 'utf-8');
    return parseSimpleYaml(raw);
  } else {
    return null;
  }

  try {
    return JSON.parse(raw) as WorkflowDefinition;
  } catch {
    return null;
  }
}

function parseSimpleYaml(raw: string): WorkflowDefinition | null {
  // Minimal YAML-like parsing for workflow files.
  // For production use, consider adding js-yaml dependency.
  try {
    // Convert simple YAML to JSON-like structure
    const lines = raw.split('\n');
    let name = '';
    const steps: WorkflowStep[] = [];
    let currentStep: Partial<WorkflowStep> | null = null;
    let inSteps = false;
    const trigger: WorkflowDefinition['trigger'] = {};
    const onError: WorkflowDefinition['on_error'] = {};
    let inTrigger = false;
    let inOnError = false;

    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = line.length - line.trimStart().length;

      if (indent === 0) {
        if (trimmed.startsWith('name:')) {
          name = trimmed.slice(5).trim().replace(/^['"]|['"]$/g, '');
        } else if (trimmed === 'steps:') {
          inSteps = true;
          inTrigger = false;
          inOnError = false;
        } else if (trimmed === 'trigger:') {
          inTrigger = true;
          inSteps = false;
          inOnError = false;
        } else if (trimmed === 'on_error:') {
          inOnError = true;
          inSteps = false;
          inTrigger = false;
        }
        continue;
      }

      if (inTrigger && indent >= 2) {
        const kv = trimmed.trim();
        if (kv.startsWith('schedule:')) trigger.schedule = kv.slice(9).trim().replace(/^['"]|['"]$/g, '');
        if (kv.startsWith('timezone:')) trigger.timezone = kv.slice(9).trim().replace(/^['"]|['"]$/g, '');
        if (kv.startsWith('pattern:')) trigger.pattern = kv.slice(8).trim().replace(/^['"]|['"]$/g, '');
      }

      if (inOnError && indent >= 2) {
        const kv = trimmed.trim();
        if (kv.startsWith('notify:')) onError.notify = kv.slice(7).trim() === 'true';
        if (kv.startsWith('retry:')) onError.retry = parseInt(kv.slice(6).trim(), 10);
      }

      if (inSteps) {
        const stripped = trimmed.trim();
        if (stripped.startsWith('- name:')) {
          if (currentStep && currentStep.name) {
            steps.push(currentStep as WorkflowStep);
          }
          currentStep = { name: stripped.slice(7).trim().replace(/^['"]|['"]$/g, '') };
        } else if (currentStep && indent >= 4) {
          if (stripped.startsWith('prompt:')) {
            currentStep.prompt = stripped.slice(7).trim().replace(/^['"]|['"]$/g, '');
          } else if (stripped.startsWith('timeout_ms:')) {
            currentStep.timeout_ms = parseInt(stripped.slice(11).trim(), 10);
          } else if (stripped.startsWith('model_override:')) {
            currentStep.model_override = stripped.slice(15).trim().replace(/^['"]|['"]$/g, '');
          } else if (stripped.startsWith('depends_on:')) {
            const deps = stripped.slice(11).trim();
            if (deps.startsWith('[')) {
              currentStep.depends_on = deps.replace(/[[\]]/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            }
          } else if (stripped.startsWith('tools:')) {
            const tools = stripped.slice(6).trim();
            if (tools.startsWith('[')) {
              currentStep.tools = tools.replace(/[[\]]/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
            }
          } else if (stripped.startsWith('condition:')) {
            currentStep.condition = stripped.slice(10).trim().replace(/^['"]|['"]$/g, '');
          }
        }
      }
    }

    if (currentStep && currentStep.name) {
      steps.push(currentStep as WorkflowStep);
    }

    if (!name || steps.length === 0) return null;

    return {
      name,
      trigger: Object.keys(trigger).length > 0 ? trigger : undefined,
      steps,
      on_error: Object.keys(onError).length > 0 ? onError : undefined
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate a simple condition string against step results.
 * Supports: "steps.<name>.result == '<value>'" and "steps.<name>.result != '<value>'"
 * Also supports bare truthiness: "steps.<name>.result" (truthy if non-null/non-empty)
 */
function evaluateCondition(condition: string, stepResults: Record<string, string | null>): boolean {
  // Match: steps.<name>.result == '<value>' or steps.<name>.result != '<value>'
  const comparisonMatch = condition.match(
    /^steps\.([a-zA-Z0-9_-]+)\.result\s*(==|!=)\s*['"](.*)['"]$/
  );
  if (comparisonMatch) {
    const [, stepName, operator, value] = comparisonMatch;
    const result = stepResults[stepName] ?? '';
    return operator === '==' ? result === value : result !== value;
  }

  // Bare truthiness: steps.<name>.result
  const truthyMatch = condition.match(/^steps\.([a-zA-Z0-9_-]+)\.result$/);
  if (truthyMatch) {
    const result = stepResults[truthyMatch[1]];
    return result !== null && result !== undefined && result.trim() !== '';
  }

  // Unknown condition format — default to true (don't skip)
  logger.warn({ condition }, 'Unknown workflow condition format; defaulting to true');
  return true;
}

function interpolateStepPrompt(prompt: string, stepResults: Record<string, string | null>): string {
  return prompt.replace(/\{\{steps\.([a-zA-Z0-9_-]+)\.result\}\}/g, (_match, stepName: string) => {
    return stepResults[stepName] || '[no result]';
  });
}

export async function startWorkflowRun(
  name: string,
  groupFolder: string,
  chatJid: string,
  params: Record<string, unknown> | undefined,
  deps: WorkflowDeps
): Promise<{ ok: boolean; run_id?: string; error?: string }> {
  const workflow = loadWorkflowDefinition(name, groupFolder);
  if (!workflow) {
    return { ok: false, error: `Workflow "${name}" not found in ${groupFolder}/workflows/` };
  }

  const runId = generateId('wf');
  const now = new Date().toISOString();

  createWorkflowRun({
    id: runId,
    workflow_name: name,
    group_folder: groupFolder,
    chat_jid: chatJid,
    status: 'running',
    current_step: null,
    state_json: params ? JSON.stringify(params) : null,
    params_json: params ? JSON.stringify(params) : null,
    created_at: now,
    updated_at: now
  });

  // Run the workflow asynchronously
  executeWorkflow(runId, workflow, groupFolder, chatJid, deps).catch(err => {
    logger.error({ runId, error: err instanceof Error ? err.message : String(err) }, 'Workflow execution failed');
    updateWorkflowRun(runId, {
      status: 'failed',
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err)
    });
  });

  return { ok: true, run_id: runId };
}

async function executeWorkflow(
  runId: string,
  workflow: WorkflowDefinition,
  groupFolder: string,
  chatJid: string,
  deps: WorkflowDeps
): Promise<void> {
  const stepResults: Record<string, string | null> = {};
  const maxRetries = workflow.on_error?.retry || 0;

  for (const step of workflow.steps) {
    if (cancelledRuns.has(runId)) {
      cancelledRuns.delete(runId);
      updateWorkflowRun(runId, { status: 'canceled', finished_at: new Date().toISOString() });
      return;
    }

    // Check dependencies
    if (step.depends_on && step.depends_on.length > 0) {
      const existingResults = getStepResults(runId);
      const completedSteps = new Set(existingResults.filter(r => r.status === 'completed').map(r => r.step_name));
      const unmet = step.depends_on.filter(dep => !completedSteps.has(dep));
      if (unmet.length > 0) {
        const failedDeps = existingResults.filter(r => step.depends_on!.includes(r.step_name) && r.status === 'failed');
        if (failedDeps.length > 0) {
          upsertStepResult(runId, step.name, {
            status: 'skipped',
            error: `Dependency failed: ${failedDeps.map(d => d.step_name).join(', ')}`
          });
          stepResults[step.name] = null;
          continue;
        }
      }
    }

    // Evaluate step condition: simple "steps.<name>.result == 'value'" checks
    if (step.condition) {
      const skip = !evaluateCondition(step.condition, stepResults);
      if (skip) {
        upsertStepResult(runId, step.name, {
          status: 'skipped',
          error: `Condition not met: ${step.condition}`
        });
        stepResults[step.name] = null;
        continue;
      }
    }

    updateWorkflowRun(runId, { current_step: step.name });
    upsertStepResult(runId, step.name, { status: 'running', started_at: new Date().toISOString() });

    // Execute step with retries
    let stepResult: string | null = null;
    let stepError: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const groups = deps.registeredGroups();
        const group = Object.values(groups).find(g => g.folder === groupFolder);
        if (!group) throw new Error(`Group not found: ${groupFolder}`);

        const prompt = interpolateStepPrompt(step.prompt, stepResults);

        const { output } = await executeAgentRun({
          group,
          prompt,
          chatJid,
          recallQuery: '',
          recallMaxResults: 0,
          recallMaxTokens: 0,
          useSemaphore: true,
          useGroupLock: true,
          modelOverride: step.model_override,
          toolAllow: step.tools,
          timeoutMs: step.timeout_ms || 300_000,
          disableMemoryExtraction: true
        });

        stepResult = output.result;
        stepError = null;
        break;
      } catch (err) {
        stepError = err instanceof Error ? err.message : String(err);
        if (attempt < maxRetries) {
          logger.warn({ runId, step: step.name, attempt, error: stepError }, 'Workflow step failed, retrying');
          await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
        }
      }
    }

    stepResults[step.name] = stepResult;

    if (stepError) {
      upsertStepResult(runId, step.name, {
        status: 'failed',
        error: stepError,
        finished_at: new Date().toISOString()
      });

      if (workflow.on_error?.notify) {
        void emitHook('task:completed', {
          workflow_run_id: runId,
          step: step.name,
          status: 'failed',
          error: stepError
        });
      }

      updateWorkflowRun(runId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: `Step "${step.name}" failed: ${stepError}`
      });
      return;
    }

    upsertStepResult(runId, step.name, {
      status: 'completed',
      result: stepResult,
      finished_at: new Date().toISOString()
    });
  }

  updateWorkflowRun(runId, {
    status: 'completed',
    finished_at: new Date().toISOString(),
    state_json: JSON.stringify(stepResults)
  });
}

export function getWorkflowRunStatus(runId: string): { run: WorkflowRun; steps: unknown[] } | null {
  const run = getWorkflowRun(runId);
  if (!run) return null;
  const steps = getStepResults(runId);
  return { run, steps };
}

export function cancelWorkflowRun(runId: string): boolean {
  const run = getWorkflowRun(runId);
  if (!run) return false;
  if (run.status !== 'running') return false;
  cancelledRuns.add(runId);
  updateWorkflowRun(runId, { status: 'canceled', finished_at: new Date().toISOString() });
  return true;
}

export function listWorkflowRuns(
  groupFolder: string,
  options?: { status?: string; limit?: number }
): WorkflowRun[] {
  return listWorkflowRunsByGroup(groupFolder, options);
}
