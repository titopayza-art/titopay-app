# TitoPay SDK Starter Kits

Single-file, dependency-free starter clients for the TitoPay POS API. Each
implements the four things every integration needs:

1. **Terminal request signing** — HMAC-SHA256 over
   `timestamp \n nonce \n METHOD \n path \n sha256hex(body)`, headers
   `X-TitoPay-Terminal-Id / -Timestamp / -Nonce / -Signature`, plus an
   `Idempotency-Key` on money-creating POSTs.
2. **Payment creation** — `POST /v1/pos/payment-intents` returning the
   `paymentId` and the `qrPayload` to render (120-second QR).
3. **Status checks** — `GET /v1/pos/payment-intents/{paymentId}`, the
   reconciliation truth alongside webhooks.
4. **Webhook verification** — constant-time HMAC comparison, timestamp
   tolerance, event-ID dedupe responsibility, and rotation awareness
   (`X-TitoPay-Signature-Previous` during the 24-hour overlap).

| Language | File | Runtime |
|---|---|---|
| Node.js | `node/titopay.js` | Node 18+ (built-in fetch) |
| Java | `java/TitoPayClient.java` | Java 17+ (JDK HttpClient) |
| PHP | `php/TitoPayClient.php` | PHP 8+ (cURL) |
| Android/Kotlin | `kotlin/TitoPayClient.kt` | Any (HttpURLConnection; swap in OkHttp) |

Get sandbox credentials from the Developer Portal (register → provision a
merchant → register a terminal); the terminal secret each client needs is
shown once at registration. Full API references: `../openapi-titopay.yaml`
and `../webhooks/openapi-webhooks.yaml`; webhook contract and worked
signature examples: `../webhooks/WEBHOOKS.md`.
