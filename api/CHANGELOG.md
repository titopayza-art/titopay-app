# Fixes applied

---

## Verification pass — the specs now match the shipped client

Every `/v1/…` call site in `app.js` was extracted and matched against the specs
by path **and HTTP method**. That found twelve places where the spec described
something the client does not do. All are corrected; the list is here because
each one would have produced a working backend that the app could not talk to.

| Corrected | Was specified as | The client actually does |
|---|---|---|
| `/v1/auth/me/photo` | `POST { kind, image }` | `PUT { mediaType, dataUrl }` |
| `/v1/chat/calls/{callId}/end` | `POST /v1/chat/calls/{threadId}` with an action enum | Only `/end` over HTTP; setup is on the socket |
| `/v1/chat/threads/{id}/mute`, `/unmute` | absent | `POST`, empty body |
| `/v1/chat/threads/{id}/messages` | absent | `GET` and `POST` — first link in both fallback chains |
| `/v1/chat/users/lookup` | `GET ?q=` | `POST` with `lookupMethod`, and `GET ?identifier=` |
| `/v1/chat/messages` | `GET` absent; `POST { threadId, body }` | `GET` too, and a `POST` body carrying every field under 2–3 names |
| `/v1/services` | no query parameters | `?audience=all`, unauthenticated |
| `/v1/support/conversations/{id}/messages`, `/read` | absent | `GET`, `POST` and a read receipt |
| `/v1/ticketing/business/events/{id}/submit` | absent | `POST` — submit a draft for approval |
| `/v1/ticketing/business/events/{id}/staff` | absent | `POST { identifier, role, permissions }` |
| Support conversation status | `open`, `awaiting_customer`, `resolved`, `closed` | `ESCALATED`, `WAITING_FOR_AGENT`, `AGENT_ACTIVE`, `REOPENED` — uppercase |
| Escalation `mode` | `live_chat`, `callback`, `queue` | `live_chat`, `callback`, **`wait`** |

Two of these are worth calling out because they are silent failures rather than
obvious ones:

**The support status vocabulary is uppercase and exact.** The client compares
`conversation.status` against those four strings to decide whether the user's
next message goes to a live agent or back to the bot. A lowercase or unexpected
value does not error — it routes the customer's message to the chatbot while
they believe they are talking to a person.

**`POST /v1/chat/messages` must be idempotent on `clientMessageId`.** The
websocket send and the REST fallback carry the same value, and the client falls
back after a 7-second ack timeout. A slow ack is the normal case, not an edge
case; without idempotency it duplicates the message every time.

**Also added:** `chat-socket.md`, documenting the websocket — subprotocol
authentication, the reconnect backoff, all six server event types and the
`chat:send` frame. It is the only part of the client's API surface that cannot
be expressed as an OpenAPI path, and it was previously described only in prose
on `GET /v1/chat/config`.

---

Every item from `API-REQUIREMENTS.md` and `API-CATALOGUE-FIX.md`, traced to the
endpoint that carries it. Priorities are the ones from the source documents: P0
means users are actively misled or data is at risk.

---

## P0-1 — "Not found" and "could not check" are now different answers

**File:** `openapi-app.yaml` → `POST /v1/recipients/resolve`

The client called up to five lookup endpoints in sequence and treated every
failure as "this person is not registered". When the directory was unreachable
it told the user their contact was not on TitoPay and offered to send them an
invitation — a false statement about a real customer, made during a payment.

**Fixed by:** an explicit `outcome` on every lookup response.

| `outcome` | HTTP | Means | The app shows |
|---|---|---|---|
| `found` | 200 | The user exists | The recipient |
| `not_found` | 200 | The directory answered; there is no such user | An invitation offer |
| `unavailable` | 503 | The directory could not answer | A retryable "could not check" |

A `200` with `registered: false` may only ever mean an authoritative miss. A
degraded index returns `unavailable`.

**Also fixed:** one canonical lookup. `POST /v1/recipients/resolve` is
authoritative. `GET /v1/recipients/resolve`, `/v1/wallets/recipient/verify` and
`/v1/chat/users/lookup` are marked `deprecated` and must return the same
envelope until cached bundles cycle past v183. That undocumented fallback chain
is what made a single failure impossible to detect.

---

## P0-2 — Business documents are persisted server-side

**File:** `openapi-app.yaml` → `/v1/business/documents`

Invoices, quotes and proformas were written to `localStorage` under
`titopay_business_documents_v1`, capped at 40, and stored nowhere else. Clearing
browser data destroyed a merchant's document history; a second device showed an
empty list. A records-retention exposure, not only a feature gap.

**Fixed by:** four endpoints — create, list, read, patch — over the document
shape the client already builds.

**Numbering moved server-side.** The client derived `INV-2026-0001` by counting
the documents it happened to hold locally, so two devices produced the same
number. The server now owns one sequence per business, per document kind, and
returns `documentNumber` on create. The client sends none.

---

## P0-3 — A purchase returns the tickets

**File:** `openapi-app.yaml` → `POST /v1/ticketing/public/events/{slug}/purchase`,
`GET /v1/ticketing/tickets`

A completed purchase returned an order reference, a total and a delivery status.
No ticket, no entry code, no QR. The buyer paid and never saw what they bought.

**Fixed by:** `tickets[]` on the purchase response, each with `ticketCode`,
`holderName`, `seat` and a server-rendered `qrImageDataUrl`.

The QR must come from the server. The client bundles `jsQR`, which is a reader
only — and a client-generated entry code would not be trustworthy at the gate in
any case. Where issuance is genuinely asynchronous, return
`deliveryStatus: "pending"`; the client falls back to "your ticket is being
issued" and **will not invent a code**.

**Also added:** `GET /v1/ticketing/tickets`. There was no route back to a ticket
once the confirmation screen closed.

---

## P1-1 — Stokvel has a ledger

**File:** `openapi-app.yaml` → `/v1/stockvels/*` (13 endpoints)

The client shipped a complete savings-group interface — hub, create wizard,
dashboard, members, contributions, withdrawals, invitations, statement — built
against `/v1/stockvels`, with no service behind it. Every screen rendered empty
or errored. The largest single gap in the app.

**Fixed by:** the full ledger — groups, members, invitations, contributions,
withdrawals with organiser approval, activity audit trail, close.

**Regulatory position, binding on the API:** the group holds only what members
contribute. TitoPay adds no interest and no return. The eleven flags in the
client's `STOCKVEL_FEATURES` — investment portfolios, lending, credit scoring,
BNPL — are all `false` and stay off until there is a legal position. The API
must not expose those concepts at all, not even as null fields.

**Until this is live, `stockvel.personal_visible` stays `false`.** Shipping a
savings-group UI with no ledger is the riskiest thing in the app.

---

## P1-2 — VAS catalogue and honest validation

**File:** `openapi-app.yaml` → `GET /v1/vas/catalogue`, `POST /v1/vas/validate`

**Fixed by:** a provider-driven catalogue. The client renders whatever fields the
provider declares rather than hard-coding a form per service, so a new provider
needs no app release.

`required` is now **explicit on every field**. The client treats an absent
`required` as optional — defaulting it to true once blocked bill submission on a
select that legitimately had no value.

**`POST /v1/vas/validate` must never return a synthesised pass.** If the upstream
provider is unreachable, return `503`. A false positive here sends a real payment
to the wrong meter, and the client has no independent source of truth to catch
it. It never fabricates a confirmation itself.

---

## P1-3 — Support tickets exist on the server

**File:** `openapi-app.yaml` → `/v1/support/tickets`, `POST /v1/chatbot/escalations`
**File:** `openapi-admin.yaml` → `/v1/admin/support/tickets`

Support requests were written to `localStorage` under
`titopay_support_requests`. If the user cleared data or changed device, the
ticket they raised was gone — and Customer Care never saw it in the first place
unless a separate channel happened to pick it up.

**Fixed by:** real tickets, a queue Admin can work, and a list the customer can
check.

---

## P1-4 — Bulk Distribution: the report, the vocabulary and the release

**File:** `openapi-hr.yaml`, `openapi-admin.yaml`

**1. Per-row rejection reasons.** `invalid_rows` was a bare count. An
organisation uploading 400 rows was told "7 rejected" with no way to learn which
seven or why. `batch.rows` now carries `line`, `uniqueBeneficiaryId`, `amount`
and a human `error`. The client already renders this whenever it is present, and
accepts the array under `rows`, `invalid_row_details` or `errors`. Until it
lands, the client says plainly that TitoPay reported a count but not which rows —
**it does not guess a reason.**

**2. Batch status vocabulary.** All nine values enumerated, each marked terminal
or not, plus a `terminal` boolean on the record. `draft_validated` is the only
fundable state. A released or rejected batch now reads as words rather than raw
snake_case.

**3. Release visibility.** `released_at`, `released_by` and `failure_reason` are
on the batch record. An organisation that has locked R98 250 of its own money no
longer has to phone TitoPay to find out where it is.

**Also specified:** `POST /v1/admin/distribution/batches/{id}/release` — step 5
of the flow, which had no documented endpoint at all. It enforces separation of
duties (the party that funds a batch may not release it) and requires the
approver to type the total and row count back.

**Not changed:** the funding and release control flow. Lock and release stay two
separate, human-triggered steps.

---

## P2-1 — Service catalogue corrections

**File:** `catalogue/` (all three forms) · `openapi-admin.yaml` → `PATCH /v1/admin/services/{serviceCode}`

Nine field values across seven rows.

| service | change | why |
|---|---|---|
| `stockvel` | `personal_visible` → false | No ledger behind the UI |
| `bill-split` | `business_visible` → false | Splitting a bill between friends has no merchant meaning |
| `withdraw` | `business_visible` → false | Duplicates Payouts with no stated difference |
| `send-gift` | `business_visible` → true | Requested for business, currently missing |
| `tickets` | `business_visible` → true | Requested for business; distinct from `ticketing` |
| `airtime`, `data` | both → false | Published three times; the app collapses them into one tile |
| `payment-request` | description | A personal account is not dealing with customers |

Nine further rows are `coming_soon` / `disabled` and invisible to both account
types — `shop-marketplace`, `rewards`, `business-rewards`, `virtual-doctor`,
`travel`, `donate`, `cross-border`, `get-cash`, `cash-back`. Either attach a
real date or remove them. No app change either way.

---

## P2-2 — Invoice creation is a record, not a debit

**File:** `openapi-app.yaml` → `POST /v1/transactions`, `POST /v1/transactions/fee-preview`

Saving a document posted to `/v1/transactions` with `amount` set to the subtotal,
and the review screen labelled it "Total debit R9,850.00" while the modal said
creation was free.

**Resolved by P2-3's `debits` flag.** The specs assume document creation returns
`debits: false` and the client renders "No charge". The R2.50 fee attaches to the
PDF download, via `PATCH /v1/business/documents/{id}` with `pdfIssued: true`.

**Confirm this assumption.** If it genuinely is a debit, that contradicts the
stated pricing and the review screen was right.

---

## P2-3 — The fee preview says what is being charged

**File:** `openapi-app.yaml` → `POST /v1/transactions/fee-preview`

The preview returned amounts but never said whether the wallet would actually be
debited — which is why P2-2 was ambiguous.

**Fixed by:** `debits: true|false` and a one-sentence `description`. The review
screen can now describe any flow correctly without hard-coding an assumption per
service.

---

## P2-4 — Chat transport is settled at runtime

**File:** `openapi-app.yaml` → `GET /v1/chat/config`

The client tried three endpoints in sequence for history and two for sending
because the canonical one was never documented, and opened a websocket that fell
back to polling every few seconds — masking failures and costing battery.

**Fixed by:** `GET /v1/chat/config`, which states whether the socket is live and
at what interval to poll if not. `/v1/chat/threads` and `/v1/chat/messages` are
marked canonical; the alternatives are deprecated.

---

## Cross-cutting

**Idempotency.** The `Idempotency-Key` header is authoritative.
`clientIdempotencyKey` in the body is accepted and ignored. A replay returns the
original response with `replayed: true`.

**Error bodies.** `error` is rendered directly to users on every surface —
human-readable, no stack traces, no SQL, no internal hostnames. Documented on
the shared `Error` schema in all three specs.

**`appVersion`.** The client sent a hard-coded `"pwa-v134"` in support payloads,
stale for 45 releases. It now sends the real build version. If nothing consumes
it, say so and it will be removed.

**15-second timeout.** The client aborts any request that has not responded in
15 seconds. Anything slower must return a job handle, not a slow response.
