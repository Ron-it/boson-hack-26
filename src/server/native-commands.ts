import { z } from 'zod';

const empty = z.strictObject({});
export const nativeCommandSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('open_display'), args: empty }),
  z.strictObject({ name: z.literal('read_brightness'), args: empty }),
  z.strictObject({ name: z.literal('set_brightness'), args: z.strictObject({ percent: z.number().min(10).max(100) }) }),
  z.strictObject({ name: z.literal('resolve_handler'), args: z.strictObject({ target: z.enum(['timer', 'alarm', 'display']) }) }),
  z.strictObject({ name: z.literal('create_alarm'), args: z.strictObject({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), label: z.string().max(120) }) }),
  z.strictObject({ name: z.literal('create_timer'), args: z.strictObject({ seconds: z.number().int().min(1).max(86400), label: z.string().max(120) }) }),
  z.strictObject({ name: z.literal('read_media_volume'), args: empty }),
  z.strictObject({ name: z.literal('set_media_volume'), args: z.strictObject({ percent: z.number().min(0).max(100) }) }),
]);
export type NativeCommandRequest = z.infer<typeof nativeCommandSchema>;
export type NativeTransport = (name: string, args: Record<string, string | number | boolean>) => Promise<unknown>;
const volume = z.object({ stream: z.literal('media'), observedIndex: z.number().int().nonnegative(), minIndex: z.number().int().nonnegative(), maxIndex: z.number().int().nonnegative() }).refine(value => value.minIndex <= value.maxIndex && value.observedIndex >= value.minIndex && value.observedIndex <= value.maxIndex, 'Invalid Android volume range');
const volumeRead = volume.safeExtend({ status: z.literal('observed') });
const volumeWrite = volume.safeExtend({ status: z.literal('completed'), requestedPercent: z.number().min(0).max(100), requestedIndex: z.number().int().nonnegative() });
const blocked = z.object({ status: z.literal('blocked'), reason: z.string() });

/** Protocol adapter only. The operator must own revision, confirmation and serialization. */
export async function executeNativeCommand(input: NativeCommandRequest, transport: NativeTransport) {
  const command = nativeCommandSchema.parse(input);
  let raw: unknown;
  try { raw = await transport(command.name, command.args); }
  catch { return { status: 'unknown' as const, reason: 'Native command was not acknowledged. Inspect the phone before retrying.' }; }
  const uncertain = z.object({ status: z.literal('unknown'), reason: z.string() }).safeParse(raw);
  if (uncertain.success) return uncertain.data;
  const denial = blocked.safeParse(raw);
  if (denial.success) return denial.data;
  switch (command.name) {
    case 'resolve_handler': return z.object({ status: z.literal('observed'), available: z.boolean(), handlerPackage: z.string().optional() }).parse(raw);
    case 'create_alarm':
    case 'create_timer': return z.object({ status: z.literal('handoff'), handlerPackage: z.string().min(1), note: z.string() }).parse(raw);
    case 'read_media_volume': return volumeRead.parse(raw);
    case 'set_media_volume': {
      const result = volumeWrite.parse(raw);
      if (result.requestedPercent !== command.args.percent || result.requestedIndex !== result.observedIndex || result.requestedIndex !== Math.floor(result.minIndex + command.args.percent / 100 * (result.maxIndex - result.minIndex) + 0.5)) throw new Error('Media volume outcome is not established by matching Android readback');
      return result;
    }
    case 'read_brightness': return z.object({ status: z.literal('observed'), observedRawValue: z.number().int() }).parse(raw);
    case 'set_brightness': return z.object({ status: z.literal('completed'), requestedPercent: z.number(), observedRawValue: z.number().int(), note: z.string().optional() }).parse(raw);
    case 'open_display': return z.object({ status: z.literal('opened') }).parse(raw);
  }
}

/** Effects are conservative: all mutations still enter the operator's shared sequence. */
export const nativeCapabilities = {
  open_display: { permissions: [], effect: 'screen', resultCheck: 'opened_only' },
  read_brightness: { permissions: [], effect: 'read', resultCheck: 'native_readback' },
  set_brightness: { permissions: ['android.permission.WRITE_SETTINGS'], effect: 'setting', resultCheck: 'native_readback' },
  read_media_volume: { permissions: [], effect: 'read', resultCheck: 'native_readback' },
  set_media_volume: { permissions: ['android.permission.MODIFY_AUDIO_SETTINGS'], effect: 'setting', resultCheck: 'native_readback' },
  resolve_handler: { permissions: [], effect: 'read', resultCheck: 'handler_availability' },
  create_timer: { permissions: ['com.android.alarm.permission.SET_ALARM'], effect: 'screen_and_app_mutation', resultCheck: 'observe_clock_required' },
  create_alarm: { permissions: ['com.android.alarm.permission.SET_ALARM'], effect: 'screen_and_app_mutation', resultCheck: 'observe_clock_required' },
} satisfies Record<NativeCommandRequest['name'], { permissions: string[]; effect: 'read' | 'setting' | 'screen' | 'screen_and_app_mutation'; resultCheck: 'native_readback' | 'opened_only' | 'handler_availability' | 'observe_clock_required' }>;
