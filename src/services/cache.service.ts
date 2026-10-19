import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR, MAX_CACHE_SIZE_MB, TARGET_CACHE_SIZE_MB } from '../config/constants';
import { CacheStats } from '../types';
import { CacheActivity } from './cache-activity';
import { CacheEntryMeta, CacheIndex } from './cache-index';
import { CachedFile, EvictionStats, summarizeFiles } from './cache-status';

const MB = 1024 * 1024;

export interface CacheServiceOptions {
  dir?: string;
  maxBytes?: number;
  targetBytes?: number;
}

export class CacheService {
  readonly dir: string;
  readonly maxBytes: number;
  readonly targetBytes: number;
  /** Hits and misses since start, recorded by the routes that serve audio. */
  readonly activity = new CacheActivity();
  private readonly index: CacheIndex;
  private evictions: EvictionStats = { runs: 0, files: 0, bytes: 0, lastAt: null };

  /**
   * Syntheses in progress, by cache filename. A line being precached is often requested
   * by playback moments later; waiting for it costs nothing, synthesizing it again costs
   * another Microsoft handshake.
   */
  private pending = new Map<string, Promise<unknown>>();

  constructor(options: CacheServiceOptions = {}) {
    this.dir = options.dir ?? CACHE_DIR;
    this.maxBytes = options.maxBytes ?? MAX_CACHE_SIZE_MB * MB;
    this.targetBytes = options.targetBytes ?? TARGET_CACHE_SIZE_MB * MB;
    this.ensureCacheDirectoryExists();
    this.index = new CacheIndex(this.dir);
  }

  private ensureCacheDirectoryExists(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  /**
   * Generates a unique, URL-safe filename based on text, voice, and prosody parameters.
   */
  public async getCacheFilename(
    text: string,
    voice: string,
    rate: string,
    pitch: string,
    volume: string
  ): Promise<string> {
    const inputStr = `${text}_${voice}_${rate}_${pitch}_${volume}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(inputStr);
    
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

    const safePrefix = text
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
      .slice(0, 15);

    return `${safePrefix || 'tts'}_${hashHex.slice(0, 12)}.mp3`;
  }

  /**
   * Checks if an audio file exists in the cache folder.
   */
  public has(filename: string): boolean {
    const filePath = join(this.dir, filename);
    return existsSync(filePath);
  }

  /**
   * Marks a file as just used. Eviction deletes by mtime, so without this it removed the
   * oldest *written* file — a line played every day went first — instead of the least
   * recently used one. Fire and forget: a hit never waits on it.
   */
  public touch(filename: string): void {
    const now = new Date();
    utimes(join(this.dir, filename), now, now).catch(() => {});
  }

  /** Syntheses running right now. */
  public get inFlight(): number {
    return this.pending.size;
  }

  /** The in-progress synthesis of `filename`, if any. */
  public pendingFor(filename: string): Promise<unknown> | undefined {
    return this.pending.get(filename);
  }

  /** Registers `work` as the in-progress synthesis of `filename` until it settles. */
  public track<T>(filename: string, work: Promise<T>): Promise<T> {
    this.pending.set(filename, work);
    const clear = () => {
      if (this.pending.get(filename) === work) this.pending.delete(filename);
    };
    work.then(clear, clear);
    return work;
  }

  /**
   * Retrieves a file path from cache.
   */
  public getFilePath(filename: string): string {
    return join(this.dir, filename);
  }

  /**
   * Saves raw ArrayBuffer audio data to the local cache, recording what it was
   * synthesized with (`meta`, the request minus its text) for the cache status.
   */
  public async save(filename: string, data: ArrayBuffer, meta?: CacheEntryMeta): Promise<void> {
    const filePath = join(this.dir, filename);
    await Bun.write(filePath, data);
    if (meta) this.index.set(filename, meta);

    // Asynchronously prune cache in the background (no await)
    this.pruneCacheAsynchronously();
  }

  /**
   * Checks the cache folder size and prunes the oldest files if it exceeds the limit.
   * This is executed asynchronously in the background so it doesn't block request processing.
   */
  private async pruneCacheAsynchronously(): Promise<void> {
    try {
      const files = this.listFiles();
      let currentSizeBytes = files.reduce((sum, f) => sum + f.size, 0);

      if (currentSizeBytes <= this.maxBytes) {
        return;
      }

      console.log(`[CacheService] Cache limit exceeded (${Math.round(currentSizeBytes / 1024)} KB > ${Math.round(this.maxBytes / 1024)} KB). Triggering eviction...`);

      // Least recently used first (hits touch the file, see touch()).
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let deletedCount = 0;
      let freedBytes = 0;

      for (const fileInfo of files) {
        if (currentSizeBytes <= this.targetBytes) {
          break;
        }

        try {
          unlinkSync(join(this.dir, fileInfo.name));
          this.index.delete(fileInfo.name);
          currentSizeBytes -= fileInfo.size;
          freedBytes += fileInfo.size;
          deletedCount++;
        } catch (e) {
          console.error(`[CacheService] Failed to delete cache file ${fileInfo.name}:`, e);
        }
      }

      this.evictions = {
        runs: this.evictions.runs + 1,
        files: this.evictions.files + deletedCount,
        bytes: this.evictions.bytes + freedBytes,
        lastAt: new Date().toISOString(),
      };
      console.log(`[CacheService] Eviction completed. Deleted ${deletedCount} files, freeing ${(freedBytes / 1024 / 1024).toFixed(2)} MB.`);
    } catch (error) {
      console.error('[CacheService] Error running cache eviction:', error);
    }
  }

  /**
   * The audio files in the cache directory. Only `.mp3`: the directory also holds the
   * voice index, which must be neither counted as audio nor evicted.
   */
  public listFiles(): CachedFile[] {
    const files: CachedFile[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.mp3')) continue;
      try {
        const stat = statSync(join(this.dir, name));
        if (stat.isFile()) files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Evicted between readdir and stat.
      }
    }
    return files;
  }

  /** Disk usage, last-used ages and voices, for GET /api/cache/status. */
  public diskStatus(now = Date.now()) {
    const files = this.listFiles();
    this.index.retain(new Set(files.map((f) => f.name)));
    const summary = summarizeFiles(files, (name) => this.index.get(name), now);
    return {
      disk: {
        files: summary.files,
        bytes: summary.bytes,
        maxBytes: this.maxBytes,
        targetBytes: this.targetBytes,
        oldestUsedAt: summary.oldestUsedAt,
        newestUsedAt: summary.newestUsedAt,
      },
      lastUsed: summary.lastUsed,
      voices: summary.voices,
      evictions: { ...this.evictions },
    };
  }

  /** Writes the voice index now rather than on its batching timer. */
  public flushIndex(): void {
    this.index.flush();
  }

  /**
   * Returns stats (number of files and size) of the cache directory.
   */
  public getStats(): CacheStats {
    try {
      const files = this.listFiles();
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      return {
        directory: this.dir,
        fileCount: files.length,
        sizeBytes: totalSize,
        sizeKB: Math.round(totalSize / 1024),
      };
    } catch (error) {
      return {
        directory: this.dir,
        fileCount: 0,
        sizeBytes: 0,
        sizeKB: 0,
      };
    }
  }
}

export const cacheService = new CacheService();
