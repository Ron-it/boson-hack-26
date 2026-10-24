import { measure, timing } from './timing.ts';
import { executeNativeCommand, type NativeCommandRequest, type NativeTransport } from './native-commands.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { actionCandidates, executeAction, readStableScreen, progressFingerprint, targetIsCurrent, type ActionCandidate, type NativeTool } from '../mobile/actions.ts';
import { globalActions, type GlobalAction, type PhoneControl, type PhoneObservation } from '../mobile/portal.ts';
import { createSelector, type Decision } from '../mobile/selectors.ts';
import { capabilityFor, type Outgoing } from '../mobile/capabilities.ts';

/** What the user is asked to approve. Approval applies once, to exactly this payload and request revision. */
type MessageProposal = { id: string; operation: 'send_message'; app: string; recipient: string; message: string; detail?: never };
/** An irreversible tap in any app, asked in plain words. */
type TapProposal = { id: string; operation: 'tap'; app: string; label: string; detail: string; recipient?: never; message?: never };
export type Proposal = MessageProposal | TapProposal;
export type TaskStatus = { type: 'task'; state: 'paused' | 'working' | 'confirming' | 'question' | 'declined' | 'completed' | 'blocked' | 'unknown'; goal: string; detail: string; revision: number; awaitingContinue?: true; proposal?: Proposal };

const singleLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'Use a single line');
/**
 * The user's goal in their own words. The operator decides how to reach it; only a message's recipient and wording
 * are structured, because those must come from the user and never from the model or the screen.
 */
export const phoneRequestSchema = z.object({
  instruction: z.string().min(1).max(2000),
  app: singleLine(80).optional(), recipient: singleLine(120).optional(), message: singleLine(1000).optional(),
  /** Only open the app; Portal launches it and no model call is needed. */
  outcome: z.literal('app_opened').optional(),
});
export type PhoneRequest = z.infer<typeof phoneRequestSchema>;

/** The exact control the user approved. Approval never transfers to another control or app. */
type Target = { packageName: string; resourceId: string; label: string };
type PendingMessage = MessageProposal & { revision: number; target: Target };
type PendingTap = TapProposal & { revision: number; packageName: string };
type Counts = Record<Outgoing['status'], number>;
/** A dispatched send, with the outgoing copies of its text that were already on screen just before the tap. */
type Sent = { recipient: string; message: string; packageName: string; before: Counts };
type ToolResult = { state: 'completed' | 'blocked' | 'unknown' | 'question'; detail: string };

const segments = (text: string) => text.split(' | ').map(segment => segment.trim()).filter(Boolean);
const contains = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());
const center = (bounds: PhoneObservation['rootBounds']) => ({ x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) });
const inForeground = (observation: PhoneObservation, packageName: string) => observation.app.packageName === packageName && observation.rootPackage === packageName;

/** Reads and model calls are safe to repeat; one hiccup should not end the task. Mutations never go through this. */
async function retrying<T>(signal: AbortSignal, work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await work(); }
    catch (error) { if (signal.aborted || attempt >= attempts) throw error; await delay(250 * attempt, undefined, { signal }); }
  }
}

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

/** Outgoing copies of the message by delivery state, or undefined when the app's sent messages are not understood. */
function outgoingCounts(observation: PhoneObservation, message: string): Counts | undefined {
  const outgoing = capabilityFor(observation).outgoing?.(observation);
  if (!outgoing) return undefined;
  const counts: Counts = { sent: 0, sending: 0, failed: 0 };
  for (const item of outgoing) if (item.text.trim() === message) counts[item.status]++;
  return counts;
}

/** A new outgoing copy beyond the pre-send baseline, in the same app and conversation. Earlier or incoming text is not evidence. */
function sendResult(observation: PhoneObservation, sent: Sent): Outgoing['status'] | 'none' {
  const counts = outgoingCounts(observation, sent.message);
  if (!counts || observation.app.packageName !== sent.packageName || !recipientNames(observation, sent.recipient).includes(sent.recipient)) return 'none';
  if (counts.sent > sent.before.sent) return 'sent';
  if (counts.failed > sent.before.failed) return 'failed';
  return counts.sending > sent.before.sending ? 'sending' : 'none';
}

/** Shared by every caller of one phone, so a replacement voice session cannot replay an unacknowledged mutation. */
type PhoneExecution = { tail: Promise<void>; sendUnknown: Sent | undefined; clockUnknown: boolean };
const phoneExecutions = new WeakMap<PhoneControl, PhoneExecution>();

/** The revision is invalidated synchronously, before awaiting a cancelled model request. */
export class PhoneTask {
  private timingOwner = randomUUID();
  private revision = 0;
  private abort: AbortController | undefined;
  private goal = '';
  private active = false;
  private explicitlyPaused = false;
  private request: PhoneRequest | undefined;
  private proposal: PendingMessage | PendingTap | undefined;
  /** Irreversible taps the user approved for the current goal, by app and label. */
  private approvedTaps = new Set<string>();
  /** The question the operator last asked; the next request carries the user's answer. */
  private lastQuestion: string | undefined;
  private answered: string | undefined;
  private phone: PhoneControl;
  private execution: PhoneExecution;
  private native: NativeTransport | undefined;
  private emit: (status: TaskStatus) => void;
  private selector: Pick<ReturnType<typeof createSelector>, 'decide'>;
  constructor(phone: PhoneControl, emit: (status: TaskStatus) => void,
    environment = process.env,
    selector: Pick<ReturnType<typeof createSelector>, 'decide'> = createSelector(environment),
    native?: NativeTransport) {
    const screenshot = phone.screenshot;
    this.phone = { ...phone,
      state: () => measure(this.timingContext(), 'state', () => phone.state()),
      ...(screenshot && { screenshot: () => measure(this.timingContext(), 'screenshot', () => screenshot()) }),
    };
    this.execution = phoneExecutions.get(phone) ?? { tail: Promise.resolve(), sendUnknown: undefined, clockUnknown: false };
    phoneExecutions.set(phone, this.execution);
    this.native = native && ((name, args) => measure(this.timingContext(), `native_${name}`, () => native(name, args)));
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
    if (this.active || withdrawn) this.emit({ type: 'task', state: 'paused', goal: this.goal, detail: withdrawn ? `${detail}. The confirmation was withdrawn; nothing was submitted.` : detail, revision: this.revision });
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
      this.finish('declined', proposal.operation === 'send_message' ? `Not sent. The draft to ${proposal.recipient} is still in ${proposal.app}.`
        : `Okay, I didn't tap ${JSON.stringify(proposal.label)}.`, this.revision);
      return { status: 'declined', settled: Promise.resolve() };
    }
    if (proposal.operation === 'tap') {
      // The operator observes again and taps the approved control itself, so a changed screen is never tapped blindly.
      this.approvedTaps.add(`${proposal.packageName}|${proposal.label}`);
      return { status: 'accepted', settled: this.schedule('Continuing with your approval') };
    }
    return { status: 'accepted', settled: this.schedule('Checking the approved action', (revision, signal) => this.send(proposal, revision, signal)) };
  }

  submit(request: PhoneRequest) {
    this.interrupt('Replacing the previous request');
    this.goal = request.instruction;
    const parsed = phoneRequestSchema.safeParse(request);
    if (!parsed.success) {
      this.request = undefined;
      this.finish('blocked', 'Please give the recipient and message on a single line each.', this.revision);
      return Promise.resolve();
    }
    this.request = parsed.data;
    this.approvedTaps.clear();
    // A request right after a question is the user's answer to it.
    this.answered = this.lastQuestion;
    this.lastQuestion = undefined;
    if (this.explicitlyPaused) {
      this.emit({ type: 'task', state: 'paused', goal: this.goal, detail: 'Request updated. Say continue when ready.', revision: this.revision, awaitingContinue: true });
      return Promise.resolve();
    }
    return this.schedule();
  }

  /** Phone-wide actions Portal performs directly: no screen reading and no model call. */
  quick(action: GlobalAction | 'open_app' | 'open_link', target = '') {
    const labels: Record<GlobalAction, string> = { back: 'Went back.', home: 'On the home screen.', recent_apps: 'Showing recent apps.', notifications: 'Opened notifications.', quick_settings: 'Opened quick settings.' };
    this.interrupt('Replacing the previous request');
    this.explicitlyPaused = false;
    this.request = undefined;
    this.goal = action === 'open_app' || action === 'open_link' ? `Open ${target}` : labels[action];
    return this.schedule('Working', async revision => {
      const result: ToolResult = action === 'open_app' ? await this.openApp(target) : action === 'open_link' ? await this.openLink(target)
        : this.phone.global ? await this.phone.global(globalActions[action]).then(() => ({ state: 'completed' as const, detail: labels[action] }))
        : { state: 'blocked', detail: 'Phone-wide actions are unavailable on this connection.' };
      this.finish(result.state, result.detail, revision);
    });
  }

  resume() {
    this.explicitlyPaused = false;
    this.interrupt('Continuing from the current phone state');
    return this.request ? this.schedule() : Promise.resolve();
  }

  get pausedForManualControl() { return this.explicitlyPaused; }

  private schedule(detail = 'Looking at the screen', work = (revision: number, signal: AbortSignal) => this.run(revision, signal)) {
    const goal = this.goal;
    this.active = true;
    const revision = this.revision;
    const abort = new AbortController();
    this.abort = abort;
    this.emit({ type: 'task', state: 'working', goal, detail, revision });
    // An already-dispatched gesture may still be finishing. Never run two action loops together.
    const queued = performance.now();
    const tail = this.execution.tail.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      timing({ owner: this.timingOwner, revision }, 'queue', queued);
      const started = performance.now();
      try { await work(revision, abort.signal); }
      catch (error) {
        if (!abort.signal.aborted && revision === this.revision) {
          this.finish('blocked', error instanceof Error ? error.message : 'Phone task failed', revision);
        }
      } finally { timing({ owner: this.timingOwner, revision }, 'execution', started); }
    });
    this.execution.tail = tail;
    return tail;
  }

  private timingContext() { return { owner: this.timingOwner, revision: this.revision }; }

  /** One goal, one loop: Portal and native tools where they exist, the screen model only where the screen decides. */
  private async run(revision: number, signal: AbortSignal) {
    const request = this.request;
    if (!request) return;
    const goal = this.goal;
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };

    if (request.outcome === 'app_opened') {
      if (!request.app) { this.finish('question', 'Which app should I open?', revision); return; }
      const result = await this.openApp(request.app, signal);
      check();
      this.finish(result.state, result.detail, revision);
      return;
    }
    if (request.message && !request.recipient) { this.finish('question', 'Who should I send it to?', revision); return; }
    if (request.message && !request.app) { this.finish('question', 'Which app should I send it with?', revision); return; }

    const first = await retrying(signal, () => this.phone.state());
    check();
    // An earlier send with an unknown outcome is inspected before anything else, and never replayed.
    const unknown = this.execution.sendUnknown;
    if (unknown && sendResult(first, unknown) === 'sent') {
      this.execution.sendUnknown = undefined;
      if (request.message === unknown.message && request.recipient && contains(unknown.recipient, request.recipient)) {
        this.finish('completed', `Checked first: ${JSON.stringify(unknown.message)} already shows as sent to ${unknown.recipient}. Not sent again.`, revision); return;
      }
      this.emit({ type: 'task', state: 'working', goal, detail: `Your earlier message ${JSON.stringify(unknown.message)} to ${unknown.recipient} was sent.`, revision });
    }

    const history: string[] = this.answered ? [`You asked the user ${JSON.stringify(this.answered)} and the goal now includes their answer. Act on the most sensible reading; do not ask again.`] : [];
    const context = { request, answered: this.answered !== undefined,
      tools: { global: !!this.phone.global, key: !!this.phone.key, deepLink: !!this.phone.deepLink, native: !!this.native } };
    let minimumMs = 120;
    let previous: { id: string; fingerprint: string } | undefined;
    let unchanged = 0;
    let dispatchFailures = 0;
    let discarded = 0;
    for (let step = 0; step < 24; step++) {
      check();
      const observation = await measure(this.timingContext(), 'settle', () => retrying(signal, () => readStableScreen(this.phone, signal, minimumMs)));
      check();
      if (previous?.fingerprint === progressFingerprint(observation)) {
        unchanged++;
        history.push(`No visible change after ${previous.id}; try another sensible action.`);
        if (unchanged >= 2) throw new Error(`I got stuck in ${observation.app.currentApp} after ${(history.at(-2) ?? previous.id).replace(/[.!?]$/, '')}. You can take it from here or ask again.`);
      } else unchanged = 0;
      const candidates = actionCandidates(observation, context);
      let screenshot: Uint8Array | undefined;
      if (this.phone.screenshot && observation.elements.filter(element => element.text).length < 3) {
        try {
          const bytes = await this.phone.screenshot();
          if (bytes.length <= 2_000_000) screenshot = bytes;
          else history.push('Screenshot exceeded the image budget; use the accessibility tree or hand off.');
        } catch { history.push('Screenshot unavailable; do not guess unseen controls.'); }
        check();
      }
      const decision = await measure(this.timingContext(), 'model', () => retrying(signal, () => this.selector.decide({ goal, request, observation, candidates, history, ...(screenshot && { screenshot }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }), 2));
      check();
      const chosen = candidates.find(item => item.id === decision.actionId);
      if (!chosen) throw new Error('Invalid phone action; stopped');
      const freeText = chosen.action.type === 'type' && !chosen.action.text;
      const needsText = freeText || chosen.action.type === 'open_app' || chosen.action.type === 'open_link' || (chosen.action.type === 'native' && chosen.action.tool === 'set_alarm');
      const needsValue = chosen.action.type === 'native' && chosen.action.tool !== 'set_alarm';
      if (needsText && !decision.text?.trim()) { history.push(`No text supplied for ${chosen.id}; supply text with that action.`); continue; }
      if (needsValue && typeof decision.value !== 'number') { history.push(`No value supplied for ${chosen.id}; supply a number as value.`); continue; }
      const current = await retrying(signal, () => this.phone.state());
      check();
      if (!targetIsCurrent(chosen, observation, current, context)) {
        // Every discard costs a model call; a screen that never holds still ends the task instead.
        if (++discarded >= 3) { this.finish('blocked', `The screen in ${current.app.currentApp} keeps changing before I can act. You can take it from here or ask again.`, revision); return; }
        history.push('Screen changed. Discarded the pending action and observed again.');
        continue;
      }
      discarded = 0;
      const candidate: ActionCandidate = freeText && chosen.action.type === 'type' && decision.text
        ? { ...chosen, action: { ...chosen.action, text: decision.text }, description: `Type ${JSON.stringify(decision.text)}` } : chosen;
      const app = current.app.currentApp;
      const answer = decision.text?.trim();
      if (candidate.action.type === 'ask') {
        const names = request.recipient ? recipientNames(current, request.recipient) : [];
        this.finish('question', names.length > 1 ? `Which ${request.recipient} do you mean: ${names.slice(0, 3).join(' or ')}?` : answer || `What should I do in ${app}?`, revision);
        return;
      }
      if (candidate.action.type === 'send') {
        if (this.proposeMessage(current, candidate.action, request, revision)) return;
        history.push('The requested message is not in the compose field yet. Type it before asking for approval.');
        previous = undefined;
        continue;
      }
      const ambiguous = request.recipient && candidate.element ? this.ambiguousRecipient(candidates, candidate, request.recipient) : undefined;
      if (ambiguous) { this.finish('question', `Which ${request.recipient} do you mean: ${ambiguous.join(' or ')}?`, revision); return; }
      if (candidate.action.type === 'done') {
        const supported = capabilityFor(current).packageName !== '*';
        if (request.message && supported) { this.finish('blocked', `Not sent. I stopped in ${app} before the confirmation step.`, revision); return; }
        this.finish('completed', answer || (request.message ? `Ready in ${app}. Tap send when you're happy with it.` : `Done in ${app}.`), revision);
        return;
      }
      if (candidate.action.type === 'blocked') {
        this.finish('blocked', answer || `I couldn't finish in ${app}. You can take it from here or ask again.`, revision);
        return;
      }
      if (candidate.action.type === 'native' || candidate.action.type === 'open_app' || candidate.action.type === 'open_link') {
        this.emit({ type: 'task', state: 'working', goal, detail: candidate.description, revision });
        const result = candidate.action.type === 'native' ? await this.nativeTool(candidate.action.tool, decision)
          : candidate.action.type === 'open_app' ? await this.openApp(answer ?? '') : await this.openLink(answer ?? '');
        check();
        if (result.state === 'unknown') { this.finish('unknown', result.detail, revision); return; }
        // A native action meant to finish the goal reports its refusal (a missing permission) instead of looping on it.
        if (decision.finish && candidate.action.type === 'native' && result.state !== 'question') { this.finish(result.state, result.detail, revision); return; }
        history.push(result.detail);
        previous = undefined;
        minimumMs = candidate.action.type === 'native' ? 120 : 350;
        continue;
      }
      let dispatched = candidate;
      if (candidate.action.type === 'confirm_tap') {
        const { x, y, label } = candidate.action;
        if (!this.approvedTaps.has(`${current.app.packageName}|${label}`)) { this.proposeTap(current, label, revision); return; }
        dispatched = { ...candidate, action: { type: 'tap', x, y }, description: `Tap ${JSON.stringify(label)}.` };
      }
      this.emit({ type: 'task', state: 'working', goal, detail: dispatched.description, revision });
      check();
      try { await measure(this.timingContext(), 'dispatch', () => executeAction(this.phone, dispatched, async () => {
        // Focus lands a few frames after the tap; poll briefly instead of failing on the first read.
        for (let attempt = 0; ; attempt++) {
          check();
          const focused = await this.phone.state();
          check();
          const field = focused.elements.find(element => candidate.element?.resourceId === element.resourceId
            && candidate.element?.bounds.left === element.bounds.left && candidate.element?.bounds.top === element.bounds.top);
          if (field?.focused !== false) return;
          if (attempt >= 6) throw new Error('The input field did not take keyboard focus.');
          await delay(80, undefined, { signal });
        }
      })); }
      catch (error) {
        check();
        // Every action here is reversible navigation or typing; the send path is separate. Observe again and keep going.
        if (++dispatchFailures >= 3) { this.finish('blocked', `Phone actions keep failing in ${app}. You can take it from here or ask again.`, revision); return; }
        history.push(`${dispatched.description} failed (${error instanceof Error ? error.message : 'unknown error'}). Observe and try another way.`);
        previous = undefined;
        continue;
      }
      check();
      history.push(dispatched.description);
      // Waiting is not an attempt to change the screen, so it never counts toward "no progress".
      previous = candidate.action.type === 'wait' ? undefined : { id: candidate.id, fingerprint: progressFingerprint(observation) };
      minimumMs = candidate.action.type === 'swipe' ? 350 : 120;
    }
    throw new Error('That took too many steps, so I stopped. You can take it from here or ask again.');
  }

  /** Several different visible names match the requested recipient and none matches it exactly. */
  private ambiguousRecipient(candidates: ActionCandidate[], chosen: ActionCandidate, recipient: string) {
    const names = (candidate: ActionCandidate) => segments(candidate.element?.text ?? '').filter(segment => contains(segment, recipient));
    if (!names(chosen).length || names(chosen).some(name => name.toLowerCase() === recipient.toLowerCase())) return undefined;
    const all = [...new Set(candidates.filter(candidate => candidate.action.type === 'tap').flatMap(names))];
    return all.length > 1 ? all.slice(0, 3) : undefined;
  }

  /**
   * Turns a supported send control into a proposal for the user. Returns false when the draft is not ready yet.
   * Without a concrete recipient and message there is nothing specific to confirm, so the user takes over instead.
   */
  private proposeMessage(observation: PhoneObservation, control: { label: string; resourceId: string }, request: PhoneRequest, revision: number) {
    const app = observation.app.currentApp;
    if (!request.recipient || !request.message) {
      this.finish('blocked', `I only send messages after confirming a concrete recipient and message, so please send this one yourself.`, revision);
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
    const proposal: PendingMessage = { id: randomUUID(), operation: 'send_message', app, recipient, message, revision, target: { packageName: observation.app.packageName, ...control } };
    this.proposal = proposal;
    const warning = this.execution.sendUnknown ? ' An earlier send may already have gone through.' : '';
    this.finish('confirming', `Send ${JSON.stringify(message)} to ${recipient} in ${app}?${warning}`, revision, { id: proposal.id, operation: proposal.operation, app, recipient, message });
    return true;
  }

  /** Asks before an irreversible tap, naming the draft when the tap would send it. */
  private proposeTap(observation: PhoneObservation, label: string, revision: number) {
    const app = observation.app.currentApp;
    const draft = /send|post|submit|publish/i.test(label) ? observation.elements.find(element => element.editable && element.text.trim())?.text.trim() : undefined;
    const detail = `Tap ${JSON.stringify(label)} in ${app}?${draft ? ` It will send ${JSON.stringify(draft.slice(0, 160))}.` : ''}`;
    const proposal: PendingTap = { id: randomUUID(), operation: 'tap', app, label, detail, revision, packageName: observation.app.packageName };
    this.proposal = proposal;
    this.finish('confirming', detail, revision, { id: proposal.id, operation: 'tap', app, label, detail });
  }

  /**
   * Dispatches an approved send once, after revalidating the exact approved control on the live screen, and reports only
   * observed results. After every await it reports only if this request still owns the phone; once the tap is
   * dispatched, the unknown outcome stays recorded until a check establishes it.
   */
  private async send(proposal: PendingMessage, revision: number, signal: AbortSignal) {
    const owns = () => revision === this.revision && !signal.aborted;
    const current = await readStableScreen(this.phone, signal);
    if (!owns()) return;
    const { target } = proposal;
    const control = current.elements.find(element => element.resourceId === target.resourceId && element.text === target.label
      && capabilityFor(current).effect(element, current)?.kind === 'send_message');
    const before = outgoingCounts(current, proposal.message);
    const unchanged = current.app.packageName === target.packageName && control && before
      && current.elements.some(element => element.editable && element.text.trim() === proposal.message)
      && recipientNames(current, proposal.recipient).includes(proposal.recipient);
    if (!unchanged) { this.finish('blocked', 'The draft, recipient or send button changed after you confirmed, so nothing was sent. Say continue to prepare it again.', revision); return; }
    const sent: Sent = { recipient: proposal.recipient, message: proposal.message, packageName: target.packageName, before };
    this.execution.sendUnknown = sent;
    const lost = `The send to ${proposal.recipient} may or may not have gone through. I won't send it again; check the conversation.`;
    try { await this.phone.tap(center(control.bounds).x, center(control.bounds).y); }
    catch { if (owns()) this.finish('unknown', lost, revision); return; }
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await delay(250, undefined, { signal }); }
      catch { return; }
      let observation: PhoneObservation;
      try { observation = await this.phone.state(); }
      catch { if (owns()) this.finish('unknown', lost, revision); return; }
      if (!owns()) return;
      const result = sendResult(observation, sent);
      if (result === 'sent') {
        this.execution.sendUnknown = undefined;
        this.finish('completed', `Sent ${JSON.stringify(proposal.message)} to ${proposal.recipient}. It shows as sent in the conversation.`, revision);
        return;
      }
      if (result === 'failed') {
        this.finish('blocked', `${proposal.app} shows the message to ${proposal.recipient} as not sent. I won't retry it on my own.`, revision);
        return;
      }
    }
    this.finish('unknown', `I tapped send, but the message doesn't show as sent to ${proposal.recipient} yet. I won't send it again; check the conversation.`, revision);
  }

  /** Native commands for what Portal cannot do in one call. An unacknowledged write is reported, never retried. */
  private async nativeTool(tool: NativeTool, decision: Pick<Decision, 'text' | 'value'>): Promise<ToolResult> {
    if (!this.native) return { state: 'blocked', detail: `${tool} is unavailable; use the screen instead.` };
    const value = Math.round(decision.value ?? Number.NaN);
    const text = decision.text?.trim().slice(0, 120) ?? '';
    let command: NativeCommandRequest;
    let done: string;
    switch (tool) {
      case 'set_timer':
        if (!(value >= 1 && value <= 86400)) return { state: 'blocked', detail: 'set_timer needs whole seconds between 1 and 86400 as value.' };
        command = { name: 'create_timer', args: { seconds: value, label: text } };
        done = `Started a ${value} second timer${text ? ` named ${JSON.stringify(text)}` : ''}.`;
        break;
      case 'set_alarm': {
        const time = /^(\d{1,2}):(\d{2})$/.exec(text);
        const hour = Number(time?.[1]), minute = Number(time?.[2]);
        if (!time || hour > 23 || minute > 59) return { state: 'blocked', detail: 'set_alarm needs a 24-hour time like "07:30" as text.' };
        command = { name: 'create_alarm', args: { hour, minute, label: '' } };
        done = `Set an alarm for ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}.`;
        break;
      }
      case 'set_media_volume':
        if (!(value >= 0 && value <= 100)) return { state: 'blocked', detail: 'set_media_volume needs a percentage from 0 to 100 as value.' };
        command = { name: 'set_media_volume', args: { percent: value } };
        done = `Media volume is at ${value}%.`;
        break;
      case 'set_brightness':
        if (!(value >= 10 && value <= 100)) return { state: 'blocked', detail: 'set_brightness needs a percentage from 10 to 100 as value.' };
        command = { name: 'set_brightness', args: { percent: value } };
        done = `Brightness is at ${value}%.`;
        break;
    }
    const clock = command.name === 'create_timer' || command.name === 'create_alarm';
    if (clock && this.execution.clockUnknown) return { state: 'unknown', detail: 'An earlier Clock request may already exist. Check Clock; I will not create another automatically.' };
    if (clock) this.execution.clockUnknown = true;
    const result = await executeNativeCommand(command, this.native);
    if (result.status !== 'unknown' && clock) this.execution.clockUnknown = false;
    if (result.status === 'blocked') return { state: 'blocked', detail: result.reason };
    if (result.status === 'unknown') return { state: 'unknown', detail: `The phone did not confirm ${tool.replace('set_', '').replace('_', ' ')}. Check it before asking again.` };
    return { state: 'completed', detail: done };
  }

  /** Launches an installed app by its label through Portal, then waits for it in the foreground. No screen model. */
  private async openApp(name: string, signal?: AbortSignal): Promise<ToolResult> {
    const installed = await this.phone.packages();
    const exact = installed.filter(app => app.label.toLowerCase() === name.toLowerCase());
    const matches = exact.length ? exact : installed.filter(app => contains(app.label, name));
    const [app] = matches;
    if (!app) return { state: 'blocked', detail: `I can't find an app called ${name} on this phone.` };
    if (matches.length > 1) return { state: 'question', detail: `Which app do you mean: ${matches.slice(0, 3).map(match => match.label).join(' or ')}?` };
    if (signal && inForeground(await this.phone.state(), app.packageName)) return { state: 'completed', detail: `${app.label} is open.` };
    try { await this.phone.launch(app.packageName); }
    catch { return { state: 'unknown', detail: `Opening ${app.label} was not acknowledged. Please check the phone.` }; }
    if (!signal) return { state: 'completed', detail: `Opened ${app.label}.` };
    const started = performance.now();
    while (performance.now() - started < 5_000) {
      if (inForeground(await readStableScreen(this.phone, signal), app.packageName)) return { state: 'completed', detail: `Opened ${app.label}.` };
      await delay(100, undefined, { signal });
    }
    return { state: 'unknown', detail: `I asked ${app.label} to open, but couldn't see it in the foreground. Please check the phone.` };
  }

  /** Opens a URI through Portal's deep-link intent: web pages, dialer, maps, mail, app links. */
  private async openLink(uri: string): Promise<ToolResult> {
    if (!this.phone.deepLink || !/^[a-z][a-z0-9+.-]*:\S+$/i.test(uri)) return { state: 'blocked', detail: `I can't open ${JSON.stringify(uri)}; it needs to be a full link like https://… or tel:+1….` };
    await this.phone.deepLink(uri);
    return { state: 'completed', detail: `Opened ${uri}.` };
  }

  private finish(state: TaskStatus['state'], detail: string, revision: number, proposal?: Proposal) {
    if (revision !== this.revision) return;
    this.lastQuestion = state === 'question' ? detail : undefined;
    this.active = false;
    this.emit({ type: 'task', state, goal: this.goal, detail, revision, ...(proposal && { proposal }) });
  }
}
