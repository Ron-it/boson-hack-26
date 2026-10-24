import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { ActionCandidate } from '../src/mobile/actions.ts';
import type { PhoneObservation } from '../src/mobile/portal.ts';
import { PhoneTask, type PhoneRequest, type TaskStatus } from '../src/server/task.ts';
import { harness, messagesApp } from './fixtures.ts';

type Decision = { request?: Partial<PhoneRequest>; observation: PhoneObservation; candidates: ActionCandidate[] };
const decided = (candidate: ActionCandidate | undefined) => ({ actionId: candidate?.id ?? 'blocked', confidence: null, returnedModel: null });

/** A navigation model that always prefers the next useful step. It never chooses to skip confirmation. */
const navigator = {
  decide: async ({ request, observation, candidates }: Decision) => {
    const find = (pattern: RegExp) => candidates.find(candidate => pattern.test(candidate.description));
    const drafted = observation.elements.some(element => element.editable && element.text === request?.message);
    return decided((drafted ? find(/approval/i) : find(/Type the requested message/))
      || (observation.elements.some(element => element.resourceId === 'ContactSearchField' && element.text === request?.recipient) ? find(/^Tap "(Avery|Jordan)/) : find(/Type the requested recipient/))
      || find(/^Tap "Start chat"/) || find(/^Open Messages/));
  },
};

const request = { instruction: 'Send Avery a text saying synthetic hello', app: 'Messages', recipient: 'Avery', message: 'Synthetic hello from the test' };

async function prepared(options: Parameters<typeof messagesApp>[0] = {}) {
  const app = messagesApp(options);
  const statuses: TaskStatus[] = [];
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, navigator);
  await task.submit(request);
  const proposal = statuses.at(-1)?.proposal;
  assert.ok(proposal, `expected a confirmation proposal, got ${statuses.at(-1)?.state}: ${statuses.at(-1)?.detail}`);
  return { app, statuses, task, proposal };
}

const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check()); };

test('a message request prepares the draft and asks before sending, even when told to send', async () => {
  const { app, proposal } = await prepared();
  assert.deepEqual({ operation: proposal.operation, recipient: proposal.recipient, message: proposal.message }, { operation: 'send_message', recipient: 'Avery Testcontact', message: 'Synthetic hello from the test' });
  assert.equal(app.draft, 'Synthetic hello from the test');
  assert.deepEqual(app.sent, []);
  assert.equal(app.sendAttempts(), 0);
});

test('approval sends exactly once and completion rests on a new outgoing message marked sent', async () => {
  const { app, statuses, task, proposal } = await prepared();
  const first = task.answer(proposal.id, true);
  const repeated = task.answer(proposal.id, true);
  await first.settled;
  assert.equal(first.status, 'accepted');
  assert.equal(repeated.status, 'expired');
  assert.equal(task.answer(proposal.id, true).status, 'expired', 'a consumed approval cannot be replayed after sending');
  assert.deepEqual(app.sent, [{ recipient: 'Avery Testcontact', text: 'Synthetic hello from the test' }]);
  assert.equal(statuses.at(-1)?.state, 'completed');
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

test('approval is bound to the send operation and its exact control, not to whatever control is there later', async () => {
  const { app, statuses, task, proposal } = await prepared();
  app.relabelSend('Delete');
  await task.answer(proposal.id, true).settled;
  assert.equal(app.taps.includes('Delete'), false);
  assert.deepEqual(app.sent, []);
  assert.equal(statuses.at(-1)?.state, 'blocked');
});

test('controls the operator does not understand are never offered or tapped, even beside the draft', async () => {
  for (const options of [{ extraControls: ['Delete', 'Buy'] }, { sendLabel: 'OK' }, { sendLabel: 'Finish' }]) {
    const app = messagesApp(options);
    const statuses: TaskStatus[] = [];
    const offered: string[] = [];
    // Once the draft is in, this model reaches for anything final: approval, delete, buy, OK or finish.
    const eager = { decide: async (input: Decision) => {
      offered.push(...input.candidates.map(candidate => candidate.description));
      const drafted = input.observation.elements.some(element => element.editable && element.text === request.message);
      const final = input.candidates.find(candidate => /Delete|Buy|"OK"|Finish|approval/i.test(candidate.description));
      return drafted ? decided(final) : navigator.decide(input);
    } };
    const task = new PhoneTask(app.phone, status => statuses.push(status), {}, eager);
    await task.submit(request);
    const unsupported = ['Delete', 'Buy', 'OK', 'Finish'];
    assert.equal(offered.some(description => unsupported.some(label => description.includes(`"${label}"`))), false, `offered: ${offered.join('; ')}`);
    assert.equal(app.taps.some(tap => unsupported.includes(tap)), false);
    assert.deepEqual(app.sent, []);
    if (options.sendLabel) assert.equal(statuses.at(-1)?.state, 'blocked', 'an unrecognized final control hands back');
  }
});

test('an app without supported controls can be opened but none of its controls are tapped', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const offered: string[] = [];
  const tapper = { decide: async ({ observation, candidates }: Decision) => {
    offered.push(...candidates.map(candidate => candidate.description));
    const inContacts = observation.app.packageName === 'com.google.android.contacts';
    return decided(candidates.find(candidate => candidate.action.type === 'tap') ?? (inContacts ? undefined : candidates.find(candidate => candidate.action.type === 'launch')));
  } };
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, tapper);
  await task.submit({ instruction: 'Delete Avery from my contacts', app: 'Contacts' });
  assert.equal(app.taps.includes('Delete contact'), false);
  assert.equal(offered.some(description => description.includes('Delete contact')), false);
  assert.notEqual(statuses.at(-1)?.state, 'completed');
});

test('finishing a request without a supported outcome check is not reported as completed', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const opener = { decide: async ({ observation, candidates }: Decision) => decided(observation.app.packageName === 'com.google.android.apps.messaging'
    ? candidates.find(candidate => candidate.id === 'done') : candidates.find(candidate => candidate.action.type === 'launch')) };
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, opener);
  await task.submit({ instruction: 'Open Messages', app: 'Messages' });
  assert.notEqual(statuses.at(-1)?.state, 'completed');
});

test('a send whose result is lost is reported unknown and never sent again on continue', async () => {
  const { app, statuses, task, proposal } = await prepared({ sendOutcome: 'throws' });
  await task.answer(proposal.id, true).settled;
  assert.equal(statuses.at(-1)?.state, 'unknown');
  assert.equal(app.sendAttempts(), 1);
  await task.resume();
  assert.equal(app.sendAttempts(), 1, 'continuing must not tap send without a new confirmation');
  assert.equal(statuses.at(-1)?.state, 'confirming');
  assert.match(statuses.at(-1)?.detail ?? '', /may already have gone through/);
});

test('a disconnect while checking a dispatched send is unknown, not blocked', async () => {
  const { app, statuses, task, proposal } = await prepared({ disconnectAfterSend: true });
  await task.answer(proposal.id, true).settled;
  assert.equal(app.sent.length, 1);
  assert.equal(statuses.at(-1)?.state, 'unknown');
  assert.match(statuses.at(-1)?.detail ?? '', /won't send it again/);
});

test('identical earlier text, outgoing or incoming, is not evidence of a new send', async () => {
  for (const from of ['me', 'them'] as const) {
    const history = [{ recipient: 'Avery Testcontact', text: request.message, from, status: 'sent' as const }];
    const { statuses, task, proposal } = await prepared({ history, sendOutcome: 'dropped' });
    await task.answer(proposal.id, true).settled;
    assert.equal(statuses.at(-1)?.state, 'unknown', `an earlier ${from === 'me' ? 'outgoing' : 'incoming'} copy was taken as proof`);
  }
});

test('a send the app shows as pending or failed is not completed', async () => {
  for (const [sendOutcome, state] of [['sending', 'unknown'], ['failed', 'blocked']] as const) {
    const { statuses, task, proposal } = await prepared({ sendOutcome });
    await task.answer(proposal.id, true).settled;
    assert.equal(statuses.at(-1)?.state, state, sendOutcome);
  }
});

test('a pause during the post-send check emits no stale result and keeps the unknown send for inspection', async () => {
  const gate = Promise.withResolvers<void>();
  const { app, statuses, task, proposal } = await prepared({ readGate: gate.promise });
  const sending = task.answer(proposal.id, true).settled;
  await until(() => app.heldReads() > 0);
  task.pause('Manual takeover');
  const paused = statuses.length;
  gate.resolve();
  await sending;
  assert.deepEqual(statuses.slice(paused).map(status => status.state), [], 'the superseded check must not report');
  await task.resume();
  assert.equal(app.sendAttempts(), 1);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /Not sent again/);
});

test('a correction during the post-send check gets its own confirmation, not the old completion', async () => {
  const gate = Promise.withResolvers<void>();
  const { app, statuses, task, proposal } = await prepared({ readGate: gate.promise });
  const sending = task.answer(proposal.id, true).settled;
  await until(() => app.heldReads() > 0);
  const corrected = task.submit({ ...request, message: 'Synthetic corrected follow-up' });
  const revision = statuses.at(-1)?.revision;
  gate.resolve();
  await Promise.all([sending, corrected]);
  const later = statuses.filter(status => status.revision === revision);
  assert.equal(later.some(status => status.state === 'completed'), false);
  assert.equal(later.at(-1)?.state, 'confirming');
  assert.equal(later.at(-1)?.proposal?.message, 'Synthetic corrected follow-up');
  assert.match(later.map(status => status.detail).join(' '), /earlier message .* was sent/i);
});

test('a send tap that fails after a pause reports nothing into the paused request and is inspected on continue', async () => {
  const gate = Promise.withResolvers<void>();
  const { app, statuses, task, proposal } = await prepared({ tapGate: gate.promise, sendOutcome: 'throws' });
  const sending = task.answer(proposal.id, true).settled;
  await until(() => app.sendAttempts() === 1);
  task.pause('Manual takeover');
  const paused = statuses.length;
  gate.resolve();
  await sending;
  assert.deepEqual(statuses.slice(paused), []);
  await task.resume();
  assert.equal(app.sendAttempts(), 1);
  assert.match(statuses.at(-1)?.detail ?? '', /may already have gone through/);
});

test('several matching contacts lead to a question instead of a guess', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, navigator);
  await task.submit({ ...request, recipient: 'Jordan' });
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.match(statuses.at(-1)?.detail ?? '', /Jordan Testone or Jordan Testtwo/);
  assert.equal(app.taps.some(tap => tap.startsWith('Jordan')), false);
});

test('when the model asks about a contact, the question names the visible matches', async () => {
  const app = messagesApp();
  const statuses: TaskStatus[] = [];
  const asking = { decide: async (input: Decision) => input.candidates.filter(candidate => /^Tap "Jordan/.test(candidate.description)).length > 1
    ? decided(input.candidates.find(candidate => candidate.id === 'ask')) : navigator.decide(input) };
  const task = new PhoneTask(app.phone, status => statuses.push(status), {}, asking);
  await task.submit({ ...request, recipient: 'Jordan' });
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.match(statuses.at(-1)?.detail ?? '', /Jordan Testone or Jordan Testtwo/);
});

const voiceRequest = { instruction: 'Text Avery: Synthetic hello from the test', app: 'Messages', recipient: 'Avery', message: 'Synthetic hello from the test' };
const taskEvent = z.looseObject({ type: z.literal('task'), state: z.string(), detail: z.string(), proposal: z.object({ id: z.string(), recipient: z.string(), message: z.string() }).optional() });
type Harness = Awaited<ReturnType<typeof harness>>;
const proposalOf = (phone: Harness) => phone.until(() => phone.appEvents.map(event => taskEvent.safeParse(event)).flatMap(event => event.success && event.data.proposal ? [event.data.proposal] : [])[0], 'a confirmation');

test('voice asks with the concrete recipient and message, and sends only after the user answers', async () => {
  const app = messagesApp();
  const phone = await harness(app.portal, { selector: navigator });
  try {
    z.object({ status: z.literal('accepted') }).loose().parse(await phone.call('update_phone_task', voiceRequest));
    const proposal = await proposalOf(phone);
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

test('a confirmation queued when the user starts speaking is still asked aloud before it can be approved', async () => {
  const app = messagesApp();
  const phone = await harness(app.portal, { selector: navigator, holdResponses: true });
  try {
    // Boson is still speaking its reply to the request, so the confirmation waits behind it.
    await phone.call('update_phone_task', voiceRequest);
    const proposal = await proposalOf(phone);
    phone.speak();
    assert.equal(phone.announcements.some(text => text.includes(proposal.id)), false);
    z.object({ status: z.literal('blocked') }).loose().parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    phone.releaseResponses();
    await phone.until(() => phone.announcements.find(text => text.includes(proposal.id)), 'the queued confirmation to be asked');
    phone.speak();
    z.object({ status: z.literal('accepted') }).loose().parse(await phone.call('confirm_phone_action', { proposalId: proposal.id, approve: true }));
    await phone.until(() => app.sent.length === 1 || undefined, 'the send');
  } finally { await phone.close(); }
});

test('guide mode cannot approve a pending send', async () => {
  const app = messagesApp();
  const phone = await harness(app.portal, { selector: navigator });
  try {
    await phone.call('update_phone_task', voiceRequest);
    const proposal = await proposalOf(phone);
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
