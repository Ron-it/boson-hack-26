# Tandem

Talk to your phone and it does the task with you. Tandem is an Android voice
assistant for people who know what they want but get lost in apps. You say the
goal in your own words ("text Avery I'm running late", "make the screen
brighter", "what does this button do?"), and Tandem operates the phone while it
talks you through it. Ask "show me how" and it guides you instead of acting.
Interrupt at any time to correct it, pause it, or take over.

<p>
  <img src="docs/brand/home.png" alt="Tandem home screen" width="240">
  <img src="docs/brand/settings.png" alt="Tandem pairing and settings" width="240">
</p>

## How Higgs Audio is used

| Model | Role |
| --- | --- |
| `higgs-realtime-1.5-preview` | The whole conversation: hears the user, speaks back, and decides when to act through tool calls (`update_phone_task`, `look_at_screen`, `confirm_phone_action`, `set_help_mode`, `pause_phone_task`, `stop_phone_task`, `quick_phone_action`). |
| `higgs-stt-3.1` | Input transcription, used to check that confirmations ("yes, send it") came from the user's own words. |
| Higgs voice cloning | Family mode speaks in a cloned voice. For the demo we recorded Ronit speaking Hindi, created a custom voice through Boson's voice API, and set it as the Family preset's voice, so a parent or grandparent hears help in their own family member's voice. |
| Higgs voices | Three presets: **Quick** (fast turn-taking), **Family** (warm, slower, always Hindi, in the cloned voice), **Hands-free** (never asks the user to touch the screen). |

Speech onset cancels in-flight phone work, flushes playback, and the corrected
goal replaces the old one. Sending, paying, deleting and other irreversible taps
are always asked aloud first.

## Architecture

```text
Tandem app (Expo + Kotlin foreground service: mic, speaker, rim overlay)
        ↕ authenticated WSS, PCM16 24 kHz
Node controller on Railway ↔ Higgs Realtime 1.5 preview
        ↕ each UI step chosen by GPT-6.1 Sol from the live accessibility tree
Mobilerun Portal (outbound WSS) → Android accessibility taps, typing, scrolling
```

- Instant actions (home, back, open app, open link) go straight to Portal with no model call.
- Timers, alarms, exact volume and brightness use the app's native module.
- Everything else reads the screen and acts step by step, verifying the result
  (a Google Messages send checks for the sent bubble).

Code map: `mobile/` is the app, `mobile/modules/boson-audio/` the native audio and
overlay module, `src/server/` the controller (`voice.ts` is the Higgs session),
`src/mobile/` the Portal client and phone operator.

## Running it

You need an Android phone (tested on a Pixel 10, Android 17), a Boson API key,
and an OpenAI API key. Node 24 or newer.

**Controller**

```sh
cp .env.example .env   # fill BOSON_API_KEY, OPENAI_API_KEY, DEVICE_TOKEN (random, 24+ chars)
npm install
npm start              # listens on PORT, default 3000
```

Deploy it anywhere with a public HTTPS URL (the `Dockerfile` is what runs on
Railway). `GET /health` reports whether the phone is connected. Optional:
`FAMILY_VOICE=voice_<id>` sets a cloned Higgs voice for the Family preset.
`bash scripts/family-voice.sh` walks through recording Hindi, cloning it with
Boson, and saving the voice ID.

**Phone**

1. Install the [Mobilerun Portal APK](https://github.com/droidrun/mobilerun-portal/releases),
   enable its accessibility service, and point its Custom Connection at
   `wss://<your-server>/device` with your `DEVICE_TOKEN`.
2. Build and install Tandem (needs JDK 17 and the Android SDK; Expo Go does not work):

   ```sh
   npm --prefix mobile ci
   cd mobile
   npx expo prebuild --platform android --no-install
   ./android/gradlew -p android assembleRelease -PreactNativeArchitectures=arm64-v8a
   adb install android/app/build/outputs/apk/release/app-release.apk
   ```

3. Open Tandem, tap **Pair this phone**, and enter the server URL and `DEVICE_TOKEN`.
   Optionally allow brightness control and drawing over other apps.
4. Pick a preset, tap **Start talking**, and speak.

**Without a phone**: `npm run voice:check` runs a synthetic Higgs session with a
tool round trip and spoken completion. `npm test` and `npm run typecheck` run
the controller checks.

## Example requests

- "Set brightness to 70% and turn on Night Light." Then mid-task: "Actually, leave Night Light off."
- "Text Avery that I'm running late." Tandem reads the draft back and asks before sending.
- "Set a timer for ten minutes."
- "What is this screen asking me?" (reads the current app without changing it)
- "Show me how to turn on Wi-Fi." (guide mode: it explains, you tap)

## Known limitations

- One phone and one voice session per controller. No accounts or durable task storage.
- A controller redeploy drops the active voice session; restart it from the phone.
- Speaker echo cancellation depends on the device. A headset is more reliable.
- Some apps expose few accessibility labels; Tandem then falls back to a
  screenshot and may be slower or refuse coordinate taps.
- Automatic pause when the user touches the screen is not built. Say "pause" first.
- The release APK is signed with Expo's development certificate. It is a hackathon build.

## Project record

[Product](PRODUCT.md) · [Design](DESIGN.md) · [Glossary](GLOSSARY.md) ·
[Runtime](docs/runtime.md) · [Decisions](docs/decisions.md) · [ADRs](docs/adr/) ·
[Model comparison](docs/model-comparison.md) · [Research](docs/research.md)

## Team

Ronit Buti ([@Ron-it](https://github.com/Ron-it)): everything.
