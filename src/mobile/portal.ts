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
  isFocused: z.boolean().optional(),
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

function describeElement(node: UiNode, index: number, text: string, parent: number | null) {
  const controls = node.isClickable ? checkableControls(node) : [];
  // Android preferences often put the label and an unlabeled switch in one clickable row.
  const control = node.isCheckable ? node : controls.length === 1 ? controls[0] : undefined;
  return {
    index,
    parent,
    resourceId: node.resourceId,
    className: node.className,
    role: node.className.slice(node.className.lastIndexOf('.') + 1),
    text: node.isPassword ? '[password field]' : text,
    /** The node's own content description, such as a message bubble's sender and delivery state. */
    description: node.isPassword ? '' : node.contentDescription,
    bounds: node.boundsInScreen,
    clickable: node.isClickable,
    enabled: node.isEnabled,
    checked: control?.isChecked ?? null,
    state: node.stateDescription || control?.stateDescription || '',
    editable: node.isEditable && !node.isPassword,
    ...(node.isFocused !== undefined && { focused: node.isFocused }),
    scrollable: node.isScrollable,
    scrollDirections: {
      up: node.actionList.some(action => action.name === 'SCROLL_BACKWARD' || action.name === 'SCROLL_UP'),
      down: node.actionList.some(action => action.name === 'SCROLL_FORWARD' || action.name === 'SCROLL_DOWN'),
    },
    range: node.rangeInfo ?? null,
  };
}

type Bounds = z.infer<typeof boundsSchema>;

function visibleElements(root: UiNode, viewport: Bounds) {
  const elements: ReturnType<typeof describeElement>[] = [];
  function visit(node: UiNode, parent: number | null) {
    const bounds = node.boundsInScreen;
    const visible = node.isVisibleToUser
      && bounds.right > Math.max(bounds.left, viewport.left)
      && bounds.bottom > Math.max(bounds.top, viewport.top)
      && bounds.left < viewport.right
      && bounds.top < viewport.bottom;
    const label = node.text || node.contentDescription
      || (node.isClickable ? node.children.flatMap(childLabels).slice(0, 3).join(' | ') : '');
    let index = parent;
    // Unlabeled controls still matter: an icon button or an empty field is something the user can see and use.
    if (visible && (label || node.isClickable || node.isEditable || node.isCheckable || node.isScrollable || node.rangeInfo)) {
      index = elements.length + 1;
      elements.push(describeElement(node, index, label, parent));
    }
    node.children.forEach(child => visit(child, index));
  }
  visit(root, null);
  return elements;
}

export type DisplaySize = { width: number; height: number };

/** Portal reports display geometry alongside the tree; older builds omit it. */
const deviceContextSchema = z.object({ device_context: z.object({ screen_bounds: z.object({ width: z.number().positive(), height: z.number().positive() }) }) });
const rootLayoutSchema = z.object({ a11y_tree: z.object({ packageName: z.string(), boundsInScreen: boundsSchema }) });

/**
 * Display size for each observation without a screenshot per read: Portal's geometry when present,
 * else one capture per foreground window layout. Rotation re-lays out the window, so its bounds change even for a dialog.
 */
export function createDisplaySource(capture: () => Promise<Uint8Array>) {
  let display: DisplaySize | null | undefined;
  let layout: string | undefined;
  return async (raw: unknown): Promise<DisplaySize | null> => {
    const context = deviceContextSchema.safeParse(raw);
    if (context.success) return context.data.device_context.screen_bounds;
    const current = JSON.stringify(rootLayoutSchema.safeParse(raw).data?.a11y_tree ?? null);
    if (display === undefined || current !== layout) {
      layout = current;
      display = await capture().then(pngSize, () => null);
    }
    return display;
  };
}

/**
 * The accessibility root is the active window, which can be a dialog or sheet.
 * Its bounds are display geometry only when it starts at the display origin and no better source exists.
 */
export function parseObservation(raw: unknown, display: DisplaySize | null = null) {
  const state = stateSchema.parse(raw);
  const root = state.a11y_tree.boundsInScreen;
  const screen = display ? { ...display, source: 'display' as const }
    : root.left === 0 && root.top === 0 ? { width: root.right, height: root.bottom, source: 'window' as const }
    : null;
  return {
    app: {
      currentApp: state.phone_state.currentApp || state.a11y_tree.packageName,
      packageName: state.phone_state.packageName || state.a11y_tree.packageName,
      activityName: state.phone_state.activityName || '',
    },
    rootPackage: state.a11y_tree.packageName,
    rootBounds: root,
    screen,
    elements: visibleElements(state.a11y_tree, screen ? { left: 0, top: 0, right: screen.width, bottom: screen.height } : root),
  };
}

/** Reads width and height from a PNG header, which is the captured display size. */
export function pngSize(bytes: Uint8Array): DisplaySize {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Portal did not return a PNG screenshot; check accessibility access');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Portal reverse and JSON replies carry base64 PNG, optionally as a data URL. */
export function decodeScreenshot(result: unknown) {
  const encoded = z.string().parse(result);
  const bytes = new Uint8Array(Buffer.from(encoded.replace(/^data:image\/png;base64,/, ''), 'base64'));
  pngSize(bytes);
  return bytes;
}

type Parameters = Record<string, string | number | boolean>;

/** Launchable apps as Portal lists them. */
export const packagesSchema = z.array(z.object({ packageName: z.string(), label: z.string() }));

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

  async function screenshot() {
    const response = await request('/screenshot');
    if (response.headers.get('content-type')?.includes('application/json')) {
      const raw: unknown = await response.json();
      return decodeScreenshot(decodeReply(raw));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    pngSize(bytes);
    return bytes;
  }

  const display = createDisplaySource(screenshot);
  return {
    version: () => json('/version'),
    async state() {
      const raw = await json('/state_full?filter=true');
      // Without a capture, window geometry remains an explicitly marked fallback.
      return parseObservation(raw, await display(raw));
    },
    openSettings: () => json('/app', { package: 'com.android.settings' }),
    tap: (x: number, y: number) => json('/tap', { x, y }),
    swipe: (startX: number, startY: number, endX: number, endY: number) =>
      json('/swipe', { startX, startY, endX, endY, duration: 300 }),
    back: () => json('/global', { action: 1 }),
    /** Replaces the focused field's text. It never presses Enter or an IME send action. */
    typeText: (text: string) => json('/keyboard/input', { base64_text: Buffer.from(text).toString('base64'), clear: true }),
    launch: (packageName: string) => json('/app', { package: packageName }),
    packages: async () => packagesSchema.parse(await json('/packages')),
    screenshot,
  };
}

export type PhoneObservation = ReturnType<typeof parseObservation>;

export type PhoneControl = Pick<ReturnType<typeof createPortal>, 'state' | 'openSettings' | 'tap' | 'swipe' | 'back' | 'typeText' | 'launch' | 'packages'>
  & Partial<Pick<ReturnType<typeof createPortal>, 'screenshot'>>;

/** Read-only access for contextual help. It deliberately has no mutation methods. */
export type ScreenReader = Pick<ReturnType<typeof createPortal>, 'state' | 'screenshot'>;
