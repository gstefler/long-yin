import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What a cached file was synthesized with, minus the text. Read by the cache status. */
export interface CacheEntryMeta {
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
}

/**
 * Dotfile so it is never mistaken for audio: CacheService only counts and evicts `.mp3`
 * files. It lives in the cache directory because that is the only path on the volume.
 */
export const INDEX_FILENAME = '.index.json';

const FLUSH_DELAY_MS = 2_000;

/**
 * Remembers each cached file's voice and prosody. The filename is a hash of them, so
 * without this the status could count files but never say whose voice they are. Files
 * cached before the index existed simply have no entry and are reported as unrecorded.
 *
 * Writes are batched (a dialogue precache saves dozens of files in a row) and atomic
 * (tmp + rename), so a crash can lose the last couple of seconds but never corrupt it.
 */
export class CacheIndex {
  private entries = new Map<string, CacheEntryMeta>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dir: string) {
    this.load();
  }

  get(filename: string): CacheEntryMeta | undefined {
    return this.entries.get(filename);
  }

  set(filename: string, meta: CacheEntryMeta): void {
    this.entries.set(filename, { voice: meta.voice, rate: meta.rate, pitch: meta.pitch, volume: meta.volume });
    this.scheduleFlush();
  }

  delete(filename: string): void {
    if (this.entries.delete(filename)) this.scheduleFlush();
  }

  /** Drops entries whose file is gone (deleted by hand, or evicted before a flush). */
  retain(existing: Set<string>): void {
    let changed = false;
    for (const name of this.entries.keys()) {
      if (!existing.has(name)) {
        this.entries.delete(name);
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  /** Writes pending changes now. Called by the batching timer; tests call it directly. */
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const path = join(this.dir, INDEX_FILENAME);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }));
      renameSync(tmp, path);
    } catch (error) {
      console.error('[CacheIndex] Failed to write the cache index:', error);
    }
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    // A pending write must not keep the process (or a test run) alive.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private load(): void {
    const path = join(this.dir, INDEX_FILENAME);
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Record<string, CacheEntryMeta> };
      for (const [name, meta] of Object.entries(raw.entries ?? {})) {
        if (meta && typeof meta.voice === 'string') this.entries.set(name, meta);
      }
    } catch (error) {
      // Unreadable: start over. It only labels files, so nothing is lost but labels.
      console.warn('[CacheIndex] Ignoring an unreadable cache index:', (error as Error).message);
    }
  }
}
