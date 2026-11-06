# TicketRoom — Phase 0 assessment and first milestone

Prepared on branch `claude/ticketroom-platform`, 9 October 2026. Everything here comes from the repository and from running it. Nothing is assumed about systems I could not see.

## 1. Infrastructure findings

### What exists in this repository (`titopay-art/titopay-app`)

| Item | Finding |
|---|---|
| Contents | The **TitoPay PWA only**: a static front end (`index.html`, a 742 KB `app.js`, `styles.css`, service worker, manifest, assets). It has no build step, and the repository root is the deployed artefact. |
| Deployment | Afrihost static hosting at `app.titopay.co.za` (`DEPLOYMENT-AFRIHOST.md`). The upload order matters, and the service worker goes last. |
| API | The PWA calls `https://api.titopay.co.za` (54 endpoints). **The API source code is not in this repository.** |
| Ticketing | TitoPay already calls a ticketing module: `/v1/ticketing/public/events`, `/v1/ticketing/business/events`, `/v1/ticketing/scanner/validate`, `/v1/ticketing/eligibility`. These are wallet-paid in-app tickets. `API-REQUIREMENTS.md` refers to `security-service.js`, `src/db/migrations/…` and `src/realtime/`, so a Node/Postgres API exists somewhere else. |
| Tests | 20 Playwright suites run against a mocked API, plus a version-consistency gate. CI is `.github/workflows/ci.yml`. |
| Database / ledger / provider | **Not visible.** I could not inspect TitoPay's schema, wallet ledger, payment-provider adapters, webhook handlers or secrets. |

### Baseline before any change

```
node --check app.js && node --check service-worker.js   OK
node tests/check-version.js                              v193 consistent
npm test (20 browser suites, mocked API)                 All suites passed (exit 0)
```

### What is missing (and why that matters)

* The TitoPay API and database. Reusing the TitoPay wallet, KYC or provider integration therefore cannot be done safely from here.
* Payment-provider documentation and sandbox credentials. No real payment adapter could be built or verified.
* Hardware samples (wristbands, cards, readers). No hardware compatibility claim can be made.
* Legal and regulatory sign-off on holding prepaid balances.

## 2. Risk assessment: effect on TitoPay

| Risk | Mitigation taken |
|---|---|
| Changing TitoPay files breaks the live PWA | **No TitoPay file was modified.** All work is in `ticketroom/`, plus one new, path-scoped workflow `.github/workflows/ticketroom.yml`. The TitoPay suite still passes afterwards (see `TEST-REPORT.md`). |
| Shared database or schema collisions | TicketRoom uses its **own database** and its own Postgres schemas (`tr`, `tr_meta`, `sim_provider`). It never touches TitoPay tables, even on a shared server. |
| Modifying the TitoPay wallet ledger | TicketRoom has its **own** double-entry ledger. Nothing is posted to the TitoPay wallet. |
| Name clash with TitoPay's `/v1/ticketing` | TicketRoom is a separate service on `ticketroom.co.za` with its own `/api/*`. TitoPay's in-app tickets keep working unchanged. Merging the two later is a product decision (see §9). |
| Secrets leakage | No secrets are committed. Production refuses to start without real keys, and `.env.example` holds placeholders only. |
| A dependency upgrade affecting TitoPay | TicketRoom has its own `package.json` and lockfile. The root `package.json` is unchanged. |

## 3. Architecture proposal: the smallest safe shape

A **modular monolith**: Node 22, Express 4, PostgreSQL 16, matching TitoPay's known stack. It is a single deployable with clear module boundaries (`src/modules/*`) and no microservices. Full detail is in `ARCHITECTURE.md`.

## 4. Payment model recommendation

| | Mode A: event-specific prepaid balance | Mode B: linked payment method |
|---|---|---|
| How it works | The attendee tops up through a hosted checkout. The balance is a ledger liability. Taps debit it. | Each tap triggers a provider charge on a stored card or token. |
| Dependence on a provider | Only for top-ups and refunds (hosted checkout, which is widely available). | Needs card-on-file or tokenised MIT charges, with fast authorisation at the till. |
| Venue connectivity | One online server call per tap (fast, internal). | A round trip to the provider per tap, which is slow and fragile on event Wi-Fi. |
| Regulatory | **Holds customer funds.** This may be treated as stored value or e-money. It needs SARB NPS/PASA assessment, segregation of funds, unused-balance refunds, and possibly a bank sponsor. | No float is held. Merchant-of-record and PCI scope sit mostly with the provider. |
| Fraud surface | Tag cloning spends the balance. This is limited by PINs, caps and instant blocking. | Tag cloning charges a card. The impact is larger, and chargebacks follow. |

**Recommendation:** build and pilot **Mode A**. It is implemented here and gated: small balance cap, PIN above R200, and refunds of unused balance to the funding card. Do **not** take real money until the legal opinion in `COMPLIANCE.md` confirms that the float arrangement is permitted, either under TitoPay's existing arrangements or through a sponsor bank. Mode B is documented as future work.

## 5. Hardware plan

See `HARDWARE.md`. In short, QR tags work today. NFC wristbands and cards work today with an **NDEF token** (via Android Web NFC or USB readers). UID-only chips are accepted as **identifiers but refused for payment**. For real-money cashless at scale, procure **NTAG 424 DNA** (AES SUN/SDM) tags and add server-side CMAC verification, which is not yet built.

## 6. Database design

43 tables across 5 reversible migrations. See `ARCHITECTURE.md` (ERD) and `PAYMENTS-AND-LEDGER.md` (ledger).

## 7. Implementation sequence (as executed)

| Phase | Status |
|---|---|
| 0 Discovery and baseline | Done (this document) |
| 1 Architecture, data model, permissions, API spec | Done (`docs/`) |
| 2 Foundation: auth, RBAC, audit, migrations, tests | Built and tested |
| 3 Ticketing MVP: events, inventory, checkout, QR, scanning, transfers | Built and tested |
| 4 Tags: QR tags, NFC NDEF, UID import, desk linking, lost/replace | Built and tested. NFC hardware **not** verified. |
| 5 Cashless pilot: top-ups, POS, ledger, refunds, reconciliation | Built and tested against the **simulated** provider only |
| 6 Hardening | Partially done: threat model, security tests, audit. Load testing, penetration testing and backup-restore drills are **not done**. |
| 7 Controlled pilot | **Not started.** It is blocked by §9. |

## 8. Testing strategy

* 68 API integration tests on real PostgreSQL. They cover concurrency (overselling, double admission, overdraft), idempotency, webhook forgery and replay, tenant isolation, maker-checker controls, ledger immutability, audit tamper detection, consent and POPIA flows.
* A browser end-to-end walkthrough of all six portals (Playwright). It fails on any console error, CSP violation or horizontal scroll at 360 px.
* The TitoPay regression suite is re-run unchanged.

Results are in `TEST-REPORT.md`.

## 9. Unresolved decisions that block a real-money launch

1. **Payment provider.** Which provider holds the TicketRoom merchant account? Is it TitoPay's existing one? I need its API docs, sandbox credentials and webhook-signing method to replace the simulated adapter.
2. **Legal position on prepaid balances** (Mode A). Who holds the funds? Is a sponsor bank or a SARB/PASA notification needed? What is the policy for unclaimed balances?
3. **Merchant of record and settlement.** Is TicketRoom (TitoPay) or the organiser the merchant? This sets refund liability, VAT treatment and payout terms.
4. **Relationship to TitoPay's `/v1/ticketing`.** Should TitoPay wallet holders be able to pay TicketRoom orders with their wallet? That would need a TitoPay-side API contract, which is out of scope here.
5. **Email and SMS gateways.** Which SMTP and SMS providers? Delivery is currently simulated.
6. **NFC hardware.** Tag model, reader model, and whether to require NTAG 424 DNA for payment.

## 10. First milestone: delivered

**Milestone:** an isolated ticketing core with QR admission, running end to end against a sandbox provider, with its correctness proven by tests.

| Acceptance criterion | Evidence |
|---|---|
| Installs from clean and migrates from an empty database | `npm ci && npm run migrate` passes. Migrations go up, down and up again, and this is tested. |
| A paid ticket is issued only on a verified provider confirmation | `ticketing.test.js` covers redirect-only, forged, stale and amount-mismatch cases |
| Inventory cannot oversell under concurrency | 20 concurrent buyers for 5 tickets give exactly 5 tickets |
| A QR admits once, including under concurrent scans | 8 parallel scans give 1 admit and 7 "already used" |
| Every money movement is a balanced, immutable journal | Database triggers, plus tests that try to break them |
| TitoPay is unaffected | No TitoPay files changed. TitoPay suite still green. |

The milestone went further than this and also delivers phases 3–5 behind the simulated provider. That is labelled throughout as **SIMULATED**.
