# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Stack

Delegated by Ronit: Expo and TypeScript for the interface, a local Kotlin module for foreground audio, and a hosted Node controller.

## Users

The target audience is people who can describe what they want but struggle to
understand and navigate unfamiliar apps. This may include older adults. Age or
disability alone does not define the audience; difficulty navigating apps is the
chosen focus. Ronit is the immediate prototype tester.

## Product Purpose

Help a person accomplish a goal when they get stuck understanding or navigating
an app, using conversation and visible phone operation. By default, the assistant
does the requested task with brief explanations. Step-by-step guidance is
available when the user asks to be shown how.

Candidate demo scenarios include navigating an unfamiliar workflow such as an
order return, carrying information across apps such as an appointment email to
a calendar, and completing a task through voice without manual tapping. Keep
these candidates open and select the main presentation scenario after testing
the shared operator on the actual phone. These are intended scenarios, not
verified capabilities.

The assistant uses the current screen as context for requests such as "help me
with this." The user does not need to name the app or describe its interface.
When the intended outcome is unclear, ask a short clarifying question.

The current proof changes phone settings and accepts task corrections. The final
demo must work without a laptop connection.

## Operating Context

One real Pixel phone, Boson Higgs Realtime voice, and Mobilerun Portal accessibility control. The first slice changes brightness and Night Light. The voice session must stay alive when Android Settings is in front.

## Capabilities and Constraints

Phone control is restricted to Settings for this experiment. Start and stop must be explicit. Speech pauses new actions; a corrected goal supersedes pending decisions. Completion requires observed values. Calendar, Gmail, ride booking, learned workflows, and a final product story remain open.

For the broader operator, always obtain confirmation before sending, submitting,
buying, or deleting, even when the initial request explicitly asks for that
action. Present the concrete action and relevant details before asking.

Automatic pause on manual tapping or typing is the target. If reliable detection
is unavailable, the hackathon may require the user to say "pause" before touching
the screen. This is an accepted fallback, not automatic takeover. In either
case, wait for an explicit request to continue, then read the updated screen and
reassess the remaining task.

When blocked, briefly explain what prevents progress and offer guidance or
manual takeover. Give only instructions supported by the observed screen.
After a manual handoff, wait for the user to ask it to continue and read the
updated screen. Do not repeatedly retry an action without progress.

## Evidence on Hand

The local model comparison and private device traces establish Settings navigation and observed toggles. Live voice and unplugged operation are not yet proven.

## Product Principles

- Prove the full interaction on the actual phone.
- Keep the first slice small.
- Prefer native shortcuts where their result can be verified.
- Show current state and recoverable errors plainly.
- Keep spoken responses short and direct. Give brief acknowledgments and outcome
  reports; explain steps when the user requests guidance.

## Brand Commitments

No final product name or identity has been chosen. Use a restrained Android utility screen, minimal copy, no decorative cards or pills, and no continuous animations.
