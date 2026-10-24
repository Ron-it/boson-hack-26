# Tandem

Language for the voice-operated phone prototype and its acceptance checks.

## Language

**Voice session**:
The period in which the user has started the assistant's microphone and can
hold a spoken conversation. It ends when the user stops it or the connection ends.
_Avoid_: Phone task, when referring to the whole conversation.

**Phone task**:
A requested result on the phone, such as a target brightness and Night Light
state. One voice session can contain several phone tasks.
_Avoid_: Tap, when referring to the requested result.

**Current request**:
The complete result the user currently wants, including requirements retained
from earlier speech and any later corrections.
_Avoid_: Latest transcript, when it contains only part of that intent.

**Correction**:
A change to or withdrawal of part of the current request. A correction does not
imply that an action already completed on the phone has been undone.

**Phone operator**:
The assistant role that chooses the next phone action toward the current request.
_Avoid_: Phone control, when referring to the choice rather than the ability to act.

**Phone control**:
The ability to read the phone's current interface and operate its controls.
_Avoid_: Phone operator, when referring only to that capability.

**UI task**:
A phone task that visibly operates apps on the user's screen. The user can
interrupt the assistant or take over the task.
_Avoid_: Background task, when the assistant needs the visible screen.

**Guidance**:
Step-by-step help requested by a user who wants to operate the phone themselves.
_Avoid_: Task execution, when the assistant is only explaining the steps.

**Confirmation**:
The user's spoken approval of one concrete proposed final action, such as sending
a specific message to a specific person. It applies once, and a correction,
pause or handoff withdraws it.
_Avoid_: Permission, when referring to an Android grant.

**Observed result**:
A phone state read after an action, such as Night Light visibly being off.
_Avoid_: Successful tap, as proof of the requested state.

**Completion claim**:
The assistant's assertion that a phone task is finished. It needs supporting
observed results and may still need an independent check.
_Avoid_: Verified completion, without that evidence.

**Family voice**:
A helper's voice cloned from a short paragraph they read aloud on the phone, in
the language Family mode speaks. It belongs to the Boson key of the controller
that created it.
_Avoid_: Voice preset, when referring to the cloned voice.

**Unplugged demo**:
A complete spoken phone task on the real phone without a laptop connection.
The phone may still use the internet and a hosted server.
_Avoid_: Standalone build, as proof that the whole demo works.
