# Drop-in fix for the admin 500 loop

`auth-middleware.js` replaces the API's bearer-token middleware so an invalid,
malformed or expired token returns **401** instead of **500**. That single change
ends the "Admin module unavailable" loop, and fixes the same fault for HR
integrations and the customer PWA at the same time.

Background, reproduction and reasoning: `../INCIDENT-admin-500.md`.

## Why this is written for Express

Not a guess — the live API reports it. From response headers on
`https://api.titopay.co.za/health`:

| Header | Tells us |
|---|---|
| `etag: W/"1f-…"` | Express's default weak ETag |
| `x-dns-prefetch-control`, `x-download-options`, `x-permitted-cross-domain-policies`, `origin-agent-cluster` | Helmet's default header set |
| `ratelimit-policy: 120;w=60` | express-rate-limit v7, `standardHeaders` |
| `vary: Origin` | the `cors` package |
| `x-request-id` | what the console prints as "Reference" |

So: **Node + Express + Helmet + cors + express-rate-limit, behind Cloudflare.**
The error envelope and the "Bearer token required" wording in the module are
copied from live responses, so nothing user-visible changes except the status
code on the paths that are currently wrong.

The CSP `connect-src` also confirms three front ends —
`app.`, `admin.` and `hr.titopay.co.za` — all of which share this API and all of
which are affected.

## Verified behaviour

Ten cases, run against the module itself:

```
customer middleware
  PASS  no header                    401  "Bearer token required"
  PASS  empty bearer                 401  "Bearer token required"
  PASS  garbage token                401  "Your session is no longer valid…"
  PASS  fake JWT shape               401  "Your session is no longer valid…"
  PASS  expired token                401  "Your session has expired…"
  PASS  wrong signature              401  "Your session is no longer valid…"
  PASS  valid token                  next()

admin middleware
  PASS  customer token on admin      403  "You do not have access to this area."
  PASS  expired admin token          401  "Your session has expired…"
  PASS  valid admin token            next()
```

No path returns 5xx. The missing-token case keeps its existing wording, so
clients that match on that string are unaffected.

## Wiring it in

**1.** Copy `auth-middleware.js` into the API repo — wherever the current auth
middleware lives, e.g. `src/middleware/auth.js`.

**2.** Find the existing middleware. It is whatever currently emits
`"Bearer token required"`:

```bash
grep -rn "Bearer token required" src/
```

**3.** Replace its export with this module's, keeping your own names:

```js
const { requireAuth, requireAdmin } = require("./middleware/auth");

app.use("/v1/admin", requireAdmin);   // admin-scoped
app.use("/v1/wallets", requireAuth);  // customer routes, as already mounted
```

**4.** Fix the refresh handler too. `refreshHandler` shows the shape; fold its
`try/catch` into your existing handler, passing whatever function already mints
the token pair. **Do not skip this** — fixing only the middleware moves the loop
one step along: the client gets its 401, tries to refresh, and the refresh 500s.

**5.** Check the secrets match your config. The module reads `JWT_SECRET` and
`JWT_REFRESH_SECRET`; rename to match what the API already uses.

**6.** Confirm the `scope` claim. It assumes admin tokens carry
`scope: "admin"` — the admin console already sends `scope: "admin"` when
refreshing, so this is likely right, but check what `/v1/admin/login` mints. If
admin identity is carried some other way (a `role` claim, a separate secret),
adjust the `scope` check and leave the `try/catch` exactly as it is. **The
try/catch is the fix; everything else is shape.**

## Confirming it worked

```bash
../verify-auth-fix.sh
```

All nine checks must pass. Until then the loop is still live.

Then, in the admin console, let a session go idle past its expiry and use it
again — it should refresh silently instead of showing "Admin module
unavailable".

## Afterwards

Once `verify-auth-fix.sh` is green, remove the `500` arm from the PWA's `api()`
in `app.js`. It is a workaround for this bug, marked in the source with that
instruction, and it should not outlive the fault it works around.

## While you are in there

Two unrelated things worth the same deploy:

- **`/v1/maintenance/public` requires a token.** The PWA calls it
  unauthenticated and swallows the failure, so no maintenance notice can
  currently reach customers. It should be public.
- **The generic 500 body tells an operator nothing.** Every response carries a
  `requestId` — make sure the server log line for it records the actual
  exception and stack, so the next incident is one grep.
