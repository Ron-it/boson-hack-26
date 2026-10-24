import { NativeModule, requireNativeModule } from 'expo';

declare class BosonAudioModule extends NativeModule<{ onEvent: (event: { json: string }) => void }> {
  configure(url: string, token: string): void;
  configuration(): { url: string; configured: boolean };
  snapshot(): string;
  canSetBrightness(): boolean;
  requestBrightnessPermission(): void;
  canShowOverlay(): boolean;
  requestOverlayPermission(): void;
  start(): void;
  stop(): void;
}

export default requireNativeModule<BosonAudioModule>('BosonAudio');
