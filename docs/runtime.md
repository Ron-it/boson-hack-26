# Phone voice runtime

The first slice is Android Settings only. The final audience and product story
remain open.

```text
Expo screen → Kotlin microphone/speaker foreground service
                         ↕ authenticated WSS
                  Node server on Railway ↔ Higgs Realtime 1.5 preview
                         ↕ UI decisions from GPT-6.1 Sol
                  Portal outbound WSS → Android accessibility actions
```

The Kotlin service owns both audio loops and the network connection. Audio does
not depend on the React Native screen staying visible. Capture and playback are
PCM16 mono at 24 kHz. The service requests communication audio routing and acoustic
echo cancellation where supported; actual speaker performance must be checked on
the Pixel. A persistent notification provides a Stop action. Connection loss
ends the session instead of replaying cached microphone audio.

Voice uses the exact `higgs-realtime-1.5-preview` identifier for both the WebSocket
URL and session configuration. `npm run voice:check` verified that model's session
acknowledgement, 24 kHz audio, tool result, and completion response. Completion
uses per-response instructions, retaining the base constraints; Boson rejects
system-role conversation messages. The official tutorial still defaults to the
older model name, so this preview check is independent evidence.

Speaker backlog is limited to 60 seconds of PCM bytes, not a fixed packet count.
The receiver never waits for playback, preserving speech-start handling. Writes
to AudioTrack remain at most 40 ms; interruption clears queued bytes and changes
the active playback generation. The old queue failed on legitimate audio bursts.

The server authenticates both phone connections with `DEVICE_TOKEN`. Boson and
OpenAI API keys are server-side variables. One device and one voice session are
supported. This prototype has no accounts, durable job storage, or reconnecting
task replay. A deployment disconnects an active voice session; restart it from
the phone afterward. Device control rejects pending requests when disconnected.

Speech onset immediately invalidates the task revision and aborts pending model
requests. The native service pauses and flushes speaker playback, and rejects
later chunks from the interrupted response. A gesture already dispatched may
complete. New task loops wait for the prior loop to settle, obtain fresh screen
state, and check both goal ownership and screen identity before each action.

Boson calls `update_phone_task` with the complete revised goal. The phone opens
Display settings through a native intent, then the worker selects actions from
actual accessibility controls. Screens outside Settings are rejected before
model inference. Direct brightness control uses Android's normal system-settings
permission and reads back the raw value. Its conversion approximates Android's
gamma slider; adaptive brightness may subsequently change the value. Night Light
continues through UI navigation. A model's completion judgment remains distinct
from a separate Android-state verification.

Contextual help reads the visible app without opening Settings. `look_at_screen`
returns labeled controls with role, short resource ID, state, parent, absolute
bounds and rough position. Display size comes from a Portal screenshot's PNG
header, cached per connection and recaptured when a window falls outside it, so
a dialog's window is not mistaken for the display. Without a capture, only a
window at the display origin supplies geometry; otherwise coordinate actions are
withheld. When fewer than three controls are labeled, a current screenshot goes
to the hosted navigation model as image input; Boson receives only its text.
If capture or that model is unavailable, the tool reports unavailable. Guide
mode refuses task, brightness and continue tools until Boson sets do mode on
the user's request. Screen text is labeled untrusted in every tool result.

The server logs connection, audio-flow, tool-name, task-state, and revision events.
It does not log audio, spoken transcripts, goals, screen contents, or API keys.
The original CLI experiments still save private traces in ignored `artifacts/`.

## Current checks

- Standalone arm64 release APK builds; JavaScript is bundled.
- Root tests, server typecheck, mobile typecheck, and Expo lint pass.
- A focused race test proves a late provider response cannot tap after pause,
  even if the provider ignores cancellation.
- A synthetic Boson connection accepted the exact 24 kHz session configuration.
- The 1.5 preview live protocol probe passed a tool round trip and announcement.
- Four native queue regression tests pass; the original eight-second burst test failed before the fix.
- Expo Doctor passes 20/20 and dependencies match SDK 58.0.19; the merged APK minimum is API31.
- The physical Pixel established Portal's outbound WSS connection to Railway.
- Microphone/speaker audio with Settings in front, actual spoken correction,
  echo cancellation, and an unplugged end-to-end task remain acceptance checks.

## Protocol sources

- [Boson connections and sessions](https://docs.boson.ai/models/higgs-realtime/guides/connections-and-sessions)
- [Boson tool calling](https://docs.boson.ai/models/higgs-realtime/guides/tool-calling)
- [Boson interruptions](https://docs.boson.ai/models/higgs-realtime/guides/turn-detection-and-interruptions)
- [Portal reverse protocol](https://github.com/droidrun/mobilerun-portal/blob/main/docs/reverse-connection.md)
- [Portal dispatch implementation](https://github.com/droidrun/mobilerun-portal/blob/main/app/src/main/java/com/mobilerun/portal/service/ActionDispatcher.kt)
- [Android microphone foreground services](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)
- [Expo local modules](https://docs.expo.dev/modules/get-started/)
