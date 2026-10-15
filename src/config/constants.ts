import { join } from 'node:path';

export const PORT = process.env.PORT || 3000;
export const NODE_ENV = process.env.NODE_ENV || 'development';

export const CACHE_DIR = join(process.cwd(), 'audio-cache');

export const MAX_CACHE_SIZE_MB = Number(process.env.MAX_CACHE_SIZE_MB) || 500;
export const TARGET_CACHE_SIZE_MB = Number(process.env.TARGET_CACHE_SIZE_MB) || 350;

export const DEFAULT_TTS_CONFIG = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
} as const;

/**
 * Azure AI Speech (the official, keyed API). With both set, every synthesis goes there
 * instead of the free Edge read-aloud endpoint — same voices, so cache keys don't change.
 */
export const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY || '';
export const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION || '';
/** Syntheses allowed per 60 s. The free F0 tier's fixed limit is 20; S0 allows 30 per second. */
export const AZURE_SPEECH_RPM = Number(process.env.AZURE_SPEECH_RPM) || 20;
