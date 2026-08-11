# Hiding technical payment errors from customers

## What a customer saw before

```
Transaction not confirmed
Card top-ups are temporarily unavailable …
/v1/payments/topup · HTTP 503 · PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED · ref 931c5e06
```

The endpoint, the HTTP status, an internal code and a request id — all rendered
into the modal. That line existed to make screenshots diagnosable. It is now
gone from the customer UI, and the detail lives where it belongs.

## Centralised mapping

One table decides what a customer is told. Every payment surface goes through
it, so a technical string cannot reach a customer by being forgotten at a call
site.

`app.js` → `PAYMENT_ERROR_MESSAGES` (code → sentence) and
`paymentErrorMessage(error)`.

| Cause | Customer sees |
| --- | --- |
| `PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED` | Card top-ups are temporarily unavailable. Please try again later. |
| `PROVIDER_UNAVAILABLE`, `NETWORK_ERROR`, `NETWORK_TIMEOUT` | Card top-ups are temporarily unavailable. Please try again shortly. |
| session expired / refresh failed / 401 / 403 | Your session has expired. Please sign in again. |
| `INSUFFICIENT_BALANCE` | You don't have enough available balance to complete this transaction. |
| declined by the card issuer | Your payment could not be approved. Please try another payment method. |
| `PAYOUT_*`, `BANK_ACCOUNT_NOT_FOUND` | plain-language withdrawal equivalents |
| timeout | This is taking longer than usual. Check Activity before trying again … |
| **anything unrecognised** | **We couldn't complete this transaction. Please try again later.** |

The last row is the important one. The mapping is **allowlist-shaped**: a failure
is recognised by its CODE and answered with a sentence written here. An
unrecognised failure falls back to the safe sentence rather than to whatever
text arrived — so a database error, a stack trace, an internal route or a
provider message cannot be rendered even if one appeared in a response.

## The modal

```
Transaction not confirmed

Card top-ups are temporarily unavailable. Please try again later.

Nothing was charged and your wallet is unchanged. Check Activity before trying
again — if the transaction appears there, it was received by TitoPay and you
should not submit it a second time.

[ Check Activity ]  [ Contact support ]  [ Close ]
```

No endpoint, no status, no code, no request id, no provider name, no stack, no
infrastructure detail. The three actions are unchanged.

Provider names were also removed from **failure** text ("Peach Payments declined
this card payment" → "Your payment could not be approved…"). They remain where
they reassure — naming the payment processor immediately before redirecting to
its page is appropriate and expected.

## Diagnostics are NOT weakened

| Where | What is retained |
| --- | --- |
| **Server log** | `PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED`, Peach's own wording, `httpStatus: 400`, `path: /v2/checkout`, `domainSent`, environment |
| **Transaction record** | `metadata.failureReason`, `providerState`, `provider`, `resultCode`, `payoutStatus`, `requiresReview` |
| **Admin Portal** | `GET /v1/admin/transactions` now projects `failure_reason`, `provider`, `provider_state`, `provider_result_code`, `payout_status`, `requires_review` |
| **API response** | `details.code` only — the PWA needs it to map, and it is never rendered |

The API's own customer-facing sentence was aligned to the specified wording, so
the API and the PWA say the same thing.

## Files changed

**PWA** — `app/app.js`, `app/app.min.js` (rebuilt), `index.html`,
`service-worker.js` (cache **v281 → v282**)

* added `PAYMENT_ERROR_MESSAGES` + `paymentErrorMessage()`
* `openTransactionFailureModal` maps internally and renders no technical line
* removed `failureDiagnostic()` and the `data-failure-diagnostic` element
* payment call sites pass the error, not a pre-formatted string
* provider names removed from failure copy

**API** — `src/services/peach-checkout-service.js` (message wording only),
`src/services/transaction-service.js` (admin projection gains the payment
diagnostic columns)

`friendlyFormError` is untouched and still serves non-payment forms, so no
unrelated UI changed.

## Not modified

Peach credentials, Peach Checkout integration, Peach Payout integration, wallet
ledger, transaction processing, payment confirmation logic, webhook processing,
balances, fees, KYC/FICA, unrelated UI.

## Verification

**`safe-errors.spec.js` — 31/31.** Nine failure shapes are thrown at the modal in
a real browser, including a raw SQL error (`relation "pricing_rules" does not
exist` with a `node_modules` path) and a message containing `POSTGRES_URL`,
`clientSecret=` and a bearer token. Every one renders a mapped sentence, and the
rendered HTML is asserted against a forbidden list covering endpoints, HTTP
statuses, internal codes, SQL, server paths, stack frames, env vars, credentials
and request ids. Nothing leaked.

**`admin-diagnostics.spec.js` — 15/15.** Drives a real domain rejection, then
proves the customer message carries no provider wording while the failure reason
survives on the transaction record, in the admin projection, and in the server
log with Peach's own text, the HTTP status and the domain sent.

Regression: domain allowlist 11/11 · session refresh 12/12 · timeout semantics
19/19 · reachability 7/7 · PWA routing 44/44 · top-up form 19/19 · offline
withdraw 6/6 · fee preview 31/31 · top-up 32/32 · withdrawal 61/61 · withdrawal
failures 28/28 · service routing 51/51 · API unit suite 207/210 (the same three
that fail in the original build).
