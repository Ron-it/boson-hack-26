import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PhoneControl, PhoneObservation } from './portal.ts';

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal('swipe'), startX: z.number(), startY: z.number(),
    endX: z.number(), endY: z.number(),
  }),
  z.object({ type: z.enum(['back', 'open_settings', 'wait', 'done', 'blocked']) }),
]);

export type ActionCandidate = {
  id: string;
  description: string;
  action: z.infer<typeof actionSchema>;
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

export function actionCandidates(observation: PhoneObservation): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  // Without display geometry, coordinates cannot be validated; only non-positional actions remain.
  const screen = observation.screen;
  if (screen) for (const element of observation.elements) {
    if (!element.enabled) continue;
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
    } else if (element.clickable && element.text) {
      const current = element.checked === null ? '' : ` Currently ${element.checked ? 'ON' : 'OFF'}.`;
      candidates.push({
        id: `tap_${element.index}`,
        description: `Tap ${JSON.stringify(element.text)}.${current}`,
        action: { type: 'tap', x, y },
      });
    }
  }

  if (screen && observation.elements.some(element => element.scrollable)) {
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
    { id: 'done', description: 'The latest requested settings have been established by observed values. Finish without further actions.', action: { type: 'done' } },
    { id: 'blocked', description: 'The allowed actions cannot advance the goal, or clarification is required. Stop.', action: { type: 'blocked' } },
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
    case 'back': return portal.back();
    case 'open_settings': return portal.openSettings();
    case 'wait': return new Promise<void>(resolve => setTimeout(resolve, 350));
    case 'done':
    case 'blocked': return;
  }
}
