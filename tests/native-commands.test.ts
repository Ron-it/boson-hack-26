import assert from 'node:assert/strict';
import test from 'node:test';
import { executeNativeCommand } from '../src/server/native-commands.ts';

test('media volume uses explicit stream and preserves matching Android readback', async () => {
  const reply = await executeNativeCommand({ name: 'set_media_volume', args: { percent: 40 } }, async (name, args) => {
    assert.equal(name, 'set_media_volume');
    assert.deepEqual(args, { percent: 40 });
    return { status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 6, minIndex: 0, maxIndex: 15 };
  });
  assert.equal(reply.status, 'completed');
});

test('an acknowledgement for a different volume cannot establish the requested result', async () => {
  await assert.rejects(executeNativeCommand({ name: 'set_media_volume', args: { percent: 40 } }, async () => ({
    status: 'completed', stream: 'media', requestedPercent: 40, requestedIndex: 6, observedIndex: 10, minIndex: 0, maxIndex: 15,
  })), /matching Android readback/);
});

test('timer handoff cannot become completed native evidence', async () => {
  const result = await executeNativeCommand({ name: 'create_timer', args: { seconds: 300, label: 'Tea' } }, async (name, args) => {
    assert.equal(name, 'create_timer');
    assert.deepEqual(args, { seconds: 300, label: 'Tea' });
    return { status: 'handoff', handlerPackage: 'com.android.deskclock', note: 'Inspect Clock before reporting a timer.' };
  });
  assert.equal(result.status, 'handoff');
});

test('alarm uses an explicit local 24-hour time and rejects a completed intent claim', async () => {
  const request = { name: 'create_alarm', args: { hour: 14, minute: 30, label: 'Call' } } as const;
  await assert.rejects(executeNativeCommand(request, async () => ({ status: 'completed' })));
  assert.equal((await executeNativeCommand(request, async () => ({ status: 'handoff', handlerPackage: 'clock', note: 'Inspect the resulting alarm.' }))).status, 'handoff');
});

test('handler availability is observed separately from launching Clock', async () => {
  const result = await executeNativeCommand({ name: 'resolve_handler', args: { target: 'timer' } }, async () => ({ status: 'observed', available: false }));
  assert.deepEqual(result, { status: 'observed', available: false });
});

test('a lost native outcome remains unknown and is never retried', async () => {
  let dispatched = 0;
  const result = await executeNativeCommand({ name: 'create_timer', args: { seconds: 60, label: '' } }, async () => {
    dispatched++;
    throw new Error('Disconnected');
  });
  assert.equal(result.status, 'unknown');
  assert.equal(dispatched, 1);
});

test('undeclared intent extras are rejected before dispatch and native denial remains blocked', async () => {
  let dispatched = false;
  const unsafeRequest = { name: 'create_timer', args: { seconds: 60, label: '', skipUi: true } } as const;
  await assert.rejects(executeNativeCommand(unsafeRequest, async () => { dispatched = true; }));
  assert.equal(dispatched, false);
  assert.deepEqual(await executeNativeCommand({ name: 'create_alarm', args: { hour: 14, minute: 30, label: '' } }, async () => ({ status: 'blocked', reason: 'No Clock handler' })), { status: 'blocked', reason: 'No Clock handler' });
});

test('an impossible native volume range is not accepted as observed state', async () => {
  await assert.rejects(executeNativeCommand({ name: 'read_media_volume', args: {} }, async () => ({
    status: 'observed', stream: 'media', observedIndex: 16, minIndex: 0, maxIndex: 15,
  })), /volume range/);
});
