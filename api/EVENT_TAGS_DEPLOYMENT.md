# TitoPay Event Tags — NFC/RFID cashless credentials

## What was built

Cashless Event Tags for the existing TitoPay Events service. An attendee is
given a physical NFC/RFID wristband or card at the gate. They tap it at any
authorised vendor at that event, and the vendor is paid **from the attendee's
own TitoPay Wallet, through the existing wallet ledger**.

### The one rule everything else follows

> **EVENT TAG ≠ WALLET.**

There is no event balance, no event top-up, no event withdrawal, no second
ledger and no event wallet. The tag is a **credential** — a random 256-bit
token that identifies which attendee is tapping and nothing else.

That single decision is what makes the rest safe:

| Because the tag holds no money… | …this is true |
|---|---|
| A lost wristband is a lost key, not a lost purse | Blocking it moves R0.00 |
| A replacement is a new key to the same house | Replacing it moves R0.00 |
| The organiser never holds attendee float | Nothing to reconcile or refund when the event ends |
| There is nothing to "unload" afterwards | No end-of-event refund run |
| Reading the database yields no working tag | Only SHA-256 hashes are stored |

---

## Status

### ✅ SOFTWARE COMPLETE

Everything below is implemented and verified against a real Postgres, the real
API, the real POS terminal signing stack, and both consoles driven in a real
browser.

### ⚠️ REQUIRES PHYSICAL HARDWARE TESTING

**No physical NFC or RFID hardware was used at any point.** Every tap in every
test was an HMAC-signed HTTP request from a registered POS terminal, which is
exactly what a reader emits *after* it has read a tag — but the read itself was
never exercised.

The following are **unverified** and must be tested with real hardware before a
live event:

1. **Reading the credential off a physical tag.** The token is 48 characters of
   base64url. NTAG213 (144 bytes usable) and MIFARE Classic 1K both have ample
   room, but this was not written to a physical chip and read back.
2. **Encoding format on the chip.** Whether the token is written as an NDEF
   text record, a URI record, or into raw sector data is an integration
   decision between TitoPay and whoever supplies the readers. The API accepts
   the token as a string in the request body and does not care how it was read.
3. **Reader-to-terminal wiring.** The reader must hand the token to software
   that can produce a valid HMAC signature (see the request contract below).
4. **Read range, collision handling and tap latency** at a real gate and a real
   bar counter.
5. **Tag write-protection.** Whether the credential should be written to a
   read-only or password-protected page, so a wristband cannot be re-written by
   an attendee with a phone. **This is a real risk and should be settled before
   the first event.**
6. **Offline behaviour at the reader.** The API refuses everything it cannot
   verify, by design — no offline spending is implemented. If a vendor's
   connectivity drops, taps fail rather than queueing. Whether that is
   acceptable operationally is a business decision, not a software one.

---

## Architecture

### Nothing new was invented

| Need | What it reuses |
|---|---|
| Terminal authentication | The existing POS `requireTerminalAuth` — HMAC-SHA256 signing, timestamp tolerance, nonce replay protection, AES-256-GCM encrypted terminal secrets |
| Idempotency | The existing `pos_idempotency_keys` table and advisory-lock pattern |
| Moving money | The existing `applyWalletMovement` and `wallet_ledger` |
| Transaction records | The existing `transactions` table, `service_code = 'event_tag'` |
| Event ownership and staff | The existing `events`, `event_staff` and `canManageEventTicketing` |
| Schema bootstrap | The existing `ensureTicketingSchema()` |
| Wallet top-up | **The customer's existing Top Up screen, unchanged.** No event top-up was built |

### Why the charge is a separate function, not a branch in `confirmPayment`

A POS QR confirm is authorised by the **customer's own token**. A tag tap is
authorised by the **terminal**. Widening `confirmPayment` to accept a
terminal-authorised debit would change the security properties of a live
integration. `chargeEventTag` mirrors its structure exactly — same locking,
same idempotency tables, same ledger calls — and leaves `pos/service.js`
untouched. A test asserts `pos/service.js` contains no reference to event tags.

---

## Database

All migrations are **additive and idempotent**. No table is dropped, no column
renamed, no data destroyed, no balance touched.

```
ALTER TABLE events ADD COLUMN IF NOT EXISTS cashless_tags_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS cashless_settings JSONB NOT NULL DEFAULT '{}'::JSONB;

CREATE TABLE IF NOT EXISTS event_tags        (...)   -- no balance column
CREATE TABLE IF NOT EXISTS event_vendors     (...)   -- which merchants may take taps at which event
CREATE TABLE IF NOT EXISTS event_tag_events  (...)   -- append-only audit trail
```

`cashless_tags_enabled` defaults to **FALSE**, so every event that already
exists behaves exactly as it did before this change. Nothing appears in any
console until an organiser switches it on.

### `event_tags` columns

`id, event_id, token_hash, tag_label, ticket_id, user_id, status, issued_at,
assigned_at, activated_at, blocked_at, replaced_at, deactivated_at,
replaced_by_tag_id, created_at, updated_at`

There is **no** `balance`, `amount`, `credit`, `loaded` or `topped_up` column,
and a test fails the build if one is ever added.

A partial unique index enforces **one live tag per ticket**:

```sql
CREATE UNIQUE INDEX uq_event_tags_live_ticket ON event_tags (ticket_id)
  WHERE status IN ('ASSIGNED','ACTIVE') AND ticket_id IS NOT NULL;
```

### Tag lifecycle

`UNASSIGNED → ASSIGNED → ACTIVE → (BLOCKED | LOST | REPLACED | DEACTIVATED)`

---

## The credential

- `ETAG_` + 32 random bytes, base64url — 256 bits of entropy.
- Returned **once**, at issue, for writing to the physical tag.
- Only its SHA-256 is stored. Reading the database yields no working tag.
- It carries **no** wallet balance, name, ID number, phone number, email
  address, credentials, or any database, user, wallet, ticket or event
  identifier. A test asserts this against live-issued tokens.
- `publicTag()` — the shape every endpoint returns — contains no token, no
  hash, and no user or wallet identifier.
- Nothing in the tag path logs anything at all, so no credential can reach a
  log file. A test asserts there are zero logging calls in the service.

---

## Endpoints

### Tap to pay — the POS lane

```
POST /v1/pos/event-tags/charge          requireTerminalAuth + Idempotency-Key
Body: { tagToken, amount, currency: "ZAR", merchantReference? }
```

The request supplies **only a credential and an amount**. It cannot name the
customer, the wallet, the event or the merchant — all four are resolved
server-side. Eleven checks run in this order, and any of them failing is a
refusal:

1. Tag exists (by hash) → yields the event
2. **The event is `approved`** — suspending an event stops its wristbands the
   same way it already stops its ticket sales, so an event pulled for fraud
   cannot keep taking money at the bar. A completed or cancelled event is over,
   and its tags stop with it.
3. Cashless is enabled for that event
4. Tag status is `ACTIVE`
5. Tag is linked to an attendee
6. **The terminal's merchant is authorised for that event** (`event_vendors`)
7. That vendor is not suspended
8. The attendee's account and wallet are active
9. The attendee's profile is **not locked** (423 if it is)
10. The vendor's settlement wallet is available
11. The balance covers the amount

Then, in one transaction: one `transactions` row, one debit, one credit.

### Organiser (owns the event)

```
POST /v1/ticketing/business/events/:id/cashless          enable / disable
GET  /v1/ticketing/business/events/:id/vendors
POST /v1/ticketing/business/events/:id/vendors           authorise a merchant
POST /v1/ticketing/business/events/:id/tags/issue        mint blank credentials
```

### Event staff (owner, or staff with the `tags` permission)

```
GET  /v1/ticketing/business/events/:id/tags
POST /v1/ticketing/business/events/:id/tags/assign       tag + ticket → ACTIVE
POST /v1/ticketing/business/events/:id/tags/:tagId/status
POST /v1/ticketing/business/events/:id/tags/:tagId/replace
GET  /v1/ticketing/business/events/:id/tags/analytics
```

### Attendee

```
GET  /v1/ticketing/tags                  their own tags, resolved from their token
POST /v1/ticketing/tags/:tagId/lost      block their own tag
```

### Admin — behind the new `event_tags` permission

```
GET  /v1/admin/ticketing/events/:id/tags
GET  /v1/admin/ticketing/events/:id/tags/analytics
GET  /v1/admin/ticketing/events/:id/vendors
POST /v1/admin/ticketing/tags/:tagId/status      block
GET  /v1/admin/ticketing/tags/:tagId/audit
```

Admin can **look, and can change a tag's status** — block it, mark it lost,
deactivate it, or reactivate one that was blocked in error. Every change is
audited with a reason. Admin **cannot mint, assign or replace** a tag; those
stay with the organiser and the gate. The admin console UI offers Block only;
the other statuses are reachable through the endpoint for support cases.

---

## RBAC

A new admin permission, **`event_tags`**, granted to `compliance`,
`customer_support` and `finance` (plus the wildcard roles: owner, root,
super_admin, ceo, developer).

Deliberately **not** granted to `marketing`, which holds `ticketing` for sales
reporting and has no reason to be able to disable an attendee's wristband. It
can be widened later through the existing `admin_role_permission_overrides`
setting with no code change.

A new event-staff permission, **`tags`**, alongside the existing `scan`. A gate
attendant can be given tag duties without being given the whole event.

No existing permission or role was changed or weakened.

---

## What the attendee sees

The Event Tag appears in **My Tickets**, with their tickets — not near the
wallet, because it is not one.

```
EVENT TAG
Tag Festival                                    [ACTIVE]
Tap to pay at any vendor at this event.

🔒 Uses your TitoPay Wallet. There is no separate event balance.

TAG  TDB5A6642        STATUS  Active

[ Top Up Wallet ]  [ View Transactions ]
[ Event Information ]  [ Report Tag Lost ]
```

- **No balance is shown**, because there is no tag balance to show.
- **Top Up Wallet is the app's existing Top Up button** (`data-service="top-up"`)
  — the same one on the home screen. No event top-up screen was built, and a
  test asserts the button carries no event-specific action.
- **View Transactions** goes to the ordinary Activity screen. Tag payments are
  ordinary wallet transactions and appear there with everything else.
- **Report Tag Lost** asks first, and the confirmation says plainly: *"Your
  money stays in your TitoPay Wallet — there is nothing on the tag itself."*
  An attendee who believes their balance is on the wristband is an attendee who
  hesitates to block it, which is exactly the wrong outcome.

---

## Fees

An Event Tag tap carries **no customer fee** — the same choice already made for
`pos_qr`, since it is the cashless equivalent of a card tap at the same
terminal. Registered as the `event_tag` pricing rule, which also has to exist
because `transactions.service_code` is a foreign key into `pricing_rules`.

---

## Verification

Everything below ran against real Postgres 16, the real API, the real POS HMAC
signing stack, and Chromium.

| Suite | Result |
|---|---|
| API unit + structure tests | **324 / 326** |
| `event-tag-e2e.js` — the full journey and refusal matrix | **82 / 82** |
| `event-tag-consoles.spec.js` — organiser and admin consoles in a browser | **29 / 29** |
| `pwa-event-tags.spec.js` — the attendee's screen in a browser | **24 / 24** |
| `event-tag-structure.test.js` — static invariants | **14 / 14** |

The two API failures are **pre-existing and unrelated**: an Email Statement
R0.10 pricing assertion and `hr-session.test.js`. Both fail identically on the
shipped archive without any of these changes.

### Regression — nothing else moved

| Suite | Before | After |
|---|---|---|
| PWA crawl | 20/20 | **20/20** |
| PWA journeys (84 journeys, 69 forms) | 96/96 | **96/96** |
| PWA wallet lock | 10/10 | **10/10** |
| PWA chat options | 31/31 | **31/31** |
| PWA support escalation | 17/17 | **17/17** |
| PWA rating and alerts | 17/17 | **17/17** |
| Admin landing | 39/39 | **39/39** |

### What the e2e harness actually proves

**The journey** — create event → approve → enable cashless → authorise a vendor
→ sell a ticket → issue blank tags → assign → tap → block → replace → the
replacement pays from the same wallet.

**There is no event balance** — no balance-like column in any tag table, no
second ledger table anywhere in the database, no extra wallet created for the
attendee, and no "balance" anywhere in the analytics payload.

**The money is real and it is in the existing ledger** — the attendee's own
wallet drops by exactly the tap amount, the vendor's rises by exactly the same,
there is exactly one debit and one credit in `wallet_ledger`, and the tap shows
up in the attendee's ordinary transaction history.

**One tap is one payment** — a repeated tap replays instead of charging again
and returns the same reference; reusing the key for a different amount is
refused; four terminals tapping the same wristband at once for more than the
balance never overdraw it.

**Every refusal** — a live, funded tag from another event (403, and that
attendee's wallet untouched); an event the admin has **suspended** (409, and it
works again once reinstated); an unauthorised vendor (403); an unassigned tag
(409); a forged credential (404); an unsigned request (401); a replayed nonce
(409); a **locked wallet (423)**; another customer trying to block your tag
(404); anonymous access (401).

**Losing a wristband costs nothing** — reporting it lost moves R0.00, the tag
stops working immediately, the replacement pays from the same wallet, and the
old one stays dead.

**Nothing leaks** — no credential in any listing, in the admin panel, in the
audit trail, or on any screen after the one-time reveal. Only hashes in the
database.

**Nothing else changed** — an ordinary event is still created exactly as
before and is not cashless unless switched on; the existing POS QR route is
still mounted and still guarded; no ledger entry is orphaned; every wallet
still equals the sum of its own ledger.

---

## One pre-existing bug fixed along the way

The PWA's **My Tickets** screen calls `GET /v1/ticketing/tickets`. **That route
has never existed** — the screen has been showing *"Tickets could not be
loaded"* since it shipped. It is unrelated to Event Tags, but the Event Tag
area lives on that screen, so the feature would have been unreachable.

Added `listMyTickets()` and `GET /v1/ticketing/tickets` — a read-only query
returning one row per ticket with its order and event attached, shaped exactly
as the existing `ticketStub()` renderer already reads it. It creates nothing,
refunds nothing and changes no state.

**Still outstanding, not fixed here:** the same screen calls
`/v1/ticketing/tickets/:code/wallet` and `/v1/ticketing/tickets/:code/download`
for Apple/Google Wallet passes and PDF download. Those routes also do not
exist. They are not needed for Event Tags and building a pass generator is well
outside this change, so they were left alone and are flagged here instead.

---

## Deploying

1. Replace `api/`. The schema migrates itself on first boot via
   `ensureTicketingSchema()` — additive and idempotent, safe to run repeatedly.
2. Replace `app/` (PWA **v292**) and `admin/` (console **v75**).
3. Nothing needs configuring. Every event stays non-cashless until an organiser
   switches it on.

### Before the first real event

- Test with the actual reader hardware — see **REQUIRES PHYSICAL HARDWARE
  TESTING** above.
- Decide whether tag credentials are write-protected on the chip.
- Grant `event_tags` to any additional admin role that needs it.
- Give gate staff the `tags` permission alongside `scan`.
