# Test report

Run on 9 October 2026 on branch `claude/ticketroom-platform` (Node 22.22, PostgreSQL 16.15, Chromium via Playwright 1.64).

| Suite | Result |
|---|---|
| `npm run check` (syntax: server + browser modules) | ✓ syntax ok |
| `npm test` (API integration, real PostgreSQL, fresh DB per file) | ✓ **68/68 passed** |
| `npm run test:ui` (browser walkthrough of all 6 portals; fails on console error, CSP violation or 360 px overflow) | ✓ passed, 14 screenshots |
| `npm audit --omit=dev` | ✓ 0 vulnerabilities (after Express 4.21.2 → 4.22.3) |
| **TitoPay regression**: `node --check`, `tests/check-version.js`, `npm test` (20 browser suites) | ✓ **unchanged: all suites passed**, before and after |

## Defects found by these tests and fixed during the build

1. A journal-balance trigger compared `uuid` with `bigint`, so every webhook failed. The order correctly stayed unpaid; caught by the first end-to-end purchase.
2. Free (R0) orders were fulfilled but the API returned the pre-fulfilment row (`pending_payment`).
3. The POS PIN-lockout counter used an untyped SQL parameter, giving a 500 on a wrong PIN.
4. The audit hash chain failed verification because `jsonb` reorders keys and drops `undefined`. Now uses canonical sorted-key JSON.
5. The audit redactor missed camelCase `accountNumber`.
6. Refunded buyers dropped out of an organiser's opted-in marketing audience. The audience is now based on orders.
7. UI: invisible selected tabs on dark venue screens, broken checkout line layout, an empty camera box, and a focus ring on `<main>`.

## API test cases

### `admission-tags.test.js`

- ✓ a valid ticket is admitted exactly once
- ✓ simultaneous scans of one ticket at two gates admit once
- ✓ altered or guessed QR payloads are rejected
- ✓ a ticket for another event is refused
- ✓ people who are not event staff cannot scan
- ✓ transfer moves the ticket and kills the sender's QR
- ✓ reissuing a QR invalidates the previous one
- ✓ admin can mint a QR tag batch; raw tokens are not stored
- ✓ attendee links a tag with code + activation code; duplicates are refused
- ✓ linking requires a ticket for the event
- ✓ activation code guessing locks the tag
- ✓ a linked tag admits its ticket at the gate
- ✓ staff desk links NFC wristbands by scanning ticket + tag; replacement keeps the person
- ✓ imported chip UIDs are registered as identifier-only

### `cashless.test.js`

- ✓ top-up credits the balance only after the provider confirms
- ✓ top-up limits and ticket requirement are enforced
- ✓ a POS sale charges server prices, not client prices, and posts commission
- ✓ the same request key never charges twice; a different body with that key is refused
- ✓ insufficient balance is declined and nothing is posted
- ✓ concurrent spending can never overdraw the balance
- ✓ purchases above the PIN threshold need the attendee's PIN, with lockout
- ✓ a tag reported lost stops paying immediately
- ✓ UID-only tags are refused for payment by default
- ✓ terminal and cashier must belong to the same vendor
- ✓ suspended terminals cannot transact
- ✓ POS refunds need a second person and reverse the exact journal
- ✓ unused balance is refunded to the funding top-ups via the provider
- ✓ the ledger balances and provider clearing matches captured money

### `finance-marketing.test.js`

- ✓ partial ticket refund: approve -> provider refund -> tickets void -> ledger
- ✓ a failed provider refund can be retried without paying twice
- ✓ payout availability waits for the event to end plus the hold period
- ✓ payouts: bank details required, maker-checker approval, EFT recorded in the ledger
- ✓ a payout cannot be approved by the person who requested it
- ✓ reconciliation matches clean data and flags every kind of discrepancy
- ✓ tampering with the audit log outside the application is detected
- ✓ campaign audience is only buyers who opted in for that organiser and channel
- ✓ sending a campaign queues one message per recipient with opt-out, never twice
- ✓ unsubscribing is honoured even for messages already queued
- ✓ SMS campaigns are length-checked and costed by segment
- ✓ unapproved organisers cannot send marketing
- ✓ registration, password reset and session revocation
- ✓ data export and account deletion (POPIA)

### `security.test.js`

- ✓ organisers cannot see or touch another organiser's data
- ✓ member roles are enforced inside an organisation
- ✓ attendees cannot reach staff, admin or other people's tickets
- ✓ financial approvals are separated from technical administration
- ✓ a finance officer cannot approve their own refund request
- ✓ state-changing requests need the session CSRF token and JSON
- ✓ uploads accept only real images, by content not by header
- ✓ security headers are set and errors do not leak internals
- ✓ login failures are generic and lock the account after repeated attempts
- ✓ passwords, PINs and tokens are never stored or logged in clear
- ✓ ledger and audit trail are append-only at the database level
- ✓ migrations revert and re-apply cleanly

### `ticketing.test.js`

- ✓ paid order issues tickets only after a verified provider webhook
- ✓ ledger records the sale as a balanced journal
- ✓ order creation is idempotent per key and client prices are ignored
- ✓ duplicate webhook delivery is processed once
- ✓ forged and replayed webhooks are rejected
- ✓ a provider amount that differs from the order is not accepted as payment
- ✓ concurrent checkouts never oversell
- ✓ event capacity caps the sum of ticket types
- ✓ abandoned checkout expires and releases its reservation
- ✓ expiry asks the provider first and keeps a paid order
- ✓ payment arriving after expiry with stock gone becomes paid_unfulfilled with a refund
- ✓ promo codes discount correctly and respect max uses
- ✓ free tickets are issued without a payment and with no fee
- ✓ sales close when the event is not published

## Not covered (see LIMITATIONS.md)

Real payment provider, real email and SMS delivery, NFC hardware, load and soak testing, penetration testing, backup restore, multi-instance deployment.
