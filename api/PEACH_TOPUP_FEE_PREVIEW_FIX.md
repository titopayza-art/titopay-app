# Card top-up blocked at "Preview top up" — root cause and fix

## Symptom

Opening **Top Up**, entering an amount and pressing **Preview top up** raised a red toast:

> Card top-ups are completed through the secure card payment flow. No wallet debit was made.

The customer never reached the review screen, so the card payment was never started.
Nothing was charged and no wallet balance changed — the top-up simply could not begin.

## Root cause

That message is TitoPay's own refusal, not Peach's. It came from
`assertServiceLaunched` in `src/services/transaction-service.js`, which threw
`409 USE_CARD_TOPUP_FLOW` for every service code in `CARD_TOPUP_SERVICES`.

`assertServiceLaunched` is called from **two** places:

| Caller | Purpose | Should a card top-up be refused? |
| --- | --- | --- |
| `feePreview` | read-only price calculation, no money moves | **No** |
| `assertLiveTransactionSupported` → `createTransaction` | debits the wallet | Yes |

The PWA's Top Up form posts through the shared `data-form="transaction"` handler, so
`processTransaction` calls `POST /v1/transactions/fee-preview` **first**, and only branches to the
card flow later in `confirmReviewedTransaction`. The refusal therefore fired on the price quote,
one step before the branch that would have sent the customer to Peach.

The earlier browser test called `startCardTopup()` directly and so never crossed this line.

## Fix

**`src/services/transaction-service.js`** — the refusal moved from `assertServiceLaunched` into
`assertLiveTransactionSupported`.

* `feePreview` now quotes a card top-up like any other service.
* `POST /v1/transactions` still answers `409 USE_CARD_TOPUP_FLOW` with the same message and the
  same `endpoint: "/v1/payments/topup"` hint, so the wallet-debit path cannot be used to fake a
  top-up. That guard was not weakened, only moved to the path that can actually move money.

Nothing else in the gate changed: withdrawals, payouts, request-only services, multi-party
services and provider-dependent services are all still blocked exactly where they were.

## The fee, and what the card is charged

Unblocking the preview surfaced a second problem. The approved pricing schedule prices a wallet
top-up at a **flat R6.00** (`pricing_rules.wallet_top_up`), so the review screen quotes:

```
Amount   R200.00
Fee      R  6.00
Total    R206.00
```

`createTopupCheckout` previously wrote `fee = 0, total = amount` and asked Peach for the bare
amount, so the customer would have confirmed R206.00 and been charged R200.00.

**`src/services/peach-checkout-service.js`** now resolves the fee from the same approved pricing
rule the preview used, and:

* the card is charged **`amount + fee`** (the total the customer confirmed);
* the wallet is credited **`amount`** — the fee is collected at the card and never enters the
  wallet, so there is still exactly one ledger entry per top-up and it is a credit for the amount;
* the transaction row records `amount`, `fee` and `total` separately, the way every other service
  does;
* the amount-mismatch guard in `settleTopupTransaction` now compares Peach's reported amount to
  `row.total` (what Peach was asked to charge) instead of `row.amount`. Rows written before this
  change carry `total = amount`, so they still verify correctly.

If the fee is ever set to zero in Admin, `total` equals `amount` and the behaviour is identical to
before.

### Stale review screens

`POST /v1/payments/topup` now accepts an optional `quotedTotal` — what the review screen showed.
If it disagrees with the total the server computes, the request is refused with
`409 TOPUP_QUOTE_STALE` and nothing is written or sent to Peach:

> The top-up fee changed since this screen was opened. Nothing was charged — please start the top
> up again to see the current total.

This can only ever **refuse** a payment. It is never used to set the amount charged, so a tampered
client cannot raise or lower what Peach is asked for. Omitting the field keeps the old behaviour.

## PWA

* `startCardTopup` sends `quotedTotal` from the review screen's own quote.
* The "Opening secure payment" modal now names the **total** being charged and, when a fee applies,
  spells out the split ("R200.00 into your wallet plus a R6.00 TitoPay top up fee").
* The success modal still names the **credited** amount, because that is what reaches the wallet.
* Cache-buster and service-worker cache bumped **v274 → v275** so browsers fetch the new bundle.

## Not touched

Wallet ledger mechanics, `applyWalletMovement`, transaction accounting for any other service,
authentication, KYC/FICA, database schema, Peach Collection credentials or connection test, the
Peach Payout capability, other providers, webhooks, unrelated API routes, and unrelated Admin
pages. No credential was regenerated or rotated.

## Verification

Run against a real Postgres, the real API, the real PWA bundle in Chromium and a Peach stand-in
that implements the documented Checkout V2 shapes.

| Check | Result |
| --- | --- |
| API unit suite | 185 / 188 (the 3 failures are pre-existing and present in the original build) |
| Card top-up through the **real Top Up form** in Chromium | 19 / 19 |
| Fee preview → credit, amounts and ledger | 31 / 31 |
| Peach Checkout top-up lifecycle end to end | 32 / 32 |
| 13-way race (6 polls + 4 webhooks + 3 browser returns) | credited exactly once |
| Service routing (top-up → Collection, withdraw/payout → Payout) | 35 / 35 |
| Collection / Payout split | 34 / 34 |
| Admin: two independent Peach capabilities | 26 / 26 |
| Admin: API Provider Settings page | 19 / 19 |
| Admin: dashboard provider tile | 7 / 7 |
| Every provider's secret stored, kept, mask never poisons it | 34 / 34 |
| PWA card top-up (direct confirm path) | 16 / 16 |

Route table: 1043 routes, none removed relative to the original build.
`GET /v1/payments/topup/:paymentId` is unchanged as a URL — the path placeholder is now named
`:reference` and the handler accepts either a reference or a transaction id.
