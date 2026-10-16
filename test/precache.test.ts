import { afterAll, expect, mock, test } from 'bun:test';
import { unlinkSync } from 'node:fs';

// A fake Edge connection: counts handshakes and syntheses, each line taking a moment so
// two batches overlap.
const counts = { opens: 0, syntheses: 0 };
mock.module('../src/services/edge-session', () => ({
  EdgeSession: class {
    isOpen = false;
    async open() {
      counts.opens++;
      this.isOpen = true;
    }
    async synthesize() {
      counts.syntheses++;
      await Bun.sleep(20);
      return new Uint8Array([1, 2, 3]).buffer;
    }
    close() {
      this.isOpen = false;
    }
  },
}));

const { precache } = await import('../src/services/precache.service');
const { cacheService } = await import('../src/services/cache.service');

// Unique per run, so the real cache directory never already holds them.
const run = crypto.randomUUID().slice(0, 8);
const items = ['一', '二', '三'].map((n) => ({
  text: `测试${n}${run}`,
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
}));

afterAll(async () => {
  for (const i of items) {
    const name = await cacheService.getCacheFilename(i.text, i.voice, i.rate, i.pitch, i.volume);
    try {
      unlinkSync(cacheService.getFilePath(name));
    } catch {}
  }
});

test('the same batch twice at once synthesizes each line once, over one connection', async () => {
  const [a, b] = await Promise.all([precache(items), precache(items)]);
  expect(counts).toEqual({ opens: 1, syntheses: 3 });
  expect(a.synthesized + b.synthesized).toBe(3);
  expect(b).toEqual({ total: 3, cached: 3, synthesized: 0, failed: 0 });
});

test('repeating a finished batch does nothing', async () => {
  const again = await precache(items);
  expect(again).toEqual({ total: 3, cached: 3, synthesized: 0, failed: 0 });
  expect(counts).toEqual({ opens: 1, syntheses: 3 });
});
