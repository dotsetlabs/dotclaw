import {
  AGENT_LANE_STARVATION_MS,
  AGENT_MAX_CONSECUTIVE_INTERACTIVE,
  AGENT_QUEUE_TIMEOUT_MS,
  MAX_CONCURRENT_AGENTS
} from './config.js';

type Release = () => void;

export type AgentExecutionLane = 'interactive' | 'scheduled' | 'maintenance';

type QueueEntry = {
  lane: AgentExecutionLane;
  enqueuedAt: number;
  seq: number;
  resolve: (release: Release) => void;
  reject: (err: Error) => void;
  timeout?: NodeJS.Timeout;
};

type SemaphoreOptions = {
  laneStarvationMs: number;
  maxConsecutiveInteractive: number;
};

const LANE_PRIORITY: Record<AgentExecutionLane, number> = {
  interactive: 3,
  scheduled: 2,
  maintenance: 1,
};

function compareEntries(a: QueueEntry, b: QueueEntry): number {
  const prioDelta = LANE_PRIORITY[b.lane] - LANE_PRIORITY[a.lane];
  if (prioDelta !== 0) return prioDelta;
  return a.seq - b.seq;
}

export class LaneAwareSemaphore {
  private available: number;
  private readonly queue: QueueEntry[] = [];
  private sequence = 0;
  private consecutiveInteractive = 0;
  private readonly opts: SemaphoreOptions;

  constructor(limit: number, options: SemaphoreOptions) {
    this.available = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
    this.opts = {
      laneStarvationMs: Math.max(1, options.laneStarvationMs),
      maxConsecutiveInteractive: Math.max(1, options.maxConsecutiveInteractive),
    };
  }

  async acquire(lane: AgentExecutionLane, timeoutMs?: number): Promise<Release> {
    if (this.available > 0 && this.queue.length === 0) {
      this.available -= 1;
      this.recordDispatch(lane);
      return () => this.release();
    }

    return new Promise<Release>((resolve, reject) => {
      const entry: QueueEntry = {
        lane,
        enqueuedAt: Date.now(),
        seq: this.sequence++,
        resolve,
        reject
      };
      if (timeoutMs && timeoutMs > 0) {
        entry.timeout = setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error(`Agent queue timeout after ${timeoutMs}ms`));
          }
          this.drainQueue();
        }, timeoutMs);
      }
      this.queue.push(entry);
      this.drainQueue();
    });
  }

  private release(): void {
    this.available += 1;
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.available > 0 && this.queue.length > 0) {
      const nextIndex = this.pickNextIndex();
      if (nextIndex < 0) return;
      const [next] = this.queue.splice(nextIndex, 1);
      if (!next) return;
      if (next.timeout) clearTimeout(next.timeout);
      this.available -= 1;
      this.recordDispatch(next.lane);
      next.resolve(() => this.release());
    }
  }

  private recordDispatch(lane: AgentExecutionLane): void {
    if (lane === 'interactive') {
      this.consecutiveInteractive += 1;
    } else {
      this.consecutiveInteractive = 0;
    }
  }

  private pickNextIndex(): number {
    if (this.queue.length === 0) return -1;
    const now = Date.now();

    // Starvation protection: once non-interactive work has waited long enough,
    // force-dispatch it even if interactive traffic remains heavy.
    let starvingIndex = -1;
    for (let i = 0; i < this.queue.length; i += 1) {
      const entry = this.queue[i];
      if (entry.lane === 'interactive') continue;
      if (now - entry.enqueuedAt >= this.opts.laneStarvationMs) {
        if (starvingIndex < 0 || compareEntries(entry, this.queue[starvingIndex]) < 0) {
          starvingIndex = i;
        }
      }
    }
    if (starvingIndex >= 0) return starvingIndex;

    const hasNonInteractive = this.queue.some(entry => entry.lane !== 'interactive');
    if (hasNonInteractive && this.consecutiveInteractive >= this.opts.maxConsecutiveInteractive) {
      let bestNonInteractive = -1;
      for (let i = 0; i < this.queue.length; i += 1) {
        const entry = this.queue[i];
        if (entry.lane === 'interactive') continue;
        if (bestNonInteractive < 0 || compareEntries(entry, this.queue[bestNonInteractive]) < 0) {
          bestNonInteractive = i;
        }
      }
      if (bestNonInteractive >= 0) return bestNonInteractive;
    }

    let best = 0;
    for (let i = 1; i < this.queue.length; i += 1) {
      if (compareEntries(this.queue[i], this.queue[best]) < 0) {
        best = i;
      }
    }
    return best;
  }
}

const semaphore = new LaneAwareSemaphore(MAX_CONCURRENT_AGENTS, {
  laneStarvationMs: AGENT_LANE_STARVATION_MS,
  maxConsecutiveInteractive: AGENT_MAX_CONSECUTIVE_INTERACTIVE
});

export async function runWithAgentSemaphore<T>(
  fn: () => Promise<T>,
  options?: { lane?: AgentExecutionLane; timeoutMs?: number }
): Promise<T> {
  if (!Number.isFinite(MAX_CONCURRENT_AGENTS) || MAX_CONCURRENT_AGENTS <= 0) {
    return fn();
  }
  const lane = options?.lane || 'interactive';
  const timeoutMs = options?.timeoutMs ?? AGENT_QUEUE_TIMEOUT_MS;
  const release = await semaphore.acquire(lane, timeoutMs);
  try {
    return await fn();
  } finally {
    release();
  }
}
