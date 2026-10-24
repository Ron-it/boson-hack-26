import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { DeviceConnection } from './device.ts';
import { VoiceSession } from './voice.ts';
import { sessionPreset } from './presets.ts';
import { createVoice, voiceRequest } from './voices.ts';

const token = process.env.DEVICE_TOKEN;
if (!token || token.length < 24) throw new Error('Set a random DEVICE_TOKEN of at least 24 characters');
const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
let device: DeviceConnection | undefined;
let voice: VoiceSession | undefined;
const authorized = (header: string | undefined) => {
  const a = Buffer.from(header?.replace(/^Bearer /, '') || '');
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};
/** The phone uploads a family voice recording; the Boson key never leaves the server. */
async function cloneVoice(request: IncomingMessage, response: ServerResponse) {
  const reply = (status: number, body: object) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (!authorized(request.headers.authorization)) return reply(401, { error: 'Pair this phone again, then record.' });
  const key = process.env.BOSON_API_KEY;
  if (!key) return reply(503, { error: 'The server has no Boson key.' });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) return reply(413, { error: 'That recording is too long. Keep it under 30 seconds.' });
    chunks.push(chunk);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = null; }
  const parsed = voiceRequest.safeParse(body);
  if (!parsed.success) return reply(400, { error: 'The recording did not arrive. Try again.' });
  try { reply(200, { voice: await createVoice(parsed.data, key) }); }
  catch (error) { reply(502, { error: error instanceof Error && error.name !== 'TimeoutError' ? error.message : 'Boson took too long. Try again.' }); }
}
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/voices') { void cloneVoice(request, response); return; }
  if (request.url !== '/health') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, phoneConnected: device?.socket.readyState === WebSocket.OPEN }));
});
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const path = url.pathname;
  if (!authorized(request.headers.authorization) || !['/device', '/session'].includes(path)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return;
  }
  if (path === '/session' && device?.socket.readyState !== WebSocket.OPEN) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return;
  }
  sockets.handleUpgrade(request, socket, head, ws => {
    if (path === '/device') {
      voice?.close('Phone connection replaced.');
      device?.socket.close(1000, 'Connection replaced');
      const current = new DeviceConnection(ws, String(request.headers['x-device-id'] || 'phone'));
      device = current;
      ws.once('close', () => { if (device === current) device = undefined; });
      ws.on('error', () => {});
      console.log('Phone connected');
    } else if (device) {
      voice?.close('Replaced by a new voice session.');
      console.log('Voice preset:', url.searchParams.get('preset'), url.searchParams.get('language') ?? '');
      try { voice = new VoiceSession(ws, device, process.env, { preset: sessionPreset(url.searchParams) }); }
      catch { ws.close(1011, 'Voice setup failed'); }
    }
  });
});
const heartbeat = setInterval(() => {
  for (const ws of sockets.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
}, 20_000);
server.on('close', () => clearInterval(heartbeat));
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Tandem server listening'));
process.on('SIGTERM', () => { voice?.close(); for (const ws of sockets.clients) ws.close(); server.close(); });
