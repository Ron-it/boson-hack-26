---
name: Tandem
description: Dark, bottom-weighted Android voice helper built on Boson AI foundations.
colors:
  canvas: "#0D1012"
  surface: "#161819"
  raised: "#1C2022"
  text: "#EFF0F0"
  strong: "#F4F5F5"
  secondary: "#BFC1C2"
  muted: "#999B9C"
  control-border: "#60696D"
  accent: "#2BCB3A"
  accent-pressed: "#21B82F"
  on-accent: "#0D1012"
  green-soft: "#8CC4A4"
  error: "#FF9B93"
typography:
  display:
    fontFamily: "Manrope"
    fontSize: "44px"
    lineHeight: "50px"
    fontWeight: 500
    letterSpacing: "-1.1px"
  headline:
    fontFamily: "Manrope"
    fontSize: "34px"
    lineHeight: "42px"
    fontWeight: 500
    letterSpacing: "-0.7px"
  wordmark:
    fontFamily: "Manrope"
    fontSize: "21px"
    lineHeight: "28px"
    fontWeight: 600
    letterSpacing: "-0.4px"
  lead:
    fontFamily: "Instrument Sans"
    fontSize: "19px"
    lineHeight: "29px"
    fontWeight: 400
  quote:
    fontFamily: "Instrument Sans"
    fontSize: "19px"
    lineHeight: "28px"
    fontWeight: 400
  button:
    fontFamily: "Instrument Sans"
    fontSize: "18px"
    fontWeight: 600
  body:
    fontFamily: "Instrument Sans"
    fontSize: "17px"
    lineHeight: "26px"
    fontWeight: 400
  status:
    fontFamily: "Instrument Sans"
    fontSize: "17px"
    lineHeight: "24px"
    fontWeight: 600
  tab:
    fontFamily: "Instrument Sans"
    fontSize: "17px"
    fontWeight: 500
  input:
    fontFamily: "Instrument Sans"
    fontSize: "16px"
    fontWeight: 400
  hint:
    fontFamily: "Instrument Sans"
    fontSize: "15px"
    lineHeight: "22px"
    fontWeight: 400
  label:
    fontFamily: "Instrument Sans"
    fontSize: "14px"
    lineHeight: "20px"
    fontWeight: 600
  detail:
    fontFamily: "Instrument Sans"
    fontSize: "14px"
    lineHeight: "20px"
    fontWeight: 400
  caption:
    fontFamily: "Instrument Sans"
    fontSize: "13px"
    lineHeight: "18px"
    fontWeight: 400
rounded:
  input: "8px"
  block: "12px"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  "28": "28px"
  "40": "40px"
  "48": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button}"
    rounded: "{rounded.block}"
    padding: "0 24px"
    height: "64px"
  button-primary-pressed:
    backgroundColor: "{colors.accent-pressed}"
    textColor: "{colors.on-accent}"
  button-neutral:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.strong}"
    typography: "{typography.button}"
    rounded: "{rounded.block}"
    padding: "0 24px"
    height: "64px"
  button-neutral-pressed:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.strong}"
  button-small:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.strong}"
    rounded: "{rounded.block}"
    padding: "0 20px"
    height: "48px"
  preset-tab:
    textColor: "{colors.muted}"
    typography: "{typography.tab}"
    height: "48px"
  preset-tab-selected:
    textColor: "{colors.strong}"
  input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.input}"
    rounded: "{rounded.input}"
    padding: "0 16px"
    height: "56px"
  message-quote:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.quote}"
    rounded: "{rounded.block}"
    padding: "20px"
---

# Design System: Tandem

## Overview

**Creative North Star: "Two voices, one thumb"**

Tandem is a near-black, dark-only Android app in the Boson AI design system. Each screen is a quiet canvas with one large question or headline, and every control sits at the bottom near the thumb. Green is rare and means one of two things: the action to take, or a session that is live.

The mark tells the story. A white dot is you. A signal-green arc beside it is Tandem, listening and answering. The source of truth is `mobile/App.tsx`. The Paper design file is the "Tandem app" page in "Boson AI Design System" (https://app.paper.design/file/01M5B4ADQSXTWS4JWY87EBYE4C/p-5-0).

Rendered evidence in `.impeccable/review/`: home while unpaired (`tandem-emulator-5554.png`), Settings (`tandem-settings.png`), home at 1.3x font scale (`tandem-large.png`), and the Family voice section idle, recording and reflected on Home (`family-voice-settings.png`, `family-voice-recording.png`, `family-voice-home.png`). The Live, Working and Confirm states exist in code but were not captured on a device, because no server was available.

**Key Characteristics:**
- Dark only. No light scheme.
- Bottom-weighted screens. Content sits low, actions sit lowest.
- Green only for the primary action and a live session.
- Information sits directly on the canvas. The message quote is the only enclosed block.
- No shadows, gradients, section rules, or continuous animation.

## Colors

Cool near-black neutrals from the Boson foundations, with one signal green.

### Primary
- **Signal Green** (accent): fill of the full-width primary button, the live dot and live state text, the recording dot and timer, Working and Done status text, the selected preset and language underline, input focus border, text selection, "Turn on" permission actions, and the Paired check.
- **Pressed Green** (accent-pressed): primary button while pressed.
- **Ink on Green** (on-accent): label and icon on the primary button. Same value as the canvas.

### Secondary
- **Sage** (green-soft): Settings section labels ("Permissions", "Family voice", "Connection") and the "Paired" and "Your voice" text. A calm green for structure, never for action.

### Neutral
- **Canvas** (canvas): the whole app background, also the app and splash background.
- **Surface** (surface): the message quote block, and the pressed state of neutral buttons.
- **Raised** (raised): the Stop button and the Save button at rest.
- **Strong** (strong): display, headline, wordmark, selected tab, row titles, button labels, and the white dot in the mark.
- **Text** (text): input values, Tandem's spoken reply, quoted message, back arrow, stop glyph.
- **Secondary** (secondary): lead, body, preset hint, field labels, the settings icon, and the "On" permission state.
- **Muted** (muted): captions, unselected tabs, row details, quote meta, placeholders, the "Tandem" reply label.
- **Control Border** (control-border): 1px outline of inputs at rest.
- **Error** (error): error text only, and Blocked or Unknown task status.

**The Two Greens Rule.** Signal green marks the primary action and a live session. Stop is neutral (raised), never green or red. Anything structural that wants green uses sage.

## Typography

**Display Font:** Manrope 500 and 600 (bundled with expo-font)
**Body Font:** Instrument Sans 400, 500 and 600 (bundled with expo-font)

**Character:** Manrope sets the large question and headlines with tight negative tracking. Instrument Sans carries everything you read or tap.

### Hierarchy
- **Display:** the home question, "What do you need help with?".
- **Headline:** Live screen. What you said, the current goal, or "Send this to {name}?".
- **Wordmark:** "Tandem" in the top bar, and the "Settings" title.
- **Lead:** the line under the home question.
- **Quote:** the message text inside the confirmation block.
- **Button:** labels on full-width buttons. The small Save button uses the same face at 16px.
- **Body:** task detail, spoken yes/no instruction, Tandem's reply, errors.
- **Status:** task state line on Live (Working, Done, Blocked), colored by state.
- **Tab:** preset names.
- **Input:** server address and pairing code values.
- **Hint:** the one-line description under the selected preset. Family's names its language and whether it uses your voice.
- **Label:** section labels in Settings (in sage) and the "Tandem" reply label (in muted).
- **Detail:** row details, quote meta, field labels.
- **Caption:** centered 13px line under the main button, and the left-aligned about line in Settings.

**The Scale With The User Rule.** Text follows Android font scale. At 1.3x the home screen still fits, the question wraps and the bottom stack stays intact.

## Layout

One portrait column inside a ScrollView with safe-area padding (bottom inset plus 24). Horizontal inset is 24 everywhere.

Every screen has the same skeleton, top to bottom:
1. **Top bar**, 64 tall. Mark and wordmark on the left (8 gap), a 48dp icon button on the right.
2. **Main area** that grows to fill space and pushes its content to the bottom (48 top, 40 bottom, 16 gap; 24 gap on Live).
3. **Controls**: preset tabs (28 gap) with the hint 12 below, on Home only.
4. **Actions**, 24 above: one full-width 64-tall button, then a centered caption 16 below.

Screens:
- **Home:** display question and lead at the bottom of the main area, then presets, then "Start talking" (with mic icon) or "Pair this phone" when unpaired.
- **Live:** the top bar swaps the settings icon for an 8px green dot and live state text ("Listening", "Waiting for you"). Headline, then a status line colored by task state, task detail, and Tandem's reply. For a message confirmation: headline, the message quote block, and a spoken instruction ("Say yes to send, or no to change it"). There are no confirm buttons; the answer is spoken. Stop is the single action.
- **Settings:** back arrow and title in the top bar. Permissions rows (72 min height) with trailing "On" or "Turn on". Family voice section 40 below: scrollable language tabs, the paragraph to read aloud in quote type on the canvas, then a row with the voice status on the left ("Standard voice", "Recording 0:07", "Making your voice…", "Your voice") and a small Record, Done or Record again button on the right, and a left-aligned consent caption. Connection section 40 below with labeled inputs, then a row with "Paired" on the left and a small Save button on the right. The about caption sits at the bottom.

**The Thumb Rule.** The main area grows and the content falls to the bottom. Never pin content to the top and leave the bottom empty.

## Elevation & Depth

Flat. No shadows, no elevation, no gradients, no section rules. Depth comes from three tonal steps: canvas, surface, raised. Raised is for neutral buttons, surface for the quote block and pressed states.

**The Open Canvas Rule.** Information sits directly on the canvas. The message quote is the only enclosed block, because it shows words Tandem is about to send for you.

## Shapes

Soft corners on controls and blocks (12) and tighter corners on inputs (8). The stop glyph is a 14px square with 3 corners. The live dot is a circle.

The mark is drawn in a 108 viewBox: a white circle (cx 44, cy 54, r 11) and a green arc `M60.7 34.1 A26 26 0 0 1 60.7 73.9` with a 10 stroke and round caps. The in-app lockup crops the viewBox to `28 28 52 52` and renders it at 22. The notification icon `ic_tandem.xml` is the same geometry in white only, 24dp, cropped the same way. The launcher uses an adaptive icon with foreground, background and monochrome layers.

## Components

### Buttons
- **Shape:** 12 corners, 64 tall, full width, 10 gap between icon and label.
- **Primary:** signal green fill, ink label. Darker green while pressed. "Start talking" carries a 22px mic icon.
- **Neutral:** raised fill, strong label, surface while pressed. Used for Stop, with a stop glyph.
- **Small:** raised Save button, 48 tall, 20 side padding, 16px label.
- **Disabled:** 40% opacity.
- **Icon button:** 48 square with a 24px line icon (1.75 stroke).

### Preset tabs
- **Style:** text tabs, 48 tall, 2px underline. Not pills.
- **State:** selected is strong text with a green underline. Others are muted with a clear underline. Exposed as a radio group.
- **Languages:** the Family language picker in Settings reuses the same tabs in a horizontal scroll, labeled in each language's own name.

### Inputs
- **Style:** transparent on the canvas, 1px control-border outline, 8 corners, 56 min height, 16 side padding. Label sits above in secondary.
- **Focus:** the border turns signal green. Selection is green.
- **Error:** error text below the fields.

### Permission rows
Title in strong, detail in muted, trailing state 72 wide and right aligned. "Turn on" is green and opens Android settings. "On" is secondary.

### Message quote
Surface fill, 12 corners, 20 padding, 8 gap. Meta line in muted ("WhatsApp · Mom"), message in quote type. Selectable.

### Live indicator
8px green dot plus 15px green state text in the top bar. Static, no pulse. The same pair marks a family voice recording in Settings, with a one-second timer.

## Do's and Don'ts

### Do:
- **Do** keep one full-width primary action per screen, at the bottom.
- **Do** use sage for structure and signal green for action or live state.
- **Do** keep Stop neutral.
- **Do** ask for confirmation by voice, with a spoken yes/no instruction under the quote.
- **Do** keep touch targets at 48 or more.

### Don't:
- **Don't** add a light theme.
- **Don't** add shadows, gradients, cards, pills, or rules between sections.
- **Don't** add pulsing, shimmering, or spinning animation, including on the live dot.
- **Don't** add confirm buttons to the Confirm state.
- **Don't** use green for decoration or for neutral information.
- **Don't** treat the idle screenshots as proof that Live or Confirm render correctly on device.
