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
