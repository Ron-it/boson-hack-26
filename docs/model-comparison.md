# Phone model comparison

Checked October 23, 2026. Physical Pixel 10, Android API 37, Mobilerun Portal 0.7.27.

Use **Boson for voice and GPT-6.1 Sol at low reasoning for the first phone operator**.
Keep direct Android tools for supported actions. Jev is worth retaining for a
clearly identified control, but it did not reliably discover the Night Light
navigation path in these runs. A gateway adds no necessary capability to this
initial implementation.

## What ran

All selectors receive a compact view of the same accessibility properties and a
menu of concrete actions derived from the current screen. This compares our
action-selection code, not the providers' native Computer Use products.

| Candidate | Observed result |
| --- | --- |
| Jev 1.14.0 | First brightness prediction took 398 ms. Later decisions were often 70-215 ms. It set brightness to 70% in a 1.51-second loop. After the Night Light switch was visible, it switched it off and finished in 1.19 seconds. It failed two navigation attempts. |
| OpenAI Decisions, GPT-6 Luna | First brightness prediction took 1.18 seconds. Later decisions varied from about 0.16 to 1.48 seconds. It found Comfort Filters in one run, but the tested journeys did not establish reliable completion. |
| GPT-6.1 Sol, low | Found Comfort Filters, turned Night Light on, and finished in 12.31 seconds from Display settings. Five model decisions took 1.39-2.16 seconds each, including one discarded stale decision. Android's separate state read confirmed Night Light was on. |
| Gemini 3.8 Flash, low | An initial SDK prediction returned the correct action after 88.82 seconds despite the requested timeout. A direct REST request then returned HTTP 503. The implementation now uses direct REST. These results do not establish normal Gemini inference latency. |

These are exploratory runs with different tasks and starting screens, not a
ranked benchmark or percentile estimate. Raw traces are in the ignored
`artifacts/` directory. Model-loop times exclude the later independent Android
verification. None includes Boson speech or microphone handling.

## Fixes discovered on the real phone

- `/state_full` exposes checked states, slider ranges and available scroll actions.
  The original compact endpoint omitted those properties.
- A preference row can hold a label and an unlabeled, non-clickable switch. Our
  first conversion dropped that switch, so models could not see Night Light's
  state. The conversion now associates the row with its single native switch.
- The controller waits for stable observations, offers only native scroll
  directions, rejects stale decisions, and stops repeated actions that make no
  visible progress. A gesture acknowledgement alone does not prove the UI settled.
- A text display name can be absent from Android app metadata. The reader uses
  the package name in that case.

One focused regression test reproduces the label/switch hierarchy. Physical
device checks remain separate from that test.

## Jev's new capabilities

The current release is [Jev 1.14.0](https://docs.typesafe.ai/models), released
October 14. It adds [Box prediction](https://docs.typesafe.ai/primitives/box) and
extends [image support](https://docs.typesafe.ai/images). Images and Box still
require an experimental header. A Box is returned even if the requested target
is absent, so a separate existence answer must gate its use.

Images must fit the documented 280-1568-pixel limits per dimension. This phone's
1080-by-2424 screenshots need resizing before Jev image input. None of these
tests used Jev's experimental vision. Its existing
[Choice](https://docs.typesafe.ai/primitives/choice) can select an entire action
and target in one call when the phone supplies labeled controls and bounds.

## Source limits and alternatives

[OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) is
generally available and supports text, JSON and images with GPT-6 Luna. Its
advertised speed comparison is not a mobile-task benchmark.
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) supports
images and structured actions; this prototype uses its text input and low reasoning.

Google currently recommends [Gemini 3.8 Flash for Computer Use](https://ai.google.dev/gemini-api/docs/computer-use#model-versions).
Its [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
supports low thinking; minimal thinking is invalid. Google's native Computer
Use is [not available on the free tier](https://ai.google.dev/gemini-api/docs/pricing).
Our custom action menu uses ordinary model inference.

The reviewed primary sources did not provide a comparable latency benchmark
for these models on this Pixel workflow. Desktop benchmark scores and vendor
token speeds cannot settle this choice. Jev's published workflow evaluation is
not an Android navigation evaluation.

[Cloudflare Clef and Clef Omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/)
also support typed decisions. Omni adds image, audio and video input; no Box
output is documented. Cloudflare's
[published latency and evaluation results](https://developers.cloudflare.com/changelog/post/2026-10-09-clef-omni-workers-ai/)
cover bounded decisions, not this phone journey. Clef was researched but not
tested here. Adding its provider now would not address an established gap.

Reconsider the baseline after clean repeated journeys on the final app. Boson
voice correction, screenshots as model input, and full unplugged completion
remain unverified. The installed app and outbound phone connection now exist;
voice is pinned to Higgs Realtime 1.5 preview, whose synthetic protocol check passes.
