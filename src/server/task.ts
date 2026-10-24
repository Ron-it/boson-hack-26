import { planOperation, type PlannedOperation, type OperationProgress, type OperationEvidence, type OperationScope } from './operation-plan.ts';
import { clockRequest, timerRequestSchema, alarmRequestSchema, type ClockProposal, type ClockCommand } from './native-requests.ts';
import { executeNativeCommand, type NativeTransport } from './native-commands.ts';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { actionCandidates, assertSettingsScreen, executeAction, readStableScreen, progressFingerprint, targetIsCurrent, type ActionCandidate } from '../mobile/actions.ts';
import { z } from 'zod';
import type { PhoneControl, PhoneObservation } from '../mobile/portal.ts';
import { createSelector } from '../mobile/selectors.ts';
import { capabilityFor, type Outgoing } from '../mobile/capabilities.ts';
import { workflowRequestSchema, type ContentSelection } from '../mobile/workflows.ts';

/** What the user is asked to approve. Approval applies once, to exactly this payload and request revision. */
type MessageProposal = { id: string; operation: 'send_message'; app: string; recipient: string; message: string };
export type Proposal = MessageProposal | ClockProposal;
export type TaskStatus = { type: 'task'; state: 'paused' | 'working' | 'confirming' | 'question' | 'declined' | 'completed' | 'blocked' | 'unknown'; goal: string; detail: string; revision: number; proposal?: Proposal; evidence?: OperationEvidence; progress?: OperationProgress[] };

const singleLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]*$/, 'Use a single line');
export const phoneRequestSchema = z.object({
  ...workflowRequestSchema.shape,
  instruction: z.string().min(1).max(2000),
  timer: timerRequestSchema.optional(), alarm: alarmRequestSchema.optional(),
  ambiguousVolume: z.boolean().optional(),
  mediaVolume: z.number().min(0).max(100).optional(),
  brightness: z.number().min(10).max(100).optional(), nightLight: z.boolean().optional(),
  app: singleLine(80).optional(), recipient: singleLine(120).optional(), message: singleLine(1000).optional(),
});
export type PhoneRequest = z.infer<typeof phoneRequestSchema>;

/** The exact control the user approved. Approval never transfers to another control or app. */
type Target = { packageName: string; resourceId: string; label: string };
type PendingMessage = MessageProposal & { revision: number; target: Target; stepKey?: string };
type PendingProposal = PendingMessage | (ClockProposal & { revision: number; stepKey?: string });
type Counts = Record<Outgoing['status'], number>;
/** A dispatched send, with the outgoing copies of its text that were already on screen just before the tap. */
type Sent = { recipient: string; message: string; packageName: string; before: Counts };

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

/** Outgoing copies of the message by delivery state, or undefined when the app's sent messages are not understood. */
function outgoingCounts(observation: PhoneObservation, message: string): Counts | undefined {
  const outgoing = capabilityFor(observation)?.outgoing?.(observation);
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
export type NativeCommand = NativeTransport;

/** Shared by every caller of one phone, so a replacement voice session cannot replay an unacknowledged mutation. */
type PhoneExecution = { tail: Promise<void>; brightnessUnknown: boolean; sendUnknown: Sent | undefined; clockUnknown: ClockCommand | undefined; mediaUnknown: number | undefined };
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
  private plan: PlannedOperation[] = [];
  private currentStep: PlannedOperation | undefined;
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
    this.execution = phoneExecutions.get(phone) ?? { tail: Promise.resolve(), brightnessUnknown: false, sendUnknown: undefined, clockUnknown: undefined, mediaUnknown: undefined };
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
    if (this.currentStep?.state === 'confirming') this.currentStep.state = 'pending';
    this.currentStep = undefined;
    this.revision++;
    this.abort?.abort(new Error(detail));
    this.abort = undefined;
    if (this.active || withdrawn) this.emit({ type: 'task', state: 'paused', goal: this.goal, detail: withdrawn ? `${detail}. The confirmation was withdrawn; nothing was submitted.` : detail, revision: this.revision });
    this.active = false;
  }

  pause(detail = 'Paused for manual control. Say continue when ready.') {
    this.explicitlyPaused = true;
    for (const step of this.plan) if (step.state === 'completed' && (step.id === 'settings'
      || (step.effect === 'ui' && step.evidence?.kind !== 'message_sent'))) step.state = 'pending';
    this.interrupt(detail);
  }

  stop() {
    this.interrupt('Stopped by request');
    this.explicitlyPaused = false;
    this.request = undefined;
    this.plan = [];
  }

  /**
   * Answers the pending confirmation. The id must name the current proposal for the current request revision,
   * and it is consumed before anything else happens, so a repeated or late approval cannot dispatch twice.
   */
  answer(proposalId: string, approve: boolean): { status: 'accepted' | 'declined' | 'expired'; settled: Promise<void> } {
    const proposal = this.proposal;
    if (!proposal || proposal.id !== proposalId || proposal.revision !== this.revision || this.active
      || (proposal.stepKey !== undefined && this.currentStep?.key !== proposal.stepKey)) return { status: 'expired', settled: Promise.resolve() };
    this.proposal = undefined;
    if (!approve) {
      this.finish('declined', proposal.operation === 'send_message' ? `Not sent. The draft to ${proposal.recipient} is still in ${proposal.app}.` : 'Not created. Clock was not changed.', this.revision);
      return { status: 'declined', settled: Promise.resolve() };
    }
    return { status: 'accepted', settled: this.schedule('Checking the approved action', async (revision, signal) => {
      if (proposal.operation === 'send_message') await this.send(proposal, revision, signal);
      else await this.createClock(proposal, revision, signal);
      if (revision === this.revision && !signal.aborted && this.currentStep?.state === 'completed') await this.run(this.goal, revision, signal);
    }) };
  }

  submit(request: PhoneRequest) {
    this.interrupt('Replacing the previous request');
    this.goal = request.instruction;
    const parsed = phoneRequestSchema.safeParse(request);
    if (!parsed.success) {
      this.request = undefined;
      this.finish('blocked', 'Please give supported settings values, a timer duration, a next local alarm time, or a single-line recipient and message. Date-specific and repeating alarms need Clock.', this.revision);
      return Promise.resolve();
    }
    const previous = this.plan.some(step => step.state !== 'completed') ? this.plan : [];
    this.request = parsed.data;
    this.plan = this.planRequest(parsed.data);
    for (const step of this.plan) {
      const retained = previous.find(old => old.key === step.key && (old.state === 'completed' || (old.state === 'unknown' && old.recovery === 'manual')));
      if (retained) { step.state = retained.state; if (retained.detail !== undefined) step.detail = retained.detail; if (retained.evidence) step.evidence = retained.evidence; }
    }
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

  /** Explicit read-only commands may overlap voice and selector inference; they never enter the mutation queue. */
  async readNative(value: 'brightness' | 'media_volume') {
    if (!this.native) return { status: 'blocked' as const, reason: 'Native readback is unavailable.' };
    try { return await executeNativeCommand({ name: value === 'brightness' ? 'read_brightness' : 'read_media_volume', args: {} }, this.native); }
    catch { return { status: 'unknown' as const, reason: 'Native readback could not be established.' }; }
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
          this.finish('blocked', error instanceof Error ? error.message : 'Phone task failed', revision);
        }
      }
    });
    this.execution.tail = tail;
    return tail;
  }

  private progress(): OperationProgress[] {
    return this.plan.map(({ id, label, effect, state, detail, evidence }) => ({ id, label, effect, state,
      ...(detail !== undefined && { detail }), ...(evidence && { evidence }) }));
  }

  private planRequest(request: PhoneRequest) {
    const executeUi = (args: Omit<PhoneRequest, 'instruction'>, scope: OperationScope) => this.runUi({ ...args, instruction: scope.instruction }, scope.revision, scope.signal);
    const steps = [
      planOperation(request, {
        id: 'media', label: 'media volume', effect: 'setting',
        arguments: value => value.mediaVolume !== undefined || value.ambiguousVolume ? { mediaVolume: value.mediaVolume, ambiguousVolume: value.ambiguousVolume } : undefined,
        execute: (args, scope) => this.setMedia({ ...args, instruction: scope.instruction }, scope.revision, scope.signal),
        check: async args => {
          if (!this.native || args.mediaVolume === undefined) return false;
          const result = await executeNativeCommand({ name: 'read_media_volume', args: {} }, this.native);
          if (result.status !== 'observed' || !('observedIndex' in result)
            || result.observedIndex !== Math.floor(result.minIndex + args.mediaVolume / 100 * (result.maxIndex - result.minIndex) + 0.5)) return false;
          return { kind: 'native_media', requestedPercent: args.mediaVolume, observedIndex: result.observedIndex, minIndex: result.minIndex, maxIndex: result.maxIndex };
        },
      }),
      planOperation(request, {
        id: 'settings', label: 'display settings', effect: 'setting',
        arguments: value => value.brightness !== undefined || value.nightLight !== undefined ? { brightness: value.brightness, nightLight: value.nightLight } : undefined,
        execute: executeUi,
      }),
      ...(['timer', 'alarm'] as const).map(kind => planOperation(request, {
        id: kind, label: `Clock ${kind}`, effect: 'intent', recovery: 'manual',
        arguments: value => value[kind] ? { [kind]: value[kind] } : undefined,
        execute: (args, scope) => this.prepareClock({ ...args, instruction: scope.instruction }, scope.revision, scope.signal),
      })),
      planOperation(request, {
        id: 'app', label: request.message || request.recipient ? 'message' : 'app result', effect: 'ui',
        arguments: value => value.app || value.message || value.recipient || value.outcome || value.values?.length
          || (value.brightness === undefined && value.nightLight === undefined && value.mediaVolume === undefined && !value.ambiguousVolume && !value.timer && !value.alarm)
          ? { app: value.app, message: value.message, recipient: value.recipient, values: value.values, outcome: value.outcome } : undefined,
        execute: executeUi,
        check: async (args, _scope, evidence) => {
          if (evidence?.kind === 'message_sent') return evidence;
          const current = await this.phone.state();
          return capabilityFor(current)?.outcome?.(current, args, evidence?.kind === 'content_opened' ? evidence.selection : undefined) ?? false;
        },
      }),
    ];
    return steps.filter(step => step !== undefined);
  }

  private async run(goal: string, revision: number, signal: AbortSignal) {
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    const scope = { revision, signal, instruction: goal };
    for (const step of this.plan) {
      check();
      this.currentStep = step;
      if (step.state === 'completed') {
        if (!step.check) continue;
        const verified = await step.check(scope, step.evidence);
        if (verified) { check(); step.evidence = verified; continue; }
        check();
        step.state = 'pending';
      }
      // An accepted Clock intent has no independent event evidence. Continue other work without recreating it.
      if (step.state === 'unknown' && step.recovery === 'manual') continue;
      await step.execute(scope);
      check();
      if (this.currentStep?.state !== 'completed') return;
    }
    check();
    // A later UI step must not hide a changed native outcome. Single-operation behavior keeps its existing readback.
    if (this.plan.length > 1) for (const step of this.plan.filter(operation => operation.state === 'completed' && operation.check)) {
      const valid = await step.check?.(scope, step.evidence);
      check();
      if (!valid) { step.state = 'pending'; step.detail = `The ${step.label} result no longer matches the request.`; }
      else step.evidence = valid;
    }
    this.currentStep = undefined;
    const unfinished = this.plan.filter(step => step.state !== 'completed');
    if (unfinished.length) {
      this.finish('unknown', unfinished.map(step => step.detail ?? `${step.label} is unfinished`).join(' '), revision);
      return;
    }
    this.finish('completed', this.plan.map(step => step.detail).filter(Boolean).join(' '), revision, undefined,
      this.plan.findLast(step => step.evidence)?.evidence);
  }

  private async prepareClock(request: PhoneRequest, revision: number, signal: AbortSignal) {
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    const clock = clockRequest(request);
    if (clock) {
      if ('question' in clock) { this.finish('question', clock.question, revision); return; }
      if (this.execution.clockUnknown) { this.finish('unknown', 'An earlier Clock creation may already exist. Check Clock and handle it there; I will not create another automatically.', revision); return; }
      if (!this.native) { this.finish('blocked', 'Clock shortcuts are unavailable. Please use the Clock app.', revision); return; }
      const handler = await executeNativeCommand({ name: 'resolve_handler', args: { target: clock.command.name === 'create_timer' ? 'timer' : 'alarm' } }, this.native);
      check();
      if (handler.status !== 'observed' || !('available' in handler) || !handler.available) {
        this.finish('blocked', handler.status === 'blocked' ? `${handler.reason}. Please open Clock and create it there.` : 'No available Clock handler was established. Please open Clock and create it there.', revision); return;
      }
      const proposal: ClockProposal & { revision: number; stepKey?: string } = { ...(this.currentStep && { stepKey: this.currentStep.key }), id: randomUUID(), operation: clock.command.name, app: 'Clock', handlerPackage: handler.handlerPackage, ...clock, revision };
      this.proposal = proposal;
      this.finish('confirming', clock.detail, revision, structuredClone({ id: proposal.id, operation: proposal.operation, app: proposal.app, handlerPackage: proposal.handlerPackage, command: proposal.command, detail: proposal.detail }));
      return;
    }
  }

  private async setMedia(request: PhoneRequest, revision: number, signal: AbortSignal) {
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    if (request.ambiguousVolume) { this.finish('question', 'Do you mean media volume? What percentage should I use?', revision); return; }
    if (request.mediaVolume !== undefined) {
      if (!this.native) { this.finish('blocked', 'Native media volume is unavailable. Please use the media volume controls.', revision); return; }
      let established = false;
      if (this.execution.mediaUnknown !== undefined) {
        let observed;
        try { observed = await executeNativeCommand({ name: 'read_media_volume', args: {} }, this.native); }
        catch { check(); this.finish('unknown', 'Could not inspect the earlier media volume change. No write retried.', revision); return; }
        check();
        if (observed.status !== 'observed' || !('observedIndex' in observed)) { this.finish('unknown', 'Could not inspect the earlier media volume change. No write retried.', revision); return; }
        this.execution.mediaUnknown = undefined;
        established = observed.observedIndex === Math.floor(observed.minIndex + request.mediaVolume / 100 * (observed.maxIndex - observed.minIndex) + 0.5);
        if (established) { this.finish('completed', `Observed media volume ${observed.observedIndex} on Android range ${observed.minIndex} to ${observed.maxIndex}.`, revision, undefined, { kind: 'native_media', requestedPercent: request.mediaVolume, observedIndex: observed.observedIndex, minIndex: observed.minIndex, maxIndex: observed.maxIndex }); return; }
      }
      if (!established) {
        this.execution.mediaUnknown = request.mediaVolume;
        let result;
        try { result = await executeNativeCommand({ name: 'set_media_volume', args: { percent: request.mediaVolume } }, this.native); }
        catch { check(); this.finish('unknown', 'Media volume outcome is unknown. Say continue to inspect before retrying.', revision); return; }
        if (result.status === 'completed' || result.status === 'blocked') this.execution.mediaUnknown = undefined;
        check();
        if (result.status !== 'completed' || !('observedIndex' in result)) {
          this.finish(result.status === 'unknown' ? 'unknown' : 'blocked', result.status === 'blocked' ? `${result.reason} Please use the media volume controls or fix the permission, then ask again.` : 'Media volume outcome is unknown. Say continue to inspect before retrying.', revision); return;
        }
        { this.finish('completed', `Observed media volume ${result.observedIndex} on Android range ${result.minIndex} to ${result.maxIndex}.`, revision, undefined, { kind: 'native_media', requestedPercent: request.mediaVolume, observedIndex: result.observedIndex, minIndex: result.minIndex, maxIndex: result.maxIndex }); return; }
      }
    }
  }

  private async runUi(request: PhoneRequest, revision: number, signal: AbortSignal) {
    const goal = this.goal;
    const check = () => { signal.throwIfAborted(); if (revision !== this.revision) throw new Error('Superseded request'); };
    const settings = request.brightness !== undefined || request.nightLight !== undefined;
    // Every screen-affecting operation is inside the same serialized tail.
    const first = await this.phone.state();
    check();
    for (const value of request.values ?? []) {
      const source = value.source;
      if (source.kind === 'screen' && (source.text !== value.text || first.app.packageName !== source.packageName
        || !first.elements.some(element => element.resourceId === source.resourceId && element.text === source.text))) {
        this.finish('question', `I can't verify the source for ${value.field}. Please give the text you want me to use.`, revision); return;
      }
    }
    const fields = request.values?.map(value => value.field) ?? [];
    if (new Set(fields).size !== fields.length) {
      this.finish('question', 'There is more than one value for the same field. Which text should I use?', revision); return;

    }
    if (!settings) {
      if (request.message && !request.recipient) { this.finish('question', 'Who should I send it to?', revision); return; }
      if (request.recipient && !request.message) { this.finish('question', `What should the message to ${request.recipient} say?`, revision); return; }
      if (request.message && !request.app) { this.finish('question', 'Which app should I send it with?', revision); return; }
      // An earlier send with an unknown outcome is inspected before anything else, and never replayed.
      const unknown = this.execution.sendUnknown;
      if (unknown && sendResult(first, unknown) === 'sent') {
        this.execution.sendUnknown = undefined;
        if (request.message === unknown.message && request.recipient && contains(unknown.recipient, request.recipient)) {
          this.finish('completed', `Checked first: ${JSON.stringify(unknown.message)} already shows as sent to ${unknown.recipient}. Not sent again.`, revision, undefined, { kind: 'message_sent', packageName: unknown.packageName, recipient: unknown.recipient, message: unknown.message }); return;
        }
        this.emit({ type: 'task', state: 'working', goal, detail: `Your earlier message ${JSON.stringify(unknown.message)} to ${unknown.recipient} was sent.`, revision });
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
          this.finish('completed', `Observed Android brightness raw value ${result.data.observedRawValue} for requested ${request.brightness}%. Adaptive brightness remains unchanged.`, revision, undefined, { kind: 'display_settings', brightness: request.brightness, observedRawValue: result.data.observedRawValue }); return;
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
        this.finish('completed', `Observed Android brightness raw value ${expected} for requested ${request.brightness}%. Adaptive brightness remains unchanged.`, revision, undefined, { kind: 'display_settings', brightness: request.brightness, observedRawValue: expected }); return;
      }
    }
    if (settings && this.native) {
      check();
      try { await this.native('open_display', {}); }
      catch { check(); this.finish('unknown', 'Opening Settings was not acknowledged. Say continue to inspect the phone.', revision); return; }
      check();
    }
    const history: string[] = [];
    let selection: ContentSelection | undefined;
    let minimumMs = 120;
    let previous: { id: string; fingerprint: string } | undefined;
    let unchanged = 0;
    for (let step = 0; step < 16; step++) {
      check();
      const observation = await readStableScreen(this.phone, signal, minimumMs);
      if (settings) assertSettingsScreen(observation);
      check();
      if (previous?.fingerprint === progressFingerprint(observation)) {
        unchanged++;
        history.push(`No visible change after ${previous.id}; try another sensible action.`);
        if (unchanged >= 2) {
          if (!settings) this.explicitlyPaused = true;
          throw new Error(settings ? 'No progress. Please reopen Display settings and try again.'
            : `No progress in ${observation.app.currentApp} after ${(history.at(-2) ?? previous.id).replace(/[.!?]$/, '')}. Please take over, then say continue.`);
        }
      } else unchanged = 0;
      const candidates = actionCandidates(observation, { request, apps });
      let screenshot: Uint8Array | undefined;
      if (this.phone.screenshot && observation.elements.filter(element => element.text).length < 3) {
        try {
          const bytes = await this.phone.screenshot();
          if (bytes.length <= 2_000_000) screenshot = bytes;
          else history.push('Screenshot exceeded the image budget; use the accessibility tree or hand off.');
        } catch { history.push('Screenshot unavailable; do not guess unseen controls.'); }
        check();
      }
      const decision = await this.selector.decide({ goal, request, observation, candidates, history, ...(screenshot && { screenshot }), signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
      check();
      const candidate = candidates.find(item => item.id === decision.actionId);
      if (!candidate) throw new Error('Invalid phone action; stopped');
      const current = await this.phone.state();
      check();
      if (settings) assertSettingsScreen(current);
      if (!targetIsCurrent(candidate, observation, current, { request, apps })) {
        history.push('Screen changed. Discarded the pending action and observed again.');
        continue;
      }
      const app = current.app.currentApp;
      const heading = current.elements.find(element => /:id\/(alertTitle|header_title)$/.test(element.resourceId))?.text;
      const visibleContext = heading ? ` showing ${JSON.stringify(heading.slice(0, 60))}` : '';
      if (candidate.action.type === 'ask') {
        const names = request.recipient ? recipientNames(current, request.recipient) : [];
        this.finish('question', names.length > 1 ? `Which ${request.recipient} do you mean: ${names.slice(0, 3).join(' or ')}?` : `I'm in ${app}${visibleContext}. What result do you want here?`, revision);
        return;
      }
      if (candidate.action.type === 'send') {
        if (this.propose(current, candidate.action, request, revision)) return;
        history.push('The requested message is not in the compose field yet. Type it before asking for approval.');
        previous = undefined;
        continue;
      }
      const ambiguous = request.recipient && candidate.element ? this.ambiguousRecipient(candidates, candidate, request.recipient) : undefined;
      if (ambiguous) { this.finish('question', `Which ${request.recipient} do you mean: ${ambiguous.join(' or ')}?`, revision); return; }
      if (!settings && (candidate.action.type === 'done' || candidate.action.type === 'blocked')) {
        if (candidate.action.type === 'done' && !request.message) {
          const evidence = capabilityFor(current)?.outcome?.(current, request, selection);
          if (evidence) { this.finish('completed', evidence.detail, revision, undefined, evidence); return; }
          // No supported check establishes this outcome, so it is not reported as completed.
          this.finish('unknown', `I stopped in ${app}${visibleContext}, but I can't check that it's done. Please have a look.`, revision); return;
        }
        if (!request.message) this.explicitlyPaused = true;
        this.finish('blocked', request.message ? `Not sent. I stopped in ${app} before the confirmation step.` : `I can't continue in ${app}${visibleContext}. Please take over, then say continue.`, revision); return;
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
          : 'The requested Settings result is not established by observed values.', revision, undefined, verified ? { kind: 'display_settings', brightness: request.brightness, nightLight: request.nightLight } : undefined);
        return;
      }
      this.emit({ type: 'task', state: 'working', goal, detail: candidate.description, revision });
      check();
      try { await executeAction(this.phone, candidate, async () => {
        check();
        const focused = await this.phone.state();
        check();
        if (!targetIsCurrent(candidate, current, focused, { request, apps })) throw new Error('The input target changed while focusing it.');
        const field = focused.elements.find(element => candidate.element?.resourceId === element.resourceId
          && candidate.element?.bounds.left === element.bounds.left && candidate.element?.bounds.top === element.bounds.top);
        if (field?.focused === false) throw new Error('The input field does not have keyboard focus.');
      }); }
      catch { check(); this.finish('unknown', 'Phone action outcome is unknown. Say continue to inspect before acting again.', revision); return; }
      check();
      if (candidate.action.type !== 'wait') selection = candidate.effect?.kind === 'open_content'
        ? { packageName: current.app.packageName, name: candidate.effect.name, viewer: candidate.effect.viewer } : undefined;
      if (settings) history.push(`Observed: ${JSON.stringify(observation.elements.filter(item => item.checked !== null || item.range).map(item => ({ label: item.text, checked: item.checked, range: item.range })))}`);
      history.push(candidate.description);
      previous = { id: candidate.id, fingerprint: progressFingerprint(observation) };
      minimumMs = candidate.action.type === 'swipe' || candidate.action.type === 'launch' ? 350 : 120;
    }
    if (!settings) this.explicitlyPaused = true;
    throw new Error('Task reached the action limit; stopped. Please take over, then say continue.');
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
  private propose(observation: PhoneObservation, control: { label: string; resourceId: string }, request: PhoneRequest, revision: number) {
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
    const proposal: PendingMessage = { ...(this.currentStep && { stepKey: this.currentStep.key }), id: randomUUID(), operation: 'send_message', app, recipient, message, revision, target: { packageName: observation.app.packageName, ...control } };
    this.proposal = proposal;
    const warning = this.execution.sendUnknown ? ' An earlier send may already have gone through.' : '';
    this.finish('confirming', `Send ${JSON.stringify(message)} to ${recipient} in ${app}?${warning}`, revision, { id: proposal.id, operation: proposal.operation, app, recipient, message });
    return true;
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
      && capabilityFor(current)?.effect(element, current)?.kind === 'send_message');
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
        this.finish('completed', `Sent ${JSON.stringify(proposal.message)} to ${proposal.recipient}. It shows as sent in the conversation.`, revision, undefined, { kind: 'message_sent', packageName: target.packageName, recipient: proposal.recipient, message: proposal.message });
        return;
      }
      if (result === 'failed') {
        this.finish('blocked', `${proposal.app} shows the message to ${proposal.recipient} as not sent. I won't retry it on my own.`, revision);
        return;
      }
    }
    this.finish('unknown', `I tapped send, but the message doesn't show as sent to ${proposal.recipient} yet. I won't send it again; check the conversation.`, revision);
  }

  private async createClock(proposal: ClockProposal, revision: number, signal: AbortSignal) {
    const owns = () => revision === this.revision && !signal.aborted;
    if (!this.native || !owns()) return;
    // Refresh both foreground evidence and handler availability after the user's answer.
    await this.phone.state();
    if (!owns()) return;
    const handler = await executeNativeCommand({ name: 'resolve_handler', args: { target: proposal.operation === 'create_timer' ? 'timer' : 'alarm' } }, this.native);
    if (!owns()) return;
    if (handler.status !== 'observed' || !('available' in handler) || !handler.available) {
      this.finish('blocked', handler.status === 'blocked' ? `${handler.reason}. Nothing was created; please use Clock manually.` : 'Clock is unavailable. Nothing was created; please use the Clock app.', revision); return;
    }
    if (handler.handlerPackage !== proposal.handlerPackage) { this.finish('blocked', 'The Clock handler changed after approval. Say continue to review a fresh proposal.', revision); return; }
    if (this.execution.clockUnknown) { this.finish('unknown', 'Check the earlier Clock creation before creating another.', revision); return; }
    this.execution.clockUnknown = proposal.command;
    let result;
    try { result = await executeNativeCommand(proposal.command, this.native); }
    catch { if (owns()) this.finish('unknown', 'Clock outcome is unknown. Inspect Clock before creating another.', revision); return; }
    // Clear a definite denial even if speech superseded the reporting revision.
    if (result.status === 'blocked') this.execution.clockUnknown = undefined;
    if (!owns()) return;
    if (result.status === 'blocked') { this.finish('blocked', `${result.reason} Please use Clock manually or fix its permission, then ask again.`, revision); return; }
    if (result.status !== 'handoff') { this.finish('unknown', 'Clock outcome is unknown. Inspect Clock before creating another.', revision); return; }
    try {
      const observation = await this.phone.state();
      if (!owns()) return;
      const opened = observation.app.packageName === result.handlerPackage;
      this.finish('unknown', opened ? 'Clock opened, but the created timer or alarm is not independently verified. Please check Clock; I will not create it again.' : 'Clock accepted the request, but its resulting screen and event are not verified. Please check Clock; I will not create it again.', revision, undefined, { kind: 'intent_handoff', operation: proposal.operation, handlerPackage: result.handlerPackage, verified: false });
    } catch { if (owns()) this.finish('unknown', 'Clock accepted the request, but the result is not verified. Please check Clock.', revision); }
  }

  private finish(state: TaskStatus['state'], detail: string, revision: number, proposal?: Proposal, evidence?: OperationEvidence) {
    if (revision !== this.revision) return;
    const step = this.currentStep;
    if (step) {
      step.state = state === 'working' || state === 'paused' ? 'pending' : state;
      step.detail = detail;
      if (evidence) step.evidence = evidence;
      if (state === 'completed') {
        if (this.plan.length > 1) this.emit({ type: 'task', state: 'working', goal: this.goal, detail, revision, progress: this.progress() });
        return;
      }
    }
    this.active = false;
    const pending = this.plan.filter(operation => operation.state !== 'completed');
    const partial = this.plan.length > 1 ? ` ${this.plan.length - pending.length}/${this.plan.length} outcomes established; unfinished: ${pending.map(operation => operation.label).join(', ')}.` : '';
    this.emit({ type: 'task', state, goal: this.goal, detail: detail + partial, revision, ...(proposal && { proposal }), ...(evidence && { evidence }),
      ...(this.plan.length > 1 && { progress: this.progress() }) });
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
