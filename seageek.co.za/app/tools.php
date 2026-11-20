<?php
/**
 * Plug-ins: no-code tools a business sets up by copying and pasting.
 * Website chat, WhatsApp button, website forms, short links and website monitoring.
 */
declare(strict_types=1);

final class Plugins
{
    /** key => [name, icon, dashboard path, one-line summary, price note] */
    public static function all(): array
    {
        return [
            'chat' => ['Website chat', 'chat', '/dashboard/chat', 'A chat box for your website. SeaGeek AI answers first and hands over to your team in Desk.', 'Included'],
            'whatsapp_button' => ['WhatsApp button', 'whatsapp', '/dashboard/chat#whatsapp', 'A floating "Chat on WhatsApp" button that opens a chat with your business number.', 'Free'],
            'forms' => ['Website forms', 'form', '/dashboard/forms', 'Point any contact or quote form at SeaGeek. Every message is emailed to you, saved, and can open a Desk ticket or send you an SMS.', 'Free; SMS alerts at the SMS rate'],
            'links' => ['Short links', 'link', '/dashboard/links', 'Short seageek.co.za links that count clicks and can be pointed somewhere new at any time.', 'Free'],
            'monitor' => ['Website monitor', 'pulse', '/dashboard/monitors', 'Checks your website every few minutes and alerts you by SMS and email the moment it goes down or comes back.', 'Free; SMS alerts at the SMS rate'],
            'qr' => ['QR codes', 'qr', '/dashboard/qr', 'Paste a link and get a QR code for print, with scan counts.', 'R20 per code'],
            'stores' => ['Store SMS', 'store', '/dashboard/stores', 'Order SMS for Shopify, WooCommerce and other online stores.', 'R0.50 per SMS'],
            'campaigns' => ['Campaigns', 'megaphone', '/dashboard/campaigns', 'Bulk SMS and email newsletters with templates and opt-outs.', 'At the SMS and email rates'],
        ];
    }

    /** Send an alert SMS for a customer through the normal SMS route, charged at the usual SMS rate. */
    public static function alertSms(array $org, string $phone, string $body, string $reference): ?string
    {
        if ($phone === '') return null;
        if (!$org['is_house'] && ($org['status'] !== 'active' || !$org['live_enabled'])) return 'Live access is off, so no SMS was sent.';
        [$code, $res] = Gateway::run($org, 'live', 'POST', 'sms/messages', ['to' => [$phone], 'body' => mb_substr($body, 0, 300), 'reference' => $reference]);
        if ($code >= 300) return $code === 402 ? 'Balance too low for the SMS alert.' : (string) ($res['error']['message'] ?? 'SMS alert failed.');
        return null;
    }

    public static function chatSettings(array $org): array
    {
        $s = json_decode((string) ($org['chat_settings'] ?? ''), true) ?: [];
        return $s + ['title' => 'Chat with us', 'color' => '#5fe3cf', 'greeting' => '', 'wa_number' => '', 'wa_text' => '', 'wa_label' => 'Chat on WhatsApp'];
    }

    public static function chatSnippet(array $org): string
    {
        $s = self::chatSettings($org);
        $attrs = ' data-org="' . e($org['slug']) . '"';
        if ($s['title'] !== 'Chat with us') $attrs .= ' data-title="' . e($s['title']) . '"';
        if (strtolower($s['color']) !== '#5fe3cf') $attrs .= ' data-color="' . e($s['color']) . '"';
        if ($s['greeting'] !== '') $attrs .= ' data-greeting="' . e($s['greeting']) . '"';
        return '<script src="' . e(app_url('/assets/js/chat-widget.js')) . '"' . $attrs . ' defer></script>';
    }

    public static function waSnippet(array $org): string
    {
        $s = self::chatSettings($org);
        if ($s['wa_number'] === '') return '';
        $attrs = ' data-number="' . e($s['wa_number']) . '"';
        if ($s['wa_text'] !== '') $attrs .= ' data-text="' . e($s['wa_text']) . '"';
        if ($s['wa_label'] !== 'Chat on WhatsApp') $attrs .= ' data-label="' . e($s['wa_label']) . '"';
        return '<script src="' . e(app_url('/assets/js/wa-button.js')) . '"' . $attrs . ' defer></script>';
    }

    /** International number for wa.me: 0821234567 becomes 27821234567. */
    public static function waNumber(string $raw): string
    {
        $n = preg_replace('/\D/', '', $raw);
        if (str_starts_with($n, '0')) $n = '27' . substr($n, 1);
        return strlen($n) >= 10 && strlen($n) <= 15 ? $n : '';
    }
}

/** Website forms: any HTML form posts to /f/{token}; SeaGeek emails, stores and routes each message. */
final class WebForms
{
    public static function endpoint(array $f): string
    {
        return app_url('/f/' . $f['token']);
    }

    public static function create(array $org, string $name, string $email, string $phone, bool $toDesk, string $autoReply, string $thanks): array
    {
        $id = DB::insert('web_forms', ['org_id' => $org['id'], 'token' => Crypto::token(12), 'name' => mb_substr($name, 0, 120), 'notify_email' => $email ?: null,
            'notify_phone' => $phone ?: null, 'to_desk' => $toDesk ? 1 : 0, 'auto_reply' => $autoReply ?: null, 'thanks_url' => $thanks ?: null, 'created_at' => now()]);
        return DB::one('SELECT * FROM web_forms WHERE id = ?', [$id]);
    }

    public static function htmlExample(array $f): string
    {
        return '<form action="' . self::endpoint($f) . '" method="post">' . "\n"
            . '  <input name="name" placeholder="Your name" required>' . "\n"
            . '  <input name="email" type="email" placeholder="Your email" required>' . "\n"
            . '  <input name="phone" placeholder="Your phone">' . "\n"
            . '  <textarea name="message" placeholder="How can we help?" required></textarea>' . "\n"
            . '  <input name="_gotcha" style="display:none" tabindex="-1" autocomplete="off">' . "\n"
            . '  <button type="submit">Send</button>' . "\n"
            . '</form>';
    }

    /** Public endpoint. Works with a normal form post (redirects) or fetch/AJAX (JSON). */
    public static function receive(string $token): never
    {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Headers: Content-Type, Accept');
        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
        $wantsJson = str_contains((string) ($_SERVER['HTTP_ACCEPT'] ?? ''), 'application/json') || str_contains((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json');
        $done = function (int $code, string $msg, ?array $f = null) use ($wantsJson, $token): never {
            if ($wantsJson) json_out($code < 300 ? ['ok' => true, 'message' => $msg] : ['ok' => false, 'error' => $msg], $code);
            if ($code < 300 && $f && $f['thanks_url']) redirect($f['thanks_url']);
            http_response_code($code);
            render('site/form-done', ['title' => $code < 300 ? 'Message sent' : 'Message not sent', 'ok' => $code < 300, 'msg' => $msg, 'back' => (string) ($_SERVER['HTTP_REFERER'] ?? '')], 'auth');
            exit;
        };
        $f = DB::one("SELECT * FROM web_forms WHERE token = ?", [$token]);
        if (!$f || $f['status'] !== 'active') $done(404, 'This form is not accepting messages.');
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') $done(405, 'Send the form to submit a message.');
        $in = str_contains((string) ($_SERVER['CONTENT_TYPE'] ?? ''), 'application/json') ? (json_decode((string) file_get_contents('php://input'), true) ?: []) : $_POST;
        // Hidden fields bots fill in: ours and the common Formspree-style one.
        if (trim((string) ($in['_gotcha'] ?? $in['sg_hp'] ?? '')) !== '') { Shield::strike('form_bot', '/f/' . $token, 3); $done(200, 'Thank you. Your message was sent.'); }
        if (rate_limited('wf:' . $f['id'] . ':' . client_ip(), 8, 600)) $done(429, 'Too many messages from your connection. Try again in a few minutes.');
        $data = [];
        foreach ($in as $k => $v) {
            if (!is_string($k) || str_starts_with($k, '_') || in_array($k, ['sg_hp', 'sg_t', 'cf-turnstile-response', 'g-recaptcha-response'], true)) continue;
            if (count($data) >= 30) break;
            $v = is_array($v) ? implode(', ', array_map('strval', array_filter($v, 'is_scalar'))) : (string) $v;
            $data[mb_substr(trim($k), 0, 60)] = mb_substr(trim($v), 0, 5000);
        }
        $data = array_filter($data, fn($v) => $v !== '');
        if (!$data) $done(422, 'The form was empty.');
        $email = '';
        foreach ($data as $k => $v) if (preg_match('/e-?mail/i', $k) && filter_var($v, FILTER_VALIDATE_EMAIL)) { $email = strtolower($v); break; }
        $name = '';
        foreach ($data as $k => $v) if (preg_match('/^(full[_ ]?)?name$|first[_ ]?name/i', $k)) { $name = mb_substr($v, 0, 120); break; }
        $page = mb_substr((string) ($_SERVER['HTTP_REFERER'] ?? ''), 0, 500);
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$f['org_id']]);
        $lines = implode("\n", array_map(fn($k, $v) => ucfirst(str_replace('_', ' ', $k)) . ': ' . $v, array_keys($data), $data));
        $ticketId = null;
        if ($f['to_desk']) {
            $t = Desk::createTicket((int) $org['id'], $f['name'] . ($name ? ': ' . $name : ''), $lines . ($page ? "\n\nSent from: $page" : ''), 'web', ['name' => $name ?: null, 'email' => $email ?: null], 'normal', ['form']);
            $ticketId = (int) $t['id'];
        }
        $entry = DB::insert('web_form_entries', ['form_id' => $f['id'], 'data' => json_encode($data, JSON_UNESCAPED_UNICODE), 'email' => $email ?: null, 'page' => $page ?: null, 'ip' => substr(client_ip(), 0, 64), 'ticket_id' => $ticketId, 'created_at' => now()]);
        DB::run('UPDATE web_forms SET submissions = submissions + 1, last_at = ? WHERE id = ?', [now(), $f['id']]);
        if ($f['notify_email']) {
            Mail::queue($f['notify_email'], 'New message from ' . $f['name'], 'form_entry', ['form' => $f, 'data' => $data, 'page' => $page, 'link' => app_url('/dashboard/forms/' . $f['id'])],
                $email ? ['Reply-To' => $email] : []);
        }
        if (!$f['to_desk'] && $f['auto_reply'] && $email) {
            Mail::queue($email, 'We received your message', 'form_reply', ['org' => $org, 'body' => $f['auto_reply'], 'name' => $name]);
        }
        if ($f['notify_phone']) {
            Plugins::alertSms($org, $f['notify_phone'], 'New ' . $f['name'] . ' message' . ($name ? ' from ' . $name : '') . ': ' . mb_substr(reset($data), 0, 90), 'form:' . $entry);
        }
        $done(200, 'Thank you. Your message was sent.', $f);
    }
}

/** Short links: /l/{code} redirects and counts clicks. */
final class ShortLinks
{
    private const RESERVED = ['admin', 'api', 'login', 'dashboard', 'docs', 'help', 'new', 'edit'];

    public static function url(array $l): string
    {
        return app_url('/l/' . $l['code']);
    }

    public static function problem(string $url, string $code, ?int $ignoreId = null): ?string
    {
        if (mb_strlen($url) > 1000 || !filter_var($url, FILTER_VALIDATE_URL) || !preg_match('#^https?://#i', $url)) return 'Enter a full link that starts with https:// or http://.';
        $host = strtolower((string) parse_url($url, PHP_URL_HOST));
        $own = strtolower((string) parse_url(app_url('/'), PHP_URL_HOST));
        if ($host === $own && str_starts_with((string) parse_url($url, PHP_URL_PATH), '/l/')) return 'A short link cannot point to another short link.';
        if ($code !== '') {
            if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9-]{2,29}$/', $code)) return 'Your own ending can use letters, numbers and dashes, 3 to 30 characters.';
            if (in_array(strtolower($code), self::RESERVED, true)) return 'That ending is reserved. Pick another.';
            $taken = DB::one('SELECT id FROM short_links WHERE LOWER(code) = ?', [strtolower($code)]);
            if ($taken && (int) $taken['id'] !== $ignoreId) return 'That ending is already taken. Pick another.';
        }
        return null;
    }

    public static function create(array $org, string $url, string $name, string $code = ''): array
    {
        if ($code === '') {
            do { $code = substr(str_replace(['-', '_'], '', Crypto::token(8)), 0, 6); } while (strlen($code) < 6 || DB::one('SELECT id FROM short_links WHERE code = ?', [$code]));
        }
        $id = DB::insert('short_links', ['org_id' => $org['id'], 'code' => $code, 'name' => mb_substr($name, 0, 120) ?: null, 'target_url' => $url, 'created_at' => now()]);
        return DB::one('SELECT * FROM short_links WHERE id = ?', [$id]);
    }

    public static function open(string $code): never
    {
        $l = DB::one('SELECT * FROM short_links WHERE LOWER(code) = ?', [strtolower($code)]);
        if (!$l || $l['status'] !== 'active') { http_response_code($l ? 410 : 404); render('site/qr-missing', ['title' => $l ? 'Link paused' : 'Link not found', 'paused' => (bool) $l, 'what' => 'link'], 'auth'); exit; }
        $ua = (string) ($_SERVER['HTTP_USER_AGENT'] ?? '');
        if (!preg_match('/bot|crawl|spider|preview|facebookexternalhit|whatsapp|slack|telegram/i', $ua)) {
            DB::insert('short_link_clicks', ['link_id' => $l['id'], 'device' => Qr::device($ua), 'created_at' => now()]);
            DB::run('UPDATE short_links SET clicks = clicks + 1, last_click_at = ? WHERE id = ?', [now(), $l['id']]);
        }
        header('Cache-Control: no-store');
        header('Location: ' . $l['target_url'], true, 302);
        exit;
    }

    /** Clicks per day for the last N days, plus a device split. */
    public static function daily(int $linkId, int $days = 30): array
    {
        $since = gmdate('Y-m-d 00:00:00', strtotime('-' . ($days - 1) . ' days'));
        $out = [];
        for ($i = $days - 1; $i >= 0; $i--) $out[gmdate('Y-m-d', strtotime("-$i days"))] = 0;
        $devices = [];
        foreach (DB::all('SELECT created_at, device FROM short_link_clicks WHERE link_id = ? AND created_at >= ?', [$linkId, $since]) as $r) {
            $d = substr($r['created_at'], 0, 10);
            if (isset($out[$d])) $out[$d]++;
            $devices[$r['device'] ?: 'Other'] = ($devices[$r['device'] ?: 'Other'] ?? 0) + 1;
        }
        arsort($devices);
        return [$out, $devices];
    }
}

/** Website monitoring: the scheduled jobs check each site and alert on changes. */
final class Monitors
{
    public const MAX_PER_ACCOUNT = 10;
    public const INTERVALS = [1 => 'Every minute', 5 => 'Every 5 minutes', 15 => 'Every 15 minutes', 60 => 'Every hour'];

    /** Refuse anything that is not a public website: no private, local or reserved addresses. */
    public static function problem(string $url): ?string
    {
        if (mb_strlen($url) > 500 || !filter_var($url, FILTER_VALIDATE_URL) || !preg_match('#^https?://#i', $url)) return 'Enter a full address that starts with https:// or http://.';
        if (parse_url($url, PHP_URL_USER) !== null) return 'Leave usernames and passwords out of the address.';
        $port = parse_url($url, PHP_URL_PORT);
        if ($port !== null && !in_array((int) $port, [80, 443, 8080, 8443], true) && Settings::get('monitor_allow_private') !== '1') return 'Only the usual web ports (80, 443, 8080, 8443) can be checked.';
        return self::publicAddress((string) parse_url($url, PHP_URL_HOST)) ? null : 'That address is not a public website.';
    }

    private static function publicAddress(string $host): ?string
    {
        if (Settings::get('monitor_allow_private') === '1') return gethostbyname($host) ?: $host; // local testing only
        $ips = filter_var($host, FILTER_VALIDATE_IP) ? [$host] : array_merge(
            array_column(@dns_get_record($host, DNS_A) ?: [], 'ip'), array_column(@dns_get_record($host, DNS_AAAA) ?: [], 'ipv6'));
        if (!$ips) { $ip = gethostbyname($host); if ($ip !== $host) $ips = [$ip]; }
        if (!$ips) return null;
        foreach ($ips as $ip) if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return null;
        return $ips[0];
    }

    /** One check. Redirects are not followed: a 3xx answer means the server is up. */
    public static function probe(array $m): array
    {
        $host = (string) parse_url($m['url'], PHP_URL_HOST);
        $ip = self::publicAddress($host);
        if (!$ip) return [false, null, null, 'Address does not resolve to a public server'];
        $port = (int) (parse_url($m['url'], PHP_URL_PORT) ?: (str_starts_with(strtolower($m['url']), 'https') ? 443 : 80));
        $ch = curl_init($m['url']);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 15, CURLOPT_CONNECTTIMEOUT => 8,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS, CURLOPT_USERAGENT => 'SeaGeek-Monitor/1.0 (+https://www.seageek.co.za/plugins)',
            CURLOPT_RESOLVE => [$host . ':' . $port . ':' . $ip], // check the address we vetted, not a different one
            CURLOPT_MAXFILESIZE => 2_000_000,
        ]);
        $t = microtime(true);
        $body = curl_exec($ch);
        $ms = (int) round((microtime(true) - $t) * 1000);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = $body === false ? curl_error($ch) : null;
        curl_close($ch);
        if ($err) return [false, null, $ms, mb_substr($err, 0, 200)];
        if ($code >= 400 || $code === 0) return [false, $code, $ms, 'The site answered with error ' . $code];
        if ($m['keyword'] && $code < 300 && !str_contains((string) $body, $m['keyword'])) return [false, $code, $ms, 'The page loaded but "' . mb_substr($m['keyword'], 0, 60) . '" was missing'];
        return [true, $code, $ms, null];
    }

    /** Cron: check every monitor that is due. Down needs two failed checks in a row, to avoid false alarms. */
    public static function run(int $limit = 25): int
    {
        $due = DB::all('SELECT * FROM monitors WHERE paused = 0 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT ' . (int) $limit, [now()]);
        foreach ($due as $m) self::check($m);
        return count($due);
    }

    public static function check(array $m): array
    {
        [$ok, $code, $ms, $err] = self::probe($m);
        $fails = $ok ? 0 : (int) $m['fails'] + 1;
        $state = $ok ? 'up' : ($fails >= 2 || $m['state'] === 'down' ? 'down' : $m['state']);
        $changed = $state !== $m['state'] && in_array($state, ['up', 'down'], true);
        DB::update('monitors', ['fails' => $fails, 'checks' => (int) $m['checks'] + 1, 'up_checks' => (int) $m['up_checks'] + ($ok ? 1 : 0), 'last_ms' => $ms, 'last_code' => $code,
            'last_error' => $err, 'last_check_at' => now(), 'next_check_at' => ts('+' . max(1, (int) $m['every_min']) . ' minutes'), 'state' => $state,
            'state_since' => $changed ? now() : ($m['state_since'] ?? now())], 'id = ?', [$m['id']]);
        if ($changed) {
            DB::insert('monitor_events', ['monitor_id' => $m['id'], 'state' => $state, 'detail' => $ok ? ('Answered in ' . $ms . ' ms') : $err, 'created_at' => now()]);
            // The first "up" after creating a monitor is not news.
            if (!($m['state'] === 'pending' && $state === 'up')) self::alert($m, $state, $ok ? null : $err);
        }
        return ['ok' => $ok, 'code' => $code, 'ms' => $ms, 'error' => $err, 'state' => $state];
    }

    private static function alert(array $m, string $state, ?string $why): void
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$m['org_id']]);
        $since = $m['state_since'] ? self::duration(time() - strtotime($m['state_since'] . ' UTC')) : '';
        $text = $state === 'down' ? $m['name'] . ' is DOWN. ' . $why . '. We will tell you when it is back.' : $m['name'] . ' is back UP' . ($since ? ' after ' . $since : '') . '.';
        if ($m['alert_email']) Mail::queue($m['alert_email'], ($state === 'down' ? 'Down: ' : 'Back up: ') . $m['name'], 'monitor_alert', ['m' => $m, 'state' => $state, 'why' => $why, 'since' => $since, 'link' => app_url('/dashboard/monitors/' . $m['id'])]);
        if ($m['alert_phone']) Plugins::alertSms($org, $m['alert_phone'], 'SeaGeek monitor: ' . $text, 'monitor:' . $m['id']);
    }

    public static function duration(int $s): string
    {
        return match (true) {
            $s < 120 => max(1, $s) . ' seconds',
            $s < 7200 => intdiv($s, 60) . ' minutes',
            $s < 172800 => intdiv($s, 3600) . ' hours',
            default => intdiv($s, 86400) . ' days',
        };
    }

    public static function uptime(array $m): ?string
    {
        return (int) $m['checks'] > 0 ? rtrim(rtrim(number_format(100 * (int) $m['up_checks'] / (int) $m['checks'], 2), '0'), '.') . '%' : null;
    }
}
