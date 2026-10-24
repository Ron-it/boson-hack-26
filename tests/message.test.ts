import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActionCandidate } from '../src/mobile/actions.ts';
import type { PhoneObservation } from '../src/mobile/portal.ts';
import { PhoneTask, type TaskStatus } from '../src/server/task.ts';
import { z } from 'zod';
import { harness, messagesApp } from './fixtures.ts';

/** A navigation model that always prefers the first applicable step. It never chooses to skip confirmation. */
const navigator = {
  decide: async ({ observation, candidates }: { observation: PhoneObservation; candidates: ActionCandidate[] }) => {
    const find = (pattern: RegExp, field = '') => candidates.find(candidate => pattern.test(candidate.description) && (candidate.element?.resourceId ?? '').includes(field));
    const compose = observation.elements.find(element => element.resourceId.endsWith('compose_message_text'));
    const search = observation.elements.find(element => element.resourceId === 'ContactSearchField');
    const choice = (compose?.text ? find(/approval/i) : find(/Type the requested message/, 'compose'))
      || (search?.text ? find(/^Tap "(Avery|Jordan)/) : find(/Type the requested recipient/, 'ContactSearchField'))
      || find(/^Tap "Start chat"/) || find(/^Open Messages/) || candidates.find(candidate => candidate.id === 'blocked');
    return { actionId: choice?.id ?? 'blocked', confidence: null, returnedModel: null };
  },
};

const request = { instruction: 'Send Avery a text saying synthetic hello', app: 'Messages', recipient: 'Avery', message: 'Synthetic hello from the test' };

test('a message request prepares the draft and asks before sending, even when told to send', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, navigator);
  await task.submit(request);
  const last = statuses.at(-1);
  assert.equal(last?.state, 'confirming');
  assert.deepEqual(last?.proposal && { recipient: last.proposal.recipient, message: last.proposal.message }, { recipient: 'Avery Testcontact', message: 'Synthetic hello from the test' });
  assert.equal(app.draft, 'Synthetic hello from the test');
  assert.deepEqual(app.sent, []);
  assert.equal(app.taps.includes('Send SMS'), false);
});

async function prepared(options: Parameters<typeof messagesApp>[0] = {}) {
  const app = messagesApp(options);
  const statuses: TaskStatus[] = [];
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, navigator);
  await task.submit(request);
  const proposal = statuses.at(-1)?.proposal;
  assert.ok(proposal, 'expected a confirmation proposal');
  return { app, statuses, task, proposal };
}

test('approval sends exactly once and completion rests on the observed sent message', async () => {
  const { app, statuses, task, proposal } = await prepared();
  const first = task.answer(proposal.id, true);
  const repeated = task.answer(proposal.id, true);
  await first.settled;
  assert.equal(first.status, 'accepted');
  assert.equal(repeated.status, 'expired');
  assert.equal(task.answer(proposal.id, true).status, 'expired', 'a consumed approval cannot be replayed after sending');
  assert.deepEqual(app.sent, [{ recipient: 'Avery Testcontact', text: 'Synthetic hello from the test' }]);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /shows in the conversation/);
});

test('declining leaves the message unsent with the draft in place', async () => {
  const { app, statuses, task, proposal } = await prepared();
  assert.equal(task.answer(proposal.id, false).status, 'declined');
  assert.equal(task.answer(proposal.id, true).status, 'expired');
  assert.deepEqual(app.sent, []);
  assert.equal(app.draft, 'Synthetic hello from the test');
  assert.equal(statuses.at(-1)?.state, 'declined');
});

test('a correction, pause or stop withdraws the confirmation before it can be approved', async () => {
  for (const withdraw of [
    (task: PhoneTask) => { void task.submit({ ...request, message: 'A corrected synthetic message' }); },
    (task: PhoneTask) => task.pause('Manual takeover'),
    (task: PhoneTask) => task.stop(),
  ]) {
    const { app, task, proposal } = await prepared();
    withdraw(task);
    assert.equal(task.answer(proposal.id, true).status, 'expired');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(app.sent, []);
  }
});

test('speaking to answer keeps the confirmation, but approval revalidates the live draft', async () => {
  const { app, statuses, task, proposal } = await prepared();
  task.interrupt('Paused while you speak', true);
  app.edit('Synthetic text the user changed by hand');
  await task.answer(proposal.id, true).settled;
  assert.deepEqual(app.sent, []);
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /nothing was sent/);
});

test('a send whose result is lost is reported unknown and never sent again on continue', async () => {
  const { app, statuses, task, proposal } = await prepared({ failSend: true });
  await task.answer(proposal.id, true).settled;
  assert.equal(statuses.at(-1)?.state, 'unknown');
  const sendTaps = () => app.taps.filter(tap => tap === 'Send SMS').length;
  assert.equal(sendTaps(), 1);
  await task.resume();
  const next = statuses.at(-1);
  assert.equal(sendTaps(), 1, 'continuing must not tap send without a new confirmation');
  assert.equal(next?.state, 'confirming');
  assert.match(next?.detail ?? '', /may already have gone through/);
});

test('a disconnect while checking a dispatched send is unknown, not blocked', async () => {
  const { app, statuses, task, proposal } = await prepared({ disconnectAfterSend: true });
  await task.answer(proposal.id, true).settled;
  assert.equal(app.sent.length, 1);
  assert.equal(statuses.at(-1)?.state, 'unknown');
  assert.match(statuses.at(-1)?.detail ?? '', /won't send it again/);
});

test('a send without observed evidence is unknown, not completed', async () => {
  const { statuses, task, proposal } = await prepared({ sendLeavesDraft: true });
  await task.answer(proposal.id, true).settled;
  assert.equal(statuses.at(-1)?.state, 'unknown');
});

test('several matching contacts lead to a question instead of a guess', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, navigator);
  await task.submit({ ...request, recipient: 'Jordan' });
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.match(statuses.at(-1)?.detail ?? '', /Jordan Testone or Jordan Testtwo/);
  assert.equal(app.taps.some(tap => tap.startsWith('Jordan')), false);
  assert.deepEqual(app.sent, []);
});

test('when the model asks about a contact, the question names the visible matches', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const asking = { decide: async (input: Parameters<typeof navigator.decide>[0]) => input.candidates.filter(candidate => /^Tap "Jordan/.test(candidate.description)).length > 1
    ? { actionId: 'ask', confidence: null, returnedModel: null } : navigator.decide(input) };
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, asking);
  await task.submit({ ...request, recipient: 'Jordan' });
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.match(statuses.at(-1)?.detail ?? '', /Jordan Testone or Jordan Testtwo/);
});

test('a model that picks send directly reaches only the gate, and without concrete details hands back', async () => {
  const { app } = await prepared();
  const statuses: TaskStatus[] = [];
  const eager = new PhoneTask(app.phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'commit')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  await eager.submit({ instruction: 'Just send whatever is there' });
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /"Send SMS".*please do it yourself/);
  assert.equal(app.taps.includes('Send SMS'), false);
  assert.deepEqual(app.sent, []);
});

const voiceRequest = { instruction: 'Text Avery: Synthetic hello from the test', app: 'Messages', recipient: 'Avery', message: 'Synthetic hello from the test' };
const taskEvent = z.looseObject({ type: z.literal('task'), state: z.string(), detail: z.string(), proposal: z.object({ id: z.string(), recipient: z.string(), message: z.string() }).optional() });

test('voice asks with the concrete recipient and message, and sends only after the user answers', async () => {
  const app = messagesApp();
  const phone = await harness(app.portal, { selector: navigator });
  try {
    z.object({ status: z.literal('accepted') }).loose().parse(await phone.call('update_phone_task', voiceRequest));
    const confirming = await phone.until(() => phone.appEvents.map(event => taskEvent.safeParse(event)).find(event => event.success && event.data.state === 'confirming')?.data, 'a confirmation');
    const proposal = confirming.proposal;
    assert.ok(proposal);
    const asked = await phone.until(() => phone.announcements.find(text => text.includes(proposal.id)), 'the spoken confirmation');
    assert.match(asked, /Avery Testcontact/);
    assert.match(asked, /Synthetic hello from the test/);

    const unprompted = z.object({ status: z.literal('blocked'), reason: z.string() }).parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    assert.match(unprompted.reason, /user/i, 'the model cannot approve before the user has answered');
    assert.deepEqual(app.sent, []);

    phone.speak();
    z.object({ status: z.literal('accepted') }).loose().parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    await phone.until(() => phone.appEvents.map(event => taskEvent.safeParse(event)).find(event => event.success && event.data.state === 'completed'), 'the observed send');
    assert.deepEqual(app.sent, [{ recipient: 'Avery Testcontact', text: 'Synthetic hello from the test' }]);
    z.object({ status: z.literal('blocked') }).loose().parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    assert.equal(app.sent.length, 1);
  } finally { await phone.close(); }
});

test('guide mode cannot approve a pending send', async () => {
  const app = messagesApp();
  const phone = await harness(app.portal, { selector: navigator });
  try {
    await phone.call('update_phone_task', voiceRequest);
    const proposal = await phone.until(() => phone.appEvents.map(event => taskEvent.safeParse(event)).flatMap(event => event.success && event.data.proposal ? [event.data.proposal] : [])[0], 'a confirmation');
    phone.speak();
    await phone.call('set_help_mode', { mode: 'guide' });
    const output = z.object({ status: z.literal('blocked'), reason: z.string() }).parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    assert.match(output.reason, /Guide mode/);
    await phone.call('set_help_mode', { mode: 'do' });
    phone.speak();
    z.object({ status: z.literal('blocked') }).loose().parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(app.sent, [], 'switching to guide mode withdrew the confirmation');
  } finally { await phone.close(); }
});
