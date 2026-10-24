# Phone-agent research

This records the research behind the Android prototype. Start with
[decisions](decisions.md) for what we chose, [runtime](runtime.md) for the
implementation, and [model comparison](model-comparison.md) for the device runs.
The initial device research was conducted on October 23, 2026.

## What we are trying to prove

Ronit's requirement is a voice-operated real Android phone that works in the
final demo without a connected laptop. USB is acceptable for development and
one-time setup. Permission setup is acceptable. Boson supplies the live voice
interaction; the first phone task changes brightness and Night Light.
The later model requirement pins voice to `higgs-realtime-1.5-preview`.
Authenticated model discovery confirmed that exact ID is available. Public
documentation still often names `higgs-realtime`, so its examples do not replace
the explicit preview-model requirement or live compatibility checks.

The production configuration is now pinned to that preview ID. A live synthetic
probe acknowledged it, produced 24 kHz audio, completed a tool round trip, and
accepted the corrected completion announcement. The current tutorial's
[session configuration](https://github.com/boson-ai/Higgs-Realtime-Tutorial/blob/87f1ae81434d8a65126503ceef36871e0b529f5c/src/realtime/sessionConfig.ts)
still uses the base model. Its examples are not evidence of preview-specific
image or avatar schemas; those advertised capabilities remain future work.

The candidate sequence is "Set brightness to 70% and turn on Night Light,"
followed while the task runs by "Actually, leave Night Light off." The assistant
must retain the brightness request and replace the cancelled Night Light request.
Older adults, Uber booking, directions to a meeting, Gmail, Calendar, and teachable
workflows were examples or possible extensions. None is a selected audience or
promised integration. These are project requirements from the conversation,
not a transcription of organizer rules. The original event references are the
[Boson hackathon page](https://www.boson.ai/hackathon) and
[Luma listing](https://luma.com/7368qkv7).

## Existing phone assistants

Gemini already manages device settings and opens apps through
[Device assistance](https://support.google.com/gemini/answer/15235441?hl=en).
Its [screen automation](https://support.google.com/gemini/answer/16940971?hl=en)
also handles multi-step tasks, including rides and orders, on selected devices,
apps, and regions. Availability is restricted and changes over time. We cannot
pitch phone actions or interruption alone as a new capability. A final product
story beyond this technical proof remains open.

## Phone-control tools

Control software supplies observations and actions. It does not by itself supply
the model that chooses a useful next action.

| Tool | What the reviewed source establishes | Decision for this prototype |
| --- | --- | --- |
| [agent-device](https://agent-device.dev/) | A device-automation CLI and typed client with accessibility snapshots, semantic references, actions, and evidence capture across development targets. | Useful development and verification option. We did not establish an installed, laptop-independent consumer runtime with it. |
| [Argent](https://argent.swmansion.com/) | An agent toolkit for app interaction, debugging, component inspection, networking, and profiling. Its described agent connection targets the iOS simulator and Android emulator. | Useful app-development tooling. Not selected as the shipped phone-control connection. |
| [Mobilerun Portal](https://github.com/droidrun/mobilerun-portal) | An Android companion with accessibility control, a local API, and an outbound host connection. | Selected. Real Settings controls were tested through its local API; its outbound connection was paired with our server. |

The [reverse-connection protocol](https://github.com/droidrun/mobilerun-portal/blob/main/docs/reverse-connection.md)
lets the phone initiate a WebSocket connection to an owned host. This avoids
requiring an inbound connection to the phone or a laptop forwarding port during
the demo. Commands carry an ID, method, and parameters; replies carry the same ID
and a success result or error. A timed-out tap has an unknown outcome and must
not be replayed blindly.

The protocol's method names matter. The reviewed
[dispatcher](https://github.com/droidrun/mobilerun-portal/blob/main/app/src/main/java/com/mobilerun/portal/service/ActionDispatcher.kt)
maps reverse `state` to the full accessibility state; it does not expose a
`state_full` reverse method. Our local HTTP probe instead uses `/state_full`.
Full observations retain checked values, slider ranges, and native scroll
actions. Compact labels alone previously hid Night Light's switch state.

## Boson protocol constraints

The [official Higgs tutorial](https://github.com/boson-ai/Higgs-Realtime-Tutorial)
is an implementation reference for microphone audio, transcripts, tool calls,
and headless protocol probes. Its browser examples and earlier verification date
do not establish Android background behavior or preview-model compatibility.

Higgs Realtime is a persistent speech-to-speech conversation with function tools.
The reviewed [compatibility notes](https://docs.boson.ai/models/higgs-realtime/migrate-an-existing-integration)
specify WebSocket transport, with WebRTC still unavailable. Send `session.update`
on connection open; `session.created` acknowledges that first update. Do not wait
for it before configuring the session. Image message contents and native MCP
tools are unsupported, so phone observation and execution need separate code.
Those notes also reject `system`-role conversation messages. A task-completion
announcement must use an accepted protocol mechanism rather than importing that
message pattern from another provider.

[Connection authentication](https://docs.boson.ai/models/higgs-realtime/guides/connections-and-sessions)
supports a server-side API key or a short-lived client secret minted by a server.
The current server relay keeps provider keys off the phone. Ephemeral direct
phone-to-Boson connections remain an alternative, not the implemented path.

[Audio](https://docs.boson.ai/models/higgs-realtime/guides/audio-and-voices)
travels as base64 in JSON. PCM means 16-bit little-endian mono audio, not WAV
files. Supported PCM rates include 8, 16, 24, and 48 kHz; this prototype declares
24 kHz in both directions. Audio generation completing does not establish that
the phone finished playing its queued audio.

For [function tools](https://docs.boson.ai/models/higgs-realtime/guides/tool-calling),
collect the completed call, execute it, return `function_call_output` with its
`call_id`, then request the next response. A call can appear in both the arguments
completion event and `response.done`, so deduplicate by `call_id`. Return all
results for a batch before sending one `response.create`.

[Speech onset](https://docs.boson.ai/models/higgs-realtime/guides/turn-detection-and-interruptions)
is signalled by `input_audio_buffer.speech_started`. Stop local playback then.
Cancelling speech generation does not undo a tap already sent to Android. Our
task controller separately pauses new phone actions, invalidates pending
decisions, and observes the phone again before continuing with the corrected
request. The complete spoken interaction still needs device acceptance.

## Model evidence and latency

The [local comparison](model-comparison.md) used one common menu of actions from
accessibility observations. It did not compare each provider's native computer-use
product. GPT-6.1 Sol completed Night Light navigation in 12.31 seconds, with a
separate Android state read confirming the result. Jev was faster at an already
visible control, turning Night Light off in 1.19 seconds, but did not reliably
discover the navigation path. OpenAI Decisions did not establish reliable task
completion in the tested journeys.

Gemini's initial SDK attempt took 88.82 seconds despite the requested timeout;
the next direct REST request returned HTTP 503. These attempts do not measure
normal Gemini latency. Clef was researched, not tested. The runs used different
starting states and tasks, so they are exploratory evidence, not a leaderboard
or a percentile estimate.

Jev 1.14's [Box](https://docs.typesafe.ai/primitives/box) and
[image](https://docs.typesafe.ai/images) capabilities were reviewed. A predicted
box needs a separate existence check, and the documented image-size limits
require resizing this phone's full-height screenshots. Neither experimental
vision nor Clef's multimodal input was exercised on this phone. Their source
links and limits are retained in the comparison.

Voice response time, model-decision time, transport time, Android animation,
observation settling, and complete task time are different measurements. The
early USB bridge calls were much shorter than a whole model-driven journey.
No end-to-end voice latency claim is established.

## Playback failure and repair

The first live attempt failed after the first message with a speaker-buffer
error. A later authenticated Boson probe delivered 18.84 seconds of 24 kHz PCM in
2.251 seconds, producing a peak playback backlog of 16.589 seconds. The original
packet-count queue could hold at most 6.4 seconds. Generating audio faster than
the speaker consumes it is therefore a real input to handle.

The repair bounds queued audio by decoded PCM bytes, with a 60-second budget,
and preserves short speaker writes. Enqueueing does not wait for playback,
because the receiving thread must remain able to process speech-start events.
Four focused [native queue tests](../mobile/modules/boson-audio/android/src/test/java/expo/modules/bosonaudio/PcmPlaybackQueueTest.kt)
pass for a burst reply, message-boundary independence, interruption cleanup, and
atomic rejection beyond the budget. This establishes the queue regression fix;
the physical voice attempt still needs to be repeated.

## Expo, native audio, and hosting

The UI uses Expo; the microphone, speaker, and voice connection currently belong
to a Kotlin foreground service in a
[local Expo module](https://docs.expo.dev/modules/get-started/). This keeps the
audio lifecycle separate from whether the React Native screen is visible. A
custom module requires a native build rather than Expo Go. The installed build
bundles JavaScript, so Metro is not part of its runtime.

The original audio review found raw microphone capture and background recording
in [expo-audio](https://docs.expo.dev/versions/v58.0.0/sdk/audio/), but did not
establish the complete queued PCM playback and immediate flush path we need.
That page recommends React Native Audio API for advanced audio control. The
native choice remains subject to the [current Expo audit](expo-audit.md) and the
reported playback failure. Choosing a native module is not evidence that its
audio implementation works.

The follow-up setup check confirmed Expo 58.0.19 as the latest stable release,
with Expo Doctor passing 20 of 20 checks and SDK dependency validation passing.
Official [Expo skills](https://docs.expo.dev/skills/) were installed and applied
to the audit. Those checks cover setup and dependencies, not live audio acceptance.

Railway runs the existing Node server and its persistent phone and Boson
connections. Cloudflare is a viable alternative:
[Durable Objects support WebSocket clients and servers](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).
The current implementation would need adaptation to that runtime. Railway was
chosen to keep this proof focused, not because of a measured hosting-latency win.

## Evidence and open acceptance

| Check | Established result |
| --- | --- |
| Real Pixel Settings control over the local API | PASS for app opening, observation, tap, swipe, back, and screenshot. |
| Model-driven Night Light changes | PASS for the specific text-command runs and independent state checks recorded in the model comparison. |
| Late decision after speech pauses a task | PASS in the focused cancellation test, even when the provider ignores cancellation. |
| Standalone APK and interface | Build and installation passed; actual light, dark, and enlarged-text captures were reviewed. |
| Boson configuration | The earlier base-model synthetic handshake accepted the 24 kHz configuration. Preview-model discovery alone does not establish session compatibility. |
| Outbound phone connection | The physical Pixel connected to the hosted server. This alone does not prove an unplugged task. |
| First live phone voice attempt | FAILED acceptance as run. Ronit reported "speaker buffer filled" after the first message. |
| Speaker-buffer repair | PASS for four focused native queue tests and a real-provider audio-arrival probe. This does not establish physical playback or spoken interruption. |
| Sustained audio while Settings is open, spoken correction, echo cancellation, unplugged completion | Not established by the failed first attempt. |

Earlier controlled experiments restored brightness to 40%, adaptive brightness
on, Night Light off, and the temporary keep-awake setting to its original value.
That is a historical restoration result, not a claim about the phone after the
later voice attempt. Private device traces and screenshots remain under ignored
local artifact directories.

The next acceptance test must establish that the phone hears and answers the
first request, keeps audio working with Settings in front, replaces the task on a
spoken correction, verifies the resulting settings, and stops microphone access
when the user ends the session. Repeat that with USB unplugged before calling
the final demo laptop-independent.
