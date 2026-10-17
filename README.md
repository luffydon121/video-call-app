# Hello — private and random video calls (WebRTC)

A one-to-one video and voice chat app built with vanilla HTML, CSS, and JavaScript on the frontend, plus a small Node.js signaling server. Create a private invite room, or use Random Talk to match without sharing a link when the server enables it.

Features include:
- Private room-based calls for two participants
- Optional, link-free Random Talk matching with Next and Report controls
- Adults-only confirmation and a conduct notice before random matching
- WebRTC video + audio with graceful fallback for audio-only sessions
- Camera toggle, microphone toggle, rear/front camera switching, and call-copy actions
- Responsive layout with a cleaner “both-video” interface for local + remote streams
- TURN/STUN support for stricter network environments

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
- `/api/config` reports whether random matching is enabled. The in-memory match queue is limited to one server instance and is cleared on restart.
- Random matching requires an explicit adult/conduct confirmation. The prototype's Report action ends the match and emits a short-lived server log entry; it does not persist reports or provide a moderation queue.

## Run locally

1. Install Node.js 18+ (https://nodejs.org).
2. `cd video-call-app && npm install`
3. `cp .env.example .env` (optional locally)
4. `npm start`, then open http://localhost:3000

**Two browser windows:** open the URL, click Start Call, allow camera/mic, copy the link, paste it into a second window (use an incognito window or a different browser; some browsers share one camera poorly between tabs, so mute one side to avoid echo).

**Two devices on the same Wi-Fi:** browsers only allow camera access on `https://` or `localhost`, so `http://192.168.x.x:3000` will not work on a phone. Use a tunnel (`npx cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) to get an HTTPS URL, then open it on both devices.

**Two devices on different networks:** deploy (below) or use a tunnel, then send the link. Try it from a phone on mobile data to exercise NAT traversal.

## Deploy

The frontend and signaling are one Node process, so one deployment covers both. GitHub Pages cannot run this Node.js/WebSocket server; use GitHub for source control and the existing Render web service to run the app.

1. Push a verified release to the GitHub branch connected to Render.
2. Render builds with `npm ci`, starts with `npm start`, and checks `/healthz`. Render provides HTTPS and WebSocket (`wss://`) support.
3. Keep the existing custom-domain and DNS records unchanged for this upgrade. The configured WebSocket origin must match the site's HTTPS origin exactly.
4. Render's free service may sleep when idle; check current plan terms. On wake-up, the first request may take longer.

Random matching is deliberately disabled in `render.yaml`. Keep it disabled on a public deployment until persistent report storage and a moderation review process are configured. Enabling the prototype flag only turns on in-memory matching and temporary report logs; it is not a production moderation system.

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

### Cloudflare Realtime TURN

1. In Cloudflare, create a TURN key under **Calls → TURN**. Create an API token scoped to the account with **Calls Write** permission.
2. In **Render → video-call-app → Environment**, set `CLOUDFLARE_TURN_KEY_ID` to the TURN key ID and `CLOUDFLARE_API_TOKEN` to the API token. Keep both values out of GitHub and browser code.
3. Redeploy the Render service. The server requests 24-hour TURN credentials from Cloudflare and keeps the long-lived API token server-side. It caches the generated ICE credentials for five minutes; the browser receives only the temporary credentials. Cloudflare currently charges $0.05 per real-time GB sent from Cloudflare to the TURN client when used without its Realtime SFU; direct peer-to-peer calls do not use TURN.

Without TURN settings the app has only STUN, which cannot relay media when direct peer-to-peer connectivity is blocked. When TURN is configured, the caller retries with relay-only ICE after a direct connection attempt fails.

**Costs:** Node hosting may be free or a few dollars a month. A domain costs money. TLS certificates (Let's Encrypt) are free. STUN is free; TURN relays all media for affected calls, so it consumes bandwidth (video can be ~1–2.5 Mbps per direction) and is the part most likely to cost money.

## Security and privacy

- Media is end-to-end encrypted in transit by WebRTC (DTLS-SRTP). Signaling uses `wss://` under HTTPS. If a TURN relay is used it forwards encrypted packets but is not able to decrypt them.
- No accounts; call media is never recorded. Private room and matching state stays in memory and is cleared when the service restarts.
- **Anyone with the link can join** if the room has a free slot. The link is the only secret, so share it privately; once two people are in, nobody else can enter. There is no waiting-room approval or password. Links appear in browser history and chat logs.
- IDs are 96-bit random, so they can't practically be guessed. Room creation is rate limited (30/hour/IP; behind a proxy this uses `X-Forwarded-For`).
- Both people's IP addresses are visible to each other's browser as ICE candidates (inherent to peer-to-peer WebRTC). Use TURN-only (`iceTransportPolicy: 'relay'`) if that matters to you.
- Random matching is an opt-in prototype and is off in Render by default. Its age check is self-attestation, not identity or age verification. Reports are not durably saved or reviewed, and there is no blocklist. Do not enable random matching for public use until durable reporting, moderation, and abuse-response operations are in place.

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

## Tests and release checks

Run `npm test` for HTTP health/config/room checks and WebSocket coverage of private-room signaling plus random-match consent, pairing, and report/next behavior. Run `node --check server.js` and `node --check public/app.js` for syntax checks.

The automated tests do not replace testing camera/microphone permissions, browser WebRTC negotiation, TURN relay behavior, or calls across different networks. Verify those manually in current desktop and mobile browsers before enabling random matching publicly.
