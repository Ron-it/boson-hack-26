import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PhoneControl, PhoneObservation } from '../src/mobile/portal.ts';
import { PhoneTask } from '../src/server/task.ts';

test('speaking invalidates a pending decision even when its provider ignores cancellation', async () => {
  const decisionStarted = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<{ actionId: string; confidence: null; returnedModel: null }>();
  const observation: PhoneObservation = {
    app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' },
    rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    screen: { width: 1080, height: 2400, source: 'display' }, elements: [],
  };
  let mutations = 0;
  const mutate = async () => { mutations++; };
  const phone: PhoneControl = { state: async () => observation, back: mutate, tap: mutate, swipe: mutate, openSettings: mutate };
  const task = new PhoneTask(phone, () => {}, {}, { decide: async () => { decisionStarted.resolve(); return decision.promise; } });
  const run = task.submit({ instruction: 'Turn Night Light on', nightLight: true });
  await decisionStarted.promise;
  task.pause('User started a correction');
  decision.resolve({ actionId: 'back', confidence: null, returnedModel: null });
  await run;
  assert.equal(mutations, 0);
});

test('explicit pause holds revised native work until continue and requires observed brightness', async () => {
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  let commands = 0;
  const phone: PhoneControl = { state: async () => ({ app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] }), back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }, async () => { commands++; return { status: 'completed' }; });
  task.pause('Manual takeover');
  await task.submit({ instruction: 'Brightness 40%', brightness: 40 });
  assert.equal(commands, 0);
  await task.resume();
  assert.equal(commands, 1);
  assert.equal(statuses.at(-1)?.state, 'blocked', 'an acknowledgement without readback cannot prove completion');
});

test('a combined Settings completion rechecks brightness after UI changes', async () => {
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  const observation: PhoneObservation = { app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [{ index: 0, parent: null, resourceId: 'night', className: 'Switch', role: 'Switch', text: 'Night Light', bounds: { left: 0, right: 100, top: 0, bottom: 100 }, clickable: true, enabled: true, checked: true, state: '', editable: false, scrollable: false, scrollDirections: { up: false, down: false }, range: null }] };
  const phone: PhoneControl = { state: async () => observation, back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }, async (name, _args) => name === 'set_brightness' ? { status: 'completed', requestedPercent: 40, observedRawValue: 14 } : { status: 'observed', observedRawValue: 200 });
  await task.submit({ instruction: 'Brightness 40% and Night Light on', brightness: 40, nightLight: true });
  assert.equal(statuses.at(-1)?.state, 'blocked', 'the earlier native readback does not prove brightness at UI completion');
});

test('brightness permission denial falls back to evidenced Settings in the same operator', async () => {
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  const observation: PhoneObservation = { app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [{ index: 0, parent: null, resourceId: 'brightness', className: 'SeekBar', role: 'SeekBar', text: 'Brightness', bounds: { left: 0, right: 100, top: 0, bottom: 100 }, clickable: true, enabled: true, checked: null, state: '', editable: false, scrollable: false, scrollDirections: { up: false, down: false }, range: { type: 1, min: 0, max: 100, current: 40 } }] };
  const phone: PhoneControl = { state: async () => observation, back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }, async () => ({ status: 'blocked', reason: 'Synthetic permission denial' }));
  await task.submit({ instruction: 'Brightness 40%', brightness: 40 });
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /"brightness":40/);
});

test('invalid native targets are rejected before a phone mutation', async () => {
  let mutations = 0;
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  const phone: PhoneControl = { state: async () => ({ app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] }), back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async () => { mutations++; return {}; });
  await task.submit({ instruction: 'Synthetic invalid brightness', brightness: 200 });
  assert.equal(mutations, 0);
  assert.equal(statuses.at(-1)?.state, 'blocked');
});

test('a replacement voice caller shares the phone scheduler with an in-flight UI gesture', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let nativeStarted = false;
  const observation: PhoneObservation = { app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] };
  const phone: PhoneControl = { state: async () => observation, back: async () => { entered.resolve(); await release.promise; }, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const oldCaller = new PhoneTask(phone, () => {}, {}, { decide: async () => ({ actionId: 'back', confidence: null, returnedModel: null }) });
  const oldRun = oldCaller.submit({ instruction: 'Night Light on', nightLight: true });
  await entered.promise;
  oldCaller.stop();
  const newCaller = new PhoneTask(phone, () => {}, {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }, async () => { nativeStarted = true; return { status: 'completed', requestedPercent: 40, observedRawValue: 14 }; });
  const newRun = newCaller.submit({ instruction: 'Brightness 40%', brightness: 40 });
  await new Promise(resolve => setImmediate(resolve));
  const raced = nativeStarted;
  release.resolve();
  await Promise.all([oldRun, newRun]);
  assert.equal(raced, false, 'native work cannot race a gesture from the previous voice caller');
  assert.equal(nativeStarted, true);
});

test('a timed-out brightness mutation is inspected on continue without being replayed', async () => {
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  let writes = 0;
  let observed = 0;
  const observation: PhoneObservation = { app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] };
  const phone: PhoneControl = { state: async () => { observed++; return observation; }, back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }, async (name, _args) => {
    if (name === 'set_brightness') { writes++; throw new Error('Synthetic transport timeout after dispatch'); }
    return name === 'read_brightness' ? { status: 'observed', observedRawValue: 14 } : { status: 'opened' };
  });
  await task.submit({ instruction: 'Brightness 40%', brightness: 40 });
  assert.equal(statuses.at(-1)?.state, 'unknown');
  const readsBeforeContinue = observed;
  await task.resume();
  assert.equal(writes, 1);
  assert.ok(observed > readsBeforeContinue);
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('revising an unknown brightness request inspects the outcome before another write', async () => {
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  let writes = 0;
  const phone: PhoneControl = { state: async () => ({ app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] }), back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'done', confidence: null, returnedModel: null }) }, async (name, _args) => {
    if (name === 'set_brightness') { writes++; throw new Error('Synthetic connection timeout'); }
    return { status: 'observed', observedRawValue: 14 };
  });
  await task.submit({ instruction: 'Brightness 40%', brightness: 40 });
  await task.submit({ instruction: 'Still brightness 40%', brightness: 40 });
  assert.equal(writes, 1, 'a model repeating the request must not blindly retry an unknown mutation');
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('stop discards the old goal and permits a new explicit request', async () => {
  const statuses: import('../src/server/task.ts').TaskStatus[] = [];
  const phone: PhoneControl = { state: async () => ({ app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' }, rootPackage: 'com.android.settings', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] }), back: async () => {}, tap: async () => {}, swipe: async () => {}, openSettings: async () => {} };
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async () => ({ status: 'completed', requestedPercent: 40, observedRawValue: 14 }));
  task.stop();
  await task.submit({ instruction: 'A new brightness request: 40%', brightness: 40 });
  assert.equal(statuses.at(-1)?.state, 'completed');
});
