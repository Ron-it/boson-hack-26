# Expo setup and audio audit

Checked October 23, 2026 against SDK 58 documentation and the official Expo skills installed from [expo/skills](https://github.com/expo/skills). This audit covers setup and API choice; the speaker-buffer diagnosis and its regression evidence are separate.

## SDK and project setup

- The app uses Expo **58.0.19**, the stable `latest` release checked through npm in this session. `expo-doctor` passed **20/20** checks, and `expo install --check` reported current compatible dependencies. There is no established SDK upgrade or dependency mismatch to fix. [Expo package metadata](https://registry.npmjs.org/expo/latest)
- `mobile/modules/boson-audio/` is a supported local Expo module. Its configuration registers the fully qualified Kotlin class, and its maintained source is outside generated `mobile/android/`. This matches Expo's local-module and autolinking flow. [Local modules](https://docs.expo.dev/modules/get-started/), [module configuration](https://docs.expo.dev/modules/module-config/)
- Generated native projects remain ignored. Keep Android build changes in app configuration/config plugins and module-owned source, then regenerate with Prebuild. The generated theme resource was checked as `automatic`. [Continuous Native Generation](https://docs.expo.dev/workflow/continuous-native-generation/)
- Custom Kotlin requires a native build. Expo Go cannot contain this app's local module. A standalone build with bundled JavaScript is appropriate for the unplugged demo; Expo also documents local release builds. A development client is optional for a faster development loop, not a prerequisite for running the bundled APK. [Development builds](https://docs.expo.dev/develop/development-builds/introduction/), [local release builds](https://docs.expo.dev/guides/local-app-production/)

## Can expo-audio replace the custom service?

SDK 58's `expo-audio` provides `useAudioStream` for raw microphone PCM, including little-endian `int16`. The actual sample rate can differ from the requested rate. Its background-recording plugin adds the Android microphone foreground service and required permissions. These are real alternatives for capture. [SDK 58 audio reference](https://docs.expo.dev/versions/v58.0.0/sdk/audio/)

The reviewed playback API loads audio sources or playlist tracks. I found no documented raw-PCM append/enqueue sink with an immediate queue flush. Therefore a complete replacement for the current duplex, interruptible transport is **not established** by the official API. Keep the Kotlin audio service for this slice; do not add `expo-audio` merely to satisfy a preference for Expo packages. Revisit if an appropriate playback API becomes available. This is an inference from the documented API surface, not a claim that such a wrapper could never be built. [SDK 58 audio reference](https://docs.expo.dev/versions/v58.0.0/sdk/audio/)

## Applicable Android correction

The audited generated manifest declared API **24**, while `VoiceService` calls `getAvailableCommunicationDevices`, `setCommunicationDevice`, and `clearCommunicationDevice`, which require API **31**. For the current Pixel-focused build, declare Android 12/API 31 as the minimum rather than silently claiming older-device support. Supporting older Android would instead require guarded routing alternatives. [Android AudioManager](https://developer.android.com/reference/android/media/AudioManager#getAvailableCommunicationDevices())

The correction is applied through `expo-build-properties`, installed with `npx expo install`, with `android.minSdkVersion: 31` in app configuration. The standalone release build passed, and `aapt dump badging` verified `sdkVersion:'31'` in the actual APK. [SDK 58 BuildProperties](https://docs.expo.dev/versions/v58.0.0/sdk/build-properties/)

## Lifecycle and remaining acceptance

The module is a bridge; the Android service owns audio, worker threads, WebSocket lifetime, and the ongoing Stop notification. This avoids depending on React component lifetime for capture. Module destruction detaches its UI listener, while explicit Stop ends the service. That separation is consistent with Expo's distinct module/activity hooks. [Module API](https://docs.expo.dev/modules/module-api/)

The service declares the microphone type and permissions. Start it while the app is visible, after microphone permission, before opening Settings. Android permits this type to continue capture in the background, but restricts starting it from the background. [Microphone foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)

Actual speaker routing, echo cancellation, Settings-in-front audio, microphone shutdown, interruption, and unplugged completion still need device evidence. Doctor success and compilation do not establish those behaviors. No navigation or UI-library migration is required to investigate the reported audio failure.
