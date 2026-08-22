# TitoPay Outbound Webhooks

TitoPay delivers signed, real-time payment events to any HTTPS endpoint a
merchant or POS partner registers. Events originate from the same database
transaction that moves the money, so a delivered event is never speculative —
if you received `payment.completed`, the ledger movement it describes has
committed.

- Base URL: `https://api.titopay.co.za/v1`
- Authentication for management calls: the merchant's TitoPay bearer token
- Delivery: `POST` to your endpoint, JSON body, HMAC-SHA256 signed
- Guarantee: **at least once, in order per subscription** — always de-duplicate
  on the event `id`
- Truth: webhooks are a notification, not the ledger. On anything
  surprising, confirm with `GET /v1/pos/payment-intents/{paymentId}`.

## Event catalogue

| Event | Fires when |
|---|---|
| `payment.created` | A payment intent (QR) is created by a terminal |
| `payment.scanned` | A customer's app has scanned the QR |
| `payment.completed` | The customer confirmed and the money moved |
| `payment.failed` | The payment failed after scanning |
| `payment.cancelled` | The terminal cancelled the intent |
| `payment.expired` | The QR's 120-second life ended unused |
| `refund.created` | A refund or reversal was initiated |
| `refund.completed` | The refund/reversal money movement committed |
| `settlement.completed` | Reserved for the settlement engine (not yet emitted) |
| `test.ping` | Sent by the subscription test endpoint only |

TitoPay refunds settle in a single database transaction, so `refund.created`
and `refund.completed` describe the same moment and arrive together, in that
order, with distinct event `id`s.

## Envelope

```json
{
  "id": "evt_5f2c9b1e8d474a02a7c31c9ce4b1f3aa",
  "type": "payment.completed",
  "apiVersion": "v1",
  "createdAt": "2026-08-22T09:41:03.512Z",
  "data": {
    "paymentId": "POSP-8A11C4D2E9F0",
    "merchantId": "TPM-000123",
    "merchantReference": "TILL-7-0091",
    "amount": 149.5,
    "currency": "ZAR",
    "status": "COMPLETED",
    "previousStatus": "SCANNED",
    "terminalId": "TERM-STORE-07",
    "provider": "OTHER",
    "occurredAt": "2026-08-22T09:41:03.498Z",
    "transactionReference": "POS-1755855663-4F2A"
  }
}
```

Refund events add a `refund` object: `{ "kind": "refund" | "reverse",
"amount": 50.0, "reference": "POS-REF-..." }`.

## Verifying the signature

Every delivery carries:

| Header | Meaning |
|---|---|
| `X-TitoPay-Signature` | `sha256=` + HMAC-SHA256 hex digest (see recipe) |
| `X-TitoPay-Timestamp` | Unix milliseconds at send time |
| `X-TitoPay-Event-ID` | The envelope `id` |
| `X-TitoPay-Event-Type` | The envelope `type` |
| `X-TitoPay-Delivery-ID` | Unique per delivery attempt row |
| `X-TitoPay-Signature-Previous` | Present only during a secret rotation overlap |

The signed string is three lines joined by `\n`:

```
{timestamp}\n{eventId}\n{sha256hex(rawBody)}
```

HMAC-SHA256 that string with your endpoint secret (`whsec_...`) and compare
against the header **using a constant-time comparison**. Reject anything whose
timestamp is more than 5 minutes from your clock, and drop event `id`s you
have already processed (at-least-once delivery means duplicates are normal
after network flaps). During a rotation, accept a match against **either**
`X-TitoPay-Signature` (new secret) or `X-TitoPay-Signature-Previous` (old
secret, valid 24 hours).

Respond `2xx` within 10 seconds — do your processing after acknowledging.
Respond `410 Gone` to permanently unsubscribe the endpoint. Anything else is
retried: 1 min, 5 min, 15 min, 1 hour, 6 hours; after six attempts the
delivery is parked dead and can be replayed from the API.

### Node.js

```js
const crypto = require("crypto");

function verifyTitoPayWebhook(req, rawBody, secret) {
  const timestamp = req.headers["x-titopay-timestamp"];
  const eventId = req.headers["x-titopay-event-id"];
  const received = String(req.headers["x-titopay-signature"] || "").replace(/^sha256=/, "");
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const expected = crypto.createHmac("sha256", secret)
    .update(`${timestamp}\n${eventId}\n${bodyHash}`).digest("hex");
  return received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
```

### Java

```java
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.HexFormat;

public final class TitoPayWebhook {
  public static boolean verify(String timestamp, String eventId, String signatureHeader,
                               byte[] rawBody, String secret) throws Exception {
    if (Math.abs(System.currentTimeMillis() - Long.parseLong(timestamp)) > 5 * 60 * 1000L) return false;
    String bodyHash = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(rawBody));
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    String expected = HexFormat.of().formatHex(
        mac.doFinal((timestamp + "\n" + eventId + "\n" + bodyHash).getBytes(StandardCharsets.UTF_8)));
    String received = signatureHeader.replaceFirst("^sha256=", "");
    return MessageDigest.isEqual(
        expected.getBytes(StandardCharsets.UTF_8), received.getBytes(StandardCharsets.UTF_8));
  }
}
```

### PHP

```php
function verifyTitoPayWebhook(array $headers, string $rawBody, string $secret): bool {
    $timestamp = $headers['x-titopay-timestamp'] ?? '';
    $eventId = $headers['x-titopay-event-id'] ?? '';
    $received = preg_replace('/^sha256=/', '', $headers['x-titopay-signature'] ?? '');
    if (abs((int) (microtime(true) * 1000) - (int) $timestamp) > 5 * 60 * 1000) return false;
    $bodyHash = hash('sha256', $rawBody);
    $expected = hash_hmac('sha256', $timestamp . "\n" . $eventId . "\n" . $bodyHash, $secret);
    return hash_equals($expected, $received);
}
```

### Android / Kotlin

```kotlin
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.abs

fun verifyTitoPayWebhook(
    timestamp: String, eventId: String, signatureHeader: String,
    rawBody: ByteArray, secret: String
): Boolean {
    if (abs(System.currentTimeMillis() - timestamp.toLong()) > 5 * 60 * 1000) return false
    val bodyHash = MessageDigest.getInstance("SHA-256").digest(rawBody)
        .joinToString("") { "%02x".format(it) }
    val mac = Mac.getInstance("HmacSHA256").apply {
        init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
    }
    val expected = mac.doFinal("$timestamp\n$eventId\n$bodyHash".toByteArray())
        .joinToString("") { "%02x".format(it) }
    val received = signatureHeader.removePrefix("sha256=")
    return MessageDigest.isEqual(expected.toByteArray(), received.toByteArray())
}
```

## Managing subscriptions

All calls carry the merchant's bearer token. The plaintext secret is returned
**exactly once** — on creation and on rotation. Store it then; it cannot be
retrieved later.

| Action | Call |
|---|---|
| Event catalogue | `GET /v1/webhooks/events` |
| Create subscription | `POST /v1/webhooks/subscriptions` `{ "endpointUrl": "https://...", "events": ["payment.completed"] }` |
| List subscriptions | `GET /v1/webhooks/subscriptions` |
| Update (URL, events, pause/resume) | `PUT /v1/webhooks/subscriptions/{id}` |
| Delete | `DELETE /v1/webhooks/subscriptions/{id}` |
| Rotate secret (24 h overlap) | `POST /v1/webhooks/subscriptions/{id}/rotate-secret` |
| List delivery attempts | `GET /v1/webhooks/subscriptions/{id}/deliveries?status=dead` |
| Replay a delivery | `POST /v1/webhooks/subscriptions/{id}/deliveries/{deliveryId}/replay` |
| Send a test ping | `POST /v1/webhooks/subscriptions/{id}/test` |

An empty `events` array subscribes to everything. A merchant can hold up to
10 subscriptions. Endpoints must be public HTTPS — private, loopback and
link-local targets are refused. Ten consecutive dead deliveries pause a
subscription automatically; resume it with `PUT { "status": "active" }` once
your endpoint is healthy.

The machine-readable specification for these endpoints is
`openapi-webhooks.yaml` beside this document.
