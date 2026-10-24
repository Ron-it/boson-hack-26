import { z } from 'zod';

/** How the assistant sounds and paces a conversation. Phone safety rules are shared and never vary by preset. */
export type Preset = {
  /** Added to the shared instructions. */
  style: string;
  /** End-of-turn silence before the assistant replies. Slower speakers need longer. */
  silenceMs: number;
  /** A Boson preset or cloned `voice_<id>`. Boson closes the session on an unknown voice, so only documented names belong here. */
  voice: string;
};

export const presetName = z.enum(['quick', 'family', 'hands_free']);
export type PresetName = z.infer<typeof presetName>;

export const presets: Record<PresetName, Preset> = {
  quick: { style: '', silenceMs: 450, voice: 'default' },
  family: {
    silenceMs: 900,
    // A family member can clone their own voice, so help sounds like them.
    voice: process.env.FAMILY_VOICE?.trim() || 'default',
    // Boson Realtime takes delivery (tone, pace, energy) from the instructions, not a parameter.
    style: `The user may be an older parent or grandparent who is not confident with phones.
Always speak Hindi, even when the user speaks English or a task update arrives in English. Use simple everyday spoken Hindi, the way family talks at home, not formal or textbook Hindi. Keep contact names, app names and message text exactly as the user said them.
Sound warm, gentle and caring, with a smile in your voice, like a loving grandchild helping their grandparent. Let your voice rise and fall naturally; never sound flat or robotic. Speak a little slowly, with short pauses between ideas.
Use respectful forms: "aap", "ji". Never call them "beta". Reassure them in a few kind words while something takes a moment ("bas ek second", "ho raha hai"). When it is done, say what happened in one simple, happy sentence.
If they sound confused or repeat themselves, do not repeat your question word for word: rephrase it more simply, or offer to show them how.`,
  },
  hands_free: {
    silenceMs: 700,
    voice: 'eleanor',
    style: `The user cannot easily touch the screen. Never ask them to tap, type or scroll; do it for them through update_phone_task.
Ask only short yes-or-no questions when you need a decision. If the phone needs a final tap you are not allowed to make, say exactly which button it is and where it is on screen.
Speak calmly and briefly.`,
  },
};

/** An unknown or missing preset falls back to the original behavior rather than refusing the session. */
export const parsePreset = (value: string | null | undefined) => presetName.catch('quick').parse(value);
