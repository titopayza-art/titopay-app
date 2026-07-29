# TitoPay authentication flow — audit and root cause

Scope: the customer PWA sign-in path, from the Sign In button to the API
response. Nothing outside that path was changed.

---

## Verdict

**The authentication code is correct.** Base URL, endpoint, payload, CORS,
service worker and error mapping all check out, and every server error is
surfaced with a specific message. The request is not blocked, not redirected and
not silently dropped.

**"TitoPay services are not reachable" is being told the truth.** It appears
when `fetch` itself rejects — and on production it does, because **the API
process is restarting roughly every 90 seconds**. Any sign-in in flight during a
restart dies at the transport layer.

The fix for the reported symptom is operational, not a code change. One genuine
code defect was found alongside it and is fixed here.

---

## Trace: Sign In button → API response

| Step | Location | Finding |
|---|---|---|
| 1. Button | `app.js` — `<button data-auth-tab="login">` | opens the auth modal |
| 2. Submit | `onSubmit()`, delegated on `document` | matches `form[data-form="login"]`, calls `login(data)` |
| 3. Request | `login()` → `api("/v1/auth/login", { method:"POST", auth:false, body:{...} })` | correct endpoint, correct method, no stray `Authorization` header |
| 4. Base URL | `const API_BASE = "https://api.titopay.co.za"` (`app.js:3`) | correct, hard-coded |
| 5. Transport | `fetch(\`${API_BASE}${path}\`)`, 15 s `AbortController` | verified sent in all five scenarios |
| 6. Response | status → `error.status`, body → `error.message` | correct |
| 7. Display | `friendlyFormError(error, "login")` → `showToast` | maps every status to a specific message |

## Checks that passed

| Check | Evidence |
|---|---|
| API base | `https://api.titopay.co.za` — correct |
| Endpoint | `POST /v1/auth/login` — exists, live |
| Payload | `{identifier, password, deviceName, platform}` — accepted |
| CSP | `connect-src` includes `https://api.titopay.co.za` and the `wss://` origin — not blocking |
| Service worker | returns early for non-GET **and** explicitly excludes `api.titopay.co.za` — never intercepts login |
| CORS preflight | `OPTIONS /v1/auth/login` from `https://app.titopay.co.za` → **204**, correct `allow-origin`, `allow-methods`, `allow-headers` |
| Live request | `POST /v1/auth/login` → **401** `{"ok":false,"error":"Invalid credentials","requestId":"…"}` with `access-control-allow-origin` present |
| Redirects | none on the auth path |

**In-browser, real bundle, real API — five scenarios, all correct:**

```
PASS  401 wrong credentials   sent=1  "Incorrect login details. Please check your PIN and try again."
PASS  429 rate limited        sent=1  "Too many login attempts. Please wait a few minutes and try again."
PASS  423 account locked      sent=1  "Account locked until tomorrow"          ← server's own text
PASS  500 server fault        sent=1  "Unable to sign in right now… Ref: r-9"  ← carries requestId
PASS  network failure         sent=1  "TitoPay services are not reachable…"    ← only here
```

`sent=1` in every case: **the request is always dispatched.** Never blocked,
never swallowed.

---

## Root cause of the reported symptom

From your own `pm2 logs` output:

```
20:36:12  TitoPay API received SIGTERM; closing connections
20:36:22  TitoPay API service started
20:37:43  TitoPay API received SIGTERM; closing connections
20:37:49  TitoPay API service started
20:39:13  TitoPay API received SIGTERM; closing connections
```

**Restarts at 20:36:12, 20:37:43, 20:39:13 — roughly every 90 seconds**, each
with a ~6–10 second window where nothing is listening. A sign-in submitted in
that window has its connection dropped mid-flight, `fetch` rejects with a
`TypeError`, and the client correctly reports the service as unreachable.

That is not a frontend defect. The frontend is accurately describing a server
that went away.

**To find why it is restarting:**

```bash
pm2 describe titopay-api | grep -Ei "restarts|uptime|memory"
pm2 logs titopay-api --err --lines 60
```

`deploy/ecosystem.config.cjs` sets `max_memory_restart: "512M"`, so a memory
ceiling is the first thing to rule out. A SIGTERM is a *graceful* signal — PM2
sends it on `restart`, on `max_memory_restart`, and on a watch trigger. It is
not a crash signature, which points at PM2 restarting the process rather than
the process dying.

Every other error in those logs is a clean **401** — no 500s. The auth fix
deployed earlier is working.

---

## Second finding: the chat socket 401-loops every 10 seconds

Also visible in your logs, ~6 times a minute, continuously:

```
GET /v1/chat/socket  401  "Bearer token required"
```

Tested against production with a proper handshake:

```bash
curl -D - https://api.titopay.co.za/v1/chat/socket \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: …" \
  -H "Sec-WebSocket-Protocol: titopay-chat, bearer.…"
→ HTTP/2 401
```

**`HTTP/2`.** A WebSocket handshake requires HTTP/1.1. The upgrade is not being
negotiated at the edge, so the request arrives at Express as a plain GET and is
answered 401 by the ordinary bearer-token middleware.

Both halves of your own stack are correct:

- `src/realtime/chat-socket.js` handles `upgrade`, reads `bearer.<token>` from
  `Sec-WebSocket-Protocol`, and negotiates the `titopay-chat` subprotocol.
- `deploy/nginx-api.titopay.co.za.conf` sets `proxy_http_version 1.1`,
  `Upgrade` and `Connection $connection_upgrade` on `location = /v1/chat/socket`.

So the upgrade is being lost **before nginx** — at Cloudflare, or because the
deployed nginx differs from the file in the repo.

The client reconnects on a linear backoff capped at 10 s
(`Math.min(10000, 1000 * attempts)`), which matches the log cadence exactly. The
effect: every signed-in customer holds an endless 10-second reconnect loop —
battery and mobile data spent on nothing — and the API log is flooded, which is
what makes real faults hard to see.

**Not fixed here.** It is a Cloudflare/nginx setting, outside this scope and
outside the rule against touching infrastructure. Enable WebSockets for
`api.titopay.co.za` at the edge, then re-run the curl above and expect
`HTTP/1.1 101 Switching Protocols`.

---

## Code defect found and fixed

`app.js`, in `api()`. The catch block funnelled **every** error without a
`.status` into "not reachable":

```js
if (!error.status) {
  const networkError = new Error("TitoPay services are not reachable…");
```

`fetch` rejects with a `TypeError` for a genuine transport failure. But a
`ReferenceError` or `TypeError` thrown by our own code *after* the response —
in the refresh arm, or in response handling — has no `.status` either, and was
reported to the customer as a network problem. That sends someone to check their
signal over a bug on our side, and hides the real message from the console.

**Fix — the smallest that separates the two:**

```js
const transportFailure = error instanceof TypeError;
const networkError = new Error(
  transportFailure
    ? "TitoPay services are not reachable. Please check your connection and try again."
    : (error.message || "Something went wrong completing that request. Please try again.")
);
networkError.status = 0;
networkError.transportFailure = transportFailure;
if (!transportFailure) console.error("[api] unexpected client-side failure", { path, error });
```

Behaviour for real network failures is unchanged — verified above. Internal
faults now carry their own message and are logged.

## Files changed

| File | Change |
|---|---|
| `app.js` | separate a transport failure from an internal fault in `api()`'s catch |
| `index.html`, `service-worker.js`, `DEPLOYMENT_BUILD_MARKER.txt` | version bump v184 → v185 (the service worker would otherwise serve the cached bundle) |

No endpoint, payload, header, base URL or auth behaviour was altered. No backend
change. Nothing outside the auth path was touched.

## What to do

1. **Stop the restart loop.** This is the reported symptom. `pm2 describe` and
   `pm2 logs --err` will say why; `max_memory_restart: "512M"` is the first
   suspect.
2. **Enable WebSockets at the edge** for `api.titopay.co.za` — stops the
   10-second reconnect loop and clears the log flood.
3. Deploy v185 when convenient. It does not fix the symptom on its own; it stops
   a future bug in our own code from being misreported as a network failure.
