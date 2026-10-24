import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { DeviceConnection } from './device.ts';
import { VoiceSession } from './voice.ts';
import { parsePreset, presets } from './presets.ts';

const token = process.env.DEVICE_TOKEN;
if (!token || token.length < 24) throw new Error('Set a random DEVICE_TOKEN of at least 24 characters');
const sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
let device: DeviceConnection | undefined;
let voice: VoiceSession | undefined;
const server = createServer((request, response) => {
  if (request.url !== '/health') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, phoneConnected: device?.socket.readyState === WebSocket.OPEN }));
});
server.on('upgrade', (request, socket, head) => {
  const credential = request.headers.authorization?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(credential);
  const b = Buffer.from(token);
  const url = new URL(request.url || '/', 'http://localhost');
  const path = url.pathname;
  if (a.length !== b.length || !timingSafeEqual(a, b) || !['/device', '/session'].includes(path)) {
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
      const preset = parsePreset(url.searchParams.get('preset'));
      console.log('Voice preset:', preset);
      try { voice = new VoiceSession(ws, device, process.env, { preset: presets[preset] }); }
      catch { ws.close(1011, 'Voice setup failed'); }
    }
  });
});
const heartbeat = setInterval(() => {
  for (const ws of sockets.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
}, 20_000);
server.on('close', () => clearInterval(heartbeat));
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Phone voice server listening'));
process.on('SIGTERM', () => { voice?.close(); for (const ws of sockets.clients) ws.close(); server.close(); });
