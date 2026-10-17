'use strict';
const $ = (id) => document.getElementById(id);
const ID_RE = /^[A-Za-z0-9_-]{16}$/;

let roomId, ws, pc, iceServers;
let audioTrack = null, videoTrack = null, audioSender = null, videoSender = null;
let facing = 'user', micOn = false, camOn = false;
let isOfferer = false, restarted = false, leaving = false, retries = 0;
let pending = [], remoteVideoOn = true, lastStatus = ['', ''], queue = Promise.resolve();

/* ---------- UI helpers ---------- */
function show(id) { for (const s of ['home', 'invite', 'call']) $(s).hidden = s !== id; }
function setStatus(text, state = '') { lastStatus = [text, state]; const s = $('status'); s.textContent = text; s.dataset.state = state; }
function flash(text) { setStatus(text, 'ok'); setTimeout(() => setStatus(...lastStatus), 1500); }
function toast(text) { const t = $('call-error'); t.textContent = text; t.hidden = !text; }
function setIcon(btn, id) { btn.firstElementChild.firstElementChild.setAttribute('href', '#' + id); }

function updateControls() {
  const mic = $('btn-mic'), cam = $('btn-cam');
  mic.setAttribute('aria-pressed', String(!micOn));
  mic.setAttribute('aria-label', micOn ? 'Mute microphone' : 'Unmute microphone');
  setIcon(mic, micOn ? 'i-mic' : 'i-mic-off');
  cam.setAttribute('aria-pressed', String(!camOn));
  cam.setAttribute('aria-label', camOn ? 'Turn camera off' : 'Turn camera on');
  setIcon(cam, camOn ? 'i-cam' : 'i-cam-off');
  $('local').srcObject = videoTrack ? new MediaStream([videoTrack]) : null;
  $('local').classList.toggle('mirror', facing === 'user');
  $('local-off').hidden = camOn;
  $('remote-off').hidden = remoteVideoOn;
}

function describeError(e) {
  switch (e && e.name) {
    case 'NotAllowedError': return 'Camera or microphone access was blocked. Allow it in your browser’s site settings and try again.';
    case 'NotFoundError': return 'No camera or microphone was found on this device.';
    case 'NotReadableError': return 'Your camera or microphone is being used by another app.';
    case 'OverconstrainedError': return 'This camera can’t be used with the requested settings.';
    default: return (e && e.message) || 'Could not access camera or microphone.';
  }
}

/* ---------- Home / invite ---------- */
function extractId(text) {
  text = text.trim();
  try { const m = new URL(text).pathname.match(/^\/r\/([^/]+)\/?$/); if (m) text = m[1]; } catch { /* plain code */ }
  return ID_RE.test(text) ? text : null;
}
async function checkRoom(id) {
  const r = await fetch('/api/rooms/' + id);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not reach the server.');
}
function showError(el, text) { el.textContent = text; el.hidden = !text; }

$('btn-start').onclick = async () => {
  try {
    const r = await fetch('/api/rooms', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    enterCall(data.id);
  } catch (e) { showError($('home-error'), e.message || 'Could not start a call.'); }
};
$('btn-join').onclick = () => { $('join-form').hidden = false; $('join-input').focus(); };
$('join-form').onsubmit = async (e) => {
  e.preventDefault();
  const id = extractId($('join-input').value);
  if (!id) return showError($('home-error'), 'That doesn’t look like a valid link or room code.');
  try { await checkRoom(id); enterCall(id); } catch (err) { showError($('home-error'), err.message); }
};
$('btn-accept').onclick = async () => {
  try { await checkRoom(roomId); enterCall(roomId); } catch (err) { showError($('invite-error'), err.message); }
};

/* ---------- Media ---------- */
async function getMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Calls need a secure connection (HTTPS or localhost) and a modern browser.');
  }
  const attempts = [{ audio: true, video: { facingMode: facing } }, { audio: true }, { video: { facingMode: facing } }];
  let firstErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(attempts[i]);
      audioTrack = stream.getAudioTracks()[0] || null;
      videoTrack = stream.getVideoTracks()[0] || null;
      micOn = !!audioTrack; camOn = !!videoTrack;
      if (i > 0) toast(describeError(firstErr) + (audioTrack && !videoTrack ? ' Joining with audio only.' : ' Joining without a microphone.'));
      return;
    } catch (e) { firstErr = firstErr || e; }
  }
  throw new Error(describeError(firstErr));
}

async function newVideoTrack() {
  for (const fm of [{ exact: facing }, facing]) {
    try { return (await navigator.mediaDevices.getUserMedia({ video: { facingMode: fm } })).getVideoTracks()[0]; }
    catch (e) { if (fm === facing) throw e; }
  }
}
async function setVideoTrack(track) {
  if (videoTrack) videoTrack.stop();
  videoTrack = track; camOn = !!track;
  if (videoSender) await videoSender.replaceTrack(track);
  updateControls(); sendState();
}

$('btn-mic').onclick = () => {
  if (!audioTrack) return toast('No microphone available.');
  audioTrack.enabled = !audioTrack.enabled; micOn = audioTrack.enabled;
  updateControls(); sendState();
};
$('btn-cam').onclick = async () => {
  try { toast(''); await setVideoTrack(camOn ? null : await newVideoTrack()); }
  catch (e) { toast(describeError(e)); }
};
$('btn-flip').onclick = async () => {
  if (!camOn) return;
  facing = facing === 'user' ? 'environment' : 'user';
  try { videoTrack.stop(); await setVideoTrack(await newVideoTrack()); }
  catch (e) { facing = facing === 'user' ? 'environment' : 'user'; toast(describeError(e)); try { await setVideoTrack(await newVideoTrack()); } catch { await setVideoTrack(null); } }
};
async function maybeShowFlip() {
  try {
    const touch = navigator.maxTouchPoints > 0;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    $('btn-flip').hidden = !(touch && cams.length > 1);
  } catch { /* ignore */ }
}

/* ---------- Call lifecycle ---------- */
async function enterCall(id) {
  roomId = id; leaving = false;
  history.replaceState(null, '', '/r/' + id);
  show('call');
  $('invite-link').value = location.origin + '/r/' + id;
  setStatus('Starting camera…');
  try { await getMedia(); } catch (e) { return exitWith(e.message); }
  updateControls(); maybeShowFlip();
  try { iceServers = (await (await fetch('/api/ice')).json()).iceServers; }
  catch { iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; }
  setStatus('Connecting…');
  connectWs();
}

function connectWs() {
  const sock = ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  sock.onopen = () => { retries = 0; sock.send(JSON.stringify({ type: 'join', room: roomId })); };
  sock.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    queue = queue.then(() => onSignal(msg)).catch((err) => console.error('signal error', err)); // handle messages strictly in order
  };
  sock.onclose = () => {
    if (leaving || sock !== ws) return;
    closePC(); $('waiting').hidden = false;
    if (retries++ < 5) { setStatus('Reconnecting…', 'bad'); setTimeout(() => { if (!leaving) connectWs(); }, 1000 * retries); }
    else exitWith('Lost connection to the server.');
  };
}

const sendMsg = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const sendState = () => sendMsg({ type: 'state', video: camOn, audio: micOn });

async function onSignal(msg) {
  switch (msg.type) {
    case 'joined':
      if (msg.peers < 2) { $('waiting').hidden = false; setStatus('Waiting for someone to join'); }
      else setStatus('Connecting…');
      break;
    case 'error': exitWith(msg.message); break;
    case 'peer-joined': isOfferer = true; restarted = false; createPC(); await makeOffer(false); break;
    case 'peer-left':
      closePC(); remoteVideoOn = true; updateControls();
      $('waiting').hidden = false; setStatus('The other person left');
      break;
    case 'offer':
      isOfferer = false;
      if (!pc) createPC();
      await pc.setRemoteDescription(msg.sdp); await flushCandidates();
      await pc.setLocalDescription(await pc.createAnswer());
      sendMsg({ type: 'answer', sdp: pc.localDescription.toJSON() });
      break;
    case 'answer':
      if (pc && pc.signalingState === 'have-local-offer') { await pc.setRemoteDescription(msg.sdp); await flushCandidates(); }
      break;
    case 'candidate':
      if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); } }
      else if (pc) pending.push(msg.candidate);
      break;
    case 'state': remoteVideoOn = msg.video; updateControls(); break;
  }
}

async function flushCandidates() {
  const list = pending; pending = [];
  for (const c of list) { try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); } }
}

function createPC() {
  closePC(); // never keep two peer connections
  const p = pc = new RTCPeerConnection({ iceServers });
  const remoteStream = new MediaStream();
  $('remote').srcObject = remoteStream;
  audioSender = p.addTransceiver('audio', { direction: 'sendrecv' }).sender; // both directions always negotiated,
  videoSender = p.addTransceiver('video', { direction: 'sendrecv' }).sender; // so camera/mic can start later without renegotiation
  if (audioTrack) audioSender.replaceTrack(audioTrack);
  if (videoTrack) videoSender.replaceTrack(videoTrack);

  p.onicecandidate = (e) => { if (p === pc && e.candidate) sendMsg({ type: 'candidate', candidate: e.candidate.toJSON() }); };
  p.ontrack = (e) => { remoteStream.addTrack(e.track); $('remote').play().catch(() => {}); };
  p.onconnectionstatechange = async () => {
    if (p !== pc) return;
    switch (p.connectionState) {
      case 'connected': $('waiting').hidden = true; toast(''); setStatus('Connected', 'ok'); sendState(); break;
      case 'disconnected': setStatus('Connection unstable…', 'bad'); break;
      case 'failed':
        if (isOfferer && !restarted) { restarted = true; setStatus('Reconnecting…', 'bad'); try { await makeOffer(true); } catch (e) { console.error(e); } }
        else { setStatus('Connection failed', 'bad'); toast('Could not connect directly. A TURN server may be required for these networks.'); }
        break;
    }
  };
}

async function makeOffer(iceRestart) {
  await pc.setLocalDescription(await pc.createOffer({ iceRestart }));
  sendMsg({ type: 'offer', sdp: pc.localDescription.toJSON() });
}

function closePC() {
  if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null; pc.close(); pc = null; }
  audioSender = videoSender = null; pending = [];
  $('remote').srcObject = null;
}

function cleanup() {
  leaving = true;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  closePC();
  for (const t of [audioTrack, videoTrack]) if (t) t.stop();
  audioTrack = videoTrack = null;
  $('local').srcObject = null;
}
function exitWith(message) { cleanup(); location.assign('/?e=' + encodeURIComponent(message || 'Call ended.')); }

$('btn-end').onclick = () => { cleanup(); location.assign('/'); };
window.addEventListener('pagehide', () => { if (!leaving) cleanup(); });

/* ---------- Copy link ---------- */
async function copyLink() {
  const link = $('invite-link').value;
  try { await navigator.clipboard.writeText(link); }
  catch { $('invite-link').select(); document.execCommand('copy'); }
  flash('Link copied');
}
$('btn-copy').onclick = $('btn-copy-main').onclick = copyLink;

/* ---------- Boot ---------- */
(function init() {
  const m = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (m) {
    if (ID_RE.test(m[1])) { roomId = m[1]; show('invite'); }
    else { show('invite'); $('btn-accept').disabled = true; showError($('invite-error'), 'This invitation link is not valid.'); }
    return;
  }
  show('home');
  const e = new URLSearchParams(location.search).get('e');
  if (e) showError($('home-error'), e.slice(0, 200));
})();
