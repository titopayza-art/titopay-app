# Peach Payments "Test Connection" 403 — root cause and fix

## Symptom

Admin Portal → Peach Payments → Sandbox → Save Configuration → **Test Connection** returned
**HTTP 403 Forbidden**. Before the Client ID was populated it returned
`Missing required configuration: clientId or apiKey`.

## Root cause

TitoPay was not performing a Peach authentication request at all, and the two code paths that
could run both belonged to the wrong Peach product.

1. **The path that actually ran (403).** `PEACH_PAYMENTS_V2_ENABLED` is unset (default `false`),
   so `testProviderConnection()` fell through to the generic provider probe
   `testHttpEndpoint(effective.baseUrl, providerHeaders("peach_payments", effective))`. That sent

   ```
   HEAD https://testsecure.peachpayments.com
   Authorization: Basic base64(clientId:clientSecret)
   x-client-id: …   x-client-secret: …
   ```

   Peach Checkout does not use HTTP Basic authentication and does not serve `HEAD` on its root.
   The edge rejects the request with **403**, which the Admin Portal surfaced verbatim. Verified
   directly: `HEAD https://testsecure.peachpayments.com` → `403`, and
   `HEAD https://secure.peachpayments.com` → `403`.

   This path also transmitted the Client Secret to whatever host happened to be in the Base URL
   field, in two headers and a Basic credential.

2. **The path behind the feature flag (also wrong product).** `testPeachConnection()` sent
   `GET {baseUrl}/payments/list?limit=1` with an `api-key:` header against
   `app.sandbox-next.peachpayments.com`. That is the **Peach Payments API**, a different product
   with a different credential. With Checkout credentials it returns
   `401 {"error":{"code":"IR_01","message":"API key not provided or invalid API key used"}}`.

3. **The earlier "Missing required configuration" message** came from
   `requiredFields: ["baseUrl", ["clientId","apiKey"], ["clientSecret","apiSecret"]]` — modelled on
   the Payments API, not on Checkout. It required a Base URL, treated the API Key as an
   alternative to the Client ID, and never required the Merchant ID that Checkout authentication
   needs.

Net effect: no request was ever made to a Peach authentication endpoint, and neither outcome could
have reported a truthful CONNECTED.

## Integration in use

**Embedded Checkout / Hosted Checkout V2** — the product the Admin Portal collects Client ID,
Client Secret and Merchant ID for. Authentication methods are no longer mixed between Peach
products: Checkout uses OAuth client credentials, the Payments API keeps its `api-key` header
behind `PEACH_PAYMENTS_V2_ENABLED`, and OPPWA is not used.

## The authentication correction

Per the Peach documentation
([authentication](https://developer.peachpayments.com/docs/checkout-embedded-authentication),
[API endpoints](https://developer.peachpayments.com/docs/checkout-embedded#api-endpoints)):

| | Sandbox | Live |
| :-- | :-- | :-- |
| Authentication | `https://sandbox-dashboard.peachpayments.com` | `https://dashboard.peachpayments.com` |
| Checkout | `https://testsecure.peachpayments.com` | `https://secure.peachpayments.com` |

```
POST https://sandbox-dashboard.peachpayments.com/api/oauth/token
content-type: application/json

{ "clientId": "…", "clientSecret": "…", "merchantId": "…" }

200 → { "access_token": "…", "expires_in": "…", "token_type": "Bearer" }
```

The token is then used as `Authorization: Bearer {access_token}` for Checkout calls.

| | Before | After |
| :-- | :-- | :-- |
| Method | `HEAD` | `POST` |
| URL | configured Base URL | `{auth-service}/api/oauth/token`, fixed per environment |
| Auth | `Basic base64(clientId:clientSecret)` | credentials in the JSON body |
| Content-Type | none | `application/json` |
| Body | none | `{clientId, clientSecret, merchantId}` |
| Success | any status < 400 | a non-empty `access_token` |

**Peach answers invalid credentials with HTTP 400** and `{"message":"Invalid client ID or secret."}`,
not 401. That case is mapped to `AUTHENTICATION_REJECTED` so a bad credential is never reported as
a configuration or availability problem.

## Test Connection semantics

`POST /v1/admin/integrations/peach_payments/test` now performs a real authenticated Peach call and
reports `connected` **only** when Peach issues an access token. It never pings a URL, never checks
availability, and never infers connected from stored configuration. The token cache is bypassed for
Test Connection, so every test is a live call. No checkout, payment, transaction or ledger entry is
created.

Sanitized failure diagnostics returned to the portal:

| `errorCode` | Meaning |
| :-- | :-- |
| `AUTHENTICATION_REJECTED` | Peach rejected the credentials (400 invalid-credential, 401, 403) |
| `INVALID_CONFIGURATION` | Credentials missing/incomplete, or endpoint invalid (400/404) |
| `PROVIDER_UNAVAILABLE` | Peach returned 5xx |
| `PROVIDER_RATE_LIMITED` | Peach returned 429 |
| `NETWORK_TIMEOUT` / `NETWORK_ERROR` | Peach unreachable |
| `AUTHENTICATION_FAILED` | HTTP 200 with no access token |

## Credential handling

- Secrets stay encrypted at rest (AES-256-GCM) and are decrypted server-side by
  `providerSecretValue()` immediately before the request. Verified end to end.
- Access tokens are held in memory only — never persisted, logged, or returned.
- Responses and stored health/log records carry booleans and status codes only; no credential,
  token, or raw provider body.
- Server logs record environment, endpoint, HTTP status, duration, last-4 of the Client ID and
  Merchant ID, and a boolean for the Client Secret. Any provider text is passed through a scrubber
  that redacts credential values before logging.
- The Basic-auth/`x-client-secret` probe that transmitted the Client Secret to the configured Base
  URL has been removed.

## Field names

The Admin Portal saves camelCase (`clientId`, `clientSecret`, `merchantId`) and the provider code
reads the same keys, so there was no mismatch. `client_id` / `client_secret` / `merchant_id`
spellings are now also accepted defensively and normalised to the documented camelCase request body.

`requiredFields` for Peach is now `["clientId", "clientSecret", "merchantId"]`. Base URL is no
longer required — the Checkout authentication and checkout service URLs are fixed per environment.

## Environment variables

**No new variables are required.** Credentials are configured in Admin → Integrations → Peach
Payments and stored encrypted. The authentication service URLs are built in.

Optional overrides, only if Peach ever moves the authentication host:

```dotenv
PEACH_PAYMENTS_SANDBOX_AUTH_URL=https://sandbox-dashboard.peachpayments.com
PEACH_PAYMENTS_PRODUCTION_AUTH_URL=https://dashboard.peachpayments.com
```

`PEACH_PAYMENTS_V2_ENABLED` is unchanged and still gates the separate Payments API top-up flow. It
no longer has any effect on Test Connection.

## Webhook

Unchanged. `https://api.titopay.co.za/v1/webhooks/provider` and its HMAC-SHA256 verification are
untouched.

## Files changed

- `src/services/peach-checkout-auth-service.js` — new; Checkout V2 OAuth authentication.
- `src/services/peach-payments-service.js` — `testPeachConnection()` delegates to Checkout auth.
- `src/routes/admin.routes.js` — Test Connection routing, required fields, auth type, removal of
  the Basic-auth probe.
- `src/routes/integrations.routes.js` — Peach `configured` flag reflects Checkout credentials.
- `test/peach-payments-v2.test.js` — Checkout V2 authentication coverage.
