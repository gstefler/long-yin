import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheActivity } from '../src/services/cache-activity';
import { CacheIndex, INDEX_FILENAME } from '../src/services/cache-index';
import { summarizeFiles } from '../src/services/cache-status';
import { CacheService } from '../src/services/cache.service';
import { RateLimiter } from '../src/services/rate-limiter';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const meta = (voice: string) => ({ voice, rate: '+0%', pitch: '+0Hz', volume: '+0%' });

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'long-yin-cache-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('summarizes files by last use and by voice, unrecorded voices last', () => {
  const now = 100 * DAY;
  const files = [
    { name: 'a.mp3', size: 100, mtimeMs: now - HOUR },
    { name: 'b.mp3', size: 200, mtimeMs: now - 3 * DAY },
    { name: 'c.mp3', size: 300, mtimeMs: now - 20 * DAY },
    { name: 'd.mp3', size: 900, mtimeMs: now - 90 * DAY },
    { name: 'e.mp3', size: 50, mtimeMs: now - 2 * HOUR },
  ];
  const voices: Record<string, string> = { 'a.mp3': 'X', 'b.mp3': 'Y', 'c.mp3': 'Y' };
  const summary = summarizeFiles(files, (name) => (voices[name] ? meta(voices[name]) : undefined), now);

  expect(summary.files).toBe(5);
  expect(summary.bytes).toBe(1550);
  expect(summary.oldestUsedAt).toBe(new Date(now - 90 * DAY).toISOString());
  expect(summary.newestUsedAt).toBe(new Date(now - HOUR).toISOString());
  expect(summary.lastUsed).toEqual([
    { withinDays: 1, files: 2, bytes: 150 },
    { withinDays: 7, files: 1, bytes: 200 },
    { withinDays: 30, files: 1, bytes: 300 },
    { withinDays: null, files: 1, bytes: 900 },
  ]);
  // The unrecorded files are the biggest group, yet still listed last.
  expect(summary.voices).toEqual([
    { voice: 'Y', files: 2, bytes: 500 },
    { voice: 'X', files: 1, bytes: 100 },
    { voice: null, files: 2, bytes: 950 },
  ]);
});

test('an empty cache has no dates and empty buckets', () => {
  const summary = summarizeFiles([], () => undefined, Date.now());
  expect(summary).toMatchObject({ files: 0, bytes: 0, oldestUsedAt: null, newestUsedAt: null, voices: [] });
  expect(summary.lastUsed.every((b) => b.files === 0)).toBe(true);
});

test('activity counts totals and the last 24 hours, oldest first', () => {
  let now = 1000 * HOUR + 5;
  const activity = new CacheActivity(() => now);
  activity.record('hit');
  activity.record('hit');
  activity.record('miss');
  now += HOUR;
  activity.record('precached');
  activity.record('failed');

  const snap = activity.snapshot();
  expect(snap.totals).toEqual({ hits: 2, misses: 1, precached: 1, failed: 1 });
  expect(snap.hourly).toHaveLength(24);
  expect(snap.hourly.at(-1)).toEqual({ hour: new Date(1001 * HOUR).toISOString(), hits: 0, misses: 0, precached: 1, failed: 1 });
  expect(snap.hourly.at(-2)).toMatchObject({ hits: 2, misses: 1 });

  // A day later the old hours fall out of the chart but stay in the totals.
  now += 30 * HOUR;
  activity.record('hit');
  const later = activity.snapshot();
  expect(later.hourly.reduce((n, h) => n + h.hits + h.misses + h.precached + h.failed, 0)).toBe(1);
  expect(later.totals.hits).toBe(3);
});

test('the voice index survives a restart and drops files that are gone', () => {
  const dir = tempDir();
  const index = new CacheIndex(dir);
  index.set('a.mp3', meta('X'));
  index.set('b.mp3', meta('Y'));
  index.flush();

  const reloaded = new CacheIndex(dir);
  expect(reloaded.get('a.mp3')?.voice).toBe('X');
  reloaded.retain(new Set(['b.mp3']));
  reloaded.flush();
  expect(new CacheIndex(dir).get('a.mp3')).toBeUndefined();
  expect(new CacheIndex(dir).get('b.mp3')?.voice).toBe('Y');
});

test('an unreadable index is ignored, not fatal', () => {
  const dir = tempDir();
  writeFileSync(join(dir, INDEX_FILENAME), '{not json');
  expect(new CacheIndex(dir).get('a.mp3')).toBeUndefined();
});

test('the index is neither counted as audio nor evicted', async () => {
  const dir = tempDir();
  const cache = new CacheService({ dir, maxBytes: 250, targetBytes: 200 });
  await cache.save('old.mp3', new ArrayBuffer(100), meta('X'));
  utimesSync(join(dir, 'old.mp3'), new Date(Date.now() - DAY), new Date(Date.now() - DAY));
  cache.flushIndex();
  utimesSync(join(dir, INDEX_FILENAME), new Date(0), new Date(0)); // the oldest file there
  await cache.save('mid.mp3', new ArrayBuffer(100), meta('Y'));
  await cache.save('new.mp3', new ArrayBuffer(100), meta('Y'));
  await Bun.sleep(10); // eviction runs in the background

  expect(existsSync(join(dir, INDEX_FILENAME))).toBe(true);
  expect(cache.has('old.mp3')).toBe(false);
  const status = cache.diskStatus();
  expect(status.disk).toMatchObject({ files: 2, bytes: 200, maxBytes: 250, targetBytes: 200 });
  expect(status.voices).toEqual([{ voice: 'Y', files: 2, bytes: 200 }]);
  expect(status.evictions).toMatchObject({ runs: 1, files: 1, bytes: 100 });
  cache.flushIndex();
  expect(Object.keys(JSON.parse(readFileSync(join(dir, INDEX_FILENAME), 'utf8')).entries).sort()).toEqual([
    'mid.mp3',
    'new.mp3',
  ]);
});

test('a hit makes the file recently used, so eviction is LRU', async () => {
  const dir = tempDir();
  const cache = new CacheService({ dir });
  await cache.save('a.mp3', new ArrayBuffer(10));
  const past = new Date(Date.now() - 10 * DAY);
  utimesSync(join(dir, 'a.mp3'), past, past);
  cache.touch('a.mp3');
  await Bun.sleep(20);
  expect(Date.now() - statSync(join(dir, 'a.mp3')).mtimeMs).toBeLessThan(DAY);
});

test('the rate limiter reports its window', async () => {
  const limiter = new RateLimiter(2, 100, 0);
  for (let i = 0; i < 3; i++) limiter.acquire('playback');
  await new Promise((r) => setTimeout(r, 0));
  expect(limiter.snapshot()).toEqual({ limit: 2, windowSeconds: 0, used: 2, queued: 1 });
});
