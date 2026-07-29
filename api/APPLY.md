# Apply everything — admin, app and HR in one pass

One ordered list of every change across all three surfaces. Work top to bottom:
each stage is independently shippable, and the early ones need no code.

Nothing below has been applied to production. Verified against the live API on
29 July 2026 — the catalogue is unchanged and the auth fault is still present.

| Stage | What | Needs | Time |
|---|---|---|---|
| 1 | Catalogue corrections | a SQL prompt | minutes |
| 2 | Auth returns 401, not 500 | backend deploy | ~30 min |
| 3 | Make `/v1/maintenance/public` public | backend deploy | minutes |
| 4 | Contract corrections to existing endpoints | backend deploy | ~half a day |
| 5 | New endpoints, per surface | build work | weeks |

Stages 1–3 are the ones with users waiting on them. Stage 2 is the only one
that is currently breaking production for customers.

---

## Stage 1 — Catalogue (no deploy, no code)

Eight field values across seven rows. The app fetches the catalogue on load, so
this takes effect on the next refresh with no release.

```bash
psql "$DATABASE_URL" -f catalogue/catalogue-fix.sql
./verify-catalogue.sh          # expect: all 8 pass
```

**6 of 8 rows are still wrong right now.** The one that matters most:
`stockvel.personal_visible` is `true`, so the savings-group interface is live to
personal users with no ledger behind it.

| service | field | live | set to |
|---|---|---|---|
| `stockvel` | `personal_visible` | `true` | `false` |
| `bill-split` | `business_visible` | `true` | `false` |
| `withdraw` | `business_visible` | `true` | `false` |
| `tickets` | `business_visible` | `false` | `true` |
| `airtime` | both | `true` | `false` |
| `data` | both | `true` | `false` |

`send-gift` and the `payment-request` copy are already correct — leave them.

Alternatives if you would rather not touch SQL: `catalogue/catalogue-patch.json`
is the same deltas as a patch, and `PATCH /v1/admin/services/{serviceCode}`
(Stage 5, admin) does it through the API once that endpoint exists.

---

## Stage 2 — Auth must return 401, not 500 · **all three surfaces**

**This is the admin crash, and it is hitting customers too.**

The API returns `500` for any invalid, malformed or expired token. Admin
console, PWA and any HR integration all refresh their session only on a `401`,
so a `500` skips recovery entirely and the client retries the same dead token
until someone signs out and back in.

Fix the auth middleware and the refresh handler together — fixing only one moves
the loop one step along. Full code, reproduction and reasoning in
**`INCIDENT-admin-500.md`**.

```bash
./verify-auth-fix.sh           # 7 of 9 failing today; all 9 must pass
```

Do not close this out on the admin console alone. Confirm a customer session
recovers too — the script covers `/v1/wallets` for exactly that reason.

---

## Stage 3 — `/v1/maintenance/public` must be public

It requires a bearer token today. The PWA calls it unauthenticated
(`app.js:575`, `auth: false`) and swallows the failure, so `state.maintenance`
is always disabled.

**You currently cannot show a maintenance notice to customers at all** — which
matters most precisely when you are trying to tell them something is wrong.

Spec: `openapi-app.yaml` → `GET /v1/maintenance/public`, `security: []`.

---

## Stage 4 — Corrections to endpoints that already exist

Contract changes, not new features. Each one is a place where the API is
currently telling a client something untrue or unusable.

### App

| Endpoint | Change | Why |
|---|---|---|
| `POST /v1/recipients/resolve` | add `outcome: found\|not_found\|unavailable` | A directory outage currently reads as "this person is not registered" — told to a customer, during a payment. Return `503` + `unavailable` when the index cannot answer. |
| `POST /v1/transactions/fee-preview` | add `debits` and `description` | The review screen cannot otherwise tell a debit from a record, which is why invoice creation says "Total debit R9,850.00" on a screen that also says it is free. |
| `POST /v1/vas/validate` | `503` when the provider is unreachable | Never return a synthesised pass. A false positive sends a real payment to the wrong meter. |
| `GET /v1/vas/catalogue` | `required` explicit on every field | The client treats absent as optional. |
| `POST /v1/ticketing/…/purchase` | return `tickets[]` with server-rendered QR | The buyer currently pays and never sees what they bought. |
| `POST /v1/chat/messages` | idempotent on `clientMessageId` | The socket send and the REST fallback carry the same id; a slow ack is the normal case, not an edge case. |
| `GET /v1/services` | accept `?audience=all` | What the client actually sends. |

### HR

| Endpoint | Change | Why |
|---|---|---|
| `POST /v1/enterprise-distribution/batches` | per-row `rows[]` with a human `error` | "7 of 400 rejected" with no indication which seven is unusable. |
| `GET …/batches` | full status vocabulary + `terminal` | So a released or rejected batch reads as words, not raw snake_case. |
| `GET …/batches` | `released_at`, `released_by`, `failure_reason` | An organisation with R98 250 locked should not have to phone to find out where it is. |

### Admin

| Endpoint | Change | Why |
|---|---|---|
| all | invalid token → `401` | Stage 2. Short admin sessions make this the most-exercised path in the console. |
| error bodies | keep human-readable | They are rendered directly to operators. No stack traces, SQL or internal hostnames. |

---

## Stage 5 — New endpoints, by surface

Build order within each surface is roughly the order listed.

### App — `openapi-app.yaml` (76 paths, 102 operations)

- **Business documents** — `/v1/business/documents` ×4. Documents live in
  `localStorage`, capped at 40; clearing browser data destroys a merchant's
  history. Numbering must move server-side — two devices currently generate the
  same invoice number.
- **Ticket retrieval** — `GET /v1/ticketing/tickets`. No route back to a ticket
  once the confirmation closes.
- **Support** — `/v1/support/tickets`. Tickets are in `localStorage`; Customer
  Care never sees them.
- **Chat** — `GET /v1/chat/config` to settle the socket question, and the
  canonical history/send paths so the client can drop its fallback chains.
  Socket contract in `chat-socket.md`.
- **Stokvel** — `/v1/stockvels/*`, 13 endpoints. The largest build. Keep
  `stockvel.personal_visible = false` until it is live. The group holds only
  what members contribute — no interest, no return, and none of the eleven
  disabled `STOCKVEL_FEATURES` concepts should exist in the API at all.

### Admin — `openapi-admin.yaml` (26 paths, 29 operations)

- **Batch release** — `POST /v1/admin/distribution/batches/{id}/release`. Step 5
  of Bulk Distribution, with no endpoint today. Enforce separation of duties:
  whoever funds a batch may not release it.
- **FICA decisions**, **event approval**, **profile change requests** — the
  decision half of flows the app can only start.
- **Catalogue** — `PATCH /v1/admin/services/{serviceCode}`, so Stage 1 does not
  need a SQL prompt next time.
- **Support queue**, **maintenance**, **audit log** (append-only).

### HR — `openapi-hr.yaml` (7 paths, 12 operations)

Mostly exists. Beyond the Stage 4 corrections: `GET …/batches/{id}/rows` for
paging large validation reports, and beneficiary upsert so an HR system can sync
its roster in one call.

---

## Checklist

```
[ ] 1  catalogue SQL applied           ./verify-catalogue.sh  → 8/8
[ ] 2  auth returns 401 not 500        ./verify-auth-fix.sh   → 9/9
[ ] 3  /v1/maintenance/public public   (covered by verify-auth-fix.sh)
[ ] 4  contract corrections shipped
[ ] 5  new endpoints, per surface
```

Stages 1–3 are worth doing this week. Stage 2 first: it is the only one
currently breaking production for customers, and it is the smallest.

## Still unanswered

Three questions the specs assume an answer to. Confirm or correct:

1. **Does invoice creation debit the wallet?** Assumed no — `debits: false`,
   with the R2.50 attaching to the PDF download. If it is a debit, that
   contradicts the stated pricing.
2. **Is the chat websocket live?** Set `socketEnabled` on `/v1/chat/config`
   accordingly.
3. **Does anything consume `appVersion`?** Hard-coded `"pwa-v134"` for 45
   releases. If nothing reads it, it comes out.
