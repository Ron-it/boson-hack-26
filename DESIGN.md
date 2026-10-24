---
name: Phone voice
description: Restrained Android utility interface for explicit voice control.
colors:
  light-surface: "#F4F8F5"
  light-text: "#142D28"
  light-secondary: "#47645B"
  light-primary: "#006B55"
  light-on-primary: "#FFFFFF"
  light-input: "#E4EEE7"
  light-error: "#A32225"
  dark-surface: "#10251F"
  dark-text: "#E2F2E7"
  dark-secondary: "#ADCABB"
  dark-primary: "#7BDBB5"
  dark-on-primary: "#00382A"
  dark-input: "#203C31"
  dark-error: "#FFB4AB"
typography:
  headline:
    fontSize: "32px"
    lineHeight: "40px"
    fontWeight: 500
  title:
    fontSize: "28px"
    lineHeight: "36px"
    fontWeight: 600
  body:
    fontSize: "17px"
    lineHeight: "26px"
  supporting:
    fontSize: "16px"
    lineHeight: "24px"
  button:
    fontSize: "16px"
    lineHeight: "24px"
    fontWeight: 600
  label:
    fontSize: "14px"
    lineHeight: "20px"
    fontWeight: 600
  caption:
    fontSize: "13px"
    lineHeight: "20px"
  input:
    fontSize: "16px"
rounded:
  input: "4px"
  button: "8px"
spacing:
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  "32": "32px"
  "48": "48px"
components:
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "16px 24px"
  button-primary-dark:
    backgroundColor: "{colors.dark-primary}"
    textColor: "{colors.dark-on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.button}"
    padding: "16px 24px"
  button-text-light:
    textColor: "{colors.light-primary}"
    typography: "{typography.button}"
    padding: "12px 0"
  button-text-dark:
    textColor: "{colors.dark-primary}"
    typography: "{typography.button}"
    padding: "12px 0"
  input-light:
    backgroundColor: "{colors.light-input}"
    textColor: "{colors.light-text}"
    typography: "{typography.input}"
    rounded: "{rounded.input}"
  input-dark:
    backgroundColor: "{colors.dark-input}"
    textColor: "{colors.dark-text}"
    typography: "{typography.input}"
    rounded: "{rounded.input}"
---

# Design System: Phone voice

## Overview

**Creative North Star: "Restrained Android utility"**

This is the implemented utility direction from PRODUCT.md, not a final product identity. A flat green surface, plain system text, and a single filled action keep the interface direct. Status and controls carry the visual hierarchy; decoration does not.

The source of truth is `mobile/App.tsx`. The light, dark, and enlarged-text Pixel captures in `.impeccable/review/` support the visual review disposition of SHIP. They establish the rendered idle interface, not acceptance of live voice, correction timing, or speaker echo cancellation.

**Key Characteristics:**
- One scrolling column with native safe areas and scalable text.
- Coordinated light and dark semantic roles.
- Filled primary action, plain text actions, and tonal input fields.
- Minimal copy, no decorative cards or pills, and no continuous animation.

## Colors

Green runs through both schemes, with a darker action in light mode and a pale mint action in dark mode. The frontmatter records every role exactly as defined in the source `schemes` object.

### Primary

- **Deep green / pale mint** (`light-primary`, `dark-primary`): filled actions and text actions.
- **White / dark green action text** (`light-on-primary`, `dark-on-primary`): text on the filled action.

### Neutral

- **Pale green / forest surface** (`light-surface`, `dark-surface`): the full app background.
- **Dark green / pale green text** (`light-text`, `dark-text`): title, session state, request, transcript, and field labels.
- **Muted green / soft sage supporting text** (`light-secondary`, `dark-secondary`): explanation, disclosure, progress, and placeholders. This is a text role, not a second accent.
- **Light / dark tonal input fill** (`light-input`, `dark-input`): connection fields without decorative outlines.

The error roles (`light-error`, `dark-error`) identify recoverable problems in body text.

**The Paired Roles Rule.** Switch the complete scheme with the device appearance; retain the matching on-primary text when changing the action fill.

## Typography

**Font:** Native Android system font. The implementation sets no font family, tracking, or custom display face. Unspecified weights and input line height remain platform defaults.

The frontmatter uses `px` for portable previews. In React Native, the corresponding numeric layout values are logical units and text follows native font scaling. The eight role names map directly to source styles; this is a functional ramp rather than a geometric scale.

### Hierarchy

- **Headline:** the largest role, used for current session state.
- **Title:** the app title, smaller than the session headline and slightly heavier.
- **Body:** instructions, requests, progress, transcript, and errors.
- **Supporting:** the short introductory sentence.
- **Button:** primary and text action labels, centered only on filled actions.
- **Label:** field labels and identifiers for request and transcript content.
- **Caption:** the audio and agent disclosure.
- **Input:** editable connection values with native line metrics.

**The Native Scaling Rule.** Let text wrap and the page scroll as the system text setting grows; the build does not truncate these roles or impose fixed text containers.

## Layout

A single flex-growing ScrollView uses a shared horizontal inset (`spacing.24`). There is no breakpoint, width cap, alternate grid, or app-owned navigation bar. Android Back remains native.

Safe-area padding is computed at runtime: top inset plus 20 logical units, bottom inset plus `spacing.24`. KeyboardAvoidingView uses height adjustment, and taps remain handled while the keyboard is visible. Status-bar content switches with the scheme.

The introductory line starts after `spacing.8`. The session group starts after `spacing.48`, uses `spacing.12` between its text, and ends with `spacing.24`. Subsequent sections use `spacing.32` above and `spacing.8` within. Fields add `spacing.16` above. The assistant transcript label also receives `spacing.16` above. Primary actions and disclosure use `spacing.12` above.

## Elevation & Depth

There are no shadows, elevation values, gradients, borders, or section rules in the app styles. Input fill and the solid primary action provide the tonal separation; other content stays on the shared surface. The native system status and gesture areas are not app-owned components.

**The Flat Utility Rule.** Separate content with spacing and text hierarchy; preserve the confirmed absence of decorative cards, pills, and section rules.

## Shapes

Controls have modest corners: the filled button uses `rounded.button`, while fields use the tighter `rounded.input`. Content sections have no enclosing shape. The filled button has a minimum height of 56 logical units and can grow with its label; text actions have a minimum height of 48. Inputs also have a minimum height of 56. These are minimums, not fixed-height tokens.

## Components

### Buttons

The filled action is full column width, center aligned, and uses the active scheme's primary and on-primary pair. Padding and radius come from the component tokens. Start changes to Stop during a session. The Start/Stop Pressable uses opacity 0.75 while pressed and 0.45 when unconfigured; it is disabled when unconfigured and inactive. Save connection shares the filled style but has no custom pressed-opacity callback.

Permission and connection actions are left-aligned text in the primary color. They use vertical padding (`spacing.12`) and no decorative container. The source defines no custom hover or focus styling; native platform behavior applies. There are no animated state transitions.

### Inputs / Fields

Connection fields use the scheme's input fill, text role, secondary placeholder role, and input radius. Horizontal padding is `spacing.16`; vertical text metrics remain native. Each field has a visible label and accessibility label. The address field uses URL entry without capitalization or correction. The pairing field masks its value. Connection setup is a disclosure that closes after saving.

### Session and transcript

The session state is a polite live region with a headline and supporting body. Errors use the error color and an alert role. Request and transcript groups remain plain text on the surface. Transcript content is selectable. Group labels describe actual content; they are not decorative kickers.

The sidecar provides HTML/CSS previews of the two button variants and input in each scheme. These translate native styles for inspection; browser system fonts and default focus indicators are preview adapters, not additional Android tokens. No tonal ramps, shadow tokens, motion timings, or breakpoints are inferred.

## Do's and Don'ts

### Do:

- **Do** use the complete light or dark role set, including its on-primary text.
- **Do** preserve native text scaling, wrapping, scrolling, and safe-area padding.
- **Do** retain minimum touch heights while allowing content to grow.
- **Do** show status and recoverable errors as readable text.

### Don't:

- **Don't** add decorative cards, pills, or section rules.
- **Don't** add continuous animation.
- **Don't** turn this utility direction into a final brand or audience commitment.
- **Don't** treat idle screenshots as proof of live voice acceptance.
