import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { harness, mediaVolume, messagesApp } from './fixtures.ts';

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
    assert.deepEqual(accepted, { status: 'accepted', note: 'Working on the complete request. Wait for the task outcome; do not resubmit.' });
    const result = await h.until(() => h.appEvents.find(event => event.type === 'task' && ['completed', 'blocked', 'unknown', 'question'].includes(String(event.state))), 'app-open outcome');
    assert.equal(result.state, 'completed', String(result.detail));
    assert.equal(result.detail, 'Opened Messages.');
    assert.equal(decisions, 0);
    assert.equal(h.portalSeen.filter(method => method === 'packages').length, 1);
    assert.equal(h.portalSeen.filter(method => method === 'app').length, 1);
    await h.until(() => h.announcements.find(text => text.includes('Opened Messages.')), 'grounded app-open announcement');
  } finally { await h.close(); }
});

test('repeated voice turns recover after failed and unknown tasks and discard interrupted response audio', async () => {
  const app = messagesApp();
  let writes = 0;
  const h = await harness(app.portal, { selector: mediaVolume(), native: async () => {
    writes++;
    if (writes === 2) return { status: 'blocked', reason: 'Synthetic permission denial' };
    if (writes === 3) return { status: 'unknown', reason: 'Synthetic missing acknowledgement' };
    return { status: 'completed' };
  } });
  try {
    for (const [index, state] of ['completed', 'blocked', 'unknown'].entries()) {
      h.speak();
      const from = h.appEvents.length;
      await h.call('update_phone_task', { instruction: `Synthetic media request ${index}` });
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
      const result = await h.until(() => h.appEvents.find(event => event.type === 'task' && ['completed', 'unknown', 'question', 'blocked'].includes(String(event.state))), 'unestablished app-open result');
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

test('flat provider enum opens the app without instruction-text guessing', async () => {
  const app = messagesApp();
  const h = await harness(app.portal);
  try {
    await h.call('update_phone_task', { instruction: 'Synthetic explicit result', app: 'Messages', outcome: 'app_opened' });
    const completed = await h.until(() => h.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'flat app-open result');
    assert.equal(completed.detail, 'Opened Messages.');
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
