import { EdgeTTS } from 'edge-tts-universal';

export class TtsService {
  /**
   * Invokes EdgeTTS to synthesize text into an audio ArrayBuffer.
   */
  public async synthesize(
    text: string,
    voice: string,
    rate: string,
    pitch: string,
    volume: string
  ): Promise<ArrayBuffer> {
    const tts = new EdgeTTS(text, voice, { rate, pitch, volume });
    const result = await tts.synthesize();
    return await result.audio.arrayBuffer();
  }
}

export const ttsService = new TtsService();
