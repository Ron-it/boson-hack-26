import type { PhoneObservation } from './portal.ts';
import type { ContentSelection, OutcomeEvidence, WorkflowRequest } from './workflows.ts';

type Element = PhoneObservation['elements'][number];

/**
 * What tapping or typing into a control is known to do. The operator only dispatches controls with an effect;
 * a control without one is unknown and leads to a question or handoff instead.
 */
export type Effect =
  | { kind: 'navigate' }
  | { kind: 'pick_contact'; name: string }
  | { kind: 'enter'; field: string }
  | { kind: 'open_content'; name: string; viewer: 'image' }
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
  outcome?(observation: PhoneObservation, request: WorkflowRequest, selection?: ContentSelection): OutcomeEvidence | undefined;
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

/** DocumentsUI's search filters locally as text changes. No Enter, submit, provider write or file deletion is exposed. */
function files(packageName: string): AppCapability {
  const owns = (element: Element, id: string) => element.resourceId === `${packageName}:id/${id}`;
  const images = (observation: PhoneObservation) => observation.elements.filter(element => owns(element, 'item_root') && element.clickable)
    .flatMap(row => observation.elements.filter(child => child.parent === row.index && child.resourceId === 'android:id/title' && /\.(png|jpe?g|webp|gif)$/i.test(child.text))
      .map(child => ({ row, name: child.text })));
  return {
    packageName,
    effect(element, observation) {
      if (!element.enabled) return undefined;
      if (element.editable && owns(element, 'search_src_text')) return { kind: 'enter', field: 'search' };
      if (element.clickable && owns(element, 'option_menu_search') && element.text === 'Search') return { kind: 'navigate' };
      const image = images(observation).find(image => image.row.index === element.index);
      if (image) return { kind: 'open_content', name: image.name, viewer: 'image' };
      // Category filters are controls in this installed app, not a global label-based tap policy.
      if (element.clickable && element.role === 'Button' && ['Images', 'Audio', 'Videos', 'Documents'].includes(element.text)) return { kind: 'navigate' };
      return undefined;
    },
    outcome(observation, request) {
      if (request.outcome?.kind !== 'search_results') return undefined;
      const query = request.outcome.query;
      if (!observation.elements.some(element => owns(element, 'search_src_text') && element.editable && element.text === query)) return undefined;
      const names = images(observation).map(image => image.name).filter(name => name.toLowerCase().includes(query.toLowerCase()));
      if (!names.length) return undefined;
      return { kind: 'search_results', packageName, query, matches: names, detail: `Files search ${JSON.stringify(query)} shows ${names.slice(0, 3).join(', ')}.` };
    },
  };
}

/** External image viewer observed when Files opens a PNG; its Share/overflow controls remain unsupported. */
const photosViewer: AppCapability = {
  packageName: 'com.google.android.apps.photos',
  effect: () => undefined,
  outcome(observation, request, selection) {
    if (request.outcome?.kind !== 'content_opened' || selection?.name !== request.outcome.name || selection.viewer !== 'image') return undefined;
    if (!observation.elements.some(element => element.resourceId === 'com.google.android.apps.photos:id/photos_photofragment_components_background_photo_view' && element.role === 'ImageView' && /^Photo taken on /.test(element.description))) return undefined;
    return { kind: 'content_opened', packageName: observation.rootPackage, selection,
      resourceId: 'com.google.android.apps.photos:id/photos_photofragment_components_background_photo_view',
      detail: `Opened the selected ${JSON.stringify(selection.name)} in the photo viewer.` };
  },
};

const capabilities = new Map([googleMessages, settings, brightnessDialog, files('com.google.android.documentsui'), files('com.android.documentsui'), photosViewer].map(capability => [capability.packageName, capability]));

/** Labels whose tap may be irreversible. The generic operator leaves these for the user. */
const irreversible = /\b(send|pay|buy|purchase|order|checkout|delete|remove|uninstall|erase|reset|submit|post|publish|transfer|place)\b/i;

/** Any other app: enabled labeled controls navigate and editable fields take model-chosen text. Irreversible labels are never offered. */
const generic: AppCapability = {
  packageName: '*',
  effect(element) {
    if (!element.enabled || irreversible.test(element.text) || irreversible.test(element.description)) return undefined;
    if (element.editable) return { kind: 'enter', field: 'text' };
    return element.clickable && (element.text || element.description) ? { kind: 'navigate' } : undefined;
  },
};

/** The supported controls of the foreground app. Apps without a dedicated capability get the generic one. */
export function capabilityFor(observation: PhoneObservation) {
  // A foreign dialog must not inherit the underlying app's privileges.
  return capabilities.get(observation.rootPackage) ?? generic;
}
