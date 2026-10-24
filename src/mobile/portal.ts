import { z } from 'zod';

const configuration = z.object({
  PORTAL_URL: z.url().default('http://127.0.0.1:8080'),
  PORTAL_TOKEN: z.string().trim().min(1, 'Set PORTAL_TOKEN in .env'),
});

const replySchema = z.object({
  status: z.string(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.string().optional(),
});

const boundsSchema = z.object({
  left: z.number(),
  top: z.number(),
  right: z.number(),
  bottom: z.number(),
});

const nodeSchema = z.object({
  resourceId: z.string(),
  className: z.string(),
  packageName: z.string(),
  text: z.string(),
  contentDescription: z.string(),
  stateDescription: z.string(),
  boundsInScreen: boundsSchema,
  isClickable: z.boolean(),
  isCheckable: z.boolean(),
  isChecked: z.boolean(),
  isEnabled: z.boolean(),
  isVisibleToUser: z.boolean(),
  isScrollable: z.boolean(),
  isEditable: z.boolean(),
  isPassword: z.boolean(),
  actionList: z.array(z.object({ id: z.number(), name: z.string() })),
  rangeInfo: z.object({
    type: z.number(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    current: z.number().nullable(),
  }).nullish(),
  get children() {
    return z.array(nodeSchema);
  },
});

const stateSchema = z.object({
  a11y_tree: nodeSchema,
  phone_state: z.object({
    currentApp: z.string().nullish(),
    packageName: z.string().nullish(),
    activityName: z.string().nullish(),
  }),
});

type UiNode = z.infer<typeof nodeSchema>;

function childLabels(node: UiNode): string[] {
  const label = node.text || node.contentDescription;
  return label ? [label] : node.children.flatMap(childLabels);
}

function checkableControls(node: UiNode): UiNode[] {
  return node.isCheckable ? [node] : node.children.flatMap(checkableControls);
}

function describeElement(node: UiNode, index: number, text: string) {
  const controls = node.isClickable ? checkableControls(node) : [];
  // Android preferences often put the label and an unlabeled switch in one clickable row.
  const control = node.isCheckable ? node : controls.length === 1 ? controls[0] : undefined;
  return {
    index,
    resourceId: node.resourceId,
    className: node.className,
    text: node.isPassword ? '[password field]' : text,
    bounds: node.boundsInScreen,
    clickable: node.isClickable,
    enabled: node.isEnabled,
    checked: control?.isChecked ?? null,
    state: node.stateDescription || control?.stateDescription || '',
    editable: node.isEditable && !node.isPassword,
    scrollable: node.isScrollable,
    scrollDirections: {
      up: node.actionList.some(action => action.name === 'SCROLL_BACKWARD' || action.name === 'SCROLL_UP'),
      down: node.actionList.some(action => action.name === 'SCROLL_FORWARD' || action.name === 'SCROLL_DOWN'),
    },
    range: node.rangeInfo ?? null,
  };
}

function visibleElements(root: UiNode) {
  const elements: ReturnType<typeof describeElement>[] = [];
  const screen = root.boundsInScreen;
  function visit(node: UiNode) {
    const bounds = node.boundsInScreen;
    const visible = node.isVisibleToUser
      && bounds.right > Math.max(bounds.left, screen.left)
      && bounds.bottom > Math.max(bounds.top, screen.top)
      && bounds.left < screen.right
      && bounds.top < screen.bottom;
    const label = node.text || node.contentDescription
      || (node.isClickable ? node.children.flatMap(childLabels).slice(0, 3).join(' | ') : '');
    if (visible && (label || node.isScrollable || node.rangeInfo)) {
      elements.push(describeElement(node, elements.length + 1, label));
    }
    node.children.forEach(visit);
  }
  visit(root);
  return elements;
}

export function parseObservation(raw: unknown) {
  const state = stateSchema.parse(raw);
  const bounds = state.a11y_tree.boundsInScreen;
  return {
    app: {
      currentApp: state.phone_state.currentApp || state.a11y_tree.packageName,
      packageName: state.phone_state.packageName || state.a11y_tree.packageName,
      activityName: state.phone_state.activityName || '',
    },
    rootPackage: state.a11y_tree.packageName,
    screen: { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
    elements: visibleElements(state.a11y_tree),
  };
}

type Parameters = Record<string, string | number | boolean>;

export function createPortal(environment: NodeJS.ProcessEnv = process.env) {
  const config = configuration.parse(environment);
  const base = new URL(config.PORTAL_URL);

  async function request(path: string, parameters?: Parameters) {
    const body = parameters === undefined
      ? undefined
      : new URLSearchParams(
          Object.entries(parameters).map(([key, value]) => [key, String(value)]),
        );
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${config.PORTAL_TOKEN}` },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (cause) {
      throw new Error(
        'Cannot reach Portal. Check its HTTP Server and the development connection.',
        { cause },
      );
    }
    if (!response.ok) {
      throw new Error(`Portal ${path}: HTTP ${response.status}`);
    }
    return response;
  }

  function decodeReply(raw: unknown) {
    const reply = replySchema.parse(raw);
    if (reply.status !== 'success') {
      const detail = reply.message
        ?? (typeof reply.error === 'string' ? reply.error : 'Device rejected the action');
      throw new Error(`Portal: ${detail}`);
    }
    // Some Portal versions encode their result as a JSON string.
    if (typeof reply.result === 'string') {
      try {
        const decoded: unknown = JSON.parse(reply.result);
        return decoded;
      } catch {
        return reply.result;
      }
    }
    return reply.result;
  }

  async function json(path: string, parameters?: Parameters) {
    const response = await request(path, parameters);
    const raw: unknown = await response.json();
    return decodeReply(raw);
  }

  return {
    version: () => json('/version'),
    async state() {
      return parseObservation(await json('/state_full?filter=true'));
    },
    openSettings: () => json('/app', { package: 'com.android.settings' }),
    tap: (x: number, y: number) => json('/tap', { x, y }),
    swipe: (startX: number, startY: number, endX: number, endY: number) =>
      json('/swipe', { startX, startY, endX, endY, duration: 300 }),
    back: () => json('/global', { action: 1 }),
    async screenshot() {
      const response = await request('/screenshot');
      let bytes: Uint8Array;
      if (response.headers.get('content-type')?.includes('application/json')) {
        const raw: unknown = await response.json();
        const encoded = z.string().parse(decodeReply(raw));
        bytes = Buffer.from(encoded.replace(/^data:image\/png;base64,/, ''), 'base64');
      } else {
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!pngSignature.every((byte, index) => bytes[index] === byte)) {
        throw new Error('Portal did not return a PNG screenshot; check accessibility access');
      }
      return bytes;
    },
  };
}

export type PhoneObservation = ReturnType<typeof parseObservation>;

export type PhoneControl = Pick<ReturnType<typeof createPortal>, 'state' | 'openSettings' | 'tap' | 'swipe' | 'back'>;
