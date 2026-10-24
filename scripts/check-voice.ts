import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { z } from 'zod';
import { bosonRealtimeUrl, bosonSessionConfiguration, completionResponse } from '../src/server/voice.ts';

const eventSchema = z.object({
  type: z.string(), delta: z.string().optional(),
  session: z.object({ model: z.string(), audio: z.object({ output: z.object({ format: z.object({ type: z.string(), rate: z.number() }) }) }) }).optional(),
  response: z.object({ status: z.string(), output: z.array(z.object({ type: z.string(), call_id: z.string().optional(), name: z.string().optional() })).optional() }).optional(),
  error: z.object({ code: z.string().optional(), type: z.string().optional() }).optional(),
});

async function main() {
  const key = process.env.BOSON_API_KEY;
  if (!key) throw new Error('Set BOSON_API_KEY in the private .env file');
  const socket = new WebSocket(bosonRealtimeUrl, { headers: { Authorization: `Bearer ${key}` } });
  let model = '';
  let stage: 'tool' | 'announcement' = 'tool';
  let bytes = 0;
  const started = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Voice protocol check timed out')), 20_000);
      const finish = (error?: Error) => { clearTimeout(timeout); error ? reject(error) : resolve(); };
      socket.once('error', () => finish(new Error('Voice transport failed')));
      socket.once('close', () => finish(new Error('Voice connection closed before the check finished')));
      socket.once('open', () => socket.send(JSON.stringify({ type: 'session.update', session: bosonSessionConfiguration() })));
      socket.on('message', data => {
        try {
          const event = eventSchema.parse(JSON.parse(data.toString()));
          if (event.type === 'error') throw new Error(`Boson protocol error: ${event.error?.code || event.error?.type || 'unknown'}`);
          if (event.type === 'session.created') {
            assert.ok(event.session);
            model = event.session.model;
            assert.equal(model, 'higgs-realtime-1.5-preview');
            assert.deepEqual(event.session.audio.output.format, { type: 'audio/pcm', rate: 24000 });
            socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'This is a synthetic protocol check. Call stop_phone_task exactly once now. No phone is connected to this test.' }] } }));
            socket.send(JSON.stringify({ type: 'response.create' }));
          }
          if (event.type === 'response.output_audio.delta' && event.delta) bytes += Buffer.from(event.delta, 'base64').length;
          if (event.type === 'response.done') {
            assert.equal(event.response?.status, 'completed');
            if (stage === 'tool') {
              const call = event.response.output?.find(item => item.type === 'function_call' && item.name === 'stop_phone_task');
              assert.ok(call?.call_id, 'Expected a real function call from the preview model');
              stage = 'announcement';
              socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify({ status: 'stopped', synthetic: true }) } }));
              socket.send(JSON.stringify(completionResponse({ type: 'task', state: 'completed', goal: 'Synthetic protocol check only', detail: 'The diagnostic tool was acknowledged. No phone setting was changed. Say only that the protocol check passed.', revision: 0 })));
            } else { assert.ok(bytes > 0, 'Expected audio output from the preview model'); finish(); }
          }
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid voice event')); }
      });
    });
    const result = { model, pcmRate: 24000, toolRoundTrip: 'PASS', completionAnnouncement: 'PASS', audioSeconds: bytes / 48000, elapsedMs: Math.round(performance.now() - started), scope: 'Synthetic protocol check; no microphone or phone actions' };
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/voice-protocol-check.json', JSON.stringify(result, null, 2));
    console.log(result);
  } finally { socket.close(); }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Voice check failed'); process.exitCode = 1; });
