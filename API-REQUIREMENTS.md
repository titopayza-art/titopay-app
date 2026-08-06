# TitoPay API requirements

What the PWA needs from the backend, written from the client side. Each item
says which screen depends on it and what happens today without it.

The client currently calls 54 endpoints. This document covers the gaps: things
the frontend is built against that do not exist, contracts that are ambiguous
enough to cause user-visible bugs, and data that is being kept on the device
because there is nowhere to put it.

Priority is P0 (users are actively misled or data is at risk), P1 (a shipped
feature has no backend), P2 (correctness and consistency).

## Status after reading the API

The first half of this document was written from the client side without sight
of the backend. The API has since been read directly, and several items were
either already satisfied or turned out to be client bugs. **The original
specifications are kept below unchanged**, and each one now has a status entry
in the second half of the document. Read the status first.

| Item | Status |
|---|---|
| P0-1 recipient lookup `outcome` | **Done** — patched in `security-service.js` |
| P0-2 business documents persistence | **Open** — confirmed, no route exists |
| P0-3 ticket issuance in the response | **Already provided** — the spec was wrong |
| P1-1 Stockvel backend | **Open** — confirmed, no route exists; tile hidden by the catalogue migration |
| P1-2 VAS catalogue and validation | Unverified — no VAS route in the supplied API |
| P1-3 support tickets | **Already provided** — the spec was wrong |
| P1-4 bulk distribution report and release state | **Done** — both were already on the wire; the client was not reading them |
| P2-1 catalogue corrections | **SQL supplied** — `src/db/migrations/2026-07-29-service-catalogue-corrections.sql` |
| P2-2 invoice posts a transaction | Open — depends on P0-2 |
| P2-3 fee preview `debits` | Open |
| P2-4 chat transport | Partly answered — a socket layer exists in `src/realtime/` |
| P1-5 payment notifications + SMS preference | **Open** — confirmed: no transaction notifications, no preference endpoint; client derives payments from `/v1/transactions` meanwhile |

---

## P0-1 — Recipient lookup must distinguish "not found" from "could not check"

**Screens:** Send Money, Bill Split, Payment Request, TitoPay Chat, Stockvel
member invite.

**Today:** the client calls up to five lookup endpoints in sequence and treats
every failure as "this person is not registered". When the directory is
unreachable it tells the user their contact is not on TitoPay and offers to send
them an invitation. That is a false statement about a real customer, made during
a payment.

The client now separates the two cases and shows a retryable "could not check"
state, but it is inferring the difference from whether the requests threw. The
API should state it.

**Required:** every lookup response carries an explicit outcome.

```
POST /v1/recipients/resolve
{
  "identifier": "@thabo",
  "lookupValues": ["@thabo", "thabo"],
  "purpose": "recipient_verification",
  "serviceCode": "wallet_transfer"
}

200 {
  "outcome": "found" | "not_found",
  "registered": true,
  "user": {
    "id": "u_123",
    "displayName": "Thabo Ndlovu",
    "username": "thabo",
    "accountType": "personal" | "business",
    "verified": true
  }
}

200 { "outcome": "not_found", "registered": false, "invite": { "url": "...", "message": "..." } }

503 { "outcome": "unavailable", "error": "Directory temporarily unavailable" }
```

`outcome: "unavailable"` must be used for any case where the directory could not
answer — dependency down, timeout, partial index. Do not return `not_found` for
these. A 5xx is also acceptable; what matters is that it is never a 200 with
`registered: false`.

**Also required:** one canonical lookup endpoint. The client tries
`/v1/recipients/resolve` (POST and GET), `/v1/wallets/recipient/verify` and
`/v1/chat/users/lookup` in sequence because it is not documented which is
authoritative. That fallback chain is why a single failure is hard to detect.

---

## P0-2 — Business documents must be persisted server-side

**Screens:** Invoice, Quote, Proforma Invoice, Saved documents.

**Today:** invoices, quotes and proformas are written to `localStorage` under
`titopay_business_documents_v1`, capped at 40, and nothing else. Clearing browser
data destroys a merchant's document history. Switching device shows an empty
list. The client cannot renumber correctly because it only knows about documents
created on that device.

This is a records-retention exposure, not only a feature gap: SARS expects
business records to be retained, and the app currently guarantees nothing.

**Required:**

```
POST   /v1/business/documents           create, returns the assigned number
GET    /v1/business/documents           list, paginated, newest first
GET    /v1/business/documents/{id}      single document
PATCH  /v1/business/documents/{id}      mark paid / cancelled / pdf issued
```

Document shape the client already builds and will send:

```
{
  "kind": "Invoice" | "Quote" | "Proforma Invoice",
  "action": "invoice" | "quote" | "proforma-invoice",
  "issueDate": "2026-07-28",
  "dueDate": "2026-08-27",
  "customerName": "Thabo Ndlovu",
  "customerEmail": "thabo@example.co.za",
  "customerAddress": "…",
  "businessAddress": "…",
  "items": [{ "description": "Website design", "quantity": 1, "unit": 8500, "total": 8500 }],
  "totals": { "subtotal": 9850, "vat": 1477.5, "total": 11327.5, "vatIncluded": true },
  "notes": "…",
  "disclaimer": "…"
}
```

**Numbering must move server-side.** The client currently derives
`INV-2026-0001` by counting local documents, so two devices produce the same
number. The server should own the sequence per business, per document kind, and
return it on create.

---

## P0-3 — Ticket issuance in the purchase response

**Screens:** Tickets, ticket confirmation.

**Today:** a completed purchase returns `order.orderReference`, `order.total` and
`order.deliveryStatus`. No ticket, no entry code, no QR. The buyer pays and never
sees what they bought. The client renders ticket stubs when tickets are present
and falls back to "ticket is being issued" when they are not — it will not
invent a code.

**Required:** the purchase response includes the issued tickets.

```
POST /v1/ticketing/public/events/{slug}/purchase

200 {
  "order": { "orderReference": "TPO-2026-0042", "total": 700, "deliveryStatus": "issued" },
  "event": { "eventName": "…", "eventDate": "…", "venueName": "…", "city": "…" },
  "tickets": [
    {
      "ticketCode": "AMA-4471-8890",
      "ticketTypeName": "General",
      "holderName": "Naledi Mokoena",
      "seat": "GA",
      "qrImageDataUrl": "data:image/png;base64,…"
    }
  ]
}
```

The QR must come from the server. The client has a QR *reader* (`jsQR`) but no
generator, and a client-generated entry code would not be trustworthy anyway.

**Also required:** `GET /v1/ticketing/tickets` so a buyer can retrieve tickets
after closing the confirmation.

The client now has that route back: **My Tickets** calls this endpoint and
renders one stub per ticket. It expects the same ticket shape as the purchase
response, optionally with the event and order the ticket belongs to:

```
GET /v1/ticketing/tickets

200 {
  "items": [
    {
      "ticketCode": "AMA-4471-8890",
      "ticketTypeName": "General",
      "holderName": "Naledi Mokoena",
      "seat": "GA",
      "qrImageDataUrl": "data:image/png;base64,…",
      "appleWalletUrl": "https://api.titopay.co.za/v1/ticketing/passes/AMA-4471-8890.pkpass",
      "event": { "eventName": "…", "eventDate": "…", "venueName": "…", "city": "…" },
      "order": { "orderReference": "TPO-2026-0042" }
    }
  ]
}
```

### Wallet passes: Apple Wallet and Google Wallet

**Required for the "Add to … Wallet" control to work:** a signed pass.

Both platforms sign with a key that can only live on the server — Apple's Pass
Type ID certificate, or the Google service account that signs the save JWT.
Shipping either into the PWA would publish it, so the client never builds a
pass. It links to one. The client shows Apple on iOS and macOS, Google on
Android, and nothing elsewhere.

Two ways to supply each, either is enough:

1. Put a pass URL on the ticket record. The client renders a direct link.
   - Apple: `appleWalletUrl`, or `applePassUrl` / `pkpassUrl` / `walletPassUrl`
     / `passUrl`.
   - Google: `googleWalletUrl`, or `googlePassUrl` / `googlePayUrl` /
     `saveToGoogleUrl`.
   - Camel or snake case, both are read.
2. Serve an endpoint the client calls when the ticket record carries no URL:
   - `GET /v1/ticketing/tickets/{ticketCode}/apple-wallet` → `200 { "appleWalletUrl": "…" }`
   - `GET /v1/ticketing/tickets/{ticketCode}/google-wallet` → `200 { "googleWalletUrl": "…" }`

   A `404` is read as "no pass issued yet" and reported as exactly that.

The Apple URL must serve the pass as `Content-Type: application/vnd.apple.pkpass`
over HTTPS; that content type is what raises the Add-to-Wallet sheet on iOS and
macOS. The Google URL is the standard save link, `https://pay.google.com/gp/v/save/{jwt}`,
where the JWT is signed with the issuer's service account key.

Only `http(s)` URLs are accepted — anything else is treated as no pass at all.
Until one of the two routes is in place, the control reports that the organiser
has not issued a pass yet and the QR stub remains the entry method.

### Ticket download

**No backend work is required.** Every ticket offers a download, on every
platform. The client draws the ticket onto a canvas and writes an A4 PDF
locally, through the same path the QR poster already uses, so a ticket
downloads without a round trip and without a library.

If the organiser issues its own ticket file, put its URL on the ticket record as
`ticketPdfUrl` (or `pdfUrl` / `downloadUrl` / `ticketFileUrl`, camel or snake
case) and the client will hand that file over instead of drawing one.

---

## P1-1 — Stockvel has no backend

**Screens:** the entire Stockvel section — hub, create wizard, dashboard,
members, contributions, withdrawals, invitations, statement.

**Today:** the client is built against `/v1/stockvels` and there is no service
behind it. Every screen renders empty or errors. This is the largest single gap
in the app: a savings-group product with no ledger.

**Required, minimum viable:**

```
GET    /v1/stockvels                          groups the user belongs to
POST   /v1/stockvels                          create a group
GET    /v1/stockvels/{id}                     detail: members, rules, balance
POST   /v1/stockvels/{id}/members             invite
POST   /v1/stockvels/{id}/members/{mid}/respond   accept / decline
GET    /v1/stockvels/{id}/contributions       ledger, paginated
POST   /v1/stockvels/{id}/contributions       record a contribution
GET    /v1/stockvels/{id}/withdrawals         requests
POST   /v1/stockvels/{id}/withdrawals         request a payout
POST   /v1/stockvels/{id}/withdrawals/{wid}/respond   approve / decline
GET    /v1/stockvels/{id}/activity            audit trail
POST   /v1/stockvels/{id}/close               close the group
GET    /v1/stockvels/invitations              invitations addressed to me
```

**Regulatory note carried in the client:** the group holds only what members
contribute. TitoPay adds no interest and no return. Eleven feature flags in
`STOCKVEL_FEATURES` (investment portfolios, lending, credit scoring, BNPL and
similar) are all `false` and must stay off until there is a legal position on
them. The API should not expose those concepts.

**Until this exists, hide the Stockvel tile.** Shipping a savings-group UI with
no ledger is the riskiest thing in the app.

---

## P1-2 — VAS catalogue and validation

**Screens:** Airtime & Data, Electricity, Vouchers, Pay Bills.

**Today:** the client calls `/v1/vas/catalogue` and `/v1/vas/validate` and is
built to be provider-driven — it renders whatever fields the provider declares
rather than hard-coding a form per service. No Flash or other provider
integration is live, so the journeys have no products.

**Required:**

```
GET /v1/vas/catalogue?journey=airtime|data|sms|voice|electricity|voucher|bill

200 {
  "providers": [
    {
      "code": "VODACOM",
      "name": "Vodacom",
      "journeys": ["airtime", "data"],
      "fields": [
        { "name": "msisdn", "label": "Cellphone number", "type": "tel",
          "required": true, "primary": true, "pattern": "^(\\+27|0)[6-8][0-9]{8}$",
          "hint": "The number receiving the airtime" }
      ],
      "products": [
        { "code": "VOD-AIR-30", "name": "R30 Airtime", "amount": 30,
          "openValue": false, "minAmount": null, "maxAmount": null }
      ]
    }
  ]
}
```

Field declarations drive the form. `required` must be explicit — the client
treats an absent `required` as optional, because defaulting it to true once
blocked bill submission on a select with no value.

```
POST /v1/vas/validate
{ "provider": "ESKOM", "journey": "electricity", "fields": { "meterNumber": "01234567890" } }

200 { "valid": true, "account": { "name": "T Tshiloane", "address": "…" } }
200 { "valid": false, "reason": "Meter number not recognised" }
503 { "error": "Validation service unavailable" }
```

**Never return a synthesised validation.** The client never fabricates meter or
account confirmation, and a false positive here sends a real payment to the wrong
meter.

---

## P1-3 — Support tickets

**Screens:** chatbot escalation, Customer Care.

**Today:** support requests are written to `localStorage` under
`titopay_support_requests`. If the user clears data or changes device, the ticket
they raised is gone, and Customer Care never saw it in the first place unless a
separate channel picked it up.

**Required:**

```
POST /v1/support/tickets    { "mode": "live_chat"|"callback"|"queue", "message": "…", "context": {…} }
GET  /v1/support/tickets    the user's own tickets and their status
```

---

## P2-1 — Service catalogue corrections

**Screens:** Services grid, Home quick services, landing preview.

The live `/v1/services` disagrees with the client's fallback in ways that produce
visible bugs:

| service | live catalogue | should be | effect today |
|---|---|---|---|
| `bill-split` | business-visible | personal only | Bill Split appears on business accounts |
| `withdraw` | business-visible | personal only | duplicates Payouts, no stated difference |
| `send-gift` | not business-visible | business-visible | requested for business, currently missing |
| `tickets` | not business-visible | business-visible | requested for business, currently missing |
| `payment-request` description | "Request money from a customer, friend or family member" | drop "customer" | a personal user is not dealing with customers |

Also: nine services are `status: coming_soon` and invisible to both account types
(Marketplace, Rewards, Business Rewards, Virtual Doctor, Travel, Donate, Cross
Border, Get Cash, Cash Back). Either give them a date or remove them; they are
currently ambition in a JSON file.

**Airtime naming:** the catalogue publishes `airtime`, `data` and `airtime-data`
as three services. The client collapses them into one "Airtime & Data" tile
everywhere. If the combined product is the real one, publish only that.

---

## P2-2 — Invoice creation posts a transaction

**Screen:** Invoice, Quote, Proforma.

Saving a document posts to `/v1/transactions` with `amount` set to the document
subtotal, and the review screen labels it **"Total debit R9,850.00"** while the
modal says creation is free.

Please confirm what this transaction does. If it is a record and not a debit, the
client needs a way to tell — a distinct `serviceCode` behaviour, or a
`recordOnly: true` on the fee preview — so the review screen can stop calling it
a debit. If it *is* a debit, that contradicts the stated pricing.

---

## P2-3 — Fee preview should state what is being charged

**Screens:** every money flow.

`POST /v1/transactions/fee-preview` returns `amount`, `fee`, `thirdPartyFee`,
`total`, `recipientAmount`. It does not say whether the wallet will actually be
debited, which is why P2-2 is ambiguous. Adding `"debits": true|false` and a
short `"description"` would let the review screen describe any flow correctly
without the client hard-coding assumptions per service.

---

## P2-4 — Chat transport

**Screens:** TitoPay Chat.

The client currently tries three endpoints in sequence for message history and
two for sending, because the canonical one is not documented. It also opens
`wss://api.titopay.co.za/v1/chat/socket` and falls back to polling every few
seconds when the socket is unavailable.

**Required:** confirm the canonical endpoints and whether the socket is live. The
fallback chain masks failures and the polling costs battery on mobile.

---

## P1-4 — Bulk Distribution — RESOLVED, and three corrections to this document

This section previously asked the API for three things. Having now read the
API, two of them already existed and one is a client bug we introduced. The
corrections are recorded here rather than quietly deleted, because the earlier
version of this file was used to plan backend work that is not needed.

**1. Per-row rejection reasons — already provided.** `POST
/v1/enterprise-distribution/batches` returns `validationReport` alongside
`batch`: one entry per row as `{ rowNumber, row, errors[], status }`, with the
reasons already written for a human — "Active TitoPay wallet was not found",
"Amount must be greater than zero", "Duplicate beneficiary in this batch". The
rows are also persisted to `enterprise_distribution_batch_items.validation_errors`.
The client was discarding the report and rendering the count alone. Fixed in
v184; no API change.

**2. Release visibility — already provided.** `GET
/v1/enterprise-distribution/batches` is a `SELECT *`, so `released_at` has
always been on the wire. The client was not reading it. Every batch row now
states where it stands — "Locked. Waiting for TitoPay Admin to release." or
"Released 12 Mar 2026 14:22". Fixed in v184; no API change.

**3. Status vocabulary — read from the service.** The set is `draft`,
`draft_validated`, `draft_validation_failed`, `funding_locked`, `released`,
`processing`, `completed`, `failed`, `cancelled`. The client now names each one
in plain words and only offers funding on `draft_validated`, which is the only
status `lockBatchFunding` accepts.

**Still open, and genuinely server-side:** batch payouts are wallet-only.
`lockBatchFunding` marks any non-wallet row `payout_service_required` and the
client says as much. If bank beneficiaries are ever meant to run through a
batch rather than through Payouts, that is a product decision with a real
implementation behind it, not a UI change.

---

## P1-3 — Support tickets — RESOLVED

`POST /v1/support/tickets` exists and writes to `support_tickets` with a
generated `ticket_ref`, status `open` and assignment to the Customer Care
queue, alongside a full conversation API. This section previously stated the
endpoint was missing. It was not.

---

## P0-3 — Ticket issuance — RESOLVED

`purchaseTickets` issues a unique numeric `ticket_code` per ticket and a QR
payload of `{ type: "titopay_ticket", ticketId, ticketCode, orderReference,
eventId }`, returns them on the purchase response, and delivers the order
asynchronously. This section previously asked for issuance in the response. It
was already there.

---

## P0-1 — Recipient lookup — RESOLVED in this change

`verifyRecipient` returned `registered: true|false` with no way to tell "we
looked and found nobody" from "the lookup itself failed". Both branches now
carry an additive `outcome` field, `"found"` or `"not_found"`, and the client
trusts it in preference to its own heuristic. Every existing field keeps its
meaning; nothing was removed.

Patch: `src/services/security-service.js`, three return sites.

---

## P2-1 — Service catalogue corrections — SQL supplied

The table is `service_config` and the client reads it through `GET
/v1/services`. A migration is supplied at
`src/db/migrations/2026-07-29-service-catalogue-corrections.sql`: nine field
values across seven rows, idempotent, and a no-op for any row absent from a
given environment. The most important line hides Stockvel.

---

## P1-1 — Stockvel still has no backend — CONFIRMED, and now urgent

There is no stockvel route in this API. `transaction-service.js` recognises
`stockvel` and `stockvel_contribution` as service codes, and nothing else
exists: no groups, no members, no contributions, no ledger. The app renders a
complete savings-group interface against `/v1/stockvels`, which returns 404.

The catalogue migration above hides the tile. That is containment, not a fix.
A savings product visible to customers with no ledger behind it is the single
largest risk in this codebase, and hiding the tile is what should happen today
while the endpoints are built.

---

## P0-2 — Business documents still have no backend — CONFIRMED

`invoice`, `quote` and `proforma-invoice` are published in `service_config`
and there is no route, service or table for any of them. Everything the app
saves lives in browser storage and is lost when the cache clears. Numbering is
client-side, so two devices on the same business will issue the same invoice
number. This is a compliance exposure, not only a data-loss one.

The original P0-2 specification below still stands unchanged.

---

---

## P1-5 — Payment notifications and the SMS preference

**Screens:** the notification centre (bell), SMS alerts toggle.

**Today, verified against the API source:** nothing in the transaction path
creates a notification — `transaction-service.js` never calls
`createNotification`; only ticketing and bulk distribution do. And there is no
notification-preference endpoint anywhere: the app's "Enable SMS alerts"
toggle can only store the choice on the device, which the UI now says in so
many words. The pricing rule (`optional_sms_notifications`, R0.30) exists;
nothing consumes it.

The client closes what it can honestly close: as of v186 the notification
centre derives payment entries from `/v1/transactions` — real data the account
already owns — and polls it on the 15-second heartbeat so money movements
reach the bell without a manual refresh. What the client cannot do is send an
SMS or know about a credit the moment it lands. That needs:

**1. Transaction events create notifications.** On every completed
transaction, one `in_app` notification for each party, written through the
existing `createNotification` (`notifications` table already has the shape):

```
recipient: type "payment_received", title "Money received",
           body "R 250.00 from Naledi Trading · Ref TP-4108"
sender:    type "payment_sent", title "Payment sent",
           body "R 250.00 to Thabo Ndlovu · Ref TP-4108"
```

Wrap the call so a notification failure can never fail the transaction.

**2. A preference the server owns.**

```
GET  /v1/users/me/notification-preferences   { smsPayments: false, inApp: true }
PUT  /v1/users/me/notification-preferences   { smsPayments: true }
```

One boolean column (or a JSONB prefs field) on `users`. The client will switch
its toggle to this endpoint the release it exists.

**3. SMS dispatch honours the preference.** When `smsPayments` is true, the
transaction event also calls the existing `deliverSms` (SIMcloud is already
wired for OTP), charging per the `optional_sms_notifications` pricing rule,
with critical security SMS remaining free. Until 1-3 land, no SMS payment
alert is sent to anyone, whatever the toggle shows — which is why the toggle
now says exactly that.

---

## P2-5 — Applicant-visible Bulk Distribution application status

`GET /v1/enterprise-distribution/eligibility` reports `approved` and
`blockers`, but nothing tells the applicant whether an application is
`submitted`, `under_review` or `rejected` — `listApplications` is admin-only.
The client remembers "you applied on this device" locally, which survives
neither a new device nor a cleared cache. Add the caller's own latest
application to the eligibility response:

```
{ "eligible": false, "approved": false,
  "application": { "status": "under_review", "submittedAt": "…", "adminNote": "…" },
  "blockers": [ … ] }
```

A rejected application currently looks identical to one never made.

---

## Cross-cutting

**Idempotency.** The client sends `clientIdempotencyKey` in the body and
`Idempotency-Key` as a header on every transaction. Please confirm the server
honours one of them and which.

**Error bodies.** The client renders `payload.error` directly to users. Please
keep these human-readable and free of stack traces, SQL and internal host names —
there is a filter on the client for generic strings, but it cannot rewrite a
leaked internal message.

**`appVersion`.** The client sends `appVersion: "pwa-v134"` in support payloads
and it has been stale for 45 releases. If nothing consumes it, we will remove it;
if something does, tell us and we will wire it to the real build version.

---

## P0-4 — QR owner lookup before payment (new in pwa-v240)

Users scanning a QR code cannot see who they are about to pay — only the raw
QR ID. Paying the wrong QR is the single easiest money-losing mistake the UI
allows. As of pwa-v240 the client calls, before showing the QR payment review:

```
GET /v1/qr/{qrId}/details          (authenticated)
```

Expected response:

```json
{
  "qr": {
    "id": "qr_abc123",
    "label": "Counter 1",
    "codeType": "static",
    "amount": null,
    "owner": {
      "displayName": "Naledi's Kitchen",
      "username": "naledis",
      "accountType": "business"
    }
  }
}
```

`owner.displayName` (or `businessName` / `fullName`) is the only required
field for the confirmation card; `username` and `accountType` enrich it.
The client also accepts the payload under `details` instead of `qr`.

Until the endpoint exists the client degrades gracefully: the review shows an
explicit **"Owner not confirmed — check before you pay"** caution instead of a
name, and the payment flow is otherwise unchanged. No client update will be
needed when the endpoint goes live — names appear automatically.

Privacy note: this endpoint reveals an account holder's display name to anyone
who scans their QR. That is the point of a payment QR, but the response should
contain nothing beyond the fields above (no phone, email or wallet balance).

## P1-5 — Business staff register (shipped v268 as a device-local preview)

**Screen:** Services → Staff (business accounts only, "Preview" badge).

**Today:** the PWA keeps a register of staff members (full name, role,
contact) in the browser's localStorage, and the screen says so. The client
is API-first: every open, add and remove already calls the endpoints below
and switches to server storage the moment they answer — no client change
needed.

```
GET    /v1/business/staff
{ "items": [ { "id": "stf_1", "fullName": "Sipho Dlamini",
               "role": "Cashier", "contact": "+27710000000",
               "addedAt": "2026-08-06T19:00:00Z" } ] }

POST   /v1/business/staff        { fullName, role, contact }  → { member }
DELETE /v1/business/staff/:id    → { ok: true }
```

Roles the client sends: `Cashier`, `Manager`, `Assistant`, `Other`. Scope the
register per business account, and RBAC-gate all three routes to the business
owner's session.

**The larger design task this preview points at:** role-scoped staff
*sign-ins* (a cashier logging in on their own phone with limited
permissions). That is an authentication/HR-system feature the client cannot
fake and does not claim — the register above is deliberately only a roster
until that exists.
