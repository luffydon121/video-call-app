'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// Minimal .env loader (no dependency). Real environment variables win.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file */ }

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://call.example.com
const EMPTY_ROOM_TTL = 2 * 60 * 1000;  // keep an empty room 2 min so a refresh can rejoin
const UNUSED_ROOM_TTL = 30 * 60 * 1000; // a room nobody ever joined expires after 30 min
const MAX_ROOMS = 5000;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

/** rooms: id -> { peers:Set<ws>, timer } */
const rooms = new Map();
const createLog = new Map(); // ip -> timestamps (simple rate limit)

function armExpiry(id, ms) {
  const room = rooms.get(id);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => { if (rooms.get(id)?.peers.size === 0) rooms.delete(id); }, ms);
}

function createRoom() {
  const id = crypto.randomBytes(12).toString('base64url'); // 96 bits -> 16 chars
  rooms.set(id, { peers: new Set(), timer: null });
  armExpiry(id, UNUSED_ROOM_TTL);
  return id;
}

function iceServers() {
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean);
  const list = [{ urls: stun }];
  const turn = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turn.length) {
    if (process.env.TURN_SECRET) { // coturn "use-auth-secret": short-lived credentials
      const username = String(Math.floor(Date.now() / 1000) + 3600);
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      list.push({ urls: turn, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      list.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  return list;
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const now = Date.now();
    const recent = (createLog.get(ip) || []).filter(t => now - t < 3600e3);
    if (recent.length >= 30 || rooms.size >= MAX_ROOMS) return json(res, 429, { error: 'Too many rooms. Try again later.' });
    createLog.set(ip, [...recent, now]);
    return json(res, 201, { id: createRoom() });
  }
  if (req.method === 'GET' && url.pathname === '/api/ice') return json(res, 200, { iceServers: iceServers() });

  const m = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
  if (req.method === 'GET' && m) {
    const room = ID_RE.test(m[1]) && rooms.get(m[1]);
    if (!room) return json(res, 404, { error: 'This call does not exist or has expired.' });
    if (room.peers.size >= 2) return json(res, 409, { error: 'This call is full.' });
    return json(res, 200, { ok: true });
  }

  // Static files; /r/<id> serves the app shell.
  let file = url.pathname.startsWith('/r/') ? '/index.html' : url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Permissions-Policy': 'camera=(self), microphone=(self)',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function validate(msg) {
  if (!msg || typeof msg !== 'object') return false;
  switch (msg.type) {
    case 'offer': case 'answer':
      return msg.sdp && typeof msg.sdp.sdp === 'string' && ['offer', 'answer'].includes(msg.sdp.type) && msg.sdp.type === msg.type;
    case 'candidate':
      return msg.candidate === null || (typeof msg.candidate === 'object' && typeof msg.candidate.candidate === 'string');
    case 'state':
      return typeof msg.video === 'boolean' && typeof msg.audio === 'boolean';
    case 'relay':
      return true;
    default: return false;
  }
}

function leave(ws) {
  const id = ws.roomId;
  if (!id) return;
  ws.roomId = null;
  const room = rooms.get(id);
  if (!room) return;
  room.peers.delete(ws);
  for (const p of room.peers) send(p, { type: 'peer-left' });
  if (room.peers.size === 0) armExpiry(id, EMPTY_ROOM_TTL);
}

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN && req.headers.origin !== ALLOWED_ORIGIN) return ws.close(1008, 'origin');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg && msg.type === 'join') {
      if (ws.roomId) return;
      const room = typeof msg.room === 'string' && ID_RE.test(msg.room) ? rooms.get(msg.room) : null;
      if (!room) return send(ws, { type: 'error', code: 'not-found', message: 'This call does not exist or has expired.' });
      if (room.peers.size >= 2) return send(ws, { type: 'error', code: 'full', message: 'This call is full.' });
      clearTimeout(room.timer);
      ws.roomId = msg.room;
      room.peers.add(ws);
      send(ws, { type: 'joined', peers: room.peers.size });
      for (const p of room.peers) if (p !== ws) send(p, { type: 'peer-joined' }); // existing peer becomes the offerer
      return;
    }

    const room = ws.roomId && rooms.get(ws.roomId);
    if (!room || !validate(msg)) return;
    for (const p of room.peers) if (p !== ws) send(p, msg); // relay to the other participant only
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
  const cutoff = Date.now() - 3600e3;
  for (const [ip, t] of createLog) if (t.every(x => x < cutoff)) createLog.delete(ip);
}, 20000).unref();

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
