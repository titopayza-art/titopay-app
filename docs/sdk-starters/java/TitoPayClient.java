package za.co.titopay.starter;

/*
 * TitoPay POS starter client - Java 17+, JDK HttpClient only.
 *
 * TitoPayClient client = new TitoPayClient(
 *     "https://api-sandbox.titopay.co.za", "SBX-TERM-01",
 *     System.getenv("TITOPAY_TERMINAL_SECRET"), "TPM-SBX-ABC123");
 * String payment = client.createPayment(149.50, "TILL-7-0091");
 * // parse paymentId + qrPayload with your JSON library, render the QR,
 * // then poll getPayment(...) or take the webhook.
 */

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class TitoPayClient {
  private final String baseUrl;
  private final String terminalId;
  private final String terminalSecret;
  private final String merchantId;
  private final HttpClient http = HttpClient.newHttpClient();

  public TitoPayClient(String baseUrl, String terminalId, String terminalSecret, String merchantId) {
    this.baseUrl = baseUrl.replaceAll("/+$", "");
    this.terminalId = terminalId;
    this.terminalSecret = terminalSecret;
    this.merchantId = merchantId;
  }

  private static String sha256Hex(byte[] data) throws Exception {
    return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
  }

  private static String hmacHex(String secret, String message) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
  }

  public String request(String method, String path, String jsonBody) throws Exception {
    String body = jsonBody == null ? "" : jsonBody;
    String timestamp = String.valueOf(System.currentTimeMillis());
    String nonce = UUID.randomUUID().toString();
    String canonical = String.join("\n", timestamp, nonce, method.toUpperCase(), path,
        sha256Hex(body.getBytes(StandardCharsets.UTF_8)));
    HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(baseUrl + path))
        .header("X-TitoPay-Terminal-Id", terminalId)
        .header("X-TitoPay-Timestamp", timestamp)
        .header("X-TitoPay-Nonce", nonce)
        .header("X-TitoPay-Signature", "sha256=" + hmacHex(terminalSecret, canonical));
    if (jsonBody == null) {
      builder.method(method, HttpRequest.BodyPublishers.noBody());
    } else {
      builder.header("Content-Type", "application/json")
          .header("Idempotency-Key", UUID.randomUUID().toString())
          .method(method, HttpRequest.BodyPublishers.ofString(jsonBody));
    }
    HttpResponse<String> response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() < 200 || response.statusCode() >= 300) {
      throw new RuntimeException("TitoPay request failed (HTTP " + response.statusCode() + "): " + response.body());
    }
    return response.body();
  }

  public String createPayment(double amount, String merchantReference) throws Exception {
    String body = String.format(
        "{\"merchantId\":\"%s\",\"terminalId\":\"%s\",\"amount\":%s,\"currency\":\"ZAR\",\"merchantReference\":\"%s\"}",
        merchantId, terminalId, amount, merchantReference);
    return request("POST", "/v1/pos/payment-intents", body);
  }

  public String getPayment(String paymentId) throws Exception {
    return request("GET", "/v1/pos/payment-intents/" + paymentId, null);
  }

  public String cancelPayment(String paymentId) throws Exception {
    return request("POST", "/v1/pos/payment-intents/" + paymentId + "/cancel", "{}");
  }

  /** Webhook verification - constant-time, timestamp-bounded, rotation-aware. */
  public static boolean verifyWebhook(String timestamp, String eventId,
      String signatureHeader, String previousSignatureHeader,
      byte[] rawBody, String secret, String previousSecret) throws Exception {
    if (Math.abs(System.currentTimeMillis() - Long.parseLong(timestamp)) > 5 * 60 * 1000L) return false;
    String bodyHash = sha256Hex(rawBody);
    String signed = timestamp + "\n" + eventId + "\n" + bodyHash;
    java.util.function.BiPredicate<String, String> matches = (header, key) -> {
      if (header == null || header.isEmpty()) return false;
      try {
        String expected = hmacHex(key, signed);
        String received = header.replaceFirst("^sha256=", "");
        return MessageDigest.isEqual(
            expected.getBytes(StandardCharsets.UTF_8), received.getBytes(StandardCharsets.UTF_8));
      } catch (Exception error) {
        return false;
      }
    };
    if (matches.test(signatureHeader, secret)) return true;
    return previousSecret != null && matches.test(previousSignatureHeader, previousSecret);
  }
}
