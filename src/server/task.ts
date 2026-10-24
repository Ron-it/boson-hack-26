import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { actionCandidates, assertSettingsScreen, executeAction, readStableScreen, screenFingerprint, type ActionCandidate } from '../mobile/actions.ts';
import { z } from 'zod';
import type { PhoneControl, PhoneObservation } from '../mobile/portal.ts';
import { createSelector } from '../mobile/selectors.ts';

/** What the user is asked to approve. Approval applies once, to exactly this payload and request revision. */
export type Proposal = { id: string; app: string; recipient: string; message: string };
export type TaskStatus = { type: 'task'; state: 'paused' | 'working' | 'confirming' | 'question' | 'declined' | 'completed' | 'blocked' | 'unknown'; goal: string; detail: string; revision: number; proposal?: Proposal };

const singleLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'Use a single line');
export const phoneRequestSchema = z.object({
  instruction: z.string().min(1).max(2000),
  brightness: z.number().min(10).max(100).optional(), nightLight: z.boolean().optional(),
  app: singleLine(80).optional(), recipient: singleLine(120).optional(), message: singleLine(1000).optional(),
});
export type PhoneRequest = z.infer<typeof phoneRequestSchema>;

type PendingProposal = Proposal & { revision: number; packageName: string; control: { label: string; resourceId: string } };
type Sent = { recipient: string; message: string };

const segments = (text: string) => text.split(' | ').map(segment => segment.trim()).filter(Boolean);
const contains = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());
const center = (bounds: PhoneObservation['rootBounds']) => ({ x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) });

/**
 * Distinct visible names, outside editable fields, for the requested recipient.
 * Names that start with the request, such as "Avery Test", outrank surrounding text like "Texting with Avery".
 */
function recipientNames(observation: PhoneObservation, recipient: string) {
  const matches = [...new Set(observation.elements.filter(element => !element.editable)
    .flatMap(element => segments(element.text)).filter(segment => contains(segment, recipient)))];
  const names = matches.filter(name => name.toLowerCase().startsWith(recipient.toLowerCase()));
  return names.length ? names : matches;
}

/** The message appears outside the compose field, the field no longer holds it, and the recipient is still shown. */
function sentEvidence(observation: PhoneObservation, sent: Sent) {
  return observation.elements.some(element => !element.editable && element.text.includes(sent.message))
    && !observation.elements.some(element => element.editable && element.text.trim() === sent.message)
    && recipientNames(observation, sent.recipient).length > 0;
}
export type NativeCommand = (...command: ['set_brightness', { percent: number }] | ['open_display' | 'read_brightness', Record<string, never>]) => Promise<unknown>;

/** Shared by every caller of one phone, so a replacement voice session cannot replay an unacknowledged mutation. */
type PhoneExecution = { tail: Promise<void>; brightnessUnknown: boolean; sendUnknown: Sent | undefined };
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
  private proposal: PendingProposal | undefined;
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
    this.execution = phoneExecutions.get(phone) ?? { tail: Promise.resolve(), brightnessUnknown: false, sendUnknown: undefined };
    phoneExecutions.set(phone, this.execution);
    this.native = native;
    this.emit = emit;
    this.selector = selector;
  }

  /**
   * Invalidates pending decisions. Speech while a confirmation waits keeps it, since the user is expected to answer;
   * everything else (pause, correction, stop, guide mode) withdraws it.
   */
  interrupt(detail = 'Paused while you speak', keepConfirmation = false) {
    if (keepConfirmation && this.proposal && !this.active) return;
    const withdrawn = this.proposal !== undefined;
    this.proposal = undefined;
    this.revision++;
    this.abort?.abort(new Error(detail));
    this.abort = undefined;
    if (this.active || withdrawn) this.emit({ type: 'task', state: 'paused', goal: this.goal, detail: withdrawn ? `${detail}. The confirmation was withdrawn; nothing was sent.` : detail, revision: this.revision });
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

  /**
   * Answers the pending confirmation. The id must name the current proposal for the current request revision,
   * and it is consumed before anything else happens, so a repeated or late approval cannot dispatch twice.
   */
  answer(proposalId: string, approve: boolean): { status: 'accepted' | 'declined' | 'expired'; settled: Promise<void> } {
    const proposal = this.proposal;
    if (!proposal || proposal.id !== proposalId || proposal.revision !== this.revision || this.active) return { status: 'expired', settled: Promise.resolve() };
    this.proposal = undefined;
    if (!approve) {
      this.finish('declined', `Not sent. The draft to ${proposal.recipient} is still in ${proposal.app}.`, this.revision);
      return { status: 'declined', settled: Promise.resolve() };
    }
    return { status: 'accepted', settled: this.schedule('Checking the draft before sending', (revision, signal) => this.send(proposal, revision, signal)) };
  }

  submit(request: PhoneRequest) {
    this.interrupt('Replacing the previous request');
    this.goal = request.instruction;
    const parsed = phoneRequestSchema.safeParse(request);
    if (!parsed.success) {
      this.request = undefined;
      this.finish('blocked', 'Please give a brightness from 10 to 100 percent, Night Light on or off, or a single-line recipient and message.', this.revision);
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

  private schedule(detail = 'Looking at the screen', work = (revision: number, signal: AbortSignal) => this.run(this.goal, revision, signal)) {
    const goal = this.goal;
    this.active = true;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: 'task', state: 'working', goal, detail, revision });
    // An already-dispatched gesture may still be finishing. Never run two action loops together.
    const tail = this.execution.tail.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      try { await work(revision, abort.signal); }
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
    const settings = request.brightness !== undefined || request.nightLight !== undefined;
    // Every screen-affecting operation is inside the same serialized tail.
    const first = await this.phone.state();
    check();
    if (!settings) {
      if (request.message && !request.recipient) { this.finish('question', 'Who should I send it to?', revision); return; }
      if (request.recipient && !request.message) { this.finish('question', `What should the message to ${request.recipient} say?`, revision); return; }
      if (request.message && !request.app) { this.finish('question', 'Which app should I send it with?', revision); return; }
      const unknown = this.execution.sendUnknown;
      if (unknown && sentEvidence(first, unknown)) {
        this.execution.sendUnknown = undefined;
        this.finish('completed', `Checked first: ${JSON.stringify(unknown.message)} already shows as sent to ${unknown.recipient}. Not sent again.`, revision); return;
      }
    }
    let apps: { packageName: string; label: string }[] = [];
    if (request.app) {
      const wanted = request.app;
      const installed = await this.phone.packages();
      check();
      const exact = installed.filter(app => app.label.toLowerCase() === wanted.toLowerCase());
      apps = exact.length ? exact : installed.filter(app => contains(app.label, wanted));
      if (!apps.length) { this.finish('blocked', `I can't find an app called ${wanted} on this phone.`, revision); return; }
      if (apps.length > 1) { this.finish('question', `Which app do you mean: ${apps.slice(0, 3).map(app => app.label).join(' or ')}?`, revision); return; }
    }
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
    if (settings && this.native) {
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
      if (settings) assertSettingsScreen(observation);
      check();
      if (previous?.fingerprint === screenFingerprint(observation)) {
        unchanged++;
        history.push(`No visible change after ${previous.id}; try another sensible action.`);
        if (unchanged >= 2) throw new Error(settings ? 'No progress. Please reopen Display settings and try again.' : 'No visible progress, so I stopped. Please check the screen.');
      } else unchanged = 0;
      const candidates = actionCandidates(observation, { request, apps });
      const decision = await this.selector.decide({ goal, request, observation, candidates, history, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      check();
      const candidate = candidates.find(item => item.id === decision.actionId);
      if (!candidate) throw new Error('Invalid phone action; stopped');
      const current = await this.phone.state();
      check();
      if (settings) assertSettingsScreen(current);
      if (screenFingerprint(current) !== screenFingerprint(observation)) {
        history.push('Screen changed. Discarded the pending action and observed again.');
        continue;
      }
      const app = current.app.currentApp;
      if (candidate.action.type === 'ask') {
        const names = request.recipient ? recipientNames(current, request.recipient) : [];
        this.finish('question', names.length > 1 ? `Which ${request.recipient} do you mean: ${names.slice(0, 3).join(' or ')}?` : `I'm not sure how to continue in ${app}. What should I do next?`, revision);
        return;
      }
      if (candidate.action.type === 'commit') {
        if (this.propose(current, candidate.action, request, revision)) return;
        history.push('The requested message is not in the compose field yet. Type it before asking for approval.');
        previous = undefined;
        continue;
      }
      const ambiguous = request.recipient && candidate.element ? this.ambiguousRecipient(candidates, candidate, request.recipient) : undefined;
      if (ambiguous) { this.finish('question', `Which ${request.recipient} do you mean: ${ambiguous.join(' or ')}?`, revision); return; }
      if (!settings && (candidate.action.type === 'done' || candidate.action.type === 'blocked')) {
        if (candidate.action.type === 'done' && !request.message) {
          this.finish('completed', `Reported done on ${app}${current.app.activityName ? ` (${current.app.activityName})` : ''}. This is the assistant's reading of the screen, not an independent check.`, revision); return;
        }
        this.finish('blocked', request.message ? `Not sent. I stopped in ${app} before the confirmation step.` : `I can't continue in ${app}. Please take over.`, revision); return;
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
          ? `Observed result: ${JSON.stringify({ brightness: this.brightnessEvidence, controls: current.elements.filter(item => item.checked !== null || item.range).map(item => ({ label: item.text, checked: item.checked, range: item.range })) })}`
          : 'The requested Settings result is not established by observed values.', revision);
        return;
      }
      this.emit({ type: 'task', state: 'working', goal, detail: candidate.description, revision });
      check();
      try { await executeAction(this.phone, candidate); }
      catch { check(); this.finish('unknown', 'Phone action outcome is unknown. Say continue to inspect before acting again.', revision); return; }
      check();
      if (settings) history.push(`Observed: ${JSON.stringify(observation.elements.filter(item => item.checked !== null || item.range).map(item => ({ label: item.text, checked: item.checked, range: item.range })))}`);
      history.push(candidate.description);
      previous = { id: candidate.id, fingerprint: screenFingerprint(observation) };
      minimumMs = candidate.action.type === 'swipe' || candidate.action.type === 'launch' ? 350 : 120;
    }
    throw new Error('Task reached the action limit; stopped');
  }

  /** Several different visible names match the requested recipient and none matches it exactly. */
  private ambiguousRecipient(candidates: ActionCandidate[], chosen: ActionCandidate, recipient: string) {
    const names = (candidate: ActionCandidate) => segments(candidate.element?.text ?? '').filter(segment => contains(segment, recipient));
    if (!names(chosen).length || names(chosen).some(name => name.toLowerCase() === recipient.toLowerCase())) return undefined;
    const all = [...new Set(candidates.filter(candidate => candidate.action.type === 'tap').flatMap(names))];
    return all.length > 1 ? all.slice(0, 3) : undefined;
  }

  /**
   * Turns a consequential control into a proposal for the user. Returns false when the draft is not ready yet.
   * Without a concrete recipient and message there is nothing specific to confirm, so the user takes over instead.
   */
  private propose(observation: PhoneObservation, control: { label: string; resourceId: string }, request: PhoneRequest, revision: number) {
    const app = observation.app.currentApp;
    if (!request.recipient || !request.message) {
      this.finish('blocked', `This step would tap ${JSON.stringify(control.label)} in ${app}. I only do steps like this after confirming a concrete recipient and message, so please do it yourself.`, revision);
      return true;
    }
    const message = request.message;
    if (!observation.elements.some(element => element.editable && element.text.trim() === message)) return false;
    const names = recipientNames(observation, request.recipient);
    const [recipient] = names;
    if (names.length !== 1 || !recipient) {
      this.finish('question', names.length ? `Which ${request.recipient} do you mean: ${names.slice(0, 3).join(' or ')}?` : `I can't see ${request.recipient} as the recipient here. Who exactly should get this?`, revision);
      return true;
    }
    const proposal: PendingProposal = { id: randomUUID(), app, recipient, message, revision, packageName: observation.app.packageName, control };
    this.proposal = proposal;
    const warning = this.execution.sendUnknown ? ' An earlier send may already have gone through.' : '';
    this.finish('confirming', `Send ${JSON.stringify(message)} to ${recipient} in ${app}?${warning}`, revision, { id: proposal.id, app, recipient, message });
    return true;
  }

  /** Dispatches an approved proposal once, after revalidating the live screen, and reports only observed results. */
  private async send(proposal: PendingProposal, revision: number, signal: AbortSignal) {
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    const current = await readStableScreen(this.phone, signal);
    check();
    const control = current.elements.find(element => element.clickable && element.enabled && element.text === proposal.control.label && element.resourceId === proposal.control.resourceId);
    const unchanged = current.app.packageName === proposal.packageName && control
      && current.elements.some(element => element.editable && element.text.trim() === proposal.message)
      && recipientNames(current, proposal.recipient).includes(proposal.recipient);
    if (!unchanged) { this.finish('blocked', 'The draft or recipient changed after you confirmed, so nothing was sent. Say continue to prepare it again.', revision); return; }
    const sent = { recipient: proposal.recipient, message: proposal.message };
    this.execution.sendUnknown = sent;
    try { await this.phone.tap(center(control.bounds).x, center(control.bounds).y); }
    catch { this.finish('unknown', `The send to ${proposal.recipient} may or may not have gone through. I won't send it again; check the conversation.`, revision); return; }
    // From here the send has been dispatched; a failed check is an unknown outcome, never a reason to retry.
    // An interruption leaves sendUnknown set, so the next run inspects before anything else.
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        await delay(250, undefined, { signal });
        if (sentEvidence(await this.phone.state(), sent)) {
          this.execution.sendUnknown = undefined;
          this.finish('completed', `Sent ${JSON.stringify(proposal.message)} to ${proposal.recipient}. It shows in the conversation.`, revision);
          return;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      this.finish('unknown', `I tapped send, but lost the phone before I could check it. The message to ${proposal.recipient} may have gone through. I won't send it again; check the conversation.`, revision);
      return;
    }
    this.finish('unknown', `I tapped send, but the message doesn't show as sent to ${proposal.recipient}. I won't send it again; check the conversation.`, revision);
  }

  private finish(state: TaskStatus['state'], detail: string, revision: number, proposal?: Proposal) {
    this.active = false;
    this.emit({ type: 'task', state, goal: this.goal, detail, revision, ...(proposal && { proposal }) });
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
