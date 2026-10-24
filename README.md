# Boson phone-use spike

Android voice-agent prototype using Expo, a Kotlin foreground audio service,
Boson Higgs Realtime **1.5 preview**, and a hosted phone-control worker. Real Settings control
and the outbound phone connection are verified. Spoken correction handling and
speaker echo cancellation still need the live phone acceptance test.

## Project record

- [Research and sources](docs/research.md)
- [Decisions and open questions](docs/decisions.md)
- [Runtime and verification](docs/runtime.md)
- [Expo audit](docs/expo-audit.md)
- [Model experiments](docs/model-comparison.md)
- [Native audio architecture](docs/adr/0001-native-foreground-audio.md)
- [Glossary](GLOSSARY.md), [product scope](PRODUCT.md), and [design system](DESIGN.md)

Voice is explicitly pinned to `higgs-realtime-1.5-preview`. Run `npm run voice:check`
for a synthetic live session, tool round trip, and completion-announcement check.
It does not record a microphone or change phone settings.

The reported first-reply buffer failure was reproduced and repaired: a real
Boson stream delivered 18.84 seconds of audio in 2.25 seconds, exceeding the old
queue's maximum 6.4 seconds. Four native tests now pass with a bounded byte-based
queue and short interruptible writes. Physical voice acceptance remains pending.

## Phone app

The standalone app is `mobile/`, with native audio in
`mobile/modules/boson-audio/`. It requires an Android build, rather than Expo Go.
The installed APK bundles JavaScript and does not use Metro at runtime.

The controller runs on [Railway](https://railway.com/project/2662e67d-6a21-4b7f-97d8-8777e9eb5193).
Its [health endpoint](https://phone-controller-production-288e.up.railway.app/health)
reports whether Portal is connected. API keys stay in the controller; the app
and Portal use a scoped device pairing token.

1. Pair Portal's Custom Connection with the server's `/device` WebSocket endpoint.
2. In Tandem, tap **Pair this phone** (or the settings icon) and save the HTTPS
   server address and device pairing code.
3. Optionally turn on instant brightness control and showing over other apps in
   the same Settings screen.
4. Pick Quick, Family, or Hands-free, tap **Start talking**, allow microphone
   access, and speak. **Stop** or the notification's **Stop** ends the native
   service and microphone.

The first demo is “Set brightness to 70% and turn on Night Light,” followed
mid-task by “Actually, leave Night Light off.” Physical speech, background audio,
and unplugged completion are acceptance checks, not established by the build.

Build locally with JDK 17 and the Android SDK:

```sh
npm --prefix mobile ci
cd mobile
npx expo prebuild --platform android --no-install
JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home \
ANDROID_HOME=/Users/ronit/Library/Android/sdk \
./android/gradlew -p android assembleRelease -PreactNativeArchitectures=arm64-v8a
```

The local release variant currently uses Expo's development signing certificate;
it is a private hackathon build, not a store release. Native build folders and
device artifacts are ignored. See [runtime details](docs/runtime.md).

## Development setup

1. Install the official [Mobilerun Portal APK](https://github.com/droidrun/mobilerun-portal/releases).
2. Open Portal, enable its accessibility service, and turn on **HTTP Server**.
3. Copy `.env.example` to `.env` and put Portal's local auth token in
   `PORTAL_TOKEN`. Keep the token private.
4. During USB development, run `adb forward tcp:8080 tcp:8080`.
5. Run `npm install`, then `npm run phone -- status`.

The probe provides `open-settings`, `state`, `screenshot`, `tap`, `swipe`, and
`back` commands. `npm run phone -- help` shows arguments. Screenshots go to the
gitignored `artifacts/` directory. Actions returning successfully do not prove
the requested setting changed: inspect the resulting state and screen.

This initial USB transport is for development. Portal's
[reverse connection](https://github.com/droidrun/mobilerun-portal/blob/main/docs/reverse-connection.md)
or hosted device API supplies the later no-laptop transport. The client uses
Portal's [documented local API](https://github.com/droidrun/mobilerun-portal/blob/main/docs/local-api.md).

## Verification

Verified October 23, 2026 on a physical Pixel 10, Android API 37, Portal 0.7.27:

| Check | Result |
| --- | --- |
| Open Settings, read controls, tap, swipe, back, screenshot | PASS through Portal HTTP |
| Initial brightness probe | 40% to 70%, verified on the Settings page, then restored to 40% |
| Night Light | Off to on to off, independently verified through Android state and rendered switches |
| Temporary keep-awake setting | Restored to its original value |
| TypeScript | `npm run typecheck` passes |
| Autonomous navigation | GPT-6.1 Sol found and enabled Night Light in 12.31 seconds; separate Android state read confirmed it |
| Local corrected instruction | Jev turned the visible Night Light switch off in 1.19 seconds; separate Android state read confirmed it |

Observed individual request times were about 40-75 ms for taps/app launch,
100-275 ms for screen reads, and 0.5-0.9 seconds for screenshots. These are a few
USB bridge measurements, excluding model reasoning, speech, and complete task
duration. Android 17 places Night Light inside **Comfort Filters** on this phone.

Local screenshots, structured records and model traces are in the gitignored
`artifacts/` directory. Initial bridge checks used actions chosen by the coding
agent; the later model runs executed without human selection of each action.
These checks do not establish hands-free correction handling or a no-laptop runtime.

## How a request runs

Boson hears the user and passes their goal, in their words, to one operator.

| Work | Done by | Model call |
| --- | --- | --- |
| Home, back, recent apps, notifications, quick settings, open an app, open a link | Portal | none |
| Timers, alarms, exact media volume and brightness | the app's native module (Portal cannot pass intent extras or exact values) | one step, or none when the voice asks for an instant action |
| Reading the screen, tapping, typing, scrolling, Enter | Portal | GPT-6.1 Sol picks each step |

Send, pay, delete and other irreversible taps are asked aloud first. A Google
Messages send also verifies the sent bubble. `npm run phone` probes Portal
directly over USB.
