<?php
/**
 * Bot and attack protection: blocks scanners and repeat offenders by IP, hidden form traps,
 * optional Cloudflare Turnstile on public forms, and two-step sign-in codes (TOTP).
 */
declare(strict_types=1);

final class Shield
{
    /** Paths only attack tools ask for on this site. */
    private const PROBES = '#^/(wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|\.env|\.git|\.svn|\.aws|\.ht|phpmyadmin|pma|myadmin|adminer|cgi-bin|vendor/phpunit|server-status|config\.php|backup|dump\.sql|.*\.(sql|bak|old|swp|ini|log)$)#i';
    /** User agents of well-known attack and scanning tools. */
    private const BAD_AGENTS = '/(sqlmap|nikto|nmap|masscan|zgrab|acunetix|wpscan|nuclei|dirbuster|gobuster|ffuf|wfuzz|hydra|havij|netsparker|jorgee|fimap)/i';
    /** Strikes within an hour that get an address blocked, and for how long. */
    private const LIMIT = 20;
    private const BLOCK = '+1 hour';

    public static function ip(): string
    {
        return substr(client_ip(), 0, 64);
    }

    /** Runs before anything else on every request. */
    public static function gate(string $path): void
    {
        if (!installed()) return;
        try {
            $ip = self::ip();
            $block = DB::one('SELECT * FROM ip_blocks WHERE ip = ? AND until > ?', [$ip, now()]);
            if ($block) self::deny(403);
            $ua = (string) ($_SERVER['HTTP_USER_AGENT'] ?? '');
            if (preg_match(self::BAD_AGENTS, $ua)) { self::strike('scanner', $ua, 10); self::deny(403); }
            if (preg_match(self::PROBES, $path)) { self::strike('probe', $path, 4); self::deny(404); }
        } catch (Throwable) {
            // Never let the shield take the site down.
        }
    }

    /** Record suspicious behaviour; enough of it within an hour blocks the address. */
    public static function strike(string $kind, string $detail = '', int $weight = 1): void
    {
        $ip = self::ip();
        for ($i = 0; $i < $weight; $i++) DB::insert('security_events', ['ip' => $ip, 'kind' => $kind, 'detail' => mb_substr($detail, 0, 255), 'created_at' => now()]);
        $n = (int) DB::value('SELECT COUNT(*) FROM security_events WHERE ip = ? AND created_at > ?', [$ip, ts('-1 hour')]);
        if ($n >= self::LIMIT && !DB::one('SELECT ip FROM ip_blocks WHERE ip = ?', [$ip])) {
            DB::insert('ip_blocks', ['ip' => $ip, 'reason' => $kind, 'until' => ts(self::BLOCK), 'created_at' => now()]);
            log_line('security', "Blocked $ip for an hour after repeated $kind");
        } elseif ($n >= self::LIMIT) {
            DB::update('ip_blocks', ['until' => ts(self::BLOCK), 'reason' => $kind], 'ip = ?', [$ip]);
        }
    }

    private static function deny(int $code): never
    {
        http_response_code($code);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
        echo $code === 403 ? "Access from your connection is paused. If you are a SeaGeek customer, write to hello@seageek.co.za.\n" : "Not found.\n";
        exit;
    }

    /** Hidden field real people never fill in, plus a signed time stamp. Printed by csrf_field(). */
    public static function trapFields(): string
    {
        $t = (string) time();
        return '<div class="hp" aria-hidden="true"><label>Leave this empty <input type="text" name="sg_hp" value="" tabindex="-1" autocomplete="off"></label></div>'
            . '<input type="hidden" name="sg_t" value="' . $t . '.' . substr(hash_hmac('sha256', $t, (string) config('app_key')), 0, 16) . '">';
    }

    /** True when a form looks automated: trap filled in, or (for public forms) sent faster than a person can. */
    public static function looksAutomated(bool $checkSpeed = false): bool
    {
        if (trim((string) ($_POST['sg_hp'] ?? '')) !== '') return true;
        if (!$checkSpeed) return false;
        [$t, $sig] = array_pad(explode('.', (string) ($_POST['sg_t'] ?? ''), 2), 2, '');
        if (!ctype_digit($t) || !hash_equals(substr(hash_hmac('sha256', $t, (string) config('app_key')), 0, 16), $sig)) return true;
        return time() - (int) $t < 2; // nobody fills in a form in under two seconds
    }

    /** Public forms (sign-up, contact, startups, newsletter, password reset) call this after csrf_check(). */
    public static function guardPublicForm(string $back): void
    {
        if (self::looksAutomated(true)) {
            self::strike('form_bot', (string) ($_SERVER['REQUEST_URI'] ?? ''), 3);
            flash('error', 'That did not go through. Wait a moment and try again.');
            redirect($back);
        }
        if (!self::turnstileOk()) {
            flash('error', 'Please complete the "I am human" check and try again.');
            redirect($back);
        }
    }

    // Cloudflare Turnstile (optional, switched on by saving keys in Admin, Settings) ----------------

    public static function turnstileEnabled(): bool
    {
        return Settings::get('turnstile_site_key') !== '' && Settings::get('turnstile_secret') !== '';
    }

    public static function turnstileWidget(): string
    {
        if (!self::turnstileEnabled()) return '';
        return '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>'
            . '<div class="cf-turnstile" data-sitekey="' . e(Settings::get('turnstile_site_key')) . '" data-theme="dark"></div>';
    }

    public static function turnstileOk(): bool
    {
        if (!self::turnstileEnabled()) return true;
        $token = (string) ($_POST['cf-turnstile-response'] ?? '');
        if ($token === '') return false;
        $res = Http::request('POST', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', ['Content-Type' => 'application/x-www-form-urlencoded'],
            http_build_query(['secret' => Settings::get('turnstile_secret'), 'response' => $token, 'remoteip' => self::ip()]), 10);
        return (bool) ($res['json']['success'] ?? false);
    }
}

/** Two-step sign-in codes from an authenticator app (RFC 6238, 30-second, 6-digit). */
final class Totp
{
    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public static function newSecret(): string
    {
        $s = '';
        for ($i = 0; $i < 32; $i++) $s .= self::B32[random_int(0, 31)];
        return $s;
    }

    private static function decode(string $b32): string
    {
        $bits = '';
        foreach (str_split(strtoupper(rtrim($b32, '='))) as $c) {
            $v = strpos(self::B32, $c);
            if ($v === false) continue;
            $bits .= str_pad(decbin($v), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) if (strlen($byte) === 8) $out .= chr(bindec($byte));
        return $out;
    }

    public static function code(string $secret, ?int $time = null): string
    {
        $counter = intdiv($time ?? time(), 30);
        $hash = hash_hmac('sha1', pack('N*', 0, $counter), self::decode($secret), true);
        $o = ord($hash[19]) & 0xf;
        $n = ((ord($hash[$o]) & 0x7f) << 24) | (ord($hash[$o + 1]) << 16) | (ord($hash[$o + 2]) << 8) | ord($hash[$o + 3]);
        return str_pad((string) ($n % 1000000), 6, '0', STR_PAD_LEFT);
    }

    /** Accepts the current code and the ones either side, for phone clocks that drift. */
    public static function verify(string $secret, string $code): bool
    {
        $code = preg_replace('/\D/', '', $code);
        if (strlen($code) !== 6) return false;
        foreach ([-1, 0, 1] as $w) if (hash_equals(self::code($secret, time() + $w * 30), $code)) return true;
        return false;
    }

    public static function uri(string $secret, string $email): string
    {
        return 'otpauth://totp/' . rawurlencode('SeaGeek:' . $email) . '?secret=' . $secret . '&issuer=SeaGeek&digits=6&period=30';
    }

    /** QR code an authenticator app can scan, as SVG. */
    public static function qrSvg(string $uri): string
    {
        $o = new \chillerlan\QRCode\QROptions(['outputType' => \chillerlan\QRCode\Output\QROutputInterface::MARKUP_SVG, 'outputBase64' => false, 'svgAddXmlHeader' => false, 'addQuietzone' => true, 'eccLevel' => \chillerlan\QRCode\Common\EccLevel::M]);
        $svg = (new \chillerlan\QRCode\QRCode($o))->render($uri);
        return preg_replace('/(<svg[^>]*>)/', '$1<rect width="100%" height="100%" fill="#ffffff"/>', $svg, 1);
    }
}
