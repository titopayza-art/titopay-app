# TitoPay API Documentation

Base URL:

```text
https://api.titopay.co.za
```

All JSON requests should include:

```http
Content-Type: application/json
```

Protected routes require:

```http
Authorization: Bearer <access_token>
```

## Versioning

The API supports both route prefixes during production cutover:

- `/v1/...` for existing TitoPay web clients.
- `/api/...` for the public production contract.

Both prefixes resolve to the same backend services. Do not remove `/v1` until every deployed client has migrated.

## Health

### GET `/`

Returns API identity.

### GET `/health`

Versioned aliases are also available at `GET /v1/health` and `GET /api/health` so browser clients can use a single versioned API base URL.

Returns API and database health.

## Authentication

### POST `/v1/auth/register`

Creates a customer account.

Required body:

```json
{
  "accountType": "personal",
  "fullName": "Customer Name",
  "username": "customername",
  "email": "customer@example.com",
  "phone": "+27710000000",
  "password": "Strong password"
}
```

### POST `/v1/auth/login`

Customer login or admin OTP challenge when `scope` is `admin`.

Customer body:

```json
{
  "identifier": "customer@example.com",
  "password": "Strong password",
  "deviceName": "iPhone",
  "platform": "web"
}
```

Admin challenge body:

```json
{
  "scope": "admin",
  "identifier": "admin@titopay.co.za",
  "password": "Strong password"
}
```

### POST `/v1/auth/verify-otp`

Verifies an OTP challenge.

```json
{
  "scope": "admin",
  "challengeId": "uuid",
  "otp": "123456",
  "deviceName": "Admin Browser",
  "platform": "web"
}
```

### POST `/v1/auth/refresh`

Refreshes access tokens.

```json
{
  "refreshToken": "token",
  "scope": "admin"
}
```

### POST `/v1/auth/password-reset`

Request mode:

```json
{
  "mode": "request",
  "userType": "admin",
  "identifier": "admin@titopay.co.za"
}
```

Confirm mode:

```json
{
  "mode": "confirm",
  "userType": "admin",
  "accountId": "uuid",
  "otp": "123456",
  "newPassword": "New strong password"
}
```

## Admin Authentication

### POST `/v1/admin/login`

Authenticates an admin account. The environment flag supplies the initial authentication-mode default; the persisted Admin Security Dashboard setting controls subsequent sign-ins. Password Only returns a JWT after password validation, while Password + Email OTP creates an email OTP challenge.

Equivalent production alias: `POST /api/auth/admin/login`.

### POST `/v1/admin/login/verify`

Verifies admin email OTP and returns JWT session when OTP is enabled.

### POST `/v1/admin/login/resend-otp`

Sends a fresh OTP challenge.

### GET `/v1/admin/me`

Returns authenticated admin profile and permissions.

## Admin Dashboards

Protected by admin RBAC.

- `GET /v1/admin/dashboard/overview`
- `GET /v1/admin/users`
- `GET /v1/admin/merchants`
- `GET /v1/admin/transactions`
- `GET /v1/admin/wallets`
- `GET /v1/admin/support/tickets`
- `POST /v1/admin/support/tickets/:id/status`
- `GET /v1/admin/compliance/queue`
- `POST /v1/admin/compliance/reviews/:id/status`
- `GET /v1/admin/revenue`
- `GET /v1/admin/security`
- `GET /v1/admin/audit`
- `GET /v1/admin/roles`
- `GET /v1/admin/security-summary`

## Wallets

### GET `/v1/wallets`

Lists authenticated user's wallets.

Equivalent production alias: `GET /api/wallets`.

### GET `/v1/wallets/me`

Returns primary wallet.

### POST `/v1/wallets/create`

Creates the authenticated user's wallet when one does not already exist.

Equivalent production alias: `POST /api/wallets/create`.

### POST `/v1/wallets/transfer`

Processes a wallet-to-wallet transfer through the transaction engine.

Equivalent production alias: `POST /api/wallets/transfer`.

### GET `/v1/wallets/:id/statement`

Returns wallet ledger entries.

## Transactions

### POST `/v1/transactions/fee-preview`

Calculates fee from `pricing_rules`.

```json
{
  "service": "bank_transfer",
  "amount": 500,
  "recipient": "recipient@example.com"
}
```

### POST `/v1/transactions`

Processes a wallet-backed transaction.

```json
{
  "serviceCode": "wallet_transfer",
  "amount": 100,
  "recipient": "recipient@example.com"
}
```

### GET `/v1/transactions`

Lists authenticated user's transactions.

Equivalent production alias: `GET /api/transactions`.

### POST `/v1/transactions/:id/reverse`

Admin reversal route protected by RBAC.

## QR Payments

### POST `/v1/qr/create`

Creates a QR code.

### POST `/v1/qr/generate-static`

Creates a static QR code.

### POST `/v1/qr/generate-dynamic`

Creates a dynamic QR code.

### POST `/v1/qr/pay`

Pays a QR code.

Equivalent payment alias: `POST /api/payments/qr`.

### GET `/v1/qr/history`

Returns QR payment history.

### GET `/v1/qr/merchant`

Returns merchant/user QR codes.

## Merchants

### POST `/v1/merchants`

Creates a merchant profile for a business user.

```json
{
  "businessName": "Registered Business Name",
  "paymentLinkBase": "https://app.titopay.co.za/pay"
}
```

### GET `/v1/merchants/me`

Returns merchant profile for authenticated business user.

Equivalent production alias: `GET /api/merchants/me`.

### POST `/v1/merchants/:id/verify`

Admin merchant verification.

## Pricing

### GET `/v1/pricing`

Lists pricing rules.

### PUT `/v1/pricing/:id`

Updates a pricing rule. Admin permission required.

## Integrations

### GET `/v1/integrations`

Returns configured provider modes and readiness status for Peach Payments, DocFox, OTT, email and SMS.

## Admin User Management

These routes require an authenticated admin JWT with the `users` permission.

- `GET /api/users`
- `GET /api/users/:id`

## Payments

These routes require an authenticated customer JWT.

- `POST /api/payments/qr`
- `POST /api/payments/topup`

`/api/payments/topup` returns a production `503` until the card top-up provider credentials are configured.
# TitoPay Chat

All Chat REST endpoints require `Authorization: Bearer <access-token>`. Both
participants must be active customers with `fica_status` equal to `approved`
or `verified`.

- `GET /v1/users/search?q=...` — resolve only a verified TitoPay user and
  return name, profile photo/business logo, account type and verification state.
- `GET /v1/chat/config` — authenticated WebRTC STUN/TURN configuration.
- `GET /v1/chat/threads` — list conversations belonging to the caller.
- `GET /v1/chat/messages?threadId=...` — list and mark received messages read.
- `GET /v1/chat/threads/:threadId/messages` — list one permitted conversation.
- `POST /v1/chat/messages` — idempotently send a message and automatically
  create its direct conversation when necessary.
- `POST /v1/chat/threads/:threadId/messages` — send to an existing or
  client-referenced conversation.
- `POST /v1/chat/threads/:threadId/read` — persist and broadcast read receipts.
- `GET /v1/chat/notifications` — retrieve durable Chat notifications.
- `POST /v1/chat/notifications/read` — mark Chat notifications read.
- `POST /v1/chat/calls` — create a verified-user voice-call record.
- `GET /v1/chat/calls` — list the caller's permitted call history.
- `PATCH|POST /v1/chat/calls/:callId/end` — end a permitted call record.
- `GET /v1/chat/socket` (WebSocket upgrade) — realtime messaging, receipts,
  typing and WebRTC signalling. Browser clients authenticate with the
  `titopay-chat` and `bearer.<JWT>` WebSocket subprotocols.

WebSocket client events: `chat:send`, `chat:read`, `chat:typing`, `call:offer`,
`call:answer`, `call:ice`, `call:mute`, `call:end`.

WebSocket server events: `chat:ready`, `chat:message`, `chat:ack`,
`chat:status`, `chat:signal`, `chat:read:ack`, `chat:signal:ack`, `chat:error`.

## Super Admin Chat Monitor

- `GET /v1/admin/chat-monitor/overview`

This endpoint is restricted to the exact `super_admin` role. It returns
privacy-safe operational metadata for active conversations, current in-process
WebSocket presence, stale/failed deliveries, categorized WebSocket failures
from the last 24 hours and durable Chat notification queue counts. It never
returns message bodies or JWT values.

## Authentication Preference

All routes require an authenticated customer bearer token. Only the selected
method is persisted; OTP values and tokens are never part of a preference
response.

- `GET /v1/auth/me/authentication-preference` — returns the saved `PUSH`,
  `EMAIL` or `SMS` method, its update timestamp, last successful/failed
  authentication timestamps and current channel availability.
- `POST /v1/auth/me/authentication-preference/request` — starts verification
  of a proposed change. Body: `{ "method": "EMAIL" }`. The response identifies
  the channel actually selected after fallback.
- `PUT /v1/auth/me/authentication-preference` — verifies and persists the
  change. Body: `{ "method": "EMAIL", "challengeId": "<uuid>", "otp": "<code>" }`.

The default persisted method is `PUSH`. When the preferred method is not
available, channel selection checks Push, Email and SMS in that order. A Push
method is reported unavailable when the existing Push Authentication system
has no registered channel for the account; no replacement push provider is
created by this enhancement.

## Wallet Unlock Authentication

These existing routes remain backward compatible:

- `GET /v1/security/wallet-lock/unlock/options`
- `POST /v1/security/wallet-lock/unlock/request`
- `POST /v1/security/wallet-lock/unlock/verify`

Omitting `channel` on the request automatically uses the saved preference.
Legacy `{ "channel": "sms" }` and `{ "channel": "email" }` bodies remain
accepted. Responses add `selectedAuthenticationMethod`, `fallbackUsed` and the
masked destination. The verify response adds `authenticationMethod` and
`returnTo: "/wallet"` without removing existing fields.

Email challenges reuse the Email Centre queue, template, delivery logs and
audit trail. SMS challenges reuse the existing SMS notification provider. OTPs
are hashed, expire according to existing configurable policy, are invalidated
on replacement, are single-use and are protected by both route and per-code
attempt limits.
