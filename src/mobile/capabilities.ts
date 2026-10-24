import type { PhoneObservation } from './portal.ts';

type Element = PhoneObservation['elements'][number];

/**
 * What tapping or typing into a control does. The operator only dispatches controls with an effect;
 * a control without one is not offered.
 */
export type Effect =
  | { kind: 'navigate' }
  | { kind: 'pick_contact'; name: string }
  | { kind: 'enter'; field: string }
  | { kind: 'send_message' }
  /** A control whose tap may not be undoable (send, pay, delete). Tapped only after the user approves it. */
  | { kind: 'irreversible' };

/** An outgoing message the app shows, with the delivery state it displays. */
export type Outgoing = { text: string; status: 'sent' | 'sending' | 'failed' };

export type AppCapability = {
  packageName: string;
  effect(element: Element, observation: PhoneObservation): Effect | undefined;
  /** Outgoing messages on screen, when the app supports a verified send. */
  outgoing?(observation: PhoneObservation): Outgoing[];
  /** The screen redraws live content (countdowns, maps, media), so a control is re-found by id, role and position instead of exact identity. */
  liveContent?: true;
};

const resourceName = (element: Element) => element.resourceId.slice(element.resourceId.indexOf('/') + 1);

/** Labels whose tap may be irreversible. The operator asks the user before tapping these. */
const irreversible = /\b(send|pay|buy|purchase|order|checkout|delete|remove|uninstall|erase|reset|submit|post|publish|transfer|place)\b/i;

/** Any app: enabled labeled controls and sliders navigate, editable fields take model-chosen text, irreversible labels need approval. */
const generic: AppCapability = {
  packageName: '*',
  liveContent: true,
  effect(element) {
    if (!element.enabled) return undefined;
    if (element.editable) return { kind: 'enter', field: 'text' };
    if (element.range) return { kind: 'navigate' };
    if (!element.clickable || !(element.text || element.description)) return undefined;
    return irreversible.test(element.text) || irreversible.test(element.description) ? { kind: 'irreversible' } : { kind: 'navigate' };
  },
};

/**
 * Google Messages, as observed on emulator-5554 (messages.android_20260306_02_RC09): a send that types only the user's
 * recipient and words, confirms them, and verifies the sent bubble. While picking a contact, only the requested one is offered.
 * The send control keeps its ID when the draft is empty but is then labeled as voice recording, so the label is checked too.
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
    if (id === 'Compose:Draft:Send') return /^Send (SMS|MMS|message)$/i.test(element.text) ? { kind: 'send_message' } : undefined;
    // Rows carry contact_row IDs before a search; search suggestions are unlabeled rows reading "Name | (555) 010-0001 · Mobile".
    const [name, number] = element.text.split(' | ');
    if (picking && name && (id.startsWith('contact_row') || (!id && number && /^[+(]?\d[\d\s().-]{6,}/.test(number)))) return { kind: 'pick_contact', name };
    if (element.text === 'Start chat') return { kind: 'navigate' };
    return picking ? undefined : generic.effect(element, observation);
  },
  outgoing(observation) {
    return observation.elements.filter(element => resourceName(element) === 'message_text' && element.description.startsWith('You said'))
      .map(element => ({
        text: element.text,
        status: /not sent|failed|couldn.t send|retry/i.test(element.description) ? 'failed' : /sending|pending/i.test(element.description) ? 'sending' : 'sent',
      }));
  },
};

/** System UI: the notification shade, quick settings and volume or brightness panels. Generic, so timer, media and call controls are tappable. */
const systemUi: AppCapability = { ...generic, packageName: 'com.android.systemui' };

const capabilities = new Map([googleMessages, systemUi].map(capability => [capability.packageName, capability]));

/** The controls of the foreground window. Apps without a dedicated capability get the generic one. */
export function capabilityFor(observation: PhoneObservation) {
  // A foreign dialog must not inherit the underlying app's privileges.
  return capabilities.get(observation.rootPackage) ?? generic;
}
