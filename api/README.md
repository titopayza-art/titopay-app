# TitoPay API — final specification

The complete API contract across all three surfaces, with every fix from
`API-REQUIREMENTS.md` and `API-CATALOGUE-FIX.md` applied.

## What is in this package

**Start with `APPLY.md`** — one ordered runbook covering admin, app and HR
together, so the whole set can be worked through in a single pass. The two
`verify-*.sh` scripts tell you what has actually landed.

| File | Surface | Who calls it |
|---|---|---|
| `APPLY.md` | **All three** | The ordered apply-everything runbook — read first |
| `verify-auth-fix.sh` | **All three** | Proves the 500-vs-401 fix landed |
| `verify-catalogue.sh` | **App / Admin** | Proves the catalogue corrections landed |
| `openapi-app.yaml` | **App** | The PWA — personal and business accounts |
| `openapi-admin.yaml` | **Admin** | The internal TitoPay console |
| `openapi-hr.yaml` | **HR / Bulk Distribution** | Approved organisations paying many people at once |
| `chat-socket.md` | **App** | The chat websocket — the one surface OpenAPI cannot express |
| `INCIDENT-admin-500.md` | **Admin** | Live bug: invalid tokens return `500`, so the console cannot recover |
| `catalogue/services-catalogue.json` | — | The corrected service catalogue, in full |
| `catalogue/catalogue-patch.json` | — | Just the deltas, as a JSON patch |
| `catalogue/catalogue-fix.sql` | — | The same deltas as SQL |
| `CHANGELOG.md` | — | Every fix, traced to the endpoint that carries it |

All three specs validate against the OpenAPI 3.1 schema. Open them in Swagger
UI, Redoc, Stoplight or Postman, or generate a server stub from them.

**Verified against the shipped client.** Every `/v1/…` path in `app.js` was
extracted and matched against these specs, path and HTTP method. Every endpoint
and method the client calls is specified, and the request bodies below are the
ones it actually sends — not an idealised version of them. Where the client
sends the same value under three names, the spec says so rather than pretending
it sends one.

## The three surfaces

They are separate files because they have separate audiences and separate
release cadences, not because they are separate services. One host,
`https://api.titopay.co.za`, one auth scheme, one error envelope.

**App** (`openapi-app.yaml`) — everything the shipped PWA calls, plus the
endpoints that finished screens are waiting on. 60 paths.

**Admin** (`openapi-admin.yaml`) — the other half of flows the app can only
half-complete. The app funds a distribution batch; Admin releases it. The app
submits FICA documents; Admin decides. The app reads the service catalogue;
Admin edits it. Nothing here is reachable from the customer app.

**HR** (`openapi-hr.yaml`) — the organisation side of Bulk Distribution:
payroll, student allowances, grants, rentals, refunds. Reached through the
*Bulk Distribution* tile on a business account, or by direct integration from
an organisation's own payroll system.

## The one thing to read first

Three of these fixes are about the same underlying problem: **the API told the
app something confident and wrong, and the app repeated it to a customer.**

- A directory outage came back as "this person is not registered", during a
  payment, about a real customer.
- A batch upload came back as "7 rejected" with no way to learn which seven.
- A ticket purchase came back with no ticket.

Every one of them is fixed the same way — by making the response say what it
actually knows, and by giving the honest-failure case a name of its own
(`outcome: "unavailable"`, a per-row `error`, `deliveryStatus: "pending"`).
The client is already built to render those states. It does not guess, and it
does not invent a ticket code, a rejection reason, or a meter confirmation.

## Applying the catalogue fix

This one needs no deployment and no code — nine field values across seven rows,
fetched by the app on load.

```bash
psql "$DATABASE_URL" -f catalogue/catalogue-fix.sql
```

Or `PATCH /v1/admin/services/{serviceCode}` per row; see the Catalogue section
of `openapi-admin.yaml`.

**Editing `services-default.json` in the deployment zip does nothing in
production.** That file is the fallback used only when `GET /v1/services`
fails. The live catalogue overrides it on every successful load.

To verify, sign in rather than checking the database:

- **Personal** — no Stokvel tile. One "Airtime & Data" tile, not three.
- **Business** — no Bill Split, no Withdraw. Send Gift and Tickets both
  present, alongside Ticketing.
- **Both** — Payment Request no longer says "customer".

If a tile does not change, the client fell back to `services-default.json`,
which means `/v1/services` returned an error. Check that endpoint before
assuming the catalogue edit failed.

## Build order

The specs are written so the backend can be built in dependency order without
the app changing:

1. **`POST /v1/recipients/resolve`** with the `outcome` field. Highest value,
   smallest change — it stops the app making a false statement about a real
   customer during a payment. Everything else can wait behind it.
2. **The catalogue fix.** No code at all; it is a data change that removes a
   savings-group UI with no ledger behind it.
3. **Business documents** (`/v1/business/documents`) and **ticket issuance**
   (`tickets[]` on the purchase response). Both are data currently held only on
   the customer's device, or not returned at all.
4. **Bulk Distribution row detail and release visibility.** The organisation-
   facing gaps in `openapi-hr.yaml`.
5. **Stokvel.** The largest build. `stockvel.personal_visible` stays `false`
   until it lands.

## Conventions that hold everywhere

- Base URL `https://api.titopay.co.za`, hard-coded in the client.
- `Authorization: Bearer <accessToken>`. On `401` the client refreshes once and
  replays; a second `401` signs the user out.
- **The client aborts any request that has not responded in 15 seconds.**
  Anything slower must return a job handle, not a slow response.
- `Idempotency-Key` header on every write. `clientIdempotencyKey` in the body
  is accepted and ignored — the header is authoritative.
- `error` strings are **rendered directly to users**. Human-readable, no stack
  traces, no SQL, no internal hostnames. The client filters a few known-generic
  strings but cannot rewrite a leaked internal message.
- A `200` with `ok: false` is treated as a failure by the client.

## Open questions for the backend team

Three things in `API-REQUIREMENTS.md` were questions rather than defects, and
the specs record an assumption for each. Confirm or correct:

1. **Does invoice creation debit the wallet?** The specs assume **no** — that
   `POST /v1/transactions` for a document write is a record, and the fee preview
   returns `debits: false`. If it genuinely is a debit, that contradicts the
   stated pricing and the review screen is right to say "Total debit".
2. **Is the chat websocket live?** The specs add `GET /v1/chat/config` so the
   client can stop guessing. Set `socketEnabled` to whatever is true today.
3. **Does anything consume `appVersion`?** The client sent a hard-coded
   `"pwa-v134"` for 45 releases. It now sends the real build version; if nothing
   reads it, say so and it will be dropped.
