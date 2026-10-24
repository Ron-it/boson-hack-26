import test from 'node:test';
import assert from 'node:assert/strict';
import { executeNativeCommand } from '../src/server/native-commands.ts';

test('a native write is completed only by its declared acknowledgement, and a denial keeps its reason', async () => {
  assert.deepEqual(await executeNativeCommand({ name: 'create_timer', args: { seconds: 300, label: 'Tea' } }, async () => ({ status: 'handoff', handlerPackage: 'clock' })), { status: 'completed' });
  assert.deepEqual(await executeNativeCommand({ name: 'set_media_volume', args: { percent: 40 } }, async () => ({ status: 'completed', observedIndex: 6 })), { status: 'completed' });
  assert.deepEqual(await executeNativeCommand({ name: 'set_brightness', args: { percent: 40 } }, async () => ({ status: 'blocked', reason: 'Enable brightness control' })), { status: 'blocked', reason: 'Enable brightness control' });
});

test('a lost or mismatched native acknowledgement is unknown, never completed', async () => {
  for (const reply of [Promise.reject(new Error('lost')), Promise.resolve({ status: 'completed' }), Promise.resolve('garbage')]) {
    assert.deepEqual(await executeNativeCommand({ name: 'create_alarm', args: { hour: 7, minute: 30, label: '' } }, () => reply), { status: 'unknown' });
  }
});

test('undeclared native arguments are rejected before dispatch', async () => {
  let sent = false;
  // @ts-expect-error the schema is strict; extras such as skipUi never reach the phone
  await assert.rejects(executeNativeCommand({ name: 'create_timer', args: { seconds: 60, label: '', skipUi: true } }, async () => { sent = true; }));
  assert.equal(sent, false);
});
