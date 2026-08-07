# TitoPay Admin API requirements

What the admin console (admin.titopay.co.za, build v61) needs from the
backend, written from the client side in the same format as
`API-REQUIREMENTS.md`. Each item says which console screen depends on it, what
happens today without it, and the exact contract the console is already built
against — every shape below is what the shipped console sends or reads, so
implementing the item lights the feature up with **no console change**.

Priority is P0 (operators are actively inconvenienced or data is at risk),
P1 (a shipped console feature is running on a per-browser fallback that only
the API can make shared), P2 (bank-grade capability the console cannot supply
from the client side at all).

| Item | Console screen | Status without it |
|---|---|---|
| A-P0-1 stop routine sign-in emails | Alert Centre | Owner's inbox flooded; events already visible in the portal |
| A-P0-2 server-side pagination | Users, Transactions, Wallets | Console pulls entire tables; fine now, breaks at scale |
| A-P1-1 user activity and profile fields | Analytics → Users, Executive | Active-user counts fall back to transacting identities; device/geo charts show "—" |
| A-P1-2 transaction detail fields | Analytics → Transactions | Payment-method and processing-time charts show "—" |
| A-P1-3 alert read state | Alert Centre | Read/unread is per browser |
| A-P1-4 service-builder store | Service Builder | Definitions live per browser; JSON export is the handoff |
| A-P1-5 quick-reply templates | Support Desk | Edited wording is per browser |
| A-P1-6 SMS analytics endpoint | SMS Analytics | Metrics derived from campaign counters only; no per-message receipts, no OTP SMS reporting |
| A-P2-1 system metrics | Analytics → System, Dashboard | CPU/RAM/disk/network/cache show "Not reported" |
| A-P2-2 per-session revoke | Security | Only "sign out all devices" exists |
| A-P2-3 TOTP / WebAuthn for admin sign-in | Sign in | Email OTP is the only second factor |
| A-P2-4 maker-checker approvals | Transactions, Wallets, RBAC | Sensitive actions execute on one operator's click |

---

## A-P0-1 — Stop emailing the owner on every sign-in

**Screen:** none — this is the inbox. The Alert Centre (v55) now surfaces
every sign-in, failed attempt, lock and fraud flag inside the console.

**Today:** the API's notification sender emails "A login to your TitoPay
account was recorded" on every login event. The owner's inbox carries dozens
of these a day and real alerts drown.

**Required:** disable the routine `login recorded` email in the API's
notification sender, keeping emails for genuinely critical events (fraud
flag, profile lock, repeated failures) if desired. No new endpoint. If a
per-event preference is wanted later:

```
GET /v1/admin/notification-preferences
{ "preferences": { "login_recorded": "portal", "fraud_alert": "email+portal", ... } }
PUT /v1/admin/notification-preferences   (same shape)
```

## A-P0-2 — Server-side pagination and search

**Screens:** Users, Transactions, Wallets, and every analytics view that
reads them.

**Today:** `GET /v1/admin/users` and `GET /v1/admin/wallets` return every row.
The console filters client-side, which is correct at hundreds of records and
fails at tens of thousands. `GET /v1/admin/transactions` already accepts
`search/status/service/from/to/limit` — extend the same idea.

**Required:** all three list endpoints accept and honour:

```
GET /v1/admin/users?search=&status=&limit=200&offset=0
{ "items": [...], "total": 18342, "limit": 200, "offset": 0 }
```

Backwards compatible: with no parameters, behave as today (the shipped console
sends none yet; a later console build adopts `total` for paging controls).

## A-P1-1 — User activity and profile fields

**Screens:** Analytics → Users (growth, retention, device, geography,
language, age charts), Executive KPIs (Active Users Today / 7 / 30).

**Today:** user records carry no last-seen timestamp, so active-user counts
fall back to distinct transacting identities (and say so). Device, browser,
OS, province, city, language and age charts render "—" with the missing field
named on the Data coverage card.

**Required:** additive columns on the rows `GET /v1/admin/users` returns.
Every name below is already read by the console (first match wins):

```
last_seen_at   (also accepted: lastSeenAt, last_active_at, last_login_at)
province, city, language
device_type, browser, operating_system
date_of_birth  (or age)
```

## A-P1-2 — Transaction detail fields

**Screens:** Analytics → Transactions (payment methods, processing time),
Fraud & Security (risk score trend).

**Required:** additive columns on `GET /v1/admin/transactions` rows:

```
payment_method   (also accepted: method, channel)
completed_at     (or processing_ms) — enables average processing time
risk_score       (0-100) — enables the risk trend and high-risk list
province         — enables the geographic filter on analytics
```

## A-P1-3 — Alert read state

**Screen:** Alert Centre (bell badge on every page).

**Today:** read/unread is stored in the browser's localStorage. Marking alerts
read on one machine does not carry to another, and the page says so.

**Required:**

```
GET /v1/admin/alerts/reads
{ "allReadAt": 1754450000000, "seen": { "<alertId>": 1754450100000, ... } }

PUT /v1/admin/alerts/reads      (same shape; server merges per admin user)
```

Alert ids are deterministic strings the console derives (`sec:<eventId>`,
`aud:<auditId>`, `cmp:<reviewId>`, `txf:<txnId>`, ...). Scope the store per
admin user. The console adopts the endpoint by replacing its localStorage
calls — the derivation stays client-side.

## A-P1-4 — Service Builder store

**Screen:** Platform → Service Builder.

**Today:** definitions live in a per-browser registry. The console already
calls the endpoints below on every load and save, switches to API storage
automatically the moment GET answers, and until then offers JSON export in
the exact `services-default.json` catalogue schema as the handoff.

**Required:**

```
GET /v1/admin/service-builder/services
{ "services": [ <service definition>, ... ] }

POST /v1/admin/service-builder/services
{ "service": <service definition> }          → upsert by service.id

DELETE /v1/admin/service-builder/services/:id
```

The service definition is versioned (`sbVersion: 1`) and includes `versions[]`
(publish snapshots) and `audit[]` (append-only entries carrying user, role,
sessionId, device). Persisting them server-side is what makes the audit trail
immutable and lets the API record source IPs. The catalogue mapping the
console exports:

```
{ service_code, service_name, description, service_icon, fee, commission,
  status, personal_visible, business_visible, sort_order, feature_badge,
  action }
```

## A-P1-5 — Support quick-reply templates

**Screen:** Support Desk conversation view (and its Manage editor, v59).

**Today:** the Customer Care responses ship built-in; owners can edit them in
the portal, stored per browser.

**Required:**

```
GET /v1/admin/support/quick-replies
{ "version": 1, "templates": [ { "group": "...", "title": "...", "text": "..." } ] }

PUT /v1/admin/support/quick-replies   (same shape; owner/developer roles only)
```

Text is plain text; `[Agent Name]` is a client-side substitution token, never
executed. 40 templates maximum, text ≤ 1200 characters.

## A-P1-6 — SMS analytics endpoint

**Screen:** Communications → SMS Analytics (v60).

**Today:** the page derives everything it can from
`GET /v1/admin/marketing/sms-campaigns` — total sent, failures, delivery
outcome and per-campaign detail come from the API's own per-campaign
counters, and the page says so. What campaign records cannot supply:
per-message delivery receipts, transactional SMS (OTP) volumes, delivery
timing, and true daily/weekly/monthly series (the fallback buckets by
campaign creation date).

**Required:** a dedicated reporting endpoint mirroring the email one the
console already consumes. The page calls it on every load and upgrades
automatically the moment it answers:

```
GET /v1/admin/sms/analytics?days=30
{
  "rangeDays": 30,
  "summary": { "total_sent": 4210, "delivered": 4102, "failed": 108,
               "delivery_rate": 97.43, "average_delivery_seconds": 6,
               "campaign_sent": 3800, "transactional_sent": 410 },
  "series": {
    "daily":   [ { "period": "2026-08-01", "sent": 140, "delivered": 137, "failed": 3 }, ... ],
    "weekly":  [ { "period": "2026-W31", "sent": 980, "delivered": 955, "failed": 25 }, ... ],
    "monthly": [ { "period": "2026-08", "sent": 4210, "delivered": 4102, "failed": 108 }, ... ]
  }
}
```

All fields are read defensively; a missing series simply renders empty.
Counting delivered/failed requires the SMS gateway's delivery receipts to be
stored per message — that storage is the real work here, and it is also what
would later enable a per-message delivery log screen.

## A-P2-1 — System metrics

**Screens:** Analytics → System, Dashboard health panel.

**Required:** numeric fields anywhere on the `GET /v1/admin/maintenance`
response (the console deep-searches by name):

```
cpu_usage, memory_usage, disk_usage, network_usage, cache_hit_rate   (0-100)
```

## A-P2-2 — Per-session revoke

**Screen:** Security → Admin Sessions.

**Today:** sessions are listed; the only remedy is "sign out all devices".

**Required:**

```
POST /v1/admin/sessions/:id/revoke   → { "ok": true }
```

The console adds a Revoke button to the existing sessions table once this
exists.

## A-P2-3 — TOTP / WebAuthn second factor for admin sign-in

**Screen:** Sign in; Security → Authentication Mode.

Email OTP is the only second factor. A bank-grade console offers an
authenticator app (TOTP, RFC 6238) or passkeys (WebAuthn). This is an API and
enrolment-flow design task; the console's sign-in page already handles a
challenge/verify handshake (`otpRequired` + `challengeId`) that a TOTP mode
can reuse with `authenticationMode: "totp"`.

## A-P2-4 — Maker-checker approvals

**Screens:** Transactions (reverse), Wallets (freeze/close), RBAC (role
changes), Staff Management.

Sensitive actions currently execute on one operator's click (the console adds
typed confirmations, which is not the same control). Bank practice is dual
authorisation: the acting operator creates a pending action, a second operator
approves it. Sketch:

```
POST /v1/admin/approvals            { action, targetType, targetId, payload }
GET  /v1/admin/approvals?status=pending
POST /v1/admin/approvals/:id/approve      (must be a different admin user)
POST /v1/admin/approvals/:id/reject       { reason }
```

When these exist, the console routes the affected actions through them and
grows a Pending approvals queue. This is the largest item here and the one
with the most audit value.
