import { z } from 'zod';

/**
 * What the app's native module does that Portal cannot in one call: Clock intents carry extras Portal's deep links
 * cannot, and exact volume or brightness would otherwise take several screen steps. Everything else goes through Portal.
 */
export const nativeCommandSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('set_brightness'), args: z.strictObject({ percent: z.number().min(10).max(100) }) }),
  z.strictObject({ name: z.literal('create_alarm'), args: z.strictObject({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), label: z.string().max(120) }) }),
  z.strictObject({ name: z.literal('create_timer'), args: z.strictObject({ seconds: z.number().int().min(1).max(86400), label: z.string().max(120) }) }),
  z.strictObject({ name: z.literal('set_media_volume'), args: z.strictObject({ percent: z.number().min(0).max(100) }) }),
]);
export type NativeCommandRequest = z.infer<typeof nativeCommandSchema>;
export type NativeTransport = (name: string, args: Record<string, string | number | boolean>) => Promise<unknown>;

const blocked = z.object({ status: z.literal('blocked'), reason: z.string() });
const succeeded = {
  set_brightness: z.object({ status: z.literal('completed') }),
  set_media_volume: z.object({ status: z.literal('completed') }),
  create_alarm: z.object({ status: z.literal('handoff') }),
  create_timer: z.object({ status: z.literal('handoff') }),
} satisfies Record<NativeCommandRequest['name'], z.ZodType>;

/** Protocol adapter only. The operator owns revision, confirmation and serialization; an unacknowledged write is unknown. */
export async function executeNativeCommand(input: NativeCommandRequest, transport: NativeTransport): Promise<{ status: 'completed' } | { status: 'blocked'; reason: string } | { status: 'unknown' }> {
  const command = nativeCommandSchema.parse(input);
  let raw: unknown;
  try { raw = await transport(command.name, command.args); }
  catch { return { status: 'unknown' }; }
  const denial = blocked.safeParse(raw);
  if (denial.success) return denial.data;
  return succeeded[command.name].safeParse(raw).success ? { status: 'completed' } : { status: 'unknown' };
}
