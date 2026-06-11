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
