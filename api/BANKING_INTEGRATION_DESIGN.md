# TitoPay Banking Integration Layer

Phase 1 (audit) and Phase 2 (design). **No code has been written. Nothing has
been changed.** This document is for review before Phase 3.

---

## 0. The stop condition, first

**The Absa Pay documentation is not in this repository.**

Searched: every file outside `node_modules` and `.git`, by filename and by
content. Every hit for "absa" is a South African bank name in an existing list:

| Where | What it is |
|---|---|
| `src/services/peach-payout-service.js:435` | a bank name in `SUPPORTED_BANKS`, for payout destinations |
| `src/db/schema.sql:1377,1414` | a `CHECK` constraint on `pos_terminals.provider` and `pos_payment_intents.provider` |
| `src/pos/providers/index.js:6`, `src/pos/service.js:12` | the same fixed provider list |
| `api/POS_BANK_INTEGRATION_CONTRACT.md` | a document stating that no bank spec has been supplied and no adapter is implemented |

There is no `PaymentConsentRequest`, no `RequestConsentResponse`, no
`PaymentInstruction`, no `PaymentStatus`, no endpoint, no sandbox URL, no
authentication scheme, no callback schema and no error catalogue anywhere in
this project.

The spec forbids inventing them, and the existing
`POS_BANK_INTEGRATION_CONTRACT.md` records the same refusal for the same reason.
So the Absa adapter is designed here **as a seam only**, and every Absa-specific
value is marked `NOT CONFIRMED`. Phase 4 cannot start until the documentation is
supplied. Section 9 lists exactly what is needed.

---

## 1. What was inspected

`api/src/` in full: 58 services, 41 route modules, `src/providers/`,
`src/pos/`, `src/config/`, `src/db/schema.sql` (1600+ lines, 80 tables),
`src/db/migrations/`, `src/middleware/`, and 74 test files. Plus `admin/`
structure and the PWA's provider coupling.

Read line by line: `src/providers/index.js`, `payment-provider.js`,
`payout-provider.js`, `vas-provider.js`, `src/services/peach-checkout-service.js`,
`src/routes/integrations.routes.js`, `src/services/money-integrity-service.js`
(reconciliation), `src/config/deployment-safety.js`, `src/config/env.js`,
`src/pos/providers/base.js`, `test/provider-boundary.test.js`.

---

## 2. Current TitoPay architecture

### 2.1 The finding that shapes everything else

**The bank-agnostic layer this task asks for already exists.** `src/providers/`
is a capability registry with exactly the architecture the spec describes, and
it is enforced by a test.

```
TitoPay core
   -> a capability, named for what TitoPay needs   (src/providers/index.js)
      -> an adapter, named for the supplier         (payment-provider.js, ...)
         -> that supplier's API                     (services/peach-*.js)
```

`src/providers/index.js` declares eight capabilities:

```
kyc  aml  payment  payout  banking  vas  card  notification
```

`banking` is already named — "account verification, statements, balances" — and
deliberately left with **no adapter registered**, with a comment saying so:
capabilities with no adapter "report as unregistered rather than being pretended
into existence."

Selection is by environment variable (`PAYMENT_PROVIDER`, `PAYOUT_PROVIDER`,
`KYC_PROVIDER`, `VAS_PROVIDER`; `BANKING_PROVIDER` would follow the same
derivation, `${CAPABILITY}_PROVIDER`). Adapters declare their own default via
`isDefault: true`, so adding a provider never edits the resolver. The registry
file contains no provider name at all, and `test/provider-boundary.test.js`
fails the build if one appears there or in nine named core files.

**Therefore: building a separate "Banking Integration Layer" would create the
duplicate financial system the spec forbids.** The design below extends
`src/providers/`. That is the single most important decision in this document.

### 2.2 Current payment flow (money in)

`POST /v1/payments/topup` -> `payment-provider.processPayment()` ->
adapter `peach_checkout` -> `peach-checkout-service.createTopupCheckout()`.

The lifecycle is already close to what section 8-11 of the spec demands:

- **Server owns the amount.** The client's `amount` is validated, the fee comes
  from the approved pricing rule, and `chargeTotal = amount + fee` is computed
  server-side and written to `transactions.total` before the provider is called.
- **A stale quote refuses.** If the client sends `quotedTotal` and it disagrees,
  HTTP 409 and nothing is charged. It can only ever refuse, never authorise more.
- **Idempotency is required.** `idempotencyKey` is mandatory; a replay within 24h
  returns the original checkout. Backed by unique index
  `idx_transactions_client_idem` on `(user_id, metadata->>'clientIdempotencyKey')`.
- **One credit site.** `settleTopupTransaction()` is the only place a top-up
  credits a wallet. It takes `SELECT ... FOR UPDATE` on the transaction row, so a
  webhook, a status poll and a browser return racing each other serialise.
- **Independent verification.** Nothing is credited from a callback body. The
  server re-reads status from the provider (`verifyWithPeach`) first.
- **Amount mismatch refuses.** Reported amount vs `transactions.total`, tolerance
  0.005; a mismatch sets `processing` + `requiresReview`, never credits.
- **A timeout is not a failure.** Result codes `100.396.104/103/106` map to
  `pending`, not failed. Uncertain never becomes success.
- **Fee revenue posts under a SAVEPOINT**, so a revenue-ledger failure can never
  cost a customer their credit.

### 2.3 Current withdrawal / payout flow (money out)

`POST /v1/payouts/withdrawals` -> `payout-provider.processPayout()` ->
`peach-withdrawal-service.createWithdrawal()`.

Controls: idempotency key **required**; `pg_advisory_xact_lock` on
`wd:${userId}:${idempotencyKey}`; wallet locked `FOR UPDATE`; funds reserved
before the provider is called; a provider timeout leaves the withdrawal pending
for reconciliation rather than resubmitting.

Destination accounts live in `payout_bank_accounts` (soft-deleted, never
removed, so a historical payout keeps the account it was sent to).

### 2.4 Wallet and ledger

- `wallets` — balance
- `wallet_ledger` — `entry_type IN (debit, credit, reserve, release)`, with
  `balance_after`; written only through `walletService.applyWalletMovement()`
- `revenue_ledger` — fees, one row per transaction, the idempotency key for fee posting
- `transactions` — `amount` / `fee` / `total`, `status`, `direction`,
  `reference UNIQUE`, `metadata JSONB`
- `transaction_status_history` + two DB triggers — every status change recorded
  in the same DB transaction as the change; **a trigger refuses to move a
  transaction out of `reversed`**

`transactions.service_code` has a foreign key to `pricing_rules(service_code)`.
Any new money path needs a pricing rule row before a transaction can be inserted.

### 2.5 Reconciliation

`money-integrity-service.js` already provides:

- `runIntegritySweep()` — wallet balance vs ledger drift, orphan detection
- `runProviderReconciliation({ provider, entries, actor })` — **already
  provider-neutral**; takes a statement as `{reference, amount, state}` rows,
  matches on `reference` / `checkoutId` / `payoutId` / `merchantTransactionId`,
  and raises typed exceptions: `unmatched_provider_transaction`,
  `amount_mismatch`, `missing_settlement`, `unexpected_settlement`,
  `unreadable_entry`
- `reconciliation_runs` + `reconciliation_exceptions` — the exception queue
- `resolveReconciliationException()` — **requires a written reason**, writes an
  audit log, and never auto-corrects

### 2.6 Callback security (the model to copy)

`handlePeachProviderWebhook` in `src/routes/integrations.routes.js`:

1. envelope check before touching config or DB (raw body, signature, timestamp, webhook id, algorithm) -> 401
2. HMAC-SHA256 over `timestamp.webhookId.url.rawBody`, `timingSafeEqual`, hex or base64
3. timestamp freshness +/- 5 minutes
4. schema validation: amount, currency, transaction id, merchant id
5. idempotency reserved by `INSERT ... ON CONFLICT DO NOTHING`
6. HTTP 200 immediately, processing deferred to `setImmediate`
7. **the body is a trigger only** — settlement re-reads status from the provider

One defect to not copy: the idempotency reservation is written into
`platform_settings`, which is why that table holds 234 rows in sandbox against 4
in a fresh database, and why `GOING-LIVE.md` has to warn against copying it.

### 2.7 Environment and configuration

`TITOPAY_ENV`, plus `PEACH_PAYMENTS_MODE` / `DOCFOX_MODE` / `OTT_MODE`.
`config/deployment-safety.js` inspects them at boot with a deliberate split:

- **warnings** — missing variable, unreadable database name, absent credentials; the API serves
- **blocking (exit 78)** — only contradictions: env vs mode, env vs `NODE_ENV`, env vs a database stamped for the other environment

This split exists because an earlier build refused to start on a *missing*
variable and took the API down. Any banking checks must respect it.

Credentials resolve **stored-config-first**: `loadPeachConfig()` reads
`platform_settings.integration_*` (AES-256-GCM encrypted) and falls back to env.
So a stored row beats the environment variable.

### 2.8 Existing gaps found during the audit

| # | Finding | Bearing on this work |
|---|---|---|
| G1 | `BANKING` capability named, no adapter. No `verifyBankAccount` exists anywhere in the codebase. | This is the seam to fill. |
| G2 | Admin feature flags (`platform_settings.feature_flags`, 20+ flags incl. `peach`) are **read and written by the admin console and enforced nowhere**. `grep` outside `admin.routes.js` returns zero consumers. | **Banking flags must not use this mechanism.** It is decorative. |
| G3 | `pos_payment_intents.provider` and `pos_terminals.provider` are `CHECK (provider IN ('STANDARD_BANK','ABSA',...))` — bank names hard-coded in the schema. | The exact anti-pattern to avoid. Not proposing to change it now; noted. |
| G4 | Webhook idempotency keys stored in `platform_settings`. | New banking events get their own table. |
| G5 | `peach-payout-service.normalizeEnvironment()` defaults to `sandbox` while every other integration defaults to `production`. | Pre-existing; warns at boot; out of scope here. |

---

## 3. New banking architecture

### 3.1 Shape

```
TitoPay core  (transaction-service, wallet-service, routes)
      |  asks for a capability, never for a company
      v
src/providers/index.js          registry, capability resolution   [EXISTS]
      |
      +-- payment-provider.js   money in                          [EXISTS]
      +-- payout-provider.js    money out                         [EXISTS]
      +-- kyc-provider.js       identity                          [EXISTS]
      +-- vas-provider.js       value added services              [EXISTS]
      +-- banking-provider.js   bank rails                        [NEW]
             |
             +-- key "none"       shipped default, refuses        [NEW]
             +-- key "absa_pay"   reference adapter               [NEW, sandbox only]
             +-- key "<future>"   any other bank
```

`BANKING_PROVIDER=absa_pay` selects the adapter. Unset selects `none`, which
refuses. Absa's vocabulary lives inside
`src/services/absa-pay-service.js` and never crosses into `banking-provider.js`'s
exported interface.

### 3.2 Provider interface (TitoPay's words only)

```js
// src/providers/banking-provider.js  — what core may call
capabilities()                         // -> capability report, below
initiateCustomerPayment(actor, request)
getPaymentStatus(actor, reference)
handleProviderCallback(envelope)
verifyAccount(actor, request)
getAccountInformation(actor, request)
getTransactionHistory(actor, request)
initiatePayout(actor, request)
initiateWithdrawal(actor, request)
reconcile(request)
```

Every operation an adapter does not implement is **absent from the adapter
object**. The existing `operation()` resolver already turns that into a
controlled refusal. One addition is needed so callers can distinguish "not
supported" from "temporarily down": a `CAPABILITY_NOT_SUPPORTED` error code on
the `AppError`, with the customer-facing wording unchanged.

### 3.3 Capability model — five gates, default closed

`capabilities()` returns an explicit report. A capability is `enabled: true`
**only when all five are true**:

| Gate | Source | Why |
|---|---|---|
| `implemented` | the adapter exports the function | code exists |
| `configured` | required credentials resolve | it can actually call out |
| `flagEnabled` | a server-read environment flag, never the admin console | TitoPay is willing, and somebody with server access said so |
| `environmentPermits` | `BANKING_ENVIRONMENT` paired with `TITOPAY_ENV` by an allow-list | sandbox keys cannot serve production |
| `approved` | an explicit approval record naming provider, capability and environment | commercial and regulatory sign-off |

> Corrected in Phase 3.5. The shipped code always required these five separate
> booleans; an earlier draft of this table and of the source comments described
> the first two as one and called it a four-gate system. Each gate is now
> proved independently, and mutation-tested. See `BANKING_SAFETY_AUDIT.md`.

```js
{
  provider: "absa_pay",
  environment: "sandbox",
  operations: {
    CUSTOMER_PAYMENT_INITIATION: { supported:false, reason:"NOT_CONFIRMED", ... },
    ACCOUNT_VERIFICATION:        { supported:false, reason:"NOT_CONFIRMED", ... },
    WITHDRAWAL:                  { supported:false, reason:"NOT_CONFIRMED", ... },
    PAYOUT:                      { supported:false, reason:"NOT_CONFIRMED", ... }
  }
}
```

`approved` deliberately does **not** use `platform_settings.feature_flags` (gap
G2 — enforced nowhere). It is a distinct, server-read record, and an operator
toggling a flag is never the same event as an approval.

Capability names are TitoPay's, from the spec:
`CUSTOMER_PAYMENT_INITIATION`, `ACCOUNT_INFORMATION`, `ACCOUNT_VERIFICATION`,
`TRANSACTION_HISTORY`, `PAYMENT_STATUS`, `WITHDRAWAL`, `PAYOUT`, `REFUND`,
`RECONCILIATION`, `SETTLEMENT`, `CONSENT_MANAGEMENT`.

### 3.4 Canonical state machine

**`transactions.status` is not changing.** It is core, it is read across the
platform, and it has DB triggers on it. A canonical banking state lives beside it
in a new sidecar row, and maps down:

| Canonical | `transactions.status` | Credits wallet? |
|---|---|---|
| `CREATED` | `pending` | no |
| `CONSENT_PENDING` | `pending` | no |
| `AUTHORISED` | `pending` | no |
| `PAYMENT_PENDING` | `pending` | no |
| `SUCCESS` | `completed` | **yes, once, after independent verification** |
| `FAILED` | `failed` | no |
| `REJECTED` | `failed` | no |
| `EXPIRED` | `cancelled` | no |
| `CANCELLED` | `cancelled` | no |
| `IN_DOUBT` | `processing` | **never** |
| `REFUNDED` | `refunded` | separate reversal path |

`IN_DOUBT` -> `SUCCESS` is permitted **only** from an authoritative provider
status query, never from a callback body, never from a retry, never from a
timeout expiring. This mirrors the existing Peach `review` state, which already
maps to `processing` and is never auto-credited.

Provider states map in **one function inside the adapter**
(`toCanonicalState(providerState)`), with an explicit default of `IN_DOUBT` for
anything unrecognised. An unknown state must never fall through to a terminal
one — this is the same discipline as
`kyc-provider.normalizeVerificationStatus()`, which sends unrecognised values to
`review_required` rather than guessing a pass.

### 3.5 Money integrity — unchanged rules, reused code path

```
provider event -> authenticate -> validate schema -> match to a TitoPay
transaction -> check amount + currency + reference + expected state ->
idempotency -> INDEPENDENT status query to the provider -> canonical state ->
if and only if SUCCESS: lock transaction FOR UPDATE -> credit once -> ledger
```

The banking settlement function is written to the shape of
`settleTopupTransaction()`: row lock, terminal-status short circuit, amount
check against `transactions.total`, an existing-credit probe scoped to the
customer's wallet, and fee revenue inside a `SAVEPOINT`.

Nothing in `wallet-service.js`, `transaction-service.js`, `wallet_ledger` or
`revenue_ledger` is modified.

### 3.6 Database changes — new tables only

Reversible `.up.sql` / `.down.sql` pair, following the existing
`src/db/migrations/YYYYMMDD_name` convention. No `ALTER` on any financial table.
No `DROP`, `DELETE` or `TRUNCATE`.

**`banking_payment_intents`** — the provider-neutral intent, modelled on the
proven `pos_payment_intents`:

```
id UUID PK
transaction_id UUID REFERENCES transactions(id)     -- the money record
provider TEXT NOT NULL                              -- free text, NOT a CHECK list (see G3)
environment TEXT NOT NULL CHECK (environment IN ('development','staging','production'))
capability TEXT NOT NULL                            -- CUSTOMER_PAYMENT_INITIATION, ...
canonical_state TEXT NOT NULL CHECK (canonical_state IN (11 states above))
amount NUMERIC(18,2) NOT NULL CHECK (amount > 0)
currency CHAR(3) NOT NULL
provider_transaction_id TEXT
provider_reference TEXT
provider_status TEXT                                -- the provider's own word, kept raw
provider_created_at / provider_updated_at TIMESTAMPTZ
idempotency_key TEXT NOT NULL
created_at / updated_at TIMESTAMPTZ
UNIQUE (provider, environment, provider_transaction_id)
UNIQUE (provider, idempotency_key)
```

`provider` is deliberately **not** a `CHECK` list of bank names. Adding a bank
must not be a schema migration (gap G3).

**`banking_provider_events`** — every inbound callback, for idempotency and for
the audit trail. Replaces the `platform_settings` habit (gap G4):

```
id UUID PK
provider TEXT NOT NULL
event_id TEXT NOT NULL
event_type TEXT
payload JSONB NOT NULL                              -- never a secret; headers not stored
signature_verified BOOLEAN NOT NULL
intent_id UUID REFERENCES banking_payment_intents(id)
status TEXT NOT NULL DEFAULT 'received'
request_id TEXT
received_at / processed_at TIMESTAMPTZ
UNIQUE (provider, event_id)
```

**`banking_state_transitions`** — canonical state history, append only.

**`banking_account_verifications`** — status, provider, provider reference,
timestamp, method, result, failure reason. Verification is a *recorded event*,
never inferred from a well-formed account number.

**`banking_capability_approvals`** — provider, capability, environment,
approved-by, reason, evidence reference, timestamps. This is what gate 4 reads.
Absent = not approved.

### 3.7 API changes

**No new customer-facing endpoint, and no renamed one.**

The spec suggests `POST /v1/wallet/topups`, `/v1/wallet/withdrawals`,
`/v1/business/payouts`. TitoPay already has provider-neutral equivalents that
the PWA calls today:

| Spec suggests | Exists already | Provider-neutral? |
|---|---|---|
| `POST /v1/wallet/topups` | `POST /v1/payments/topup` | yes |
| `POST /v1/wallet/withdrawals` | `POST /v1/payouts/withdrawals` | yes |
| `POST /v1/business/payouts` | `POST /v1/payouts/withdrawals` | yes |

**Recommendation: keep them.** They already satisfy the intent — no
`/v1/absa/topup` exists or is proposed. Renaming would change a live contract
the PWA depends on, for cosmetic gain, and the spec forbids modifying the PWA
unless required. Flagged as a deliberate deviation for your decision.

One new **internal** endpoint:

```
POST /v1/webhooks/banking/:provider     unauthenticated, signature-verified
```

Kept separate from `/v1/webhooks/provider` so a new bank's callback contract can
never destabilise the working Peach path. It needs the same raw-body preservation
already configured in `src/app.js` for `/v1/webhooks/provider`.

Admin, read-only:

```
GET /v1/admin/banking/providers          capabilities, environment, flags, health
GET /v1/admin/banking/intents            recent intents, filterable by state
GET /v1/admin/banking/events             recent callbacks
```

No "credit wallet" control. No credential is returned by any of them.

### 3.8 Environments and feature flags

```
BANKING_INTEGRATION_ENABLED   default false
BANKING_ENVIRONMENT           development | staging | production   (no default)
BANKING_PROVIDER              none (default) | absa_pay | ...
ABSA_ENABLED                  default false
ABSA_ENVIRONMENT              sandbox | production   (no default; NOT_CONFIRMED for production)
ABSA_CUSTOMER_PAYMENT_ENABLED default false
ABSA_ACCOUNT_INFORMATION_ENABLED default false
ABSA_ACCOUNT_VERIFICATION_ENABLED default false
ABSA_WITHDRAWAL_ENABLED       default false   -- NOT CONFIRMED that Absa supports this
ABSA_PAYOUT_ENABLED           default false   -- NOT CONFIRMED that Absa supports this
```

Credentials (client id, secret, certificates, keys) are read by
`absa-pay-service.js` from server-side configuration at call time. Per
`test/provider-boundary.test.js`, **no file in `src/providers/` may read a
credential** — that test greps for `process.env.*SECRET|KEY|TOKEN|PASSWORD` in
that directory and fails the build. The design respects it.

Nothing reaches the PWA. No bank API is ever called from a browser.

Extension to `config/deployment-safety.js`, honouring the existing warn/block
split:

- **blocking** — `BANKING_ENVIRONMENT` contradicts `TITOPAY_ENV`; `ABSA_ENVIRONMENT=sandbox` while `TITOPAY_ENV=production`; any capability enabled in production without an approval record
- **warning** — `BANKING_INTEGRATION_ENABLED=true` with no provider; provider selected with credentials missing

A missing variable never blocks. That rule is not negotiable after the build 54 outage.

### 3.9 Security model

- Signature verification per provider, `timingSafeEqual`, over the **raw** body
- Replay window on the callback timestamp; unique `(provider, event_id)`
- Fail closed: unverifiable callback -> 401, nothing recorded beyond the rejection
- Response bodies carry no internal detail; operator detail goes to the log
- Structured logs with `request_id`, `transaction_id`, `provider_transaction_id`,
  `intent_id`, `canonical_state`. **No credential, no full payload, no PAN, no account number** — account numbers logged masked, last four only
- Admin surfaces are RBAC-gated. Any manual reconciliation action requires a
  written reason and writes an immutable audit row, matching
  `resolveReconciliationException()` today

### 3.10 Reconciliation model

`runProviderReconciliation()` is already provider-neutral and is reused as-is.
The banking layer adds a `reconcile()` adapter operation that **fetches** the
provider statement and normalises it to the `{reference, amount, state}` shape
that function already accepts. Four-way comparison: TitoPay transaction,
provider transaction, ledger entry, settlement record. Every disagreement becomes
an exception in the existing queue. Nothing is auto-repaired.

---

## 4. Absa reference adapter — the seam

`src/services/absa-pay-service.js` is where `PaymentConsentRequest`,
`RequestConsentResponse`, `PaymentInstruction` and `PaymentStatus` would live.
`banking-provider.js` would map them to TitoPay's words and canonical states.

**Every one of the following is `NOT CONFIRMED` and cannot be written without
the documentation:** base URLs (sandbox and production), authentication scheme
and token lifetime, mTLS/certificate requirements, request and response schemas,
the consent lifecycle and its expiry, callback delivery schema, callback
signature algorithm and canonicalisation, the provider status vocabulary, the
error/result code catalogue, idempotency semantics, retry and timeout rules,
rate limits, statement/reconciliation retrieval, and IP allow-listing.

Until it arrives, `absa_pay` registers with **no operations at all** and
`capabilities()` reports every capability `supported: false, reason:
"NOT_CONFIRMED"`. That is the same honest position `vas-provider.js` and
`POS_BANK_INTEGRATION_CONTRACT.md` already take.

**Explicitly not assumed:** that Absa Pay supports TitoPay wallet funding, that
it supports withdrawals, that it supports business payouts, that it supports
settlement banking, that all account types work, or that production access is
approved. A merchant payment API does not establish any of them.

---

## 5. Backward compatibility

Untouched by this design: `transactions`, `wallets`, `wallet_ledger`,
`revenue_ledger`, `pricing_rules`, every existing route, `peach-*` services,
`src/pos/`, the PWA, the admin console's existing pages, authentication, KYC,
fees, and limits.

`src/providers/index.js` needs **no edit at all** — `BANKING` is already a
declared capability and `registerProvider` already accepts it.

Regression proof required before Phase 3 is called done: API suite green
(790/790 at the time of this audit) and the root browser suite green.

---

## 6. Deviations from the spec, for your decision

| # | Spec asks | Proposed | Why |
|---|---|---|---|
| D1 | a new Banking Integration Layer | extend `src/providers/` | that layer already exists, is test-enforced, and already names `banking`; a second one is the duplicate financial system the spec forbids |
| D2 | `POST /v1/wallet/topups` etc. | keep `POST /v1/payments/topup` etc. | already provider-neutral; renaming breaks a live PWA contract for no safety gain |
| D3 | feature flags | new server-read flags, not `platform_settings.feature_flags` | the existing flag mechanism is enforced nowhere (gap G2) |
| D4 | canonical state machine | sidecar table, `transactions.status` unchanged | that column is core, widely read, and trigger-protected |

---

## 7. Production readiness

Every capability, every provider: **NOT READY.**

Absa specifically: **NOT CONFIRMED** on all eleven capabilities — no
documentation, no credentials, no sandbox access, no commercial agreement
evidenced in this repository, no regulatory confirmation.

Nothing in this design activates a production provider. The default for every
new flag is off, and `none` is the shipped default adapter.

---

## 8. Test plan for Phase 5

All twenty scenarios from the spec, against a **fake bank** in-repo (never Absa's
real sandbox until credentials exist): success, failure, consent rejected,
consent expired, timeout, provider unavailable, in-doubt, duplicate callback,
duplicate payment request, amount mismatch, currency mismatch, invalid provider
reference, unknown transaction, callback replay, status reconciliation, wallet
credited exactly once, payout unavailable, withdrawal unavailable, flag disabled,
production rejecting sandbox config.

Plus concurrency: N parallel callbacks for one intent must produce exactly one
credit; interleaved poll/callback/return must produce exactly one credit. Plus an
extension of `provider-boundary.test.js` adding `absa` to `PROVIDER_NAMES` and
`banking-provider.js` to the brand-free assertions.

---

## 9. What is needed before Phase 4

1. **The Absa Pay documentation** — the whole `NOT CONFIRMED` list in section 4
2. **Sandbox/playpen credentials** and how they are to be supplied (never committed)
3. **Which capabilities Absa has actually agreed to**, in writing: payment initiation only, or also account information, verification, withdrawal, payout
4. **A decision on D1-D4** in section 6

---

## 10. Status

Phase 1 complete. Phase 2 complete. **Phases 3 to 7 not started.**
Awaiting review.
