export type Priority = 'playback' | 'precache';

interface Waiter {
  priority: Priority;
  resolve: () => void;
}

/**
 * A sliding-window request limiter with two lanes. Azure's free tier allows 20 syntheses
 * per 60 s, and one dialogue precache alone can be 60 lines — so precache queues behind
 * playback and never takes the last `reserve` slots of a window, which keeps a tap on
 * the play button from waiting a minute behind a batch it did not ask for.
 */
export class RateLimiter {
  private stamps: number[] = [];
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly reserve: number,
    private readonly now: () => number = Date.now
  ) {}

  acquire(priority: Priority): Promise<void> {
    return new Promise((resolve) => {
      const waiter = { priority, resolve };
      // Playback goes ahead of every queued precache, behind earlier playback.
      const at = priority === 'playback' ? this.queue.findIndex((w) => w.priority === 'precache') : -1;
      if (at === -1) this.queue.push(waiter);
      else this.queue.splice(at, 0, waiter);
      this.pump();
    });
  }

  /** Requests in the current window and waiting for a slot, for the cache status. */
  snapshot(): { limit: number; windowSeconds: number; used: number; queued: number } {
    const since = this.now() - this.windowMs;
    return {
      limit: this.limit,
      windowSeconds: Math.round(this.windowMs / 1000),
      used: this.stamps.filter((t) => t > since).length,
      queued: this.queue.length,
    };
  }

  private capacity(priority: Priority): number {
    return priority === 'playback' ? this.limit : Math.max(1, this.limit - this.reserve);
  }

  private pump() {
    const now = this.now();
    while (this.stamps.length && this.stamps[0]! <= now - this.windowMs) this.stamps.shift();
    while (this.queue.length && this.stamps.length < this.capacity(this.queue[0]!.priority)) {
      this.stamps.push(now);
      this.queue.shift()!.resolve();
    }
    if (this.queue.length && !this.timer) {
      // The oldest request in the window is the next slot to free up.
      const wait = Math.max(0, this.stamps[0]! + this.windowMs - now) + 5;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, wait);
    }
  }
}
