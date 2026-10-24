import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { harness, messagesApp } from './fixtures.ts';

const request = { instruction: 'Open Messages', app: 'Messages', outcome: { kind: 'app_opened' } };

test('public voice app-open request completes from fresh foreground proof without a navigation model', async () => {
  const app = messagesApp();
  let decisions = 0;
  const h = await harness(app.portal, { selector: { decide: async () => {
    decisions++;
    return { actionId: 'blocked', confidence: null, returnedModel: null };
  } } });
  try {
    const accepted = await h.call('update_phone_task', request);
    assert.deepEqual(accepted, { status: 'accepted', note: 'Working on the complete request. Wait for the operator outcome; do not resubmit.' });
    const result = await h.until(() => h.appEvents.find(event => event.type === 'task' && ['completed', 'blocked', 'unknown', 'question'].includes(String(event.state))), 'app-open outcome');
    assert.equal(result.state, 'completed', String(result.detail));
    assert.deepEqual(result.evidence, { kind: 'app_opened', packageName: 'com.google.android.apps.messaging', detail: 'Observed Messages in the foreground.' });
    assert.equal(decisions, 0);
    assert.equal(h.portalSeen.filter(method => method === 'packages').length, 1);
    assert.equal(h.portalSeen.filter(method => method === 'app').length, 1);
    await h.until(() => h.announcements.find(text => text.includes('Observed Messages in the foreground.')), 'grounded app-open announcement');
  } finally { await h.close(); }
});

test('after a manual pause a new request reports the retained pause, then explicit continue completes', async () => {
  const app = messagesApp();
  let writes = 0;
  const h = await harness(app.portal, { native: async (_name, args) => {
    writes++;
    return { status: 'completed', stream: 'media', requestedPercent: args.percent, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  } });
  try {
    await h.call('update_phone_task', { instruction: 'Media volume 40%', mediaVolume: 40 });
    await h.until(() => h.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'first task');
    h.speak();
    await h.call('pause_phone_task', {});
    h.speak();
    assert.deepEqual(await h.call('update_phone_task', { instruction: 'Keep media volume 40%', mediaVolume: 40 }), { status: 'paused', note: 'Request updated. Say continue when ready.' });
    await h.until(() => h.appEvents.find(event => event.state === 'paused' && event.detail === 'Request updated. Say continue when ready.'), 'retained pause');
    await h.until(() => h.announcements.find(text => text.includes('Request updated. Say continue when ready.')), 'grounded retained-pause feedback', 2000);
    assert.equal(writes, 1, 'updating a paused task must not mutate the phone');
    h.speak();
    await h.call('continue_phone_task', {});
    await h.until(() => writes === 2 ? true : undefined, 'explicit continue');
  } finally { await h.close(); }
});

test('repeated voice turns recover after failed and unknown tasks and discard interrupted response audio', async () => {
  const app = messagesApp();
  let writes = 0;
  const h = await harness(app.portal, { native: async (_name, args) => {
    writes++;
    if (writes === 2) return { status: 'blocked', reason: 'Synthetic permission denial' };
    if (writes === 3) return { status: 'unknown', reason: 'Synthetic missing acknowledgement' };
    return { status: 'completed', stream: 'media', requestedPercent: args.percent, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  } });
  try {
    for (const [index, state] of ['completed', 'blocked', 'unknown'].entries()) {
      h.speak();
      const from = h.appEvents.length;
      await h.call('update_phone_task', { instruction: `Synthetic media request ${index}`, mediaVolume: 40 });
      await h.until(() => h.appEvents.slice(from).find(event => event.type === 'task' && event.state === state), state);
      h.provider({ type: 'response.created', response: { id: `late-${index}` } });
      h.speak();
      h.speak();
      h.provider({ type: 'response.output_audio.delta', response_id: `late-${index}`, delta: 'stale' });
      h.provider({ type: 'response.done', response: { id: `late-${index}`, status: 'completed', output: [] } });
    }
    // Use an independent supported result after an unknown media write, without retrying that write.
    const from = h.appEvents.length;
    await h.call('update_phone_task', request);
    await h.until(() => h.appEvents.slice(from).find(event => event.type === 'task' && event.state === 'completed'), 'new app request after repeated interrupted turns');
    assert.equal(h.appEvents.some(event => event.delta === 'stale'), false);
    assert.equal(writes, 3);
  } finally { await h.close(); }
});

for (const failure of ['no-foreground', 'mismatched-root', 'ambiguous', 'launch-error'] as const) {
  test(`app-open does not claim completion for ${failure}`, async () => {
    const app = messagesApp();
    const h = await harness(async (method, params) => {
      if (method === 'packages' && failure === 'ambiguous') return [
        { packageName: 'example.one', label: 'Messages' }, { packageName: 'example.two', label: 'Messages' },
      ];
      if (method === 'app') {
        if (failure === 'launch-error') throw new Error('Synthetic launch acknowledgement lost');
        return {}; // Acknowledged, but nothing entered the foreground.
      }
      const result = await app.portal(method, params);
      if (method === 'state' && failure === 'mismatched-root' && result && typeof result === 'object' && 'phone_state' in result) {
        return { ...result, phone_state: { packageName: 'com.google.android.apps.messaging', currentApp: 'Messages' } };
      }
      return result;
    });
    try {
      await h.call('update_phone_task', request);
      const result = await h.until(() => h.appEvents.find(event => event.type === 'task' && ['completed', 'unknown', 'question', 'blocked'].includes(String(event.state))), 'unestablished app-open result', 7000);
      assert.equal(result.state, failure === 'ambiguous' ? 'question' : 'unknown', String(result.detail));
      assert.equal(h.portalSeen.filter(method => method === 'app').length, failure === 'ambiguous' ? 0 : 1);
      assert.equal(h.appEvents.some(event => event.state === 'completed'), false);
    } finally { await h.close(); }
  });
}

test('an already foreground app is freshly checked after package resolution and is not relaunched', async () => {
  const app = messagesApp();
  await app.phone.launch('com.google.android.apps.messaging');
  const h = await harness(app.portal);
  try {
    await h.call('update_phone_task', request);
    await h.until(() => h.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'already foreground app');
    assert.equal(h.portalSeen.filter(method => method === 'app').length, 0);
    const resolved = h.portalSeen.indexOf('packages');
    assert.ok(resolved >= 0 && h.portalSeen.slice(resolved + 1).includes('state'), 'completion needs a fresh read after resolving the app');
  } finally { await h.close(); }
});

test('observed provider JSON-encoded object normalizes to the typed app-open outcome', async () => {
  const app = messagesApp();
  const h = await harness(app.portal);
  try {
    const accepted = await h.call('update_phone_task', { instruction: 'Open Messages', app: 'Messages', outcome: JSON.stringify({ kind: 'app_opened' }) });
    assert.deepEqual(accepted, { status: 'accepted', note: 'Working on the complete request. Wait for the operator outcome; do not resubmit.' });
    const completed = await h.until(() => h.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'normalized app-open result');
    assert.deepEqual(completed.evidence, { kind: 'app_opened', packageName: 'com.google.android.apps.messaging', detail: 'Observed Messages in the foreground.' });
  } finally { await h.close(); }
});

test('flat provider enum opens the app without instruction-text guessing', async () => {
  const app = messagesApp();
  const h = await harness(app.portal);
  try {
    await h.call('update_phone_task', { instruction: 'Synthetic explicit result', app: 'Messages', outcome: 'app_opened' });
    const completed = await h.until(() => h.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'flat app-open result');
    assert.deepEqual(completed.evidence, { kind: 'app_opened', packageName: 'com.google.android.apps.messaging', detail: 'Observed Messages in the foreground.' });
  } finally { await h.close(); }
});

for (const fields of [
  { outcome: 'send_message' },
  { outcome: JSON.stringify({ kind: 'app_opened', uri: 'synthetic:unsupported' }) },
  { outcome: JSON.stringify({ kind: 'search_results' }) },
  { outcome: JSON.stringify('app_opened') },
  { outcome: 'app_opened', outcomeQuery: 'unrelated search' },
]) test(`a malformed outcome keeps the goal instead of rejecting it: ${JSON.stringify(fields)}`, async () => {
  const app = messagesApp();
  const h = await harness(app.portal);
  try {
    const result = await h.call('update_phone_task', { instruction: 'Synthetic invalid wire request', app: 'Messages', ...fields });
    assert.equal(z.object({ status: z.string() }).loose().parse(result).status, 'accepted');
    await h.until(() => h.appEvents.find(event => event.type === 'task'), 'the goal to start without the malformed outcome');
  } finally { await h.close(); }
});

for (const [kind, field, expected] of [
  ['search_results', 'outcomeQuery', { kind: 'search_results', query: 'Synthetic search' }],
  ['content_opened', 'outcomeName', { kind: 'content_opened', name: 'Synthetic search' }],
] as const) test(`flat ${kind} keeps its typed result instead of reducing the goal to app opening`, async () => {
  const app = messagesApp();
  let observed: unknown;
  const h = await harness(app.portal, { selector: { decide: async ({ request }) => {
    observed = request?.outcome;
    return { actionId: 'blocked', confidence: null, returnedModel: null };
  } } });
  try {
    await h.call('update_phone_task', { instruction: 'Synthetic requested result', app: 'Messages', outcome: kind, [field]: 'Synthetic search' });
    await h.until(() => observed, 'normalized typed result');
    assert.deepEqual(observed, expected);
    assert.equal(h.appEvents.some(event => event.state === 'completed'), false);
  } finally { await h.close(); }
});
