import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionResponse } from '../src/server/voice.ts';

test('task completion uses a supported Boson response instruction instead of a rejected system message', () => {
  const event = completionResponse({ type: 'task', state: 'completed', goal: 'Leave Night Light off', detail: 'Observed Night Light OFF', revision: 2 });
  assert.equal(event.type, 'response.create', 'Boson rejects system-role conversation items; use per-response instructions');
  assert.match(event.response.instructions, /Observed Night Light OFF/);
  assert.match(event.response.instructions, /Do not describe an action as completed until/);
});
