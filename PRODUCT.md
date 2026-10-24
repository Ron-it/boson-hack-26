# Product

<!-- impeccable:product-schema 1 -->

## Platform

android

## Stack

Delegated by Ronit: Expo and TypeScript for the interface, a local Kotlin module for foreground audio, and a hosted Node controller.

## Users

The immediate user is Ronit testing a voice-operated Android phone. A narrower audience is deliberately undecided. Older adults and ride booking were brainstorming examples.

## Product Purpose

Prove that a person can speak to the phone, see real settings change, and correct the task while it runs. The final demo must work without a laptop connection.

## Operating Context

One real Pixel phone, Boson Higgs Realtime voice, and Mobilerun Portal accessibility control. The first slice changes brightness and Night Light. The voice session must stay alive when Android Settings is in front.

## Capabilities and Constraints

Phone control is restricted to Settings for this experiment. Start and stop must be explicit. Speech pauses new actions; a corrected goal supersedes pending decisions. Completion requires observed values. Calendar, Gmail, ride booking, learned workflows, and a final product story remain open.

## Evidence on Hand

The local model comparison and private device traces establish Settings navigation and observed toggles. Live voice and unplugged operation are not yet proven.

## Product Principles

- Prove the full interaction on the actual phone.
- Keep the first slice small.
- Prefer native shortcuts where their result can be verified.
- Show current state and recoverable errors plainly.

## Brand Commitments

No final product name or identity has been chosen. Use a restrained Android utility screen, minimal copy, no decorative cards or pills, and no continuous animations.
