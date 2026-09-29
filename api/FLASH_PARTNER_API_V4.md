# Flash Partner API v4 — Sandbox configuration and connection test

## What was wrong

The Flash provider was registered with the generic provider field set — API
Secret, Username, Password, Merchant ID, Webhook Secret, Callback URL — none of
which Flash uses, and none of which TitoPay read. Its "Test Connection" button
fell through to `testHttpEndpoint()`, a plain GET against the base URL with
speculative `x-api-key` headers. That probe could report **Connected** for a
host that had never accepted a Flash credential, and would report **Failed**
for a correctly configured account whose root path answers 404.

There was no Flash service module at all: no OAuth, no token handling, no
`responseCode` checking.

## What it does now

### Configuration (Admin → Integrations → Flash)

Five fields, matching Partner API v4:

| Field | Required | Notes |
|---|---|---|
| Enabled for API use | – | Existing toggle |
| Environment | – | Sandbox / Production |
| Base URL / Host | no | Blank falls back to the documented endpoint for the selected environment; the placeholder shows which one |
| API Key | **yes** | The Basic credential. Encrypted at rest, masked in Admin, never returned to the browser |
| Flash Account Number | **yes** | An identifier, not a credential — shown in full |

Environment defaults:

- Sandbox — `https://api-flashswitch-sandbox.flash-group.com`
- Production — `https://api.flashswitch.flash-group.com`

Changing the Environment dropdown moves the Base URL placeholder to match. A
base URL an operator typed is never overwritten.

### Test Connection

Two real calls, in order. Neither is a purchase.

1. `POST {base}/token`
   `Authorization: Basic <API key>`,
   `Content-Type: application/x-www-form-urlencoded`,
   body `grant_type=client_credentials`.
2. `GET {base}/aggregation/4.0/accounts/{accountNumber}/products`
   `Accept: application/json`, `Authorization: Bearer <access_token>`.

**Connected** is reported only when both succeed. The test never answers from
the token cache, so a corrected credential is tested immediately rather than
re-reporting the previous outcome.

### Status states

| State | Meaning |
|---|---|
| Not Configured | API key or account number missing — Flash was never contacted |
| Testing | The test is in flight (the button says so and refuses a second click) |
| Connected | A token was issued and accepted on a live account read |
| Authentication Failed | Flash rejected the API key, or returned no access token |
| Account Validation Failed | The token was accepted but the account number was rejected, or Flash answered with a non-zero `responseCode` |
| Connection Failed | Timeout, unreachable host, or Flash 5xx |

Alongside: Environment, Base URL, Last tested, Response time, Last successful
test, product count and the product groups discovered. Never the API key,
never the access token.

### Token handling

Tokens are cached server-side, in memory only, keyed by a hash of the endpoint
and the API key — changing either invalidates the cache. TTL comes from
`expires_in` (Flash documents 3600s) minus a 60-second refresh skew, so a token
can never expire in flight. A cached token that Flash rejects with a 401 is
discarded and re-issued exactly once, not in a loop.

### `responseCode`

Flash can fail with an HTTP error **or** with HTTP 200 carrying a non-zero
`responseCode`. Success requires both: an HTTP success **and** `responseCode`
of 0 wherever Flash supplies one. An absent `responseCode` is not treated as
zero — endpoints that omit it are not forced to declare success.

### Idempotency

`flashTransactionReference(sourceReference)` derives a Flash reference
deterministically from TitoPay's own transaction reference, so retrying a
timed-out transaction can only ever produce the same value. TitoPay has no
Flash purchase path yet; when one is built it must use this helper rather than
minting a new reference on retry.

## Security

- The API key is a `secretKeys` field: AES-256-GCM encrypted at rest through
  the existing `encryptSecret`/`maskSecret` mechanism, displayed as `••••` plus
  the last four characters, and never sent to the browser.
- Access tokens exist only in the API process. They are never persisted, never
  logged, and never returned in any response.
- Every provider message is passed through a scrubber that removes the API key
  and the access token — including when Flash echoes the credential back inside
  an error body — before it reaches a log line or an Admin diagnostic.
- Logging was not weakened: the endpoint, HTTP status, duration, cache use and
  `responseCode` are all recorded.
- RBAC is unchanged (Super Admin only) and audit logging is unchanged.

## Files changed

| File | Change |
|---|---|
| `src/services/flash-service.js` | **New.** Environment URLs, OAuth token request and cache, product discovery, connection test, `responseCode` enforcement, scrubber, idempotent reference helper |
| `src/routes/admin.routes.js` | Flash provider definition rewritten to the five Partner API v4 fields; `accountNumber` label and projection; environment-aware `defaultBaseUrl` plus `defaultBaseUrls`; Flash routed to `testFlashConnection`; Flash authentication type is now OAuth; a provider that classifies its own failure keeps that classification |
| `test/flash-partner-api.test.js` | **New.** 43 tests across the ten specified categories |
| `admin/assets/admin.js` | Six status labels and their colours; failure-state helper used by the health count and the "last failed" timestamp; Base URL placeholder driven by the environment; a Testing state on the button; status labels rendered instead of raw status keys |

## Database migrations

**None.** Flash configuration lives in the existing `platform_settings` row
`integration_flash`, using the existing schema. No table was added, altered or
dropped.

## Environment variables

All optional — they only supply defaults before an operator saves the provider
in Admin.

| Variable | Purpose |
|---|---|
| `FLASH_MODE` | `sandbox` (new default) or `production` |
| `FLASH_BASE_URL` | Overrides the documented endpoint |
| `FLASH_API_KEY` | Basic credential |
| `FLASH_ACCOUNT_NUMBER` | **New.** Flash account number |

`FLASH_API_SECRET`, `FLASH_USERNAME` and `FLASH_PASSWORD` are no longer read.
They can be removed from `.env`; leaving them in place changes nothing.
`FLASH_WEBHOOK_SECRET` is untouched — it belongs to the webhook-event registry
at `/v1/integrations/webhooks/flash`, which reads it from the environment and
never read the provider form.

## What an operator enters

1. Admin → Integrations → **Flash**
2. Environment: **Sandbox**
3. Base URL: leave blank (or `https://api-flashswitch-sandbox.flash-group.com`)
4. API Key: the Flash Sandbox API key, exactly as Flash issued it — the value
   that goes after `Basic ` in the Authorization header
5. Flash Account Number: the account number Flash allocated
6. Save Configuration → **Test Connection**

Connected means Flash issued a token and accepted it against that account.
Anything else names which step failed.
