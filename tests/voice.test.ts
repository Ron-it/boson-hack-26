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

for (const split of [false, true, 'brightness-first']) test(`combined request reaches Night Light and max brightness despite autonomous model resubmissions (split tools: ${split})`, async () => {
  const app = await socketPair();
  const device = await socketPair();
  const voice = await socketPair();
  let nightLight = false;
  let resubmissions = 0;
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
        ? { status: 'completed', requestedPercent: event.args.percent, observedRawValue: 255 }
        : event.name === 'read_brightness' ? { status: 'observed', observedRawValue: 255 } : { status: 'opened' };
      if (event.name === 'set_brightness') mutations.push('brightness');
      app.client.send(JSON.stringify({ type: 'command_result', id: event.id, result }));
    }
  });
  const session = new VoiceSession(app.peer, new DeviceConnection(device.peer, 'synthetic-phone'), { BOSON_API_KEY: 'synthetic' }, { voiceSocket: voice.peer, selector: { decide: async input => {
    if (resubmissions++ < 3) {
      const id = `autonomous-${resubmissions}`;
      voice.client.send(JSON.stringify({ type: 'response.created', response: { id } }));
      voice.client.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'function_call', name: 'update_phone_task', call_id: id, arguments: JSON.stringify({ instruction: 'Turn on Night Light and max out brightness', brightness: 100, nightLight: 'on' }) }] } }));
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return { actionId: input.observation.elements.some(item => item.checked) ? 'done' : input.candidates.find(item => item.action.type === 'tap')?.id ?? 'blocked', confidence: null, returnedModel: null };
  } } });
  try {
    const splitCalls = [{ type: 'function_call', name: 'update_phone_task', call_id: 'night', arguments: JSON.stringify({ instruction: 'Turn on Night Light and max out brightness', nightLight: 'on' }) }, { type: 'function_call', name: 'set_brightness', call_id: 'brightness', arguments: JSON.stringify({ percent: 100 }) }];
    voice.client.send(JSON.stringify({ type: 'response.created', response: { id: 'request' } }));
    voice.client.send(JSON.stringify({ type: 'response.done', response: { id: 'request', status: 'completed', output: split ? (split === 'brightness-first' ? splitCalls.toReversed() : splitCalls) : [{ type: 'function_call', name: 'update_phone_task', call_id: 'combined', arguments: JSON.stringify({ instruction: 'Turn on Night Light and max out brightness', brightness: 100, nightLight: 'on' }) }] } }));
    const outcome = await completed.promise;
    assert.equal(outcome.state, 'completed', String(outcome.detail));
    assert.match(String(outcome.detail), /"brightness":100/);
    assert.match(String(outcome.detail), /"nightLight":true/);
    assert.deepEqual(mutations, ['brightness', 'night-light']);
    assert.equal(statuses.at(-1), 'completed');
  } finally { clearTimeout(timer); session.close(); app.close(); device.close(); voice.close(); }
});

// Synthetic peers exercise the public voice/native/Portal wire protocol only.
async function settingsJourney() {
  const app = await socketPair();
  const device = await socketPair();
  const voice = await socketPair();
  const statuses: { state: string; detail: string }[] = [];
  const nativeCommands: string[] = [];
  const voiceEvents: { type: string; session?: { tool_choice?: string }; response?: { instructions?: string } }[] = [];
  const toolOutputs = new Map<string, { status: string }>();
  let rawBrightness = 14;
  let blocked = true;
  device.client.on('message', data => {
    const request = JSON.parse(data.toString());
    device.client.send(JSON.stringify({ id: request.id, status: 'success', result: request.method === 'state' ? {
      phone_state: { packageName: 'com.android.settings' },
      a11y_tree: { packageName: 'com.android.settings', resourceId: 'night', text: 'Night Light', className: 'Switch',
        contentDescription: '', stateDescription: '', isClickable: true, isScrollable: false, isEditable: false, isPassword: false, actionList: [],
        boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 },
        isChecked: true, isCheckable: true, isEnabled: true, isVisibleToUser: true, children: [] },
    } : {} }));
  });
  app.client.on('message', data => {
    const event = JSON.parse(data.toString());
    if (event.type === 'task') statuses.push(event);
    if (event.type !== 'command') return;
    nativeCommands.push(event.name);
    if (event.name === 'set_brightness') rawBrightness = event.args.percent === 100 ? 255 : 14;
    app.client.send(JSON.stringify({ type: 'command_result', id: event.id, result: event.name === 'set_brightness'
      ? { status: 'completed', requestedPercent: event.args.percent, observedRawValue: rawBrightness }
      : event.name === 'read_brightness' ? { status: 'observed', observedRawValue: rawBrightness } : { status: 'opened' } }));
  });
  voice.client.on('message', data => {
    const event = JSON.parse(data.toString());
    voiceEvents.push(event);
    if (event.item?.type === 'function_call_output') toolOutputs.set(event.item.call_id, JSON.parse(event.item.output));
  });
  const session = new VoiceSession(app.peer, new DeviceConnection(device.peer, 'synthetic-settings'), { BOSON_API_KEY: 'synthetic' }, {
    voiceSocket: voice.peer, describeScreen: null,
    selector: { decide: async () => ({ actionId: blocked ? 'blocked' : 'done', confidence: null, returnedModel: null }) },
  });
  const waitFor = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Synthetic Settings protocol did not reach the expected state');
  };
  const call = async (id: string, name: string, args: object, userTurn = false) => {
    if (userTurn) for (const type of ['input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped']) voice.client.send(JSON.stringify({ type }));
    voice.client.send(JSON.stringify({ type: 'response.created', response: { id } }));
    const item = { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) };
    // Both provider event forms carry the same call. They must not dispatch twice.
    voice.client.send(JSON.stringify({ ...item, type: 'response.function_call_arguments.done', response_id: id }));
    voice.client.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed', output: [item] } }));
    await waitFor(() => toolOutputs.has(id));
    return toolOutputs.get(id);
  };
  return { call, waitFor, statuses, nativeCommands, voiceEvents, allowCompletion: () => { blocked = false; },
    close: () => { session.close(); app.close(); device.close(); voice.close(); } };
}

test('blocked tasks wait for a real user correction; pause persists across corrections and continue reads fresh evidence', async () => {
  const journey = await settingsJourney();
  try {
    await journey.call('initial', 'update_phone_task', { instruction: 'Turn on Night Light and max out brightness', brightness: 100, nightLight: 'on' }, true);
    await journey.waitFor(() => journey.statuses.at(-1)?.state === 'blocked');
    const writes = journey.nativeCommands.filter(name => name === 'set_brightness').length;
    assert.equal(writes, 1, 'arguments.done plus response.done must execute once');
    assert.equal((await journey.call('autonomous-retry', 'update_phone_task', { instruction: 'Try Night Light again', nightLight: 'on' }))?.status, 'retained');
    assert.equal((await journey.call('autonomous-continue', 'continue_phone_task', {}))?.status, 'retained');
    assert.equal(journey.nativeCommands.filter(name => name === 'set_brightness').length, writes);
    await journey.call('pause', 'pause_phone_task', {}, true);
    await journey.call('corrected', 'update_phone_task', { instruction: 'Actually brightness 40%, keep Night Light on', brightness: 40, nightLight: 'on' }, true);
    assert.equal(journey.statuses.at(-1)?.state, 'paused');
    assert.equal(journey.nativeCommands.filter(name => name === 'set_brightness').length, writes);
    journey.allowCompletion();
    await journey.call('explicit-continue', 'continue_phone_task', {}, true);
    await journey.waitFor(() => journey.statuses.at(-1)?.state === 'completed');
    assert.equal(journey.statuses.at(-1)?.detail, 'Observed result: {"brightness":40,"nightLight":true}');
    assert.equal(journey.nativeCommands.filter(name => name === 'set_brightness').length, 2);
    assert.equal(journey.nativeCommands.at(-1), 'read_brightness', 'completion needs fresh direct brightness evidence');
    assert.equal((await journey.call('autonomous-after-completion', 'set_brightness', { percent: 100 }))?.status, 'retained');
    assert.equal(journey.nativeCommands.filter(name => name === 'set_brightness').length, 2);
    assert.ok(journey.voiceEvents.some(event => event.type === 'session.update' && event.session?.tool_choice === 'none'));
    assert.ok(journey.voiceEvents.some(event => event.type === 'session.update' && event.session?.tool_choice === 'auto'));
  } finally { journey.close(); }
});

test('blocked Settings announcement gives the recovery instruction without a generic greeting', () => {
  const event = completionResponse({ type: 'task', state: 'blocked', goal: 'Turn Night Light on', detail: "I couldn't open Settings. Open Display settings, then say continue.", revision: 5 });
  assert.match(event.response.instructions, /Say exactly this task feedback/);
  assert.match(event.response.instructions, /Open Display settings, then say continue/);
  assert.match(event.response.instructions, /Do not greet/);
});


import { harness } from './fixtures.ts';

test('accepted async work waits for observed outcome instead of starting an idle voice reply', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  const journey = await harness(() => { throw new Error('No UI required'); }, { native: async name => {
    if (name === 'set_media_volume') { writes++; await gate.promise; return { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 }; }
    return { status: 'observed', stream: 'media', observedIndex: 6, minIndex: 0, maxIndex: 15 };
  } });
  try {
    await journey.call('update_phone_task', { instruction: 'Media volume 40%', mediaVolume: 40 });
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
    assert.match(journey.announcements[0] ?? '', /Observed media volume 6/);
    assert.match(JSON.stringify(journey.responseRequests[0]?.input), /Observed media volume 6/, 'the response has explicit grounded input, not only instructions');
    assert.equal(writes, 1);
  } finally { gate.resolve(); await journey.close(); }
});

test('a new intentional user question can speak while old task audio and late completion are ignored', async () => {
  const gate = Promise.withResolvers<void>();
  let writes = 0;
  const h = await harness(() => ({}), { native: async () => { writes++; await gate.promise; return { status: 'unknown', reason: 'Synthetic interruption' }; } });
  try {
    await h.call('update_phone_task', { instruction: 'Media volume 40%', mediaVolume: 40 });
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
  const h = await harness(() => ({}), { holdResponses: true, responseDeadlineMs: 80, native: async () => {
    writes++; return { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  } });
  try {
    await h.call('update_phone_task', { instruction: 'Media volume 40%', mediaVolume: 40 });
    await h.until(() => h.appEvents.find(event => event.type === 'voice_issue' && event.state === 'unknown'), 'voice timeout issue', 1000);
    assert.ok(h.appEvents.some(event => event.type === 'task' && event.state === 'completed'));
    assert.equal(h.announcements.length, 1, 'a missing speech acknowledgment cannot replay narration or phone work');
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test('a late old response completion cannot erase a new turn tool carried by argument events', async () => {
  let writes = 0;
  const h = await harness(() => ({}), { native: async () => { writes++; return { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 }; } });
  try {
    h.provider({ type: 'response.created', response: { id: 'old-turn', metadata: null } });
    h.speak();
    h.provider({ type: 'response.created', response: { id: 'new-turn', metadata: null } });
    h.provider({ type: 'response.function_call_arguments.done', response_id: 'new-turn', name: 'update_phone_task', call_id: 'new-call', arguments: JSON.stringify({ instruction: 'Media volume 40%', mediaVolume: 40 }) });
    h.provider({ type: 'response.done', response: { id: 'old-turn', status: 'cancelled', output: [] } });
    h.provider({ type: 'response.done', response: { id: 'new-turn', status: 'completed', output: [] } });
    await h.until(() => writes === 1 ? true : undefined, 'new turn tool', 500);
    assert.equal(writes, 1);
  } finally { await h.close(); }
});
