import { parentPort, workerData } from 'worker_threads';
import { runAgentOnce } from './index.js';
import type { ContainerInput } from './container-protocol.js';

async function main(): Promise<void> {
  const input = (workerData as { input?: ContainerInput } | null)?.input;
  if (!parentPort) return;
  if (!input) {
    parentPort.postMessage({ ok: false, error: 'Missing input payload' });
    process.exitCode = 1;
    return;
  }
  try {
    const output = await runAgentOnce(input);
    parentPort.postMessage({ ok: true, output });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    });
    process.exitCode = 1;
  }
}

void main();
