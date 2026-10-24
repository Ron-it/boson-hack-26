import { z } from 'zod';
import { voiceId } from './presets.ts';

/** A recording from the phone and the exact words read in it. Boson requires the transcript. */
export const voiceRequest = z.object({ audio: z.string().min(1), text: z.string().min(1).max(2000) });
// The live API answers with `voice_id`; its OpenAPI spec says `voice`.
const created = z.union([z.object({ voice_id: voiceId }).transform(body => body.voice_id), z.object({ voice: voiceId }).transform(body => body.voice)]);

/** Clones a voice with Boson. The error message is shown on the phone as is. */
export async function createVoice({ audio, text }: z.infer<typeof voiceRequest>, key: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher('https://api.boson.ai/v1/audio/voices', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref_audio: audio, ref_text: text, description: 'Tandem family voice' }),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 400) throw new Error('Boson could not use that recording. Record again somewhere quiet.');
  if (!response.ok) throw new Error('Boson could not make the voice. Try again.');
  const result = created.safeParse(await response.json());
  if (!result.success) throw new Error('Boson returned no voice. Try again.');
  return result.data;
}
