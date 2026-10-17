# Hello — two-person video calls (WebRTC)

A polished, private one-to-one video and voice chat app built with vanilla HTML, CSS, and JavaScript on the frontend, plus a small Node.js signaling server. Start a room, copy the invite link, and join from another browser or device.

Features include:
- Private room-based calls for two participants
- WebRTC video + audio with graceful fallback for audio-only sessions
- Camera toggle, microphone toggle, rear/front camera switching, and call-copy actions
- Responsive layout with a cleaner “both-video” interface for local + remote streams
- Production-ready signaling server and TURN/STUN support for stricter network environments

## Architecture

```
Browser A ──WebSocket──┐                ┌──WebSocket── Browser B
                       └─ Node server ──┘     (signaling only: join, offer, answer, ICE, mute/camera state)
Browser A ◄══ encrypted audio/video (WebRTC, DTLS-SRTP) ══► Browser B
              direct via STUN, or relayed via TURN when needed
```

- `POST /api/rooms` creates a room with a random 96-bit ID (`/r/<16 chars>`). `GET /api/rooms/:id` validates it (404 missing, 409 full).
- The first person waits. When the second joins, the server tells the first to send the offer, which avoids offer collisions. Answer and ICE candidates are relayed to the *other* peer only.
- Max 2 peers per room; a third gets "This call is full". The server validates every message type and shape (64 KB cap) and never stores media.
- Empty rooms are deleted after 2 minutes (so a refresh can rejoin); rooms nobody joined expire after 30 minutes.
- If a peer drops or refreshes, the other sees "The other person left", and the returning peer triggers a fresh negotiation. A failed connection triggers one ICE restart.
- `/api/ice` hands out STUN/TURN config from environment variables. TURN credentials are never in the frontend source.

## Run locally

1. Install Node.js 18+ (https://nodejs.org).
2. `cd video-call-app && npm install`
3. `cp .env.example .env` (optional locally)
4. `npm start`, then open http://localhost:3000

**Two browser windows:** open the URL, click Start Call, allow camera/mic, copy the link, paste it into a second window (use an incognito window or a different browser; some browsers share one camera poorly between tabs, so mute one side to avoid echo).

**Two devices on the same Wi-Fi:** browsers only allow camera access on `https://` or `localhost`, so `http://192.168.x.x:3000` will not work on a phone. Use a tunnel (`npx cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) to get an HTTPS URL, then open it on both devices.

**Two devices on different networks:** deploy (below) or use a tunnel, then send the link. Try it from a phone on mobile data to exercise NAT traversal.

## Deploy

The frontend and signaling are one Node process, so one deployment covers both. GitHub Pages cannot run this Node.js/WebSocket server; use GitHub for source control and Render to run the app. The steps below replace the existing root site at `chluffy.net` with this app.

1. Push this repository to GitHub.
2. In Render, create a Blueprint from the repository and apply the included `render.yaml`. It builds with `npm ci` and starts with `npm start`. Render provides HTTPS and WebSocket (`wss://`) support.
3. Add `chluffy.net` as a custom domain for the Render web service. In the DNS manager, replace the GitHub Pages records with the values shown by Render for this service: set `@` to an A record for `216.24.57.1` (or use the `ANAME`/`ALIAS` option with Render's target `video-call-app-yyhi.onrender.com`), and set `www` to a CNAME for `video-call-app-yyhi.onrender.com`. Remove the old GitHub Pages A records for `@` and any AAAA records. This takes the existing root website offline; do not change DNS until the Render service is healthy. Leave mail-related MX/TXT records unchanged.
4. The Blueprint restricts signaling connections to `https://chluffy.net`. Keep that origin in sync if you choose a different app domain. The `www.chluffy.net` hostname is separate and will need its own Render custom-domain setup and DNS record if it should also serve this app.
5. Render's free service may sleep when idle; check current plan terms. On wake-up, the first request may take longer.

**VPS alternative:** run `npm start` under `pm2` or systemd, and put Caddy in front for automatic HTTPS:
   ```
   call.example.com {
     reverse_proxy localhost:3000
   }
   ```
   Caddy proxies WebSockets automatically. With nginx, add `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` and a long `proxy_read_timeout`. Set `ALLOWED_ORIGIN=https://call.example.com` for the chosen domain.

**State is in memory:** run a single instance (no horizontal scaling) and expect active rooms to be lost on restart.

## STUN and TURN

STUN (free public servers are preconfigured) only lets browsers discover their public address. It works for many home networks but **not** for symmetric NATs, many corporate firewalls, and some mobile carriers. In those cases only a TURN relay works. Without TURN, some pairs of users will be unable to connect.

Self-host coturn (`apt install coturn`), `/etc/turnserver.conf`:
```
listening-port=3478
tls-listening-port=5349
realm=turn.example.com
use-auth-secret
static-auth-secret=LONG_RANDOM_SECRET
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
min-port=49152
max-port=65535
no-cli
```
Open UDP/TCP 3478, TCP 5349, and UDP 49152–65535. Then set on the signaling server:
```
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=LONG_RANDOM_SECRET
```
The server derives 1-hour credentials per request (coturn REST scheme). Or use a managed TURN provider and set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` (note: those static values are returned to any client that fetches `/api/ice`, so prefer short-lived credentials from your provider if offered).

For this Render deployment, add the TURN variables under **Render → video-call-app → Environment** and redeploy. Do not put TURN secrets in GitHub or in the browser code. Without these values the app only has STUN, which cannot relay media when direct peer-to-peer connectivity is blocked. When TURN is configured, the caller retries with relay-only ICE after a direct connection attempt fails.

**Costs:** Node hosting may be free or a few dollars a month. A domain costs money. TLS certificates (Let's Encrypt) are free. STUN is free; TURN relays all media for affected calls, so it consumes bandwidth (video can be ~1–2.5 Mbps per direction) and is the part most likely to cost money.

## Security and privacy

- Media is end-to-end encrypted in transit by WebRTC (DTLS-SRTP). Signaling uses `wss://` under HTTPS. If a TURN relay is used it forwards encrypted packets but is not able to decrypt them.
- No accounts or personal data; nothing is recorded or stored. Room state is in memory and removed after everyone leaves.
- **Anyone with the link can join** if the room has a free slot. The link is the only secret, so share it privately; once two people are in, nobody else can enter. There is no waiting-room approval or password. Links appear in browser history and chat logs.
- IDs are 96-bit random, so they can't practically be guessed. Room creation is rate limited (30/hour/IP; behind a proxy this uses `X-Forwarded-For`).
- Both people's IP addresses are visible to each other's browser as ICE candidates (inherent to peer-to-peer WebRTC). Use TURN-only (`iceTransportPolicy: 'relay'`) if that matters to you.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Camera/mic prompt never appears | Page must be HTTPS or localhost; check site permissions. |
| "Blocked / not found / in use" message | Allow access in browser settings; close other apps using the camera. The call continues audio-only if possible. |
| Stuck on "Connecting…" or "Connection failed" | NAT/firewall blocks peer-to-peer: configure TURN. |
| WebSocket errors behind a proxy | Enable WebSocket upgrade headers; check `ALLOWED_ORIGIN` matches exactly (scheme + host). |
| "Call does not exist" | Room expired (30 min unused / 2 min empty) or server restarted; start a new call. |
| Echo/feedback in one-device tests | Mute one side or use headphones. |
| Camera switch button missing | Only shown on touch devices with 2+ cameras. |

## Testing status

Verified in the authoring sandbox: JavaScript syntax check of server and client; HTTP API (room create/validate/404, `/api/ice` incl. HMAC TURN credentials, static serving, SPA route, path traversal blocked) run against the real `server.js` with a stubbed `ws`.

**Not verified:** the sandbox had no network, so `ws` could not be installed and no browsers were available. The WebSocket signaling, offer/answer/ICE exchange, two-way audio/video, mute/camera/hang-up, room capacity, disconnect handling, and cross-network behavior have **not** been run. Follow the local test steps above and check each before relying on it.
