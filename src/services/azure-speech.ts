import { AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_SPEECH_RPM } from '../config/constants';
import { TtsRequestParams } from '../types';
import { retryDelayMs, sleep } from './backoff';
import { Priority, RateLimiter } from './rate-limiter';
import { buildSsml } from './ssml';

/** The Edge endpoint's format too, so a file cached from either sounds the same. */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const MAX_ATTEMPTS = 4;
const ATTEMPT_TIMEOUT_MS = 15_000;
/** A Retry-After longer than this isn't worth waiting out inside a request. */
const MAX_RETRY_AFTER_MS = 10_000;

export class AzureSpeechError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
  }
}

const retryable = (status: number) => status === 429 || status >= 500;

/**
 * Azure AI Speech's REST synthesis API: one POST per line, keyed, so there are no
 * refused handshakes to fight. Throttling (429) and server errors are retried, honouring
 * Retry-After; anything else (a bad key, a voice the region lacks) fails at once.
 */
export class AzureSpeech {
  constructor(
    private readonly key: string,
    private readonly region: string,
    readonly limiter: RateLimiter,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  get endpoint(): string {
    return `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  }

  async synthesize(params: TtsRequestParams, priority: Priority): Promise<ArrayBuffer> {
    const body = buildSsml(params, { omitNeutralProsody: true });
    let lastError: Error = new AzureSpeechError('synthesis failed');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.limiter.acquire(priority);
      let wait = retryDelayMs(attempt);
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': this.key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
            'User-Agent': 'long-yin',
          },
          body,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        if (res.ok) {
          const audio = await res.arrayBuffer();
          if (audio.byteLength === 0) throw new AzureSpeechError('no audio received');
          return audio;
        }
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        lastError = new AzureSpeechError(`Azure Speech ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
        if (!retryable(res.status)) throw lastError;
        const retryAfter = Number(res.headers.get('retry-after'));
        if (retryAfter > 0) wait = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
      } catch (error) {
        if (error instanceof AzureSpeechError && error.status && !retryable(error.status)) throw error;
        lastError = error as Error;
      }
      console.warn(`[AzureSpeech] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${params.voice}: ${lastError.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(wait);
    }
    throw lastError;
  }
}

export const azureSpeech =
  AZURE_SPEECH_KEY && AZURE_SPEECH_REGION
    ? new AzureSpeech(
        AZURE_SPEECH_KEY,
        AZURE_SPEECH_REGION,
        new RateLimiter(AZURE_SPEECH_RPM, 60_000, Math.max(1, Math.floor(AZURE_SPEECH_RPM / 4)))
      )
    : null;
