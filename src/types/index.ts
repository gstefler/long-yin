export interface VoiceProfile {
  id: string;
  name: string;
  displayName: string;
  gender: 'Female' | 'Male';
  region: string;
  demoText: string;
}

export interface VoiceProfileWithDemo extends VoiceProfile {
  demoUrl: string;
}

export interface TtsRequestParams {
  text: string;
  voice: string;
  rate: string;
  pitch: string;
  volume: string;
}

export interface CacheStats {
  directory: string;
  fileCount: number;
  sizeBytes: number;
  sizeKB: number;
}
