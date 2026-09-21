# TitoPay Compliance & Money Integrity Readiness Report

Date: 14 August 2026 · API build 16 · App v390 · Console v83
Status: engineering controls implemented and verified; legal and compliance decisions outstanding as listed in section 4.

## 0. What changed in build 16 (the limit engine)

Limits are no longer a substitute for knowing the customer. One engine
(`limit-engine.js`) builds every effective limit in a fixed order:
**verification → product → earned standing → risk**, with risk applied last
so it always wins. A level with no fixed limit still gains real boundaries
under high risk; a product profile can only narrow, never widen.

- **Basic Verified is now a genuinely usable everyday wallet** (R100,000 a
  month in and out, R25,000 per payment by default), while per-payment
  friction — the control that costs honest customers least and fraud most —
  is kept.
- **Unverified is coherent**: the wallet balance cap no longer exceeds what
  the account may receive.
- **Earned capacity**: account age plus a clean record plus no open case
  lifts fixed limits by a configured multiple, so regulars stop living
  against a wall.
- **Refusals quote remaining capacity** ("The most you can send in one
  payment right now is R25,000.00") and never invoke FICA, SARB or "the
  law". A test enforces this, with word boundaries, because *Verification*
  itself contains the letters f-i-c-a.
- **A recipient's limits are never disclosed to a sender.** Instead:
- **Money is held, not lost.** A payment that fails only on the recipient's
  receiving capacity completes for the sender and is **held** for the
  recipient: never credited to a spendable balance, released the moment
  they verify, and returned to the sender **in full including the service
  fee** if unclaimed within the configured window. Release and return each
  happen exactly once under a row lock.
- **Monitoring follows the money**: a held credit does not enter the
  recipient's transaction monitoring until it is actually released.
- **Configuration is versioned and reversible** from the console, with a
  reason on every change and one-click restore.

This report does NOT declare TitoPay "FICA compliant" or "SARB compliant". It records which controls exist in the software, which are configuration awaiting the compliance team's values, which decisions belong to legal and compliance, and what remains to remediate. Regulatory applicability depends on TitoPay's actual regulatory classification, products, payment flows and regulated partners, which this document does not assume.

---

## 1. Implemented controls

### Central compliance and risk engine (`api/src/services/compliance-service.js`)
- One engine consumed by every money rail: transfers, gifts, stokvel contributions, payment requests and bill splits, withdrawals, card top-ups. No feature carries its own KYC or fraud rules.
- KYC status and risk status are independent axes. KYC: Unverified / Basic Verified / Fully Verified with nine customer-status states (including Verification Required, Under Review, EDD Required, Verification Failed, Restricted, Suspended). Risk: normal / elevated / high_risk / edd_review, escalation-only by signal; only a recorded compliance decision lowers it.
- Identity verification for South African and foreign customers: SA ID (validated locally), passport (issuing country + date of birth) or another approved document. Document numbers are stored ONLY as salted SHA-256 hashes; document type and issuing country are stored; every verification writes a `kyc_verifications` history row. Wording is "Identity verified", never "SA ID verified". No SA-citizen assumption anywhere.
- Risk signal taxonomy (all configurable): unusual activity, transaction patterns, velocity, sanctions screening, source of funds, EDD triggers, manual decisions, failed logins, device risk, account takeover, duplicate accounts, chargebacks, refund abuse, money integrity. Unknown signal types default to "elevated" so new detectors ship without code changes.
- Transaction monitoring after every completed movement: velocity (count and amount per 24h), structuring shape (repeated payments near the single-payment limit), EDD value marks (optional and nullable — EDD never rests on a fixed amount alone), ongoing CDD cycles for fully verified customers.
- Sanctions screening: compliance-maintained list, matched by normalised name or document hash, on verification and by on-demand sweep. A match escalates to high risk with the match recorded; potential matches can never be silently ignored (they are open flags until decided).
- Anti tipping-off: internal risk ratings are never exposed to customers; only customer-safe states surface in the app.

### Money Integrity Engine (`api/src/services/money-integrity-service.js`) — new in build 15
- The wallet_ledger is the financial source of truth; displayed balances are projections. The engine proves they agree.
- Integrity sweep (every ~30 minutes in the worker, on demand via admin API) detects: balance vs ledger mismatch, duplicate postings, orphan completed transactions with no ledger entries, unbalanced multi-leg entries (transfer legs must net to zero), negative balances, stale in-flight payments (webhook/return never arrived), and provider states parked for review (`amount_mismatch`, `submission_uncertain`).
- Findings are deduplicated alerts that stay open until resolved with a stated note; a resolved alert whose condition recurs re-opens itself. High and critical alerts are audit-logged and, once an escalation address is configured, emailed to authorised personnel.
- The engine observes and never repairs: it cannot write to wallets or the ledger (pinned by test).

### Transaction state machine
- Every `transactions.status` transition is recorded by a database trigger into `transaction_status_history`, in the same database transaction as the change — no code path can change a status silently, including future code.
- `reversed` is terminal, enforced at the database level: the trigger refuses to resurrect a reversed transaction.
- The allowed-transition map is exported (`ALLOWED_STATUS_TRANSITIONS`) for rails to consult.

### Reconciliation
- Internal sweep runs recorded in `reconciliation_runs` with counts and findings.
- Provider reconciliation: statements (JSON entries) matched against internal records by reference / checkoutId / payoutId; disagreements (amount mismatch, missing settlement, unexpected settlement, unmatched provider transaction) land in `reconciliation_exceptions` — an exception queue with investigation status, resolution notes and audit history. Nothing is auto-corrected, ever.

### Limits engine
- All limits configurable per level under `platform_settings` (`compliance_tier_limits`): monthly receive/send, single transaction, daily send, single withdrawal, monthly withdrawal, wallet balance cap. Enforced on every rail including top-ups (balance headroom before the card page) and withdrawals (before provider work).
- Every limit change requires an authorised administrator AND a stated reason; the audit record carries reason, previous values and new values together. No amount is presented as statutory; customer-facing copy carries the RMCP disclaimer.

### Account and device security → risk
- Account lockouts feed the risk engine as `failed_logins` signals (fire-and-forget; the login path never depends on the risk engine answering).
- A document reuse attempt (registering an ID/passport already anchoring another account) is refused AND flags the attempting account as `duplicate_account`.
- Existing controls retained: trusted devices, remote logout, session revocation, security logs, PIN attempt logging, account lockout thresholds.

### Case management
- Every risk signal is a `compliance_flags` row; flags now carry assignment (`assigned_to`), severity, case type and a recorded decision. Admin endpoints: list/filter cases, assign, decide (decision + note mandatory). Deciding the last open case clears EDD/risk through the same rules as flag resolution. All moves audit-logged.

### Admin and employee fraud protections
- Role-based access on every endpoint (`requireAdminPermission` / `requireSuperAdmin`).
- There is NO admin endpoint that can set, credit or debit a wallet balance — verified by audit and pinned by test. The only money-moving admin action is transaction reversal, which: derives its inverse postings from the actual ledger (cannot create money), records a reason, is audit-logged, and always raises a standing `manual_reversal` integrity alert for second-person visibility.
- Immutable audit trail: who, what, when, where, metadata (secrets scrubbed), with system/admin/customer actor types, for every compliance, security and financial event.

### Regulatory reporting workflow
- `regulatory_report_events` records trigger, review, decision, submission reference, date and responsible person. Report types are free text mapped by compliance to TitoPay's actual obligations — no report type or obligation is hard-coded (pinned by test).

### Dashboards
- `GET /v1/admin/compliance/overview`: KYC distribution, risk distribution, open flags by type, open integrity alerts by severity, open reconciliation exceptions, restricted/suspended accounts, failed/reversed/refunded/cancelled transactions (30 days).
- `GET /v1/admin/integrity/alerts`, `GET /v1/admin/integrity/reconciliation`, `GET /v1/admin/compliance/cases`, `GET /v1/admin/compliance/reports`.
- Dry-run decisioning for support: `POST /v1/admin/compliance/transaction-check` returns what the engine would decide, changing nothing.

### Customer UI (unchanged wallet)
- The wallet shows only: verification status badge, Limits & Verification (usage + all five limit types + RMCP disclaimer), required actions, and customer-safe compliance notices. No risk scores, no fraud rules, no investigation detail, no "FICA compliant" language.

---

## 2. Configurable controls (compliance sets the values)

| Configuration | Where | Default |
|---|---|---|
| Tier limits (7 limit types × 3 levels) | `platform_settings.compliance_tier_limits` | engineering placeholders, NOT policy |
| EDD value marks (nullable = off) | same key, `edd.*` | 100000 / 500000 |
| Monitoring thresholds (velocity, structuring) | same key, `monitoring.*` | 30 tx / R150k / 5 near-limit |
| Ongoing CDD cycle | same key, `cdd.reviewMonths` | 24 months |
| Pre-limit prompt share | same key, `promptAtPercent` | 80% |
| Risk signal → status mapping | same key, `riskSignals.*` | see service |
| Accepted identity document types | same key, `identity.documentTypes` | sa_id, passport, other |
| Stale in-flight window, sweep scope, net tolerance | `platform_settings.money_integrity_config` | 24h / 500 wallets / R0.01 |
| Integrity escalation email | same key, `escalationEmail` | unset (must be configured) |
| Sanctions screening list | `compliance_screening_list` via admin API | empty |

---

## 3. Money integrity findings (from the build-15 audit)

1. **Two services bypass the sanctioned ledger writer.** `enterprise-distribution-service` and `titokids-service` post ledger rows with raw SQL instead of `applyWalletMovement`. They DO write ledger entries (the sweep verifies their sums), but they re-read balances instead of using the atomic RETURNING path. Remediation: refactor both onto `applyWalletMovement`. Risk now: low (monitored by sweep).
2. **`wallet_ledger` has no uniqueness constraint.** Duplicate postings are structurally possible; the sweep detects them within its window. Remediation: after a clean production sweep period, add a unique index on `(transaction_id, wallet_id, entry_type, reference)`.
3. **Provider webhook processing is fire-and-forget.** The HMAC-verified provider webhook processes via `setImmediate` with no retry queue; a processing crash loses the event. Mitigated by: the stale in-flight sweep now surfaces any resulting stuck payment. Remediation: queue webhook events with retries.
4. **Payout webhook is unauthenticated by design** (it only names a payoutId; TitoPay re-queries the provider before acting). Acceptable pattern; keep.
5. **First production sweep will surface history.** Wallets whose balances predate full ledgering (seeded, promotional or migrated balances) will raise `balance_mismatch` alerts. This is discovery, not malfunction: each needs a one-time investigation and a resolution note, or a documented opening ledger entry.
6. **No dual authorisation yet** for reversals or limit changes: single authorised admin + mandatory reason + audit + standing alert. Remediation: approval workflow (second admin) for reversals above a configured amount and for limit changes.

## 4. Outstanding legal / compliance decisions (not engineering)

- TitoPay's regulatory classification, licences/registrations, and which FIC / SARB / NPS obligations apply — determines which regulatory report types are configured.
- The real limit values, EDD triggers, monitoring thresholds and CDD cycle per the approved RMCP (current numbers are engineering placeholders).
- Responsibility boundaries with regulated partners (issuing, acquiring, settlement, and any partner-performed KYC) — to be documented per partner agreement.
- Sanctions screening source (current: internal compliance-maintained list; a commercial screening provider can replace the matcher without downstream changes).
- Retention and deletion periods for KYC records, audit logs and compliance cases.
- The escalation address (or channel) for high/critical integrity alerts.
- Whether document images / liveness-biometric verification are required at Basic or only Full verification, and which vendor performs them (the data model stores outcomes, not images; secure document storage for uploads exists in the FICA flow).

## 5. Payment-partner dependencies

- Card top-ups and payouts settle through Peach Payments; reconciliation of provider statements uses the new exception queue and depends on statement availability from the partner.
- Value-added services (airtime, data, electricity) settle through their providers; those flows are provider-dependent and return honest unavailability rather than simulating success.

## 6. Deployment blockers

None in code. Before relying on the framework operationally:
1. Configure the integrity escalation email.
2. Have compliance set real limit/monitoring values via the admin API.
3. Triage the first production sweep's findings (expect historical balance_mismatch discovery).

## 7. Verification evidence

- 556/556 automated tests, including 12 architecture pins on the integrity engine.
- 10/10 money-integrity live checks on the real API (duplicates, orphans, mismatches, re-opening alerts, status history, terminal reversed, stale in-flight, reconciliation exceptions, case decisions, audited limit changes, duplicate-document flags).
- 12/12 progressive-KYC live checks (including foreign passport flow), 12 payment-request checks, 9 hardening checks, 5 notification checks — all passing with the status trigger active, proving the existing rails are unbroken.
- Static audit: no hard-coded FICA thresholds in enforcement paths, no "FICA/SARB compliant" claims, no statutory language outside "not statutory" disclaimers, no admin balance-mutation surface, no compliance rules that exist only in the frontend.
