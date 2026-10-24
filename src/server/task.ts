import { actionCandidates, assertSettingsScreen, executeAction, readStableScreen, screenFingerprint } from '../mobile/actions.ts';
import type { PhoneControl } from '../mobile/portal.ts';
import { createSelector } from '../mobile/selectors.ts';

export type TaskStatus = { type: 'task'; state: 'paused' | 'working' | 'completed' | 'blocked'; goal: string; detail: string; revision: number };

/** The revision is invalidated synchronously, before awaiting a cancelled model request. */
export class PhoneTask {
  private revision = 0;
  private abort: AbortController | undefined;
  private tail: Promise<void> = Promise.resolve();
  private goal = '';
  private active = false;
  private phone: PhoneControl;
  private emit: (status: TaskStatus) => void;
  private selector: Pick<ReturnType<typeof createSelector>, 'decide'>;
  constructor(phone: PhoneControl, emit: (status: TaskStatus) => void,
    environment = process.env,
    selector: Pick<ReturnType<typeof createSelector>, 'decide'> = createSelector('openai', environment)) {
    this.phone = phone;
    this.emit = emit;
    this.selector = selector;
  }

  pause(detail = 'Paused while you speak') {
    this.revision++;
    this.abort?.abort(new Error(detail));
    this.abort = undefined;
    if (this.active) this.emit({ type: 'task', state: 'paused', goal: this.goal, detail, revision: this.revision });
    this.active = false;
  }

  start(goal: string) {
    this.pause('Replacing the previous request');
    this.goal = goal;
    this.active = true;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: 'task', state: 'working', goal, detail: 'Looking at Settings', revision });
    // An already-dispatched gesture may still be finishing. Never run two action loops together.
    this.tail = this.tail.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      try { await this.run(goal, revision, abort.signal); }
      catch (error) {
        if (!abort.signal.aborted && revision === this.revision) {
          this.active = false;
          this.emit({ type: 'task', state: 'blocked', goal, detail: error instanceof Error ? error.message : 'Phone task failed', revision });
        }
      }
    });
    return this.tail;
  }

  private async run(goal: string, revision: number, signal: AbortSignal) {
    const history: string[] = [];
    let minimumMs = 120;
    let previous: { id: string; fingerprint: string } | undefined;
    let unchanged = 0;
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    for (let step = 0; step < 16; step++) {
      check();
      const observation = await readStableScreen(this.phone, signal, minimumMs);
      assertSettingsScreen(observation);
      check();
      if (previous?.fingerprint === screenFingerprint(observation)) {
        unchanged++;
        history.push(`No visible change after ${previous.id}; try another sensible action.`);
        if (unchanged >= 2) throw new Error('No progress. Please reopen Display settings and try again.');
      } else unchanged = 0;
      const candidates = actionCandidates(observation);
      const decision = await this.selector.decide({ goal, observation, candidates, history, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      check();
      const candidate = candidates.find(item => item.id === decision.actionId);
      if (!candidate) throw new Error('Invalid phone action; stopped');
      const current = await this.phone.state();
      check();
      assertSettingsScreen(current);
      if (screenFingerprint(current) !== screenFingerprint(observation)) {
        history.push('Screen changed. Discarded the pending action and observed again.');
        continue;
      }
      if (candidate.action.type === 'done' || candidate.action.type === 'blocked') {
        this.active = false;
        const facts = observation.elements.filter(item => item.checked !== null || item.range || item.state)
          .map(item => ({ label: item.text, checked: item.checked, value: item.range?.current, state: item.state }));
        this.emit({ type: 'task', state: candidate.action.type === 'done' ? 'completed' : 'blocked', goal, revision,
          detail: candidate.action.type === 'done' ? `Observed result: ${JSON.stringify(facts)}` : 'I could not establish the requested result.' });
        return;
      }
      this.emit({ type: 'task', state: 'working', goal, detail: candidate.description, revision });
      check();
      await executeAction(this.phone, candidate);
      history.push(`Observed: ${JSON.stringify(observation.elements.filter(item => item.checked !== null || item.range).map(item => ({ label: item.text, checked: item.checked, range: item.range })))}`);
      history.push(candidate.description);
      previous = { id: candidate.id, fingerprint: screenFingerprint(observation) };
      minimumMs = candidate.action.type === 'swipe' ? 350 : 120;
    }
    throw new Error('Task reached the action limit; stopped');
  }
}
