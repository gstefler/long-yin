import { Context } from 'hono';
import { parsePrecacheItems, precache, PrecacheValidationError } from '../services/precache.service';

export class PrecacheController {
  /**
   * POST /api/tts/precache — `{ items: [{ text, voice?, rate?, pitch?, volume? }] }`.
   * Answers once every item is cached (or has failed) with
   * `{ total, cached, synthesized, failed }`. Callers that only want the cache warm can
   * fire and forget: the work finishes even if they disconnect.
   */
  public async handlePrecache(c: Context) {
    let items;
    try {
      items = parsePrecacheItems(await c.req.json().catch(() => null));
    } catch (error) {
      if (error instanceof PrecacheValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
    try {
      return c.json(await precache(items));
    } catch (error) {
      console.error('Precache controller error:', error);
      return c.json({ error: (error as Error).message || 'Precache failed' }, 500);
    }
  }
}

export const precacheController = new PrecacheController();
