# Peach card transaction "Transaction not confirmed" — root cause and fix

## Symptom

A card/Peach transaction in the PWA showed **"Transaction not confirmed"** and
**"Unable to complete the request. Please try again."**

## Root cause

**No Peach payment was ever attempted.** The PWA's Top Up screen submitted through the generic
wallet-**debit** transaction endpoint, which refuses top-ups by design, and the refusal reason was
then overwritten by a generic error before it reached the customer.

The chain, exactly:

1. `openTopUpModal` submits `serviceCode: "wallet_top_up"` through the shared `data-form="transaction"`
   handler (`app.js`), which posts to `POST /v1/transactions`.
2. `createTransaction` calls `assertLiveTransactionSupported`, and `wallet_top_up` is listed in
   `PROVIDER_DEPENDENT_SERVICES`, so it throws
   `AppError(503, "Wallet top up is not enabled for live processing yet. No wallet debit was made.")`.
3. `errorHandler` replaced every message at status ≥ 500:
   `const publicMessage = status >= 500 ? "Unable to complete the request. Please try again." : message;`
   The deliberate explanation never left the server.
4. The PWA's `api()` throws, `confirmReviewedTransaction` catches, and
   `openTransactionFailureModal` renders "Transaction not confirmed".

The 503 was correct: a top-up is a wallet **credit** funded by a card, so it can never run through
a function whose first act is to debit the wallet (a new customer with a R0 balance would have hit
"Insufficient balance" even if it had been allowed). What was missing was the Peach Checkout flow
to send it to instead.

`POST /v1/payments/topup` did exist, but it was unusable: gated behind `PEACH_PAYMENTS_V2_ENABLED`
(off), it required a pre-tokenised card, and it called the **Peach Payments API** (`api-key`
header) rather than **Checkout V2** — a different product from the one whose credentials the Admin
Portal holds. The PWA never called it.

### Two further defects on the same path

**The webhook rejected every genuine Peach Checkout notification.**
`validatePeachV2Payload` read the merchant identifier from `["merchantId", "merchant_id", "merchant.name", "merchant"]`
and compared the result to the configured **Merchant ID**. Peach Checkout webhooks carry
`merchant.name` — the merchant's *display name*, not the ID — so the comparison always failed with
HTTP 400. Peach then retried for 30 days and the wallet was never credited. With
`PEACH_PAYMENTS_V2_ENABLED` off, the payload took the legacy validator instead, which requires an
`entityId` that Checkout webhooks never send: also HTTP 400. Both paths failed closed.

**A fee preview wrote bad pricing to the database.** The service catalogue publishes the code
`payouts`, which had no pricing rule, so the first preview inserted a persistent zero-fee `payouts`
row into `pricing_rules` — a read path silently writing config. `payouts` was also absent from
`PROVIDER_DEPENDENT_SERVICES`, so it was blocked only by an accidental catch-all.

## Where the lifecycle was failing

At the very first step. Nothing downstream — no Peach checkout, no callback, no webhook, no status
verification, no wallet credit — was ever reached.

## The fix

Card top-ups now run the documented Peach Checkout V2 lifecycle:

```
PWA   -> POST /v1/payments/topup          create checkout, return redirectUrl
user  -> pays on Peach
Peach -> POST /v1/payments/topup/return   browser redirect (POST), 303 back to the PWA
Peach -> POST /v1/webhooks/provider       server-to-server notification (unchanged endpoint)
PWA   -> GET  /v1/payments/topup/:ref     poll until terminal
```

`POST {checkout}/v2/checkout` is sent with the Bearer token from the existing, working
Checkout authentication, and the documented required fields: `authentication.entityId`,
`merchantTransactionId`, `amount`, `currency`, `nonce`, `shopperResultUrl` (plus `notificationUrl`
pointing at the existing TitoPay webhook).

### Wallet safety

The wallet is credited in exactly one function, `settleTopupTransaction`, and only after this
server has called `GET {checkout}/v2/checkout/{checkoutId}/status` itself. A browser redirect, a
success URL, a frontend claim, or a webhook body is never sufficient — **the webhook is treated as
a hint and triggers a fresh status read before any money moves**. The reported amount is compared
to the amount TitoPay created; a mismatch is held for review rather than credited.

### Idempotency

- `transactions.reference` is the `merchantTransactionId` and is `UNIQUE`.
- A repeated create with the same idempotency key returns the original checkout.
- Settlement takes `SELECT … FOR UPDATE` on the transaction row, so concurrent webhooks, polls and
  browser returns serialise. The first credits; the rest observe a terminal status and no-op.
- A second guard checks for an existing `wallet_ledger` credit row for the transaction.
- Webhook deliveries are also deduplicated by webhook ID in `platform_settings`.

### Status handling

| Peach result code | State | Transaction status |
| :-- | :-- | :-- |
| `000.000.*`, `000.100.1*`, `000.300.*`, `000.600.*` | successful | `completed` (credits) |
| `000.200.*` | pending | `pending` |
| `100.396.104/103/106` (uncertain) | pending | `pending` |
| `000.400.0xx`, `000.400.100`, `800.400.5*` | review | `processing` (never auto-credited) |
| `100.396.101` | cancelled | `cancelled` |
| anything else | failed | `failed` |

An uncertain or pending payment is never turned into a failure, so a customer is never told to
retry a payment that may still complete.

## Withdraw and payout — read this

**They remain blocked, deliberately.** There is no payout provider integrated anywhere in the API:
no withdraw or payout route, no disbursement code, and no Peach payout call. Peach Checkout V2 is a
*pay-in* product and cannot send money out; Peach's Payouts API is a separate product with its own
onboarding and credentials.

Enabling them would debit a customer's wallet with nothing on the other side to move the money —
the one change that could actually lose funds. What was fixed instead is the honesty of the flow:

- The refusal now reaches the customer verbatim: *"Withdraw is not enabled for live processing yet.
  No wallet debit was made."*
- The block is applied at **fee preview**, so a customer is told up front instead of after seeing a
  fee and pressing Confirm.
- `payouts` is blocked deliberately and no longer writes a zero-fee pricing rule.

To make them work, Peach Payouts (or another payout provider) has to be onboarded and integrated.

## Files changed

**API**

| File | Change |
| :-- | :-- |
| `src/services/peach-checkout-service.js` | **New.** Full Checkout V2 top-up lifecycle and the single credit point. |
| `src/services/peach-config-service.js` | **New.** Shared loader/decryptor for the stored Peach configuration. |
| `src/routes/payment-return.routes.js` | **New.** Public POST target for Peach's browser redirect. |
| `src/routes/payments.routes.js` | Top-up create/status on Checkout V2; legacy Payments API actions moved to `/legacy-topup/*`, unchanged. |
| `src/routes/integrations.routes.js` | Webhook accepts real Checkout payloads; settles top-ups; no `merchant.name` vs Merchant ID comparison. |
| `src/services/transaction-service.js` | Card top-ups routed to the card flow (409 + `USE_CARD_TOPUP_FLOW`); `payouts` blocked deliberately; preview blocks unlaunched services. |
| `src/middleware/error-handler.js` | Deliberate 502/503/504 `AppError` messages reach the customer; details still withheld for 5xx. |
| `src/middleware/security.js` | Form-urlencoded allowed on the Peach return path. |
| `src/app.js` | Mounts the public return route. |
| `src/services/peach-payments-service.js` | Network errors no longer echo a raw fetch message. |
| `test/peach-checkout-topup.test.js` | **New.** 20 tests. |

**PWA**

| File | Change |
| :-- | :-- |
| `app.js` / `app.min.js` | Card top-up calls the top-up endpoint, redirects to Peach, resumes on return, polls, and shows pending/success/failure. |
| `index.html`, `service-worker.js` | Cache-buster `v=273` → `v=274` so the new bundle is actually served. |
| `DEPLOYMENT_BUILD_MARKER.txt` | Build marker. |

## Database changes

**None.** No migration, no schema change. Existing tables and columns only.

## Webhook changes

The endpoint `https://api.titopay.co.za/v1/webhooks/provider` is **unchanged**, as is its
HMAC-SHA256 verification (`{timestamp}.{webhookId}.{url}.{rawBody}`). Only the payload validation
was corrected to match what Peach Checkout actually sends. Deliveries that carry an `entityId` still
take the previous strict path, so any existing integration is unaffected.

## Environment variables

**None required.** Optional overrides:

```dotenv
APP_BASE_URL=https://app.titopay.co.za      # where customers are returned after paying
PEACH_TOPUP_MIN_AMOUNT=5
PEACH_TOPUP_MAX_AMOUNT=50000
```

`APP_BASE_URL` defaults to `https://app.titopay.co.za`. Set it if the PWA is served elsewhere.

Peach Dashboard: the domain running Checkout must be **allowlisted**, and `entityId` must be filled
in under Admin → Integrations → Peach Payments (it is required by Checkout and may be blank).
