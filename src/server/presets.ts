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

/** Languages a family voice can be set up in. The phone keeps the choice and sends it with each session. */
export const familyLanguage = z.enum(['hi', 'en', 'es', 'fr', 'de', 'zh']);
export type FamilyLanguage = z.infer<typeof familyLanguage>;
const languageNames: Record<FamilyLanguage, string> = { hi: 'Hindi', en: 'English', es: 'Spanish', fr: 'French', de: 'German', zh: 'Mandarin Chinese' };
const manners: Partial<Record<FamilyLanguage, string>> = {
  hi: 'Use respectful forms: "aap", "ji". Never call them "beta". Short reassurances like "bas ek second" or "ho raha hai" fit well.',
};
/** A cloned Boson voice. Boson closes the session on an unknown voice, so anything else is dropped. */
export const voiceId = z.string().regex(/^voice_[A-Za-z0-9_-]+$/);

/** Family speaks one language, in the helper's cloned voice when the phone has one. */
export function familyPreset(language: FamilyLanguage = 'hi', voice = process.env.FAMILY_VOICE?.trim() || 'default'): Preset {
  const name = languageNames[language];
  return {
    silenceMs: 900,
    voice,
    // Boson Realtime takes delivery (tone, pace, energy) from the instructions, not a parameter.
    style: `The user may be an older parent or grandparent who is not confident with phones.
Always speak ${name}, even when the user speaks another language or a task update arrives in English. Use simple everyday spoken ${name}, the way family talks at home, not formal or textbook ${name}. Keep contact names, app names and message text exactly as the user said them.
Sound warm, gentle and caring, with a smile in your voice, like a loving grandchild helping their grandparent. Let your voice rise and fall naturally; never sound flat or robotic. Speak a little slowly, with short pauses between ideas.
Address them respectfully, without pet names or family titles. ${manners[language] ?? ''}
Reassure them in a few kind words while something takes a moment. When it is done, say what happened in one simple, happy sentence.
If they sound confused or repeat themselves, do not repeat your question word for word: rephrase it more simply, or offer to show them how.`,
  };
}
export type PresetName = z.infer<typeof presetName>;

export const presets: Record<PresetName, Preset> = {
  quick: { style: '', silenceMs: 450, voice: 'default' },
  family: familyPreset(),
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

/** The session's preset from its query. Malformed Family settings fall back to Hindi and the server's voice. */
export function sessionPreset(query: URLSearchParams): Preset {
  const name = parsePreset(query.get('preset'));
  if (name !== 'family') return presets[name];
  return familyPreset(familyLanguage.catch('hi').parse(query.get('language')), voiceId.safeParse(query.get('voice')).data);
}
