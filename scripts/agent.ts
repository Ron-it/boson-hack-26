import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { actionCandidates, assertSettingsScreen, executeAction, readStableScreen, screenFingerprint } from '../src/mobile/actions.ts';
import { createPortal } from '../src/mobile/portal.ts';
import { createSelector, providerSchema } from '../src/mobile/selectors.ts';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { provider: { type: 'string', default: 'openai' }, execute: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } },
  });
  if (values.help || !positionals.length) {
    console.log(`Model-driven display experiment

  npm run agent -- "Set brightness to 70%"
  npm run agent -- --provider jev --execute "Set brightness to 70% and leave Night Light off"

Providers: openai (default, GPT-6.1 Sol), gemini, jev, openai-decisions.
Default: observe once and predict one action without executing it.
--execute: run up to 16 decisions in Settings. Ctrl+C stops new actions.
Uses a common action menu, not the providers' native Computer Use tools.
Model completion is a claim; independently verify the resulting phone settings.`);
    return;
  }
  const selector = createSelector(providerSchema.parse(values.provider));
  const portal = createPortal();
  const goal = positionals.join(' ');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('Stopped by user')));
  const history: string[] = [];
  const trace: unknown[] = [];
  let minimumSettleMs = 120;
  let pendingProgressCheck: { id: string; fingerprint: string } | undefined;
  let lastUnchangedAction = '';
  let unchangedCount = 0;
  const started = performance.now();
  await mkdir('artifacts', { recursive: true });
  const traceFile = `artifacts/model-${selector.provider}-${Date.now()}.json`;
  try {
    for (let step = 1; step <= (values.execute ? 16 : 1); step++) {
      controller.signal.throwIfAborted();
      const observeStarted = performance.now();
      const observation = await readStableScreen(portal, controller.signal, minimumSettleMs);
      assertSettingsScreen(observation);
      if (pendingProgressCheck) {
        const unchanged = screenFingerprint(observation) === pendingProgressCheck.fingerprint;
        if (unchanged) {
          unchangedCount = lastUnchangedAction === pendingProgressCheck.id ? unchangedCount + 1 : 1;
          lastUnchangedAction = pendingProgressCheck.id;
          history.push(`No visible screen change after ${pendingProgressCheck.id}. Repeating that action has not advanced the task.`);
          if (unchangedCount >= 2) throw new Error('The same action twice made no visible progress; stopped.');
        } else unchangedCount = 0;
        pendingProgressCheck = undefined;
      }
      const observationMs = Math.round(performance.now() - observeStarted);
      const candidates = actionCandidates(observation);
      const decideStarted = performance.now();
      const decision = await selector.decide({
        goal, observation, candidates, history,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      const decisionMs = Math.round(performance.now() - decideStarted);
      controller.signal.throwIfAborted();
      const candidate = candidates.find(candidate => candidate.id === decision.actionId);
      if (!candidate) throw new Error('The model returned an action outside the observed menu; nothing dispatched.');
      const record = { step, observationMs, decisionMs, requestedModel: selector.model, ...decision, description: candidate.description };
      trace.push({ ...record, observation, candidates });
      console.log(JSON.stringify(record));
      if (!values.execute) return;

      const current = await portal.state();
      controller.signal.throwIfAborted();
      if (screenFingerprint(current) !== screenFingerprint(observation)) {
        history.push('Screen changed while deciding. The previous decision was discarded without execution.');
        trace.push({ event: 'stale_decision_discarded', step });
        continue;
      }
      if (candidate.action.type === 'done' || candidate.action.type === 'blocked') {
        console.log(JSON.stringify({ terminal: candidate.action.type, independentlyVerified: false, elapsedMs: Math.round(performance.now() - started) }));
        return;
      }
      const observedFacts = observation.elements
        .filter(element => element.checked !== null || element.range || (!element.clickable && element.text))
        .map(element => ({ label: element.text, checked: element.checked, state: element.state, range: element.range }));
      history.push(`Observed before action: ${JSON.stringify(observedFacts)}`);
      const executeStarted = performance.now();
      await executeAction(portal, candidate);
      const executionMs = Math.round(performance.now() - executeStarted);
      history.push(`${candidate.id}: ${candidate.description}`);
      minimumSettleMs = candidate.action.type === 'swipe' ? 350 : 120;
      pendingProgressCheck = { id: candidate.id, fingerprint: screenFingerprint(observation) };
      trace.push({ event: 'action_executed', step, executionMs });
      console.log(JSON.stringify({ step, executionMs }));
    }
    if (values.execute) throw new Error('Decision limit reached. Stopped; completion has not been established.');
  } finally {
    await writeFile(traceFile, JSON.stringify({ goal, provider: selector.provider, mode: values.execute ? 'execute' : 'preview', trace }, null, 2), { flag: 'wx' });
    console.log(`Trace: ${traceFile}`);
  }
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Model experiment failed';
  for (const [name, value] of Object.entries(process.env)) {
    if (name.endsWith('_API_KEY') && value) message = message.replaceAll(value, '[redacted]');
  }
  console.error(message);
  process.exitCode = 1;
});
