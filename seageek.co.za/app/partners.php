<?php
/**
 * Wholesale partners (upstream providers) and the adapters that talk to them.
 * Partners are configured in Admin > Partners. Requests are routed by priority with automatic failover.
 */
declare(strict_types=1);

final class Partners
{
    public static function config(array $partner): array
    {
        return json_decode(Crypto::decrypt($partner['config_enc'] ?? ''), true) ?: [];
    }

    public static function saveConfig(int $id, array $config): void
    {
        DB::update('partners', ['config_enc' => Crypto::encrypt(json_encode($config))], 'id = ?', [$id]);
    }

    /** Active partners for a service, best first. A partner that failed 5 times in a row drops to the back until it succeeds again. */
    public static function forService(string $service): array
    {
        return DB::all('SELECT * FROM partners WHERE service = ? AND active = 1 ORDER BY CASE WHEN fail_count >= 5 THEN 1 ELSE 0 END, priority, id', [$service]);
    }

    public static function firstActive(string $service, ?string $driver = null): ?array
    {
        foreach (self::forService($service) as $p) if ($driver === null || $p['driver'] === $driver) return $p;
        return null;
    }

    public static function markOk(array $p): void
    {
        DB::update('partners', ['last_ok_at' => now(), 'fail_count' => 0], 'id = ?', [$p['id']]);
    }

    public static function markFail(array $p, string $error): void
    {
        DB::update('partners', ['last_error' => mb_substr(now() . ' ' . $error, 0, 500), 'fail_count' => (int) $p['fail_count'] + 1], 'id = ?', [$p['id']]);
        log_line('partners', "{$p['name']} failed: $error");
    }

    /**
     * Try each active partner for the service in order until one accepts the request.
     * @return array{ok:bool, partner:?array, external_id:?string, error:?string, data:array}
     */
    public static function dispatch(string $service, array $payload): array
    {
        $partners = self::forService($service);
        if (!$partners) return ['ok' => false, 'partner' => null, 'external_id' => null, 'error' => 'No active partner is configured for ' . $service, 'data' => []];
        $last = 'Unknown error';
        foreach ($partners as $p) {
            try {
                $res = Adapters::send($p, $service, $payload);
            } catch (Throwable $e) {
                $res = ['ok' => false, 'error' => $e->getMessage(), 'retryable' => true];
            }
            if ($res['ok']) {
                self::markOk($p);
                return ['ok' => true, 'partner' => $p, 'external_id' => $res['external_id'] ?? null, 'error' => null, 'data' => $res['data'] ?? []];
            }
            self::markFail($p, (string) ($res['error'] ?? 'error'));
            $last = (string) ($res['error'] ?? 'error');
            if (empty($res['retryable'])) break; // e.g. invalid number: another route won't help
        }
        return ['ok' => false, 'partner' => null, 'external_id' => null, 'error' => $last, 'data' => []];
    }
}

final class Adapters
{
    public static function send(array $partner, string $service, array $payload): array
    {
        return match ($partner['driver']) {
            'http' => self::httpTemplate($partner, $payload),
            'ses' => self::sesSend($partner, $payload),
            'd360' => self::d360Send($partner, $payload),
            default => ['ok' => false, 'error' => 'Driver ' . $partner['driver'] . ' cannot handle ' . $service, 'retryable' => true],
        };
    }

    /**
     * Generic JSON-over-HTTP adapter. The admin pastes the partner's endpoint, headers and a body template
     * with {{placeholders}} (to, body, from, subject, html, text, reference, text, code, id_number, ...).
     */
    public static function httpTemplate(array $partner, array $payload): array
    {
        $c = Partners::config($partner);
        if (empty($c['url'])) return ['ok' => false, 'error' => 'Partner URL not set', 'retryable' => true];
        $vars = $payload + ['secret' => $c['secret'] ?? ''];
        $fill = function (string $tpl, bool $json) use ($vars): string {
            return preg_replace_callback('/\{\{\s*([a-z0-9_]+)\s*\}\}/i', function ($m) use ($vars, $json) {
                $v = $vars[$m[1]] ?? '';
                if (is_array($v)) $v = implode(',', $v);
                return $json ? substr(json_encode((string) $v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 1, -1) : (string) $v;
            }, $tpl);
        };
        $headers = [];
        foreach (preg_split('/\r?\n/', (string) ($c['headers'] ?? '')) as $line) {
            if (trim($line) !== '') $headers[] = $fill(trim($line), false);
        }
        $body = trim((string) ($c['body'] ?? '')) !== '' ? $fill((string) $c['body'], true) : json_encode($payload);
        $res = Http::request($c['method'] ?? 'POST', $fill($c['url'], false), $headers, $body, 30);
        if ($res['error']) return ['ok' => false, 'error' => $res['error'], 'retryable' => true];
        if ($res['status'] < 200 || $res['status'] >= 300) {
            return ['ok' => false, 'error' => "HTTP {$res['status']}: " . mb_substr($res['body'], 0, 200), 'retryable' => $res['status'] >= 500 || $res['status'] === 429];
        }
        $id = self::dig($res['json'], (string) ($c['id_path'] ?? 'id'));
        return ['ok' => true, 'external_id' => $id !== null ? (string) $id : null, 'data' => is_array($res['json']) ? $res['json'] : []];
    }

    private static function dig($data, string $path)
    {
        foreach (explode('.', $path) as $k) {
            if (is_array($data) && array_key_exists($k, $data)) $data = $data[$k];
            elseif (is_array($data) && ctype_digit($k) && array_key_exists((int) $k, $data)) $data = $data[(int) $k];
            else return null;
        }
        return is_scalar($data) ? $data : null;
    }

    /** Amazon SES v2 SendEmail, signed with AWS Signature Version 4. */
    public static function sesSend(array $partner, array $m): array
    {
        $c = Partners::config($partner);
        $region = $c['region'] ?? 'af-south-1';
        if (empty($c['access_key']) || empty($c['secret_key'])) return ['ok' => false, 'error' => 'SES keys not set', 'retryable' => true];
        $host = "email.$region.amazonaws.com";
        $path = '/v2/email/outbound-emails';
        $content = ['Simple' => ['Subject' => ['Data' => $m['subject'], 'Charset' => 'UTF-8'], 'Body' => []]];
        if (!empty($m['html'])) $content['Simple']['Body']['Html'] = ['Data' => $m['html'], 'Charset' => 'UTF-8'];
        if (!empty($m['text'])) $content['Simple']['Body']['Text'] = ['Data' => $m['text'], 'Charset' => 'UTF-8'];
        $body = ['FromEmailAddress' => $m['from'], 'Destination' => ['ToAddresses' => array_values((array) $m['to'])], 'Content' => $content];
        if (!empty($m['reply_to'])) $body['ReplyToAddresses'] = [$m['reply_to']];
        if (!empty($c['configuration_set'])) $body['ConfigurationSetName'] = $c['configuration_set'];
        $payload = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $amzDate = gmdate('Ymd\THis\Z');
        $date = gmdate('Ymd');
        $scope = "$date/$region/ses/aws4_request";
        $canonicalHeaders = "content-type:application/json\nhost:$host\nx-amz-date:$amzDate\n";
        $signed = 'content-type;host;x-amz-date';
        $canonical = "POST\n$path\n\n$canonicalHeaders\n$signed\n" . hash('sha256', $payload);
        $toSign = "AWS4-HMAC-SHA256\n$amzDate\n$scope\n" . hash('sha256', $canonical);
        $k = hash_hmac('sha256', 'aws4_request', hash_hmac('sha256', 'ses', hash_hmac('sha256', $region, hash_hmac('sha256', $date, 'AWS4' . $c['secret_key'], true), true), true), true);
        $sig = hash_hmac('sha256', $toSign, $k);
        $res = Http::request('POST', "https://$host$path", [
            'Content-Type' => 'application/json', 'X-Amz-Date' => $amzDate,
            'Authorization' => "AWS4-HMAC-SHA256 Credential={$c['access_key']}/$scope, SignedHeaders=$signed, Signature=$sig",
        ], $payload);
        if ($res['status'] === 200) return ['ok' => true, 'external_id' => $res['json']['MessageId'] ?? null];
        return ['ok' => false, 'error' => "SES {$res['status']}: " . mb_substr($res['body'] ?: (string) $res['error'], 0, 200), 'retryable' => $res['status'] >= 500 || $res['status'] === 429 || $res['status'] === 0];
    }

    /** 360dialog WhatsApp Cloud API. Each number carries its own channel API key. */
    public static function d360Send(array $partner, array $m): array
    {
        $c = Partners::config($partner);
        if (empty($m['channel_key'])) return ['ok' => false, 'error' => 'This WhatsApp number has no 360dialog channel key yet', 'retryable' => true];
        $body = ['messaging_product' => 'whatsapp', 'recipient_type' => 'individual', 'to' => ltrim((string) $m['to'], '+')];
        if (($m['type'] ?? 'text') === 'template') {
            $t = $m['template'];
            $body['type'] = 'template';
            $body['template'] = ['name' => $t['name'], 'language' => ['code' => $t['language'] ?? 'en'], 'components' => $t['components'] ?? []];
        } else {
            $body['type'] = 'text';
            $body['text'] = ['body' => $m['text']];
        }
        $res = Http::request('POST', rtrim($c['base_url'] ?? 'https://waba-v2.360dialog.io', '/') . '/messages', ['D360-API-KEY' => $m['channel_key']], $body);
        if ($res['status'] >= 200 && $res['status'] < 300) return ['ok' => true, 'external_id' => $res['json']['messages'][0]['id'] ?? null];
        return ['ok' => false, 'error' => "360dialog {$res['status']}: " . mb_substr($res['body'] ?: (string) $res['error'], 0, 200), 'retryable' => $res['status'] >= 500 || $res['status'] === 0];
    }
}
