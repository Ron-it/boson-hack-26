import { z } from 'zod';
import type { NativeCommandRequest } from './native-commands.ts';

export const timerRequestSchema = z.strictObject({ seconds: z.number().int().min(1).max(86400).optional(), label: z.string().max(120).default('') });
export const alarmRequestSchema = z.strictObject({
  hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59).optional(),
  period: z.enum(['am', 'pm', '24h']).optional(), occurrence: z.literal('next').optional(),
  label: z.string().max(120).default(''),
});
export type ClockCommand = Extract<NativeCommandRequest, { name: 'create_timer' | 'create_alarm' }>;
export type ClockProposal = { id: string; operation: 'create_timer' | 'create_alarm'; app: 'Clock'; handlerPackage: string | undefined; command: ClockCommand; detail: string; recipient?: never; message?: never };

/** No natural-language time guessing. Missing scheduling intent remains a user question. */
export function clockRequest(request: { timer?: z.infer<typeof timerRequestSchema> | undefined; alarm?: z.infer<typeof alarmRequestSchema> | undefined }): { command: ClockCommand; detail: string } | { question: string } | undefined {
  if (request.timer && request.alarm) return { question: 'Should I create a timer or an alarm first?' };
  if (request.timer) {
    if (request.timer.seconds === undefined) return { question: 'How long should the timer run?' };
    const command = { name: 'create_timer', args: { seconds: request.timer.seconds, label: request.timer.label } } as const;
    return { command, detail: `Create a ${command.args.seconds} seconds timer${command.args.label ? ` named ${JSON.stringify(command.args.label)}` : ''}?` };
  }
  if (request.alarm) {
    const { hour, minute, period, occurrence, label } = request.alarm;
    if (hour === undefined || minute === undefined) return { question: 'What hour and minute should the alarm use?' };
    if (period === undefined) return { question: 'Is that AM or PM, in the phone’s local time?' };
    if (period !== '24h' && (hour < 1 || hour > 12)) return { question: 'What time do you mean, including AM or PM?' };
    if (occurrence !== 'next') return { question: 'Should this alarm use the next occurrence of that time on the phone? Date-specific or repeating alarms need the Clock app.' };
    const localHour = period === '24h' ? hour : hour % 12 + (period === 'pm' ? 12 : 0);
    const command = { name: 'create_alarm', args: { hour: localHour, minute, label } } as const;
    return { command, detail: `Create an alarm for the next ${String(localHour).padStart(2, '0')}:${String(minute).padStart(2, '0')} in the phone’s local time${label ? ` named ${JSON.stringify(label)}` : ''}?` };
  }
}
