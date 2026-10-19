import { Context } from 'hono';
import { azureSpeech } from '../services/azure-speech';
import { cacheService } from '../services/cache.service';
import type { CacheStatus } from '../services/cache-status';

export class CacheController {
  /**
   * GET /api/cache/status — how full the audio cache is, what is in it (by voice and by
   * when it was last played), and how playback has fared since start (hits, misses,
   * precached, failed; also hour by hour). Aggregates only, never texts or filenames.
   */
  public getStatus(c: Context) {
    const status: CacheStatus = {
      generatedAt: new Date().toISOString(),
      provider: azureSpeech ? 'azure' : 'edge',
      uptimeSeconds: Math.round(process.uptime()),
      ...cacheService.diskStatus(),
      activity: cacheService.activity.snapshot(),
      inFlight: cacheService.inFlight,
      rateLimit: azureSpeech ? azureSpeech.limiter.snapshot() : null,
    };
    c.header('Cache-Control', 'no-store');
    return c.json(status);
  }
}

export const cacheController = new CacheController();
