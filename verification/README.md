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
