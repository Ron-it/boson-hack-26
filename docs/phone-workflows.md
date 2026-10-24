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
observation of this request before any mutation. Duplicate field purposes ask a
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
