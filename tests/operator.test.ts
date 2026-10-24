import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObservation, type PhoneControl, type PhoneObservation } from '../src/mobile/portal.ts';
import type { ActionCandidate } from '../src/mobile/actions.ts';
import type { Decision } from '../src/mobile/selectors.ts';
import { PhoneTask, type TaskStatus } from '../src/server/task.ts';

function node(overrides: Record<string, unknown> = {}) {
  return { resourceId: '', className: 'android.widget.FrameLayout', packageName: 'com.example.app', text: '', contentDescription: '', stateDescription: '', boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 }, isClickable: false, isCheckable: false, isChecked: false, isEnabled: true, isVisibleToUser: true, isScrollable: false, isEditable: false, isPassword: false, actionList: [], children: [], ...overrides };
}
/** One screen of a generic app: each control is a labeled clickable row, an editable field, or a switch. */
function screen(packageName: string, controls: Record<string, unknown>[], currentApp = packageName) {
  return parseObservation({ a11y_tree: node({ packageName, children: controls.map((control, index) => node({ packageName, isClickable: true, boundsInScreen: { left: 100, top: 200 + index * 150, right: 980, bottom: 300 + index * 150 }, ...control })) }),
    phone_state: { currentApp, packageName, activityName: 'Main' } });
}
function phone(state: () => PhoneObservation, overrides: Partial<PhoneControl> = {}) {
  const calls: string[] = [];
  const record = (name: string) => async (...args: unknown[]) => { calls.push(`${name}${args.length ? ` ${args.join(' ')}` : ''}`); };
  const control: PhoneControl = { state: async () => state(), tap: record('tap'), swipe: record('swipe'), back: record('back'), typeText: record('type'), launch: record('launch'),
    global: record('global'), key: record('key'), deepLink: record('deepLink'), packages: async () => [{ packageName: 'com.example.maps', label: 'Maps' }, { packageName: 'com.example.music', label: 'Music' }, { packageName: 'com.example.musicpro', label: 'Music Pro' }], ...overrides };
  return { control, calls };
}
type Pick = (input: { candidates: ActionCandidate[]; observation: PhoneObservation; history: string[] }) => Partial<Decision> & { actionId: string };
function selector(pick: Pick) {
  let decisions = 0;
  return { get decisions() { return decisions; }, decide: async (input: { candidates: ActionCandidate[]; observation: PhoneObservation; history: string[] }) => { decisions++; return { text: null, value: null, finish: false, confidence: null, returnedModel: null, ...pick(input) }; } };
}
const id = (candidates: ActionCandidate[], test: (candidate: ActionCandidate) => boolean) => candidates.find(test)?.id ?? 'blocked';

test('a pending model decision is discarded when the user pauses, even if the provider ignores cancellation', async () => {
  const started = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<{ actionId: string; confidence: null; returnedModel: null }>();
  const { control, calls } = phone(() => screen('com.example.app', [{ text: 'Next' }]));
  const task = new PhoneTask(control, () => {}, {}, { decide: async () => { started.resolve(); return decision.promise; } });
  const run = task.submit({ instruction: 'Go next' });
  await started.promise;
  task.pause('User started a correction');
  decision.resolve({ actionId: 'back', confidence: null, returnedModel: null });
  await run;
  assert.deepEqual(calls, []);
});

test('a replacement voice caller waits for the previous caller\'s in-flight gesture', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { control } = phone(() => screen('com.example.app', [{ text: 'Next' }]), { back: async () => { entered.resolve(); await release.promise; } });
  const oldRun = new PhoneTask(control, () => {}, {}, selector(() => ({ actionId: 'back' }))).submit({ instruction: 'Go back' });
  await entered.promise;
  const replacement = selector(() => ({ actionId: 'done' }));
  const newRun = new PhoneTask(control, () => {}, {}, replacement).submit({ instruction: 'Something else' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replacement.decisions, 0, 'the new caller cannot decide while the old gesture is in flight');
  release.resolve();
  await Promise.all([oldRun, newRun]);
  assert.equal(replacement.decisions, 1);
});

test('any app gets navigation and free text; irreversible controls are offered only as ask-first', async () => {
  let query = '';
  const offered: string[] = [];
  const statuses: TaskStatus[] = [];
  const { control } = phone(() => screen('com.example.maps', [
    { className: 'android.widget.EditText', text: query || 'Search here', isEditable: true, isFocused: true },
    { text: 'Directions' }, { text: 'Place order' },
  ], 'Maps'), { typeText: async text => { query = text; } });
  const pick = selector(({ candidates }) => {
    offered.push(...candidates.map(candidate => candidate.description));
    return query ? { actionId: 'done', text: 'Three coffee shops are nearby.' } : { actionId: id(candidates, candidate => candidate.action.type === 'type'), text: 'coffee near me' };
  });
  await new PhoneTask(control, status => statuses.push(status), {}, pick).submit({ instruction: 'Find coffee near me in Maps' });
  assert.ok(offered.some(description => description === 'Tap "Directions".'));
  assert.ok(offered.some(description => description.startsWith('Ask the user, then tap "Place order"')));
  assert.ok(!offered.some(description => description.startsWith('Tap "Place order"')));
  assert.equal(query, 'coffee near me');
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.equal(statuses.at(-1)?.detail, 'Three coffee shops are nearby.');
});

test('an irreversible tap is proposed first and dispatched only after approval', async () => {
  let ordered = false;
  const statuses: TaskStatus[] = [];
  const { control, calls } = phone(() => screen('com.example.shop', ordered ? [{ text: 'Order placed', isClickable: false }] : [{ text: 'Place order' }], 'Shop'),
    { tap: async (_x, y) => { calls.push(`tap ${y}`); ordered = true; } });
  const task = new PhoneTask(control, status => statuses.push(status), {}, selector(({ candidates }) =>
    ordered ? { actionId: 'done', text: 'Your order is placed.' } : { actionId: id(candidates, candidate => candidate.action.type === 'confirm_tap') }));
  await task.submit({ instruction: 'Place my order in Shop' });
  const proposal = statuses.at(-1)?.proposal;
  assert.equal(statuses.at(-1)?.state, 'confirming');
  assert.ok(proposal?.operation === 'tap' && proposal.detail === 'Tap "Place order" in Shop?');
  assert.deepEqual(calls, [], 'nothing is tapped before approval');
  await task.answer(proposal.id, true).settled;
  assert.deepEqual(calls, ['tap 250']);
  assert.equal(statuses.at(-1)?.detail, 'Your order is placed.');
});

test('after the user answers a question, the operator acts instead of asking again', async () => {
  const statuses: TaskStatus[] = [];
  const { control } = phone(() => screen('com.example.files', [{ text: 'Downloads' }, { text: 'Pictures' }]));
  const pick = selector(({ candidates }) => candidates.some(candidate => candidate.id === 'ask') ? { actionId: 'ask', text: 'Which folder?' } : { actionId: 'done', text: 'Opened Downloads.' });
  const task = new PhoneTask(control, status => statuses.push(status), {}, pick);
  await task.submit({ instruction: 'Open my folder' });
  assert.deepEqual([statuses.at(-1)?.state, statuses.at(-1)?.detail], ['question', 'Which folder?']);
  await task.submit({ instruction: 'Open my Downloads folder' });
  assert.equal(pick.decisions, 2, 'ask is not offered right after an answer');
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('a stuck task ends cleanly and the next request runs without saying continue', async () => {
  const statuses: TaskStatus[] = [];
  const { control, calls } = phone(() => screen('com.example.app', [{ text: 'Next' }], 'Example'));
  const task = new PhoneTask(control, status => statuses.push(status), {}, selector(({ candidates }) => ({ actionId: id(candidates, candidate => candidate.description === 'Tap "Next".') })));
  await task.submit({ instruction: 'Go next' });
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /stuck in Example after Tap "Next"/);
  const before = calls.length;
  await task.submit({ instruction: 'Try again' });
  assert.ok(calls.length > before);
  assert.equal(task.pausedForManualControl, false);
});

test('a control whose label ticks (a countdown) is still the same control at tap time', async () => {
  let tick = 23;
  let paused = false;
  const statuses: TaskStatus[] = [];
  const { control } = phone(() => screen('com.android.systemui', [{ text: `Clock | 2m Timer | 00:${tick--}`, resourceId: 'notification' }, { text: paused ? 'Resume' : 'Pause', resourceId: 'action' }], 'System UI'),
    { tap: async (_x, y) => { if (y === 400) paused = true; } });
  await new PhoneTask(control, status => statuses.push(status), {}, selector(({ candidates }) =>
    paused ? { actionId: 'done', text: 'The timer is paused.' } : { actionId: id(candidates, candidate => candidate.description === 'Tap "Pause".') })).submit({ instruction: 'Pause the timer' });
  assert.equal(statuses.at(-1)?.detail, 'The timer is paused.');
});

test('a screen that never holds still stops after three discarded actions instead of spending model calls', async () => {
  // The control jumps between two spots on every decision, so each re-read before the tap finds it moved.
  let moves = 0;
  const statuses: TaskStatus[] = [];
  const { control, calls } = phone(() => screen('com.example.feed', [{ text: 'Next', boundsInScreen: { left: 100, top: 200 + (moves % 2) * 600, right: 980, bottom: 300 + (moves % 2) * 600 } }], 'Feed'));
  const pick = selector(({ candidates }) => { moves++; return { actionId: id(candidates, candidate => candidate.description === 'Tap "Next".') }; });
  await new PhoneTask(control, status => statuses.push(status), {}, pick).submit({ instruction: 'Go next' });
  assert.equal(pick.decisions, 3);
  assert.deepEqual(calls, []);
  assert.match(statuses.at(-1)?.detail ?? '', /keeps changing/);
});

test('a lone native timer finishes in one model call, and an unacknowledged one is never replayed', async () => {
  const statuses: TaskStatus[] = [];
  const commands: string[] = [];
  let acknowledge = true;
  const { control } = phone(() => screen('com.example.launcher', [{ text: 'Clock' }]));
  const pick = selector(() => ({ actionId: 'set_timer', value: 30, finish: true }));
  const task = new PhoneTask(control, status => statuses.push(status), {}, pick, async (name, args) => {
    commands.push(`${name} ${JSON.stringify(args)}`);
    if (!acknowledge) throw new Error('lost');
    return { status: 'handoff', handlerPackage: 'clock' };
  });
  await task.submit({ instruction: 'Start a 30 second timer' });
  assert.equal(pick.decisions, 1);
  assert.deepEqual(commands, ['create_timer {"seconds":30,"label":""}']);
  assert.deepEqual([statuses.at(-1)?.state, statuses.at(-1)?.detail], ['completed', 'Started a 30 second timer.']);
  acknowledge = false;
  await task.submit({ instruction: 'Start a 30 second timer' });
  assert.equal(statuses.at(-1)?.state, 'unknown');
  await task.submit({ instruction: 'Start a 30 second timer' });
  assert.equal(commands.length, 2, 'an unknown Clock request is not created again');
  assert.match(statuses.at(-1)?.detail ?? '', /Check Clock/);
});

test('dark theme is a plain switch the operator taps and reads back, with no special Settings path', async () => {
  let dark = true;
  const statuses: TaskStatus[] = [];
  const { control } = phone(() => screen('com.android.systemui', [{ text: 'Dark theme', isCheckable: true, isChecked: dark }], 'System UI'), { tap: async () => { dark = !dark; } });
  await new PhoneTask(control, status => statuses.push(status), {}, selector(({ observation, candidates }) =>
    observation.elements[0]?.checked === false ? { actionId: 'done', text: 'Light mode is on.' } : { actionId: id(candidates, candidate => candidate.description.startsWith('Tap "Dark theme"')) })).submit({ instruction: 'Turn on light mode' });
  assert.equal(dark, false);
  assert.equal(statuses.at(-1)?.detail, 'Light mode is on.');
});

test('instant actions go straight to Portal with no screen read or model call', async () => {
  const statuses: TaskStatus[] = [];
  const { control, calls } = phone(() => { throw new Error('no screen read expected'); });
  const pick = selector(() => ({ actionId: 'blocked' }));
  const task = new PhoneTask(control, status => statuses.push(status), {}, pick);
  await task.quick('home');
  await task.quick('open_link', 'tel:+15551234567');
  await task.quick('open_app', 'Maps');
  assert.deepEqual(calls, ['global 2', 'deepLink tel:+15551234567', 'launch com.example.maps']);
  assert.equal(pick.decisions, 0);
  assert.equal(statuses.at(-1)?.detail, 'Opened Maps.');
});

test('open_app resolves the app by label and asks when the name is ambiguous', async () => {
  const statuses: TaskStatus[] = [];
  const histories: string[][] = [];
  const { control, calls } = phone(() => screen('com.example.launcher', [{ text: 'Widgets' }]));
  await new PhoneTask(control, status => statuses.push(status), {}, selector(({ history }) => {
    histories.push([...history]);
    return history.length ? { actionId: 'blocked', text: history.at(-1) ?? null } : { actionId: 'open_app', text: 'Mus' };
  })).submit({ instruction: 'Open my music app' });
  assert.deepEqual(calls, []);
  assert.match(statuses.at(-1)?.detail ?? '', /Which app do you mean: Music or Music Pro\?/);
});

test('Enter is not offered while a send control is visible, so a chat draft is never submitted by a key press', async () => {
  const menus: string[][] = [];
  const pick = selector(({ candidates }) => { menus.push(candidates.map(candidate => candidate.id)); return { actionId: 'blocked' }; });
  for (const controls of [[{ text: 'Search', isEditable: true }], [{ text: 'Message', isEditable: true }, { text: 'Send' }]]) {
    const { control } = phone(() => screen('com.example.chat', controls));
    await new PhoneTask(control, () => {}, {}, pick).submit({ instruction: 'Search' });
  }
  assert.ok(menus[0]?.includes('enter'));
  assert.ok(!menus[1]?.includes('enter'));
});

test('stop discards the old goal and permits a new request', async () => {
  const statuses: TaskStatus[] = [];
  const { control } = phone(() => screen('com.example.app', [{ text: 'Next' }]));
  const task = new PhoneTask(control, status => statuses.push(status), {}, selector(() => ({ actionId: 'done', text: 'Done.' })));
  task.stop();
  await task.submit({ instruction: 'A new request' });
  assert.equal(statuses.at(-1)?.state, 'completed');
});
