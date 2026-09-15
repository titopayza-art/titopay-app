# "Transaction not confirmed / services are not reachable" — root cause

## Symptom

Pressing **Confirm** on a top-up showed:

> **Transaction not confirmed** — TitoPay services are not reachable. Please
> check your connection and try again.

The **review screen loaded fine**, which was the decisive clue: the fee preview
is a database-only call and returns in milliseconds, so the app could reach the
API perfectly. Only the Confirm failed.

## Root cause — a client timeout shorter than the server's own budget

`api()` in `app.js` aborted every request after **15 seconds**:

```js
const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
```

The API's budget for a provider-backed confirm is far larger:

| Step | Timeout |
| --- | --- |
| Peach OAuth token (cold cache) | `peach-checkout-auth-service.js` — **12s** |
| Peach Checkout / Payouts call | `peach-checkout-service.js`, `peach-payout-service.js` — **15s** |
| **Worst case** | **27s + database time** |

So whenever Peach was slow, the browser was **guaranteed** to give up first —
while the server carried on and, very often, succeeded.

The message was wrong for a second reason. The catch keyed off `error.name`:

```js
if (error.name === "AbortError") { …"taking too long"… }
if (!error.status)               { …"services are not reachable"… }
```

Safari does not reliably surface an aborted fetch as a recognisable
`AbortError`, so on iOS the app's own timeout fell through to the network
branch and was reported as a connectivity problem. Both branches also set
`status = 0`, so `friendlyFormError` could not tell them apart either.

## The answers asked for

| | |
| --- | --- |
| 1. Frontend request URL | `POST https://api.titopay.co.za/v1/payments/topup` (card) / `/v1/payouts/withdrawals` (withdrawal) |
| 2. Method | `POST` |
| 3. Payload | `{amount, currency:"ZAR", idempotencyKey, quotedTotal, note}` + `Idempotency-Key` header |
| 4. API route | `payments.routes.js` → `createTopupCheckout` / `payouts.routes.js` → `createWithdrawal` |
| 5. HTTP status | **none** — the browser aborted the request before a response arrived |
| 6. Server-side exception | **none.** The server completed normally |
| 7. Transaction record created | **YES** — `status=pending`, reproduced below |
| 8. Peach contacted | **YES** |
| 9. Peach response | success — a real `checkoutId` was returned |
| 10. Why "not reachable" | the app's own 15s abort, misclassified as a network failure |

**Not** a 404, 401/403, CORS, 5xx, malformed request, version mismatch, or a
Peach failure. All were tested and ruled out — notably, the previous API build
answers the new routes `401` **with** `Access-Control-Allow-Origin`, so a
version mismatch surfaces as 401, never as "not reachable".

## Reproduction (before the fix)

Peach delayed 8s on the token and 10s on the checkout — 18s total, each step
well inside the server's own limits:

```
review screen reached : true

after 25s the customer sees:
  Transaction not confirmed
  TitoPay services are taking too long to respond. Please try again.

server-side result:
  TP-TOPUP-MSJ56PA8-F1339E5C  status=pending  checkoutId=yes   <-- it WORKED
```

The customer was told the payment failed while a real Peach checkout existed —
and was invited to try again, which is how a payment gets made twice.

## Fix — `app.js` only

**1. The timeout now depends on the endpoint.** Ordinary calls keep 15s. The
four provider-backed paths get **45s**, comfortably beyond the server's 27s
worst case, so the client can no longer give up first.

**2. Abort detection asks the controller, not the error:**

```js
const timedOut = controller ? controller.signal.aborted : error.name === "AbortError";
```

This is authoritative on every browser, including Safari.

**3. A timeout is no longer `status = 0`.** It is **408** with `timedOut: true`,
so a timeout can never again be presented as a connection problem.

**4. A timed-out payment is re-asked, not abandoned.** Re-sending with the
**same idempotency key** returns the original record — the API cannot create a
second payment — so this recovers the checkout the server already made instead
of reporting a failure. If even that times out, a withdrawal shows **Processing**
with "do not try again", never "failed".

### The six states are now distinct

| Situation | Status | What the customer is told |
| --- | --- | --- |
| API unreachable / network down | `0` | "services are not reachable… check your connection" |
| API rejected the request | 4xx | the API's own reason |
| Timeout | `408` | "taking longer than usual… Check Activity before trying again" |
| Peach rejected | provider status | "declined… no money was taken" |
| Pending | — | **Processing**, "do not try again" |
| Confirmed | — | "Wallet topped up" / "Withdrawal successful" |

## After the fix — same 18s provider latency

```
review screen reached : true

after 25s the customer sees:
  Peach Payments  Pay ZAR 156.00  Reference: TP-TOPUP-MSJ5B2GR-4A25098D  [Pay now]

server-side result:
  TP-TOPUP-MSJ5B2GR-4A25098D  status=pending  checkoutId=yes
```

The customer reaches the payment page instead of a false failure.

## Files changed

`app/app.js` and `app/app.min.js` (rebuilt), `index.html`, `service-worker.js`
(cache **v277 → v278**). **No API change** — the server was behaving correctly
throughout.

## Verification

New: `timeout-semantics.spec.js` **19/19** in a real browser — proves a timeout
is 408 and never says "not reachable", a real network failure still does, an API
rejection is reported as itself, and re-sending a timed-out payment returns the
same record rather than creating a second.

Regression, all re-run after the change: withdrawal 61/61 · failure modes 28/28 ·
business payout 15/15 · PWA routing 44/44 · service routing 51/51 · fee preview
31/31 · card top-up 32/32 · top-up form 19/19 · offline withdraw 6/6 · direct
top-up 16/16 · 13-way race credited exactly once · API unit suite 207/210 (the
same three that fail in the original build).

## Not touched

Peach Collection and Payout credentials, configuration and connection tests;
transaction confirmation rules; wallet ledger; KYC/FICA; other providers; the
Admin Portal. No wallet was credited or debited to make a test pass.

---

## Addendum — production infrastructure verified from the public internet

Probed `api.titopay.co.za` directly rather than reasoning about it:

| Check | Result |
| --- | --- |
| `GET /v1/health` | **200**, `database: ok`, 1.4s |
| `GET /v1/payouts/banks` | **401** with `Access-Control-Allow-Origin` — the new build **is** deployed and the route exists |
| `OPTIONS /v1/payments/topup` preflight, requesting `authorization,content-type,idempotency-key` | **204**, every header allowed including `Idempotency-Key` |
| `POST /v1/transactions/fee-preview`, `/v1/payments/topup`, `/v1/payouts/withdrawals` | clean **401 JSON**, correct CORS, ~1.0–1.6s |
| Edge | Cloudflare — no WAF challenge, no interception |

So the API, its routes, CORS, TLS, DNS and the edge are all healthy. Nothing
server-side produces "services are not reachable".

## Failure diagnostics in the app

Diagnosing this from a screenshot was impossible: an unreachable API, a client
timeout and an API rejection all rendered identically. The failure modal now
carries one short line:

```
/v1/payments/topup · timeout · 46.2s
/v1/payouts/withdrawals · HTTP 409 · 0.4s · INSUFFICIENT_BALANCE · ref e132675d
```

Endpoint, what happened, how long it took, the API's own error code and the
server request id. Deliberately **no** token, amount, bank detail or account
number — asserted by `diagnostic-line.spec.js` (7/7). A screenshot of the modal
is now enough to identify the cause without access to the device.

---

## Addendum 2 — the diagnostic line answered it

Customer screenshot, v279 deployed:

```
/v1/payments/topup · no response · 1.1s
```

**This rules the timeout out.** A timeout would read `45.0s`. 1.1s is the normal
round-trip to the production API (measured 1.0–1.6s for a 401 from the public
internet), so the request reached the server and something came back — and the
browser then refused it. A response that survives the preflight but is rejected
on arrival is one that carries no valid `Access-Control-Allow-Origin`, i.e. it
did not come from Express at all.

### The API had no crash guards

`src/server.js` registered `SIGTERM` and `SIGINT` and nothing else. **Node
terminates the process on an unhandled promise rejection**, so a single floating
promise anywhere in the API:

* kills the process mid-request,
* drops every other in-flight request with it,
* writes **nothing** explaining why,
* resets the connection, so the edge answers with its own error page — no CORS
  headers — and the browser reports a network failure.

The client cannot distinguish that from a genuine outage. It is exactly the
shape of "not reachable · 1.1s".

Proven rather than assumed:

```
--- Node's default: an unhandled rejection kills the process ---
  PASS  without a handler the process DIES  — exit=1
--- with the handler this API now registers ---
  PASS  the process SURVIVES  — exit=0
  PASS  and the reason is logged
```

### Fix — `src/server.js`

* `unhandledRejection` — log the message, code and stack, **keep serving**. The
  offending request still fails, but through the normal error handler, so the
  caller gets a proper 500 with a `requestId` instead of a dropped connection.
* `uncaughtException` — log the message and stack, then shut down cleanly. This
  one genuinely is unsafe to continue from; what was missing was saying why.

This does not mask a bug — it makes the bug appear in `pm2 logs` instead of
vanishing with the process, and stops one bad promise taking down every
concurrent customer.

Covered by `crash-guard.spec.js` (8/8).

---

## Addendum 3 — separating "the API is down" from "this request was refused"

`no response · 1.1s` narrowed the fault but did not identify it. A browser
reports every failed `fetch` identically, so the modal still could not say
whether the device had lost the API entirely or whether this one request was
refused — and those need opposite answers.

The app now answers that question itself. On any `status = 0` failure it makes
one deliberately minimal probe — a plain `GET /v1/health`, no `Authorization`,
no custom headers, so it triggers no preflight and tests nothing but "can this
device talk to the API right now" — and appends the result:

```
/v1/payments/topup · no response · 1.1s · api reachable      <- this request alone was refused
/v1/payments/topup · no response · 1.1s · api unreachable    <- the device really has lost the API
```

Covered by `reachability.spec.js` (8/8), which drives both cases in a real
browser: one aborting only `/v1/payments/topup`, the other aborting everything.
Still no token, amount or bank detail in the line.

**This is diagnostic, not a fix.** The underlying cause of `no response · 1.1s`
on the production device is not yet identified, and this build does not claim to
resolve it — it makes the next report decisive instead of ambiguous.

---

## Addendum 4 — ROOT CAUSE FOUND, from the production logs

`pm2 logs` showed, repeatedly:

```
status: 401
message: 'Bearer token required'
at requireAuth (/opt/titopay-api/src/middleware/auth.js:69:13)
```

and **no exception, no crash, no restart**. So the crash theory was wrong. The
API was answering correctly; `"Bearer token required"` means the `Authorization`
header was **absent**, i.e. the app had no usable access token.

### The defect

`api()` called `refreshCustomerSession()` **inside its network `try` block**:

```js
try {
  const response = await fetch(...);          // 401
  if (response.status === 401 && …) {
    await refreshCustomerSession();            // throws {status: 0}
    …
  }
} catch (error) {
  if (!error.status) {                         // 0 is FALSY → true
    …"TitoPay services are not reachable"…
    networkError.path = path;                  // the TOP-UP path, not the refresh
    networkError.elapsedMs = Date.now() - startedAt;   // includes the 401 round trip
  }
}
```

A **session** failure was therefore rewritten as a **connectivity** failure,
attributed to the wrong endpoint, with an elapsed time spanning a round trip
that had already succeeded. That is exactly:

```
/v1/payments/topup · no response · 1.1s
```

The customer was told to check their signal and try again. Retrying could never
work — the session needed renewing, not the network.

Anything that throws while renewing a session lands here: the refresh call
itself, a rejected refresh token, or a browser refusing to store the new one
(Safari private mode, full storage quota).

### Fix

**`api()` restructured** so the network `try` wraps *only* the `fetch`. Nothing
else can be classified as a connectivity problem. Response handling and the
token refresh sit outside it, and their errors pass through untouched.

**Session failures are tagged** `fromSessionRefresh`, carry `path:
"/v1/auth/refresh"` and a real `401`, and read:

> Your TitoPay session could not be renewed. Please sign in again. Sign out and
> sign in again — your wallet and money are unaffected.

The diagnostic line names it too:

```
/v1/auth/refresh · HTTP 401 · session refresh failed · 0s
```

A genuine network failure still says "not reachable" — verified in the same run,
so the two can no longer be confused in either direction.

Covered by `session-refresh.spec.js` (11/11), which reproduces the production
shape exactly: the top-up 401s with `Bearer token required`, the refresh fails,
and the app must call it a session problem.
