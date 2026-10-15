import { Context } from 'hono';
import { cacheService } from '../services/cache.service';
import { ttsService } from '../services/tts.service';
import { NODE_ENV } from '../config/constants';
import { parseTtsParams, TtsValidationError } from '../services/ssml';

export class TtsController {
  public async handleTts(c: Context) {
    let params;
    try {
      // Same validation and defaults as the precache route, so their cache keys agree —
      // and the values are safe to put into SSML.
      params = parseTtsParams(c.req.query());
    } catch (error) {
      if (error instanceof TtsValidationError) return c.json({ error: error.message }, 400);
      throw error;
    }
    const { text, voice, rate, pitch, volume } = params;

    try {
      const filename = await cacheService.getCacheFilename(text, voice, rate, pitch, volume);
      let isCached = cacheService.has(filename);
      // Being synthesized right now (usually by a precache): wait for it, not the provider.
      const inProgress = isCached ? undefined : cacheService.pendingFor(filename);
      if (inProgress) {
        await inProgress.catch(() => {});
        isCached = cacheService.has(filename);
      }
      const filePath = cacheService.getFilePath(filename);

      // Cache HIT
      if (isCached) {
        const file = Bun.file(filePath);
        this.logDevRequest({
          text,
          voice,
          rate,
          pitch,
          volume,
          filename,
          cacheStatus: 'HIT',
          latencyMs: 0,
        });
        return c.body(file.stream(), 200, {
          'Content-Type': 'audio/mpeg',
          'X-Cache-Status': 'HIT',
          'X-Cache-Filename': encodeURIComponent(filename),
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
      }

      // Cache MISS
      const start = performance.now();
      const arrayBuffer = await cacheService.track(
        filename,
        (async () => {
          const audio = await ttsService.synthesize(text, voice, rate, pitch, volume);
          await cacheService.save(filename, audio);
          return audio;
        })()
      );
      
      const latency = Math.round(performance.now() - start);

      this.logDevRequest({
        text,
        voice,
        rate,
        pitch,
        volume,
        filename,
        cacheStatus: 'MISS',
        latencyMs: latency,
      });

      return c.body(arrayBuffer, 200, {
        'Content-Type': 'audio/mpeg',
        'X-Cache-Status': 'MISS',
        'X-Cache-Filename': encodeURIComponent(filename),
        'X-Response-Time-Ms': `${latency}`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    } catch (error: any) {
      console.error('Synthesis controller error:', error);
      return c.json({ error: error.message || 'Failed to synthesize audio' }, 500);
    }
  }

  private logDevRequest(params: {
    text: string;
    voice: string;
    rate: string;
    pitch: string;
    volume: string;
    filename: string;
    cacheStatus: 'HIT' | 'MISS';
    latencyMs: number;
  }): void {
    if (NODE_ENV === 'production') return;

    console.log(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          type: 'TTS_REQUEST_TELEMETRY',
          parameters: {
            text: params.text,
            voice: params.voice,
            rate: params.rate,
            pitch: params.pitch,
            volume: params.volume,
          },
          cache: {
            status: params.cacheStatus,
            filename: params.filename,
          },
          metrics: {
            latencyMs: params.latencyMs,
          },
        },
        null,
        2
      )
    );
  }
}

export const ttsController = new TtsController();
