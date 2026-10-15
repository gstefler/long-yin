import { Context } from 'hono';
import { azureSpeech } from '../services/azure-speech';
import { cacheService } from '../services/cache.service';

export class HealthController {
  public getHealth(c: Context) {
    const stats = cacheService.getStats();
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      provider: azureSpeech ? 'azure' : 'edge',
      cache: stats,
    });
  }
}

export const healthController = new HealthController();
