# TitoPay Embedded POS Dynamic QR API

Base path: `/v1/pos` (the existing `/api/pos` compatibility mount is also available).

## Authentication

Customer and merchant operations use the existing TitoPay bearer token. Terminal
operations do not accept customer JWTs. They require:

- `X-TitoPay-Terminal-Id`
- `X-TitoPay-Timestamp` (Unix milliseconds)
- `X-TitoPay-Nonce` (unique for every request)
- `X-TitoPay-Signature`
- `Idempotency-Key` on every state-changing request

The signature is lowercase hex HMAC-SHA256 over:

```text
timestamp + "\n" + nonce + "\n" + HTTP_METHOD + "\n" + request_path + "\n" + sha256(raw_request_body)
```

Terminal secrets are returned exactly once during registration and stored only
as AES-256-GCM ciphertext. Replayed nonces are rejected.

## Endpoints

### Register a terminal

`POST /v1/pos/terminals/register` — existing admin JWT plus `engineering`
permission.

```json
{
  "merchantId": "TP-MERCHANT-001",
  "terminalId": "SPEEDPOINT-001",
  "provider": "OTHER",
  "deviceIdentifier": "SERIAL-001"
}
```

### Create a payment intent

`POST /v1/pos/payment-intents` — terminal HMAC authentication.

```json
{
  "merchantId": "TP-MERCHANT-001",
  "terminalId": "SPEEDPOINT-001",
  "amount": "125.50",
  "currency": "ZAR",
  "merchantReference": "ORDER-1001"
}
```

Returns an opaque, expiring `qrPayload`. The QR contains no amount, wallet,
merchant, customer, credential, or internal database identifier.

### Resolve and confirm

- `GET /v1/pos/payment-intents/resolve/:token` — customer JWT.
- `POST /v1/pos/payment-intents/:paymentId/confirm` — customer JWT and
  `Idempotency-Key`.

Confirmation atomically creates the TitoPay transaction, debits the customer
wallet, credits the merchant wallet, appends both ledger entries, and completes
the POS intent. Any failure rolls back the complete database transaction.

### Terminal status and cancellation

- `GET /v1/pos/payment-intents/:paymentId` — terminal HMAC.
- `POST /v1/pos/payment-intents/:paymentId/cancel` — terminal HMAC and
  `Idempotency-Key`.

Terminals should poll the status endpoint with bounded exponential backoff.

### Refund and reversal

- `POST /v1/pos/payment-intents/:paymentId/refund`
- `POST /v1/pos/payment-intents/:paymentId/reverse`

These require the existing merchant-owner or admin JWT and an
`Idempotency-Key`. Refunds may be partial but cumulative refunds cannot exceed
the original payment. Reversals are full and unavailable after any refund.

### Provider callback

`POST /v1/webhooks/pos-provider` is intentionally public at the HTTP routing
layer, but every request requires timestamped HMAC verification and replay
protection. Unknown, unsigned, stale, or invalid requests are rejected.

## State model

`PENDING → SCANNED → AUTHORIZED → PROCESSING → COMPLETED`

Supported terminal states also include `FAILED`, `CANCELLED`, `EXPIRED`,
`REVERSED`, and `REFUNDED`. Every state event is append-only in
`pos_payment_events`.

