import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bosonSessionConfiguration, completionResponse, presetInstructions } from '../src/server/voice.ts';
import { parsePreset, presets } from '../src/server/presets.ts';

test('task completion uses a supported Boson response instruction instead of a rejected system message', () => {
  const event = completionResponse({ type: 'task', state: 'completed', goal: 'Leave Night Light off', detail: 'Observed Night Light OFF', revision: 2 });
  assert.equal(event.type, 'response.create', 'Boson rejects system-role conversation items; use per-response instructions');
  assert.match(event.response.instructions, /Observed Night Light OFF/);
  assert.match(event.response.instructions, /Do not describe an action as completed until/);
});

import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { VoiceSession } from '../src/server/voice.ts';
import { DeviceConnection } from '../src/server/device.ts';

async function socketPair() {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Missing test address');
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const opened = once(client, 'open');
  const [peer] = await connected;
  await opened;
  return { client, peer: peer as WebSocket, close: () => { client.terminate(); (peer as WebSocket).terminate(); server.close(); } };
}

test('a voice response begun before speech cannot dispatch a late native tool', async () => {
  const app = await socketPair();
  const device = await socketPair();
  const voice = await socketPair();
  const commands: string[] = [];
  app.client.on('message', data => { commands.push(data.toString()); });
  const session = new VoiceSession(app.peer, new DeviceConnection(device.peer, 'synthetic-phone'), { BOSON_API_KEY: 'synthetic' }, { voiceSocket: voice.peer, selector: { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) } });
  try {
    voice.client.send(JSON.stringify({ type: 'response.created', response: { id: 'old' } }));
    voice.client.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    voice.client.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
    voice.client.send(JSON.stringify({ type: 'response.done', response: { id: 'old', status: 'completed', output: [{ type: 'function_call', name: 'quick_phone_action', call_id: 'old-call', arguments: '{"action":"home"}' }] } }));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(commands.some(event => JSON.parse(event).type === 'command'), false);
  } finally { session.close(); app.close(); device.close(); voice.close(); }
});

test('late argument events from an interrupted response cannot attach to a new response', async () => {
  const app = await socketPair();
  const device = await socketPair();
  const voice = await socketPair();
  const commands: string[] = [];
  app.client.on('message', data => { commands.push(data.toString()); });
  const session = new VoiceSession(app.peer, new DeviceConnection(device.peer, 'synthetic-phone'), { BOSON_API_KEY: 'synthetic' }, { voiceSocket: voice.peer, selector: { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) } });
  try {
    for (const event of [
      { type: 'response.created', response: { id: 'old' } },
      { type: 'input_audio_buffer.speech_started' },
      { type: 'input_audio_buffer.speech_stopped' },
      { type: 'response.created', response: { id: 'new' } },
      { type: 'response.function_call_arguments.done', response_id: 'old', name: 'quick_phone_action', call_id: 'late', arguments: '{"action":"home"}' },
      { type: 'response.done', response: { id: 'new', status: 'completed' } },
    ]) voice.client.send(JSON.stringify(event));
    await new Promise(resolve => setTimeout(resolve, 80));
    // No device observation or native mutation should be scheduled for the old request.
    assert.equal(commands.some(event => JSON.parse(event).type === 'task'), false);
  } finally { session.close(); app.close(); device.close(); voice.close(); }
});

test('blocked Settings announcement gives the recovery instruction without a generic greeting', () => {
  const event = completionResponse({ type: 'task', state: 'blocked', goal: 'Turn Night Light on', detail: "I couldn't open Settings. Open Display settings, then say continue.", revision: 5 });
  assert.match(event.response.instructions, /Tell the user this task feedback in their language/);
  assert.match(event.response.instructions, /Open Display settings, then say continue/);
  assert.match(event.response.instructions, /Do not greet/);
});


import { harness, mediaVolume, quietScreen } from './fixtures.ts';

test('a blocked task waits for real user speech; pause holds a correction until an explicit continue', async () => {
  let allow = false;
  let writes = 0;
  const h = await harness(quietScreen, {
    selector: { decide: async () => allow ? mediaVolume().decide() : { actionId: 'blocked', text: 'Nothing here can do that.', confidence: null, returnedModel: null } },
    native: async () => { writes++; return { status: 'completed' }; },
  });
  const task = () => h.appEvents.filter(event => event.type === 'task').at(-1);
  try {
    await h.call('update_phone_task', { instruction: 'Media volume 40%' });
    await h.until(() => task()?.state === 'blocked' || undefined, 'blocked task');
    assert.equal(task()?.detail, 'Nothing here can do that.');
    // The voice model resubmitting or continuing on its own, without the user speaking, is not a new request.
    assert.equal((await h.call('update_phone_task', { instruction: 'Try again' }) as { status: string }).status, 'retained');
    assert.equal((await h.call('continue_phone_task', {}) as { status: string }).status, 'retained');
    h.speak();
    await h.call('pause_phone_task', {});
    h.speak();
    await h.call('update_phone_task', { instruction: 'Actually media volume 40% now' });
    await h.until(() => task()?.awaitingContinue || undefined, 'correction held by the pause');
    assert.equal(writes, 0);
    allow = true;
    h.speak();
    await h.call('continue_phone_task', {});
    await h.until(() => task()?.state === 'completed' || undefined, 'completion after continue');
    assert.equal(task()?.detail, 'Media volume is at 40%.');
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test('accepted async work waits for observed outcome instead of starting an idle voice reply', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  const journey = await harness(quietScreen, { selector: mediaVolume(), native: async () => { writes++; await gate.promise; return { status: 'completed' }; } });
  try {
    await journey.call('update_phone_task', { instruction: 'Media volume 40%' });
    await journey.until(() => writes === 1 ? true : undefined, 'pending native operation');
    assert.equal(journey.announcements.length, 0, 'acceptance must not request an idle response before the result');
    journey.provider({ type: 'response.created', response: { id: 'unowned' } });
    journey.provider({ type: 'response.output_audio_transcript.done', response_id: 'unowned', transcript: 'How can I help you with your phone today?' });
    journey.provider({ type: 'response.output_audio.delta', response_id: 'unowned', delta: 'synthetic' });
    journey.provider({ type: 'response.done', response: { id: 'unowned', status: 'completed', output: [] } });
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(journey.appEvents.some(event => event.response_id === 'unowned'), false, 'unowned speech while work is pending is not played');
    gate.resolve();
    await journey.until(() => journey.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'fresh observed outcome');
    await journey.until(() => journey.announcements.length === 1 ? true : undefined, 'one result announcement');
    assert.match(journey.announcements[0] ?? '', /Media volume is at 40%/);
    assert.match(JSON.stringify(journey.responseRequests[0]?.input), /Media volume is at 40%/, 'the response has explicit grounded input, not only instructions');
    assert.equal(writes, 1);
  } finally { gate.resolve(); await journey.close(); }
});

test('a new intentional user question can speak while old task audio and late completion are ignored', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  const h = await harness(quietScreen, { selector: mediaVolume(), native: async () => { writes++; await gate.promise; return { status: 'unknown', reason: 'Synthetic interruption' }; } });
  try {
    await h.call('update_phone_task', { instruction: 'Media volume 40%' });
    await h.until(() => writes === 1 ? true : undefined, 'native dispatch');
    h.provider({ type: 'response.created', response: { id: 'old-pending' } });
    h.speak();
    h.provider({ type: 'response.created', response: { id: 'intentional-question' } });
    h.provider({ type: 'response.done', response: { id: 'old-pending', status: 'completed' } });
    h.provider({ type: 'response.output_audio_transcript.done', response_id: 'intentional-question', transcript: 'The time is shown in the status bar.' });
    h.provider({ type: 'response.output_audio.delta', response_id: 'intentional-question', delta: 'answer' });
    h.provider({ type: 'response.output_audio.delta', response_id: 'old-pending', delta: 'late' });
    await h.until(() => h.appEvents.find(event => event.response_id === 'intentional-question' && event.type === 'response.output_audio.delta'), 'intentional answer audio');
    assert.equal(h.appEvents.some(event => event.response_id === 'old-pending'), false);
    assert.equal(h.appEvents.some(event => event.type === 'task' && event.state === 'paused'), false, 'speech does not pause phone work');
    h.provider({ type: 'response.done', response: { id: 'intentional-question', status: 'completed' } });
    h.provider({ type: 'response.output_audio.delta', response_id: 'intentional-question', delta: 'after-done' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.appEvents.filter(event => event.type === 'response.output_audio.delta').length, 1);
    assert.equal(writes, 1);
  } finally { gate.resolve(); await h.close(); }
});


test('a missing voice response completion becomes a visible unknown without replaying the action', async () => {
  let writes = 0;
  const h = await harness(quietScreen, { selector: mediaVolume(), holdResponses: true, responseDeadlineMs: 80, native: async () => { writes++; return { status: 'completed' }; } });
  try {
    await h.call('update_phone_task', { instruction: 'Media volume 40%' });
    await h.until(() => h.appEvents.find(event => event.type === 'voice_issue' && event.state === 'unknown'), 'voice timeout issue');
    assert.ok(h.appEvents.some(event => event.type === 'task' && event.state === 'completed'));
    assert.equal(h.announcements.length, 1, 'a missing speech acknowledgment cannot replay narration or phone work');
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test('a late old response completion cannot erase a new turn tool carried by argument events', async () => {
  let writes = 0;
  const h = await harness(quietScreen, { selector: mediaVolume(), native: async () => { writes++; return { status: 'completed' }; } });
  try {
    h.provider({ type: 'response.created', response: { id: 'old-turn', metadata: null } });
    h.speak();
    h.provider({ type: 'response.created', response: { id: 'new-turn', metadata: null } });
    h.provider({ type: 'response.function_call_arguments.done', response_id: 'new-turn', name: 'update_phone_task', call_id: 'new-call', arguments: JSON.stringify({ instruction: 'Media volume 40%' }) });
    h.provider({ type: 'response.done', response: { id: 'old-turn', status: 'cancelled', output: [] } });
    h.provider({ type: 'response.done', response: { id: 'new-turn', status: 'completed', output: [] } });
    await h.until(() => writes === 1 ? true : undefined, 'new turn tool');
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test('a preset changes manner and pacing while the shared phone rules stay in every response', () => {
  const family = bosonSessionConfiguration(presets.family);
  assert.equal(parsePreset('family'), 'family');
  assert.equal(parsePreset('unknown'), 'quick');
  assert.ok(family.audio.input.turn_detection.silence_duration_ms > bosonSessionConfiguration().audio.input.turn_detection.silence_duration_ms);
  assert.match(family.instructions, /Always speak Hindi/);
  const update = completionResponse({ type: 'task', state: 'question', goal: 'Send a photo', detail: 'Which photo?', revision: 1 }, presetInstructions(presets.family));
  assert.match(update.response.instructions, /Always speak Hindi/);
  assert.match(update.response.instructions, /Do not describe an action as completed until/);
});
