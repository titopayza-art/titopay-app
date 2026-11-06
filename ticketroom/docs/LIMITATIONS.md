# Known limitations and outstanding risks

Labelled honestly. Anything marked **SIMULATED** has been tested only against TicketRoom's own simulator.

## Simulated or not integrated

* **Payments are SIMULATED.** No real provider adapter exists yet.
* **Email and SMS delivery are SIMULATED** (`log` adapter).
* **NFC hardware is untested.** The NTAG 424 DNA (cryptographic) tag flow is not built.
* **TitoPay integration (wallet payments, shared login) is not built.** The TitoPay API is not in this repository.

## Functional gaps

* Reserved seating: the data model accommodates it (ticket types), but there is no seat map.
* Offline ticket admission at the gate is not built. The scanner refuses to admit when it cannot reach the server. Offline cashless is intentionally unsupported.
* Dynamic or rotating QR codes are not built. A copied current QR admits whoever arrives first.
* MFA for organisers and staff is not built (required before the pilot).
* Tax invoices with VAT numbers are not built.
* Reserved accounts for provider fees exist, but settlement-report fees are not yet posted.
* Organiser self-service date or venue changes after sales are blocked (they go via support). There is no "notify all buyers of change" tool yet.
* Waiting lists, resale marketplace, group bookings and seat holds for partners are not built.
* The external monitoring endpoint (`/api/ops/status` with a token) is not built.
* Key rotation for `QR_SIGNING_KEY` and `TAG_PEPPER` needs versioning (not built).
* Event images are not re-encoded or stripped of metadata.

## Scale and operational risks

* Rate limiting is in-memory (single instance). Use a shared store or the WAF for multiple instances.
* The checkout locks the event row. That is safe, but it serialises checkouts per event. Load-test before high-demand on-sales; consider a queue or waiting room for big drops.
* The audit-log hash chain serialises audit writes (advisory lock). Fine at pilot scale.
* No load test, penetration test, or backup-restore drill has been performed.

## Decisions outstanding

See `00-ASSESSMENT.md` §9: provider, legal position on balances, merchant of record and VAT, the TitoPay wallet relationship, the messaging gateways, and NFC hardware.
