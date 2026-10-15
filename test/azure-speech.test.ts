import { expect, test } from 'bun:test';
import { AzureSpeech, AzureSpeechError } from '../src/services/azure-speech';
import { RateLimiter } from '../src/services/rate-limiter';

const params = { text: '你好', voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%', pitch: '+0Hz', volume: '+0%' };

function fakeFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return responses.shift() ?? new Response('exhausted', { status: 500 });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const client = (impl: typeof fetch) => new AzureSpeech('k3y', 'westeurope', new RateLimiter(100, 60_000, 0), impl);

test('posts SSML with the key and the MP3 format', async () => {
  const { calls, impl } = fakeFetch([new Response(new Uint8Array([1, 2, 3]))]);
  const audio = await client(impl).synthesize(params, 'playback');
  expect(audio.byteLength).toBe(3);
  expect(calls[0]!.url).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  const headers = calls[0]!.init.headers as Record<string, string>;
  expect(headers['Ocp-Apim-Subscription-Key']).toBe('k3y');
  expect(headers['X-Microsoft-OutputFormat']).toBe('audio-24khz-48kbitrate-mono-mp3');
  expect(calls[0]!.init.body).toBe(
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='zh-CN-XiaoxiaoNeural'>你好</voice></speak>"
  );
});

test('retries throttling, honouring Retry-After', async () => {
  const { calls, impl } = fakeFetch([
    new Response('slow down', { status: 429, headers: { 'Retry-After': '1' } }),
    new Response(new Uint8Array([9])),
  ]);
  const start = Date.now();
  await client(impl).synthesize(params, 'playback');
  expect(calls.length).toBe(2);
  expect(Date.now() - start).toBeGreaterThanOrEqual(950);
});

test('fails at once on a bad key', async () => {
  const { calls, impl } = fakeFetch([new Response('denied', { status: 401 })]);
  const error = await client(impl).synthesize(params, 'playback').catch((e) => e);
  expect(error).toBeInstanceOf(AzureSpeechError);
  expect(error.status).toBe(401);
  expect(calls.length).toBe(1);
});
