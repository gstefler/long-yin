import { expect, test } from 'bun:test';
import { RateLimiter } from '../src/services/rate-limiter';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('admits up to the limit, then waits for the window to slide', async () => {
  const limiter = new RateLimiter(2, 100, 0);
  const done: number[] = [];
  for (const i of [1, 2, 3]) limiter.acquire('playback').then(() => done.push(i));
  await tick();
  expect(done).toEqual([1, 2]);
  await new Promise((r) => setTimeout(r, 130));
  expect(done).toEqual([1, 2, 3]);
});

test('precache leaves the reserve to playback, and playback jumps the queue', async () => {
  const limiter = new RateLimiter(4, 100, 2);
  const done: string[] = [];
  for (const id of ['p1', 'p2', 'p3']) limiter.acquire('precache').then(() => done.push(id));
  await tick();
  expect(done).toEqual(['p1', 'p2']); // 4 - reserve 2
  limiter.acquire('playback').then(() => done.push('play1'));
  limiter.acquire('playback').then(() => done.push('play2'));
  await tick();
  expect(done).toEqual(['p1', 'p2', 'play1', 'play2']);
  limiter.acquire('playback').then(() => done.push('play3'));
  await new Promise((r) => setTimeout(r, 130));
  expect(done.slice(4)).toEqual(['play3', 'p3']);
});
