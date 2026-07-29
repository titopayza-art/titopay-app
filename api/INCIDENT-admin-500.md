# "Admin module unavailable — Service responded 500"

Diagnosed 29 July 2026 against live production. Reproducible on demand.

## Summary

**The API returns `500` instead of `401` when an access token is invalid or
expired.** The admin console only refreshes its session on a `401`, so a `500`
puts it in a loop it cannot get out of: every retry sends the same expired
token and gets the same `500`. That is the "keeps on crashing".

Missing token is handled correctly. **Invalid** token is not.

## Reproduction

```bash
# Missing token — correct
curl -s https://api.titopay.co.za/v1/admin/dashboard/overview
# 401 {"ok":false,"error":"Bearer token required","requestId":"…"}

# Invalid token — wrong
curl -s https://api.titopay.co.za/v1/admin/dashboard/overview \
     -H "Authorization: Bearer garbage"
# 500 {"ok":false,"error":"Unable to complete the request. Please try again.","requestId":"…"}
```

Confirmed with three token shapes — a non-JWT string, a well-formed but fake
JWT (`aaa.bbb.ccc`), and a structurally valid JWT with an expired `exp` and a
bad signature. All three return `500`.

That `error` string is verbatim the text on the reported screenshot, under
heading "Admin module unavailable" with "Service responded 500".

## Why it loops

`assets/admin.js` (admin console v33), in `apiFetch`:

```js
if (response.status === 401 && auth?.refreshToken) {
  // …refresh, then retry the original request…
}
```

The refresh branch is gated on `401`. When the API answers `500` the console
never reaches it, never refreshes, and renders the module error instead.

1. Admin signs in. Access token is short-lived.
2. Token expires while the console is open.
3. Console requests a module → API auth middleware throws on the expired token
   → **500**.
4. Console sees `500`, not `401`, so it does **not** refresh.
5. "Retry" re-sends the same expired token → same `500`. Indefinitely.

The only way out is signing out and back in, which is consistent with the
reported behaviour.

## Second, compounding bug

`POST /v1/auth/refresh` **also** returns `500` for any bad or missing refresh
token, where it should return `401`:

```bash
curl -s -X POST https://api.titopay.co.za/v1/auth/refresh \
     -H 'Content-Type: application/json' \
     -d '{"refreshToken":"not-a-real-token","scope":"admin"}'
# 500 {"ok":false,"error":"Unable to complete the request. Please try again.","requestId":"…"}

curl -s -X POST https://api.titopay.co.za/v1/auth/refresh \
     -H 'Content-Type: application/json' -d '{}'
# 500 — same
```

So even once the middleware is fixed and the console does get a `401`, the
refresh it then attempts will `500` unless this is fixed too. **Both need
fixing**, or the loop simply moves one step further along.

This also affects the customer PWA: `app.js` refreshes on `401` and signs the
user out if it fails. An expired refresh token currently produces a server
error rather than a clean re-authentication.

## What is *not* wrong

Ruled out by probing, so nobody spends time here:

- **The API is up.** `GET /health` → `200 {"status":"ok","database":"ok"}`.
- **The database is up.** Same response.
- **Routing is intact.** All 39 admin endpoints return a clean `401` without a
  token — every route exists and resolves.
- **CORS is fine.** The console receives and parses responses.
- **It is not one bad module.** Any admin endpoint reproduces it.
- **The error page is well-behaved** — no stack trace, no SQL, no internal
  hostname, and it surfaces a `requestId`. It is reporting a real server fault,
  not creating one.

## The fix

In the API's authentication middleware, catch verification failures and return
`401`. Today the exception escapes to the generic error handler, which maps
anything unhandled to `500`.

```js
// Express / jsonwebtoken shape — adapt to the actual stack.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Bearer token required", requestId: req.id });
  }
  try {
    req.user = jwt.verify(header.slice(7), SECRET);
    return next();
  } catch (err) {
    // TokenExpiredError, JsonWebTokenError, NotBeforeError — all are 401.
    // This catch is the entire bug: without it these become a 500.
    return res.status(401).json({
      ok: false,
      error: err.name === "TokenExpiredError"
        ? "Your session has expired. Please sign in again."
        : "Your session is no longer valid. Please sign in again.",
      requestId: req.id
    });
  }
}
```

Apply the same treatment to the `/v1/auth/refresh` handler: a refresh token
that is absent, malformed, expired or revoked is a `401`, never a `500`.

### Verifying the fix

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://api.titopay.co.za/v1/admin/dashboard/overview -H 'Authorization: Bearer garbage'
# want: 401

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.titopay.co.za/v1/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"nope","scope":"admin"}'
# want: 401
```

Both `401` means the console will refresh and recover on its own, and the loop
is gone.

## Worth doing regardless

The generic `500` body — "Unable to complete the request. Please try again." —
is the right thing to show a user, but it tells an operator nothing. Every one
of these carries a `requestId`. Make sure the server log line for that id
records the actual exception and stack, so the next incident is one grep rather
than an afternoon of probing.

The reference from the reported screenshot was
`e61cdf24-025a-43e1-b7e0-e3716e0aac46`. If that log line exists it should show
a JWT verification error, which would confirm this diagnosis directly.

## Related: `/v1/maintenance/public` requires authentication

Found while probing, unrelated to the crash but live:

```bash
curl -s https://api.titopay.co.za/v1/maintenance/public
# 401 {"ok":false,"error":"Bearer token required","requestId":"…"}
```

The PWA calls this endpoint **unauthenticated** (`app.js:575`, `auth: false`)
and swallows the failure, so `state.maintenance` is silently set to disabled.
**TitoPay currently cannot show a maintenance notice to customers at all.** It
should be public, as its name and `openapi-app.yaml` both say.
