# Sponsor Bank Structure & Money-Flow Documentation

The document a sponsor bank's partnerships, risk and settlement teams read
before the first workshop. It states plainly what TitoPay is, where money
sits, how it moves, what the bank would be sponsoring, and — candidly — what
must be decided WITH the bank rather than presented as already solved. It is
written to be read alongside the due-diligence review, not to contradict it:
where a thing does not yet exist, it says so.

## 1. What TitoPay is

A South African wallet and merchant-acceptance platform: a customer PWA, an
admin console, and a Node/Express + PostgreSQL API. Customers hold ZAR
wallets; merchants accept payment by TitoPay QR at the point of sale;
businesses run ticketing, bookings, stokvels and related services on the
same ledger. The payment core is double-entry, database-enforced, and
covered by 1,235 automated tests (see the Build 99 due-diligence review).

**Current regulatory posture (stated honestly):** TitoPay operates as a
technology and wallet platform. It does **not** hold a banking licence and
does not claim deposit-taking status. The purpose of a sponsor-bank
relationship is precisely to place customer float and settlement on a
properly sponsored, regulated footing. The float-safeguarding structure in
§3 is therefore presented as the DECISION to make with the bank, not as an
arrangement already in force.

## 2. What TitoPay asks a sponsor bank for

1. **Float safeguarding** — a trust / safeguarding account structure in
   which pooled customer wallet balances are held segregated from TitoPay
   operating funds.
2. **Settlement sponsorship** — access to clearing/settlement so merchant
   payouts reach merchant bank accounts on sponsored rails rather than
   solely through a payment processor.
3. **Scheme / interoperability positioning** — a path to EMVCo
   merchant-presented QR interoperability so TitoPay acceptance participates
   in the national QR ecosystem the bank already sits in.
4. **Regulatory umbrella** — operating under the bank's licensed permissions
   where applicable, with the compliance obligations that entails.

## 3. Where money sits today, and the target structure

**Today (pre-sponsorship):**
- Customer wallet balances are recorded in the `wallets` ledger; the
  aggregate is real customer money. As of the 22 Aug 2026 restore rehearsal
  the recorded float was **R 61,114,700.52 available, R 0.00 reserved**
  (integration dataset; production figure differs).
- Top-ups and merchant payouts to external bank accounts flow through
  **Peach Payments** (processor), not through sponsored rails. This is a
  concentration the sponsorship is intended to cure.
- A single revenue wallet accrues platform fees, booked via `revenue_ledger`.

**Target (with sponsor bank):**
- Pooled customer float held in a **bank-held trust/safeguarding account**,
  reconciled daily to the `wallets` aggregate — the reconciliation engine
  that already reconciles settlement batches extends naturally to a
  float-vs-trust daily check.
- Merchant settlement executed on sponsored rails; the Build 99 settlement
  engine already produces the reconciled, itemised, per-merchant net that
  such a payout instruction requires.

## 4. How money moves (the flows a settlement team will ask to see)

**Acceptance (POS QR):**
1. Terminal creates a payment intent (HMAC-signed request, 120-second QR).
2. Customer scans and confirms in the PWA.
3. In ONE database transaction: customer wallet debited, merchant operating
   wallet credited (gross), double-entry legs written, transaction marked
   completed. Idempotency and a unique ledger-posting index make duplicate
   credit structurally impossible.
4. `payment.completed` webhook fires to any subscribed partner, signed.

**Refund / reversal:** cumulative-accounted, refused past the original
amount, reversal refused once any refund exists — all inside one
transaction, all evented.

**Settlement (Build 99):**
1. A trading window (manual or daily/weekly/monthly at SAST midnight) is
   closed; items are derived from the ledger.
2. **Three-way reconciliation** must pass before payout: double-entry legs
   per item, POS-stream vs ledger both directions, header totals re-summed
   in SQL. A discrepancy parks the batch and raises an integrity alert.
3. Payout leg: net swept to a configured settlement wallet, or recorded as
   `realtime_wallet` where the operating wallet already holds the funds.
4. `settlement.completed` webhook fires with the itemised summary.

**External settlement to merchant bank accounts** currently runs via Peach
Payouts. **Under sponsorship this leg moves to the bank's rails** — the
engine's output (a reconciled net per merchant) is the same instruction
either way, which is what makes the migration low-risk.

## 5. Controls a bank will want catalogued

| Control | State |
|---|---|
| Double-entry ledger + unique posting index | in place, tested |
| Idempotency (POS + settlement) | in place, tested |
| Three-way settlement reconciliation | in place, tested (Build 99) |
| Money-integrity sweep + exception queue | in place |
| Dual authorization (large reversals, limit changes; self-approval refused in code + DB) | in place |
| HMAC terminal auth, replay protection, signed webhooks | in place |
| FICA/KYC | **document-based, manual review; no live KYC provider yet** |
| Sanctions screening | list-based; **refresh process manual, ownership to be assigned** |
| Backup + tested restore | in place, rehearsed 22 Aug 2026 |
| Monitoring + push alerting | in place (watchdog + external probe) |
| Incident response procedure | in place, one real incident on record |
| Independent penetration test | **not yet — scoped and ready to commission** |
| Named compliance officer | **to be appointed — a due-diligence precondition** |

## 6. Integration architecture (for the bank's technology team)

- Single deployable API (`api.zip`), replayable to production and to a
  `TITOPAY_ENV=sandbox` deployment with its own database; sandbox is
  production-identical code.
- `/v1/health` exposes build, config warnings, integrity alerts and worker
  heartbeats; the watchdog turns this into push alerts from an independent
  host.
- OpenAPI specification and four-language SDK starters exist; a POS vendor
  has been shown to integrate self-service, unaided.
- **Current topology is single-server / single-database** — the scaling and
  resilience path (managed Postgres with replicas, dedicated worker
  processes, horizontal API scaling) is documented in the due-diligence
  Section 8 and is a funded-roadmap item, not a hidden gap.

## 7. Open items to decide WITH the bank

1. Float-safeguarding account structure and the daily float-vs-trust
   reconciliation cadence.
2. Settlement rail, cut-off times, and value dating for merchant payouts.
3. Regulatory footing: which of the bank's permissions TitoPay operates
   under, and the resulting AML/CDD obligations and reporting lines.
4. KYC uplift: live identity-verification provider and the risk-based
   threshold at which enhanced due diligence triggers.
5. EMVCo QR interoperability timeline.
6. The assurance items still open above (penetration test, compliance
   officer) — all in progress, none blocking a discovery-phase conversation.

TitoPay's position: the rails, the reconciliation, and the settlement
machinery are built and tested; the safeguarding, sponsorship and regulatory
structure are exactly what the relationship is for. This document is written
to start that conversation from facts.
