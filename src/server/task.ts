import { actionCandidates, assertSettingsScreen, executeAction, readStableScreen, screenFingerprint } from '../mobile/actions.ts';
import { z } from 'zod';
import type { PhoneControl, PhoneObservation } from '../mobile/portal.ts';
import { createSelector } from '../mobile/selectors.ts';

export type TaskStatus = { type: 'task'; state: 'paused' | 'working' | 'completed' | 'blocked' | 'unknown'; goal: string; detail: string; revision: number };

export const phoneRequestSchema = z.object({ instruction: z.string().min(1).max(2000), brightness: z.number().min(10).max(100).optional(), nightLight: z.boolean().optional() }).refine(value => value.brightness !== undefined || value.nightLight !== undefined, 'Supply the complete requested brightness and/or Night Light targets');
export type PhoneRequest = z.infer<typeof phoneRequestSchema>;
export type NativeCommand = (...command: ['set_brightness', { percent: number }] | ['open_display' | 'read_brightness', Record<string, never>]) => Promise<unknown>;

type PhoneExecution = { tail: Promise<void>; brightnessUnknown: boolean };
const phoneExecutions = new WeakMap<PhoneControl, PhoneExecution>();

/** The revision is invalidated synchronously, before awaiting a cancelled model request. */
export class PhoneTask {
  private revision = 0;
  private abort: AbortController | undefined;
  private goal = '';
  private active = false;
  private explicitlyPaused = false;
  private request: PhoneRequest | undefined;
  private nativePending = false;
  private brightnessEvidence: number | undefined;
  private phone: PhoneControl;
  private execution: PhoneExecution;
  private native: NativeCommand | undefined;
  private emit: (status: TaskStatus) => void;
  private selector: Pick<ReturnType<typeof createSelector>, 'decide'>;
  constructor(phone: PhoneControl, emit: (status: TaskStatus) => void,
    environment = process.env,
    selector: Pick<ReturnType<typeof createSelector>, 'decide'> = createSelector('openai', environment),
    native?: NativeCommand) {
    this.phone = phone;
    this.execution = phoneExecutions.get(phone) ?? { tail: Promise.resolve(), brightnessUnknown: false };
    phoneExecutions.set(phone, this.execution);
    this.native = native;
    this.emit = emit;
    this.selector = selector;
  }

  interrupt(detail = 'Paused while you speak') {
    this.revision++;
    this.abort?.abort(new Error(detail));
    this.abort = undefined;
    if (this.active) this.emit({ type: 'task', state: 'paused', goal: this.goal, detail, revision: this.revision });
    this.active = false;
  }

  pause(detail = 'Paused for manual control. Say continue when ready.') {
    this.explicitlyPaused = true;
    this.interrupt(detail);
  }

  stop() {
    this.interrupt('Stopped by request');
    this.explicitlyPaused = false;
    this.request = undefined;
  }

  submit(request: PhoneRequest) {
    this.interrupt('Replacing the previous request');
    this.goal = request.instruction;
    const parsed = phoneRequestSchema.safeParse(request);
    if (!parsed.success) {
      this.request = undefined;
      this.finish('blocked', 'Please provide a brightness from 10 to 100 percent and/or Night Light on or off.', this.revision);
      return Promise.resolve();
    }
    this.request = parsed.data;
    this.nativePending = request.brightness !== undefined && this.native !== undefined;
    this.brightnessEvidence = undefined;
    if (this.explicitlyPaused) {
      this.emit({ type: 'task', state: 'paused', goal: this.goal, detail: 'Request updated. Say continue when ready.', revision: this.revision });
      return Promise.resolve();
    }
    return this.schedule();
  }

  setBrightness(percent: number) {
    return this.submit({ ...this.request, instruction: this.request?.nightLight === undefined ? `Set brightness to ${percent}%` : `Set brightness to ${percent}%, retaining Night Light ${this.request.nightLight ? 'on' : 'off'}`, brightness: percent });
  }

  resume() {
    this.explicitlyPaused = false;
    this.interrupt('Continuing from the current phone state');
    return this.request ? this.schedule() : Promise.resolve();
  }

  private schedule() {
    const goal = this.goal;
    this.active = true;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: 'task', state: 'working', goal, detail: 'Looking at Settings', revision });
    // An already-dispatched gesture may still be finishing. Never run two action loops together.
    const tail = this.execution.tail.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      try { await this.run(goal, revision, abort.signal); }
      catch (error) {
        if (!abort.signal.aborted && revision === this.revision) {
          this.active = false;
          this.emit({ type: 'task', state: 'blocked', goal, detail: error instanceof Error ? error.message : 'Phone task failed', revision });
        }
      }
    });
    this.execution.tail = tail;
    return tail;
  }

  private async run(goal: string, revision: number, signal: AbortSignal) {
    const request = this.request;
    if (!request) return;
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    // Every screen-affecting operation is inside the same serialized tail.
    await this.phone.state();
    check();
    if (this.execution.brightnessUnknown && this.native && request.brightness !== undefined) {
      // A repeated model tool call is not permission to replay an unacknowledged write.
      let raw: unknown;
      try { raw = await this.native('read_brightness', {}); }
      catch { check(); this.finish('unknown', 'Could not inspect the previous brightness outcome. No write retried.', revision); return; }
      const result = z.object({ status: z.literal('observed'), observedRawValue: z.number() }).safeParse(raw);
      check();
      if (!result.success) { this.finish('unknown', 'Could not inspect the previous brightness outcome. No write retried.', revision); return; }
      this.execution.brightnessUnknown = false;
      if (result.data.observedRawValue === this.expectedBrightness(request.brightness)) {
        this.nativePending = false;
        this.brightnessEvidence = request.brightness;
        if (request.nightLight === undefined) {
          this.finish('completed', `Observed Android brightness raw value ${result.data.observedRawValue} for requested ${request.brightness}%. Adaptive brightness remains unchanged.`, revision); return;
        }
      }
    }
    if (this.nativePending && this.native && request.brightness !== undefined) {
      this.nativePending = false; // Once dispatched, never replay this mutation on continue.
      let result: unknown;
      this.execution.brightnessUnknown = true;
      try { result = await this.native('set_brightness', { percent: request.brightness }); }
      catch { check(); this.finish('unknown', 'Brightness command outcome is unknown. Say continue to inspect Settings.', revision); return; }
      check();
      const reply = z.object({ status: z.literal('completed'), requestedPercent: z.number(), observedRawValue: z.number() }).safeParse(result);
      const expected = this.expectedBrightness(request.brightness);
      const denied = z.object({ status: z.literal('blocked'), reason: z.string() }).safeParse(result).success;
      if (!denied && (!reply.success || reply.data.requestedPercent !== request.brightness || reply.data.observedRawValue !== expected)) {
        this.finish('blocked', 'Brightness was not established by a matching Android readback. Use Settings or check permission.', revision); return;
      }
      if (!denied) { this.execution.brightnessUnknown = false; this.brightnessEvidence = request.brightness; }
      if (!denied && request.nightLight === undefined) {
        this.finish('completed', `Observed Android brightness raw value ${expected} for requested ${request.brightness}%. Adaptive brightness remains unchanged.`, revision); return;
      }
    }
    if (this.native) {
      check();
      try { await this.native('open_display', {}); }
      catch { check(); this.finish('unknown', 'Opening Settings was not acknowledged. Say continue to inspect the phone.', revision); return; }
      check();
    }
    const history: string[] = [];
    let minimumMs = 120;
    let previous: { id: string; fingerprint: string } | undefined;
    let unchanged = 0;
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
        if (candidate.action.type === 'done' && request.brightness !== undefined && this.native) {
          this.brightnessEvidence = undefined;
          const result = z.object({ status: z.literal('observed'), observedRawValue: z.number() }).safeParse(await this.native('read_brightness', {}));
          check();
          if (result.success) this.execution.brightnessUnknown = false;
          if (result.success && result.data.observedRawValue === this.expectedBrightness(request.brightness)) this.brightnessEvidence = request.brightness;
        }
        const verified = candidate.action.type === 'done' && this.matchesRequest(current, request);
        this.finish(verified ? 'completed' : 'blocked', verified
          ? `Observed result: ${JSON.stringify({ brightness: request.brightness, nightLight: request.nightLight })}`
          : 'The requested Settings result is not established by observed values.', revision);
        return;
      }
      this.emit({ type: 'task', state: 'working', goal, detail: candidate.description, revision });
      check();
      try { await executeAction(this.phone, candidate); }
      catch { check(); this.finish('unknown', 'Phone action outcome is unknown. Say continue to inspect before acting again.', revision); return; }
      check();
      history.push(`Observed: ${JSON.stringify(observation.elements.filter(item => item.checked !== null || item.range).map(item => ({ label: item.text, checked: item.checked, range: item.range })))}`);
      history.push(candidate.description);
      previous = { id: candidate.id, fingerprint: screenFingerprint(observation) };
      minimumMs = candidate.action.type === 'swipe' ? 350 : 120;
    }
    throw new Error('Task reached the action limit; stopped');
  }

  private finish(state: TaskStatus['state'], detail: string, revision: number) {
    this.active = false;
    this.emit({ type: 'task', state, goal: this.goal, detail, revision });
  }

  private expectedBrightness(percent: number) {
    const normalized = percent / 100;
    const linear = (normalized <= 0.5 ? (normalized / 0.5) ** 2 : Math.exp((normalized - 0.55991073) / 0.17883277) + 0.28466892) / 12;
    return Math.max(1, Math.min(255, Math.round(linear * 255)));
  }

  private matchesRequest(observation: PhoneObservation, request: PhoneRequest) {
    // Fail closed when voice has not supplied concrete Settings targets.
    if (request.brightness === undefined && request.nightLight === undefined) return false;
    const targetBrightness = request.brightness;
    const brightness = targetBrightness === undefined || this.brightnessEvidence === targetBrightness || observation.elements.some(item => {
      if (!/brightness/i.test(item.text) || !item.range || item.range.min === null || item.range.max === null || item.range.current === null || item.range.max <= item.range.min) return false;
      const percent = (item.range.current - item.range.min) / (item.range.max - item.range.min) * 100;
      return Math.abs(percent - targetBrightness) <= 1;
    });
    const nightLight = request.nightLight === undefined || observation.elements.some(item => /night light/i.test(item.text) && item.checked === request.nightLight);
    return brightness && nightLight;
  }
}
