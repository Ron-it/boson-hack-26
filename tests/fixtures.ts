import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { parseObservation, type PhoneControl } from '../src/mobile/portal.ts';
import { DeviceConnection } from '../src/server/device.ts';
import type { ScreenDescriber } from '../src/server/help.ts';
import type { createSelector } from '../src/mobile/selectors.ts';
import { VoiceSession } from '../src/server/voice.ts';

/** Answers one Portal request. Throwing becomes a Portal error reply. */
export type Portal = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

const outputSchema = z.object({ type: z.literal('conversation.item.create'), item: z.object({ call_id: z.string(), output: z.string() }) });

const quietNode = { resourceId: '', className: 'android.widget.FrameLayout', packageName: 'com.example.launcher', text: '', contentDescription: '', stateDescription: '', boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 }, isClickable: false, isCheckable: false, isChecked: false, isEnabled: true, isVisibleToUser: true, isScrollable: false, isEditable: false, isPassword: false, actionList: [], children: [] };
/** A Portal showing one quiet home screen, for voice journeys whose phone work is native or blocked. */
export const quietScreen: Portal = method => method === 'state' ? { a11y_tree: quietNode, phone_state: { currentApp: 'Launcher', packageName: 'com.example.launcher', activityName: 'Home' } } : {};
/** A screen model that sets media volume natively in one step, standing in for any quick native request. */
export const mediaVolume = (percent = 40) => ({ decide: async () => ({ actionId: 'set_media_volume', text: null, value: percent, finish: true, confidence: null, returnedModel: null }) });

export async function harness(portal: Portal, options: { describeScreen?: ScreenDescriber | null; selector?: Pick<ReturnType<typeof createSelector>, 'decide'>; holdResponses?: boolean; responseDeadlineMs?: number; native?: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown> } = {}) {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const accepted: WebSocket[] = [];
  const nextAccepted = () => new Promise<WebSocket>(resolve => server.once('connection', ws => { accepted.push(ws); resolve(ws); }));

  const portalSeen: string[] = [];
  const deviceSide = nextAccepted();
  const portalClient = new WebSocket(url);
  portalClient.on('message', data => {
    const request = z.object({ id: z.string(), method: z.string(), params: z.record(z.string(), z.unknown()) }).parse(JSON.parse(data.toString()));
    portalSeen.push(request.method);
    Promise.resolve().then(() => portal(request.method, request.params)).then(
      result => portalClient.send(JSON.stringify({ id: request.id, status: 'success', result: JSON.stringify(result) })),
      (error: unknown) => portalClient.send(JSON.stringify({ id: request.id, status: 'error', error: error instanceof Error ? error.message : 'failed' })));
  });
  const device = new DeviceConnection(await deviceSide, 'test-phone');

  const appSide = nextAccepted();
  const appClient = new WebSocket(url);
  const appEvents: { type: string; [key: string]: unknown }[] = [];
  appClient.on('message', data => {
    const event = z.looseObject({ type: z.string() }).parse(JSON.parse(data.toString()));
    appEvents.push(event);
    const command = z.object({ type: z.literal('command'), id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }).safeParse(event);
    if (command.success && options.native) void Promise.resolve(options.native(command.data.name, command.data.args))
      .then(result => appClient.send(JSON.stringify({ type: 'command_result', id: command.data.id, result })));
  });
  const appSocket = await appSide;

  const bosonSide = nextAccepted();
  const boson = new WebSocket(url);
  const { holdResponses = false, native: _native, ...adapters } = options;
  const session = new VoiceSession(appSocket, device, { BOSON_API_KEY: 'synthetic' }, {
    voiceSocket: await bosonSide,
    selector: { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) },
    describeScreen: null, ...adapters,
  });
  await once(boson, 'open');
  const outputs: { call_id: string; output: unknown }[] = [];
  /** Instructions of each response the server asked Boson to speak, such as a task announcement. */
  const announcements: string[] = [];
  const responseRequests: { instructions: string; input?: unknown }[] = [];
  let spoken = 0;
  /** While held, responses the server starts stay in progress, as if Boson were still speaking them. */
  let held: string[] | undefined = holdResponses ? [] : undefined;
  const finish = (id: string) => boson.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed', output: [] } }));
  boson.on('message', data => {
    const event: unknown = JSON.parse(data.toString());
    const parsed = outputSchema.safeParse(event);
    if (parsed.success) outputs.push({ call_id: parsed.data.item.call_id, output: JSON.parse(parsed.data.item.output) });
    const response = z.object({ type: z.literal('response.create'), response: z.object({ instructions: z.string(), metadata: z.record(z.string(), z.string()).optional(), input: z.unknown().optional() }).optional() }).safeParse(event);
    if (response.success) {
      // Boson speaks the response and finishes it, so the server may announce again.
      if (response.data.response) { announcements.push(response.data.response.instructions); responseRequests.push(response.data.response); }
      const id = `spoken_${++spoken}`;
      boson.send(JSON.stringify({ type: 'response.created', response: { id, metadata: response.data.response?.metadata } }));
      if (held) held.push(id); else finish(id);
    }
  });

  let calls = 0;
  async function call(name: string, args: object) {
    const callId = `call_${++calls}`;
    boson.send(JSON.stringify({ type: 'response.created', response: { id: callId, metadata: null } }));
    boson.send(JSON.stringify({ type: 'response.done', response: { id: callId, status: 'completed', output: [{ type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }] } }));
    for (const deadline = performance.now() + 5000; performance.now() < deadline;) {
      const result = outputs.find(item => item.call_id === callId);
      if (result) return result.output;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`No tool output for ${name}`);
  }

  /** The user starts and stops speaking, as Boson's voice activity detection reports it. */
  function speak() {
    boson.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    boson.send(JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }));
  }

  /** Waits on wall-clock time, so a slow runner gets the full budget instead of fewer polls. */
  async function until<T>(find: () => T | undefined, what: string, timeout = 8000) {
    for (const deadline = performance.now() + timeout; performance.now() < deadline;) {
      const found = find();
      if (found !== undefined) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  /** Boson finishes every held response and finishes later ones immediately. */
  function releaseResponses() { const ids = held ?? []; held = undefined; ids.forEach(finish); }

  return {
    call, speak, until, releaseResponses, portalSeen, appEvents, announcements, responseRequests,
    provider: (event: object) => boson.send(JSON.stringify(event)),
    async close() {
      session.close();
      for (const ws of [portalClient, appClient, boson, ...accepted]) ws.terminate();
      server.close();
    },
  };
}

const messaging = 'com.google.android.apps.messaging';
const contacts = [
  { name: 'Avery Testcontact', number: '(555) 010-0001' },
  { name: 'Jordan Testone', number: '(555) 010-0002' },
  { name: 'Jordan Testtwo', number: '(555) 010-0003' },
];

function messagingView(overrides: Record<string, unknown> = {}) {
  return {
    resourceId: '', className: 'android.view.View', packageName: messaging,
    text: '', contentDescription: '', stateDescription: '',
    boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 },
    isClickable: false, isCheckable: false, isChecked: false,
    isEnabled: true, isVisibleToUser: true, isScrollable: false,
    isEditable: false, isPassword: false, actionList: [], children: [],
    ...overrides,
  };
}

const row = (top: number) => ({ left: 0, top, right: 1080, bottom: top + 150 });

type Bubble = { recipient: string; text: string; from: 'me' | 'them'; status: 'sent' | 'sending' | 'failed' };

/**
 * A synthetic Messages app shaped like the emulator's Google Messages accessibility tree, with only test contacts.
 * Resource IDs, labels and bubble descriptions mirror what Portal returned on emulator-5554.
 */
export function messagesApp(options: {
  /** What a send tap does. Default: a new bubble that shows as sent. */
  sendOutcome?: 'sent' | 'dropped' | 'sending' | 'failed' | 'throws';
  /** Bubbles already in conversations, such as an earlier identical message. */
  history?: Bubble[];
  /** Extra clickable controls in the conversation, by label. */
  extraControls?: string[];
  /** Overrides the send button's label, to model a final control the operator does not understand. */
  sendLabel?: string;
  disconnectAfterSend?: boolean;
  /** Held before state reads that follow a send, so a test can act while the operator awaits. */
  readGate?: Promise<void>;
  /** Held before the send tap resolves. */
  tapGate?: Promise<void>;
} = {}) {
  let screen: 'home' | 'list' | 'pick' | 'conversation' | 'contacts' = 'home';
  let query = '';
  let recipient = '';
  let draft = '';
  let focused: 'search' | 'compose' | undefined;
  let disconnected = false;
  let heldReads = 0;
  const bubbles: Bubble[] = [...options.history ?? []];
  const taps: string[] = [];
  const sendAttempts = () => taps.filter(tap => tap === (options.sendLabel ?? 'Send SMS')).length;

  function tree() {
    if (screen === 'home') return messagingView({ packageName: 'com.google.android.apps.nexuslauncher', children: [messagingView({ packageName: 'com.google.android.apps.nexuslauncher', text: 'Messages', isClickable: true, boundsInScreen: row(100) })] });
    if (screen === 'contacts') return messagingView({ packageName: 'com.google.android.contacts', children: [
      messagingView({ packageName: 'com.google.android.contacts', text: 'Delete contact', isClickable: true, boundsInScreen: row(100) }),
      messagingView({ packageName: 'com.google.android.contacts', text: 'Avery Testcontact', isClickable: true, boundsInScreen: row(300) }),
    ] });
    if (screen === 'list') return messagingView({ children: [
      messagingView({ isClickable: true, boundsInScreen: row(100), children: [messagingView({ contentDescription: 'Search messages', boundsInScreen: row(100) })] }),
      messagingView({ isClickable: true, boundsInScreen: row(2000), children: [messagingView({ text: 'Start chat', boundsInScreen: row(2000) })] }),
    ] });
    if (screen === 'pick') return messagingView({ children: [
      messagingView({ className: 'android.widget.EditText', resourceId: 'ContactSearchField', isEditable: true, isClickable: true, boundsInScreen: row(100),
        children: query ? [] : [messagingView({ className: 'android.widget.TextView', text: 'Type name, phone number, or email', boundsInScreen: row(100) })], text: query }),
      // Before a search, rows carry contact_row IDs; once a query is typed, suggestions are unlabeled rows in a list.
      messagingView({ resourceId: query ? 'ContactSuggestionList' : 'contact_list', boundsInScreen: { left: 0, top: 400, right: 1080, bottom: 2000 }, children: contacts
        .filter(contact => contact.name.toLowerCase().includes(query.toLowerCase())).map((contact, index) => messagingView({
          resourceId: query ? '' : `contact_row_test_prefix_${index + 1}`, isClickable: true, boundsInScreen: row(400 + index * 200),
          children: [messagingView({ text: contact.name, boundsInScreen: row(400 + index * 200) }), messagingView({ text: query ? `${contact.number} · Mobile` : contact.number, boundsInScreen: row(400 + index * 200) })],
        })) }),
    ] });
    const label = draft ? options.sendLabel ?? 'Send SMS' : 'Show record a voice message screen';
    return messagingView({ children: [
      messagingView({ resourceId: 'top_app_bar', boundsInScreen: row(100), children: [messagingView({ className: 'android.widget.TextView', text: recipient, boundsInScreen: row(100) })] }),
      ...bubbles.filter(bubble => bubble.recipient === recipient).map((bubble, index) => messagingView({
        className: 'android.widget.TextView', resourceId: `${messaging}:id/message_text`, text: bubble.text, boundsInScreen: row(600 + index * 160),
        contentDescription: `${bubble.from === 'me' ? 'You' : recipient} said  ${bubble.text} 2:38 AM ${bubble.status === 'sending' ? 'Sending' : bubble.status === 'failed' ? 'Not sent, tap to retry' : ''}.`,
      })),
      // The emulator's Messages also names the recipient in the conversation banner.
      messagingView({ className: 'android.widget.TextView', resourceId: `${messaging}:id/message_text`, text: `Texting with ${recipient.split(' ')[0]} (SMS/MMS)`, boundsInScreen: row(400) }),
      ...(options.extraControls ?? []).map((text, index) => messagingView({ isClickable: true, boundsInScreen: { left: 0, top: 2000 + index, right: 200, bottom: 2100 }, children: [messagingView({ contentDescription: text, boundsInScreen: { left: 0, top: 2000, right: 200, bottom: 2100 } })] })),
      messagingView({ className: 'android.widget.EditText', resourceId: `${messaging}:id/compose_message_text`, text: draft || 'Text message', isEditable: true, isClickable: true, boundsInScreen: { left: 0, top: 2200, right: 900, bottom: 2350 } }),
      messagingView({ resourceId: 'Compose:Draft:Send', isClickable: true, boundsInScreen: { left: 900, top: 2200, right: 1080, bottom: 2350 }, children: [messagingView({ contentDescription: label, boundsInScreen: { left: 900, top: 2200, right: 1080, bottom: 2350 } })] }),
    ] });
  }

  const raw = () => ({ a11y_tree: tree(), phone_state: { packageName: tree().packageName, activityName: screen } });
  const observe = () => parseObservation(raw());
  async function state() {
    if (sendAttempts() > 0 && options.readGate) { heldReads++; await options.readGate; }
    if (disconnected) throw new Error('Phone is disconnected');
    return observe();
  }
  async function tap(x: number, y: number) {
    const target = observe().elements.filter(element => element.clickable && x >= element.bounds.left && x < element.bounds.right && y >= element.bounds.top && y < element.bounds.bottom).at(-1);
    taps.push(target?.text ?? 'nothing');
    if (!target) return;
    if (target.text === 'Start chat') { screen = 'pick'; focused = 'search'; }
    else if (target.resourceId === 'ContactSearchField') focused = 'search';
    else if (target.resourceId.endsWith('compose_message_text')) focused = 'compose';
    else if (screen === 'pick' && target.text.includes(' | (555)')) { recipient = target.text.split(' | ')[0] ?? ''; screen = 'conversation'; focused = 'compose'; }
    else if (target.resourceId === 'Compose:Draft:Send' && draft) {
      if (options.tapGate) await options.tapGate;
      const outcome = options.sendOutcome ?? 'sent';
      if (outcome === 'throws') throw new Error('Synthetic disconnect after dispatch');
      if (outcome !== 'dropped') bubbles.push({ recipient, text: draft, from: 'me', status: outcome });
      draft = '';
      if (options.disconnectAfterSend) disconnected = true;
    }
  }
  function typeText(text: string) {
    if (focused === 'search') query = text;
    else if (focused === 'compose') draft = text;
    else throw new Error('No focused field');
  }
  const launch = (packageName: string) => {
    if (packageName === messaging) screen = 'list';
    if (packageName === 'com.google.android.contacts') screen = 'contacts';
  };
  const packages = () => [{ packageName: messaging, label: 'Messages' }, { packageName: 'com.google.android.contacts', label: 'Contacts' }];
  const phone: PhoneControl = {
    state, tap, typeText: async text => typeText(text),
    launch: async packageName => launch(packageName), packages: async () => packages(),
    swipe: async () => {}, back: async () => {},
  };
  /** The same app behind the Portal request protocol, for voice journeys. */
  const portal: Portal = async (method, params) => {
    const number = (key: string) => z.number().parse(params[key]);
    switch (method) {
      case 'state': return raw();
      case 'tap': await tap(number('x'), number('y')); return {};
      case 'keyboard/input': typeText(Buffer.from(z.string().parse(params.base64_text), 'base64').toString()); return {};
      case 'app': launch(z.string().parse(params.package)); return {};
      case 'packages': return packages();
      default: throw new Error(`Unexpected ${method}`);
    }
  };
  const sent = () => bubbles.filter(bubble => bubble.from === 'me' && !options.history?.includes(bubble)).map(({ recipient, text }) => ({ recipient, text }));
  return { phone, portal, taps, sendAttempts, heldReads: () => heldReads, relabelSend: (label: string) => { options.sendLabel = label; }, get sent() { return sent(); }, edit: (text: string) => { draft = text; }, get draft() { return draft; } };
}
