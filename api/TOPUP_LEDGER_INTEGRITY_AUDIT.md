# Failed top-ups appearing as money received — audit and remediation

## 1. Root cause

**The wallet was never credited. The statement was counting attempts.**

A top-up transaction row is created *before* Peach is contacted, deliberately, so
the attempt is auditable and idempotent:

```
peach-checkout-service.js  createTopupCheckout()
  INSERT INTO transactions (... status) VALUES (... 'pending', 'credit', ...)   <- attempt recorded
  POST {peach}/v2/checkout                                                      <- fails: domain not allowlisted
  UPDATE transactions SET status='failed'                                       <- attempt closed
```

The wallet is credited in exactly one place, and only against a verified
provider success:

```
peach-checkout-service.js  settleTopupTransaction()
  SELECT * FROM transactions WHERE id = $1 FOR UPDATE
  if (verified.providerState !== "successful") -> update status, return { credited: false }
  if (amount mismatch)                          -> status 'processing', requiresReview, no credit
  if (a credit ledger row already exists)       -> no second credit
  applyWalletMovement(credit, amount)           <- the only wallet credit in the file
```

So a `PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED` failure produces a transaction row
and **no ledger entry and no balance change**.

The statement, however, was built from the raw transaction list:

```
app.js  filteredTransactions()   – filters on search, direction and date. No status filter.
app.js  statementPdf()           – totalIn = items.filter(transactionIsCredit).reduce(...)
app.js  statementAmountNumber()  – return Math.abs(Number(item.total || item.amount || 0))
```

Two defects, both in reporting:

**D1 — attempts counted as money.** No status or ledger filter anywhere between
the transaction list and TOTAL IN.

**D2 — the wrong field for credits.** `total` is `amount + fee`. The wallet is
credited `amount`; the R6 top-up fee rides on the card charge and never enters
the wallet. That is exactly the R506 and R206 lines on the statement: R500 + R6
and R200 + R6. Even had all eight succeeded, TOTAL IN would have been overstated
by R48.

`8 × R6 = R48`, and `4 × R506 + 4 × R206 = R2 848` — the reported figure, to the
cent, from attempts that moved nothing.

## 2. Was the wallet balance actually credited?

**No — not by this fault.** The code above cannot credit without a verified
`successful` from Peach, and checkout creation failing throws before settlement
is ever reached.

That is the code's answer. For *your* production data, run the read-only audit
in section 6 — I cannot see your database from here, and this is not a question
to answer by inference.

The decisive figure the audit prints is whether each wallet's recorded
`available_balance` equals the sum of its own `wallet_ledger`. If it does, no
money was created, whatever the statement printed.

## 3. Lifecycle — before and after

| Step | Before | After |
|---|---|---|
| 1. Payment transaction created | `status='pending'` before Peach is called | unchanged |
| 2. Wallet ledger entry | only on verified success | unchanged |
| 3. Wallet balance changed | only on verified success | unchanged |
| 4. Marked successful | only on verified success | unchanged |
| 5. Included in Activity | **any status, shown as +R506 in credit green** | shown, but an unposted attempt gets no `+`, no credit colour, and reads "attempted, no money moved" |
| 6. Included in statements | **any status** | only rows the ledger posted; attempts listed below the closing balance, labelled, excluded from totals |
| 7. Included in TOTAL IN / NET | **any status, at `amount + fee`** | posted ledger movement only, at the posted amount |

Steps 1–4 were already correct and are untouched. Only 5–7 changed.

## 4. The eight affected records

I cannot read your production database from this environment, so I will not
invent transaction IDs. Run:

```bash
cd ~/api                       # wherever the API is deployed
node scripts/audit-topup-integrity.js --wallet 9152641376
```

For every top-up it prints exactly what you asked for: TitoPay transaction ID,
status, amount, provider reference, the Peach evidence held against it, the
ledger entry ID, whether the wallet was actually credited, and whether it
belongs on a statement. It flags anything genuinely wrong:

| Flag | Meaning |
|---|---|
| `CREDITED_WITHOUT_PEACH_CONFIRMATION` | money posted with no verified success — **escalate** |
| `CONFIRMED_BUT_NOT_CREDITED` | Peach confirmed but no ledger entry — customer is owed |
| `CREDIT_AMOUNT_MISMATCH` | credited an amount other than the transaction amount |
| `MULTIPLE_LEDGER_ENTRIES` | a possible double credit |
| `FLAGGED_FOR_REVIEW` | an amount mismatch the API already parked |

Expected result for these eight, given the code: status `failed` or `pending`,
Peach evidence `failure=PEACH_MERCHANT_DOMAIN_NOT_ALLOWLISTED` or
`providerState=created`, ledger entry `NONE`, wallet credited `NO`, on statement
`NO`, and no flags.

## 5. Files corrected

| File | Change |
|---|---|
| `api/src/services/transaction-service.js` | `listTransactionsForUser` now joins `wallet_ledger` and returns `wallet_posted` and `posted_amount` — the signed amount the balance actually moved by — per transaction |
| `app/app.js` | statement, payout report, CSV and Activity derive money from `wallet_posted` / `posted_amount`; credits total `amount`, never `amount + fee`; unposted attempts are disclosed in their own labelled block with zero financial effect; transaction detail gained a "Wallet movement" line; a session-expiry payment failure now says money is unaffected |
| `app/app.min.js` | regenerated |
| `app/index.html`, `app/service-worker.js` | cache `v282` → `v283` |
| `api/scripts/audit-topup-integrity.js` | **new**, read-only |
| `api/test/statement-financial-integrity.test.js` | **new**, 18 tests |

**Not changed:** Peach credentials, domain allowlisting, the payout integration,
KYC/FICA, the wallet ledger, `applyWalletMovement`, settlement, webhook handling,
fees, or any unrelated service. No database migration — the two new fields are
derived in the query and stored nowhere.

## 6. Safe reconciliation procedure

Nothing is deleted or reversed automatically, and nothing in this change writes
to historical records.

1. **Deploy the corrected build.** The statement stops misreporting immediately.
   No data changes.
2. **Audit, read-only:**
   `node scripts/audit-topup-integrity.js --wallet <number>` — and
   `node scripts/audit-topup-integrity.js` for every account.
3. **Read the balance reconciliation at the foot of the output.** If every
   wallet reconciles, there is no money to recover and no correcting entry to
   make: the records were correct and only the report was wrong. Stop here.
4. **Only if a wallet does not reconcile, or a record carries a flag**, escalate
   before touching anything. A wrong balance is corrected with a new, dated,
   audited ledger entry that states its reason — never by editing or deleting
   the original rows.
5. **Leave the eight attempts in place.** They are the audit trail of a real
   outage, and they are what proves Peach rejected the checkouts. They now
   appear on the statement as disclosed attempts with no financial effect,
   which is the accurate record.
6. **Re-issue any statement a customer already has.** The old PDF overstates
   TOTAL IN; the new one does not.

## 7. Tests — failed payments can never increase a balance

`topup-integrity-e2e.js`, against the real API, real Postgres and the Peach mock
(**26/26**):

- eight top-ups rejected exactly as production was rejected them — balance
  unchanged, ledger empty, `wallet_posted` false, `posted_amount` 0
- a declined payment — no credit
- a checkout created and never paid — no credit
- a confirmed payment — credited, and credited `amount` (R500) while `total`
  stays R506 for the card
- duplicate confirmations, webhooks and retries — no second credit

`statement-financial-integrity.test.js` (**18/18**) additionally holds the
invariants in code: exactly one `applyWalletMovement` call in the top-up
service, behind the success gate, the row lock and the ledger existence check.

## 8. Tests — only confirmed payments appear in statement totals

`statement-integrity.spec.js`, driving the **shipped minified bundle** in
Chromium with the exact eight rows from the reported statement (**20/20**):

- TOTAL IN is `+R 500.00`; the string `2 848.00` never appears in the PDF
- no `+R 506.00` credit line is ever printed
- `PERSONAL ACTIVITY (1)`, not `(9)`
- the eight attempts are disclosed as
  `UNSUCCESSFUL OR PENDING ATTEMPTS (8) - NO EFFECT ON THE TOTALS ABOVE`,
  each marked `NOT RECEIVED`
- a statement containing only failed attempts totals `+R 0.00` and says
  "No settled wallet movements were recorded"

`statement-financial-integrity.test.js` runs the real statement functions
extracted from `app.js` and proves a `completed` status cannot override a ledger
that posted nothing, that a credit totals `amount` and a debit totals `total`,
and that the statement net always equals the sum of posted ledger movement.

---

## Addendum — Admin Transaction Monitoring

The same defect appeared on the Operations console, where the eight rejected
attempts showed **FEES IN VIEW R48.00** and **NEEDS REVIEW 8**.

`REVENUE RECORDED R0.00` and the eight `Failed` statuses were correct: no money
and no revenue. The other two were the attempted-versus-actual confusion again.

| Symptom | Cause | Now |
|---|---|---|
| `FEES IN VIEW R48.00` | summed `row.fee` over every visible row; a fee on a failed attempt was *quoted*, never charged | tile is **Fees Charged**, summed over rows the ledger posted |
| `NEEDS REVIEW 8` | `reconciliation_status` compared a quoted fee against zero collected revenue, so every failed attempt looked like a break | a transaction with no ledger entry reconciles as `not_settled` — nothing to reconcile |
| `Reverse` offered on a failed row | the button was rendered for any non-reversed row | offered only for `completed` rows with a posted ledger entry |

Two tiles were added — **Settled Movements** and **Attempts (no money moved)** —
so the split is visible without reading the table, and the Amounts column now
reads `Attempted • Fee R6.00 not charged` on an unsettled row.

`reverseTransaction` was **already** safe and is unchanged: it refuses anything
that is not `completed` (409) and anything with no ledger entries (409). The
button was misleading, not dangerous, and a test now drives that 409 and
confirms no ledger entry appears.

### A real gap this surfaced

With the false positives gone, `NEEDS REVIEW` dropped from 8 to **1** — and that
one is genuine. A **settled** top-up charges the R6 fee inside the R506 card
charge, but no `revenue_ledger` row is written for it, so `revenue_recorded`
stays R0.00 against a `fee` of R6.00. Verified directly:

```
status     service_code   fee    revenue
completed  wallet_top_up  6.00   0
completed  wallet_top_up  6.00   0
completed  wallet_top_up  6.00   0
```

This is revenue recognition, not customer money — no wallet is wrong and no
customer is affected. **I have not changed it**, because it means writing to the
revenue ledger inside settlement, which is on the do-not-modify list. The
reconciliation flag is now doing its job and pointing at it; it is your call
whether TitoPay should record that fee as revenue at settlement.
