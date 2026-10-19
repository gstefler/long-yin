import type { ActivityCounts, ActivityHour } from './cache-activity';
import type { CacheEntryMeta } from './cache-index';

/** One audio file in the cache directory. */
export interface CachedFile {
  name: string;
  size: number;
  /** Last played or written: hits touch it, which is what makes eviction LRU. */
  mtimeMs: number;
}

export interface UsageBucket {
  /** Played or written within this many days; `null` for the oldest bucket. */
  withinDays: number | null;
  files: number;
  bytes: number;
}

export interface VoiceUsage {
  /** `null` for files cached before the service recorded voices. */
  voice: string | null;
  files: number;
  bytes: number;
}

export interface EvictionStats {
  runs: number;
  files: number;
  bytes: number;
  lastAt: string | null;
}

export interface RateLimitSnapshot {
  limit: number;
  windowSeconds: number;
  used: number;
  queued: number;
}

/** GET /api/cache/status. Aggregates only: no texts or filenames leave the service. */
export interface CacheStatus {
  generatedAt: string;
  provider: 'azure' | 'edge';
  uptimeSeconds: number;
  disk: {
    files: number;
    bytes: number;
    /** Eviction starts above this… */
    maxBytes: number;
    /** …and deletes least recently used files until the cache is back under this. */
    targetBytes: number;
    oldestUsedAt: string | null;
    newestUsedAt: string | null;
  };
  lastUsed: UsageBucket[];
  voices: VoiceUsage[];
  activity: { since: string; totals: ActivityCounts; hourly: ActivityHour[] };
  /** Syntheses running right now. */
  inFlight: number;
  evictions: EvictionStats;
  /** The Azure request budget; `null` on Edge, which has none. */
  rateLimit: RateLimitSnapshot | null;
}

const DAY_MS = 86_400_000;
export const USAGE_BUCKET_DAYS = [1, 7, 30] as const;

/** The parts of the status that come from the files on disk. */
export function summarizeFiles(
  files: CachedFile[],
  meta: (name: string) => CacheEntryMeta | undefined,
  now: number
): Pick<CacheStatus, 'lastUsed' | 'voices'> & {
  files: number;
  bytes: number;
  oldestUsedAt: string | null;
  newestUsedAt: string | null;
} {
  const lastUsed: UsageBucket[] = [...USAGE_BUCKET_DAYS, null].map((withinDays) => ({ withinDays, files: 0, bytes: 0 }));
  const voices = new Map<string | null, VoiceUsage>();
  let bytes = 0;
  let oldest = Infinity;
  let newest = -Infinity;

  for (const file of files) {
    bytes += file.size;
    oldest = Math.min(oldest, file.mtimeMs);
    newest = Math.max(newest, file.mtimeMs);

    const ageDays = (now - file.mtimeMs) / DAY_MS;
    const bucket = lastUsed.find((b) => b.withinDays === null || ageDays <= b.withinDays)!;
    bucket.files++;
    bucket.bytes += file.size;

    const voice = meta(file.name)?.voice ?? null;
    const usage = voices.get(voice) ?? { voice, files: 0, bytes: 0 };
    usage.files++;
    usage.bytes += file.size;
    voices.set(voice, usage);
  }

  return {
    files: files.length,
    bytes,
    oldestUsedAt: files.length ? new Date(oldest).toISOString() : null,
    newestUsedAt: files.length ? new Date(newest).toISOString() : null,
    lastUsed,
    // Biggest first; unrecorded files last, whatever their size.
    voices: [...voices.values()].sort(
      (a, b) => Number(a.voice === null) - Number(b.voice === null) || b.bytes - a.bytes
    ),
  };
}
