// Semaphore-based concurrency limiter with bounded queue.
// Prevents fork-bombing when many requests arrive simultaneously.

export interface QueueOptions {
  maxConcurrent?: number;
  maxQueueSize?: number;
  queueTimeoutMs?: number;
}

export interface QueueStats {
  running: number;
  queued: number;
  maxConcurrent: number;
  maxQueueSize: number;
  totalProcessed: number;
  totalRejected: number;
}

export class RequestQueue {
  private maxConcurrent: number;
  private maxQueueSize: number;
  private queueTimeoutMs: number;
  private running = 0;
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private totalProcessed = 0;
  private totalRejected = 0;

  constructor(opts: QueueOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 5;
    this.maxQueueSize = opts.maxQueueSize ?? 50;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 30_000;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const result = await fn();
      this.totalProcessed++;
      return result;
    } finally {
      this.release();
    }
  }

  stats(): QueueStats {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize,
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
    };
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.totalRejected++;
      return Promise.reject(new QueueFullError());
    }

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        this.totalRejected++;
        reject(new QueueTimeoutError());
      }, this.queueTimeoutMs);

      this.queue.push({ resolve, reject, timer });
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      next.resolve();
    } else {
      this.running--;
    }
  }
}

export class QueueFullError extends Error {
  constructor() {
    super("Server is at capacity. Try again later.");
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends Error {
  constructor() {
    super("Request timed out waiting in queue.");
    this.name = "QueueTimeoutError";
  }
}
