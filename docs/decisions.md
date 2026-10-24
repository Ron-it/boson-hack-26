# Decisions

This is the current decision log, with the trade-offs needed to revisit it.
[Research](research.md) preserves source evidence; [runtime](runtime.md) describes
the code. A selected design is not a passed device test.

| Decision | Reason | Status and revisit condition |
| --- | --- | --- |
| Use a real Android phone for the final demo, without a connected laptop. | Ronit explicitly rejected a laptop-assisted final experience. Development can use USB and one-time setup. | Accepted project constraint. A hosted server and internet connection are allowed. |
| Prove brightness, Night Light, and a mid-task correction first. | These exercise a direct setting, UI navigation, and a revised request on the actual phone. | Current technical slice. This is not the final product scope. |
| Keep the audience and product story open. | Older adults and Uber were brainstorming examples. Ronit wanted phone use working before choosing a narrower story. | Open. Calendar, Gmail, meeting directions, and learned workflows remain possible later work. |
| Use Boson for live conversation and a separate phone operator. | The voice model supplies turn taking and tools; a worker reads the phone and chooses UI actions. The reviewed public protocol lacks image messages and native MCP tools. | Implemented split. Check preview-model capabilities separately and revisit if phone-observation support changes. |
| Pin voice to `higgs-realtime-1.5-preview`. | Ronit explicitly required the preview model; authenticated model discovery confirmed that ID is available. Public examples still commonly name the base model. | Pinned in URL and session. A live synthetic probe verified the preview acknowledgement, 24 kHz audio, tool round trip, and completion announcement. |
| Use Mobilerun Portal as the control companion. | Its local API proved real accessibility control, and its outbound WebSocket supports an owned host. It avoids first writing another accessibility service. | Selected. Keep development tools such as agent-device and Argent available for verification; they are not the current shipped runtime. |
| Use Expo for the interface and a local Kotlin foreground service for audio. | Ronit delegated the stack choice. Audio must continue while another app is visible, with direct PCM playback and interruption control. | Official Expo audit supports the local-module/CNG approach. The buffer repair passes native regression tests; physical voice acceptance remains pending. |
| Bound speaker backlog by PCM bytes while keeping reception nonblocking. | A real Boson reply arrived faster than playback and exceeded the old packet-count queue's capacity. Waiting for the speaker on the receiver would also delay speech-start events. | The 60-second queue and four native regression checks are implemented. Physical playback and spoken correction still need a repeat test. |
| Use native shortcuts where supported, then UI control for the remaining task. | Opening Display settings and changing brightness need fewer steps than model-driven navigation. Night Light currently uses the actual Settings UI. | Implemented approach. Brightness requires normal Android permission; its raw-value read-back does not guarantee an exact lasting slider percentage under adaptive brightness. |
| Start with GPT-6.1 Sol at low reasoning for the phone operator. | It completed the tested Night Light navigation path and passed a separate state verification. | Exploratory baseline, not a controlled benchmark winner. Revisit after repeated equivalent tasks in the final app. |
| Retain Jev and other selectors as comparison paths. | Jev showed fast decisions at known controls, but its navigation was unreliable here. Gemini availability and latency were not established by the failed attempts. | CLI experiments only. No need for an additional gateway or a multi-provider runtime yet. Clef was researched, not run. |
| Host the Node controller on Railway. | The existing server can hold the phone and voice connections without a platform port. | Current hosting choice, approved by Ronit. Cloudflare Durable Objects remain viable; no comparative latency or cost win is claimed. |
| Keep provider credentials on the server. | The phone needs a scoped pairing credential, not the Boson or OpenAI API key. | Implemented. Never include keys, tokens, or private screen traces in committed examples or documentation. |
| Pause on speech onset and continue only under the latest complete request. | A correction can arrive while a model response or Android gesture is pending. The old decision must not become a new tap. | Implemented task ownership checks and a focused race test. A gesture already dispatched can finish; pause is not undo. Full spoken behavior remains unverified. |
| Distinguish a tool acknowledgement, a completion claim, and an observed result. | An accepted tap or a model saying "done" does not prove the requested setting changed. | Required reporting rule. Background-task completion announcements must also obey Boson's supported message schema. |

## Recorded authorization

Ronit authorized using the real Pixel for the experiment, installing and enabling
Portal's accessibility service, and using USB for development. The accessibility
service can read screen content and operate controls until disabled.

Ronit also authorized sending the relevant Android Settings text and control
values to Gemini, TypeSafe/Jev, and OpenAI, with Settings screenshots when needed
for a visual test. That experiment scope does not grant permission to send
unrelated personal app contents to those providers.

For the hosted phone demo, Ronit explicitly approved storing the Boson and OpenAI
API keys in the new Railway controller service. Values stay private. The app's
microphone and brightness permissions use Android's normal permission flow.

The current request authorizes separating the completed work into relevant PRs
and merging them. PR completion and merging should be recorded from actual
repository state rather than assumed from this authorization.

## Still open

- A useful product story beyond basic phone automation and interruption.
- A narrower audience, if evidence supports one.
- Whether calendar or email context is needed for the chosen task.
- Whether teachable workflows add enough value to justify recording and replay.
- Reliable speaker playback, echo cancellation, and interruption on the physical phone.
- Repeated unplugged completion, recovery from connection loss, and measured voice-to-action latency.

The live speaker-buffer failure is an acceptance failure, not a reason to mark
all earlier Settings and setup checks as failed. Keep each result at the scope
it actually tested.
