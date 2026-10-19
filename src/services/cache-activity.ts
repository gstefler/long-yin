/** What happened to one request for audio, as the cache status counts it. */
export type CacheEvent =
  /** Playback served from the cache, or by waiting on a synthesis already under way. */
  | 'hit'
  /** Playback had to synthesize it. */
  | 'miss'
  /** A precache batch synthesized it ahead of playback. */
  | 'precached'
  /** A synthesis failed (playback or precache). */
  | 'failed';

export interface ActivityCounts {
  hits: number;
  misses: number;
  precached: number;
  failed: number;
}

export interface ActivityHour extends ActivityCounts {
  /** Start of the hour, ISO 8601. */
  hour: string;
}

const HOUR_MS = 3_600_000;
export const ACTIVITY_HOURS = 24;

const zero = (): ActivityCounts => ({ hits: 0, misses: 0, precached: 0, failed: 0 });

const FIELD: Record<CacheEvent, keyof ActivityCounts> = {
  hit: 'hits',
  miss: 'misses',
  precached: 'precached',
  failed: 'failed',
};

/**
 * Hit/miss counters since the process started, plus the last 24 hours bucketed by hour.
 * In memory on purpose: it describes this process's traffic, and a restart (a deploy)
 * is a natural point to start counting again.
 */
export class CacheActivity {
  readonly startedAt: number;
  private totals = zero();
  /** Keyed by hour index (ms / HOUR_MS); only the last ACTIVITY_HOURS are kept. */
  private hours = new Map<number, ActivityCounts>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  record(event: CacheEvent): void {
    const field = FIELD[event];
    this.totals[field]++;
    const hour = Math.floor(this.now() / HOUR_MS);
    let bucket = this.hours.get(hour);
    if (!bucket) {
      bucket = zero();
      this.hours.set(hour, bucket);
      for (const key of this.hours.keys()) if (key <= hour - ACTIVITY_HOURS) this.hours.delete(key);
    }
    bucket[field]++;
  }

  /** Totals since start, and every one of the last 24 hours (empty ones included), oldest first. */
  snapshot(): { since: string; totals: ActivityCounts; hourly: ActivityHour[] } {
    const current = Math.floor(this.now() / HOUR_MS);
    const hourly: ActivityHour[] = [];
    for (let h = current - ACTIVITY_HOURS + 1; h <= current; h++) {
      hourly.push({ hour: new Date(h * HOUR_MS).toISOString(), ...(this.hours.get(h) ?? zero()) });
    }
    return { since: new Date(this.startedAt).toISOString(), totals: { ...this.totals }, hourly };
  }
}
