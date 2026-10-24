import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import type { DeviceConnection } from './device.ts';
import { PhoneTask, type TaskStatus } from './task.ts';

const eventSchema = z.object({
  type: z.string(), delta: z.string().optional(), transcript: z.string().optional(),
  response_id: z.string().optional(), item_id: z.string().optional(),
  name: z.string().optional(), call_id: z.string().optional(), arguments: z.string().optional(),
  response: z.object({ status: z.string().optional(), output: z.array(z.object({
    type: z.string(), name: z.string().optional(), call_id: z.string().optional(), arguments: z.string().optional(),
  })).optional() }).optional(),
  error: z.object({ code: z.string().optional() }).optional(),
});
const instructionSchema = z.object({ instruction: z.string().min(1).max(2000) });

const instructions = `You are a concise, friendly voice assistant operating this Android phone.
This prototype supports brightness and Night Light in Android Settings only. Explain that limit when asked for other tasks.
Use set_brightness for an explicit brightness percentage. Use update_phone_task for display navigation and Night Light.
If direct brightness control is blocked by permission, use update_phone_task to adjust it through the Settings UI instead.
When the user corrects an in-progress task, call update_phone_task with the COMPLETE corrected goal, retaining requirements they did not cancel. Speaking pauses phone actions automatically. Acknowledge briefly, then resume only the latest intent through a tool call. Use stop_phone_task for stop/cancel.
The phone UI worker is separate from you. Do not describe an action as completed until the tool or a task update supplies observed evidence. Task started is not task completed.
Never announce made-up phone values or keep chatting over the user. No long preambles.`;

const tools = [
  { type: 'function', name: 'update_phone_task', description: 'Start or replace the display-settings task with the complete latest user goal.', parameters: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'], additionalProperties: false } },
  { type: 'function', name: 'set_brightness', description: 'Set system brightness immediately to a user-requested percentage. Requires the phone brightness permission.', parameters: { type: 'object', properties: { percent: { type: 'number', minimum: 10, maximum: 100 } }, required: ['percent'], additionalProperties: false } },
  { type: 'function', name: 'stop_phone_task', description: 'Stop scheduling phone actions.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];

export const bosonSessionConfiguration = {
  model: 'higgs-realtime-1.5-preview', instructions, output_modalities: ['audio'], tools, tool_choice: 'auto',
  audio: {
    input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: { type: 'server_vad', silence_duration_ms: 450 }, transcription: { model: 'higgs-stt-3.1' } },
    output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'default' },
  },
};

export const bosonRealtimeUrl = `wss://api.boson.ai/v1/realtime?model=${bosonSessionConfiguration.model}`;

export function completionResponse(status: TaskStatus) {
  return { type: 'response.create', response: {
    // Boson replaces the instructions for this response, so retain the session constraints.
    instructions: `${instructions}\n\nPhone task update for ${JSON.stringify(status.goal)}: ${status.state}. ${status.detail}. Briefly report only the observed outcome.`,
  } };
}

export class VoiceSession {
  private boson: WebSocket;
  private task: PhoneTask;
  private closed = false;
  private speaking = false;
  private responseActive = false;
  private lastSpeechAt = 0;
  private revision = 0;
  private calls = new Map<string, { name: string; arguments: string }>();
  private handledCalls = new Set<string>();
  private commands = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private pendingAnnouncement: TaskStatus | undefined;
  private announcementTimer: NodeJS.Timeout | undefined;
  private app: WebSocket;
  private device: DeviceConnection;
  private firstInput = true;
  private firstOutput = true;
  private onDeviceClose = () => this.close('Phone controls disconnected. Stop and reconnect Portal.');

  constructor(app: WebSocket, device: DeviceConnection, environment = process.env) {
    this.app = app;
    this.device = device;
    const key = environment.BOSON_API_KEY;
    if (!key) throw new Error('Boson key is not configured on the server');
    this.task = new PhoneTask(device.phone, status => this.onTaskStatus(status), environment);
    this.boson = new WebSocket(bosonRealtimeUrl, { headers: { Authorization: `Bearer ${key}` } });
    this.boson.on('open', () => this.sendBoson({ type: 'session.update', session: bosonSessionConfiguration }));
    this.boson.on('message', data => {
      try { this.onBosonEvent(eventSchema.parse(JSON.parse(data.toString()))); }
      catch { this.sendApp({ type: 'notice', message: 'An unexpected voice event was ignored.' }); }
    });
    this.boson.on('error', () => this.close('Voice connection failed. Stop and try again.'));
    this.boson.on('close', () => this.close('Voice connection closed.'));
    app.on('message', data => {
      try {
        const event: unknown = JSON.parse(data.toString());
        const audio = z.object({ type: z.literal('input_audio_buffer.append'), audio: z.string().max(100000) }).safeParse(event);
        if (audio.success) {
          if (this.firstInput) { this.firstInput = false; console.log('Voice input audio received'); }
          this.sendBoson(audio.data); return;
        }
        const reply = z.object({ type: z.literal('command_result'), id: z.string(), result: z.unknown() }).safeParse(event);
        if (reply.success) {
          const pending = this.commands.get(reply.data.id);
          if (pending) { clearTimeout(pending.timer); this.commands.delete(reply.data.id); pending.resolve(reply.data.result); }
        }
      } catch { /* Non-protocol messages cannot drive phone actions. */ }
    });
    app.on('close', () => this.close());
    app.on('error', () => this.close());
    device.socket.once('close', this.onDeviceClose);
    console.log('Voice session connected');
  }

  close(message?: string) {
    if (this.closed) return;
    this.closed = true;
    this.device.socket.removeListener('close', this.onDeviceClose);
    this.task.pause('Session ended');
    clearTimeout(this.announcementTimer);
    if (message) this.sendApp({ type: 'notice', message });
    this.boson.close();
    for (const pending of this.commands.values()) { clearTimeout(pending.timer); pending.reject(new Error('Session ended')); }
    this.commands.clear();
    this.app.close();
  }

  private sendApp(event: object) { if (this.app.readyState === WebSocket.OPEN) this.app.send(JSON.stringify(event)); }
  private sendBoson(event: object) { if (this.boson.readyState === WebSocket.OPEN) this.boson.send(JSON.stringify(event)); }

  private onBosonEvent(event: z.infer<typeof eventSchema>) {
    switch (event.type) {
      case 'session.created':
        console.log('Boson voice session ready');
        this.sendApp({ type: 'ready' });
        return;
      case 'input_audio_buffer.speech_started':
        this.speaking = true;
        this.lastSpeechAt = Date.now();
        this.revision++;
        this.pendingAnnouncement = undefined;
        this.task.pause();
        this.sendApp(event);
        return;
      case 'input_audio_buffer.speech_stopped':
        this.speaking = false;
        this.lastSpeechAt = Date.now();
        return;
      case 'response.created': this.responseActive = true; return;
      case 'response.output_audio.delta':
        if (this.firstOutput) { this.firstOutput = false; console.log('Voice output audio received'); }
        this.sendApp(event);
        return;
      case 'response.output_audio_transcript.delta':
      case 'response.output_audio_transcript.done':
      case 'conversation.item.input_audio_transcription.completed':
        this.sendApp(event);
        return;
      case 'response.function_call_arguments.done':
        if (event.call_id && event.name && event.arguments && !this.handledCalls.has(event.call_id)) {
          this.calls.set(event.call_id, { name: event.name, arguments: event.arguments });
        }
        return;
      case 'response.done': {
        this.responseActive = false;
        for (const item of event.response?.output ?? []) {
          if (item.type === 'function_call' && item.call_id && item.name && item.arguments && !this.handledCalls.has(item.call_id)) {
            this.calls.set(item.call_id, { name: item.name, arguments: item.arguments });
          }
        }
        const calls = [...this.calls];
        this.calls.clear();
        const revision = this.revision;
        if (calls.length) void this.finishCalls(calls, revision, event.response?.status === 'completed');
        else this.announceWhenIdle();
        return;
      }
      case 'error':
        console.error('Boson protocol error:', event.error?.code || 'unknown');
        this.sendApp({ type: 'notice', message: 'Boson rejected a voice event. Stop and reconnect.' }); return;
    }
  }

  private async finishCalls(calls: [string, { name: string; arguments: string }][], revision: number, completed: boolean) {
    for (const [callId, call] of calls) {
      if (this.handledCalls.has(callId)) continue;
      this.handledCalls.add(callId);
      console.log('Voice tool:', call.name);
      let output: object;
      try {
        if (!completed || revision !== this.revision || this.speaking || this.closed) throw new Error('Interrupted before the tool could run');
        const raw: unknown = JSON.parse(call.arguments);
        if (call.name === 'stop_phone_task') { this.task.pause('Stopped by request'); output = { status: 'stopped' }; }
        else if (call.name === 'update_phone_task') {
          const { instruction } = instructionSchema.parse(raw);
          await this.command('open_display', {});
          if (revision !== this.revision || this.speaking || this.closed) throw new Error('Request was replaced while opening Settings');
          this.task.start(instruction);
          output = { status: 'started', instruction, note: 'The UI worker is running. Wait for observed results before claiming completion.' };
        } else if (call.name === 'set_brightness') {
          const { percent } = z.object({ percent: z.number().min(10).max(100) }).parse(raw);
          output = z.record(z.string(), z.unknown()).parse(await this.command('set_brightness', { percent }));
        } else throw new Error('Unsupported tool');
      } catch (error) { output = { status: 'blocked', reason: error instanceof Error ? error.message : 'Tool failed' }; }
      this.sendBoson({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) } });
    }
    if (!this.closed && revision === this.revision && !this.speaking && !this.responseActive) {
      this.responseActive = true;
      this.sendBoson({ type: 'response.create' });
    }
  }

  private command(name: string, args: object): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.commands.delete(id); reject(new Error('The phone did not acknowledge the command')); }, 5000);
      this.commands.set(id, { resolve, reject, timer });
      this.sendApp({ type: 'command', id, name, args });
    });
  }

  private onTaskStatus(status: TaskStatus) {
    console.log('Phone task:', status.state, 'revision:', status.revision);
    this.sendApp(status);
    if (status.state === 'completed' || status.state === 'blocked') {
      this.pendingAnnouncement = status;
      this.announceWhenIdle();
    }
  }

  private announceWhenIdle() {
    clearTimeout(this.announcementTimer);
    if (!this.pendingAnnouncement || this.closed) return;
    if (this.speaking || this.responseActive || Date.now() - this.lastSpeechAt < 1200) {
      this.announcementTimer = setTimeout(() => this.announceWhenIdle(), 500);
      return;
    }
    const status = this.pendingAnnouncement;
    this.pendingAnnouncement = undefined;
    this.responseActive = true;
    this.sendBoson(completionResponse(status));
  }
}
