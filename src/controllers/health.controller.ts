import { Context } from 'hono';
import { cacheService } from '../services/cache.service';

export class HealthController {
  public getHealth(c: Context) {
    const stats = cacheService.getStats();
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      cache: stats,
    });
  }
}

export const healthController = new HealthController();
