# Supported app workflows

The operator accepts general mobile goals. Execution stays bounded by effects
established for the current app. An unfamiliar control is not an arbitrary tap
candidate, even when its label sounds harmless or the model says it is safe.

The same model-driven loop handles app launch, supported visible controls,
purpose-bound text input, scrolling within a current list, back, confirmation,
and fresh outcome checks. There is no stored sequence for a Files journey.
Current adapters cover the existing Settings and Google Messages behavior,
DocumentsUI image search and selection, and the resulting Google Photos viewer.
Other app controls, including file creation, purchases, deletion, and arbitrary
web forms, require clarification or manual takeover.

## Public request and result

`PhoneRequest.values` contains `{ field, text, source }` entries. A request source
is `{ kind: 'request' }`. A screen source includes `kind: 'screen'`, `packageName`,
`resourceId`, and the exact `text`. Screen-sourced text must match the first fresh
observation of its UI step before any UI mutation. Earlier supported operations
may already have established their own outcomes. Duplicate field purposes ask a
question. The navigation model chooses from these values and cannot invent text.
A resumed request whose screen source is no longer visible asks for the text
again. Durable cross-app fact capture remains work for ticket 11.

`PhoneRequest.outcome` currently supports:

- `{ kind: 'search_results', query }`, checked against the live Files search field
  and named image result rows.
- `{ kind: 'content_opened', name }`, checked against an exact image row that the
  operator selected and a subsequent supported Photos image-view observation.
  A pre-existing photo viewer cannot complete a new request by itself.

Generic completions include `TaskStatus.evidence`. The discriminated evidence
records the query and matching names, or the dispatched selection and observed
viewer resource ID. The task envelope supplies the request revision. Extend
these outcome/evidence unions for new supported results rather than using a
message recipient or a generic model success flag. The existing message/Clock
proposal union remains intact. New consequential operations need their own
concrete payload, target and one-shot confirmation path.

## Observation and dispatch

The navigation context includes roles, resource IDs, descriptions, hierarchy,
bounds, editability, focus when Portal provides it, checked/range state, and the
explicit request. Sparse accessibility can include a bounded PNG as actual image
input to the OpenAI Responses API. Screenshots do not enable coordinate guesses
or authorize unknown effects. See the [official image-input contract](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses).

Display geometry is refreshed from capture on each device observation, including
small dialogs that would fit an obsolete orientation. Capture failure discards
the previous dimensions and leaves an explicitly marked window-origin fallback,
or no geometry for an offset dialog. Identical numeric dimensions can settle
whether they came from capture or the fallback. Foreground/frame settling is
bounded to five seconds; live unrelated text need not stop changing.

Before dispatch, the operator checks the foreground, coordinate frame, exact
selected target, relevant ancestors, current effect, state and coordinates.
Traversal index changes and unrelated text do not invalidate that target.
Scrolling belongs to the observed scroll container. Text entry checks request
ownership and the target again after focusing, and refuses an explicitly
unfocused target. Peers omitting focus state retain the legacy tap-plus-target
check; that is weaker evidence than an explicit focused field.

Repeated unchanged controls stop after two no-progress observations; all work
also has a 16-step limit. Generic manual handoff persists through corrections
until explicit continue. Native permission recovery and the existing messaging
confirmation behavior retain their separate rules. Explicit voice pause before
manual interaction remains the accepted fallback, not automatic touch detection.


## One retained request

`src/server/operation-plan.ts` defines the shared operation contract: typed
arguments, a declared effect, executor and optional fresh result check. The flat
ordered plan in `PhoneTask.planRequest` composes media, display Settings, Clock
and supported app work under the same revision, serialized phone tail, pause,
correction and confirmation lifecycle. This is an ordered list, not a stored UI
journey or a separate voice tool for each workflow. Adding a supported operation
contributes its arguments, effect, executor and check at this contract.

`TaskStatus.progress` reports each required operation and its evidence. Whole-goal
completion requires every operation to be established. A later app failure keeps
an established native result and the unfinished app requirement. Continue reads
fresh evidence for mutable completed outcomes. A missing final native readback
becomes unknown and must be inspected before another write. Clock intent
acceptance remains unknown without independent event evidence; continuing other
work never creates that event again. Calendar fields remain ticket 11 work.

A proposal includes only the current concrete operation, payload and target.
Internally its operation key and revision bind it to the current step. The
proposal is consumed once before dispatch. The known Messages adapter still
requires a new outgoing copy marked sent beyond its pre-send baseline.

A fresh supported generic outcome can finish directly after observation without
another model request to choose done. A model's done alone remains insufficient.
The runtime baseline is Sol low reasoning with default serving. Coding-agent
model preferences do not alter runtime configuration.

## Voice and overlay protocol

Accepted asynchronous tool work returns its tool output without requesting an
idle acknowledgment response. The operator queues one material result, blocker
or relevant question. Repeated equal statuses in a user turn do not repeat the
announcement. A new intentional user turn can interrupt and ask another
question; old response audio and late tool completion cannot own that turn.
Queued outcomes survive speech unless a new working request supersedes them.

Each requested reply carries opaque ownership metadata, echoed by Boson on
response.created. Ordinary provider responses may carry metadata:null. During a
submitted task's turn, unowned replies are cancelled and their transcript/audio
is withheld. Terminal narration includes the grounded operator outcome as
explicit response.input as well as instructions. The live provider produced an
unrelated greeting with instructions alone; input made the bounded synthetic
probe task-relevant. This is no universal semantic guarantee of generated speech.

The app receives independent events:

- Existing `TaskStatus` is authoritative operator work and outcome state, with
  optional operation progress and discriminated evidence.
- `VoiceResponseStatus`: `{type:'voice_response',state:'generating'|'audio'|
  'finished'|'cancelled'|'suppressed'|'unknown',voiceTurn,responseId?,taskRevision?}`.
  Audio means first provider bytes forwarded, not actual device playback. A
  finished voice reply does not clear task working.
- `VoiceIssue`: `{type:'voice_issue',source:'voice',state:'blocked'|'unknown',
  detail,voiceTurn,taskRevision?}`. Display the concise grounded detail. A missing
  response completion has a 30-second deadline; it cancels stale generation,
  marks speech delivery unknown and never replays a phone action or narration.
  Provider disconnection cannot guarantee spoken error delivery. Native playback
  and overlay presentation are owned separately.

Timing logs contain opaque owner IDs, revisions, operation IDs, phase and
monotonic milliseconds only. They omit arguments, screens and transcripts.
Phases cover queue/execution, native commands, state, screenshot, settle, model,
dispatch, verification, speech end, tool arguments/dispatch, result queue,
response creation, first audio and provider completion. Nested spans overlap;
do not sum them as independent elapsed time. Provider completion is not playback
completion.

## Current acceptance boundary

Public operator and voice/device tests use controlled peers. They establish
composition, ownership, one-shot confirmation and honest partial results. A live
Boson text-fed synthetic-native probe separately establishes no audio during
pending work and a relevant result after fresh evidence, with ownership metadata
round-tripping. It does not prove microphone, physical phone or playback behavior.

On emulator-5554, Portal HTTP was independently bound by serial, adb forward,
local token, equal HTTP/ADB Portal trees and matching screenshot geometry.
Actual Portal launch, search focus and typing worked. The image result tap was
acknowledged as dispatched but did not open the image, including a separate
500ms delay before observation. Only Portal accessibility was enabled. Earlier
agent-device tap journeys are differential evidence and do not establish
production PhoneControl acceptance. This transport/execution gap remains open.
Sol low trials encountered HTTP 503 and a 20s decision timeout. There is no
successful matched model/device speed comparison or broad general-mobile
completion claim. No physical Pixel interaction or deployment was performed.

Luna Decisions was tried against the same grounded image-result contract after
the unavailable Sol trials. Its two decisions took about 1052ms and 439ms; the
3.34s task stopped for no progress because the acknowledged Portal taps did not
open the image. This is a failed device journey, not a measured successful
speedup. Runtime selection remains unchanged.
