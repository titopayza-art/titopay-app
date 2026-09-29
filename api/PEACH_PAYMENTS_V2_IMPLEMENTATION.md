# Peach Payments v2 (feature-flagged)

> **Note.** This document describes the **Peach Payments API** top-up integration, which
> authenticates with an `api-key` header and remains gated behind `PEACH_PAYMENTS_V2_ENABLED`.
> Provider health checking has since moved to **Peach Checkout V2** OAuth authentication and is no
> longer controlled by this flag — see `PEACH_CHECKOUT_403_FIX.md`. Step 4 of the checklist below
> is superseded: Test Connection now reports `connected` only when Peach issues an access token.

This change is on branch `peach-payments-v2` and is not deployed automatically. The backup branch is `backup-before-peach-v2-20260804`.

## Modified files

- `src/config/env.js` — adds the feature flag and environment-specific API URLs.
- `src/services/peach-payments-service.js` — Peach API client, authenticated health check, top-up lifecycle, refunds, webhook settlement and idempotency helpers.
- `src/routes/payments.routes.js` — additive top-up status/confirm/capture/cancel/refund routes; the existing top-up response remains unchanged while the flag is off.
- `src/routes/admin.routes.js` — Peach-specific authenticated Test Connection and sandbox/production fields.
- `src/routes/integrations.routes.js` — Peach Checkout payload compatibility and feature-flagged webhook settlement.
- `test/peach-payments-v2.test.js` — client, authentication, timeout and lifecycle tests.

No database schema, existing route, QR flow, merchant payment flow, authentication flow, wallet service API, or unrelated webhook was changed.

## Environment variables

Set these only on the API process. Keep the flag `false` or unset until Sandbox acceptance is complete.

```dotenv
PEACH_PAYMENTS_V2_ENABLED=false
PEACH_PAYMENTS_MODE=sandbox
PEACH_PAYMENTS_API_KEY=...
PEACH_PAYMENTS_SANDBOX_BASE_URL=https://app.sandbox-next.peachpayments.com/api
PEACH_PAYMENTS_PRODUCTION_BASE_URL=https://app.next.peachpayments.com/api
PEACH_PAYMENTS_WEBHOOK_SECRET=...
PEACH_PAYMENTS_WEBHOOK_URL=https://api.titopay.co.za/v1/webhooks/provider
PEACH_PAYMENTS_CALLBACK_URL=https://app.titopay.co.za/payments/peach/callback
```

`PEACH_PAYMENTS_BASE_URL` remains supported for existing installations and takes precedence when explicitly set. Secrets must be entered through the existing Admin Integration Centre or the protected process environment; never commit them.

## New additive routes

The existing `/v1/payments/topup` route is preserved. When the flag is enabled it performs a real Peach request; when disabled it returns the previous 503 response.

- `GET /v1/payments/topup/:paymentId`
- `POST /v1/payments/topup/:paymentId/confirm`
- `POST /v1/payments/topup/:paymentId/capture`
- `POST /v1/payments/topup/:paymentId/cancel`
- `POST /v1/payments/topup/:paymentId/refund`

All require the existing customer JWT and profile-lock checks. Top-ups require an idempotency key and a tokenized payment method; raw card numbers are not accepted.

## Sandbox-first deployment checklist

1. Create a Git backup and review branch (already done locally).
2. Configure the Sandbox API key and webhook secret in Admin → Integrations → Peach Payments; set Environment to `sandbox`.
3. Leave `PEACH_PAYMENTS_V2_ENABLED=false`; deploy the branch to a staging/preview API and run the automated tests.
4. Enable the flag only in the staging/preview process, then use Admin → Test Connection. The health state must be `connected` with `connectionState: sandbox_reachable`; a saved configuration alone is never reported as connected.
5. Run Peach Sandbox success, pending, failed, cancelled/uncertain, capture and refund scenarios. Confirm exactly one wallet credit per successful payment and one debit per refund.
6. Deliver duplicate and invalid-signature webhooks and verify duplicate acknowledgement plus no duplicate ledger movement.
7. Confirm existing Personal, Business, Admin, QR, merchant, authentication and notification tests remain green.
8. Only after written Sandbox acceptance, switch the stored environment to `production`, install production credentials, run Test Connection, and perform one low-value production verification according to Peach’s operational policy.

## Rollback plan

1. Set `PEACH_PAYMENTS_V2_ENABLED=false` in the API process environment.
2. Restart only the API process with the existing PM2 ecosystem configuration.
3. Existing top-up behavior returns to the previous 503 response; QR, wallet, merchant, authentication and unrelated webhooks continue using their prior code paths.
4. If a code rollback is required, switch to the previous release commit (`58bae0c`) or use `backup-before-peach-v2-20260804`; do not delete transaction or ledger data.

## Verification status

The new local tests pass:

- authenticated Sandbox connection and `api-key` header
- authentication failure is not reported as Connected
- network timeout classification
- pending, successful, cancelled, expired and refunded status normalization

The full API suite currently has one unrelated pre-existing failure: `test/hr-session.test.js` expects `hr/hr-session.js`, which is absent from this checkout. The other 103 existing tests pass. No live Peach credentials were available in this workspace, so live Sandbox/Production authentication, payment settlement and delivery cannot honestly be marked complete until the deployment checklist is run with the account’s credentials.

Peach’s current webhook documentation specifies the HMAC-SHA256 message `timestamp.webhookId.url.rawBody` and the four `x-webhook-*` headers. The implementation preserves the existing signed envelope and adds the official Checkout form-encoded fields behind the feature flag. See [Peach Checkout webhooks](https://developer.peachpayments.com/docs/checkout-webhooks) and [Peach Payments API OpenAPI](https://playground.sandbox-next.peachpayments.com/openapi.json).
