import { Context } from 'hono';
import { VOICES } from '../config/voices';
import { VoiceProfileWithDemo } from '../types';

export class VoiceController {
  public getVoices(c: Context) {
    const list: VoiceProfileWithDemo[] = VOICES.map((voice) => ({
      ...voice,
      demoUrl: `/api/tts?text=${encodeURIComponent(voice.demoText)}&voice=${voice.id}`,
    }));
    return c.json(list);
  }
}

export const voiceController = new VoiceController();
