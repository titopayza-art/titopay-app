# API specification

Base URL: `https://ticketroom.co.za`. JSON in, JSON out. Money is always **integer cents (ZAR)**. Times are ISO-8601 UTC. The UI displays them in Africa/Johannesburg.

## Conventions

* **Auth:** an HttpOnly `tr_sid` session cookie (SameSite=Lax, Secure in production). `GET /api/auth/me` returns the user and the per-session `csrfToken`.
* **CSRF:** every POST/PUT/PATCH/DELETE made with a session must send `X-CSRF-Token: <csrfToken>` and `Content-Type: application/json`. Image uploads send `image/png|jpeg|webp` instead. Webhooks are exempt because they are signature-verified.
* **Idempotency:** order creation, top-ups and POS sales take `idempotencyKey` (8–80 chars). Repeating a request with the same key returns the original result (HTTP 200). Reusing a key with a different POS body returns `409 idempotency_mismatch`.
* **Errors:** `{ "error": { "code", "message", "details?" } }`. Validation returns `422 validation_failed` with `details: { field: message }`. Objects outside the caller's tenancy return **404**, never 403, so their existence is not revealed.
* **Rate limits:** per IP, user or terminal (see `src/routes/*`). Limits return `429 rate_limited`.
* **Unknown fields are dropped.** In particular, client-supplied prices and totals are ignored.

## Key payloads

```jsonc
// POST /api/public/orders
{ "eventSlug": "soweto-sunset-sessions-vb9n", "items": [{ "ticketTypeId": "uuid", "quantity": 2 }],
  "promoCode": "SUNSET20", "ref": "IG-STORY", "marketingOptIn": { "email": true, "sms": false }, "idempotencyKey": "uuid" }
// 201
{ "order": { "reference": "TR-9FRMFPN5", "status": "pending_payment", "totalCents": 37780, "expiresAt": "…" },
  "payment": { "status": "pending", "redirectUrl": "https://provider/…" } }

// POST /api/staff/scan
{ "eventId": "uuid", "payload": "TR1.<code>.<version>.<sig>" }        // or "tagInput": "TRT1.<token>" | "UID:04…"
// 200
{ "outcome": "admitted" | "already_used" | "invalid" | "wrong_event" | "revoked" | "refunded" | "event_not_live",
  "message": "…", "holderName": "…", "ticketType": "…", "admittedAt": "…" }

// POST /api/pos/sales   (headers: X-Terminal-Key, X-CSRF-Token)
{ "items": [{ "productId": "uuid", "quantity": 2 }], "tagInput": "TRT1.…", "pin": "4826", "idempotencyKey": "uuid" }
// 200
{ "status": "confirmed" | "declined", "reference": "PS-…", "totalCents": 6000, "declineReason": "insufficient_funds", "message": "…" }

// POST /api/webhooks/simulated   (header X-Sim-Signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + raw)>)
{ "id": "evt_…", "type": "payment.succeeded" | "payment.failed" | "payment.cancelled", "data": { "reference": "SIM-…", "amount_cents": 37780 } }
```

### POS decline reasons

`tag_unknown`, `tag_blocked`, `tag_lost`, `tag_revoked`, `tag_replaced`, `tag_expired`, `tag_unassigned`, `tag_assigned`, `tag_wrong_event`, `tag_not_payment_enabled`, `account_inactive`, `pin_not_set`, `pin_required`, `pin_incorrect`, `pin_locked`, `insufficient_funds`.

## Endpoints

Generated from `src/routes/*.js` by `node scripts/gen-api-doc.js`.

<!-- endpoints -->
| Method | Path | Access | Role / note |
|---|---|---|---|
| POST | `/api/auth/register` | public / session |  |
| POST | `/api/auth/login` | public / session |  |
| POST | `/api/auth/logout` | public / session |  |
| GET | `/api/auth/me` | public / session |  |
| PATCH | `/api/auth/me` | public / session |  |
| POST | `/api/auth/me/password` | public / session |  |
| POST | `/api/auth/me/pin` | public / session |  |
| POST | `/api/auth/verify-email` | public / session |  |
| POST | `/api/auth/verify-email/resend` | public / session |  |
| POST | `/api/auth/password/forgot` | public / session |  |
| POST | `/api/auth/password/reset` | public / session |  |
| GET | `/api/auth/me/export` | public / session |  |
| POST | `/api/auth/me/delete` | public / session |  |
| GET | `/api/auth/me/consents` | public / session |  |
| PUT | `/api/auth/me/consents` | public / session |  |
| GET | `/api/public/events` | public (orders: session) |  |
| GET | `/api/public/events/:slug` | public (orders: session) |  |
| POST | `/api/public/events/:slug/click` | public (orders: session) |  |
| POST | `/api/public/checkout/quote` | public (orders: session) |  |
| POST | `/api/public/orders` | public (orders: session) |  |
| GET | `/api/public/orders/:ref` | public (orders: session) |  |
| POST | `/api/public/orders/:ref/pay` | public (orders: session) |  |
| POST | `/api/public/orders/:ref/cancel` | public (orders: session) |  |
| POST | `/api/public/unsubscribe` | public (orders: session) |  |
| POST | `/api/public/support` | public (orders: session) |  |
| GET | `/api/me/tickets` | session (attendee) |  |
| GET | `/api/me/tickets/:id/qr.svg` | session (attendee) |  |
| PATCH | `/api/me/tickets/:id` | session (attendee) |  |
| POST | `/api/me/tickets/:id/transfer` | session (attendee) |  |
| GET | `/api/me/transfers` | session (attendee) |  |
| POST | `/api/me/transfers/:id/cancel` | session (attendee) |  |
| POST | `/api/me/transfers/claim` | session (attendee) |  |
| GET | `/api/me/orders` | session (attendee) |  |
| GET | `/api/me/tags` | session (attendee) |  |
| POST | `/api/me/tags/link` | session (attendee) |  |
| POST | `/api/me/tags/:id/lost` | session (attendee) |  |
| GET | `/api/me/wallets` | session (attendee) |  |
| GET | `/api/me/wallets/:eventId` | session (attendee) |  |
| POST | `/api/me/wallets/:eventId/topups` | session (attendee) |  |
| POST | `/api/me/wallets/:eventId/refund` | session (attendee) |  |
| GET | `/api/me/refunds` | session (attendee) |  |
| GET | `/api/me/support` | session (attendee) |  |
| POST | `/api/organiser/apply` | session + organiser member role |  |
| GET | `/api/organiser/orgs` | session + organiser member role |  |
| GET | `/api/organiser/:orgId` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId` | session + organiser member role |  |
| PUT | `/api/organiser/:orgId/bank` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/dashboard` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/members` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/members` | session + organiser member role |  |
| DELETE | `/api/organiser/:orgId/members/:userId` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/uploads` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events/:eventId` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId/events/:eventId` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/submit` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/request-cancellation` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/ticket-types` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId/events/:eventId/ticket-types/:ttId` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/promo-codes` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId/events/:eventId/promo-codes/:id` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/tracking-links` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events/:eventId/analytics` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events/:eventId/orders` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events/:eventId/attendees` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/orders/:orderId/refund` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/refunds` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/refunds/:refundId/decide` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events/:eventId/staff` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/staff` | session + organiser member role |  |
| DELETE | `/api/organiser/:orgId/events/:eventId/staff/:userId` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/events/:eventId/vendors` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/vendors` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId/events/:eventId/vendors/:vendorId` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/vendors/:vendorId/members` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/vendors/:vendorId/terminals` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId/events/:eventId/terminals/:terminalId` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/events/:eventId/vendors/:vendorId/payout` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/finance` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/payouts` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/marketing/audience` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/campaigns` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/campaigns` | session + organiser member role |  |
| PATCH | `/api/organiser/:orgId/campaigns/:id` | session + organiser member role |  |
| GET | `/api/organiser/:orgId/campaigns/:id/preview` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/campaigns/:id/test` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/campaigns/:id/send` | session + organiser member role |  |
| POST | `/api/organiser/:orgId/campaigns/:id/cancel` | session + organiser member role |  |
| GET | `/api/staff/events` | session + event staff / organiser owner|manager / admin|support |  |
| POST | `/api/staff/scan` | session + event staff / organiser owner|manager / admin|support |  |
| GET | `/api/staff/events/:eventId/stats` | session + event staff / organiser owner|manager / admin|support |  |
| POST | `/api/staff/tags/link` | session + event staff / organiser owner|manager / admin|support |  |
| POST | `/api/staff/tags/lookup` | session + event staff / organiser owner|manager / admin|support |  |
| POST | `/api/staff/tags/replace` | session + event staff / organiser owner|manager / admin|support |  |
| POST | `/api/staff/tags/:tagId/block` | session + event staff / organiser owner|manager / admin|support |  |
| GET | `/api/pos/vendors` | session + vendor member (+ X-Terminal-Key for sales) |  |
| GET | `/api/pos/context` | session + vendor member (+ X-Terminal-Key for sales) |  |
| POST | `/api/pos/sales` | session + vendor member (+ X-Terminal-Key for sales) |  |
| GET | `/api/pos/sales/by-key/:key` | session + vendor member (+ X-Terminal-Key for sales) |  |
| GET | `/api/pos/sales` | session + vendor member (+ X-Terminal-Key for sales) |  |
| GET | `/api/pos/summary` | session + vendor member (+ X-Terminal-Key for sales) |  |
| POST | `/api/pos/sales/:saleId/refund` | session + vendor member (+ X-Terminal-Key for sales) |  |
| GET | `/api/pos/vendors/:vendorId/products` | session + vendor member (+ X-Terminal-Key for sales) |  |
| POST | `/api/pos/vendors/:vendorId/products` | session + vendor member (+ X-Terminal-Key for sales) |  |
| PATCH | `/api/pos/vendors/:vendorId/products/:productId` | session + vendor member (+ X-Terminal-Key for sales) |  |
| POST | `/api/pos/vendors/:vendorId/terminals` | session + vendor member (+ X-Terminal-Key for sales) |  |
| GET | `/api/admin/dashboard` | platform role (admin | finance | support) |  |
| GET | `/api/admin/organisers` | platform role (admin | finance | support) |  |
| POST | `/api/admin/organisers/:id/status` | platform role (admin | finance | support) | ADMIN |
| GET | `/api/admin/events` | platform role (admin | finance | support) |  |
| POST | `/api/admin/events/:id/status` | platform role (admin | finance | support) | ADMIN |
| POST | `/api/admin/events/:id/cancel` | platform role (admin | finance | support) | ADMIN |
| GET | `/api/admin/users` | platform role (admin | finance | support) | ADMIN_OR_SUPPORT |
| GET | `/api/admin/users/:id` | platform role (admin | finance | support) | ADMIN_OR_SUPPORT |
| POST | `/api/admin/users/:id/status` | platform role (admin | finance | support) | ADMIN |
| POST | `/api/admin/users/:id/roles` | platform role (admin | finance | support) | ADMIN |
| GET | `/api/admin/orders` | platform role (admin | finance | support) |  |
| GET | `/api/admin/tickets/:code` | platform role (admin | finance | support) |  |
| POST | `/api/admin/tickets/:id/reissue` | platform role (admin | finance | support) | ADMIN_OR_SUPPORT |
| POST | `/api/admin/tickets/:id/revoke` | platform role (admin | finance | support) | ADMIN |
| GET | `/api/admin/payments` | platform role (admin | finance | support) |  |
| POST | `/api/admin/payments/:id/recheck` | platform role (admin | finance | support) |  |
| GET | `/api/admin/webhooks` | platform role (admin | finance | support) |  |
| GET | `/api/admin/refunds` | platform role (admin | finance | support) |  |
| POST | `/api/admin/refunds/:id/decide` | platform role (admin | finance | support) | FINANCE |
| POST | `/api/admin/refunds/:id/retry` | platform role (admin | finance | support) | FINANCE |
| POST | `/api/admin/refunds/bulk-approve` | platform role (admin | finance | support) | FINANCE |
| GET | `/api/admin/payouts` | platform role (admin | finance | support) |  |
| POST | `/api/admin/payouts/:id/decide` | platform role (admin | finance | support) | FINANCE |
| POST | `/api/admin/payouts/:id/mark-paid` | platform role (admin | finance | support) | FINANCE |
| POST | `/api/admin/payouts/:id/reveal-account` | platform role (admin | finance | support) | FINANCE |
| GET | `/api/admin/reconciliation` | platform role (admin | finance | support) |  |
| POST | `/api/admin/reconciliation` | platform role (admin | finance | support) | FINANCE |
| GET | `/api/admin/reconciliation/:id` | platform role (admin | finance | support) |  |
| POST | `/api/admin/reconciliation/items/:id/resolve` | platform role (admin | finance | support) | FINANCE |
| GET | `/api/admin/ledger/accounts` | platform role (admin | finance | support) |  |
| GET | `/api/admin/ledger/journals` | platform role (admin | finance | support) |  |
| POST | `/api/admin/tag-batches` | platform role (admin | finance | support) | ADMIN |
| GET | `/api/admin/tags` | platform role (admin | finance | support) |  |
| GET | `/api/admin/tags/:id/history` | platform role (admin | finance | support) |  |
| POST | `/api/admin/tags/:id/status` | platform role (admin | finance | support) | ADMIN_OR_SUPPORT |
| GET | `/api/admin/terminals` | platform role (admin | finance | support) |  |
| POST | `/api/admin/terminals/:id/status` | platform role (admin | finance | support) | ADMIN |
| GET | `/api/admin/audit` | platform role (admin | finance | support) |  |
| GET | `/api/admin/audit/verify` | platform role (admin | finance | support) |  |
| GET | `/api/admin/support` | platform role (admin | finance | support) |  |
| POST | `/api/admin/support/:id` | platform role (admin | finance | support) | ADMIN_OR_SUPPORT |
| GET | `/api/admin/outbox` | platform role (admin | finance | support) |  |
| POST | `/api/webhooks/:provider` | provider signature |  |
| GET | `/api/webhooks/pay/:ref` | provider signature |  |
<!-- /endpoints -->

The simulator's hosted pages (`GET /sim/pay/:ref`, `POST /sim/pay/:ref/{approve|decline|approve-silent}`) exist only while the simulated provider is enabled.
