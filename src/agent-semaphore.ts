import { AGENT_QUEUE_TIMEOUT_MS, MAX_CONCURRENT_AGENTS } from './config.js';

type Release = () => void;
type QueueEntry = {
  resolve: (release: Release) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
};

class AsyncSemaphore {
  private available: number;
  private readonly queue: QueueEntry[] = [];

  constructor(limit: number) {
    this.available = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  }

  async acquire(timeoutMs?: number): Promise<Release> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }

    return new Promise<Release>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        entry.timeout = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error(`Agent queue timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.queue.push(entry);
    });
  }

  private release(): void {
    if (this.queue.length === 0) {
      this.available += 1;
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    if (next.timeout) clearTimeout(next.timeout);
    next.resolve(() => this.release());
  }
}

const semaphore = new AsyncSemaphore(MAX_CONCURRENT_AGENTS);

export async function runWithAgentSemaphore<T>(fn: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(MAX_CONCURRENT_AGENTS) || MAX_CONCURRENT_AGENTS <= 0) {
    return fn();
  }
  const release = await semaphore.acquire(AGENT_QUEUE_TIMEOUT_MS);
  try {
    return await fn();
  } finally {
    release();
  }
}
