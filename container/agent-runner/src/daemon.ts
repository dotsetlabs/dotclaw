import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { loadAgentConfig } from './agent-config.js';
import type { ContainerInput, ContainerOutput } from './container-protocol.js';

const REQUESTS_DIR = '/workspace/ipc/agent_requests';
const RESPONSES_DIR = '/workspace/ipc/agent_responses';
const HEARTBEAT_FILE = '/workspace/ipc/heartbeat';
const STATUS_FILE = '/workspace/ipc/daemon_status.json';

const config = loadAgentConfig();
const POLL_MS = config.daemonPollMs;
const HEARTBEAT_INTERVAL_MS = config.daemonHeartbeatIntervalMs;

let shuttingDown = false;
let heartbeatWorker: Worker | null = null;

function log(message: string): void {
  console.error(`[agent-daemon] ${message}`);
}

function ensureDirs(): void {
  fs.mkdirSync(REQUESTS_DIR, { recursive: true });
  fs.mkdirSync(RESPONSES_DIR, { recursive: true });
}

// --- Worker thread management ---

function getWorkerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), 'heartbeat-worker.js');
}

function getRequestWorkerPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), 'request-worker.js');
}

let workerRestarts = 0;
let workerRestartWindowStart = Date.now();
let workerRestarting = false;

function maybeRestartWorker(exitCode: number): void {
  if (shuttingDown || exitCode === 0 || workerRestarting) return;
  workerRestarting = true;
  const now = Date.now();
  if (now - workerRestartWindowStart > 60_000) {
    workerRestarts = 0;
    workerRestartWindowStart = now;
  }
  workerRestarts++;
  if (workerRestarts > 5) {
    log('Heartbeat worker crash loop detected, stopping restarts');
    workerRestarting = false;
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, workerRestarts - 1), 10_000);
  setTimeout(() => {
    workerRestarting = false;
    heartbeatWorker = spawnHeartbeatWorker();
  }, delay);
}

function spawnHeartbeatWorker(): Worker {
  const workerPath = getWorkerPath();
  const worker = new Worker(workerPath, {
    workerData: {
      heartbeatPath: HEARTBEAT_FILE,
      statusPath: STATUS_FILE,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      pid: process.pid,
    },
  });

  worker.on('error', (err) => {
    log(`Heartbeat worker error: ${err.message}`);
    maybeRestartWorker(1);
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      log(`Heartbeat worker exited with code ${code}`);
    }
    maybeRestartWorker(code ?? 1);
  });

  return worker;
}

function postWorkerMessage(msg: { type: string; requestId?: string }): void {
  try {
    heartbeatWorker?.postMessage(msg);
  } catch {
    // Worker may have died — will be restarted by exit handler
  }
}

let currentRequestId: string | null = null;

async function runRequestWithCancellation(requestId: string, input: ContainerInput): Promise<{ output: ContainerOutput | null; canceled: boolean }> {
  const cancelFile = path.join(REQUESTS_DIR, requestId + '.cancel');
  const workerPath = getRequestWorkerPath();
  const worker = new Worker(workerPath, { workerData: { input } });

  return await new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      fn();
    };

    const handleCancel = (): void => {
      if (!fs.existsSync(cancelFile)) return;
      finish(() => {
        try { fs.unlinkSync(cancelFile); } catch { /* already removed */ }
        void worker.terminate().catch(() => undefined);
        resolve({ output: null, canceled: true });
      });
    };

    const cancelTimer = setInterval(handleCancel, Math.max(100, Math.floor(POLL_MS / 2)));
    handleCancel();

    worker.on('message', (message: unknown) => {
      finish(() => {
        const payload = (message && typeof message === 'object') ? (message as Record<string, unknown>) : null;
        if (payload?.ok === true && payload.output && typeof payload.output === 'object') {
          resolve({ output: payload.output as ContainerOutput, canceled: false });
          return;
        }
        const errMessage = typeof payload?.error === 'string' ? payload.error : 'Agent worker failed';
        reject(new Error(errMessage));
      });
    });

    worker.on('error', (err) => {
      finish(() => reject(err));
    });

    worker.on('exit', (code) => {
      finish(() => {
        if (code === 0) {
          reject(new Error('Agent worker exited without output'));
          return;
        }
        reject(new Error(`Agent worker exited with code ${code}`));
      });
    });
  });
}

// --- Request processing ---

function isContainerInput(value: unknown): value is ContainerInput {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.prompt === 'string'
    && typeof record.groupFolder === 'string'
    && typeof record.chatJid === 'string'
    && typeof record.isMain === 'boolean';
}

async function processRequests(): Promise<void> {
  const files = fs.readdirSync(REQUESTS_DIR).filter(file => file.endsWith('.json')).sort();
  for (const file of files) {
    if (shuttingDown) break;

    const filePath = path.join(REQUESTS_DIR, file);
    let requestId = file.replace('.json', '');
    const cancelFile = path.join(REQUESTS_DIR, requestId + '.cancel');
    if (fs.existsSync(cancelFile)) {
      try { fs.unlinkSync(filePath); } catch { /* already removed */ }
      try { fs.unlinkSync(cancelFile); } catch { /* already removed */ }
      continue;
    }
    try {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw readErr;
      }
      const payload = JSON.parse(raw) as { id?: string; input?: unknown };
      requestId = payload.id || requestId;
      const input = payload.input || payload;
      if (!isContainerInput(input)) {
        throw new Error('Invalid agent request payload');
      }

      currentRequestId = requestId;
      postWorkerMessage({ type: 'processing', requestId });

      const { output, canceled } = await runRequestWithCancellation(requestId, input);
      if (canceled) {
        try { fs.unlinkSync(filePath); } catch { /* request file already removed */ }
        continue;
      }
      if (!output) {
        throw new Error('Agent worker returned no output');
      }
      if (fs.existsSync(cancelFile)) {
        try { fs.unlinkSync(cancelFile); } catch { /* already removed */ }
        try { fs.unlinkSync(filePath); } catch { /* request file already removed */ }
        continue;
      }
      const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
      const tmpPath = responsePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(output));
      fs.renameSync(tmpPath, responsePath);
      try { fs.unlinkSync(filePath); } catch { /* request file already removed */ }
    } catch (err) {
      log(`Failed processing request ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
      const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
      const tmpPath = responsePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify({
        status: 'error',
        result: null,
        error: err instanceof Error ? err.message : String(err)
      }));
      fs.renameSync(tmpPath, responsePath);
      try { fs.unlinkSync(filePath); } catch { /* request file already removed */ }
    } finally {
      currentRequestId = null;
      postWorkerMessage({ type: 'idle' });
    }
  }
}

// --- Graceful shutdown ---

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}, shutting down gracefully...`);
  postWorkerMessage({ type: 'shutdown' });
  const deadline = Date.now() + 30_000;
  const check = () => {
    if (!currentRequestId || Date.now() > deadline) {
      if (currentRequestId) {
        // Write aborted response for in-flight request
        const responsePath = path.join(RESPONSES_DIR, `${currentRequestId}.json`);
        try {
          const tmpPath = responsePath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify({ status: 'error', result: null, error: 'Daemon shutting down' }));
          fs.renameSync(tmpPath, responsePath);
        } catch { /* best-effort abort response */ }
      }
      log('Daemon stopped.');
      process.exit(0);
    }
    setTimeout(check, 500);
  };
  check();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Error handlers (keep daemon alive through individual failures) ---

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  // Don't exit — daemon should survive individual request failures
});

process.on('uncaughtException', (err) => {
  log(`Uncaught exception (fatal): ${err.message}`);
  try { postWorkerMessage({ type: 'shutdown' }); } catch { /* worker may be dead */ }
  process.exit(1);
});

// --- Main loop ---

async function loop(): Promise<void> {
  ensureDirs();
  heartbeatWorker = spawnHeartbeatWorker();
  log('Daemon started (worker thread heartbeat active)');

  while (!shuttingDown) {
    try {
      await processRequests();
    } catch (err) {
      log(`Daemon loop error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }

  log('Daemon loop exited.');
}

loop().catch(err => {
  log(`Daemon fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
