import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { PhoneTask, type TaskStatus } from '../src/server/task.ts';
import { parseObservation, type PhoneControl } from '../src/mobile/portal.ts';

function node(overrides: Record<string, unknown> = {}) {
  return { resourceId: '', className: 'android.widget.FrameLayout', packageName: 'com.google.android.documentsui', text: '', contentDescription: '', stateDescription: '', boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 }, isClickable: false, isCheckable: false, isChecked: false, isEnabled: true, isVisibleToUser: true, isScrollable: false, isEditable: false, isPassword: false, actionList: [], children: [], ...overrides };
}
const search = (text: string) => node({ resourceId: 'com.google.android.documentsui:id/search_src_text', className: 'android.widget.EditText', text, isClickable: true, isEditable: true, boundsInScreen: { left: 100, top: 100, right: 1000, bottom: 220 } });
const result = () => node({ resourceId: 'com.google.android.documentsui:id/item_root', isClickable: true, boundsInScreen: { left: 60, top: 500, right: 1000, bottom: 800 }, children: [node({ resourceId: 'android:id/title', text: 'Boson-Test-Mountain.png', boundsInScreen: { left: 80, top: 600, right: 980, bottom: 700 } })] });
function screen(children: ReturnType<typeof node>[]) {
  return parseObservation({ a11y_tree: node({ children }), phone_state: { currentApp: 'Files', packageName: 'com.google.android.documentsui', activityName: 'FilesActivity' } });
}
const request = { instruction: 'Find my Boson-Test images in Files', app: 'Files', values: [{ field: 'search', text: 'Boson-Test', source: { kind: 'request' as const } }], outcome: { kind: 'search_results' as const, query: 'Boson-Test' } };
function control(state: PhoneControl['state'], overrides: Partial<PhoneControl> = {}): PhoneControl {
  return { state, tap: async () => {}, swipe: async () => {}, back: async () => {}, openSettings: async () => {}, launch: async () => {}, typeText: async () => {}, packages: async () => [{ packageName: 'com.google.android.documentsui', label: 'Files' }], ...overrides };
}

test('the public operator searches an app with requested text and reports fresh supported results', async () => {
  let query = '';
  const typed: string[] = [];
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { typed.push(text); query = text; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: query ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  await task.submit(request);
  assert.deepEqual(typed, ['Boson-Test']);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /Boson-Test-Mountain.png/);
  const evidence = statuses.at(-1)?.evidence;
  assert.equal(evidence?.kind, 'search_results');
  assert.ok(evidence?.kind === 'search_results' && evidence.matches.includes('Boson-Test-Mountain.png'));
});

test('live unrelated content does not prevent a current search target from being used', async () => {
  let query = '';
  let tick = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), node({ text: `Refresh in ${++tick}`, boundsInScreen: { left: 0, top: 2300, right: 500, bottom: 2350 } }), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: query ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  await task.submit(request);
  assert.equal(query, 'Boson-Test');
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('screen-sourced text is refused when its exact source was never observed', async () => {
  const typed: string[] = [];
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search('')]), { typeText: async text => { typed.push(text); } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  await task.submit({ ...request, values: [{ field: 'search', text: 'Invented from screen', source: { kind: 'screen', packageName: 'com.example.mail', resourceId: 'subject', text: 'Invented from screen' } }] });
  assert.deepEqual(typed, []);
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.match(statuses.at(-1)?.detail ?? '', /source/i);
});

test('no-progress stop names the observed screen and a new request runs without continue', async () => {
  let writes = 0;
  let live = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(''), node({ text: `Live ${++live}` })]), { typeText: async () => { writes++; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  await task.submit(request);
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /Files.*search|search.*Files/i);
  assert.ok(writes <= 2);
  const before = writes;
  await task.submit({ ...request, instruction: 'Find Boson-Test instead, keep using Files' });
  assert.ok(writes > before, 'a failure does not leave the operator paused');
  assert.equal(task.pausedForManualControl, false);
});

test('any app gets generic navigation and free text, and irreversible controls only ask first', async () => {
  const typed: string[] = [];
  let offered: string[] = [];
  const statuses: TaskStatus[] = [];
  const maps = (query: string) => parseObservation({ a11y_tree: node({ packageName: 'com.example.maps', children: [
    node({ packageName: 'com.example.maps', className: 'android.widget.EditText', text: query || 'Search here', isClickable: true, isEditable: true, isFocused: true, boundsInScreen: { left: 100, top: 100, right: 1000, bottom: 220 } }),
    node({ packageName: 'com.example.maps', text: 'Directions', isClickable: true, boundsInScreen: { left: 100, top: 400, right: 500, bottom: 500 } }),
    node({ packageName: 'com.example.maps', text: 'Place order', isClickable: true, boundsInScreen: { left: 100, top: 600, right: 500, bottom: 700 } }),
  ] }), phone_state: { currentApp: 'Maps', packageName: 'com.example.maps', activityName: 'Main' } });
  let query = '';
  const phone = control(async () => maps(query), { typeText: async text => { typed.push(text); query = text; }, packages: async () => [{ packageName: 'com.example.maps', label: 'Maps' }] });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => {
    offered = candidates.map(candidate => candidate.description);
    const type = candidates.find(candidate => candidate.action.type === 'type');
    return query ? { actionId: 'done', confidence: null, returnedModel: null } : { actionId: type?.id ?? 'blocked', text: 'pizza near me', confidence: null, returnedModel: null };
  } });
  await task.submit({ instruction: 'Search Maps for pizza near me', app: 'Maps' });
  assert.ok(offered.some(description => description.includes('Directions')));
  assert.ok(offered.some(description => description.startsWith('Ask the user, then tap "Place order"')));
  assert.ok(!offered.some(description => description.startsWith('Tap "Place order"')));
  assert.deepEqual(typed, ['pizza near me']);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /Done in Maps/);
});

test('an irreversible tap is proposed first and dispatched only after approval', async () => {
  const taps: number[] = [];
  const statuses: TaskStatus[] = [];
  const shop = parseObservation({ a11y_tree: node({ packageName: 'com.example.shop', children: [
    node({ packageName: 'com.example.shop', text: 'Place order', isClickable: true, boundsInScreen: { left: 100, top: 600, right: 500, bottom: 700 } }),
  ] }), phone_state: { currentApp: 'Shop', packageName: 'com.example.shop', activityName: 'Cart' } });
  let ordered = false;
  const phone = control(async () => ordered ? parseObservation({ a11y_tree: node({ packageName: 'com.example.shop', children: [node({ packageName: 'com.example.shop', text: 'Order placed' })] }), phone_state: { currentApp: 'Shop', packageName: 'com.example.shop', activityName: 'Done' } }) : shop,
    { tap: async (_x, y) => { taps.push(y); ordered = true; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({
    actionId: ordered ? 'done' : candidates.find(candidate => candidate.action.type === 'confirm_tap')?.id ?? 'blocked', text: ordered ? 'Your order is placed.' : null, confidence: null, returnedModel: null }) });
  await task.submit({ instruction: 'Place my order in Shop' });
  const proposal = statuses.at(-1)?.proposal;
  assert.equal(statuses.at(-1)?.state, 'confirming');
  assert.ok(proposal?.operation === 'tap' && proposal.detail.includes('Place order'));
  assert.deepEqual(taps, [], 'nothing is tapped before approval');
  await task.answer(proposal.id, true).settled;
  assert.deepEqual(taps, [650]);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.equal(statuses.at(-1)?.detail, 'Your order is placed.');
});

test('after the user answers a question, the operator acts instead of asking again', async () => {
  const statuses: TaskStatus[] = [];
  let asked = 0;
  const phone = control(async () => screen([search('')]));
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => {
    const ask = candidates.find(candidate => candidate.id === 'ask');
    if (ask) { asked++; return { actionId: 'ask', text: 'Which folder?', confidence: null, returnedModel: null }; }
    return { actionId: 'done', text: 'Opened Downloads.', confidence: null, returnedModel: null };
  } });
  await task.submit({ instruction: 'Open my folder in Files' });
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.equal(statuses.at(-1)?.detail, 'Which folder?');
  await task.submit({ instruction: 'Open my Downloads folder in Files' });
  assert.equal(asked, 1, 'ask is not offered right after an answer');
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('opening requested content needs an actual selection followed by a fresh supported viewer', async () => {
  let opened = false;
  const statuses: TaskStatus[] = [];
  const viewer = parseObservation({ a11y_tree: node({ packageName: 'com.google.android.apps.photos', children: [node({ resourceId: 'com.google.android.apps.photos:id/photos_photofragment_components_background_photo_view', packageName: 'com.google.android.apps.photos', className: 'android.widget.ImageView', contentDescription: 'Photo taken on Jan 1, 1970 12:00 AM' })] }), phone_state: { currentApp: 'Photos', packageName: 'com.google.android.apps.photos', activityName: 'ViewActivity' } });
  const phone = control(async () => opened ? viewer : screen([search('Boson-Test'), result()]), { tap: async () => { opened = true; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: opened ? 'done' : candidates.find(candidate => candidate.effect?.kind === 'open_content')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  const openRequest = { ...request, outcome: { kind: 'content_opened' as const, name: 'Boson-Test-Mountain.png' } };
  await task.submit(openRequest);
  assert.equal(opened, true);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /selected.*Boson-Test-Mountain.png/);
  // Starting on an arbitrary photo must not prove the requested photo was opened.
  const noSelection: TaskStatus[] = [];
  await new PhoneTask(phone, status => noSelection.push(status), {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }).submit(openRequest);
  assert.equal(noSelection.at(-1)?.state, 'unknown');
});

test('sparse accessibility reaches the operator model with a current screenshot and full control context', async () => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d494844520000043800000960', 'hex');
  let captured = false;
  let sawImage = false;
  const phone = { ...control(async () => screen([search('')])), screenshot: async () => { captured = true; return bytes; } };
  const task = new PhoneTask(phone, () => {}, {}, { decide: async input => {
    sawImage = 'screenshot' in input && input.screenshot instanceof Uint8Array && input.screenshot.length === bytes.length;
    assert.equal(input.observation.elements[0]?.resourceId, 'com.google.android.documentsui:id/search_src_text');
    return { actionId: 'blocked', confidence: null, returnedModel: null };
  } });
  await task.submit(request);
  assert.equal(captured, true);
  assert.equal(sawImage, true);
});

test('a correction during field focus prevents the old text from being entered', async () => {
  const focused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const typed: string[] = [];
  const phone = control(async () => screen([search('')]), { tap: async () => { focused.resolve(); await release.promise; }, typeText: async text => { typed.push(text); } });
  const task = new PhoneTask(phone, () => {}, {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) });
  const run = task.submit(request);
  await focused.promise;
  task.pause('I will type it myself');
  release.resolve();
  await run;
  assert.deepEqual(typed, []);
});

test('a moved scroll container is reconsidered before a swipe', async () => {
  let moved = false;
  let swipes = 0;
  let decisions = 0;
  const phone = control(async () => screen([node({ resourceId: 'com.google.android.documentsui:id/dir_list', className: 'android.widget.ListView', isScrollable: true, actionList: [{ id: 4096, name: 'SCROLL_FORWARD' }], boundsInScreen: { left: 0, top: moved ? 800 : 400, right: 1080, bottom: 1600 } })]), { swipe: async () => { swipes++; } });
  const task = new PhoneTask(phone, () => {}, {}, { decide: async ({ candidates }) => {
    decisions++;
    const id = decisions === 1 ? candidates.find(candidate => candidate.action.type === 'swipe')?.id ?? 'blocked' : 'blocked';
    moved = true;
    return { actionId: id, confidence: null, returnedModel: null };
  } });
  await task.submit(request);
  assert.equal(swipes, 0);
  assert.equal(decisions, 2, 'the stale gesture must lead to another observation');
});

test('device observations refresh display geometry when a rotated dialog still fits the old display', async () => {
  const { harness } = await import('./fixtures.ts');
  let landscape = true;
  const png = () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(landscape ? 2400 : 1080, 16);
    bytes.writeUInt32BE(landscape ? 1080 : 2400, 20);
    return bytes.toString('base64');
  };
  const dialog = { a11y_tree: node({ boundsInScreen: { left: 60, top: 100, right: 1000, bottom: 1000 }, children: [search(''), node({ text: 'Files search' }), node({ text: 'Test dialog' })] }), phone_state: { currentApp: 'Files', packageName: 'com.google.android.documentsui', activityName: 'Dialog' } };
  const phone = await harness(method => {
    if (method === 'state') return dialog;
    if (method === 'screenshot') return png();
    throw new Error('Unexpected mutation');
  });
  try {
    const first = await phone.call('look_at_screen', { question: 'What is on screen?' });
    assert.deepEqual(z.object({ display: z.unknown() }).parse(first).display, { width: 2400, height: 1080 });
    landscape = false;
    // Rotation re-lays out the window, so even a dialog that fits both orientations moves.
    dialog.a11y_tree.boundsInScreen = { left: 70, top: 100, right: 1010, bottom: 1000 };
    const second = await phone.call('look_at_screen', { question: 'What is on screen now?' });
    assert.deepEqual(z.object({ display: z.unknown() }).parse(second).display, { width: 1080, height: 2400 });
  } finally { await phone.close(); }
});

test('text entry stops when the target field does not own keyboard focus after the tap', async () => {
  const typed: string[] = [];
  const phone = control(async () => screen([node({ ...search(''), isFocused: false })]), { typeText: async text => { typed.push(text); } });
  const statuses: TaskStatus[] = [];
  await new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }).submit(request);
  assert.deepEqual(typed, []);
  assert.notEqual(statuses.at(-1)?.state, 'completed');
});

test('capture availability changes do not make identical display dimensions appear to move', async () => {
  let query = '';
  let read = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => {
    const observed = screen([search(query), ...(query ? [result()] : [])]);
    if (observed.screen) observed.screen.source = ++read % 2 ? 'display' : 'window';
    return observed;
  }, { typeText: async text => { query = text; } });
  await new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: query ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }).submit(request);
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('a field reused in a changed parent context is not treated as the old target', async () => {
  let changed = false;
  let decisions = 0;
  const typed: string[] = [];
  const phone = control(async () => screen([node({ resourceId: changed ? 'dialog_B' : 'dialog_A', text: changed ? 'Other folder' : 'Downloads', children: [search('')] })]), { typeText: async text => { typed.push(text); } });
  const task = new PhoneTask(phone, () => {}, {}, { decide: async ({ candidates }) => {
    const id = ++decisions === 1 ? candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked' : 'blocked';
    changed = true;
    return { actionId: id, confidence: null, returnedModel: null };
  } });
  await task.submit(request);
  assert.deepEqual(typed, []);
  assert.equal(decisions, 2);
});

test('a blocked app outcome remains unfinished after its native setting is established', async () => {
  const statuses: TaskStatus[] = [];
  let commands = 0;
  const phone = control(async () => screen([search('')]));
  await new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async () => {
    commands++;
    return { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  }).submit({ ...request, app: undefined, mediaVolume: 40 });
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.equal(commands, 1);
  assert.equal(statuses.at(-1)?.progress?.find(step => step.id === 'media')?.state, 'completed');
  assert.equal(statuses.at(-1)?.progress?.find(step => step.id === 'app')?.state, 'blocked');
});

test('an unexpected unsupported dialog produces a grounded handoff without typing or confirming it', async () => {
  let mutations = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([node({ resourceId: 'com.google.android.documentsui:id/alertTitle', text: 'New folder' }), node({ resourceId: 'android:id/text1', className: 'android.widget.EditText', text: 'Name', isEditable: true, isClickable: true }), node({ resourceId: 'android:id/button1', text: 'OK', isClickable: true })]), { tap: async () => { mutations++; }, typeText: async () => { mutations++; } });
  await new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => {
    assert.equal(candidates.some(candidate => candidate.element?.resourceId === 'android:id/button1'), false);
    return { actionId: 'blocked', confidence: null, returnedModel: null };
  } }).submit({ instruction: 'Finish this folder screen', app: 'Files' });
  assert.equal(mutations, 0);
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /New folder/);
});

test('one current request composes native media and Files search with evidence for both', async () => {
  let query = '';
  let volume = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: query ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }, async (name, args) => {
    if (name === 'set_media_volume') { volume = Number(args.percent); return { status: 'completed', stream: 'media', requestedPercent: volume, requestedIndex: 3, observedIndex: 3, minIndex: 0, maxIndex: 10 }; }
    return { status: 'observed', stream: 'media', observedIndex: 3, minIndex: 0, maxIndex: 10 };
  });
  await task.submit({ ...request, mediaVolume: 30 });
  assert.equal(query, 'Boson-Test');
  assert.equal(volume, 30);
  assert.equal(statuses.at(-1)?.progress?.find(step => step.id === 'media')?.evidence?.kind, 'native_media');
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /media volume/i);
  assert.match(statuses.at(-1)?.detail ?? '', /Boson-Test/);
});

test('the runtime selector retains low reasoning and priority serving at the public operator', async context => {
  const bodies: { reasoning?: { effort?: string }; service_tier?: string }[] = [];
  context.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ status: 'completed', model: 'gpt-6.1-sol', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"actionId":"blocked"}' }] }] }));
  });
  await new PhoneTask(control(async () => screen([search('')])), () => {}, { OPENAI_API_KEY: 'synthetic' }).submit(request);
  assert.equal(bodies[0]?.reasoning?.effort, 'low');
  assert.equal(bodies[0]?.service_tier, 'priority');
});

test('a correction while paused between operations retains native evidence and runs only the corrected second step', async () => {
  let query = '';
  let writes = 0;
  let paused = false;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  const task = new PhoneTask(phone, status => {
    statuses.push(status);
    if (!paused && status.state === 'working' && status.progress?.some(step => step.id === 'media' && step.state === 'completed')) {
      paused = true;
      task.pause('Let me correct the search before you open it');
    }
  }, {}, { decide: async ({ candidates }) => ({ actionId: query ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }, async (name, args) => {
    if (name === 'set_media_volume') { writes++; return { status: 'completed', stream: 'media', requestedPercent: args.percent, requestedIndex: 3, observedIndex: 3, minIndex: 0, maxIndex: 10 }; }
    return { status: 'observed', stream: 'media', observedIndex: 3, minIndex: 0, maxIndex: 10 };
  });
  await task.submit({ ...request, mediaVolume: 30 });
  assert.equal(query, '');
  assert.equal(statuses.at(-1)?.state, 'paused');
  await task.submit({ ...request, instruction: 'Keep media 30%, search Boson instead', mediaVolume: 30, values: [{ field: 'search', text: 'Boson', source: { kind: 'request' } }], outcome: { kind: 'search_results', query: 'Boson' } });
  assert.equal(query, '');
  await task.resume();
  assert.equal(query, 'Boson');
  assert.equal(writes, 1);
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('a timer and an app goal complete in one run, and continuing never recreates the timer', async () => {
  let query = '';
  const creates: number[] = [];
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: query === 'Boson-Test' ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }, async (name, args) => {
    if (name === 'resolve_handler') return { status: 'observed', available: true, handlerPackage: 'test.clock' };
    if (name === 'create_timer') { creates.push(Number(args.seconds)); return { status: 'handoff', handlerPackage: 'test.clock', note: 'Event not independently verified' }; }
    throw new Error('Unexpected command');
  });
  await task.submit({ ...request, timer: { seconds: 600, label: 'Tea' } });
  assert.deepEqual(creates, [600]);
  assert.equal(query, 'Boson-Test');
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.equal(statuses.at(-1)?.progress?.find(step => step.id === 'timer')?.evidence?.kind, 'intent_handoff');
  task.pause('Manual control');
  query = 'Something else';
  await task.resume();
  assert.equal(query, 'Boson-Test', 'the UI result is rechecked and redone');
  assert.deepEqual(creates, [600], 'the timer is not created again');
});

test('a fresh supported UI outcome completes without another model decision', async () => {
  let query = '';
  let decisions = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  await new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => {
    decisions++;
    return { actionId: query ? 'done' : candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null };
  } }).submit(request);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.equal(decisions, 1, 'fresh capability evidence makes a second model call unnecessary');
});

test('lost final native readback leaves that outcome unknown while preserving the independently established UI result', async () => {
  let query = '';
  let writes = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }, async name => {
    if (name === 'read_media_volume') throw new Error('Synthetic read unavailable');
    writes++;
    return { status: 'completed', stream: 'media', requestedPercent: 30, requestedIndex: 3, observedIndex: 3, minIndex: 0, maxIndex: 10 };
  });
  await task.submit({ ...request, mediaVolume: 30 });
  assert.equal(statuses.at(-1)?.state, 'unknown');
  assert.equal(statuses.at(-1)?.progress?.find(step => step.id === 'media')?.state, 'unknown');
  assert.equal(statuses.at(-1)?.progress?.find(step => step.id === 'app')?.state, 'completed');
  await task.resume();
  assert.equal(writes, 1, 'unavailable readback never authorizes another write');
  assert.notEqual(statuses.at(-1)?.state, 'completed');
});

test('a new brightness request after the whole goal completed does not replay the previous app and media operations', async () => {
  let query = '';
  let mediaWrites = 0;
  const statuses: TaskStatus[] = [];
  const phone = control(async () => screen([search(query), ...(query ? [result()] : [])]), { typeText: async text => { query = text; } });
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async ({ candidates }) => ({ actionId: candidates.find(candidate => candidate.action.type === 'type')?.id ?? 'blocked', confidence: null, returnedModel: null }) }, async name => {
    if (name === 'set_brightness') return { status: 'completed', requestedPercent: 100, observedRawValue: 255 };
    if (name === 'set_media_volume') { mediaWrites++; return { status: 'completed', stream: 'media', requestedPercent: 30, requestedIndex: 3, observedIndex: 3, minIndex: 0, maxIndex: 10 }; }
    return { status: 'observed', stream: 'media', observedIndex: 3, minIndex: 0, maxIndex: 10 };
  });
  await task.submit({ ...request, mediaVolume: 30 });
  assert.equal(statuses.at(-1)?.state, 'completed');
  await task.setBrightness(100);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.equal(mediaWrites, 1);
  assert.equal(statuses.at(-1)?.progress, undefined);
});
