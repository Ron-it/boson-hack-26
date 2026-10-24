import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { harness, messagesApp } from './fixtures.ts';

const diagnosticSchema = z.object({
  session: z.string().uuid(), voiceTurn: z.number(), currentVoiceTurn: z.number(), category: z.string(),
  mode: z.enum(['guide', 'do']), taskState: z.string(), taskRevision: z.number().nullable(),
  awaitingContinue: z.boolean(), manualPause: z.boolean(), speaking: z.boolean(), pendingAnnouncement: z.boolean(), confirmationPending: z.boolean(),
  response: z.object({ turn: z.number(), sequence: z.number(), ownership: z.enum(['user', 'operator', 'stale', 'suppressed']) }).optional(),
  tool: z.string().optional(), result: z.string().optional(),
}).strict();

test('public multi-turn diagnostics distinguish no tool, schema rejection, guide gate and retained pause without content', async t => {
  const diagnostics: z.infer<typeof diagnosticSchema>[] = [];
  const log = t.mock.method(console, 'log', (...args: unknown[]) => {
    if (args[0] === 'Voice diagnostic:') diagnostics.push(diagnosticSchema.parse(JSON.parse(String(args[1]))));
  });
  const app = messagesApp();
  const h = await harness(app.portal);
  const privateContent = 'PRIVATE_SYNTHETIC_CONTENT_82';
  try {
    h.speak();
    h.provider({ type: 'response.created', response: { id: privateContent } });
    h.provider({ type: 'response.output_audio_transcript.done', response_id: privateContent, transcript: privateContent });
    h.provider({ type: 'response.done', response: { id: privateContent, status: 'completed', output: [] } });
    await h.until(() => diagnostics.find(event => event.category === 'no_tool'), 'completed user response without a tool');
    h.speak();
    await h.call('update_phone_task', { brightness: privateContent });
    assert.ok(diagnostics.some(event => event.result === 'schema_rejected' && event.tool === 'update_phone_task'));
    h.speak();
    await h.call(privateContent, {});
    assert.ok(diagnostics.some(event => event.result === 'unsupported' && event.tool === 'unsupported'));
    h.speak();
    await h.call('set_help_mode', { mode: 'guide' });
    h.speak();
    await h.call('update_phone_task', { instruction: privateContent, app: privateContent });
    assert.ok(diagnostics.some(event => event.result === 'guide_mode' && event.mode === 'guide'));
    h.speak();
    await h.call('set_help_mode', { mode: 'do' });
    h.speak();
    await h.call('pause_phone_task', {});
    h.speak();
    await h.call('update_phone_task', { instruction: privateContent, app: 'Messages', outcome: { kind: 'app_opened' } });
    assert.ok(diagnostics.some(event => event.category === 'operator_state' && event.taskState === 'paused' && event.awaitingContinue && event.manualPause));
    assert.ok(diagnostics.some(event => event.result === 'paused' && event.manualPause));
    await h.until(() => diagnostics.find(event => event.category === 'response_started' && event.response?.ownership === 'operator'), 'operator-owned feedback');
    h.provider({ type: 'response.created', response: { id: 'stale-response', metadata: { owner: privateContent } } });
    h.provider({ type: 'response.done', response: { id: 'stale-response', status: 'completed', output: [] } });
    await h.until(() => diagnostics.find(event => event.category === 'response_ended' && event.response?.ownership === 'stale'), 'stale response excluded from no-tool classification');
    assert.equal(diagnostics.filter(event => event.category === 'no_tool').length, 1, 'operator feedback is not a no-tool user request');
    assert.equal(JSON.stringify(diagnostics).includes(privateContent), false, 'neither request/response content nor raw provider IDs are logged');
    assert.ok(diagnostics.every(event => event.voiceTurn <= event.currentVoiceTurn));
  } finally { await h.close(); log.mock.restore(); }
});
