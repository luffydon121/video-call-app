'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');

const serverPath = path.join(__dirname, '..', 'server.js');

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/localhost:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (!output.includes('Listening on') && code !== null) reject(new Error(`Server exited (${code}): ${output}`));
    });
  });
  const port = await started;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  };
}

async function connect(baseUrl) {
  const socket = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/ws');
  await once(socket, 'open');
  return socket;
}

function nextMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 3000);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
    socket.once('close', () => {
      clearTimeout(timeout);
      reject(new Error(`Socket closed while waiting for ${type}`));
    });
  });
}

test('private room endpoints and websocket signaling remain available', async t => {
  const server = await startServer();
  t.after(() => server.close());

  const config = await fetch(`${server.baseUrl}/api/config`);
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { randomMatchEnabled: false });
  assert.deepEqual(await (await fetch(`${server.baseUrl}/healthz`)).json(), { ok: true });

  const created = await fetch(`${server.baseUrl}/api/rooms`, { method: 'POST' });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.match(id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal((await fetch(`${server.baseUrl}/api/rooms/${id}`)).status, 200);
  assert.equal((await fetch(`${server.baseUrl}/api/rooms/not-a-room`)).status, 404);

  const first = await connect(server.baseUrl);
  const second = await connect(server.baseUrl);
  t.after(() => { first.close(); second.close(); });

  const firstJoined = nextMessage(first, 'joined');
  first.send(JSON.stringify({ type: 'join', room: id }));
  assert.equal((await firstJoined).peers, 1);

  const firstPeerJoined = nextMessage(first, 'peer-joined');
  const secondJoined = nextMessage(second, 'joined');
  second.send(JSON.stringify({ type: 'join', room: id }));
  assert.equal((await secondJoined).peers, 2);
  await firstPeerJoined;

  const relayed = nextMessage(second, 'state');
  first.send(JSON.stringify({ type: 'state', video: false, audio: true }));
  assert.deepEqual(await relayed, { type: 'state', video: false, audio: true });

  const randomSocket = await connect(server.baseUrl);
  t.after(() => randomSocket.close());
  const disabled = nextMessage(randomSocket, 'error');
  randomSocket.send(JSON.stringify({ type: 'find', adultConfirmed: true, conductAccepted: true }));
  assert.match((await disabled).message, /not enabled/);
});

test('random matching requires the feature flag and adult confirmation', async t => {
  const server = await startServer({ RANDOM_MATCH_ENABLED: 'true' });
  t.after(() => server.close());

  const first = await connect(server.baseUrl);
  const second = await connect(server.baseUrl);
  t.after(() => { first.close(); second.close(); });

  const rejected = nextMessage(first, 'error');
  first.send(JSON.stringify({ type: 'find', adultConfirmed: false, conductAccepted: false }));
  assert.match((await rejected).message, /18 or older/);

  const searching = nextMessage(first, 'searching');
  first.send(JSON.stringify({ type: 'find', adultConfirmed: true, conductAccepted: true }));
  await searching;

  const firstJoined = nextMessage(first, 'joined');
  const firstPeerJoined = nextMessage(first, 'peer-joined');
  const secondJoined = nextMessage(second, 'joined');
  second.send(JSON.stringify({ type: 'find', adultConfirmed: true, conductAccepted: true }));
  assert.equal((await firstJoined).random, true);
  assert.equal((await secondJoined).peers, 2);
  await firstPeerJoined;

  const reportAccepted = nextMessage(second, 'reported');
  const firstPeerLeft = nextMessage(first, 'peer-left');
  const secondSearching = nextMessage(second, 'searching');
  second.send(JSON.stringify({ type: 'report' }));
  await reportAccepted;
  await firstPeerLeft;
  await secondSearching;

  const third = await connect(server.baseUrl);
  t.after(() => third.close());
  const secondMatched = nextMessage(second, 'joined');
  const secondPeerJoined = nextMessage(second, 'peer-joined');
  const thirdMatched = nextMessage(third, 'joined');
  third.send(JSON.stringify({ type: 'find', adultConfirmed: true, conductAccepted: true }));
  assert.equal((await secondMatched).peers, 2);
  assert.equal((await thirdMatched).random, true);
  await secondPeerJoined;

  const thirdPeerLeft = nextMessage(third, 'peer-left');
  const secondSearchingAgain = nextMessage(second, 'searching');
  second.send(JSON.stringify({ type: 'next' }));
  await thirdPeerLeft;
  await secondSearchingAgain;
});
