import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionResponse } from '../src/server/voice.ts';

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
    voice.client.send(JSON.stringify({ type: 'response.done', response: { id: 'old', status: 'completed', output: [{ type: 'function_call', name: 'set_brightness', call_id: 'old-call', arguments: '{"percent":40}' }] } }));
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
      { type: 'response.function_call_arguments.done', response_id: 'old', name: 'set_brightness', call_id: 'late', arguments: '{"percent":40}' },
      { type: 'response.done', response: { id: 'new', status: 'completed' } },
    ]) voice.client.send(JSON.stringify(event));
    await new Promise(resolve => setTimeout(resolve, 80));
    // No device observation or native mutation should be scheduled for the old request.
    assert.equal(commands.some(event => JSON.parse(event).type === 'task'), false);
  } finally { session.close(); app.close(); device.close(); voice.close(); }
});

test('voice submits a combined Settings request through native and Portal and reports only matching evidence', async () => {
  const app = await socketPair();
  const device = await socketPair();
  const voice = await socketPair();
  let nightLight = false;
  const mutations: string[] = [];
  const completed = Promise.withResolvers<Record<string, unknown>>();
  const statuses: string[] = [];
  const timer = setTimeout(() => completed.reject(new Error('Synthetic protocol journey did not finish')), 3000);
  device.client.on('message', data => {
    const request = JSON.parse(data.toString());
    if (request.method === 'tap') { nightLight = true; mutations.push('night-light'); }
    const result = request.method === 'state' ? {
      phone_state: { packageName: 'com.android.settings', activityName: 'DisplaySettings' },
      a11y_tree: {
        resourceId: 'night', className: 'android.widget.Switch', packageName: 'com.android.settings',
        text: 'Night Light', contentDescription: '', stateDescription: '',
        boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 },
        isClickable: true, isCheckable: true, isChecked: nightLight,
        isEnabled: true, isVisibleToUser: true, isScrollable: false, isEditable: false,
        isPassword: false, actionList: [], children: [],
      },
    } : {};
    device.client.send(JSON.stringify({ id: request.id, status: 'success', result }));
  });
  app.client.on('message', data => {
    const event = JSON.parse(data.toString());
    if (event.type === 'task') {
      statuses.push(event.state);
      if (event.state === 'completed' || event.state === 'blocked') completed.resolve(event);
    }
    if (event.type === 'command') {
      const result = event.name === 'set_brightness'
        ? { status: 'completed', requestedPercent: event.args.percent, observedRawValue: 14 }
        : event.name === 'read_brightness' ? { status: 'observed', observedRawValue: 14 } : { status: 'opened' };
      if (event.name === 'set_brightness') mutations.push('brightness');
      app.client.send(JSON.stringify({ type: 'command_result', id: event.id, result }));
    }
  });
  const session = new VoiceSession(app.peer, new DeviceConnection(device.peer, 'synthetic-phone'), { BOSON_API_KEY: 'synthetic' }, { voiceSocket: voice.peer, selector: { decide: async input => ({ actionId: input.observation.elements.some(item => item.checked) ? 'done' : input.candidates.find(item => item.action.type === 'tap')?.id ?? 'blocked', confidence: null, returnedModel: null }) } });
  try {
    voice.client.send(JSON.stringify({ type: 'response.created', response: { id: 'request' } }));
    voice.client.send(JSON.stringify({ type: 'response.done', response: { id: 'request', status: 'completed', output: [{ type: 'function_call', name: 'update_phone_task', call_id: 'combined', arguments: JSON.stringify({ instruction: 'Brightness 40% and Night Light on', brightness: 40, nightLight: true }) }] } }));
    const outcome = await completed.promise;
    assert.equal(outcome.state, 'completed', String(outcome.detail));
    assert.match(String(outcome.detail), /"brightness":40/);
    assert.match(String(outcome.detail), /"checked":true/);
    assert.deepEqual(mutations, ['brightness', 'night-light']);
    assert.equal(statuses.at(-1), 'completed');
  } finally { clearTimeout(timer); session.close(); app.close(); device.close(); voice.close(); }
});
