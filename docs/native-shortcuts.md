# Native shortcuts

The shared operator accepts typed brightness, media-volume, timer and alarm
requests through the existing voice task tool. `read_phone_value` reads brightness
or media volume without mutation. Other volume streams are unsupported; ambiguous
volume requests ask which stream and percentage rather than changing media volume.
The narrow catalog in `src/server/native-commands.ts` declares effects, permissions
and result checks. No arbitrary Android intents or extras are exposed.

## Clock scheduling boundary

Timers require an explicit integer duration in seconds, from 1 to 86400, and an
optional label. Voice converts unambiguous durations to seconds. Missing duration
asks "How long should the timer run?"

Alarms support only the **next occurrence in the phone's local time**. They require
hour, minute, an explicit `am`, `pm` or `24h` period, and `occurrence: next`.
Missing period asks "Is that AM or PM, in the phone’s local time?" Missing occurrence
asks "Should this alarm use the next occurrence of that time on the phone?
Date-specific or repeating alarms need the Clock app."

No date, recurrence, timezone conversion or relative-date inference is supported.
For example, an explicitly established next 7:30 PM becomes Android hour 19,
minute 30. The proposal says "Create an alarm for the next 19:30 in the phone’s
local time?" The label is included when supplied. A timer proposal says, for
example, "Create a 300 seconds timer named \"Tea\"?"

Every Clock creation requires one concrete approval through the same confirmation
interface as messaging. A correction, pause, stop or guidance switch withdraws
approval. Before dispatch, the operator refreshes screen state and handler
availability; a changed handler blocks the approved action. All mutations use the
shared sequence, including screen-changing intents. Read-only native values may
overlap voice or selector inference.

## Evidence and manual recovery

Clock intent acceptance is a handoff, not proof of creation. There is currently no
independent Clock event verifier. After an accepted handoff the operator reads the
foreground app and reports one of these actual result messages:

- "Clock opened, but the created timer or alarm is not independently verified.
  Please check Clock; I will not create it again."
- "Clock accepted the request, but its resulting screen and event are not verified.
  Please check Clock; I will not create it again."

When the native acknowledgment is lost, the operator reports "Clock outcome is
unknown. Inspect Clock before creating another." It keeps the dispatched command
in shared phone execution memory across replacement voice sessions on the same
phone connection. Continue reads fresh screen state, then reports "An earlier
Clock creation may already exist. Check Clock and handle it there; I will not
create another automatically."

The recovery affordance is manual takeover in Clock: say pause before interacting,
inspect the timer/alarm, and finish or remove it there. There is no automatic
retry or user-facing reset of this uncertainty. Further Clock creation on that
phone connection remains manual once a handoff or unknown creation is recorded.
Other supported tasks can still be requested. A definite native permission denial
clears the creation uncertainty and reports its reason followed by "Please use
Clock manually or fix its permission, then ask again." Missing handlers use
"No available Clock handler was established. Please open Clock and create it
there." Handler denial preserves its native reason and offers the same fallback.

Native media volume completion requires the requested percentage and quantized
Android index to match readback, for example "Observed media volume 6 on Android
range 0 to 15." Unknown media writes are inspected by readback before another
write. Native brightness retains its existing permission fallback to Settings.

## Mixed requests

The complete request remains retained while these questions stop execution before
any mutation:

- Clock plus another target: "Should I handle the Clock request or the other task
  first?"
- Media volume plus an app task: "Should I change media volume or handle the app
  task first?"

This implementation does not schedule those mixed workflows. The user must choose
one task and request the remaining task separately; voice must explain that limit
rather than imply the selected task completes the original combined goal.
Existing combined brightness and Night Light requests keep their established
behavior. Media volume can accompany those Settings targets in the same sequence.

## Verification limits

Public operator and synthetic voice/native/Portal protocol tests cover dispatch,
confirmation, ambiguity, recovery and scheduling. They do not establish installed
Clock behavior, Android background launch behavior, speech understanding, real
playback or unplugged acceptance. Native unit tests and assembly check maintained
Kotlin source; they do not establish those device outcomes either. The physical
Pixel and emulator are untouched by this implementation. A matching APK must be
built and coordinated before deploying the server that exposes these commands.
