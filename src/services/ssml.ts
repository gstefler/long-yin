import { DEFAULT_TTS_CONFIG } from '../config/constants';
import { TtsRequestParams } from '../types';

export const MAX_TEXT_LENGTH = 500;

// These go into SSML attributes verbatim, so only well-formed values get through.
const VOICE = /^[a-z]{2,3}-[A-Z]{2}(-[a-z]+)?-[A-Za-z]+Neural$/;
const PERCENT = /^[+-]\d{1,3}%$/;
const HERTZ = /^[+-]\d{1,3}Hz$/;

export class TtsValidationError extends Error {}

/**
 * Validates one synthesis request, filling the defaults for anything absent or empty.
 * Shared by GET /api/tts and the precache route, so both accept exactly the same input
 * and produce the same cache keys.
 */
export function parseTtsParams(raw: Record<string, unknown>): TtsRequestParams {
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new TtsValidationError(`text must be 1-${MAX_TEXT_LENGTH} characters`);
  }
  const field = (name: keyof typeof DEFAULT_TTS_CONFIG, pattern: RegExp) => {
    const value = raw[name] === undefined || raw[name] === '' ? DEFAULT_TTS_CONFIG[name] : raw[name];
    if (typeof value !== 'string' || !pattern.test(value)) {
      throw new TtsValidationError(`invalid ${name}`);
    }
    return value;
  };
  return {
    text,
    voice: field('voice', VOICE),
    rate: field('rate', PERCENT),
    pitch: field('pitch', HERTZ),
    volume: field('volume', PERCENT),
  };
}

export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const isNeutral = (value: string) => /^[+-]0+(%|Hz)$/.test(value);

/**
 * The SSML document for one request. Callers validate voice/rate/pitch/volume (see
 * parseTtsParams); text is escaped here. `omitNeutralProsody` drops a `<prosody>` that
 * changes nothing: Azure bills its markup as characters.
 */
export function buildSsml(r: TtsRequestParams, options: { omitNeutralProsody?: boolean } = {}): string {
  const lang = /^[a-z]{2,3}-[A-Z]{2}/.exec(r.voice)?.[0] ?? 'en-US';
  const neutral = isNeutral(r.rate) && isNeutral(r.pitch) && isNeutral(r.volume);
  const body =
    options.omitNeutralProsody && neutral
      ? escapeXml(r.text)
      : `<prosody pitch='${r.pitch}' rate='${r.rate}' volume='${r.volume}'>${escapeXml(r.text)}</prosody>`;
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${r.voice}'>${body}</voice></speak>`
  );
}
