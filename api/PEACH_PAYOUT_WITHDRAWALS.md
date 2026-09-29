# Top-up routing (Card vs EFT) and Peach Payouts withdrawals

Two changes, both surgical.

---

# Part 1 — Top-up payment-method routing

## Root cause

`confirmReviewedTransaction` in `app.js` branched on the **service code** only:

```js
if (isCardTopupService(data.serviceCode)) { await startCardTopup(context); return; }
```

`wallet_top_up` is the service code for **both** funding methods, so choosing
**EFT or bank transfer** launched the Peach **card** checkout. The `fundingMethod`
field the form collects was never read by anything except a hint-text handler.

## Fix

Routing is now decided by the funding method, not the service code:

```js
if (isCardTopupService(data.serviceCode)) {
  if (topupFundingMethod(data) === "eft_bank_transfer") { await startEftTopup(context); return; }
  await startCardTopup(context); return;
}
```

* **Card** → `POST /v1/payments/topup` → Peach Checkout → redirect → server-side
  verification → wallet credited exactly once. Unchanged.
* **EFT** → Peach is never called.

## What EFT does now, and why

**There is no TitoPay EFT/bank-transfer top-up workflow.** The dropdown option,
its hint text and a line in the chatbot answer were the entire implementation —
there is no deposit-reference generator, no bank-account setting, no
reconciliation job, no admin settlement screen, and no way for a bank transfer
to reach a wallet. Nothing was removed; it was never built.

So EFT now says so, and sends the customer back to Card:

> **EFT top ups are not available yet.** TitoPay cannot match bank transfers to
> your wallet automatically, so EFT top ups are switched off. Nothing was
> charged and your wallet is unchanged. Do not transfer money to TitoPay by EFT
> — it cannot be credited.

The alternative — creating a pending record with a reference — would have
invited customers to transfer real money against a deposit nothing can settle.
That is worse than saying no.

The dropdown option is labelled `EFT or bank transfer · not available yet`, and
selecting it warns before the customer fills in the form.

**To make EFT real you need a deposit-reference scheme, TitoPay bank account
details in settings, a bank-statement feed or file import, a matching job, and
an admin settlement screen.** That is a feature, not a fix, and it touches the
Admin Portal — which this brief excluded.

---

# Part 2 — Peach Payouts withdrawals

## Root cause of the blocker

`transaction-service.js` carried an explicit safety control:

```js
const PAYOUT_PROCESSING_ENABLED = String(process.env.PEACH_PAYOUT_PROCESSING_ENABLED || "").toLowerCase() === "true";
...
if (!PAYOUT_PROCESSING_ENABLED) throw new AppError(503, "Withdrawals are not open yet. …");
```

It was **not** a feature flag hiding finished work. It was standing in for
missing functionality: `createTransaction` only debits a wallet, so without a
submit-and-confirm lifecycle a Confirm would have taken the money with nothing
on the other side to move it, and no way to give it back if the payout failed.

The flag is now **removed rather than bypassed**, because the lifecycle it was
protecting exists.

## Existing architecture found

| Thing | State before |
| --- | --- |
| `peach-payout-service.js` | OAuth, balance check, `createPayoutRequest`, `queryPayoutRequest` — a working client, never called by any customer path |
| `wallet_ledger` / `applyWalletMovement` | `debit`, `credit`, `reserve`, `release`; `reverseTransaction` already pairs them |
| `beneficiaries` table | **TitoPay-user to TitoPay-user only** (`beneficiary_user_id REFERENCES users(id)`) — cannot hold a bank account |
| Withdraw form | one free-text field, "Bank account number or saved beneficiary" |
| Pricing | `withdraw` R7.00 flat; `business_payout` 1.5%; **`payouts` missing entirely** |

So the two genuinely missing pieces were **somewhere to keep bank details** and
**the withdrawal lifecycle itself**.

## Peach Payouts API implementation

Every field, constraint and status below is taken from the published reference.
Nothing is guessed.

```
POST {payouts}/api/merchants/{merchantId}/payouts
GET  {payouts}/api/merchants/{merchantId}/payouts/{payoutRequestId}/status
```

| Field | Constraint | How TitoPay satisfies it |
| --- | --- | --- |
| `amount` | number, **minor units (cents)**, 1000–500000000 | `toMinorUnits()` — R500 is sent as `50000`. **This was a live 100× bug: the old client passed rands.** |
| `currency` | `ZAR` only | fixed |
| `accountNumber` | ≤ 50 | validated at save time |
| `branchCode` | `^[0-9]{6}$` | validated at save time |
| `reference` | `^(?! )[A-Za-z0-9 ]{1,20}(?<! )$` | `toPayoutReference()` — a TitoPay reference contains hyphens, which Peach rejects |
| `bankName` | enum of 24 SA banks | `SUPPORTED_BANKS`, offered as a dropdown |
| `accountHolder` | 2–50, restricted punctuation | `toAccountHolder()` |
| `payoutMethod` | `realtime-eft` only | fixed |
| `payoutId` | optional lowercase UUIDv4 | **TitoPay generates it**, so a payout always carries our identifier and a webhook can be matched back |

Response: `payoutRequestId`, and `payouts[].{payoutId, status, resultCode}`.
Statuses: `pending`, `processing`, `failed`, `successful`, `cancelled`, `reversed`.

### Status mapping

| Peach | TitoPay | Money |
| --- | --- | --- |
| `pending`, `processing` | `processing` | stays out |
| `successful` | `completed` | stays out |
| `failed`, `cancelled`, `reversed` | `failed` / `cancelled` | returned in full |
| anything unrecognised | `processing` | stays out |

**Peach accepting the request is never a completion.** A new payout is created
`pending`, which maps to `processing`.

## Transaction and ledger lifecycle

```
Confirm
  └─ ONE database transaction:
       SELECT … FROM wallets FOR UPDATE          (a double tap serialises here)
       available >= amount + fee ?               (else 409, Peach never contacted)
       INSERT transactions … status 'pending'
       applyWalletMovement debit (amount + fee)  ← THE debit, exactly one
     COMMIT
  └─ POST to Peach  (outside the transaction — a slow provider never holds a wallet lock)
       accepted  → status 'processing', store payoutRequestId
       rejected  → release, status 'failed'
       uncertain → HOLD, status 'processing', requiresReview
```

Settlement:

* **successful** → status `completed`. **No ledger movement** — the debit already
  happened at submission.
* **failed / cancelled / reversed** → credit back, once.

The reversal amount is **summed from the ledger's own debit rows**, never from a
caller, a webhook or a provider payload. Money can therefore not be created or
destroyed by a bad message.

## Idempotency

| Risk | Guard |
| --- | --- |
| Double tap | wallet row `FOR UPDATE` inside the transaction that debits |
| Retry with the same key | `clientIdempotencyKey` lookup returns the original withdrawal, no new payout |
| Duplicate payout at Peach | TitoPay-generated `payoutId`; one submission per transaction row |
| Repeated status polls | terminal statuses short-circuit before any movement |
| Repeated webhooks | same, plus a ledger check for `stage = 'withdrawal_reversed'` |
| Browser refresh | the withdrawal is server-side state; the page only reads it |
| Rewound status | ledger existence check, independent of `transactions.status` |

## Failure and reversal handling

A failed **submission** splits into two cases that must behave differently:

* **Definitely rejected** — Peach validated the request and answered 4xx (not
  408/429). No payout exists, so the debit is released immediately and the
  customer is told nothing was sent.
* **Uncertain** — timeout, network error, 5xx, 408, 429. Peach may or may not
  have created the payout. Releasing here could pay the customer twice, so the
  money **stays out**, the withdrawal is `processing` with `requiresReview`, and
  the customer is told: *"do not try again"*. An operator resolves it.

This is the one place where doing nothing is the correct action, and it is
deliberate.

## Webhook

`POST /v1/webhooks/peach-payouts` — `{status, payoutId, lastUpdated, resultCode}`.

Peach's reference documents **no signature** for this webhook, so it is treated
purely as a **trigger**: it names a payout that changed, and TitoPay then queries
the Peach Payouts API with its own server-side credentials for the real status.
The webhook's own `status` claim is never read. A forged delivery can at most
cause a redundant status query; an unknown `payoutId` is answered `202` (not
`404`) so the endpoint cannot be used to probe which identifiers exist.

**A webhook claiming success for a payout Peach actually failed is not believed
— this is covered by a test.**

## Bank accounts

New table `payout_bank_accounts` (additive; `beneficiaries` is untouched):
`account_holder, bank_name, account_number, branch_code, account_type,
is_default, verified_at, deleted_at`. Soft-deleted, so a historical withdrawal
keeps the account it was sent to.

* `GET /v1/payouts/banks` — the 24 banks Peach supports, plus account types.
* `GET|POST|DELETE /v1/payouts/bank-accounts`
* **Account numbers are never returned in full** — the API returns `••••4567`.
  The full number exists only server-side, and only the withdrawal service reads
  it, only to build the Peach request.
* **A withdrawal request accepts a `bankAccountId`, never bank details.** The
  browser cannot redirect anyone's money by editing a request body.

## Cash withdrawal

`withdraw_cash` and `cash_withdrawal` were listed as Peach payout services. They
are **not** — Peach Payouts pays a bank account by realtime-EFT. Routing them
there would have told the customer to use an endpoint that then refused them, so
they moved to the unlaunched-services list and report the standard
"not enabled for live processing yet. No wallet debit was made."

## Pricing

`payouts` — the code the business **Payouts** tile actually submits — was missing
from the approved pricing schedule, so an earlier fee preview auto-created it at
**zero** and business payouts would have been free. It is now priced identically
to Business Payout: **1.5%**.

> **This is a price decision.** A R1,000 business payout now costs R15. If that
> is wrong, change it in Admin → Pricing; nothing in the code depends on the
> figure. Personal withdrawals keep their approved R7.00 flat fee.

## App

* Withdraw and business Payouts now use a saved bank account picker, with an
  inline "add a bank account" form (bank dropdown, account number, branch code,
  account holder, account type) so a first-time customer completes one journey.
* The review screen shows **Paying out to: holder · bank · ••••1234 · branch**.
* After Confirm: **Processing** immediately, with *"Do not try again"*.
* Then **Withdrawal successful** or **Withdrawal failed** (with *"returned to
  your wallet in full"*), from the server's authoritative status.
* Activity shows the same server-side status.
* The PWA never calls Peach. Every credential and access token stays server-side.

## Error handling change

`error-handler.js` previously stripped `details` from every 5xx. A deliberate
502/503/504 now returns **one short UPPER_SNAKE code** and nothing else, so the
app can tell "rejected, money returned" from "unconfirmed, money held". Anything
lower-case, punctuated or long is assumed to be provider text and dropped — a
regression test asserts that provider prose and bodies never ride out on a 5xx.

---

## Files changed

**API — new**
`src/services/peach-withdrawal-service.js`, `src/services/payout-account-service.js`,
`src/routes/payouts.routes.js`, `src/routes/payout-webhook.routes.js`,
`test/peach-withdrawal.test.js`

**API — modified**
`src/services/peach-payout-service.js` (documented schema, cents conversion,
bank enum, reference/holder sanitising, status vocabulary),
`src/services/transaction-service.js` (flag removed, `USE_WITHDRAWAL_FLOW`,
cash withdrawals rerouted), `src/services/pricing-service.js` (`payouts` priced),
`src/middleware/error-handler.js` (safe 5xx code), `src/routes/index.js`,
`src/app.js`, `src/db/schema.sql`, `test/peach-checkout-topup.test.js`,
`test/peach-payout-capability.test.js`

**PWA**
`app.js` + `app.min.js` (funding-method routing, EFT stop, withdrawal lifecycle,
bank account picker, destination row, processing/success/failure modals),
`index.html`, `service-worker.js` (cache **v275 → v276**)

`app.min.js` is regenerated from `app.js` with terser. Verified first that no
function exists in the old bundle that is absent from `app.js`, and that every
top-level name survives minification.

## Verification

Real Postgres, the real API, the real PWA bundle in Chromium, and a Peach Payouts
stand-in that enforces the **documented** schema — including cents, the bank
enum, the reference alphabet and the 6-digit branch code — so a request TitoPay
gets wrong fails there exactly as it would at Peach.

| Check | Result |
| --- | --- |
| API unit suite | **207 / 210** (the 3 failures are pre-existing and present in the original build) |
| Withdrawal lifecycle end to end | **61 / 61** |
| Submission failures and money safety | **28 / 28** |
| Business payout | **15 / 15** |
| PWA: Card vs EFT vs Withdrawal in Chromium | **44 / 44** |
| Service routing | **51 / 51** |
| Card top-up through the real form | **19 / 19** |
| Card top-up lifecycle | **32 / 32** |
| Fee preview → credit | **31 / 31** |
| 13-way top-up race | credited exactly once |
| Collection / Payout split | **34 / 34** |
| Admin: two Peach capabilities | **26 / 26** |
| Admin: API Provider Settings | **19 / 19** |
| Admin: dashboard tile | **7 / 7** |
| Every provider's secrets | **34 / 34** |
| PWA card top-up (direct path) | **16 / 16** |

Route table: 1028 → 1059, none removed. (`GET /v1/payments/topup/:paymentId` is
unchanged as a URL — the placeholder is named `:reference` and the handler
accepts either.)

### Evidence, specifically

**One withdrawal creates exactly one Peach payout** — 5 concurrent repeats with
the same idempotency key returned the same withdrawal and left exactly one
submission at Peach; a browser refresh added none.

**One withdrawal causes at most one wallet debit** — one ledger row
(`debit 507.00`) after 5 repeats; a successful payout adds none. 8 concurrent
withdrawals against one wallet: 2 accepted, 6 refused, balance never negative.

**A failed payout restores funds exactly once** — `debit 307.00` then
`credit 307.00`, equal by construction; 6 further polls and 4 webhooks left the
balance and the ledger unchanged.

**Insufficient balance never reaches Peach** — the over-balance attempt was
refused 409 and the Peach stand-in received nothing.

**Cents** — a R500 withdrawal reached Peach as `amount: 50000`.

## Not touched

Peach Collection and Payout configuration, credentials or connection tests; the
card top-up flow; TitoPay-to-TitoPay transfers; QR payments; KYC/FICA;
authentication; the `wallet_ledger` architecture and `applyWalletMovement`; other
providers; the Admin Portal; unrelated API routes and PWA screens. No credential
was regenerated or rotated.

---

## Addendum — "Transaction not confirmed / services are not reachable"

That message is raised by the PWA when `fetch()` **never completes** — it sets
`status = 0`. It is not an HTTP 404, 500 or 503; those produce different text.
So it means the browser could not get a usable response at all: the API is not
answering, or something in front of it answered without CORS headers.

Two things were checked and cleared:

* **The service worker is not involved.** Its fetch handler returns early for
  `api.titopay.co.za`, so it never touches an API request.
* **A stale API is not the cause.** The previous build answers the new
  `/v1/payouts/*` paths with `401` **and** an `Access-Control-Allow-Origin`
  header, which the app reports as a 401 — not as "not reachable".

**One defect was fixed regardless of the cause.** Failing to *open* the Withdraw
screen used the "Transaction not confirmed" modal, which exists to warn that a
payment may already be in flight. Nothing is submitted when the screen loads, so
it now says:

> **Could not open withdraw** — TitoPay could not be reached, so this screen
> could not load. **Nothing was submitted and your wallet is unchanged.**

Covered by `withdraw-offline.spec.js` (6/6), which aborts every `/v1/payouts/*`
request in a real browser.

### Separately: `npm run db:migrate` cannot bootstrap an empty database

`schema.sql` references `transactions` at lines 347 and 400 but only creates it
at line 552, so on a virgin database the whole file fails with
`relation "transactions" does not exist`. **This is pre-existing** — the original
build fails identically, verified against `api_pristine`. It does not affect an
existing installation, where migrate only adds the new `payout_bank_accounts`
table. Worth fixing before anyone provisions a fresh environment.
