import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, messagesApp } from './fixtures.ts';

test('voice media volume and independent read use the typed native protocol', async () => {
  const app = messagesApp();
  const commands: string[] = [];
  const h = await harness(app.portal, { native: async (name, args) => {
    commands.push(name);
    return name === 'read_media_volume' ? { status: 'observed', stream: 'media', observedIndex: 6, minIndex: 0, maxIndex: 15 }
      : { status: 'completed', stream: 'media', requestedPercent: args.percent, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  } });
  try {
    assert.deepEqual(await h.call('read_phone_value', { value: 'media_volume' }), { status: 'observed', stream: 'media', observedIndex: 6, minIndex: 0, maxIndex: 15 });
    h.speak();
    await h.call('update_phone_task', { instruction: 'Set media volume 40%', mediaVolume: 40 });
    await h.until(() => h.appEvents.find(event => event.type === 'task' && event.state === 'completed'), 'native volume result');
    assert.deepEqual(commands, ['read_media_volume', 'set_media_volume']);
  } finally { await h.close(); }
});

test('voice Clock proposal is spoken with concrete duration and cannot be self-approved', async () => {
  const app = messagesApp();
  let creates = 0;
  const h = await harness(app.portal, { native: async name => {
    if (name === 'resolve_handler') return { status: 'observed', available: true, handlerPackage: 'clock' };
    creates++;
    return { status: 'handoff', handlerPackage: 'clock', note: 'Inspect Clock' };
  } });
  try {
    await h.call('update_phone_task', { instruction: 'Tea for five minutes', timer: { seconds: 300, label: 'Tea' } });
    const event = await h.until(() => h.appEvents.find(event => event.state === 'confirming'), 'Clock proposal');
    const proposal = event.proposal;
    assert.ok(proposal && typeof proposal === 'object' && 'id' in proposal && typeof proposal.id === 'string');
    await h.until(() => h.announcements.find(text => text.includes('300 seconds') && text.includes('Tea')), 'spoken concrete proposal');
    const premature = await h.call('confirm_phone_action', { proposalId: proposal.id, approve: true });
    assert.ok(premature && typeof premature === 'object' && 'status' in premature && premature.status === 'blocked');
    assert.equal(creates, 0);
    h.speak();
    await h.call('confirm_phone_action', { proposalId: proposal.id, approve: true });
    await h.until(() => h.appEvents.find(event => event.state === 'unknown'), 'unverified Clock outcome');
    assert.equal(creates, 1);
    assert.equal(h.appEvents.some(event => event.state === 'completed'), false);
  } finally { await h.close(); }
});
