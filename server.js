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

const PORT = process.env.PORT === '0' ? 0 : Number(process.env.PORT) || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // e.g. https://call.example.com
const RANDOM_MATCH_ENABLED = process.env.RANDOM_MATCH_ENABLED === 'true';
const EMPTY_ROOM_TTL = 2 * 60 * 1000;  // keep an empty room 2 min so a refresh can rejoin
const UNUSED_ROOM_TTL = 30 * 60 * 1000; // a room nobody ever joined expires after 30 min
const MAX_ROOMS = 5000;
const MAX_RANDOM_QUEUE = 100;
const MAX_RANDOM_MATCHES_PER_HOUR = 30;
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

/** rooms: id -> { peers:Set<ws>, timer } */
const rooms = new Map();
const createLog = new Map(); // ip -> timestamps (simple rate limit)
const randomQueue = new Set();
let cloudflareTurnCache = null;
let cloudflareTurnCacheExpiresAt = 0;
let cloudflareTurnRequest = null;

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

async function cloudflareTurnServers() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!keyId || !apiToken) {
    if (keyId || apiToken) throw new Error('Both Cloudflare TURN environment variables are required.');
    return [];
  }
  if (cloudflareTurnCache && Date.now() < cloudflareTurnCacheExpiresAt) return cloudflareTurnCache;
  if (cloudflareTurnRequest) return cloudflareTurnRequest;

  cloudflareTurnRequest = (async () => {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Cloudflare TURN credential request failed (HTTP ${response.status}).`);
    const result = await response.json();
    if (!Array.isArray(result.iceServers)) throw new Error('Cloudflare TURN returned an invalid ICE server response.');

    const servers = result.iceServers
      .filter(server => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some(url => typeof url === 'string' && /^(turn|turns):/i.test(url));
      })
      .map(server => ({
        urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
          .filter(url => typeof url === 'string' && /^(turn|turns):/i.test(url) && !/:\s*53(?:\?|$)/.test(url)),
        username: server.username,
        credential: server.credential
      }))
      .filter(server => server.urls.length && typeof server.username === 'string' && typeof server.credential === 'string');
    if (!servers.length) throw new Error('Cloudflare TURN returned no usable relay servers.');

    cloudflareTurnCache = servers;
    cloudflareTurnCacheExpiresAt = Date.now() + 5 * 60 * 1000;
    return servers;
  })();

  try {
    return await cloudflareTurnRequest;
  } finally {
    cloudflareTurnRequest = null;
  }
}

async function iceServers() {
  const stun = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map(s => s.trim()).filter(Boolean);
  const list = [{ urls: stun }, ...await cloudflareTurnServers()];
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const now = Date.now();
    const recent = (createLog.get(ip) || []).filter(t => now - t < 3600e3);
    if (recent.length >= 30 || rooms.size >= MAX_ROOMS) return json(res, 429, { error: 'Too many rooms. Try again later.' });
    createLog.set(ip, [...recent, now]);
    return json(res, 201, { id: createRoom() });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { randomMatchEnabled: RANDOM_MATCH_ENABLED });
  }
  if (req.method === 'GET' && url.pathname === '/api/ice') {
    try {
      return json(res, 200, { iceServers: await iceServers() });
    } catch (error) {
      console.error('Could not load ICE server configuration:', error.message);
      return json(res, 503, { error: 'ICE server configuration is unavailable. Check the TURN provider settings.' });
    }
  }

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
  randomQueue.delete(ws);
  ws.randomQueued = false;
  const id = ws.roomId;
  if (!id) return;
  const wasRandomMatch = ws.randomMatch;
  ws.roomId = null;
  ws.randomMatch = false;
  const room = rooms.get(id);
  if (!room) return;
  room.peers.delete(ws);
  if (wasRandomMatch) {
    for (const peer of room.peers) {
      peer.roomId = null;
      peer.randomMatch = false;
      send(peer, { type: 'peer-left' });
    }
    room.peers.clear();
    armExpiry(id, EMPTY_ROOM_TTL);
    return;
  }
  for (const p of room.peers) {
    p.randomMatch = false;
    send(p, { type: 'peer-left' });
  }
  if (room.peers.size === 0) armExpiry(id, EMPTY_ROOM_TTL);
}

function queueForRandomMatch(ws) {
  if (!RANDOM_MATCH_ENABLED) {
    return send(ws, { type: 'error', message: 'Random chat is not enabled on this server yet.' });
  }
  if (!ws.ageConfirmed) {
    return send(ws, { type: 'error', message: 'Confirm that you are 18 or older before starting random chat.' });
  }
  if (ws.roomId) {
    return send(ws, { type: 'error', message: 'Leave the active call before searching for another match.' });
  }
  if (ws.randomQueued) return;

  const now = Date.now();
  ws.randomMatchTimes = (ws.randomMatchTimes || []).filter(time => now - time < 3600e3);
  if (ws.randomMatchTimes.length >= MAX_RANDOM_MATCHES_PER_HOUR) {
    return send(ws, { type: 'error', message: 'You have started too many chats. Try again later.' });
  }
  if (rooms.size >= MAX_ROOMS) {
    return send(ws, { type: 'error', message: 'Calls are busy right now. Try again later.' });
  }

  let peer;
  for (const candidate of randomQueue) {
    if (candidate.readyState !== 1) {
      randomQueue.delete(candidate);
      candidate.randomQueued = false;
      continue;
    }
    peer = candidate;
    break;
  }
  if (!peer) {
    if (randomQueue.size >= MAX_RANDOM_QUEUE) {
      return send(ws, { type: 'error', message: 'Random chat is busy right now. Try again later.' });
    }
    ws.randomQueued = true;
    ws.randomMatchTimes.push(now);
    randomQueue.add(ws);
    send(ws, { type: 'searching' });
    return;
  }

  randomQueue.delete(peer);
  peer.randomQueued = false;
  const roomId = createRoom();
  const room = rooms.get(roomId);
  clearTimeout(room.timer);
  room.peers.add(peer);
  room.peers.add(ws);
  peer.roomId = ws.roomId = roomId;
  peer.randomMatch = ws.randomMatch = true;
  ws.randomMatchTimes.push(now);
  send(peer, { type: 'joined', peers: 2, random: true });
  send(ws, { type: 'joined', peers: 2, random: true });
  send(peer, { type: 'peer-joined' });
}

wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN && req.headers.origin !== ALLOWED_ORIGIN) return ws.close(1008, 'origin');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg && msg.type === 'join') {
      if (ws.roomId || ws.randomQueued || ws.ageConfirmed) {
        return send(ws, { type: 'error', message: 'This connection is already in a call or search.' });
      }
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

    if (msg && msg.type === 'find') {
      const consented = msg.adultConfirmed === true && msg.conductAccepted === true;
      if (!consented) {
        if (ws.randomMatch) leave(ws);
        ws.ageConfirmed = false;
        randomQueue.delete(ws);
        ws.randomQueued = false;
        return send(ws, { type: 'error', message: 'Confirm that you are 18 or older before starting random chat.' });
      }
      if (ws.roomId) return send(ws, { type: 'error', message: 'Leave the active call before searching for another match.' });
      ws.ageConfirmed = true;
      queueForRandomMatch(ws);
      return;
    }

    if (msg && msg.type === 'next') {
      if (!ws.ageConfirmed) return send(ws, { type: 'error', message: 'Start a random chat first.' });
      leave(ws);
      queueForRandomMatch(ws);
      return;
    }

    if (msg && msg.type === 'report') {
      if (!ws.randomMatch || !ws.roomId) {
        return send(ws, { type: 'error', message: 'There is no active random chat to report.' });
      }
      console.info(JSON.stringify({ event: 'random-chat-report', room: ws.roomId, timestamp: new Date().toISOString() }));
      send(ws, { type: 'reported' });
      leave(ws);
      queueForRandomMatch(ws);
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

server.listen(PORT, () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : PORT;
  console.log(`Listening on http://localhost:${port}`);
});
