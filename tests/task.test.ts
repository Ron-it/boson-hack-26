import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PhoneControl, PhoneObservation } from '../src/mobile/portal.ts';
import { PhoneTask } from '../src/server/task.ts';

test('speaking invalidates a pending decision even when its provider ignores cancellation', async () => {
  const decisionStarted = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<{ actionId: string; confidence: null; returnedModel: null }>();
  const observation: PhoneObservation = {
    app: { currentApp: 'Settings', packageName: 'com.android.settings', activityName: '' },
    rootPackage: 'com.android.settings', screen: { width: 1080, height: 2400 }, elements: [],
  };
  let mutations = 0;
  const mutate = async () => { mutations++; };
  const phone: PhoneControl = { state: async () => observation, back: mutate, tap: mutate, swipe: mutate, openSettings: mutate };
  const task = new PhoneTask(phone, () => {}, {}, { decide: async () => { decisionStarted.resolve(); return decision.promise; } });
  const run = task.start('Turn Night Light on');
  await decisionStarted.promise;
  task.pause('User started a correction');
  decision.resolve({ actionId: 'back', confidence: null, returnedModel: null });
  await run;
  assert.equal(mutations, 0);
});
