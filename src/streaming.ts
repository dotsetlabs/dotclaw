import fs from 'fs';
import path from 'path';
import type { MessagingProvider } from './providers/types.js';
import { logger } from './logger.js';
import { loadRuntimeConfig } from './runtime-config.js';

export interface StreamingConfig {
  enabled: boolean;
  chunkFlushIntervalMs: number;
  editIntervalMs: number;
  maxEditLength: number;
}

export interface StreamingOptions {
  threadId?: string;
  replyToMessageId?: string;
}

const runtime = loadRuntimeConfig();
const STREAM_CHUNK_POLL_MS = Math.max(25, runtime.host.streaming.chunkFlushIntervalMs || 50);

class DirectoryWakeSignal {
  private watcher: fs.FSWatcher | null = null;
  private pending = false;
  private waiter: (() => void) | null = null;
  private readonly abortHandler: (() => void) | null;

  constructor(
    streamDir: string,
    private readonly abortSignal?: AbortSignal
  ) {
    try {
      this.watcher = fs.watch(streamDir, { persistent: false }, () => this.notify());
      this.watcher.on('error', () => {
        if (this.watcher) {
          try { this.watcher.close(); } catch { /* ignore */ }
          this.watcher = null;
        }
        this.notify();
      });
    } catch {
      this.watcher = null;
    }

    if (this.abortSignal) {
      this.abortHandler = () => this.notify();
      this.abortSignal.addEventListener('abort', this.abortHandler);
    } else {
      this.abortHandler = null;
    }
  }

  private notify(): void {
    if (this.waiter) {
      const wake = this.waiter;
      this.waiter = null;
      wake();
      return;
    }
    this.pending = true;
  }

  async wait(timeoutMs: number): Promise<void> {
    if (this.pending) {
      this.pending = false;
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.waiter === finish) this.waiter = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(10, timeoutMs));
      this.waiter = finish;
    });
  }

  close(): void {
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener('abort', this.abortHandler);
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.notify();
  }
}

/**
 * Delivers streaming text to a chat by accumulating chunks and
 * periodically editing a single message in-place.
 *
 * Rate-limited edits prevent hitting provider API limits (e.g. Telegram 1 edit/sec).
 * When accumulated text exceeds maxEditLength, sends a new message.
 */
export class StreamingDelivery {
  private accumulated = '';
  private sentMessageId: string | null = null;
  private lastEditAt = 0;
  private editTimer: NodeJS.Timeout | null = null;
  private finalized = false;

  constructor(
    private readonly provider: MessagingProvider,
    private readonly chatId: string,
    private readonly config: StreamingConfig,
    private readonly options: StreamingOptions = {}
  ) {}

  /**
   * Called for each incoming text chunk from the container stream.
   * Accumulates text and flushes via edit at rate-limited intervals.
   */
  async onChunk(text: string): Promise<void> {
    if (this.finalized) return;
    this.accumulated += text;
    this.scheduleFlush();
  }

  /**
   * Finalize delivery with the complete text. Cancels any pending edit timer
   * and sends/edits the final message.
   * Returns the message ID of the delivered message.
   */
  async finalize(finalText: string): Promise<string> {
    this.finalized = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    this.accumulated = finalText;
    return this.flush(true);
  }

  /**
   * Clean up a streaming delivery that was interrupted.
   * Cancels pending timers and deletes the partial message.
   */
  async cleanup(): Promise<void> {
    this.finalized = true;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
    if (this.sentMessageId) {
      try {
        await this.provider.deleteMessage(this.chatId, this.sentMessageId);
      } catch { /* best-effort */ }
      this.sentMessageId = null;
    }
  }

  private scheduleFlush(): void {
    if (this.editTimer) return;
    const elapsed = Date.now() - this.lastEditAt;
    const delay = Math.max(0, this.config.editIntervalMs - elapsed);
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.flush(false).catch(err => {
        logger.debug({ chatId: this.chatId, err }, 'Streaming flush error');
      });
    }, delay);
  }

  private async flush(isFinal: boolean): Promise<string> {
    const text = this.accumulated.trim();
    if (!text) {
      return this.sentMessageId || '';
    }

    try {
      if (this.sentMessageId && text.length <= this.config.maxEditLength) {
        // Edit existing message in-place
        const result = await this.provider.editMessage(this.chatId, this.sentMessageId, text);
        this.lastEditAt = Date.now();
        if (result.messageId) this.sentMessageId = result.messageId;
      } else if (this.sentMessageId && text.length > this.config.maxEditLength) {
        // Text exceeds edit limit — send a new message with the overflow
        if (isFinal) {
          // On final, edit the old message with truncated text and send remainder
          const truncated = text.slice(0, this.config.maxEditLength);
          await this.provider.editMessage(this.chatId, this.sentMessageId, truncated);
          const remainder = text.slice(this.config.maxEditLength);
          if (remainder.trim()) {
            const result = await this.provider.sendMessage(this.chatId, remainder, {
              threadId: this.options.threadId,
            });
            if (result.messageId) this.sentMessageId = result.messageId;
          }
        }
        // During streaming, just edit with what fits — final will handle overflow
        else {
          const truncated = text.slice(0, this.config.maxEditLength);
          await this.provider.editMessage(this.chatId, this.sentMessageId, truncated);
        }
        this.lastEditAt = Date.now();
      } else {
        // First message — send new
        const result = await this.provider.sendMessage(this.chatId, text, {
          replyToMessageId: this.options.replyToMessageId,
          threadId: this.options.threadId,
        });
        this.lastEditAt = Date.now();
        if (result.messageId) this.sentMessageId = result.messageId;
      }
    } catch (err) {
      logger.debug({ chatId: this.chatId, err }, 'Streaming delivery error');
    }

    return this.sentMessageId || '';
  }
}

/**
 * Async generator that watches a stream directory for chunk files
 * written by the container agent-runner.
 *
 * Chunk files are named `chunk_NNNNNN.txt` and written sequentially.
 * The generator yields chunk contents in order and stops when a `done`
 * or `error` sentinel file appears, or the abort signal fires.
 */
export async function* watchStreamChunks(
  streamDir: string,
  abortSignal?: AbortSignal
): AsyncGenerator<string> {
  let seq = 0;
  const wakeSignal = new DirectoryWakeSignal(streamDir, abortSignal);
  const pollMs = STREAM_CHUNK_POLL_MS;

  try {
    while (!abortSignal?.aborted) {
      // Check for sentinel files
      if (fs.existsSync(path.join(streamDir, 'done'))) {
        // Yield remaining chunks, including chunks that arrive just after
        // the done sentinel due to filesystem scheduling races.
        yield* drainRemainingChunksWithGrace(streamDir, seq, wakeSignal, pollMs, abortSignal);
        return;
      }
      if (fs.existsSync(path.join(streamDir, 'error'))) {
        // Yield remaining chunks before exiting on error sentinel.
        yield* drainRemainingChunksWithGrace(streamDir, seq, wakeSignal, pollMs, abortSignal);
        return;
      }

      const nextSeq = seq + 1;
      const chunkFile = path.join(streamDir, `chunk_${String(nextSeq).padStart(6, '0')}.txt`);
      if (fs.existsSync(chunkFile)) {
        try {
          const content = fs.readFileSync(chunkFile, 'utf-8');
          seq = nextSeq;
          yield content;
        } catch {
          // File might be partially written; retry shortly.
          await wakeSignal.wait(pollMs);
        }
      } else {
        await wakeSignal.wait(pollMs);
      }
    }
  } finally {
    wakeSignal.close();
  }

  // Aborted
  throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

async function* drainRemainingChunksWithGrace(
  streamDir: string,
  startSeq: number,
  wakeSignal: DirectoryWakeSignal,
  pollMs: number,
  abortSignal?: AbortSignal
): AsyncGenerator<string> {
  let seq = startSeq;
  let misses = 0;
  const maxMisses = 3;
  for (;;) {
    if (abortSignal?.aborted) return;
    const nextSeq = seq + 1;
    const chunkFile = path.join(streamDir, `chunk_${String(nextSeq).padStart(6, '0')}.txt`);
    if (!fs.existsSync(chunkFile)) {
      if (misses >= maxMisses) break;
      misses += 1;
      await wakeSignal.wait(pollMs);
      continue;
    }
    try {
      const content = fs.readFileSync(chunkFile, 'utf-8');
      seq = nextSeq;
      misses = 0;
      yield content;
    } catch {
      if (misses >= maxMisses) break;
      misses += 1;
      await wakeSignal.wait(pollMs);
    }
  }
}
