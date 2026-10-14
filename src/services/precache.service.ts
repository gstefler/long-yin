import { DEFAULT_TTS_CONFIG } from '../config/constants';
import { TtsRequestParams } from '../types';
import { cacheService } from './cache.service';
import { EdgeSession } from './edge-session';

/** A dialogue is at most 60 lines in the app; leave headroom without inviting abuse. */
export const MAX_PRECACHE_ITEMS = 100;
const MAX_TEXT_LENGTH = 500;

// These go into SSML attributes verbatim, so only well-formed values get through.
const VOICE = /^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$/;
const PERCENT = /^[+-]\d{1,3}%$/;
const HERTZ = /^[+-]\d{1,3}Hz$/;

export class PrecacheValidationError extends Error {}

export interface PrecacheSummary {
  total: number;
  cached: number;
  synthesized: number;
  failed: number;
}

/** Validates the request body into synthesis params, filling the GET route's defaults. */
export function parsePrecacheItems(body: unknown): TtsRequestParams[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new PrecacheValidationError('items must be a non-empty array');
  }
  if (items.length > MAX_PRECACHE_ITEMS) {
    throw new PrecacheValidationError(`at most ${MAX_PRECACHE_ITEMS} items`);
  }
  return items.map((raw, i) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LENGTH) {
      throw new PrecacheValidationError(`item ${i}: text must be 1-${MAX_TEXT_LENGTH} characters`);
    }
    const field = (name: string, fallback: string, pattern: RegExp) => {
      const value = item[name] === undefined || item[name] === '' ? fallback : item[name];
      if (typeof value !== 'string' || !pattern.test(value)) {
        throw new PrecacheValidationError(`item ${i}: invalid ${name}`);
      }
      return value;
    };
    return {
      text,
      voice: field('voice', DEFAULT_TTS_CONFIG.voice, VOICE),
      rate: field('rate', DEFAULT_TTS_CONFIG.rate, PERCENT),
      pitch: field('pitch', DEFAULT_TTS_CONFIG.pitch, HERTZ),
      volume: field('volume', DEFAULT_TTS_CONFIG.volume, PERCENT),
    };
  });
}

/**
 * Makes sure every item is in the audio cache, synthesizing only what is missing — all
 * of it over one reused Edge connection (see EdgeSession), so a whole dialogue costs a
 * single handshake. Cache keys are exactly the GET /api/tts route's, so later playback
 * of these lines is a HIT. A dropped socket is reopened and the batch carries on; an
 * item that fails is counted and skipped — playback will simply synthesize it then.
 */
export async function precache(items: TtsRequestParams[]): Promise<PrecacheSummary> {
  const summary: PrecacheSummary = { total: items.length, cached: 0, synthesized: 0, failed: 0 };

  // Distinct and not yet cached (or already on its way via another request).
  const todo: { item: TtsRequestParams; filename: string }[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const filename = await cacheService.getCacheFilename(item.text, item.voice, item.rate, item.pitch, item.volume);
    if (seen.has(filename)) {
      summary.cached++;
      continue;
    }
    seen.add(filename);
    if (cacheService.has(filename) || cacheService.pendingFor(filename)) summary.cached++;
    else todo.push({ item, filename });
  }
  if (todo.length === 0) return summary;

  const session = new EdgeSession();
  try {
    for (let i = 0; i < todo.length; i++) {
      const { item, filename } = todo[i]!;
      // Something else may have started it since the scan.
      if (cacheService.has(filename) || cacheService.pendingFor(filename)) {
        summary.cached++;
        continue;
      }
      if (!session.isOpen) {
        try {
          await session.open();
        } catch (error) {
          // Every handshake was refused: Microsoft won't take one right now, and the rest
          // would fail the same way. Playback synthesizes them later instead.
          summary.failed += todo.length - i;
          console.warn(`[Precache] giving up on ${todo.length - i} items: ${(error as Error).message}`);
          break;
        }
      }
      try {
        await cacheService.track(
          filename,
          session.synthesize(item).then((audio) => cacheService.save(filename, audio))
        );
        summary.synthesized++;
      } catch (error) {
        // Usually a dropped socket; the next item reopens it.
        summary.failed++;
        console.warn(`[Precache] ${item.voice} "${item.text.slice(0, 20)}" failed: ${(error as Error).message}`);
      }
    }
  } finally {
    session.close();
  }
  return summary;
}
