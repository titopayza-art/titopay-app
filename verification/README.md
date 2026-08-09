# Peach top-up verification harnesses

These are **not** part of the API or PWA deployment. They are the harnesses used to prove the
Peach Checkout top-up lifecycle locally, kept so the evidence is reproducible.

| File | What it does |
| :-- | :-- |
| `fake-peach.js` | Stand-in for the Peach sandbox: Authentication API, Checkout V2, a hosted payment page, and signed form-urlencoded webhooks. Payload shapes match the live sandbox and the published docs. |
| `topup-e2e.js` | 32 checks over the whole lifecycle: create, idempotent replay, pending, verified success, duplicate webhooks/polls/returns, decline, cancellation, forged webhook, Activity. |
| `race-e2e.js` | Fires 6 status polls + 4 webhooks + 3 browser returns simultaneously at one paid checkout and asserts a single wallet credit. |
| `pwa-topup.spec.js` | Drives the real `app.min.js` bundle through a complete top-up in Chromium, including the Peach redirect and the POST return. |

## Running them

Needs a local Postgres with the API schema, the API running against `fake-peach.js`, and Peach
configured in the Admin Portal with the mock's entity ID (`GET http://127.0.0.1:4400/__entity`).

```bash
node fake-peach.js &                                   # port 4400
# start the API with:
#   PEACH_PAYMENTS_SANDBOX_AUTH_URL=http://127.0.0.1:4400
#   PEACH_PAYMENTS_SANDBOX_CHECKOUT_URL=http://127.0.0.1:4400
#   APP_BASE_URL=http://127.0.0.1:8010
node topup-e2e.js
node race-e2e.js
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pwa-topup.spec.js
```

`PEACH_PAYMENTS_SANDBOX_CHECKOUT_URL` / `PEACH_PAYMENTS_PRODUCTION_CHECKOUT_URL` exist so the
Checkout host can be pointed at a mock; unset, the real Peach hosts are used.

## Peach capability split

| File | What it does |
| :-- | :-- |
| `fake-peach-payouts.js` | Stand-in for the Peach Payouts API: OAuth token, `GET /merchants/{id}/balance`, `POST /merchants/{id}/payouts`. Documented shapes only. |
| `split-e2e.js` | 34 checks that Collection and Payout are independent: separate credentials, separate stored rows, separate tests, separate statuses, and that saving one never overwrites the other. |
| `admin-split.spec.js` | Drives the real Admin bundle in Chromium: two capability sections, two forms, two Test Connection buttons, and Collection Connected while Payout reads Not Configured. |

Payout authentication uses the Peach *dashboard* host, not the payouts host, so a local run needs
`PEACH_PAYOUTS_SANDBOX_AUTH_URL=http://127.0.0.1:4401` alongside the payouts base URL.

## Coverage harnesses

These two exist because the file-level structure work — grouping `app.js`, `admin.js`,
`admin-analytics.js` and `admin-service-builder.js` into named sections — can only be proven safe
by running the code, not by reading it. A hoisting mistake surfaces as a `ReferenceError` the
moment a code path executes, and only then.

| File | What it does |
| :-- | :-- |
| `pwa-journeys.spec.js` | Walks **every** service journey in the customer app on both a personal and a business account: opens each one, types a plausible value into every field it exposes, and advances as far as the review step. 84 journeys, 96 checks. It never presses Pay, Confirm, Send, Withdraw or Buy, and asserts both wallet balances are unchanged at the end, so a journey that settles something behind its back fails the run. |
| `wallet-lock-semantics.js` | What a locked wallet may and may not do, against the real API and ledger: transfers, airtime, electricity, bill payments, withdrawals and the owner's own card top-up are all refused with 423 and move no money; another customer can still pay in and the balance goes up; unlocking restores sending; every wallet still reconciles against its own ledger afterwards. 21 checks. |
| `pwa-wallet-lock.spec.js` | The same two Profile journeys a customer uses, driven in Chromium against the shipped bundle: choosing the OTP method (Email or SMS), then Lock Wallet → confirm → the row becoming Unlock Wallet → the OTP screen. Also asserts the customer app never says "freeze" — that is the admin portal's separate action. 10 checks. |
| `admin-modules.spec.js` | Drives the two lazily imported Admin modules: all eight analytics tabs, all eight range presets, the XLSX and CSV exports, all ten Service Builder wizard steps and the detail view. It also asserts `admin.js` and both modules are fetched at one build stamp — they had drifted, and pages served at v73 were still fetching modules at `?v=admin-console-v63`. |

```bash
# Needs the API, the PWA on :8010 and the Admin console on :8020.
# The Admin console pins connect-src to api.titopay.co.za, so a local run needs
# a copy of the console whose CSP also allows the sandbox API origin.
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pwa-journeys.spec.js
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node admin-modules.spec.js
```

`pwa-journeys.spec.js` bridges `https://api.titopay.co.za` to the local API with a Playwright
route, because the shipped bundle hard-codes its API base to production.

## Event Tags

Cashless NFC/RFID credentials for events. The claim every one of these exists to
test is a single sentence: **an Event Tag is a credential, not a wallet.**

| File | What it does |
| :-- | :-- |
| `event-tag-e2e.js` | The whole journey and the whole refusal matrix, against a real Postgres, the real API and the real POS HMAC signing stack: create event → approve → enable cashless → authorise a vendor → sell a ticket → issue blank tags → assign → tap → block → replace → the replacement pays from the same wallet. Then it tries to break the claim: it looks for a balance column in every tag table, a second ledger anywhere in the database, and an extra wallet on the attendee; it repeats a tap, reuses an idempotency key for a different amount, and fires four terminals at one wristband for more than the balance; and it checks every refusal — a live funded tag from another event, a suspended event, an unauthorised vendor, an unassigned tag, a forged credential, an unsigned request, a replayed nonce, a locked wallet, another customer's tag, anonymous access. 82 checks. |
| `event-tag-consoles.spec.js` | The organiser's console in the PWA and the admin's in the operations console, both driven in Chromium: switch cashless on, authorise a vendor, mint blank credentials and read them off the screen once, assign one, then block it from Admin and read its audit trail. Asserts the credentials never reappear after the one-time reveal, that no screen anywhere shows a balance, and that blocking moves R0.00. 29 checks. |
| `pwa-event-tags.spec.js` | What the attendee sees. The tag card shows a status and an event and **no balance**; Top Up is the app's own wallet button (`data-service="top-up"`), not an event top-up; reporting the tag lost asks first, says the money stays in the wallet, and moves nothing. 25 checks. |
| `../api/test/event-tag-structure.test.js` | The static guards, so a later change cannot quietly undo the rule: no balance-like column in any tag table, no second wallet or ledger, every migration additive and `IF NOT EXISTS`, cashless off by default, only hashes stored, `publicTag` leaking neither credential nor holder, zero logging calls in the tag path, the charge resolving everything server-side, exactly one debit and one credit, `pos/service.js` untouched, and `event_tags` granted to three roles rather than everyone. 14 checks. |

## Screen layout

| File | What it does |
| :-- | :-- |
| `pwa-money-screens.spec.js` | The redesigned Top Up / Send Money screens are presentation only, and this follows the money to prove it: drives the keypad, checks grouping and the two-decimal limit, then submits — the fee on the review screen matches the API's fee to the cent, nothing is charged at review, and confirming really moves the money (R800 → R650 out, R150 in). 23 checks. |
| `service-screens-full-bleed.js` | Opens every service screen at iPhone 15 Pro size and **measures** the modal card — position, size and corner radius — rather than eyeballing a screenshot. 18 screens; Transactions and Profile & Security are excluded because they navigate to full pages rather than opening a modal. |

```bash
# All of these bridge https://api.titopay.co.za to the local API with a
# Playwright route, and all of them wait out the API's 120-request-per-minute
# rate limit rather than failing on it.
node event-tag-e2e.js
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node event-tag-consoles.spec.js
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pwa-event-tags.spec.js
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node pwa-money-screens.spec.js
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node service-screens-full-bleed.js
```

**Run them one at a time.** The API rate-limits per client IP and several of these
spend most of a window on their own; back to back they starve each other, and the
symptom is a first-step failure ("customer created FAIL", "admin signed in FAIL")
that looks like a product break and is not.

`split-e2e.js` scores 34/34 alone and 31/34 when it follows `withdrawal-e2e.js` —
a long-standing ordering dependency between those two harnesses, since split
configures the payout capability withdrawal consumes.
