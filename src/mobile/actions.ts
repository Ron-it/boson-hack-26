import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { capabilityFor, type Effect } from './capabilities.ts';
import { globalActions, type PhoneControl, type PhoneObservation } from './portal.ts';
import type { WorkflowRequest } from './workflows.ts';

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal('swipe'), startX: z.number(), startY: z.number(),
    endX: z.number(), endY: z.number(),
  }),
  z.object({ type: z.literal('type'), x: z.number(), y: z.number(), field: z.string(), text: z.string() }),
  z.object({ type: z.literal('launch'), packageName: z.string() }),
  // A supported send control. It is never dispatched here; only the operator's approval gate can tap it.
  z.object({ type: z.literal('send'), label: z.string(), resourceId: z.string() }),
  z.object({ type: z.enum(['back', 'open_settings', 'wait', 'done', 'blocked', 'ask', 'enter', 'open_app', 'open_link']) }),
  z.object({ type: z.literal('global'), action: z.enum(['home', 'recent_apps', 'notifications', 'quick_settings']) }),
  z.object({ type: z.literal('native'), tool: z.enum(['set_timer', 'set_alarm', 'set_media_volume', 'set_brightness']) }),
  // An irreversible control. It is never dispatched here; the operator asks the user first.
  z.object({ type: z.literal('confirm_tap'), x: z.number(), y: z.number(), label: z.string() }),
]);
export type NativeTool = Extract<z.infer<typeof actionSchema>, { type: 'native' }>['tool'];

type Element = PhoneObservation['elements'][number];

export type ActionCandidate = {
  id: string;
  description: string;
  action: z.infer<typeof actionSchema>;
  element?: Element;
  effect?: Effect;
};

/** Values the operator may type. They come from the user's request, never from the model or the screen. */
export type CandidateContext = {
  request?: WorkflowRequest & { recipient?: string | undefined; message?: string | undefined };
  apps?: { packageName: string; label: string }[];
  /** Which phone-wide tools exist here. Each one runs through Portal or a native command, never through screen taps. */
  tools?: { global?: boolean; key?: boolean; deepLink?: boolean; native?: boolean };
  /** The user already answered a question for this goal; the operator must act instead of asking again. */
  answered?: boolean;
};

export function assertSettingsScreen(observation: PhoneObservation) {
  const settings = observation.rootPackage === 'com.android.settings';
  const brightnessDialog = observation.rootPackage === 'com.android.systemui'
    && observation.elements.some(element => element.resourceId === 'com.android.systemui:id/slider');
  if (!settings && !brightnessDialog) {
    throw new Error('The display experiment stopped outside Settings. Unlock the phone and reopen Settings.');
  }
}

export function screenFingerprint(observation: PhoneObservation) {
  return createHash('sha256').update(JSON.stringify(observation)).digest('hex');
}

/** Only the foreground and coordinate frame need to settle; a clock is allowed to keep ticking. */
function frame(observation: PhoneObservation) {
  return JSON.stringify([observation.app.packageName, observation.app.activityName, observation.rootPackage, observation.rootBounds,
    observation.screen && { width: observation.screen.width, height: observation.screen.height }]);
}

function target(element: Element) {
  const { index: _index, parent: _parent, focused: _focused, ...identity } = element;
  return identity;
}

function lineage(element: Element, observation: PhoneObservation) {
  const path = [];
  let parent = element.parent;
  for (let depth = 0; parent !== null && depth < 32; depth++) {
    const ancestor = observation.elements.find(item => item.index === parent);
    if (!ancestor) return null;
    path.push({ resourceId: ancestor.resourceId, role: ancestor.role, bounds: ancestor.bounds, text: ancestor.text, state: ancestor.state });
    parent = ancestor.parent;
  }
  return path;
}

/** Passive live text is not progress. Controls, their state and their visible content are. */
export function progressFingerprint(observation: PhoneObservation) {
  return JSON.stringify([frame(observation), observation.elements.filter(element => element.clickable || element.editable || element.scrollable || element.range)
    .map(target)]);
}

const middle = (element: Element) => ({ x: (element.bounds.left + element.bounds.right) / 2, y: (element.bounds.top + element.bounds.bottom) / 2 });

/** Rebuild the allowed operation against the live target, ignoring traversal indices and unrelated content. */
export function targetIsCurrent(candidate: ActionCandidate, before: PhoneObservation, current: PhoneObservation, context: CandidateContext) {
  // Generic apps redraw constantly (maps, placeholders, live content). The same control near the same spot is enough;
  // every action they allow is reversible.
  if (capabilityFor(current).liveContent) {
    if (before.rootPackage !== current.rootPackage) return false;
    const element = candidate.element;
    if (!element) return true;
    const at = middle(element);
    // Labels carry live text (countdowns, prices), so a control is the same one when its id, role and spot match
    // and its label still starts the same way.
    const head = (text: string) => text.split(' | ')[0]?.trim() ?? '';
    return current.elements.some(other => other.resourceId === element.resourceId && other.role === element.role
      && (other.text === element.text || head(other.text) === head(element.text))
      && Math.abs(middle(other).x - at.x) < 48 && Math.abs(middle(other).y - at.y) < 48);
  }
  if (frame(before) !== frame(current)) return false;
  if (!candidate.element) return true;
  const identity = JSON.stringify(target(candidate.element));
  const matches = current.elements.filter(element => JSON.stringify(target(element)) === identity);
  const [match] = matches;
  if (matches.length !== 1 || !match) return false;
  if (JSON.stringify(lineage(candidate.element, before)) !== JSON.stringify(lineage(match, current))) return false;
  const live = actionCandidates(current, context).filter(item => item.element?.index === matches[0]?.index
    && JSON.stringify(item.action) === JSON.stringify(candidate.action)
    && JSON.stringify(item.effect) === JSON.stringify(candidate.effect));
  return live.length === 1;
}

export async function readStableScreen(portal: PhoneControl, signal: AbortSignal, minimumMs = 120) {
  const started = performance.now();
  const observation = await portal.state();
  let fingerprint = frame(observation);
  let stableSince = performance.now();
  while (performance.now() - started < 5_000) {
    await delay(60, undefined, { signal });
    const next = await portal.state();
    const nextFingerprint = frame(next);
    const now = performance.now();
    if (nextFingerprint !== fingerprint) stableSince = now;
    else if (now - stableSince >= 100 && now - started >= minimumMs) return next;
    fingerprint = nextFingerprint;
  }
  throw new Error('The foreground or display frame did not settle within five seconds; no decision dispatched.');
}

export function actionCandidates(observation: PhoneObservation, context: CandidateContext = {}): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  // Without display geometry, coordinates cannot be validated; only non-positional actions remain.
  const screen = observation.screen;
  // Only controls whose effect is known for this app are offered; everything else is unknown and never dispatched.
  const capability = capabilityFor(observation);
  if (screen && capability) for (const element of observation.elements) {
    const effect = capability.effect(element, observation);
    if (!effect) continue;
    const left = Math.max(0, element.bounds.left);
    const right = Math.min(screen.width, element.bounds.right);
    const top = Math.max(0, element.bounds.top);
    const bottom = Math.min(screen.height, element.bounds.bottom);
    if (right <= left || bottom <= top) continue;

    const x = Math.round((left + right) / 2);
    const y = Math.round((top + bottom) / 2);
    if (element.range) {
      for (let percent = 0; percent <= 100; percent += 10) {
        candidates.push({
          id: `slider_${element.index}_${percent}`,
          description: `Set the visible ${element.text || 'slider'} to approximately ${percent}% of its track. Verify the resulting value.`,
          action: { type: 'tap', x: Math.round(left + (right - left - 1) * percent / 100), y },
          element, effect,
        });
      }
    } else if (effect.kind === 'enter') {
      const text = effect.field === 'recipient' || effect.field === 'message' ? context.request?.[effect.field]
        : context.request?.values?.find(value => value.field === effect.field)?.text;
      if (text) candidates.push({
        id: `type_${element.index}_${effect.field}`,
        description: `Type the requested ${effect.field} ${JSON.stringify(text)} into the field showing ${JSON.stringify(element.text)}. Replaces its text; does not send.`,
        action: { type: 'type', x, y, field: effect.field, text }, element, effect,
      });
      // Free text: the selector supplies it with the decision, so the menu entry carries none.
      // Message recipients and wording only ever come from the user's request.
      else if (effect.field !== 'recipient' && effect.field !== 'message') candidates.push({
        id: `type_${element.index}_${effect.field}`,
        description: `Type text you choose into the field showing ${JSON.stringify(element.text || element.description)}. Replaces its text; does not submit. Supply the text.`,
        action: { type: 'type', x, y, field: effect.field, text: '' }, element, effect,
      });
    } else if (effect.kind === 'send_message') {
      candidates.push({
        id: `send_${element.index}`,
        description: `Ask the user for approval to send the requested message with ${JSON.stringify(element.text)}. It is sent only after they confirm.`,
        action: { type: 'send', label: element.text, resourceId: element.resourceId }, element, effect,
      });
    } else if (effect.kind === 'open_content') {
      const outcome = context.request?.outcome;
      if (outcome?.kind === 'content_opened' && effect.name === outcome.name) candidates.push({
        id: `open_${element.index}`, description: `Open the requested image ${JSON.stringify(effect.name)}.`, action: { type: 'tap', x, y }, element, effect,
      });
    } else if (effect.kind === 'irreversible') {
      const label = element.text || element.description;
      candidates.push({
        id: `confirm_${element.index}`,
        description: `Ask the user, then tap ${JSON.stringify(label)}. It may not be undoable; choose it only when the goal needs exactly this tap.`,
        action: { type: 'confirm_tap', x, y, label }, element, effect,
      });
    } else if (effect.kind === 'pick_contact') {
      // A contact is only offered when it matches the requested recipient; the operator never picks someone else.
      const recipient = context.request?.recipient;
      if (recipient && effect.name.toLowerCase().includes(recipient.toLowerCase())) candidates.push({
        id: `tap_${element.index}`, description: `Tap ${JSON.stringify(element.text)}.`, action: { type: 'tap', x, y }, element, effect,
      });
    } else {
      const current = element.checked === null ? '' : ` Currently ${element.checked ? 'ON' : 'OFF'}.`;
      candidates.push({
        id: `tap_${element.index}`,
        description: `Tap ${JSON.stringify(element.text)}.${current}`,
        action: { type: 'tap', x, y }, element, effect,
      });
    }
  }
  context.apps?.forEach((app, index) => candidates.push({
    id: `launch_${index}`, description: `Open ${app.label}.`, action: { type: 'launch', packageName: app.packageName },
  }));

  if (screen && capability) for (const element of observation.elements.filter(element => element.scrollable && element.enabled)) {
    const left = Math.max(0, element.bounds.left);
    const right = Math.min(screen.width, element.bounds.right);
    const top = Math.max(0, element.bounds.top);
    const bottom = Math.min(screen.height, element.bounds.bottom);
    if (right <= left || bottom - top < 80) continue;
    const x = Math.round((left + right) / 2);
    const upper = Math.round(top + (bottom - top) * 0.2);
    const lower = Math.round(top + (bottom - top) * 0.8);
    const suffix = candidates.some(candidate => candidate.id === 'scroll_down' || candidate.id === 'scroll_up') ? `_${element.index}` : '';
    if (element.scrollDirections.down) candidates.push({
      id: `scroll_down${suffix}`, description: 'Scroll down within the visible list.',
      action: { type: 'swipe', startX: x, startY: lower, endX: x, endY: upper }, element, effect: { kind: 'navigate' },
    });
    if (element.scrollDirections.up) candidates.push({
      id: `scroll_up${suffix}`, description: 'Scroll up within the visible list.',
      action: { type: 'swipe', startX: x, startY: upper, endX: x, endY: lower }, element, effect: { kind: 'navigate' },
    });
  }
  const tools = context.tools ?? {};
  // Enter can send in chat apps, so it is offered only when no send control is visible.
  const sendVisible = observation.elements.some(element => /\bsend\b/i.test(`${element.text} ${element.description}`));
  const fixed: ActionCandidate[] = [
    { id: 'back', description: 'Go back or dismiss the current dialog.', action: { type: 'back' } },
    ...tools.global ? [
      { id: 'home', description: 'Go to the home screen.', action: { type: 'global', action: 'home' } },
      { id: 'recent_apps', description: 'Show recent apps.', action: { type: 'global', action: 'recent_apps' } },
      { id: 'notifications', description: 'Open the notification shade (running timers, media and calls have controls there).', action: { type: 'global', action: 'notifications' } },
      { id: 'quick_settings', description: 'Open quick settings (Wi-Fi, Bluetooth, flashlight, do not disturb, rotation).', action: { type: 'global', action: 'quick_settings' } },
    ] satisfies ActionCandidate[] : [],
    ...tools.key && !sendVisible ? [{ id: 'enter', description: 'Press Enter to submit the focused field, for example a search.', action: { type: 'enter' } } satisfies ActionCandidate] : [],
    { id: 'open_app', description: 'Open an installed app by name. Supply the app name as text.', action: { type: 'open_app' } },
    ...tools.deepLink ? [{ id: 'open_link', description: 'Open a URI directly: https: pages, tel:+number to dial, geo:0,0?q=place for maps, mailto:, or an app link. Supply the URI as text.', action: { type: 'open_link' } } satisfies ActionCandidate] : [],
    ...tools.native ? [
      { id: 'set_timer', description: 'Start a countdown timer instantly. Supply seconds as value and an optional label as text.', action: { type: 'native', tool: 'set_timer' } },
      { id: 'set_alarm', description: 'Set an alarm instantly. Supply the 24-hour time as text, like "07:30".', action: { type: 'native', tool: 'set_alarm' } },
      { id: 'set_media_volume', description: 'Set media volume instantly. Supply the percentage as value.', action: { type: 'native', tool: 'set_media_volume' } },
      { id: 'set_brightness', description: 'Set screen brightness instantly. Supply the percentage (10-100) as value.', action: { type: 'native', tool: 'set_brightness' } },
    ] satisfies ActionCandidate[] : [],
    { id: 'open_settings', description: 'Open Android Settings.', action: { type: 'open_settings' } },
    { id: 'wait', description: 'The screen is transitioning. Wait briefly and observe again.', action: { type: 'wait' } },
    { id: 'done', description: 'The goal is achieved or its answer is visible. Supply the answer as text when the user asked something.', action: { type: 'done' } },
    ...context.answered ? [] : [{ id: 'ask', description: 'The goal itself is ambiguous (for example several matching contacts). Supply the specific question as text.', action: { type: 'ask' } } satisfies ActionCandidate],
    { id: 'blocked', description: 'Nothing offered can advance the goal. Stop and hand back to the user.', action: { type: 'blocked' } },
  ];
  // Keep the phone-wide tools when a dense screen overflows the menu.
  return [...candidates.slice(0, 255 - fixed.length), ...fixed];
}

export async function executeAction(portal: PhoneControl, candidate: ActionCandidate, beforeInput?: () => Promise<void>) {
  const action = actionSchema.parse(candidate.action);
  switch (action.type) {
    case 'tap': return portal.tap(action.x, action.y);
    case 'swipe': return portal.swipe(action.startX, action.startY, action.endX, action.endY);
    case 'type':
      if (!beforeInput) throw new Error('Text entry needs a fresh target and request check.');
      await portal.tap(action.x, action.y);
      await beforeInput();
      return portal.typeText(action.text);
    case 'launch': return portal.launch(action.packageName);
    case 'send': throw new Error('Sending needs the user\'s approval; nothing was tapped.');
    case 'back': return portal.back();
    case 'global':
      if (!portal.global) throw new Error('Global actions are unavailable on this connection.');
      return portal.global(globalActions[action.action]);
    case 'enter':
      if (!portal.key) throw new Error('Key events are unavailable on this connection.');
      return portal.key(66);
    case 'open_app':
    case 'open_link':
    case 'native': throw new Error('The operator resolves this action before dispatch.');
    case 'confirm_tap': throw new Error('This tap needs the user\'s approval; nothing was tapped.');
    case 'open_settings': return portal.openSettings();
    case 'wait': return new Promise<void>(resolve => setTimeout(resolve, 350));
    case 'done':
    case 'ask':
    case 'blocked': return;
  }
}
