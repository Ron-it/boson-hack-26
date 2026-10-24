import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneTask, type TaskStatus } from '../src/server/task.ts';
import { type PhoneObservation, type PhoneControl } from '../src/mobile/portal.ts';

function fixture() {
  const observation: PhoneObservation = { app: { currentApp: 'Clock', packageName: 'com.android.deskclock', activityName: 'Clock' }, rootPackage: 'com.android.deskclock', rootBounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, screen: { width: 1080, height: 2400, source: 'display' }, elements: [] };
  const phone: PhoneControl = { state: async () => observation, packages: async () => [], launch: async () => {}, typeText: async () => {}, openSettings: async () => {}, tap: async () => {}, swipe: async () => {}, back: async () => {} };
  const statuses: TaskStatus[] = [];
  const commands: string[] = [];
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async (name, args) => {
    commands.push(name);
    return { status: 'completed', stream: 'media', requestedPercent: args.percent, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  });
  return { task, statuses, commands, phone };
}

test('explicit media volume is completed only by matching native readback', async () => {
  const { task, statuses, commands } = fixture();
  await task.submit({ instruction: 'Media volume 40%', mediaVolume: 40 });
  assert.deepEqual(commands, ['set_media_volume']);
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.match(statuses.at(-1)?.detail ?? '', /6.*15/);
});

test('a timer starts directly once and is never replayed', async () => {
  const { phone, statuses } = fixture();
  const commands: string[] = [];
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async name => {
    commands.push(name);
    return name === 'resolve_handler' ? { status: 'observed', available: true, handlerPackage: 'com.android.deskclock' }
      : { status: 'handoff', handlerPackage: 'com.android.deskclock', note: 'Inspect Clock.' };
  });
  await task.submit({ instruction: 'Five minute tea timer', app: 'Clock', timer: { seconds: 300, label: 'Tea' } });
  assert.deepEqual(commands, ['resolve_handler', 'create_timer'], 'no confirmation, and naming Clock adds no UI step');
  assert.equal(statuses.at(-1)?.state, 'completed');
  assert.equal(statuses.at(-1)?.proposal, undefined);
  assert.match(statuses.at(-1)?.detail ?? '', /Started a 300 second timer named "Tea"/);
  await task.resume();
  assert.equal(commands.filter(name => name === 'create_timer').length, 1);
});
test('unacknowledged media volume survives replacement sessions and is inspected before any retry', async () => {
  const { phone, statuses } = fixture();
  let writes = 0;
  let reads = 0;
  const transport = async (name: string) => {
    if (name === 'set_media_volume') { writes++; throw new Error('Lost after dispatch'); }
    reads++;
    return { status: 'observed', stream: 'media', observedIndex: 6, minIndex: 0, maxIndex: 15 };
  };
  const selector = { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) };
  const first = new PhoneTask(phone, status => statuses.push(status), {}, selector, transport);
  await first.submit({ instruction: 'Media volume 40%', mediaVolume: 40 });
  assert.equal(statuses.at(-1)?.state, 'unknown');
  first.stop();
  const replacement = new PhoneTask(phone, status => statuses.push(status), {}, selector, transport);
  await replacement.submit({ instruction: 'Media volume 40%', mediaVolume: 40 });
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('alarm ambiguity asks before mutation and explicit PM becomes device-local 24-hour values', async () => {
  const { phone, statuses } = fixture();
  const payloads: object[] = [];
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async (name, args) => {
    if (name === 'create_alarm') payloads.push(args);
    return name === 'resolve_handler' ? { status: 'observed', available: true } : { status: 'handoff', handlerPackage: 'com.android.deskclock', note: 'Inspect Clock' };
  });
  await task.submit({ instruction: 'Alarm at 7:30', alarm: { hour: 7, minute: 30, label: '' } });
  assert.equal(statuses.at(-1)?.state, 'question');
  assert.match(statuses.at(-1)?.detail ?? '', /AM or PM/);
  assert.deepEqual(payloads, []);
  await task.submit({ instruction: '7:30 PM', alarm: { hour: 7, minute: 30, period: 'pm', label: 'Call' } });
  assert.deepEqual(payloads, [{ hour: 19, minute: 30, label: 'Call' }]);
  assert.equal(statuses.at(-1)?.state, 'completed');
});
test('independent native read can finish during inference while a replacement mutation waits for ownership', async () => {
  const { phone, statuses } = fixture();
  const entered = Promise.withResolvers<void>();
  const inference = Promise.withResolvers<{ actionId: string; confidence: null; returnedModel: null }>();
  let writes = 0;
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => { entered.resolve(); return inference.promise; } }, async name => {
    if (name === 'read_media_volume') return { status: 'observed', stream: 'media', observedIndex: 6, minIndex: 0, maxIndex: 15 };
    writes++;
    return { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  });
  const old = task.submit({ instruction: 'Help with this screen' });
  await entered.promise;
  assert.equal((await task.readNative('media_volume')).status, 'observed');
  const replacement = task.submit({ instruction: 'Media volume 40%', mediaVolume: 40 });
  await Promise.resolve();
  assert.equal(writes, 0);
  inference.resolve({ actionId: 'blocked', confidence: null, returnedModel: null });
  await Promise.all([old, replacement]);
  assert.equal(writes, 1);
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('a media shortcut cannot claim a combined messaging request complete', async () => {
  const { task, statuses } = fixture();
  await task.submit({ instruction: 'Volume 40% and send hello', mediaVolume: 40, message: 'Hello' });
  assert.equal(statuses.at(-1)?.state, 'question');
});

test('native permission denial explains recovery and permits a later explicit request', async () => {
  const { phone, statuses } = fixture();
  let denied = true;
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async () => denied
    ? { status: 'blocked', reason: 'Android policy denied media volume access.' }
    : { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 });
  await task.submit({ instruction: 'Media 40%', mediaVolume: 40 });
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /Android policy denied/);
  denied = false;
  await task.submit({ instruction: 'Try media 40% after I fixed permission', mediaVolume: 40 });
  assert.equal(statuses.at(-1)?.state, 'completed');
});

test('handler denial retains the reason and gives a manual Clock fallback', async () => {
  const { phone, statuses } = fixture();
  const task = new PhoneTask(phone, status => statuses.push(status), {}, { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) }, async () => ({ status: 'blocked', reason: 'Unlock the phone first' }));
  await task.submit({ instruction: 'Tea timer', timer: { seconds: 300, label: 'Tea' } });
  assert.equal(statuses.at(-1)?.state, 'blocked');
  assert.match(statuses.at(-1)?.detail ?? '', /Unlock the phone first.*Clock/);
});
