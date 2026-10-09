# TICKETROOM

**Your event. Your ticket.** · ticketroom.co.za · *Powered by TitoPay*

TicketRoom is a South African platform for event ticketing, QR entry, RFID/NFC/QR tags and cashless payments. It is an isolated package inside the TitoPay repository: **it changes no TitoPay file** and uses its own database.

> ⚠ **Not production-ready.** Payments, email and SMS are **SIMULATED**. NFC hardware is untested. Legal sign-off on prepaid balances is outstanding. See [`docs/PILOT-ACCEPTANCE.md`](docs/PILOT-ACCEPTANCE.md) and [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Portals

| URL | Who | What |
|---|---|---|
| `/` | Everyone | Event discovery (featured, categories, cities, dates), event pages, all-in pricing, checkout, order status |
| `/account` | Attendees | Ticket wallet with QR (works offline), orders, **ticket transfers**, tags & wristbands, cashless wallets and top-ups, refunds, support, privacy (export/delete), spending PIN, marketing preferences |
| `/organiser` | Organisers | Dashboard, event setup, ticket types and releases, promo codes, tracking links, **analytics**, orders and refunds, attendees (CSV), staff, vendors and POS terminals, **email and SMS marketing**, **finance and payouts**, team roles, bank details |
| `/scan` | Event staff | Camera QR, Web NFC and manual gate scanning with live counts; tag registration desk (link, replace, block) |
| `/pos` | Vendors | Phone POS: product grid, tag charge via QR/NFC, PIN pad, approvals, uncertain-outcome recovery, history, refund requests, summary |
| `/admin` | TicketRoom team | Approvals, users and roles, order/ticket lookup, tags (batch mint/import), terminals, support, **refunds, payouts, payments and webhooks, reconciliation, ledger** (finance), audit log, messages |

## Quick start (development)

Requires Node 22+ and PostgreSQL 16.

```bash
cd ticketroom
npm ci
# a local database (adjust to your setup)
createuser -d ticketroom -P          # password: ticketroom_dev
createdb -O ticketroom ticketroom
npm run migrate
node scripts/make-seed-posters.js    # optional: demo poster images (needs Playwright's Chromium)
npm run seed                         # demo data; prints logins; refuses in production
npm start                            # http://127.0.0.1:8080
```

All demo accounts use password `TicketRoom!2026`: `admin@`, `finance@`, `support@`, `organiser@`, `staff@`, `vendor@` and `fan@ticketroom.test`. The POS terminal key and demo tag codes are written to `var/seed-credentials.txt`.

To try a purchase: sign in as `fan@…`, buy a ticket, approve it on the **simulated provider** page, and the tickets appear under **My tickets**.

## Tests

```bash
npm run check      # syntax gate (server CJS + browser ESM)
npm test           # 68 API integration tests on a fresh PostgreSQL database per file
npm run test:ui    # browser walkthrough of all portals (server running on a freshly seeded DB)
```

`TEST_ADMIN_DATABASE_URL` (default `postgres://ticketroom:ticketroom_dev@127.0.0.1:5432/postgres`) must be able to create the `ticketroom_test` database.

## Layout

```
server.js               entry (HTTP + background workers)
src/app.js              middleware and route mounting
src/config.js           environment (refuses unsafe production config)
src/db/migrations/      5 reversible migrations (tr, tr_meta, sim_provider schemas)
src/lib/                db/tx, double-entry ledger, hash-chained audit, crypto, money, validation, rate limit
src/middleware/         security headers, sessions, CSRF, tenancy/role checks
src/modules/            orders, payments (+provider adapters), tickets, tags, cashless, pos, finance, marketing, messaging
src/routes/             public, auth, account, organiser, staff, pos, admin, webhooks
public/                 six portal pages + assets (no build step, strict CSP)
tests/                  node:test API suites    tests-ui/  Playwright walkthrough
docs/                   assessment, architecture, API, permissions, payments & ledger, security,
                        hardware, operations, compliance, integrations, pilot acceptance, limitations, test report
```

## Documentation

| Deliverable | File |
|---|---|
| 1 Repository & infrastructure audit · first-response assessment | [`docs/00-ASSESSMENT.md`](docs/00-ASSESSMENT.md) |
| 2–3 Architecture, data model, ERD · 6 tag-linking flow | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| 4 API specification | [`docs/API.md`](docs/API.md) |
| 5 Payment & cashless sequences · 11 provider integration · 12 ledger & reconciliation | [`docs/PAYMENTS-AND-LEDGER.md`](docs/PAYMENTS-AND-LEDGER.md), [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) |
| 7 Role & permission matrix | [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) |
| 8 Migrations | [`src/db/migrations/`](src/db/migrations) |
| 9 Automated tests · results | [`tests/`](tests), [`tests-ui/`](tests-ui), [`docs/TEST-REPORT.md`](docs/TEST-REPORT.md) |
| 10 Threat model | [`docs/SECURITY.md`](docs/SECURITY.md) |
| Hardware plan | [`docs/HARDWARE.md`](docs/HARDWARE.md) |
| 13 Deployment & rollback · 14 environment variables · 15 monitoring & incidents | [`docs/OPERATIONS.md`](docs/OPERATIONS.md), [`.env.example`](.env.example) |
| 16 Compliance checklist | [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) |
| 17 Pilot acceptance report | [`docs/PILOT-ACCEPTANCE.md`](docs/PILOT-ACCEPTANCE.md) |
| 18 Known limitations & risks | [`docs/LIMITATIONS.md`](docs/LIMITATIONS.md) |
