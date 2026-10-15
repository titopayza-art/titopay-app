<?php
// Email, card payments and SMS, set up from the admin portal (Integrations).
//
// Settings live in the integration_settings table, one row per service, as
// JSON. Secret fields (passwords, API keys) are encrypted with the site's data
// key before they are stored and are never sent back to a browser: the admin
// page only learns whether each one is set. A value saved here wins over the
// same setting in the data folder's config.php, so the config file is only
// needed for things the portal does not cover.
declare(strict_types=1);

// What each service needs. 'secret' fields are write-only.
const INTEGRATION_FIELDS = [
    'mail' => [
        'mode' => ['label' => 'Send email with', 'options' => ['smtp' => 'SMTP mailbox (recommended)', 'mail' => "Hosting server's mail()", 'log' => 'Do not send (log only)']],
        'smtpHost' => ['label' => 'SMTP server', 'placeholder' => 'mail.ticketroom.co.za'],
        'smtpPort' => ['label' => 'Port', 'placeholder' => '465', 'int' => true],
        'smtpUser' => ['label' => 'Username', 'secret' => true, 'plain' => true, 'hint' => 'Usually the full mailbox address.'],
        'smtpPass' => ['label' => 'Password', 'secret' => true],
        'fromEmail' => ['label' => 'Send from', 'placeholder' => 'hello@ticketroom.co.za'],
        'fromName' => ['label' => 'Sender name', 'placeholder' => 'TicketRoom'],
    ],
    'payments' => [
        'provider' => ['label' => 'Payment provider', 'options' => ['none' => 'Not set up (free events only)', 'sandbox' => 'TicketRoom sandbox (practice payments, no provider needed)', 'yoco' => 'Yoco (cards, Apple Pay, Google Pay)', 'payfast' => 'PayFast (cards, instant EFT, SnapScan, Zapper)']],
        'mode' => ['label' => 'Mode', 'options' => ['test' => 'Test (no real money)', 'live' => 'Live']],
        'yocoSecretKey' => ['label' => 'Yoco secret key', 'secret' => true, 'provider' => 'yoco', 'hint' => 'From the Yoco portal: Sales → Payment gateway → API keys. Starts with sk_test_ or sk_live_.'],
        'yocoWebhookSecret' => ['label' => 'Yoco webhook secret', 'secret' => true, 'provider' => 'yoco', 'hint' => 'Filled in for you when you save: TicketRoom registers its notification address with Yoco.'],
        'payfastMerchantId' => ['label' => 'PayFast merchant ID', 'secret' => true, 'plain' => true, 'provider' => 'payfast'],
        'payfastMerchantKey' => ['label' => 'PayFast merchant key', 'secret' => true, 'provider' => 'payfast'],
        'payfastPassphrase' => ['label' => 'PayFast passphrase', 'secret' => true, 'provider' => 'payfast', 'hint' => 'Set the same passphrase under Settings → Developer settings in PayFast.'],
    ],
    'sms' => [
        'provider' => ['label' => 'SMS provider', 'options' => ['none' => 'Not set up', 'bulksms' => 'BulkSMS', 'clickatell' => 'Clickatell', 'http' => 'My own provider (any web API)']],
        'bulksmsTokenId' => ['label' => 'BulkSMS token ID', 'secret' => true, 'plain' => true, 'provider' => 'bulksms'],
        'bulksmsTokenSecret' => ['label' => 'BulkSMS token secret', 'secret' => true, 'provider' => 'bulksms'],
        'clickatellApiKey' => ['label' => 'Clickatell API key', 'secret' => true, 'provider' => 'clickatell'],
        'httpUrl' => ['label' => 'Send-SMS web address', 'secret' => true, 'plain' => true, 'provider' => 'http', 'hint' => 'From your provider\'s API documentation, starting with https://. Kept secret, as some providers put the key in it.'],
        'httpAuth' => ['label' => 'Authorization header', 'secret' => true, 'provider' => 'http', 'hint' => 'Optional. The whole value, for example: Bearer 1a2b3c… or Basic dXNlcjpwYXNz'],
        'httpFormat' => ['label' => 'Send the message as', 'provider' => 'http', 'options' => ['json' => 'JSON (most providers)', 'form' => 'Form fields']],
        'httpToField' => ['label' => 'Field name for the number', 'provider' => 'http', 'placeholder' => 'to'],
        'httpMessageField' => ['label' => 'Field name for the message', 'provider' => 'http', 'placeholder' => 'message'],
        'httpSenderField' => ['label' => 'Field name for the sender', 'provider' => 'http', 'placeholder' => 'from', 'hint' => 'Optional. Leave blank if your provider sets the sender.'],
        'httpNumberFormat' => ['label' => 'Number format', 'provider' => 'http', 'options' => ['plus' => '+27821234567', 'intl' => '27821234567', 'local' => '0821234567']],
        'senderId' => ['label' => 'Sender name', 'placeholder' => 'TicketRoom', 'hint' => 'Only if your provider has approved it.'],
    ],
    // Organiser identity checks (FICA). See lib/verification.php.
    'kyc' => [
        'provider' => ['label' => 'Identity checks by', 'options' => ['manual' => 'TicketRoom staff (every document reviewed by a person)', 'sandbox' => 'Sandbox: simulated checks for testing, nothing real is checked', 'http' => 'My own provider (any web API)']],
        'httpUrl' => ['label' => 'Check-identity web address', 'secret' => true, 'plain' => true, 'provider' => 'http', 'hint' => 'Starting with https://. TicketRoom posts JSON (reference, documentType, idNumber, fullName, dateOfBirth, country) and expects {"status": "verified" | "declined" | "refer"}.'],
        'httpAuth' => ['label' => 'Authorization header', 'secret' => true, 'provider' => 'http', 'hint' => 'Optional. The whole value, for example: Bearer 1a2b3c…'],
    ],
];

// Saved values for a service, secrets decrypted. Cached for the request.
function integration_saved(string $group): array
{
    static $cache = [];
    if (isset($GLOBALS['TR_INTEG_RESET'])) { $cache = []; unset($GLOBALS['TR_INTEG_RESET']); }
    if (array_key_exists($group, $cache)) return $cache[$group];
    $raw = null;
    try { $raw = val('SELECT value FROM integration_settings WHERE key = ?', [$group]); } catch (Throwable $e) { /* not installed yet */ }
    $v = $raw ? (json_decode((string) $raw, true) ?: []) : [];
    foreach (INTEGRATION_FIELDS[$group] ?? [] as $k => $f) {
        if (!empty($f['secret']) && isset($v[$k]) && $v[$k] !== '') {
            // Fields that became secret later (username, merchant ID, token ID) may
            // still be stored in plain text from before; they are encrypted on the next save.
            if (!str_starts_with((string) $v[$k], 'v1.')) continue;
            try { $v[$k] = decrypt_str($v[$k]); } catch (Throwable $e) { $v[$k] = ''; }
        }
    }
    return $cache[$group] = $v;
}
function integration_value(string $group, string $field)
{
    $v = integration_saved($group);
    return array_key_exists($field, $v) && $v[$field] !== '' && $v[$field] !== null ? $v[$field] : null;
}

// Saves new values. Blank secret fields keep what is stored; 'clear' lists
// secrets to remove. Returns the names of fields that changed (never values).
function integration_save(string $group, array $in, array $clear, string $userId): array
{
    $fields = INTEGRATION_FIELDS[$group];
    $cur = integration_saved($group);
    $next = $cur;
    $changed = [];
    foreach ($fields as $k => $f) {
        if (in_array($k, $clear, true) && !empty($f['secret'])) { if (($cur[$k] ?? '') !== '') $changed[] = $k; $next[$k] = ''; continue; }
        if (!array_key_exists($k, $in)) continue;
        $val = is_string($in[$k]) ? trim($in[$k]) : $in[$k];
        if (!empty($f['secret']) && $val === '') continue;
        if (isset($f['options']) && !isset($f['options'][$val])) throw invalid([$k => 'Choose one of the options.']);
        if (!empty($f['int']) && $val !== '' && !ctype_digit((string) $val)) throw invalid([$k => 'Numbers only.']);
        if (strlen((string) $val) > 300) throw invalid([$k => 'Too long.']);
        if ((string) ($cur[$k] ?? '') !== (string) $val) $changed[] = $k;
        $next[$k] = $val;
    }
    $store = $next;
    foreach ($fields as $k => $f) if (!empty($f['secret']) && ($store[$k] ?? '') !== '') $store[$k] = encrypt_str((string) $store[$k]);
    q('INSERT INTO integration_settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        [$group, json_encode($store, JSON_UNESCAPED_SLASHES), $userId, now_iso()]);
    $GLOBALS['TR_INTEG_RESET'] = true;
    return $changed;
}

// What the admin page shows: options, plain values, and only "set / not set" for secrets.
function integration_form(string $group): array
{
    $saved = integration_saved($group);
    $out = [];
    foreach (INTEGRATION_FIELDS[$group] as $k => $f) {
        $effective = cfg("$group.$k");
        $row = ['name' => $k, 'label' => $f['label'], 'secret' => !empty($f['secret']), 'hint' => $f['hint'] ?? null, 'placeholder' => $f['placeholder'] ?? null,
            'provider' => $f['provider'] ?? null, 'options' => $f['options'] ?? null, 'fromConfigFile' => !array_key_exists($k, $saved) && $effective !== null && $effective !== ''];
        if (!empty($f['secret'])) { $row['set'] = $effective !== null && $effective !== ''; $row['plain'] = !empty($f['plain']); }
        else $row['value'] = $effective === null ? '' : (string) $effective;
        $out[] = $row;
    }
    return $out;
}

// ============================================================== outgoing HTTP
// Small JSON/form client for provider APIs. Uses cURL where the host has it,
// otherwise PHP streams. Times out quickly so a slow provider never hangs a page.
function http_request(string $method, string $url, array $headers = [], ?string $body = null, int $timeout = 15): array
{
    if (!preg_match('#^https?://#', $url)) throw new RuntimeException('Bad URL');
    $h = [];
    foreach ($headers as $k => $v) $h[] = "$k: $v";
    if (function_exists('curl_init')) {
        $c = curl_init($url);
        curl_setopt_array($c, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP]);
        if ($body !== null) curl_setopt($c, CURLOPT_POSTFIELDS, $body);
        $text = curl_exec($c);
        $status = (int) curl_getinfo($c, CURLINFO_HTTP_CODE);
        $err = curl_error($c);
        curl_close($c);
        if ($text === false) throw new RuntimeException('Could not reach ' . parse_url($url, PHP_URL_HOST) . ($err ? ": $err" : ''));
    } else {
        $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $h), 'content' => $body ?? '', 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0]]);
        $text = @file_get_contents($url, false, $ctx);
        if ($text === false) throw new RuntimeException('Could not reach ' . parse_url($url, PHP_URL_HOST));
        $status = preg_match('#HTTP/\S+ (\d{3})#', $http_response_header[0] ?? '', $m) ? (int) $m[1] : 0;
    }
    return ['status' => $status, 'text' => (string) $text, 'json' => json_decode((string) $text, true)];
}

// ============================================================== SMS
function sms_provider(): string { $p = (string) cfg('sms.provider', 'none'); return in_array($p, ['bulksms', 'clickatell', 'http'], true) ? $p : 'none'; }
function sms_ready(): bool
{
    return match (sms_provider()) {
        'bulksms' => (string) cfg('sms.bulksmsTokenId', '') !== '' && (string) cfg('sms.bulksmsTokenSecret', '') !== '',
        'clickatell' => (string) cfg('sms.clickatellApiKey', '') !== '',
        'http' => str_starts_with((string) cfg('sms.httpUrl', ''), 'https://') || (cfg('sms.allowPrivateHosts', false) && str_starts_with((string) cfg('sms.httpUrl', ''), 'http://')),
        default => false,
    };
}
// Your own provider: only secure addresses on the public internet, never this
// server or the hosting network.
function sms_http_url_ok(string $url): bool
{
    $p = parse_url($url);
    if (cfg('sms.allowPrivateHosts', false)) return !empty($p['host']); // test setups only (config file)
    if (($p['scheme'] ?? '') !== 'https' || empty($p['host']) || isset($p['user'])) return false;
    $ips = @gethostbynamel($p['host']) ?: [];
    if (!$ips) return false;
    foreach ($ips as $ip) if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return false;
    return true;
}
function sms_send_http(string $to, string $body, string $from): string
{
    $url = (string) cfg('sms.httpUrl');
    if (!sms_http_url_ok($url)) throw new RuntimeException('The send-SMS address must start with https:// and be on the public internet.');
    $digits = ltrim($to, '+');
    $number = match ((string) cfg('sms.httpNumberFormat', 'plus')) { 'intl' => $digits, 'local' => '0' . substr($digits, 2), default => '+' . $digits };
    $fields = [(string) (cfg('sms.httpToField') ?: 'to') => $number, (string) (cfg('sms.httpMessageField') ?: 'message') => $body];
    if ($from !== '' && (string) cfg('sms.httpSenderField', '') !== '') $fields[(string) cfg('sms.httpSenderField')] = $from;
    $json = cfg('sms.httpFormat', 'json') !== 'form';
    $headers = ['Content-Type' => $json ? 'application/json' : 'application/x-www-form-urlencoded', 'Accept' => 'application/json'];
    if ((string) cfg('sms.httpAuth', '') !== '') $headers['Authorization'] = (string) cfg('sms.httpAuth');
    $r = http_request('POST', $url, $headers, $json ? json_encode($fields) : http_build_query($fields));
    if ($r['status'] < 200 || $r['status'] >= 300) throw new RuntimeException('Your SMS provider refused the message (HTTP ' . $r['status'] . ').');
    $j = $r['json'];
    return (string) ($j['id'] ?? $j['message_id'] ?? $j['messageId'] ?? ($j['data']['id'] ?? 'http'));
}
// Sends one SMS to a +27 number. Returns the provider's message id.
function sms_send(string $to, string $body): string
{
    if (!sms_ready()) throw new RuntimeException('SMS is not set up (Admin portal → Integrations).');
    $to = preg_replace('/[^\d+]/', '', $to);
    $from = trim((string) cfg('sms.senderId', ''));
    if (sms_provider() === 'http') return sms_send_http($to, $body, $from);
    if (sms_provider() === 'bulksms') {
        $r = http_request('POST', 'https://api.bulksms.com/v1/messages', ['Content-Type' => 'application/json',
            'Authorization' => 'Basic ' . base64_encode(cfg('sms.bulksmsTokenId') . ':' . cfg('sms.bulksmsTokenSecret'))],
            json_encode(['to' => $to, 'body' => $body] + ($from !== '' ? ['from' => $from] : [])));
        if ($r['status'] >= 300) throw new RuntimeException('BulkSMS refused the message (HTTP ' . $r['status'] . ').');
        return (string) ($r['json'][0]['id'] ?? 'bulksms');
    }
    $r = http_request('POST', 'https://platform.clickatell.com/v1/message', ['Content-Type' => 'application/json', 'Authorization' => (string) cfg('sms.clickatellApiKey')],
        json_encode(['messages' => [['channel' => 'sms', 'to' => ltrim($to, '+'), 'content' => $body] + ($from !== '' ? ['from' => $from] : [])]]));
    if ($r['status'] >= 300 || !empty($r['json']['messages'][0]['error'])) throw new RuntimeException('Clickatell refused the message (HTTP ' . $r['status'] . ').');
    return (string) ($r['json']['messages'][0]['apiMessageId'] ?? 'clickatell');
}
// Checks the credentials without sending anything.
function sms_health(): array
{
    if (!sms_ready()) return ['ok' => false, 'detail' => 'Choose a provider and enter its keys first.'];
    if (sms_provider() === 'http') {
        return sms_http_url_ok((string) cfg('sms.httpUrl'))
            ? ['ok' => true, 'detail' => 'The address looks right. Providers differ, so send yourself a test SMS to be sure.']
            : ['ok' => false, 'detail' => 'The send-SMS address must start with https:// and be on the public internet.'];
    }
    try {
        if (sms_provider() === 'bulksms') {
            $r = http_request('GET', 'https://api.bulksms.com/v1/profile', ['Authorization' => 'Basic ' . base64_encode(cfg('sms.bulksmsTokenId') . ':' . cfg('sms.bulksmsTokenSecret'))], null, 10);
            return $r['status'] === 200 ? ['ok' => true, 'detail' => 'BulkSMS accepted the keys. Credits: ' . ($r['json']['credits']['balance'] ?? '?')] : ['ok' => false, 'detail' => "BulkSMS rejected the keys (HTTP {$r['status']})."];
        }
        $r = http_request('GET', 'https://platform.clickatell.com/v1/balance', ['Authorization' => (string) cfg('sms.clickatellApiKey')], null, 10);
        return $r['status'] === 200 ? ['ok' => true, 'detail' => 'Clickatell accepted the key. Balance: ' . ($r['json']['balance'] ?? '?')] : ['ok' => false, 'detail' => "Clickatell rejected the key (HTTP {$r['status']})."];
    } catch (Throwable $e) { return ['ok' => false, 'detail' => $e->getMessage()]; }
}

// Error text from providers can echo what was sent to them. Before any of it
// is shown or stored, every saved key, password and username is masked.
function integration_scrub(string $text): string
{
    foreach (INTEGRATION_FIELDS as $group => $fields) {
        foreach ($fields as $k => $f) {
            if (empty($f['secret'])) continue;
            $v = (string) (cfg("$group.$k") ?? '');
            if (strlen($v) >= 4) $text = str_replace($v, '••••', $text);
        }
    }
    return $text;
}
