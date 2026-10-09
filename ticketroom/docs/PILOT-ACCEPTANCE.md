# Pilot acceptance report

**Current status: NOT READY for a real-money pilot.** The software criteria below that can be met in a sandbox have been met with automated evidence. The rest are blocked by external decisions (`00-ASSESSMENT.md` §9).

| # | Criterion (from the Definition of Done) | Evidence | Status |
|---|---|---|---|
| 1 | Reproducible install and deploy | `npm ci` from lockfile; `OPERATIONS.md` | Install ✓. Deploy **not done**. |
| 2 | Migrations from a clean environment | Each test file builds a fresh DB. Up/down/up is tested. | ✓ |
| 3 | TitoPay regression passes | TitoPay suite re-run after the change: all 20 suites pass; no TitoPay file changed | ✓ |
| 4 | Inventory and QR correct under concurrency | 20 concurrent buyers/5 tickets; 8 concurrent scans | ✓ |
| 5 | All three tag types supported by **verified compatible** implementations | Software paths tested with simulated reader input | **Partial: hardware not verified** |
| 6 | Cashless model implemented and tested end to end | Mode A against the **simulated** provider | **Partial: real provider not integrated** |
| 7 | Ledger balances and reconciles against **authoritative provider records** | Balanced and reconciles against simulator records and CSV | **Partial: no real provider records** |
| 8 | No duplicate charges from duplicate requests | Idempotency tests (orders, POS, webhooks, refunds) | ✓ |
| 9 | Refunds and reversals auditable | Maker-checker, reversal journals, audit chain | ✓ |
| 10 | Organisers and vendors isolated | Tenancy tests | ✓ |
| 11 | Lost tags blocked promptly | Self-service block is immediate (tested) | ✓ |
| 12 | Monitoring, alerting, backups, recovery tested | Signals defined in `OPERATIONS.md` | **Not done** |
| 13 | No unresolved Critical/High security findings | Self-assessed threat model. Open: MFA, NFC cloning (payment), shared rate limiter | **Not done: needs independent pentest** |
| 14 | Provider approval and legal assessments documented | `COMPLIANCE.md` | **Open** |
| 15 | Real-money pilot explicitly approved | — | **Open** |

## Suggested pilot scope once unblocked

One organiser and one event of ≤ 500 attendees. Ticketing plus QR admission first. Cashless only with: a balance cap of R1,000, NTAG 424 DNA or QR tags with a PIN for every purchase, 2–3 vendors, and daily reconciliation, with finance sign-off before any payout.
