import { NativeModule, requireNativeModule } from 'expo';

declare class BosonAudioModule extends NativeModule<{ onEvent: (event: { json: string }) => void }> {
  configure(url: string, token: string): void;
  /** `familyVoiceLanguage` is empty until a family voice is saved. */
  configuration(): { url: string; configured: boolean; preset: string; familyLanguage: string; familyVoiceLanguage: string };
  snapshot(): string;
  canSetBrightness(): boolean;
  requestBrightnessPermission(): void;
  canShowOverlay(): boolean;
  requestOverlayPermission(): void;
  /** Starts listening with a preset the server recognizes; it falls back to quick otherwise. */
  start(preset: string): void;
  stop(): void;
  setFamilyLanguage(language: string): void;
  /** Records the helper reading the sample paragraph. Ask for the microphone first. */
  startSample(): void;
  cancelSample(): void;
  /** Stops recording and clones the voice through the paired server, then Family uses it. */
  saveSample(language: string, text: string): Promise<{ voice: string } | { error: string }>;
}

export default requireNativeModule<BosonAudioModule>('BosonAudio');
