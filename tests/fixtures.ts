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
export type Portal = (method: string, params: Record<string, unknown>) => unknown;

const outputSchema = z.object({ type: z.literal('conversation.item.create'), item: z.object({ call_id: z.string(), output: z.string() }) });

export async function harness(portal: Portal, options: { describeScreen?: ScreenDescriber | null; selector?: Pick<ReturnType<typeof createSelector>, 'decide'> } = {}) {
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
    try { portalClient.send(JSON.stringify({ id: request.id, status: 'success', result: JSON.stringify(portal(request.method, request.params)) })); }
    catch (error) { portalClient.send(JSON.stringify({ id: request.id, status: 'error', error: error instanceof Error ? error.message : 'failed' })); }
  });
  const device = new DeviceConnection(await deviceSide, 'test-phone');

  const appSide = nextAccepted();
  const appClient = new WebSocket(url);
  const appEvents: { type: string; [key: string]: unknown }[] = [];
  appClient.on('message', data => appEvents.push(z.looseObject({ type: z.string() }).parse(JSON.parse(data.toString()))));
  const appSocket = await appSide;

  const bosonSide = nextAccepted();
  const boson = new WebSocket(url);
  const session = new VoiceSession(appSocket, device, { BOSON_API_KEY: 'synthetic' }, {
    voiceSocket: await bosonSide,
    selector: { decide: async () => ({ actionId: 'blocked', confidence: null, returnedModel: null }) },
    describeScreen: null, ...options,
  });
  await once(boson, 'open');
  const outputs: { call_id: string; output: unknown }[] = [];
  /** Instructions of each response the server asked Boson to speak, such as a task announcement. */
  const announcements: string[] = [];
  let spoken = 0;
  boson.on('message', data => {
    const event: unknown = JSON.parse(data.toString());
    const parsed = outputSchema.safeParse(event);
    if (parsed.success) outputs.push({ call_id: parsed.data.item.call_id, output: JSON.parse(parsed.data.item.output) });
    const response = z.object({ type: z.literal('response.create'), response: z.object({ instructions: z.string() }).optional() }).safeParse(event);
    if (response.success) {
      // Boson speaks the response and finishes it, so the server may announce again.
      if (response.data.response) announcements.push(response.data.response.instructions);
      const id = `spoken_${++spoken}`;
      boson.send(JSON.stringify({ type: 'response.created', response: { id } }));
      boson.send(JSON.stringify({ type: 'response.done', response: { id, status: 'completed', output: [] } }));
    }
  });

  let calls = 0;
  async function call(name: string, args: object) {
    const callId = `call_${++calls}`;
    boson.send(JSON.stringify({ type: 'response.created', response: { id: callId } }));
    boson.send(JSON.stringify({ type: 'response.done', response: { id: callId, status: 'completed', output: [{ type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) }] } }));
    for (let waited = 0; waited < 3000; waited += 10) {
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

  async function until<T>(find: () => T | undefined, what: string, timeout = 5000) {
    for (let waited = 0; waited < timeout; waited += 10) {
      const found = find();
      if (found !== undefined) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  return {
    call, speak, until, portalSeen, appEvents, announcements,
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

/** A synthetic Messages app shaped like the emulator's accessibility tree, with only test contacts. */
export function messagesApp(options: { failSend?: boolean; sendLeavesDraft?: boolean; disconnectAfterSend?: boolean } = {}) {
  let screen: 'home' | 'list' | 'pick' | 'conversation' = 'home';
  let query = '';
  let recipient = '';
  let draft = '';
  let focused: 'search' | 'compose' | undefined;
  let disconnected = false;
  const sent: { recipient: string; text: string }[] = [];
  const taps: string[] = [];

  function tree() {
    if (screen === 'home') return messagingView({ packageName: 'com.google.android.apps.nexuslauncher', children: [messagingView({ packageName: 'com.google.android.apps.nexuslauncher', text: 'Home', boundsInScreen: row(100) })] });
    if (screen === 'list') return messagingView({ children: [
      messagingView({ className: 'android.widget.Button', contentDescription: 'Search messages', isClickable: true, boundsInScreen: row(100) }),
      messagingView({ className: 'android.widget.Button', text: 'Start chat', resourceId: `${messaging}:id/start_chat_fab`, isClickable: true, boundsInScreen: row(2000) }),
    ] });
    if (screen === 'pick') return messagingView({ children: [
      messagingView({ className: 'android.widget.EditText', resourceId: 'ContactSearchField', text: query, isEditable: true, isClickable: true, boundsInScreen: row(100) }),
      ...contacts.filter(contact => contact.name.toLowerCase().includes(query.toLowerCase())).map((contact, index) => messagingView({
        resourceId: `contact_row_${index}`, isClickable: true, boundsInScreen: row(400 + index * 200),
        children: [messagingView({ text: contact.name, boundsInScreen: row(400 + index * 200) }), messagingView({ text: contact.number, boundsInScreen: row(400 + index * 200) })],
      })),
    ] });
    return messagingView({ children: [
      messagingView({ text: recipient, resourceId: `${messaging}:id/conversation_title`, boundsInScreen: row(100) }),
      // The emulator's Messages also names the recipient in the conversation banner.
      messagingView({ text: `Texting with ${recipient.split(" ")[0]} (SMS/MMS)`, boundsInScreen: row(300) }),
      ...sent.filter(item => item.recipient === recipient).map((item, index) => messagingView({ text: item.text, resourceId: `${messaging}:id/message_text`, boundsInScreen: row(600 + index * 160) })),
      messagingView({ className: 'android.widget.EditText', resourceId: `${messaging}:id/compose_message_text`, text: draft, isEditable: true, isClickable: true, boundsInScreen: { left: 0, top: 2200, right: 900, bottom: 2350 } }),
      messagingView({ className: 'android.widget.ImageButton', resourceId: `${messaging}:id/send_message_button`, contentDescription: 'Send SMS', isClickable: true, boundsInScreen: { left: 900, top: 2200, right: 1080, bottom: 2350 } }),
    ] });
  }

  const raw = () => ({ a11y_tree: tree(), phone_state: { packageName: tree().packageName, activityName: screen } });
  const observe = () => parseObservation(raw());
  function tap(x: number, y: number) {
    const target = observe().elements.filter(element => element.clickable && x >= element.bounds.left && x < element.bounds.right && y >= element.bounds.top && y < element.bounds.bottom).at(-1);
      taps.push(target?.text ?? 'nothing');
      if (!target) return;
      if (target.text === 'Start chat') { screen = 'pick'; focused = 'search'; }
      else if (target.resourceId === 'ContactSearchField') focused = 'search';
      else if (target.resourceId.endsWith('compose_message_text')) focused = 'compose';
      else if (target.resourceId.startsWith('contact_row')) { recipient = target.text.split(' | ')[0] ?? ''; screen = 'conversation'; focused = 'compose'; }
      else if (target.text === 'Send SMS') {
        if (options.failSend) throw new Error('Synthetic disconnect after dispatch');
        if (draft) { sent.push({ recipient, text: draft }); if (!options.sendLeavesDraft) draft = ''; }
        if (options.disconnectAfterSend) disconnected = true;
      }
  }
  function typeText(text: string) {
    if (focused === 'search') query = text;
    else if (focused === 'compose') draft = text;
    else throw new Error('No focused field');
  }
  const launch = (packageName: string) => { if (packageName === messaging) screen = 'list'; };
  const packages = () => [{ packageName: messaging, label: 'Messages' }, { packageName: 'com.google.android.contacts', label: 'Contacts' }];
  const phone: PhoneControl = {
    state: async () => { if (disconnected) throw new Error('Phone is disconnected'); return observe(); }, tap: async (x, y) => tap(x, y), typeText: async text => typeText(text),
    launch: async packageName => launch(packageName), packages: async () => packages(),
    swipe: async () => {}, back: async () => {}, openSettings: async () => {},
  };
  /** The same app behind the Portal request protocol, for voice journeys. */
  const portal: Portal = (method, params) => {
    const number = (key: string) => z.number().parse(params[key]);
    switch (method) {
      case 'state': return raw();
      case 'tap': return tap(number('x'), number('y')) ?? {};
      case 'keyboard/input': return typeText(Buffer.from(z.string().parse(params.base64_text), 'base64').toString()) ?? {};
      case 'app': return launch(z.string().parse(params.package)) ?? {};
      case 'packages': return packages();
      default: throw new Error(`Unexpected ${method}`);
    }
  };
  return { phone, portal, sent, taps, edit: (text: string) => { draft = text; }, get draft() { return draft; } };
}

