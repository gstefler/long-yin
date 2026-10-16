import { TtsRequestParams } from '../types';
import { azureSpeech } from './azure-speech';
import { cacheService } from './cache.service';
import { EdgeSession } from './edge-session';
import { parseTtsParams, TtsValidationError } from './ssml';

/** A dialogue is at most 60 lines in the app; leave headroom without inviting abuse. */
export const MAX_PRECACHE_ITEMS = 100;

export class PrecacheValidationError extends Error {}

/**
 * Lines a running batch has taken on but not reached yet. Playback ignores this (it
 * would rather synthesize a line now than wait its turn in someone's batch), but a
 * second batch skips them — two people opening the same dialogue, or one sending it
 * twice, must not open a second Edge connection for the same lines.
 */
const claimed = new Set<string>();

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
    try {
      return parseTtsParams((raw ?? {}) as Record<string, unknown>);
    } catch (error) {
      if (error instanceof TtsValidationError) throw new PrecacheValidationError(`item ${i}: ${error.message}`);
      throw error;
    }
  });
}

/**
 * Makes sure every item is in the audio cache, synthesizing only what is missing — on
 * Azure when configured, else all of it over one reused Edge connection (see
 * EdgeSession), so a whole dialogue costs a single handshake. Cache keys are exactly
 * the GET /api/tts route's, so later playback of these lines is a HIT. A dropped socket
 * is reopened and the batch carries on; an item that fails is counted and skipped —
 * playback will simply synthesize it then.
 *
 * Repeating a batch is free: every line is a cache hit, or claimed by the batch still
 * working on it, so no connection is opened and nothing is synthesized or rate-limited.
 */
export async function precache(items: TtsRequestParams[]): Promise<PrecacheSummary> {
  const summary: PrecacheSummary = { total: items.length, cached: 0, synthesized: 0, failed: 0 };

  // Distinct and not yet cached (or already on its way via another request or batch).
  // Claimed as the scan finds them, not after it: the scan awaits a hash per line, and
  // an identical batch scanning alongside would otherwise take the same lines.
  const todo: { item: TtsRequestParams; filename: string }[] = [];
  const seen = new Set<string>();
  try {
    for (const item of items) {
      const filename = await cacheService.getCacheFilename(item.text, item.voice, item.rate, item.pitch, item.volume);
      if (seen.has(filename)) {
        summary.cached++;
        continue;
      }
      seen.add(filename);
      if (cacheService.has(filename) || cacheService.pendingFor(filename) || claimed.has(filename)) {
        summary.cached++;
      } else {
        claimed.add(filename);
        todo.push({ item, filename });
      }
    }
    if (todo.length === 0) return summary;
    return await (azureSpeech ? precacheViaAzure(todo, summary) : precacheViaEdge(todo, summary));
  } finally {
    for (const { filename } of todo) claimed.delete(filename);
  }
}

async function precacheViaEdge(
  todo: { item: TtsRequestParams; filename: string }[],
  summary: PrecacheSummary
): Promise<PrecacheSummary> {
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

/**
 * Azure has no handshake to save, only a request budget (20 a minute on the free tier):
 * one line at a time in the limiter's precache lane, so playback keeps priority.
 */
async function precacheViaAzure(
  todo: { item: TtsRequestParams; filename: string }[],
  summary: PrecacheSummary
): Promise<PrecacheSummary> {
  for (const { item, filename } of todo) {
    if (cacheService.has(filename) || cacheService.pendingFor(filename)) {
      summary.cached++;
      continue;
    }
    try {
      await cacheService.track(
        filename,
        azureSpeech!.synthesize(item, 'precache').then((audio) => cacheService.save(filename, audio))
      );
      summary.synthesized++;
    } catch (error) {
      summary.failed++;
      console.warn(`[Precache] ${item.voice} "${item.text.slice(0, 20)}" failed: ${(error as Error).message}`);
    }
  }
  return summary;
}
