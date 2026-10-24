import { NativeModule, requireNativeModule } from 'expo';

declare class BosonAudioModule extends NativeModule<{ onEvent: (event: { json: string }) => void }> {
  configure(url: string, token: string): void;
  configuration(): { url: string; configured: boolean; preset: string };
  snapshot(): string;
  canSetBrightness(): boolean;
  requestBrightnessPermission(): void;
  canShowOverlay(): boolean;
  requestOverlayPermission(): void;
  /** Starts listening with a preset the server recognizes; it falls back to quick otherwise. */
  start(preset: string): void;
  stop(): void;
}

export default requireNativeModule<BosonAudioModule>('BosonAudio');
