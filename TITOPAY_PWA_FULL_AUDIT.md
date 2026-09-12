# TitoPay Customer PWA — Full Production Audit

**Audit date:** 11 August 2026
**Scope:** the customer PWA (`pwa/`), plus the API only where the PWA depends on it
**Branch:** `claude/peach-payments-403-fix-6sv7cy` @ `5d24537`
**Nature:** read-only. No application file was modified, and nothing was committed or pushed.

---

## 0. What this audit did and did not touch

**Changed:** nothing in `pwa/`, `api/`, `admin/`, `hr/`, the database schema, migrations, or any
configuration. The only file created is this report.

**Method.** Static reading of `pwa/app.js` (20,199 lines), `pwa/styles.css` (12,800 lines),
the service worker, manifest and entry point; targeted reading of the API where the PWA's
behaviour depends on it; and a **live browser pass** against a throwaway copy served from a
sandbox, driven with an iPhone-sized viewport and an iOS Safari user agent.

**Two honest caveats about the live pass:**

1. It ran against a **local sandbox** (`127.0.0.1`), not production. The served copy was built
   from the repository's `pwa/` and verified byte-identical to it apart from the API origin, so
   what was exercised is the real shipped code — but the data and the provider behind it are not
   production's.
2. Signing in required an account, so the pass **registered one throwaway user in the local
   sandbox database**. No production data was touched. Nothing that commits money was clicked.

**One prior-state disclosure.** Before this audit, in an earlier task on this branch, I committed
and pushed two commits (`ff6bf86`, `5d24537`). Finding **P0-1** below is a direct consequence of
one of my own earlier changes on this branch (`c2c4603`). I have not reverted it — this is an
audit — but I am naming it as mine rather than presenting it as pre-existing.

---

## 1. Executive Summary

The TitoPay PWA is a **single 1.0 MB classic script** (`app.js`, minified to `app.min.js`) with
no framework, no build-time dependencies and no third-party network calls. That is an unusual
architecture for a fintech app and it is, on balance, a **strength**: the supply-chain surface is
almost nil, the Content-Security-Policy is genuinely strict, and HTML escaping is applied with
real discipline throughout.

The money path is also better than expected. Fees are priced **server-side** from a schedule keyed
by service code; the customer app previews them through `/v1/transactions/fee-preview` and
displays what the server returned. Idempotency is implemented properly — a client-generated key
sent as both a header and a body field, checked unlocked as a fast path and then enforced by a
**transaction-scoped Postgres advisory lock**, so a double tap, two tabs, or a mobile network
re-delivering a POST all resolve to the original transaction rather than a second charge. Timeouts
tell the customer to **check Activity** rather than to retry, which is the correct instruction and
is rarer than it should be.

The problems are concentrated in three places:

1. **Internal server sentences now reach customers verbatim.** A configuration fault surfaces to
   the person paying as *"TitoPay revenue wallet is not configured"*. This is the exact string the
   audit brief names as the canonical bad case, and it is currently **locked in by two passing
   tests**. It was introduced deliberately, by me, on this branch.
2. **The client supplies the charge amount for at least one fixed-price item.** The Business
   Document PDF flow posts `amount: DOCUMENT_PDF_FEE` (a client constant) to `/v1/transactions`.
   Whether that is exploitable depends on a server behaviour I did not fully trace — the exact
   check is written out in P0-2 and should be run before anything else in this report.
3. **Any unrecognised URL fragment renders a completely blank screen.** Verified live: `#stockvel`,
   `#send`, `#not-a-route` all produce a bottom navigation bar over an empty page. There is no
   route allow-list and no fallback.

Test coverage has a specific and important hole: there is **no test file at all** for transactions,
transfers, fees, VAS (airtime/data/electricity), QR or Scan-to-Pay.

---

## 2. Overall Production Readiness

**Needs Important Fixes Before Production.**

Nothing found in this audit demonstrably loses or misplaces customer money today. The server-side
fee authority and the advisory-lock idempotency guard are the two things that would most likely
have caused financial damage, and both are implemented correctly. The blocking items are an
information-disclosure regression that is currently enshrined in tests, one unverified
client-controlled-amount path, and dead routes that show customers a blank app.

---

## 3. Architecture Overview

| Layer | What it is |
|---|---|
| Framework | **None.** One classic `<script>`, `"use strict"`, ~900 top-level functions |
| Entry | `index.html` → `app.min.js?v=299` (**not** `app.js` — the source is not shipped as the runtime) |
| Overlay | `notification-routing-fix.js?v=1`, a 22-line additive patch loaded after the bundle |
| Styling | `styles.min.css?v=298`, no preprocessor |
| Build | `verification/build-pwa.sh` — Terser, top-level names preserved, bumps the version in three files |
| State | One module-level `state` object; `render()` re-renders the whole shell via `innerHTML` |
| Routing | `location.hash` → `state.route`; `hashchange` → `render()` |
| API client | One `api()` function: `AbortController` timeout, bearer token, single 401→refresh retry |
| Auth | JWT access + refresh in `localStorage` under `titopay_candidate_auth_v1` |
| Offline | Service worker, network-first for HTML/JS/CSS/JSON, cache-first for everything else |
| Third-party | **One vendored file only** — `assets/jsQR.min.js` (130 KB). No CDN, no analytics, no tag manager |

The file is organised into 24 documented sections with a contents list, and it enforces a real
convention: function declarations may live anywhere (they hoist), but every order-sensitive
statement must sit in one of two banner-marked blocks. This is worth preserving — it is what keeps
a 20,000-line file navigable.

`render()` gates in a deliberate order: public event view → maintenance view → unauthenticated
`authView()` → `appView()`.

---

## 4. Route Inventory

The app has **five real routes**. Everything else — 133 `openModal()` call sites and 110 distinct
`data-action` values — is a modal reached from a tile.

| Route | Renders | Live result (authenticated, iPhone viewport) |
|---|---|---|
| `#dashboard` | `dashboardView()` | renders (265 chars of text on a new account) |
| `#services` | `servicesView()` | renders (269 chars) |
| `#qr` | `qrView()` | renders (270 chars) |
| `#activity` | `activityView()` | renders (362 chars) |
| `#profile` | `profileView()` | renders (1,127 chars) |
| *(empty)* | falls back to `dashboard` | correct |
| **anything else** | **nothing** | **blank screen, nav bar still present** |

Verified blank: `#stockvel`, `#send`, `#not-a-route`, and a URL-encoded `<img src=x onerror=…>`
fragment. The XSS-shaped fragment did **not** execute — the hash is only ever string-compared,
never written into HTML — so that is a dead route, not an injection.

Because `appView()` is a chain of `route === "x" ? view() : ""` expressions, an unmatched route
produces an empty `<main class="screen">`. There is no `default`, no 404 view and no redirect.

**Reachable in the wild:** the service worker's `notificationclick` handler builds its destination
from `event.notification.data?.route || "profile"`. Any notification carrying a route the shell
does not render lands the customer on a blank app.

---

## 5. Financial Logic Findings

### What is server-authoritative (good)

- **Fee pricing.** `api/src/services/pricing-service.js` holds a schedule keyed by service code
  (flat, percentage and capped variants). `business_document_pdf` is `2.50`, `payouts` is `1.5%`,
  `marketplace_commission` is `12%`, and so on.
- **Fee computation.** `createTransaction()` calls `feePreview()` server-side and derives
  `debitTotal` from `preview.total`. The client's opinion of the fee is not used to debit.
- **Rounding.** The server uses `roundMoney()` on both the amount and the net.
- **Balance check.** `if (Number(wallet.available_balance) < debitTotal) throw 400 Insufficient balance`
  — server-side, before any movement.
- **Idempotency.** Fast-path unlocked read, then a transaction-scoped advisory lock inside `BEGIN`.
  The code comments correctly identify that the unlocked read is *not* the guard. This is the
  single best-implemented thing in the money path.

### What is client-side (risk)

| Location | Code | Risk |
|---|---|---|
| `app.js:8289` | `amount: DOCUMENT_PDF_FEE` posted to `/v1/transactions` | **P0-2** — client names the charge |
| `app.js:90,91,96` | `EMAIL_STATEMENT_FEE=0.1`, `SMS_ALERT_FEE=0.3`, `DOCUMENT_PDF_FEE=2.5` | **P1-2** — advertised price can drift from configured price |
| `app.js:5803` | `const total = Number(preview.total ?? amount + fee)` | **P2-1** — float fallback contradicts its own comment |
| `app.js:11700` | `netAmount: Math.max(0, amount - fee)` | display-only, but same float pattern |
| `app.js:8184` | `const vat = vatIncluded ? subtotal * 0.15 : 0` | invoice/quote **document** arithmetic, not a wallet movement |

No `NaN`, `Infinity` or negative-amount guard gaps were found on the client that the server does
not independently re-check (`!Number.isFinite(amount) || amount <= 0` → 400).

The VAT line at `8184` is float arithmetic on money, but it renders a customer-generated business
document (invoice/quote), not a TitoPay charge. It is a correctness concern for the document, not
for the wallet.

---

## 6. Wallet Findings

- Balance is read from the server; the app never computes it.
- `data-action="toggle-balance"` hides the figure and persists the choice in `sessionStorage`
  (`BALANCE_HIDDEN_KEY`) — correctly session-scoped, not device-permanent.
- The CSV export (`downloadTransactionsCsv`) is notably careful: it separates *attempted* Amount/Total
  from *actual* `Posted To Wallet` / `Wallet Movement` columns, with a comment telling a reconciler
  which two to total. That is good financial hygiene.
- The "All" quick-amount chip on withdrawal passes the raw balance as `data-quick-amount` — server
  re-validates, so this is presentational only.

---

## 7. Transfer Findings

- Recipients are resolved and **verified before** the fee preview
  (`verifyRegisteredRecipientBeforeTransaction`), so a customer confirms against a named person.
- `state.pendingTransactionReview` carries one `idempotencyKey` created at preview time and reused
  on every confirm attempt — the correct shape.
- Insufficient balance is enforced server-side.
- **Gap:** `/v1/transactions` is not in `PROVIDER_BACKED_PATHS`, so transfers get the 15-second
  default timeout (see P1-3).

---

## 8. Withdrawal Findings

- `/v1/payouts/withdrawals` **is** in `PROVIDER_BACKED_PATHS` → 45-second timeout. Correct.
- Server-side payout construction validates against Peach's published `createPayoutRequest` schema:
  `payoutMethod` must be `realtime-eft`, `payoutId` a lowercase UUIDv4, `branchCode` exactly six
  digits, `bankName` from a fixed list of South African banks. Amounts are converted to cents
  server-side with documented min/max bounds.
- Withdrawal has a dedicated test file (`peach-withdrawal.test.js`) and a payout capability suite.

---

## 9. Payment Findings

- The app does **not** treat an HTTP 200 as proof of settlement. Merchant sale polls status every
  2.5 s (`sale.pollTimer`); top-up has its own status path.
- On timeout the customer is told: *"Check Activity before trying again — if it appears there, it
  went through."* with an explicit comment that "retrying is how a payment gets made twice". This is
  correct and unusually well handled.
- 401 triggers exactly one refresh-and-retry, guarded by `authRetried` — no infinite loop.
- Webhooks are server-side only; the PWA never processes a callback.

---

## 10. VAS Findings (airtime, data, electricity, vouchers)

- Section 14 of `app.js` is the largest VAS surface (78 functions). Purchases go through the same
  `/v1/transactions` + fee-preview + idempotency-key path as transfers, which is the right design.
- **Gap:** VAS is provider-backed (Flash) but is **not** in `PROVIDER_BACKED_PATHS`, so an airtime
  or electricity purchase aborts client-side at 15 seconds while the provider may still be working.
  The customer then sees the "check Activity" message — correct guidance, but the abort is premature.
- **Gap:** there is **no automated test file** covering airtime, data, electricity or vouchers.

I did not exercise a VAS purchase end to end — that would commit a transaction, which this audit
does not do.

---

## 11. Statement Findings

The Email Statement flow is where the top finding surfaces to customers.

- `confirmEmailStatement()` sends an `Idempotency-Key` header **and** an `idempotencyKey` body
  field, and correctly distinguishes the deduplicated reply: *"This Email Statement request was
  already received. No duplicate fee was charged."*
- The success message quotes `money(result.fee)` — the **server's** fee. Correct.
- **But** the button label and the Activity screen both quote the **client constant**
  `EMAIL_STATEMENT_FEE = 0.1` (`app.js:990`, `8723`). The button says "Confirm and email for R0.10"
  from a hardcoded value; only the receipt line falls back to it (`preview.fee ?? EMAIL_STATEMENT_FEE`).
- `confirmEmailStatement` sets `button.disabled = true` and has **no `try`/`catch`**. On any failure
  the throw propagates to the global click handler, which toasts the message — and the button stays
  permanently disabled. The customer must close and reopen the modal to try again.
- `statement-financial-integrity.test.js` verifies exactly one revenue-wallet movement and that the
  fee is not taken twice. That is good coverage of the money, if not of the messaging.

---

## 12. Security Findings

### Strong

- **CSP is strict and real:** `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  `connect-src` allows only `'self'`, `https://api.titopay.co.za` and `wss://api.titopay.co.za`.
- **No external scripts of any kind.** jsQR is vendored locally.
- `<meta name="referrer" content="no-referrer">`.
- **Escaping discipline:** `esc()` is applied consistently, including inside shared helpers
  (`settingsRow`, `securityCentreRow`) rather than only at call sites. A targeted search for
  user-controlled fields interpolated into HTML without escaping found no hits.
- **Toasts use `textContent`**, not `innerHTML` — server-supplied error prose cannot inject markup.
- `showToast` additionally scrubs a list of technical phrases before display.
- No API keys, secrets or credentials found in the client bundle.

### Weak

- **`frame-ancestors` in a `<meta>` tag is ignored by browsers** (confirmed live in the console).
  Clickjacking protection therefore depends on an `X-Frame-Options` or CSP **response header** from
  the host. Not verifiable from the repository — see P2-2.
- **Access *and* refresh tokens live in `localStorage`** (verified: `titopay_candidate_auth_v1`
  holds both). Any successful XSS yields a full, refreshable session. The strict CSP and escaping
  discipline are what stand between that and exploitation; there is no second line.
- The in-app notification store is keyed per user and held in `localStorage`
  (`titopay_in_app_notifications_v1:personal:<uuid>`, 6.7 KB on a brand-new account) — it persists
  after sign-out unless explicitly cleared.

### Not a production issue

The live pass logged a CSP violation for `ws://127.0.0.1:8110/v1/chat/socket`. That is a **sandbox
artefact** — production connects to `wss://api.titopay.co.za`, which the CSP allows.

---

## 13. Authentication Findings

- Login, registration and OTP occupy section 7 (38 functions); session and device management
  section 8 (28 functions).
- **Session refresh is deliberately outside the network `try`** so that a session failure is never
  relabelled as "services are not reachable". The comment explains that this previously told
  customers to check their signal when their session had actually expired. Good fix, well documented.
- Idle timers reset on `pointerdown`, `keydown`, `scroll`, `touchstart` (all passive).
- Rate limiting is server-side and persisted in Postgres, so it survives an API restart.
- One refresh retry per request, guarded — no loop.
- No authentication bypass was found. Route rendering is gated on
  `state.auth?.accessToken && state.user`, and every protected read is a server call with a bearer
  token, so hiding UI is not load-bearing.

---

## 14. API Findings

- **17+ distinct endpoints**, 110 `await api(...)` call sites.
- Timeouts: 15 s default, 45 s for provider-backed paths — but the provider-backed list covers only
  top-up and withdrawals, not `/v1/transactions`.
- **No automatic retry** on any request. For financial POSTs that is the correct choice.
- Malformed JSON is handled: a non-JSON body becomes `{ error: text }` rather than throwing.
- Errors carry `status`, `details`, `requestId`, `path` and `elapsedMs` — a good diagnostic shape.
- **Contract mismatch risk:** the fee-preview consumer reads `preview.total`, `preview.fee`,
  `preview.amount`, `preview.recipientAmount ?? preview.netAmount` — two different names for the
  same concept, defended with `??`. That defence is what makes P2-1 possible.

---

## 15. Safari / iOS Findings

Measured on a 390×844 viewport with an iOS Safari user agent.

| Signal | Count | Assessment |
|---|---|---|
| `100dvh` | 22 | Modern dynamic viewport used widely — good |
| `100svh` | 21 | Small-viewport units used alongside — good |
| `100vh` | 9 | Residual; each is a candidate for the classic iOS toolbar bug |
| `safe-area-inset` | 4 | **Low** for an app with a fixed bottom nav and a notch target |
| `position: fixed` | 8 | Modest |
| `position: sticky` | 1 | Minimal |
| `-webkit-overflow-scrolling` | 11 | Legacy momentum scrolling retained |
| `overscroll-behavior` | 24 | Well covered — this is what prevents rubber-band bleed-through |

- **No horizontal overflow** at 390 px on the landing screen (`scrollWidth === clientWidth === 390`).
- **All visible touch targets ≥ 44×44.**
- **Bottom-nav overlap: not demonstrated.** `main.screen` carries `padding-bottom: 104px` against
  an 80 px nav, which clears it. An earlier measurement of mine suggested five overlapping elements;
  that measurement was **invalid** — the programmatic scroll did not reach the bottom
  (`atBottom: false`), so it was sampling mid-scroll content passing under a fixed bar, which is
  normal. I am not reporting it as a finding.
- The programmatic-scroll failure is itself informative: **the document is not the scroll container**
  on this layout. Anything that assumes `document.scrollingElement.scrollTop` will mis-measure, and
  only a real gesture can test a scroll lock.

**The specific symptoms named in the brief** — Services wobbling, Send Gift shaking, Stockvel screens
moving — could **not be reproduced or ruled out** in headless Chromium with an iOS user agent. A UA
string does not give you WebKit. These need a real iPhone or a WebKit runner; see *Recommended
Testing*.

---

## 16. UI/UX Findings

- **Consistency is high.** Shared builders (`settingsRow`, `metricCard`, `securityCentreRow`,
  `receiptRow`) mean spacing, typography and iconography are structurally consistent rather than
  consistent by discipline.
- **Financial copy is unusually good.** The cost panel shows three labelled lines (amount / fee /
  total) with wording adapted per service, and adds "The recipient receives R…" only where a
  recipient exists. The comment explaining why the money lines are *not* repeated further down is
  the kind of decision most apps get wrong.
- Destructive actions confirm with consequence stated: removing a beneficiary says *"No money will
  move and past transactions will remain in Activity."*
- **Dead routes render nothing at all** (P1-1) — the single worst UX defect found.
- **A disabled button that never re-enables** after a failed statement request (P1-4).
- Empty/loading/error states exist but were not surveyed screen-by-screen; the five top-level routes
  all rendered content on a brand-new, unfunded account, which is the hardest empty-state case.

---

## 17. Accessibility Findings

Measured live on the landing screen:

| Check | Result |
|---|---|
| Images without `alt` | **0** |
| Inputs without an accessible name | **0** |
| Buttons without an accessible name | **0** |
| `<html lang>` | `en-ZA` |
| `<h1>` count | 1 |
| Touch targets < 44×44 | **0** |

Additionally: `showToast` sets `role="alert"` + `aria-live="assertive"` for errors and
`role="status"` + `aria-live="polite"` otherwise, with `aria-atomic`, and removes any existing toast
first so screen readers do not double-announce. `#app` carries `aria-live="polite"`. The bottom nav
has `aria-label="Primary"` and every item an `aria-label`. `associateFieldLabels(app)` runs after
each render.

This is a **good** accessibility baseline. It was measured on the landing and shell only —
individual modals were not surveyed.

---

## 18. Performance Findings

| Asset | Size |
|---|---|
| `app.min.js` | **727 KB** |
| `app.js` (source, not shipped) | 1,017 KB |
| `styles.min.css` | **185 KB** |
| `assets/jsQR.min.js` | 130 KB |

- **~912 KB of parse-blocking-ish JS+CSS on first load** for a mobile-first app in South Africa.
  `defer` is used, and the launch screen renders from static HTML, which hides much of the cost —
  but on a slow connection this is the dominant first-load factor.
- **No code splitting.** jsQR (130 KB) loads for every user whether or not they ever open the
  scanner. It is the most obvious lazy-load candidate.
- **Whole-shell re-render:** every `hashchange` sets `app.innerHTML = appView()`, rebuilding the
  entire route. Route scroll position is saved and restored around it, which is thoughtful, but it
  discards all DOM state.
- **Polling:** merchant sale 2.5 s, chat 5 s, support conversation and account sync on their own
  timers. Five `setInterval` against five `clearInterval` — balanced at the source level, though I
  did not verify each is cleared on every teardown path.
- Only **3 API calls** on the unauthenticated landing, none duplicated. Good.
- The logo is preloaded with `fetchpriority="high"` and sized.

---

## 19. PWA Findings

- Manifest is complete: `id`, `start_url`, `scope`, `standalone`, `portrait`, three icons including
  a maskable 512, two shortcuts, `lang: en-ZA`, theme and background colours.
- **Cache strategy is correct:** network-first for HTML/JS/CSS/JSON, cache-first for everything else,
  and the service worker explicitly **skips `api.titopay.co.za`** so API responses are never cached.
- `skipWaiting()` + `clients.claim()` + delete-all-non-current-caches on activate → a new deployment
  takes effect promptly.
- The offline fallback chain was recently repaired; the comment documents that `||` over un-awaited
  promises meant `offline.html` had **never once been served** despite shipping. Now each is awaited.

**Two structural risks:**

1. **`cache.addAll(APP_SHELL)` is atomic.** If any one of the 15 precache URLs 404s, the install
   rejects, the service worker never activates, and the app silently loses offline support. Two
   entries are version-pinned to values that differ from the current bundle
   (`services-default.json?v=269`, `verify-email.js?v=227`), and one is a directory (`./verify-email/`)
   that depends on the host serving a directory index.
2. **The version must move in three places** (`index.html`, `service-worker.js`, `CACHE_NAME`).
   `build-pwa.sh` does this and `api/test/pwa-structure.test.js` checks it — good. But
   `styles.min.css?v=298` and `app.min.js?v=299` are already on different numbers, so a partial
   hand-edit would not be obvious.

---

## 20. Environment Findings

- `API_BASE = "https://api.titopay.co.za"` is **hardcoded** at `app.js:48`. There is no environment
  switch; sandbox testing requires patching the string (which is what this audit did, in a throwaway
  copy).
- No secrets, tokens or credentials in the client bundle.
- Origins referenced: `app.titopay.co.za`, `www.titopay.co.za`, `titopay.co.za`, `api.titopay.co.za`,
  and `wa.me` (WhatsApp deep links). All are either first-party or an outbound link target; none is a
  script source.
- **Repository hygiene:** the repo root still carries a **stale duplicate PWA** — `app.js`,
  `index.html`, `service-worker.js`, `assets/`, `services-default.json` — whose contents differ from
  `pwa/` and which has no `app.min.js`. Anyone reading the root copy is reading dead code.

---

## 21. Dependency Findings

**The PWA has zero runtime dependencies.** No `package.json`, no lockfile, no node_modules, no CDN.
For a payments front-end this is a significant and deliberate security advantage and should be
protected.

The single third-party artefact is **`assets/jsQR.min.js` (130 KB)**, vendored at a pinned copy. It
is not in any dependency manifest, so it will never appear in an `npm audit` and has no update path.
That is a trade: no supply-chain injection risk, but also no supply-chain *visibility*.

`terser` is used at build time via `npx --yes`, i.e. resolved from the network at build time rather
than pinned.

---

## 22. Testing Gaps

**Present:** 27 API test files, 19 browser E2E specs.

| Money path | Dedicated test file |
|---|---|
| Wallet | 1 (`wallet-unlock-authentication-preference`) |
| Withdrawal | 1 (`peach-withdrawal`) |
| Payout | 1 (`peach-payout-capability`) |
| Top-up | 1 (`peach-checkout-topup`) |
| Statement | 1 (`statement-financial-integrity`) |
| Authentication | 2 |
| **Transactions** | **0** |
| **Transfers** | **0** |
| **Fee preview / pricing** | **0** |
| **VAS — airtime / data / electricity** | **0** |
| **QR** | **0** |
| **Scan-to-Pay** | **0** |

The uncovered set is precisely the set the client can influence most (`serviceCode`, `amount`,
`recipient`) and includes both P0 candidates. `feePreview` — the function that decides what every
customer is charged — has no direct test.

---

## 23. Error Message Findings

### CRITICAL

**CURRENT:** `TitoPay revenue wallet is not configured`
**Raised at:** `wallet-service.js:29`, `ticketing-service.js:1101`, `enterprise-distribution-service.js:875`
**Reaches:** Email Statement, ticketing, enterprise distribution — verified end to end
**RECOMMENDED:** *"Statement request unavailable. We couldn't process your statement right now. Please try again later."*
**WHY:** names TitoPay's internal wallet architecture and a configuration state to a customer, who
can do nothing with it. The operator value is real but belongs in the log line and the `requestId`,
both of which already exist.

**CURRENT:** `Card top-up is not configured yet`
**RECOMMENDED:** *"Card top-up is unavailable right now. Please try another top-up method."*
**WHY:** same class — exposes configuration state, and offers no next step.

### GOOD (keep as they are)

- *"Check Activity before trying again — if it appears there, it went through."*
- *"This Email Statement request was already received. No duplicate fee was charged."*
- *"Incorrect OTP. 2 attempts remaining."*
- *"Too many attempts. Try again in 3 minutes."*
- *"Remove {name} from Saved Beneficiaries? No money will move and past transactions will remain in Activity."*

### The mechanism, precisely

`api/src/middleware/error-handler.js` scrubs on a regex —
`/pricing rule not found|sql|database|stack|webrtc|dtls|srtp|exception|internal server error/i`.
Anything matching becomes the generic sentence. **Every `AppError` that does not match passes through
verbatim at any status, including 500.** Non-`AppError` throws (raw driver failures, provider
errors) still fall back to the generic message — confirmed live: a dead Postgres produced
*"Unable to complete the request. Please try again."*, not the connection error.

So the boundary is *"did this codebase author the sentence"*, not *"is this sentence safe for a
customer"*. Those are different questions, and the difference is this finding.

**This behaviour is currently asserted by two passing tests** —
`error-messages.test.js:47` and `peach-checkout-topup.test.js:236` both assert the customer
receives the literal string. Any fix must update those tests, which is why this cannot be a
one-line change.

---

## 24. P0 — Critical

### P0-1 · Internal configuration and wallet architecture disclosed to customers

**Where:** `api/src/middleware/error-handler.js` (`clientSafe`), surfacing via `pwa/app.js:2415`
**Verified:** yes, end to end
**Origin:** introduced by me in commit `c2c4603` on this branch, and locked in by two tests

A customer pressing *Confirm and email* on a statement sees, verbatim:
`TitoPay revenue wallet is not configured`.

`confirmEmailStatement()` has no `try`/`catch`; the throw reaches the global click handler, which
calls `showToast(error.message, "error")`. `showToast`'s scrub list does not contain this phrase, so
it displays unchanged.

Classified P0 because the brief designates this exact string CRITICAL. The technical severity is
**information disclosure and loss of customer trust**, not loss of funds.

**Recommended change (do not apply yet):** invert the rule — a 5xx returns a customer-safe sentence
by default, and only messages explicitly marked safe at the throw site (e.g. an
`AppError(..., { publicMessage })` field) pass through. Keep the full sentence in the log against
the `requestId` that is already returned. Then update both tests to assert the new contract.

### P0-2 · Client supplies the charge amount for a fixed-price item — needs confirmation

**Where:** `pwa/app.js:8286-8296`
**Verified:** the client behaviour, yes. The exploitability, **no** — see the check below.

```js
const result = await api("/v1/transactions", {
  method: "POST",
  body: {
    serviceCode: "business_document_pdf",
    amount: DOCUMENT_PDF_FEE,          // <- a client constant, 2.5
    recipient: "TitoPay Revenue Wallet",
    metadata: { …, pdfFee: DOCUMENT_PDF_FEE }
  }
});
```

The server does `const amount = roundMoney(payload.amount)` and derives `debitTotal` from
`feePreview()`. The fee is server-priced; **the amount is not**. For a fixed-price digital good the
price should come from the service code alone.

Two further problems in the same call: it sends **no idempotency key** (unlike every other money
POST in the app), and it sets `document.pdfFeePaid = true` immediately after the call returns,
before any settlement confirmation.

**The check to run first (read-only):**

```bash
cd api && grep -n "business_document_pdf\|flatFee\|function feePreview" -A 20 src/services/pricing-service.js
```

Determine whether `feePreview` **overrides** `amount` for a flat-fee service code, or treats the
client amount as the principal and adds the flat fee on top. If the latter, a tampered client can
pay an arbitrary principal — and the two figures shown to the customer (R2.50) would not match the
debit either.

---

## 25. P1 — High

**P1-1 · Unknown routes render a blank screen.** `pwa/app.js:890-905`, `251`. Verified live for
`#stockvel`, `#send`, `#not-a-route`. No route allow-list, no fallback. Reachable from a push
notification whose `data.route` the shell does not render. *Recommended: validate `state.route`
against the five known routes in the `hashchange` handler and fall back to `dashboard`.*

**P1-2 · Hardcoded client-side fee constants can disagree with configured pricing.**
`pwa/app.js:90, 91, 96`. `EMAIL_STATEMENT_FEE = 0.1` is rendered as the price on the Activity button
(`:990`) with no server value involved. If Admin changes the configured price, the customer is
quoted the old one. *Recommended: source every displayed price from the fee preview; keep constants
only as a last-resort fallback and label them as such.*

**P1-3 · Provider-backed transactions get the 15-second default timeout.**
`pwa/app.js:19029-19036`. `PROVIDER_BACKED_PATHS` covers only top-up and withdrawals.
`/v1/transactions` — which carries VAS, transfers and QR — falls to `DEFAULT_REQUEST_TIMEOUT_MS`.
The client aborts while the provider may still be completing. The customer guidance on timeout is
correct, so this degrades experience rather than money. *Recommended: add `/v1/transactions` to the
provider-backed list.*

**P1-4 · A failed statement request permanently disables its own button.**
`pwa/app.js:8727-8742`. `button.disabled = true` with no `try`/`catch` and no re-enable. After the
P0-1 error, the customer cannot retry without closing and reopening the modal.

**P1-5 · No test coverage for transactions, transfers, fees, VAS, QR or Scan-to-Pay.** See §22. This
is what allowed P0-2 to sit unexamined.

---

## 26. P2 — Medium

**P2-1 · Client-side total fallback contradicts its own comment.** `pwa/app.js:5803`.
`Number(preview.total ?? amount + fee)` — the comment directly above states "Nothing is calculated
here that the server did not already state". If the server ever omits `total`, the displayed total
is float arithmetic that can disagree with the debit.

**P2-2 · `frame-ancestors` is delivered via `<meta>` and therefore ignored.** `pwa/index.html`.
Confirmed by browser console. Clickjacking protection depends on a response header that is not in
this repository. *Recommended: verify the Afrihost/Cloudflare response headers include
`X-Frame-Options: DENY` or a CSP header.*

**P2-3 · Access and refresh tokens in `localStorage`.** Verified. Any XSS yields a durable session.
Mitigated only by the CSP and escaping discipline.

**P2-4 · `cache.addAll` is atomic and two precache URLs are version-pinned out of step.**
`pwa/service-worker.js:2-17`. One 404 disables offline support silently.

**P2-5 · jsQR is vendored with no update path.** 130 KB, not in any manifest, invisible to `npm audit`.

**P2-6 · No code splitting.** 912 KB of JS+CSS on first load; jsQR loads for users who never scan.

**P2-7 · In-app notifications persist in `localStorage` after sign-out.** 6.7 KB on a fresh account,
keyed by user UUID.

**P2-8 · Two names for one concept in the fee-preview contract.**
`preview.recipientAmount ?? preview.netAmount`. Defensive `??` hides a contract that was never settled.

---

## 27. P3 — Low

**P3-1 · Stale duplicate PWA at the repository root.** `app.js`, `index.html`, `service-worker.js`,
`assets/` at root differ from `pwa/` and lack `app.min.js`. Dead code that reads as live.

**P3-2 · Nine residual `100vh` declarations** alongside 22 `100dvh` and 21 `100svh`.

**P3-3 · Only four `safe-area-inset` references** for an app with a fixed bottom nav on notched devices.

**P3-4 · `terser` resolved via `npx --yes` at build time** rather than pinned.

**P3-5 · `styles.min.css?v=298` and `app.min.js?v=299` are on different version numbers.** Correct
today; a trap for the next hand-edit.

**P3-6 · Timer teardown not verified.** Five `setInterval` against five `clearInterval` balances at
the source level, but not every teardown path was traced.

---

## 28. Recommended Fixes

Ordered by value, not by effort. **None of these has been applied.**

1. **Invert the 5xx disclosure rule** (P0-1). Default to a safe sentence; opt in per throw site.
   Update `error-messages.test.js` and `peach-checkout-topup.test.js` to assert the new contract.
2. **Run the P0-2 check**, then make fixed-price charges server-derived from the service code, add
   an idempotency key to the document-PDF call, and stop setting `pdfFeePaid` before confirmation.
3. **Add a route allow-list** with a `dashboard` fallback (P1-1). Roughly a three-line change in the
   `hashchange` handler, and the highest UX return in this report.
4. **Source displayed prices from the fee preview** (P1-2).
5. **Add `/v1/transactions` to `PROVIDER_BACKED_PATHS`** (P1-3).
6. **Wrap `confirmEmailStatement` and re-enable its button on failure** (P1-4).
7. **Write the missing test files** — transactions, transfers, fee preview, VAS, QR, Scan-to-Pay (P1-5).
8. **Verify frame-busting response headers** at the host (P2-2).
9. **Make the service worker install resilient** — precache individually and tolerate a miss (P2-4).
10. **Lazy-load jsQR** on first scanner open (P2-6).
11. **Clear per-user `localStorage` on sign-out** (P2-7).
12. **Delete the stale root PWA duplicate** (P3-1) — after confirming nothing serves from it.

---

## 29. Recommended Testing

**Production-critical matrix.** Rows are flows; columns are Happy · Failure · Network loss ·
Duplicate tap · API error · Flow-specific. Current automated coverage in brackets.

| Flow | Happy | Failure | Net loss | Dup tap | API err | Specific | Covered? |
|---|---|---|---|---|---|---|---|
| Login | ☐ | ☐ | ☐ | ☐ | ☐ | lockout | partial (2 files) |
| Wallet | ☐ | ☐ | ☐ | — | ☐ | inconsistency | partial |
| Transfer | ☐ | ☐ | ☐ | ☐ | ☐ | insufficient balance | **none** |
| Withdrawal | ☐ | ☐ | ☐ | ☐ | ☐ | reversal | partial |
| QR payment | ☐ | ☐ | ☐ | ☐ | ☐ | pending | **none** |
| Scan-to-Pay | ☐ | ☐ | ☐ | ☐ | ☐ | pending | **none** |
| Airtime | ☐ | ☐ | ☐ | ☐ | ☐ | — | **none** |
| Data | ☐ | ☐ | ☐ | ☐ | ☐ | — | **none** |
| Electricity | ☐ | ☐ | ☐ | ☐ | ☐ | token delivery | **none** |
| Statement | ☐ | ☐ | ☐ | ☐ | ☐ | fee failure | partial |
| Gift | ☐ | ☐ | ☐ | ☐ | ☐ | — | **none** |
| Stockvel | ☐ | ☐ | ☐ | ☐ | ☐ | — | **none** |

**Highest-value tests to write first**

1. `feePreview` unit tests per service code — flat, percentage, capped, and the zero case.
2. A duplicate-tap test per money flow that asserts **one** wallet movement (the advisory lock is
   good; nothing currently proves it stays good).
3. An error-contract test asserting no 5xx body contains `revenue wallet`, `not configured`,
   `pricing rule`, or an internal service name.
4. A route test asserting every hash renders **something**.

**Safari/iOS — must be done on real hardware.** The wobble, shake and movement symptoms in the brief
cannot be reproduced in headless Chromium regardless of user agent. Options: a physical iPhone with
Safari Web Inspector, a WebKit runner (`playwright.webkit`), or BrowserStack. Prioritise Services,
Send Gift and Stockvel at 390×844 and 430×932, with the keyboard open and closed.

---

## 30. Production Deployment Risks

1. **A stale service worker serves the previous bundle.** Mitigated by `skipWaiting` +
   `clients.claim` + the three-place version bump, and tested — but a hand-edit that moves one of
   the three breaks it silently.
2. **A precache 404 disables offline support** with no visible symptom (P2-4).
3. **Migrations not applied before the API restarts.** `DEPLOY.md` already flags this as the step
   that previously broke Marketing; it applies to any release adding tables.
4. **The email worker is a separate process.** If it does not come back, queued statement email
   accumulates silently — `/v1/health` reports `emailWorker` for exactly this reason.
5. **`API_BASE` is hardcoded**, so a wrong-environment build is a code edit, not a config error —
   harder to make by accident, but also impossible to correct without a redeploy.
6. **No rollback concern for the front-end** — static files, previous zip extracts over the top.

---

## 31. Safe-to-Modify Analysis

### Safe to fix independently — front-end only, no backend coordination

- **P1-1** route allow-list — pure client logic, three lines
- **P1-4** statement button re-enable — pure client logic
- **P2-1** remove the `?? amount + fee` fallback (show a dash if the server omits `total`)
- **P2-6** lazy-load jsQR
- **P2-7** clear per-user storage on sign-out
- **P3-2, P3-3** residual `100vh` → `100dvh`; add safe-area padding
- **P3-5** align the asset version numbers

Each still requires `build-pwa.sh`, the three-place version bump, and a re-zip.

### Requires backend changes

- **P0-1** error-handler contract + two test files
- **P0-2** server-derived pricing for fixed-price service codes
- **P1-2** exposing configured prices through the preview for display
- **P2-8** settling one name for the recipient-amount field

### Requires database changes

None identified.

### Requires payment-provider coordination

None. **Do not touch** `peach-payout-service.js`, `peach-checkout-service.js`,
`peach-withdrawal-service.js` or any Peach configuration as part of remediating this report — no
finding here requires it.

### Requires production configuration / hosting

- **P2-2** frame-busting response headers (Afrihost/cPanel or Cloudflare)
- Confirming the SMTP/email worker supervision that `/v1/health` reports on

### Should NOT be touched

- The **advisory-lock idempotency guard** in `createTransaction` — it is correct, and it is what
  stands between a double tap and a double charge.
- The **server-side fee schedule** in `pricing-service.js` — prices are a business decision.
- The **two order-sensitive blocks** in `app.js` and `admin.js` — the structure tests exist because
  this convention has decayed before.
- The **strict CSP** and the no-external-scripts posture.
- The **session-refresh-outside-the-network-try** arrangement — it fixes a real mislabelling bug.
- **Anything in the Peach integration.**

### Test in sandbox first

Everything under P0 and P1. In particular P0-1 changes what every 5xx in the system says, which
touches far more than statements.

### Requires production deployment

All PWA changes (rebuild `app.min.js`, bump the version triple, re-zip, extract).
All API changes (upload, `npm install --omit=dev`, migrations, restart, `/v1/health` check).

### Rollback planning

- Front-end: keep the previous `app.zip`; extraction over the top is the rollback.
- API: `DEPLOY.md` §4 already documents the tar-backup-and-restore procedure.
- **P0-1 specifically** should ship on its own, not bundled with feature work, because it alters
  every 5xx message in the platform and a regression would be diffuse and hard to attribute.

---

## 32. Final Summary

### OVERALL TITOPAY PWA STATUS

**Needs Important Fixes Before Production**

Not "high risk" — the two mechanisms most likely to lose money (server-side fee authority and
advisory-lock idempotency) are correctly built, and the client-side security posture is genuinely
strong. Not "minor issues" either — one confirmed disclosure regression, one unverified
client-controlled-amount path, and blank screens on unknown routes are each enough to hold a release.

### Counts

| | Count |
|---|---|
| 🔴 **P0** | **2** |
| 🟠 **P1** | **5** |
| 🟡 **P2** | **8** |
| 🔵 **P3** | **6** |
| **Total** | **21** |

### TOP 10 RISKS

1. Internal configuration and wallet architecture shown verbatim to customers, and **asserted by
   two passing tests** — so the safety net currently protects the wrong behaviour *(P0-1)*
2. The client names the charge amount for a fixed-price item, with no idempotency key on that call
   *(P0-2)*
3. `pdfFeePaid` is set to true before settlement is confirmed *(P0-2)*
4. Any unrecognised URL fragment renders a blank app, reachable from a push notification *(P1-1)*
5. Zero automated coverage of transactions, transfers, fee preview, VAS, QR and Scan-to-Pay *(P1-5)*
6. Displayed prices come from hardcoded client constants and can drift from configured pricing *(P1-2)*
7. Provider-backed VAS and transfers abort at 15 s, leaving genuinely unconfirmed states *(P1-3)*
8. Access **and** refresh tokens in `localStorage`, with CSP as the only line of defence *(P2-3)*
9. Clickjacking protection relies on a header not present in this repository *(P2-2)*
10. One 404 in the precache list silently disables offline support entirely *(P2-4)*

### TOP 10 RECOMMENDED IMPROVEMENTS

1. Invert the 5xx rule to safe-by-default, opt-in per throw site — and update the two tests
2. Derive fixed-price charges from the service code server-side; add the missing idempotency key
3. Add a five-route allow-list with a `dashboard` fallback
4. Write the missing money-path tests, starting with `feePreview` and duplicate-tap
5. Source every displayed price from the fee preview
6. Add `/v1/transactions` to `PROVIDER_BACKED_PATHS`
7. Add an error-contract test that fails if any 5xx body names an internal component
8. Make the service worker install tolerate a single precache miss
9. Lazy-load jsQR; it is 130 KB most users never need
10. Run the Safari/iOS pass on real hardware — the reported wobble and shake symptoms remain
    unreproduced and therefore unexplained

---

### Confidence and limits

**Verified live:** dead routes, touch targets, accessibility on the landing and shell, horizontal
overflow, console errors, storage contents, landing API call count, and the error handler's
behaviour on a real driver failure.

**Verified by reading only:** fee authority, idempotency, the pricing schedule, timeout policy, the
service worker, CSP, and the escaping discipline.

**Not verified — and named as such rather than assumed:**
- whether `feePreview` overrides a client-supplied amount for flat-fee service codes (**P0-2**)
- the Safari-specific movement symptoms in the brief, which need real WebKit
- per-modal accessibility and empty/error states beyond the five top-level routes
- production response headers
- every `clearInterval` teardown path

**One measurement retracted:** an earlier bottom-nav overlap count of five elements was invalid —
the programmatic scroll never reached the bottom, so it sampled content passing under a fixed bar
mid-scroll. `main.screen` has 104 px of bottom padding against an 80 px nav. No overlap is reported.
