import { spawn } from 'child_process';
import { loadRuntimeConfig } from './runtime-config.js';
import { logger } from './logger.js';

const runtime = loadRuntimeConfig();
const hooksConfig = runtime.hooks;

export type HookEvent =
  | 'message:received'
  | 'message:processing'
  | 'message:responded'
  | 'agent:start'
  | 'agent:complete'
  | 'job:spawned'
  | 'job:completed'
  | 'task:fired'
  | 'task:completed'
  | 'memory:upserted';

type HookScript = {
  event: string;
  command: string;
  blocking: boolean;
  timeoutMs: number;
};

let activeConcurrent = 0;

function resolveCommand(command: string): string {
  if (command.startsWith('~/')) {
    const home = process.env.HOME || '/root';
    return home + command.slice(1);
  }
  return command;
}

async function executeHookScript(
  script: HookScript,
  payload: Record<string, unknown>
): Promise<{ cancel?: boolean } | null> {
  const maxConcurrent = hooksConfig.maxConcurrent;
  if (activeConcurrent >= maxConcurrent) {
    logger.warn({ event: script.event, command: script.command }, 'Hook skipped: max concurrent reached');
    return null;
  }

  activeConcurrent += 1;
  const timeoutMs = script.timeoutMs || hooksConfig.defaultTimeoutMs;

  return new Promise((resolve) => {
    const resolved = resolveCommand(script.command);
    const proc = spawn('/bin/sh', ['-c', resolved], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, DOTCLAW_HOOK_EVENT: script.event }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Send payload as JSON on stdin
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    proc.on('close', (code) => {
      activeConcurrent -= 1;
      if (code !== 0) {
        logger.warn({ event: script.event, command: script.command, code, stderr: stderr.slice(0, 500) }, 'Hook script exited with non-zero code');
      }

      if (script.blocking && stdout.trim()) {
        try {
          const result = JSON.parse(stdout.trim()) as { cancel?: boolean };
          resolve(result);
          return;
        } catch {
          // Not JSON, ignore
        }
      }
      resolve(null);
    });

    proc.on('error', (err) => {
      // Don't decrement activeConcurrent here — Node.js guarantees 'close'
      // fires after 'error' for spawned processes, so 'close' handles it.
      logger.error({ event: script.event, command: script.command, error: err.message }, 'Hook script failed to execute');
      resolve(null);
    });
  });
}

/**
 * Emit a hook event. Blocking hooks are awaited; non-blocking hooks fire-and-forget.
 * Returns true if any blocking hook requested cancellation.
 */
export async function emitHook(
  event: HookEvent,
  payload: Record<string, unknown>
): Promise<boolean> {
  if (!hooksConfig.enabled) return false;

  const scripts = hooksConfig.scripts.filter(s => s.event === event);
  if (scripts.length === 0) return false;

  const blockingScripts = scripts.filter(s => s.blocking);
  const asyncScripts = scripts.filter(s => !s.blocking);

  // Fire async hooks (fire-and-forget)
  for (const script of asyncScripts) {
    executeHookScript(script, { ...payload, event }).catch(err => {
      logger.error({ event, error: err instanceof Error ? err.message : String(err) }, 'Async hook error');
    });
  }

  // Execute blocking hooks sequentially
  for (const script of blockingScripts) {
    const result = await executeHookScript(script, { ...payload, event });
    if (result?.cancel) {
      logger.info({ event, command: script.command }, 'Blocking hook requested cancellation');
      return true;
    }
  }

  return false;
}
