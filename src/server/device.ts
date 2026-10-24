import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { decodeScreenshot, packagesSchema, parseObservation, pngSize, type DisplaySize, type PhoneControl, type ScreenReader } from '../mobile/portal.ts';

const replySchema = z.object({ id: z.string(), status: z.string(), result: z.unknown().optional(), error: z.string().optional() });

/** One connection owns its pending requests. A disconnected mutation is never replayed. */
export class DeviceConnection {
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  /** Undefined until captured once; null when capture failed, so state reads do not keep paying for it. */
  private display: DisplaySize | null | undefined;
  readonly phone: PhoneControl & ScreenReader;
  readonly socket: WebSocket;
  readonly id: string;

  constructor(socket: WebSocket, id: string) {
    this.socket = socket;
    this.id = id;
    this.phone = {
      state: async () => {
        const raw = await this.request('state', { filter: true });
        const observation = parseObservation(raw, this.display ?? null);
        const root = observation.rootBounds;
        // A window outside the known display means rotation or a stale size; capture again.
        const fits = this.display && root.right <= this.display.width && root.bottom <= this.display.height;
        if (this.display === null || fits) return observation;
        await this.capture().catch(() => { this.display = null; });
        return parseObservation(raw, this.display ?? null);
      },
      screenshot: () => this.capture(),
      openSettings: () => this.request('app', { package: 'com.android.settings' }),
      tap: (x, y) => this.request('tap', { x, y }),
      swipe: (startX, startY, endX, endY) => this.request('swipe', { startX, startY, endX, endY, duration: 300 }),
      back: () => this.request('global', { action: 1 }),
      typeText: text => this.request('keyboard/input', { base64_text: Buffer.from(text).toString('base64'), clear: true }),
      launch: packageName => this.request('app', { package: packageName }),
      packages: async () => packagesSchema.parse(await this.request('packages')),
    };
    socket.on('message', data => {
      try {
        const parsed = replySchema.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) return;
        const reply = parsed.data;
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(reply.id);
        if (reply.status !== 'success') pending.reject(new Error(reply.error || 'Phone rejected the action'));
        else {
          let result = reply.result;
          if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Plain results are valid. */ } }
          pending.resolve(result);
        }
      } catch { /* Ignore malformed unsolicited events. */ }
    });
    socket.on('close', () => this.rejectPending());
    socket.on('error', () => this.rejectPending());
  }

  request(method: string, params: Record<string, string | number | boolean> = {}): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Phone is disconnected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Phone ${method} timed out; it will not be retried automatically`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private async capture() {
    const bytes = decodeScreenshot(await this.request('screenshot', { hideOverlay: true }));
    this.display = pngSize(bytes);
    return bytes;
  }

  private rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Phone disconnected; action outcome is unknown'));
    }
    this.pending.clear();
  }
}
