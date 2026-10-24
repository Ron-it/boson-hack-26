import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { capabilityFor, type Effect } from './capabilities.ts';
import type { PhoneControl, PhoneObservation } from './portal.ts';

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal('swipe'), startX: z.number(), startY: z.number(),
    endX: z.number(), endY: z.number(),
  }),
  z.object({ type: z.literal('type'), x: z.number(), y: z.number(), field: z.enum(['recipient', 'message']), text: z.string() }),
  z.object({ type: z.literal('launch'), packageName: z.string() }),
  // A supported send control. It is never dispatched here; only the operator's approval gate can tap it.
  z.object({ type: z.literal('send'), label: z.string(), resourceId: z.string() }),
  z.object({ type: z.enum(['back', 'open_settings', 'wait', 'done', 'blocked', 'ask']) }),
]);

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
  request?: { recipient?: string | undefined; message?: string | undefined };
  apps?: { packageName: string; label: string }[];
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

export async function readStableScreen(portal: PhoneControl, signal: AbortSignal, minimumMs = 120) {
  const started = performance.now();
  const observation = await portal.state();
  let fingerprint = screenFingerprint(observation);
  let stableSince = performance.now();
  while (performance.now() - started < 2_000) {
    await delay(60, undefined, { signal });
    const next = await portal.state();
    const nextFingerprint = screenFingerprint(next);
    const now = performance.now();
    if (nextFingerprint !== fingerprint) stableSince = now;
    else if (now - stableSince >= 100 && now - started >= minimumMs) return next;
    fingerprint = nextFingerprint;
  }
  throw new Error('The screen did not settle within two seconds; no decision dispatched.');
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
        });
      }
    } else if (effect.kind === 'enter') {
      const text = context.request?.[effect.field];
      if (text) candidates.push({
        id: `type_${element.index}_${effect.field}`,
        description: `Type the requested ${effect.field} ${JSON.stringify(text)} into the field showing ${JSON.stringify(element.text)}. Replaces its text; does not send.`,
        action: { type: 'type', x, y, field: effect.field, text }, element, effect,
      });
    } else if (effect.kind === 'send_message') {
      candidates.push({
        id: `send_${element.index}`,
        description: `Ask the user for approval to send the requested message with ${JSON.stringify(element.text)}. It is sent only after they confirm.`,
        action: { type: 'send', label: element.text, resourceId: element.resourceId }, element, effect,
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

  if (screen && capability && observation.elements.some(element => element.scrollable)) {
    const x = Math.round(screen.width / 2);
    const upper = Math.round(screen.height * 0.3);
    const lower = Math.round(screen.height * 0.8);
    if (observation.elements.some(element => element.scrollDirections.down)) {
      candidates.push({ id: 'scroll_down', description: 'Scroll down to controls below the viewport.', action: { type: 'swipe', startX: x, startY: lower, endX: x, endY: upper } });
    }
    if (observation.elements.some(element => element.scrollDirections.up)) {
      candidates.push({ id: 'scroll_up', description: 'Scroll up to controls above the viewport.', action: { type: 'swipe', startX: x, startY: upper, endX: x, endY: lower } });
    }
  }
  candidates.push(
    { id: 'back', description: 'Go back or dismiss the current dialog.', action: { type: 'back' } },
    { id: 'open_settings', description: 'Open or return to Android Settings.', action: { type: 'open_settings' } },
    { id: 'wait', description: 'The screen is transitioning. Wait briefly and observe again.', action: { type: 'wait' } },
    { id: 'done', description: 'The latest request has been established by observed values on screen. Finish without further actions.', action: { type: 'done' } },
    { id: 'ask', description: 'The request or the screen is ambiguous, for example several matching contacts. Stop and ask the user.', action: { type: 'ask' } },
    { id: 'blocked', description: 'The allowed actions cannot advance the goal. Stop and hand back to the user.', action: { type: 'blocked' } },
  );
  if (candidates.length > 255) {
    throw new Error('This screen exceeds the decision-menu limit; no actions sent.');
  }
  return candidates;
}

export async function executeAction(portal: PhoneControl, candidate: ActionCandidate) {
  const action = actionSchema.parse(candidate.action);
  switch (action.type) {
    case 'tap': return portal.tap(action.x, action.y);
    case 'swipe': return portal.swipe(action.startX, action.startY, action.endX, action.endY);
    case 'type': await portal.tap(action.x, action.y); return portal.typeText(action.text);
    case 'launch': return portal.launch(action.packageName);
    case 'send': throw new Error('Sending needs the user\'s approval; nothing was tapped.');
    case 'back': return portal.back();
    case 'open_settings': return portal.openSettings();
    case 'wait': return new Promise<void>(resolve => setTimeout(resolve, 350));
    case 'done':
    case 'ask':
    case 'blocked': return;
  }
}
