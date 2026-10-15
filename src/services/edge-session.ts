import { createHash, randomBytes } from 'node:crypto';
import { retryDelayMs, sleep } from './backoff';
import { escapeXml } from './ssml';

// One Edge read-aloud websocket reused for many syntheses — what makes the precache
// route cheap. Microsoft refuses a share of websocket *handshakes* (HTTP 403), but once
// a socket is open every request on it has succeeded, and it takes any number of
// requests in sequence, voices mixed (measured October 2026, ~350 ms per line). So a
// dialogue costs one handshake instead of one per line.
//
// edge-tts-universal opens a socket per synthesis and closes it on turn.end, so this
// speaks the same protocol directly. Keep TRUSTED_CLIENT_TOKEN and CHROMIUM_FULL_VERSION
// in step with that library's constants when it is upgraded.

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const WSS_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;

const HEADERS = {
  'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
  'Accept-Language': 'en-US,en;q=0.9',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
};

const MAX_CONNECT_ATTEMPTS = 6;
/** One line's synthesis; generous, a line normally takes well under a second. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface SynthesisRequest {
  text: string;
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
}

const uuid = () => crypto.randomUUID().replaceAll('-', '');
const timestamp = () => new Date().toUTCString().replace('GMT', 'GMT+0000 (Coordinated Universal Time)');

/** The Sec-MS-GEC token: SHA-256 of Windows-epoch ticks, rounded down to 5 minutes. */
function secMsGec(): string {
  let seconds = Date.now() / 1000 + 11_644_473_600;
  seconds -= seconds % 300;
  return createHash('sha256')
    .update(`${(seconds * 1e7).toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** Callers validate voice/rate/pitch/volume (see parseTtsParams); text is escaped here. */
function ssml(r: SynthesisRequest): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${r.voice}'><prosody pitch='${r.pitch}' rate='${r.rate}' volume='${r.volume}'>` +
    `${escapeXml(r.text)}</prosody></voice></speak>`
  );
}

/** Splits a text frame (or a binary frame's header block) into its header map. */
function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return headers;
}

interface Pending {
  requestId: string;
  chunks: Uint8Array[];
  resolve: (audio: ArrayBuffer) => void;
  reject: (error: Error) => void;
}

export class EdgeSession {
  private ws: WebSocket | null = null;
  private pending: Pending | null = null;

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Opens the socket, retrying refused handshakes with backoff. */
  async open(): Promise<void> {
    let lastError: Error = new Error('could not connect');
    for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
      try {
        await this.connectOnce();
        return;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[EdgeSession] handshake ${attempt}/${MAX_CONNECT_ATTEMPTS} refused: ${lastError.message}`);
        if (attempt < MAX_CONNECT_ATTEMPTS) await sleep(retryDelayMs(attempt));
      }
    }
    throw lastError;
  }

  private connectOnce(): Promise<void> {
    const url = `${WSS_URL}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}&ConnectionId=${uuid()}`;
    // Bun's WebSocket takes request headers; the endpoint checks Origin and User-Agent.
    const ws = new WebSocket(url, {
      headers: { ...HEADERS, Cookie: `muid=${randomBytes(16).toString('hex').toUpperCase()};` },
    } as unknown as string[]);
    ws.binaryType = 'arraybuffer';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('handshake timed out'));
      }, 5_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        ws.send(
          `X-Timestamp:${timestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
            '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
        );
        resolve();
      });
      ws.addEventListener('message', (event) => this.onMessage(event.data));
      ws.addEventListener('close', () => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        this.fail(new Error('socket closed'));
        reject(new Error('handshake refused'));
      });
    });
  }

  private onMessage(data: string | ArrayBuffer) {
    const p = this.pending;
    if (!p) return;
    if (typeof data === 'string') {
      const [head] = data.split('\r\n\r\n', 1);
      const headers = parseHeaders(head ?? '');
      if (headers['X-RequestId'] === p.requestId && headers['Path'] === 'turn.end') {
        this.pending = null;
        const total = p.chunks.reduce((n, c) => n + c.byteLength, 0);
        if (total === 0) return p.reject(new Error('no audio received'));
        const audio = new Uint8Array(total);
        let offset = 0;
        for (const c of p.chunks) {
          audio.set(c, offset);
          offset += c.byteLength;
        }
        p.resolve(audio.buffer);
      }
      return;
    }
    const view = new DataView(data);
    const headerLength = view.getUint16(0);
    const headers = parseHeaders(new TextDecoder().decode(new Uint8Array(data, 2, headerLength)));
    if (headers['X-RequestId'] !== p.requestId || headers['Path'] !== 'audio') return;
    const body = new Uint8Array(data, 2 + headerLength);
    if (body.byteLength > 0) p.chunks.push(body);
  }

  private fail(error: Error) {
    const p = this.pending;
    this.pending = null;
    p?.reject(error);
  }

  /** One synthesis on the open socket. Sequential: await each before the next. */
  synthesize(request: SynthesisRequest): Promise<ArrayBuffer> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('socket not open'));
    if (this.pending) return Promise.reject(new Error('a synthesis is already in progress'));

    const requestId = uuid();
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A stuck request poisons the socket's turn order — drop it and reconnect.
        this.fail(new Error(`synthesis timed out after ${REQUEST_TIMEOUT_MS} ms`));
        this.close();
      }, REQUEST_TIMEOUT_MS);
      this.pending = {
        requestId,
        chunks: [],
        resolve: (audio) => {
          clearTimeout(timer);
          resolve(audio);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      ws.send(
        `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp()}Z\r\nPath:ssml\r\n\r\n${ssml(request)}`
      );
    });
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
