import type { PhoneObservation } from './portal.ts';

type Element = PhoneObservation['elements'][number];

/**
 * What tapping or typing into a control is known to do. The operator only dispatches controls with an effect;
 * a control without one is unknown and leads to a question or handoff instead.
 */
export type Effect =
  | { kind: 'navigate' }
  | { kind: 'pick_contact'; name: string }
  | { kind: 'enter'; field: 'recipient' | 'message' }
  | { kind: 'send_message' };

/** An outgoing message the app shows, with the delivery state it displays. */
export type Outgoing = { text: string; status: 'sent' | 'sending' | 'failed' };

/**
 * Controls of one installed app whose effects were established from that app's real accessibility tree.
 * Add an app or effect here to support it; labels alone are not treated as proof of what an arbitrary app does.
 */
export type AppCapability = {
  packageName: string;
  effect(element: Element, observation: PhoneObservation): Effect | undefined;
  /** Outgoing messages on screen, when the app supports sending. */
  outgoing?(observation: PhoneObservation): Outgoing[];
};

const resourceName = (element: Element) => element.resourceId.slice(element.resourceId.indexOf('/') + 1);

/**
 * Google Messages, as observed on emulator-5554 (messages.android_20260306_02_RC09).
 * The send control keeps its ID when the draft is empty but is then labeled as voice recording, so the label is checked too.
 * Pending and failed bubble wording were not observed on the device; they are treated as not sent.
 */
const googleMessages: AppCapability = {
  packageName: 'com.google.android.apps.messaging',
  effect(element, observation) {
    if (!element.enabled) return undefined;
    const id = resourceName(element);
    const picking = observation.elements.some(other => other.editable && resourceName(other) === 'ContactSearchField');
    if (element.editable && id === 'ContactSearchField') return { kind: 'enter', field: 'recipient' };
    if (element.editable && id === 'compose_message_text') return { kind: 'enter', field: 'message' };
    if (!element.clickable) return undefined;
    if (id === 'Compose:Draft:Send' && /^Send (SMS|MMS|message)$/i.test(element.text)) return { kind: 'send_message' };
    // Rows carry contact_row IDs before a search; search suggestions are unlabeled rows reading "Name | (555) 010-0001 · Mobile".
    const [name, number] = element.text.split(' | ');
    if (picking && name && (id.startsWith('contact_row') || (!id && number && /^[+(]?\d[\d\s().-]{6,}/.test(number)))) return { kind: 'pick_contact', name };
    if (element.text === 'Start chat') return { kind: 'navigate' };
    return undefined;
  },
  outgoing(observation) {
    return observation.elements.filter(element => resourceName(element) === 'message_text' && element.description.startsWith('You said'))
      .map(element => ({
        text: element.text,
        status: /not sent|failed|couldn.t send|retry/i.test(element.description) ? 'failed' : /sending|pending/i.test(element.description) ? 'sending' : 'sent',
      }));
  },
};

/** Words that suggest an irreversible Settings change. Settings controls remain as #6 left them, minus these. */
const settingsExclusions = /\b(reset|erase|delete|remove|uninstall|confirm|ok)\b/i;

/** Android Settings for the display requests established in #6, plus the brightness slider dialog. */
const settings: AppCapability = {
  packageName: 'com.android.settings',
  effect(element) {
    if (!element.enabled || settingsExclusions.test(element.text)) return undefined;
    return element.range || (element.clickable && element.text) ? { kind: 'navigate' } : undefined;
  },
};

const brightnessDialog: AppCapability = {
  packageName: 'com.android.systemui',
  effect: element => element.enabled && element.range && element.resourceId === 'com.android.systemui:id/slider' ? { kind: 'navigate' } : undefined,
};

const capabilities = new Map([googleMessages, settings, brightnessDialog].map(capability => [capability.packageName, capability]));

/** The supported controls of the foreground app, or undefined when none are understood. */
export function capabilityFor(observation: PhoneObservation) {
  return capabilities.get(observation.rootPackage) ?? capabilities.get(observation.app.packageName);
}
