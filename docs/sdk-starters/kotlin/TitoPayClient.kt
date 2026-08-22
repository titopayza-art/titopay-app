package za.co.titopay.starter

/*
 * TitoPay POS starter client - Android/Kotlin, no third-party dependencies
 * (java.net.HttpURLConnection + javax.crypto). Swap the transport for OkHttp
 * in production apps; the signing and verification stay identical.
 */

import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.abs

class TitoPayClient(
    private val baseUrl: String,          // https://api-sandbox.titopay.co.za
    private val terminalId: String,
    private val terminalSecret: String,
    private val merchantId: String
) {
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
    private fun sha256Hex(data: ByteArray) =
        hex(MessageDigest.getInstance("SHA-256").digest(data))
    private fun hmacHex(secret: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(), "HmacSHA256"))
        return hex(mac.doFinal(message.toByteArray()))
    }

    private fun signedHeaders(method: String, path: String, body: String): Map<String, String> {
        val timestamp = System.currentTimeMillis().toString()
        val nonce = UUID.randomUUID().toString()
        val canonical = listOf(timestamp, nonce, method.uppercase(), path,
            sha256Hex(body.toByteArray())).joinToString("\n")
        return mapOf(
            "X-TitoPay-Terminal-Id" to terminalId,
            "X-TitoPay-Timestamp" to timestamp,
            "X-TitoPay-Nonce" to nonce,
            "X-TitoPay-Signature" to "sha256=${hmacHex(terminalSecret, canonical)}"
        )
    }

    /** Raw signed request; returns the response body. Throws on non-2xx. */
    fun request(method: String, path: String, jsonBody: String? = null): String {
        val connection = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        connection.requestMethod = method
        signedHeaders(method, path, jsonBody ?: "").forEach { (k, v) -> connection.setRequestProperty(k, v) }
        if (jsonBody != null) {
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Idempotency-Key", UUID.randomUUID().toString())
            connection.doOutput = true
            connection.outputStream.use { it.write(jsonBody.toByteArray()) }
        }
        val stream = if (connection.responseCode in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader()?.readText() ?: ""
        if (connection.responseCode !in 200..299) {
            throw RuntimeException("TitoPay request failed (HTTP ${connection.responseCode}): $body")
        }
        return body
    }

    /** Create a QR payment; parse paymentId and qrPayload from the JSON with your JSON library. */
    fun createPayment(amount: Double, merchantReference: String): String =
        request("POST", "/v1/pos/payment-intents",
            """{"merchantId":"$merchantId","terminalId":"$terminalId","amount":$amount,"currency":"ZAR","merchantReference":"$merchantReference"}""")

    fun getPayment(paymentId: String): String =
        request("GET", "/v1/pos/payment-intents/$paymentId")

    fun cancelPayment(paymentId: String): String =
        request("POST", "/v1/pos/payment-intents/$paymentId/cancel", "{}")

    companion object {
        /** Webhook verification - constant-time, timestamp-bounded, rotation-aware. */
        fun verifyWebhook(
            timestamp: String, eventId: String,
            signatureHeader: String?, previousSignatureHeader: String?,
            rawBody: ByteArray, secret: String, previousSecret: String? = null,
            toleranceMs: Long = 5 * 60 * 1000
        ): Boolean {
            if (abs(System.currentTimeMillis() - timestamp.toLong()) > toleranceMs) return false
            val bodyHash = MessageDigest.getInstance("SHA-256").digest(rawBody)
                .joinToString("") { "%02x".format(it) }
            fun expected(key: String): String {
                val mac = Mac.getInstance("HmacSHA256")
                mac.init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
                return mac.doFinal("$timestamp\n$eventId\n$bodyHash".toByteArray())
                    .joinToString("") { "%02x".format(it) }
            }
            fun matches(header: String?, key: String): Boolean {
                val received = header?.removePrefix("sha256=") ?: return false
                return MessageDigest.isEqual(expected(key).toByteArray(), received.toByteArray())
            }
            if (matches(signatureHeader, secret)) return true
            return previousSecret != null && matches(previousSignatureHeader, previousSecret)
        }
    }
}
