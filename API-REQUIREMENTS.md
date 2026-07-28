# TitoPay API requirements

What the PWA needs from the backend, written from the client side. Each item
says which screen depends on it and what happens today without it.

The client currently calls 54 endpoints. This document covers the gaps: things
the frontend is built against that do not exist, contracts that are ambiguous
enough to cause user-visible bugs, and data that is being kept on the device
because there is nowhere to put it.

Priority is P0 (users are actively misled or data is at risk), P1 (a shipped
feature has no backend), P2 (correctness and consistency).

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
after closing the confirmation. There is currently no route back to them.

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
