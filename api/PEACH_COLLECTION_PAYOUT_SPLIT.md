# Peach Payments — Collection / Top-up and Payout / Withdrawal split

Peach Payments is now two independent capabilities under one provider, each with its own base URL,
credentials, encryption, connection test and status.

```
PEACH PAYMENTS
 ├── COLLECTION / TOP-UP   (money in)   platform_settings: integration_peach_payments
 │    checkout  https://testsecure.peachpayments.com  (v2/checkout)
 │    auth      https://sandbox-dashboard.peachpayments.com/api/oauth/token
 │    test      real Checkout authentication — unchanged
 │
 └── PAYOUT / WITHDRAWAL   (money out)  platform_settings: integration_peach_payouts
      payouts   https://sandbox-payouts.peachpayments.com/api   (configurable)
      auth      https://sandbox-dashboard.peachpayments.com/api/oauth/token
      test      GET /merchants/{merchantId}/balance
```

## How the existing Collection configuration is stored (and preserved)

Collection lives in `platform_settings` under `integration_peach_payments`, with secrets encrypted
at rest as `secrets.<field>Encrypted` (AES-256-GCM, key derived from the API's refresh secret).
**Not one byte of that row, its schema, its encryption or its Checkout code path was changed.**

Payout was given a **new, separate row**, `integration_peach_payouts`. Because they are different
rows behind different provider keys, saving one physically cannot touch the other.

## Payout endpoints — from the documentation, not invented

Source: <https://developer.peachpayments.com/docs/payouts-api-1>

| Service | Live | Sandbox |
| :-- | :-- | :-- |
| Authentication | `https://dashboard.peachpayments.com` | `https://sandbox-dashboard.peachpayments.com` |
| Payouts | `https://payouts.peachpayments.com/api` | `https://sandbox-payouts.peachpayments.com/api` |

```
POST {auth}/api/oauth/token          { clientId, clientSecret, merchantId } -> access_token
GET  {payouts}/merchants/{merchantId}/balance                    connection test (read-only)
POST {payouts}/merchants/{merchantId}/payouts                    create payout request
GET  {payouts}/merchants/{merchantId}/payouts/{id}/status        query payout request
```

Authorisation is `Authorization: Bearer <JWT>`. Payout credentials are created separately in the
Peach Dashboard under **Payouts → Settings**, and are *not* the Checkout credentials.

The payout base URL is a configurable Admin field. The documented sandbox URL is offered only as a
placeholder — a saved value always wins, and nothing is auto-saved. With no URL configured the
capability reports **"Payout endpoint not configured"**.

## Connection tests

**Collection** — unchanged. Real Checkout authentication; `connected` only when Peach issues an
access token.

**Payout** — authenticates with the **payout** credentials against the **payout** endpoint and reads
the merchant balance. It never attempts Checkout authentication as a substitute, and Collection
being connected can never make Payout report connected. Incomplete configuration returns
`PAYOUT_NOT_CONFIGURED` without any network call.

| `errorCode` | Meaning |
| :-- | :-- |
| `PAYOUT_NOT_CONFIGURED` | No endpoint and/or credentials |
| `PAYOUT_AUTHENTICATION_REJECTED` | Peach refused the payout credentials (400 invalid-credential, 401, 403) |
| `PAYOUT_ENDPOINT_NOT_FOUND` | 404 — check the payout base URL and merchant ID |
| `PAYOUT_PROVIDER_UNAVAILABLE` / `PAYOUT_RATE_LIMITED` | 5xx / 429 |
| `PAYOUT_NETWORK_TIMEOUT` / `PAYOUT_NETWORK_ERROR` | Peach unreachable |

## Withdrawal safety

Withdrawals are **not activated** by the existence of the Admin form. `payoutAvailability()` requires
all four of: endpoint configured, credentials configured, capability enabled, and a connection test
that has actually succeeded. Anything less throws with a message that says no wallet debit was made.

Withdrawal *processing* remains switched off in `transaction-service.js`, exactly as before. The
payout service provides the documented create/query calls and the availability gate, ready to be
wired once Peach payout credentials exist and the connection test passes. A payout is never marked
successful merely because TitoPay submitted it — `queryPayoutRequest` exists for provider
confirmation.

`createPayoutRequest` builds only the documented fields (`currency`, `amount`, `accountNumber`,
`branchCode`, `reference`, `bankName`, `accountHolder`, `payoutMethod`, plus optional `payoutId` and
`merchantReference`) and refuses an incomplete entry before it reaches Peach. `payoutId` /
`merchantReference` carry TitoPay's own reference for idempotency.

## Credential security

- Two separate encrypted rows; neither can overwrite the other.
- Payout has **no environment-variable fallback that could borrow Collection credentials** — its
  loader never reads the Collection row or `config.integrations.peachPayments`.
- Payout access tokens live in their own cache keyed by the payout credentials, so a Collection
  token can never satisfy a payout call.
- Secrets are never returned to the browser; existing saved secrets keep showing as `••••` + last 4.
- Logs carry environment, endpoint, HTTP status, duration and last-4 identifiers only, and any
  provider text is scrubbed of credential values first.
- No credentials were rotated.

## Files changed

**API**

| File | Change |
| :-- | :-- |
| `src/services/peach-payout-service.js` | **New.** Payout authentication, connection test, create/query, availability gate. |
| `src/services/peach-config-service.js` | Adds `loadPeachPayoutConfig()` reading the separate row. Collection loader untouched. |
| `src/routes/admin.routes.js` | Registers the `peach_payouts` provider; routes its test; exposes capability metadata; keeps `not_configured` distinct from `failed`. |
| `test/peach-payout-capability.test.js` | **New.** 16 tests. |

**Admin Portal**

| File | Change |
| :-- | :-- |
| `assets/admin.js` | Provider page renders both capabilities; every capability form binds its own submit handler and posts to its own key; capability status strip; parent "Partially configured"; `Not Configured` vs `Not Tested`. |
| `admin-version.txt`, `DEPLOYMENT_BUILD_MARKER.txt`, all pages | `admin-console-v63` → `v64` cache-buster. |

## Database changes

**No migration and no schema change.** `platform_settings` is an existing key/value table; the payout
capability simply adds a new row the first time it is saved. Backward compatible in both directions:
the API works with the row absent (payout reads Not Configured), and the previous API build ignores
the extra row entirely.

## Environment variables

None required. Optional, for installations that prefer process configuration:

```dotenv
PEACH_PAYOUTS_MODE=sandbox
PEACH_PAYOUTS_BASE_URL=https://sandbox-payouts.peachpayments.com/api
PEACH_PAYOUTS_CLIENT_ID=...
PEACH_PAYOUTS_CLIENT_SECRET=...
PEACH_PAYOUTS_MERCHANT_ID=...
```

`PEACH_PAYOUTS_SANDBOX_AUTH_URL` / `PEACH_PAYOUTS_PRODUCTION_AUTH_URL` exist only to point the payout
auth host elsewhere for testing.

## Deployment

1. Deploy `api.zip` and restart the API (`pm2 restart titopay-api --update-env`).
2. Deploy `admin.zip`. Hard-refresh the console once — the asset version moved to `v64`.
3. Admin → Integrations → Peach Payments. Collection should still read **Connected**; press its Test
   Connection to confirm.
4. Payout reads **Not Configured** until Peach payout credentials are created in the Peach Dashboard
   (Payouts → Settings). Enter the payout base URL, Client ID, Client Secret and Merchant ID, save,
   then press Test Connection.
