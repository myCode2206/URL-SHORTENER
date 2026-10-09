import type { Logger } from '../../utils/logger';
import type { ClickEvent, ClickRecorder } from './clickEvent';
import type { ClicksRepository } from './clicks.repository';

export interface BufferOptions {
  flushIntervalMs: number;
  // Flush early once this many clicks are waiting, without waiting for the timer.
  maxBatchSize: number;
  // Hard cap on memory. If the database is slow or down, clicks beyond this are
  // dropped rather than growing memory until the process crashes.
  maxBufferSize: number;
}

const DEFAULTS: BufferOptions = { flushIntervalMs: 1000, maxBatchSize: 500, maxBufferSize: 10_000 };

// Phase 4's way to record clicks without blocking: keep them in memory and
// write them in batches in the background.
//
// The trade-off: clicks still in the buffer are lost if the process crashes (a
// graceful shutdown flushes them). Phase 9 replaces this with a Redis Streams
// queue and a separate worker, which survives crashes, and reuses
// ClicksRepository.insertBatch to write.
export class BufferedClickRecorder implements ClickRecorder {
  private buffer: ClickEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private dropped = 0;
  private readonly options: BufferOptions;

  constructor(
    private readonly repository: Pick<ClicksRepository, 'insertBatch'>,
    private readonly logger: Logger,
    options: Partial<BufferOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    // The timer alone must not keep the process alive.
    this.timer.unref();
  }

  record(event: ClickEvent): void {
    if (this.buffer.length >= this.options.maxBufferSize) {
      this.dropped++;
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.options.maxBatchSize) void this.flush();
  }

  // Writes everything buffered so far. Concurrent callers share one flush, so
  // batches are written one at a time and in order.
  flush(): Promise<void> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.options.maxBatchSize);
      try {
        await this.repository.insertBatch(batch);
      } catch (err) {
        // Analytics is best-effort here: log, drop this batch, keep serving.
        // Putting it back would grow memory without limit during an outage.
        this.logger.error({ err, lostClicks: batch.length }, 'failed to write click batch');
        return;
      }
    }
    if (this.dropped > 0) {
      this.logger.warn({ droppedClicks: this.dropped }, 'click buffer was full; clicks dropped');
      this.dropped = 0;
    }
  }
}
