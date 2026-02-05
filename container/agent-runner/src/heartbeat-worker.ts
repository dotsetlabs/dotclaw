/**
 * Heartbeat Worker Thread
 *
 * Runs in a separate V8 isolate so heartbeat writes are never blocked
 * by long-running agent tasks on the main thread. Writes two files:
 *
 * - /workspace/ipc/heartbeat          — epoch ms (backward compatible)
 * - /workspace/ipc/daemon_status.json — structured status with state info
 */

import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';

interface WorkerConfig {
  heartbeatPath: string;
  statusPath: string;
  intervalMs: number;
  pid: number;
}

type WorkerMessage =
  | { type: 'processing'; requestId: string }
  | { type: 'idle' }
  | { type: 'shutdown' };

interface DaemonStatus {
  state: 'idle' | 'processing';
  ts: number;
  request_id: string | null;
  started_at: number | null;
  pid: number;
}

const config = workerData as WorkerConfig;
let state: 'idle' | 'processing' = 'idle';
let requestId: string | null = null;
let startedAt: number | null = null;
function writeHeartbeat(): void {
  const now = Date.now();
  try {
    const tmpHeartbeat = config.heartbeatPath + '.tmp';
    fs.writeFileSync(tmpHeartbeat, now.toString());
    fs.renameSync(tmpHeartbeat, config.heartbeatPath);
  } catch {
    // Ignore heartbeat write errors
  }

  const status: DaemonStatus = {
    state,
    ts: now,
    request_id: requestId,
    started_at: startedAt,
    pid: config.pid,
  };
  try {
    const tmpStatus = config.statusPath + '.tmp';
    fs.writeFileSync(tmpStatus, JSON.stringify(status));
    fs.renameSync(tmpStatus, config.statusPath);
  } catch {
    // Ignore status write errors
  }
}

// Write immediately on start
writeHeartbeat();

const timer = setInterval(writeHeartbeat, config.intervalMs);

parentPort?.on('message', (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'processing':
      state = 'processing';
      requestId = msg.requestId;
      startedAt = Date.now();
      writeHeartbeat(); // Immediate update
      break;
    case 'idle':
      state = 'idle';
      requestId = null;
      startedAt = null;
      writeHeartbeat(); // Immediate update
      break;
    case 'shutdown':
      clearInterval(timer);
      state = 'idle';
      requestId = null;
      startedAt = null;
      writeHeartbeat(); // Final heartbeat
      process.exit(0);
      break;
  }
});

// Worker stays alive via the setInterval timer
