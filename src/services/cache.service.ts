import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, MAX_CACHE_SIZE_MB, TARGET_CACHE_SIZE_MB } from '../config/constants';
import { CacheStats } from '../types';

export class CacheService {
  constructor() {
    this.ensureCacheDirectoryExists();
  }

  private ensureCacheDirectoryExists(): void {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
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
    const filePath = join(CACHE_DIR, filename);
    return existsSync(filePath);
  }

  /**
   * Retrieves a file path from cache.
   */
  public getFilePath(filename: string): string {
    return join(CACHE_DIR, filename);
  }

  /**
   * Saves raw ArrayBuffer audio data to the local cache.
   */
  public async save(filename: string, data: ArrayBuffer): Promise<void> {
    const filePath = join(CACHE_DIR, filename);
    await Bun.write(filePath, data);

    // Asynchronously prune cache in the background (no await)
    this.pruneCacheAsynchronously();
  }

  /**
   * Checks the cache folder size and prunes the oldest files if it exceeds the limit.
   * This is executed asynchronously in the background so it doesn't block request processing.
   */
  private async pruneCacheAsynchronously(): Promise<void> {
    try {
      const stats = this.getStats();
      const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
      
      if (stats.sizeBytes <= maxSizeBytes) {
        return;
      }

      console.log(`[CacheService] Cache limit exceeded (${stats.sizeKB} KB > ${MAX_CACHE_SIZE_MB * 1024} KB). Triggering eviction...`);

      const files = readdirSync(CACHE_DIR);
      const fileInfos = files
        .map((name) => {
          const filePath = join(CACHE_DIR, name);
          const fStat = statSync(filePath);
          return {
            name,
            path: filePath,
            size: fStat.size,
            mtime: fStat.mtime.getTime(),
          };
        })
        .filter((info) => statSync(info.path).isFile());

      // Sort files by modified time ascending (oldest first)
      fileInfos.sort((a, b) => a.mtime - b.mtime);

      let currentSizeBytes = stats.sizeBytes;
      const targetSizeBytes = TARGET_CACHE_SIZE_MB * 1024 * 1024;
      let deletedCount = 0;
      let freedBytes = 0;

      for (const fileInfo of fileInfos) {
        if (currentSizeBytes <= targetSizeBytes) {
          break;
        }

        try {
          unlinkSync(fileInfo.path);
          currentSizeBytes -= fileInfo.size;
          freedBytes += fileInfo.size;
          deletedCount++;
        } catch (e) {
          console.error(`[CacheService] Failed to delete cache file ${fileInfo.name}:`, e);
        }
      }

      console.log(`[CacheService] Eviction completed. Deleted ${deletedCount} files, freeing ${(freedBytes / 1024 / 1024).toFixed(2)} MB.`);
    } catch (error) {
      console.error('[CacheService] Error running cache eviction:', error);
    }
  }

  /**
   * Returns stats (number of files and size) of the cache directory.
   */
  public getStats(): CacheStats {
    try {
      const files = readdirSync(CACHE_DIR);
      let totalSize = 0;

      files.forEach((file) => {
        const stats = statSync(join(CACHE_DIR, file));
        if (stats.isFile()) {
          totalSize += stats.size;
        }
      });

      return {
        directory: CACHE_DIR,
        fileCount: files.length,
        sizeBytes: totalSize,
        sizeKB: Math.round(totalSize / 1024),
      };
    } catch (error) {
      return {
        directory: CACHE_DIR,
        fileCount: 0,
        sizeBytes: 0,
        sizeKB: 0,
      };
    }
  }
}

export const cacheService = new CacheService();
