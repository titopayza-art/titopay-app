<?php
/**
 * TitoPay POS starter client - PHP 8+, cURL only.
 *
 * $client = new TitoPayClient(
 *   'https://api-sandbox.titopay.co.za', 'SBX-TERM-01',
 *   getenv('TITOPAY_TERMINAL_SECRET'), 'TPM-SBX-ABC123');
 * $payment = $client->createPayment(149.50, 'TILL-7-0091');
 * // render $payment['qrPayload'] as a QR, then poll or take the webhook.
 */
final class TitoPayClient
{
    public function __construct(
        private string $baseUrl,
        private string $terminalId,
        private string $terminalSecret,
        private string $merchantId
    ) {
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    private function signedHeaders(string $method, string $path, string $body): array
    {
        $timestamp = (string) (int) (microtime(true) * 1000);
        $nonce = bin2hex(random_bytes(12));
        $canonical = implode("\n", [$timestamp, $nonce, strtoupper($method), $path, hash('sha256', $body)]);
        $signature = hash_hmac('sha256', $canonical, $this->terminalSecret);
        return [
            "X-TitoPay-Terminal-Id: {$this->terminalId}",
            "X-TitoPay-Timestamp: {$timestamp}",
            "X-TitoPay-Nonce: {$nonce}",
            "X-TitoPay-Signature: sha256={$signature}",
        ];
    }

    /** @return array<string,mixed> decoded JSON; throws on non-2xx */
    public function request(string $method, string $path, ?array $payload = null): array
    {
        $body = $payload === null ? '' : json_encode($payload, JSON_UNESCAPED_SLASHES);
        $headers = $this->signedHeaders($method, $path, $body);
        if ($payload !== null) {
            $headers[] = 'Content-Type: application/json';
            $headers[] = 'Idempotency-Key: ' . bin2hex(random_bytes(16));
        }
        $curl = curl_init($this->baseUrl . $path);
        curl_setopt_array($curl, [
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => $payload === null ? null : $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 15,
        ]);
        $response = curl_exec($curl);
        $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        $json = json_decode((string) $response, true) ?: [];
        if ($status < 200 || $status >= 300 || (($json['ok'] ?? true) === false)) {
            throw new RuntimeException(($json['error'] ?? 'Request failed') . " (HTTP {$status})");
        }
        return $json;
    }

    public function createPayment(float $amount, string $merchantReference): array
    {
        $result = $this->request('POST', '/v1/pos/payment-intents', [
            'merchantId' => $this->merchantId,
            'terminalId' => $this->terminalId,
            'amount' => $amount,
            'currency' => 'ZAR',
            'merchantReference' => $merchantReference,
        ]);
        return $result['payment'];
    }

    public function getPayment(string $paymentId): array
    {
        $result = $this->request('GET', "/v1/pos/payment-intents/{$paymentId}");
        return $result['payment'] ?? $result;
    }

    public function cancelPayment(string $paymentId): array
    {
        return $this->request('POST', "/v1/pos/payment-intents/{$paymentId}/cancel", []);
    }

    /** Webhook verification - constant-time, timestamp-bounded, rotation-aware. */
    public static function verifyWebhook(
        array $headers,
        string $rawBody,
        string $secret,
        ?string $previousSecret = null,
        int $toleranceMs = 300000
    ): bool {
        $headers = array_change_key_case($headers, CASE_LOWER);
        $timestamp = $headers['x-titopay-timestamp'] ?? '';
        $eventId = $headers['x-titopay-event-id'] ?? '';
        if (abs((int) (microtime(true) * 1000) - (int) $timestamp) > $toleranceMs) {
            return false;
        }
        $signed = $timestamp . "\n" . $eventId . "\n" . hash('sha256', $rawBody);
        $matches = static function (?string $header, string $key) use ($signed): bool {
            if ($header === null || $header === '') return false;
            $received = preg_replace('/^sha256=/', '', $header);
            return hash_equals(hash_hmac('sha256', $signed, $key), $received);
        };
        if ($matches($headers['x-titopay-signature'] ?? null, $secret)) return true;
        return $previousSecret !== null
            && $matches($headers['x-titopay-signature-previous'] ?? null, $previousSecret);
    }
}
