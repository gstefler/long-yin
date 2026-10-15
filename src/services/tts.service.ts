import { Communicate } from 'edge-tts-universal';
import { azureSpeech } from './azure-speech';
import { retryDelayMs, sleep } from './backoff';

/**
 * Attempts per synthesis. Microsoft refuses a third of handshakes with a 403 at a
 * trickle and over half in a burst (measured October 2026), so 4 still lost ~1 in 12
 * under load. Refusals come back in ~200 ms; the backoff below is what costs time.
 */
const MAX_ATTEMPTS = 6;
/** WebSocket handshake timeout, so a stalled TCP connect fails instead of waiting forever. */
const CONNECT_TIMEOUT_MS = 5_000;
/** Whole-attempt cap: a socket that opens but never finishes still gets retried. */
const ATTEMPT_TIMEOUT_MS = 15_000;


export class TtsService {
  /**
   * Synthesizes text into an MP3 ArrayBuffer — through Azure AI Speech when it is
   * configured, otherwise through Edge TTS, retrying failed
   * attempts. The read-aloud endpoint intermittently refuses the websocket handshake
   * (HTTP 403, a third to over half of connections in October 2026) while the next attempt usually
   * succeeds. The library's own 403 retry never fires for websocket handshakes, and
   * unpatched it hung on a refusal instead of throwing — see patches/.
   */
  public async synthesize(
    text: string,
    voice: string,
    rate: string,
    pitch: string,
    volume: string
  ): Promise<ArrayBuffer> {
    if (azureSpeech) return azureSpeech.synthesize({ text, voice, rate, pitch, volume }, 'playback');
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attempt(text, voice, rate, pitch, volume);
      } catch (error) {
        lastError = error;
        console.warn(
          `[TtsService] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${voice}: ${(error as Error)?.message ?? error}`
        );
        // Worst case ≈8 s of backoff in total, inside the app's 20 s proxy timeout.
        if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs(attempt));
      }
    }
    throw lastError;
  }

  private async attempt(
    text: string,
    voice: string,
    rate: string,
    pitch: string,
    volume: string
  ): Promise<ArrayBuffer> {
    const communicate = new Communicate(text, {
      voice,
      rate,
      pitch,
      volume,
      connectionTimeout: CONNECT_TIMEOUT_MS,
    });
    const collect = async () => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of communicate.stream()) {
        if (chunk.type === 'audio' && chunk.data) chunks.push(chunk.data);
      }
      const audio = Buffer.concat(chunks);
      return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        collect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`synthesis timed out after ${ATTEMPT_TIMEOUT_MS} ms`)),
            ATTEMPT_TIMEOUT_MS
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const ttsService = new TtsService();
