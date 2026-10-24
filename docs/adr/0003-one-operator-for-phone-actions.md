# Coordinate all phone actions through one operator

Retain Boson voice, the hosted Node controller, Kotlin native commands, and
Mobilerun Portal. Route native commands, structured intents and deep links, and
visible UI steps through one operator that owns scheduling, request revisions,
pause and resume, confirmation, and outcome evidence. The current split lets
native commands bypass the UI worker's lifecycle; merely widening that worker's
app scope would leave inconsistent execution rules.

Serialize actions that affect the screen and permit overlap only for operations
with known compatible effects. Always confirm sending, submitting, buying, and
deleting across every execution path. Keep the existing navigation model as the
baseline until measurements justify a change. Moving orchestration to Mobilerun
Cloud does not establish these controls and is not selected for this build.

Automatic pause on manual interaction remains the target. Explicit voice pause
before touching the screen is an accepted hackathon fallback, followed by an
explicit request to continue and a fresh observation. Portal's inspected event
contract does not establish manual-input provenance.

Ronit accepted this technical design. Implementation and device verification
remain outstanding. See the [design and source grounding](../phone-operator-design.md).
