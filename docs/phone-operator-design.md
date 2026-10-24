# Phone operator design

Status: accepted technical design. Ronit confirmed the design after the product
interview. Product decisions are recorded in [Product](../PRODUCT.md).
Implementation and broader device verification remain outstanding.

## Caller experience

Today, the voice caller directly dispatches brightness commands or starts a
Settings-only worker. In the selected design, voice submits the user's current
request to one phone operator. The operator owns action scheduling, interruptions,
confirmation, and evidence for the result across all execution paths.

Keep the caller interface small: submit or revise the current request, pause,
resume, and answer a pending question or confirmation. Emit short progress,
questions, proposed actions, handoffs, and evidenced outcomes for voice to report.
The user should not have to choose an execution path.

## Execution paths

Prefer a supported native command when it can accomplish the requested result.
Use a structured intent or deep link to reach an app function when available.
Use the visible UI for the remaining steps. A task can combine these paths.

Native commands have typed arguments, declared permission requirements, known
effects, and a result check where possible. Start with a small explicit catalog,
not arbitrary Android method invocation or a plugin framework.

An intent or deep link is a handoff, not necessarily a completed task. It may
open another app, require user input, or lack a queryable result. Record what
actually happened, and use a fresh screen observation when appropriate.

For UI steps, retain useful control labels, roles, resource IDs, state, hierarchy,
and absolute bounds. Validate screen geometry independently of a dialog's bounds.
Support app launch, text entry, scrolling, back, and selecting visible controls.
Screenshots can supplement incomplete accessibility information where available.

## Scheduling and interruption

Use one coordinator per phone across native and UI paths. UI work, app launches,
and intents that can change the screen must share an ordered execution sequence.
Only independent operations with known compatible effects may overlap. Voice
and model inference need not hold exclusive screen access.

Each current request has a revision. Speech, manual takeover, cancellation, or a
correction invalidates pending decisions before another action is dispatched.
An already dispatched Android action may finish; interruption is not rollback.

Manual tapping or typing requires an explicit resume. Resume starts from a fresh
observation and the remaining current request, not the old sequence of taps.
The inspected Portal event contract does not expose a distinction between manual
input and programmatic actions. This requires a separate device-side feasibility
probe. Neither screen changes nor generic text-change events prove manual input.
Ronit accepted explicit voice pause before manual interaction as the hackathon
fallback if reliable automatic detection is unavailable. This does not satisfy
automatic takeover and must be presented as an explicit-pause interaction.

Validate the chosen control and relevant app context immediately before acting.
Whole-screen equality is too strict for changing countdowns and other unrelated
live content. A target that moved or changed must be reconsidered.

## Confirmation

Sending, submitting, buying, and deleting always require confirmation. This
applies equally to native commands, intents, and UI steps. A voice instruction
alone is not a substitute for the required final confirmation.

Represent a proposed final action with its concrete details and current request
revision. Approval applies once to that proposal. Changed recipient, contents,
price, item, or other material details require another confirmation. Revalidate
the relevant app state before dispatch and invalidate stale approval on takeover
or a correction.

For arbitrary UI, identifying consequential controls remains a semantic problem.
A controller can enforce that a recognized proposal needs approval, but an
instruction to the model alone cannot guarantee recognition of every final
action in an unfamiliar app. Uncertain effects should lead to clarification or
handoff. Technical research must establish what can actually be enforced.

## Result evidence and recovery

Keep action acceptance, model completion claims, and observed outcomes distinct.
Known native commands use explicit result checks. UI completion requires fresh
evidence supporting the requested outcome. If the available evidence is weak,
report the limited observation or uncertainty instead of asserting completion.

A timed-out mutation has an unknown outcome and must not be blindly retried.
Inspect the result first, particularly for duplicate messages, purchases, or
submissions. Stop repeated actions without progress and offer a brief, grounded
handoff. Manual handoff waits for explicit resume.

## Selected stack and remaining checks

Retain Boson voice, the native Kotlin execution/audio module, the hosted Node
controller, and Portal as the phone-control adapter for the first implementation.
Keep the existing navigation model as the comparison baseline; this decision
does not select a new model or move orchestration to Mobilerun Cloud.

Portal documents text entry, screenshots, app launching, deep links, and reverse
events. Its inspected public event types do not include manual-touch or
manual-typing provenance. Reverse events are best-effort and have no replay after
reconnection. The current server ignores unsolicited events, and the runtime
phone interface does not expose screenshot capture or text entry.

Device tests must establish stop behavior, takeover detection, confirmation
enforcement, permission failures, result verification, and unplugged execution.

Candidate journeys remain open. Compare total time to a supported outcome,
incorrect actions, false completion claims, and interruption behavior on the
actual phone. Text-injected emulator success does not establish spoken or
accessibility acceptance.

## Implementation order

1. Put native and UI execution behind one operator, with persistent pause,
   revision checks, confirmation proposals, and explicit outcome states.
2. Expand Portal observation and execution beyond Settings, including accurate
   geometry, useful control context, app launching, typing, and visual fallback.
3. Add a small native-command and intent catalog based on the actual phone's
   permissions and installed handlers. Use it to avoid unnecessary UI steps.
4. Verify confirmation, correction, pause/continue, unknown outcomes, and handoff
   through real journeys. Judge the actual requested result, not successful taps.
5. Test the candidate scenarios on the actual phone and select the main demo.
   Optimize measured bottlenecks after establishing correct behavior.

## Source grounding

Read-only research inspected Portal commit
`da4e384d10f9d6bfa26f8f0c7b653f7eae34caaf`. Installed APK compatibility and physical
behavior were not tested in this design session.

- [Portal local API](https://github.com/droidrun/mobilerun-portal/blob/da4e384d10f9d6bfa26f8f0c7b653f7eae34caaf/docs/local-api.md)
- [Portal event types](https://github.com/droidrun/mobilerun-portal/blob/da4e384d10f9d6bfa26f8f0c7b653f7eae34caaf/app/src/main/java/com/mobilerun/portal/events/model/EventType.kt)
- [Portal reverse connection](https://github.com/droidrun/mobilerun-portal/blob/da4e384d10f9d6bfa26f8f0c7b653f7eae34caaf/docs/reverse-connection.md)
- [Personal Phone enrollment](https://docs.mobilerun.ai/guides/connect-android)

Current repository evidence: `src/server/voice.ts` routes brightness separately
from the UI task; `src/server/task.ts` accepts model-selected completion;
`src/server/device.ts` handles request/reply messages; `src/mobile/selectors.ts`
omits control roles, IDs, bounds, and hierarchy from model context.
