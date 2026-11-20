<?php
/**
 * SeaGeek platform core: configuration, database, security, settings, mail queue, HTTP client.
 */
declare(strict_types=1);

const APP_ROOT = __DIR__ . '/..';
const APP_DIR = __DIR__;
const STORAGE = APP_ROOT . '/storage';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function config(?string $key = null, $default = null, bool $reload = false)
{
    static $cfg = null;
    if ($cfg === null || $reload) {
        $file = APP_DIR . '/config.php';
        $cfg = is_file($file) ? require $file : [];
        // Environment variables override the file, so containers and new servers need no file edits.
        $env = [
            'app_url' => 'SG_APP_URL', 'app_key' => 'SG_APP_KEY', 'cron_token' => 'SG_CRON_TOKEN',
            'db.driver' => 'SG_DB_DRIVER', 'db.host' => 'SG_DB_HOST', 'db.port' => 'SG_DB_PORT',
            'db.name' => 'SG_DB_NAME', 'db.user' => 'SG_DB_USER', 'db.pass' => 'SG_DB_PASS', 'db.path' => 'SG_DB_PATH',
        ];
        foreach ($env as $path => $var) {
            $v = getenv($var);
            if ($v === false || $v === '') continue;
            [$a, $b] = array_pad(explode('.', $path), 2, null);
            if ($b === null) $cfg[$a] = $v; else $cfg[$a][$b] = $v;
        }
    }
    if ($key === null) return $cfg;
    $node = $cfg;
    foreach (explode('.', $key) as $part) {
        if (!is_array($node) || !array_key_exists($part, $node)) return $default;
        $node = $node[$part];
    }
    return $node;
}

function installed(): bool
{
    return is_file(APP_DIR . '/config.php') || (getenv('SG_APP_KEY') !== false && getenv('SG_APP_KEY') !== '');
}

function app_url(string $path = ''): string
{
    $base = rtrim((string) config('app_url', ''), '/');
    if ($base === '') {
        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
        $base = ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
    }
    return $base . '/' . ltrim($path, '/');
}

function now(): string { return gmdate('Y-m-d H:i:s'); }
function ts(string $modify): string { return gmdate('Y-m-d H:i:s', strtotime($modify)); }

function log_line(string $channel, string $message, array $context = []): void
{
    $line = '[' . now() . '] ' . $message . ($context ? ' ' . json_encode($context, JSON_UNESCAPED_SLASHES) : '') . "\n";
    @file_put_contents(STORAGE . '/logs/' . preg_replace('/[^a-z0-9_-]/', '', $channel) . '.log', $line, FILE_APPEND | LOCK_EX);
}

// ---------------------------------------------------------------------------
// Database (MySQL in production, SQLite for local development)
// ---------------------------------------------------------------------------

final class DB
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo) return self::$pdo;
        self::$pdo = self::connect(config('db', []));
        return self::$pdo;
    }

    public static function connect(array $c): PDO
    {
        $opts = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false];
        if (($c['driver'] ?? 'mysql') === 'sqlite') {
            $pdo = new PDO('sqlite:' . $c['path'], null, null, $opts);
            $pdo->exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
            return $pdo;
        }
        $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $c['host'] ?? 'localhost', (int) ($c['port'] ?? 3306), $c['name'] ?? '');
        $pdo = new PDO($dsn, $c['user'] ?? '', $c['pass'] ?? '', $opts);
        $pdo->exec("SET time_zone = '+00:00'");
        return $pdo;
    }

    public static function driver(): string
    {
        return self::pdo()->getAttribute(PDO::ATTR_DRIVER_NAME);
    }

    public static function run(string $sql, array $params = []): PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($params);
        return $st;
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    public static function value(string $sql, array $params = [])
    {
        $v = self::run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public static function insert(string $table, array $data): int
    {
        $cols = array_keys($data);
        $sql = 'INSERT INTO ' . $table . ' (' . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')';
        self::run($sql, array_values($data));
        return (int) self::pdo()->lastInsertId();
    }

    public static function update(string $table, array $data, string $where, array $params = []): int
    {
        $set = implode(',', array_map(fn($c) => "$c = ?", array_keys($data)));
        return self::run("UPDATE $table SET $set WHERE $where", array_merge(array_values($data), $params))->rowCount();
    }

    public static function tx(callable $fn)
    {
        $pdo = self::pdo();
        if ($pdo->inTransaction()) return $fn();
        $pdo->beginTransaction();
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }
}

// ---------------------------------------------------------------------------
// Encryption for stored secrets (partner credentials, API provider keys)
// ---------------------------------------------------------------------------

final class Crypto
{
    private static function key(): string
    {
        $k = base64_decode((string) config('app_key', ''), true);
        if ($k === false || strlen($k) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
            throw new RuntimeException('app_key missing or invalid in app/config.php');
        }
        return $k;
    }

    public static function encrypt(string $plain): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        return 'v1:' . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, self::key()));
    }

    public static function decrypt(?string $cipher): string
    {
        if ($cipher === null || $cipher === '') return '';
        if (strncmp($cipher, 'v1:', 3) !== 0) return $cipher;
        $raw = base64_decode(substr($cipher, 3), true);
        $nonce = substr($raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $plain = sodium_crypto_secretbox_open(substr($raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES), $nonce, self::key());
        if ($plain === false) throw new RuntimeException('Could not decrypt a stored secret. Has app_key changed?');
        return $plain;
    }

    public static function token(int $bytes = 24): string
    {
        return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '=');
    }
}

// ---------------------------------------------------------------------------
// Settings (key/value, editable in admin; secrets encrypted)
// ---------------------------------------------------------------------------

final class Settings
{
    private static ?array $cache = null;

    public const SECRET_KEYS = ['payfast_merchant_key', 'payfast_passphrase', 'anthropic_api_key', 'openai_api_key', 'smtp_password', 'turnstile_secret', 'xero_client_secret', 'xero_tokens'];

    public const DEFAULTS = [
        'company_name' => 'SeaGeek Technologies (Pty) Ltd',
        'company_reg' => '',
        'company_address' => 'Johannesburg, Gauteng, South Africa',
        'support_email' => 'hello@seageek.co.za',
        'mail_from_name' => 'SeaGeek',
        'mail_from_address' => 'hello@seageek.co.za',
        'mail_driver' => 'auto',
        'smtp_host' => '',
        'smtp_port' => '587',
        'smtp_encryption' => 'tls',
        'smtp_username' => '',
        'smtp_password' => '',
        'vat_registered' => '0',
        'vat_number' => '',
        'vat_rate' => '15',
        'bank_name' => '',
        'bank_account_name' => 'SeaGeek Technologies (Pty) Ltd',
        'bank_account_number' => '',
        'bank_branch_code' => '',
        'bank_account_type' => 'Business current account',
        'payfast_mode' => 'sandbox',
        'payfast_merchant_id' => '10000100',
        'payfast_merchant_key' => '46f0cd694581a',
        'payfast_passphrase' => '',
        'min_topup' => '100',
        'startup_credit' => '500',
        'require_staff_2fa' => '1',
        'turnstile_site_key' => '',
        'turnstile_secret' => '',
        'xero_client_id' => '',
        'xero_client_secret' => '',
        'xero_tokens' => '',
        'xero_tenant_name' => '',
        'xero_sales_account' => '200',
        'xero_bank_account' => '090',
        'xero_tax_type' => 'NONE',
        'monitor_allow_private' => '0',
        'xero_scopes' => 'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings.read',
        'xero_login_url' => 'https://login.xero.com/identity/connect/authorize',
        'xero_identity_url' => 'https://identity.xero.com',
        'xero_api_url' => 'https://api.xero.com',
        'startup_plan_months' => '3',
        'invoice_due_days' => '7',
        'reminder_days' => '0,3,6',
        'lock_after_days' => '7',
        'low_balance_default' => '50',
        'chat_provider' => 'anthropic',
        'chat_model_anthropic' => 'claude-opus-5-5',
        'chat_model_openai' => 'gpt-5-mini',
        'anthropic_api_key' => '',
        'openai_api_key' => '',
        'chat_extra_knowledge' => '',
        'support_hours' => 'Monday to Friday, 08:00 to 17:00 (SAST)',
        'usd_zar' => '18.50',
        'ai_markup_pct' => '40',
        'last_cron_at' => '',
    ];

    public static function get(string $key, ?string $default = null): string
    {
        if (self::$cache === null) self::load();
        if (array_key_exists($key, self::$cache)) {
            $v = self::$cache[$key];
            return in_array($key, self::SECRET_KEYS, true) ? Crypto::decrypt($v) : $v;
        }
        return $default ?? (self::DEFAULTS[$key] ?? '');
    }

    public static function set(string $key, string $value): void
    {
        $stored = in_array($key, self::SECRET_KEYS, true) && $value !== '' ? Crypto::encrypt($value) : $value;
        if (DB::one('SELECT k FROM settings WHERE k = ?', [$key])) {
            DB::update('settings', ['v' => $stored], 'k = ?', [$key]);
        } else {
            DB::insert('settings', ['k' => $key, 'v' => $stored]);
        }
        self::$cache = null;
    }

    private static function load(): void
    {
        self::$cache = [];
        foreach (DB::all('SELECT k, v FROM settings') as $r) self::$cache[$r['k']] = $r['v'];
    }
}

// ---------------------------------------------------------------------------
// Request helpers, escaping, CSRF, flash
// ---------------------------------------------------------------------------

function e($v): string { return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

function input(string $key, $default = null)
{
    $v = $_POST[$key] ?? $_GET[$key] ?? $default;
    return is_string($v) ? trim($v) : $v;
}

function is_post(): bool { return ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST'; }

function client_ip(): string { return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'; }

function redirect(string $to): never
{
    header('Location: ' . (str_starts_with($to, 'http') ? $to : app_url($to)));
    exit;
}

function json_out($data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $secure = str_starts_with(app_url(), 'https://');
    session_name('sg_session');
    session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $secure, 'httponly' => true, 'samesite' => 'Lax']);
    if (installed()) {
        session_set_save_handler(new DbSessionHandler(), true);
        ini_set('session.gc_maxlifetime', '28800');
    } else {
        session_save_path(STORAGE . '/cache');
    }
    session_start();
}

function csrf_token(): string
{
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = Crypto::token(32);
    return $_SESSION['csrf'];
}

function csrf_field(): string { return '<input type="hidden" name="_csrf" value="' . e(csrf_token()) . '">' . Shield::trapFields(); }

function csrf_check(): void
{
    $sent = $_POST['_csrf'] ?? $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($sent) || !hash_equals(csrf_token(), $sent)) {
        if (installed()) Shield::strike('csrf', (string) ($_SERVER['REQUEST_URI'] ?? ''));
        http_response_code(419);
        exit('This form has expired. Go back, refresh the page and try again.');
    }
    if (Shield::looksAutomated(false)) {
        Shield::strike('form_bot', (string) ($_SERVER['REQUEST_URI'] ?? ''), 3);
        http_response_code(400);
        exit('That did not go through. Go back and try again.');
    }
}

function flash(string $type, string $message): void { $_SESSION['flash'][] = [$type, $message]; }

function take_flash(): array
{
    $f = $_SESSION['flash'] ?? [];
    unset($_SESSION['flash']);
    return $f;
}

function old(string $key, string $default = ''): string { return e($_SESSION['old'][$key] ?? $default); }

/** Rand amount: R1,234.50, -R0.29, and extra decimals only when they matter (R0.015). */
function zar($amount, int $decimals = 2): string
{
    $a = (float) $amount;
    $s = number_format(abs($a), $decimals, '.', ',');
    if ($decimals > 2) $s = preg_replace('/(\.\d\d\d*?)0+$/', '$1', $s);
    return ($a < 0 && round($a, $decimals) != 0 ? '-R' : 'R') . $s;
}

function rate_limited(string $key, int $max, int $windowSeconds): bool
{
    $window = (int) floor(time() / $windowSeconds);
    $k = substr(hash('sha256', $key), 0, 40);
    $row = DB::one('SELECT count FROM rate_limits WHERE k = ? AND window_start = ?', [$k, $window]);
    if (!$row) {
        DB::run('DELETE FROM rate_limits WHERE k = ?', [$k]);
        DB::insert('rate_limits', ['k' => $k, 'window_start' => $window, 'count' => 1]);
        return false;
    }
    if ((int) $row['count'] >= $max) return true;
    DB::run('UPDATE rate_limits SET count = count + 1 WHERE k = ? AND window_start = ?', [$k, $window]);
    return false;
}

function audit(string $action, ?int $orgId = null, string $detail = ''): void
{
    DB::insert('audit_log', [
        'user_id' => Auth::id(), 'org_id' => $orgId, 'action' => $action,
        'detail' => mb_substr($detail, 0, 500), 'ip' => client_ip(), 'created_at' => now(),
    ]);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function view(string $template, array $data = [], ?string $layout = null): string
{
    extract($data, EXTR_SKIP);
    ob_start();
    require APP_DIR . '/views/' . $template . '.php';
    $content = ob_get_clean();
    if ($layout === null) return $content;
    ob_start();
    require APP_DIR . '/views/layouts/' . $layout . '.php';
    return ob_get_clean();
}

function render(string $template, array $data = [], string $layout = 'site'): never
{
    header('Content-Type: text/html; charset=utf-8');
    echo view($template, $data, $layout);
    exit;
}

function icon(string $name, string $class = ''): string
{
    static $paths = null;
    $paths ??= require APP_DIR . '/icons.php';
    $c = $class ? ' class="' . e($class) . '"' : '';
    return '<svg' . $c . ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . ($paths[$name] ?? '') . '</svg>';
}

// ---------------------------------------------------------------------------
// Outbound HTTP (cURL)
// ---------------------------------------------------------------------------

final class Http
{
    /** @return array{status:int, body:string, json:mixed, error:?string} */
    public static function request(string $method, string $url, array $headers = [], $body = null, int $timeout = 30): array
    {
        $ch = curl_init($url);
        $h = [];
        foreach ($headers as $k => $v) $h[] = is_int($k) ? $v : "$k: $v";
        if (is_array($body)) {
            $body = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            $h[] = 'Content-Type: application/json';
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => strtoupper($method),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $h,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_USERAGENT => 'SeaGeek-Platform/1.0',
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $resp = curl_exec($ch);
        $err = $resp === false ? curl_error($ch) : null;
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $resp = $resp === false ? '' : (string) $resp;
        return ['status' => $status, 'body' => $resp, 'json' => json_decode($resp, true), 'error' => $err];
    }
}

// ---------------------------------------------------------------------------
// Email: everything goes through a queue; cron delivers it.
// ---------------------------------------------------------------------------

/** Email building blocks. Inline styles only, because most email clients ignore stylesheets. */
function mail_button(string $url, string $label): string
{
    return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px"><tr><td style="background:#0f8f80;border-radius:8px">'
        . '<a href="' . e($url) . '" style="display:inline-block;padding:13px 24px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">' . e($label) . '</a></td></tr></table>';
}

/** Label and value rows, e.g. Reference, Amount. */
function mail_details(array $rows): string
{
    $h = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;border-top:1px solid #e3e9eb">';
    foreach ($rows as $label => $value) {
        $h .= '<tr><td style="padding:11px 0;border-bottom:1px solid #e3e9eb;color:#5b6f76;font-size:15px;width:42%">' . e($label) . '</td>'
            . '<td style="padding:11px 0;border-bottom:1px solid #e3e9eb;color:#14262d;font-size:15px;font-weight:600;text-align:right">' . e((string) $value) . '</td></tr>';
    }
    return $h . '</table>';
}

function mail_note(string $html): string
{
    return '<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#5b6f76">' . $html . '</p>';
}

final class Mail
{
    public static function queue(string $to, string $subject, string $template, array $data = [], array $headers = []): void
    {
        $data['subject'] = $subject;
        $html = view('emails/' . $template, $data, 'email');
        DB::insert('email_outbox', [
            'to_addr' => $to, 'subject' => $subject, 'html' => $html, 'text_body' => self::text($html),
            'headers' => $headers ? json_encode($headers) : null,
            'status' => 'queued', 'attempts' => 0, 'created_at' => now(),
        ]);
    }

    /** Plain-text version of an HTML email. */
    public static function text(string $html): string
    {
        $html = preg_replace('/<(style|title)[^>]*>.*?<\/\1>/is', '', $html);
        $html = preg_replace('/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/is', '$2 ($1)', $html);
        $t = html_entity_decode(strip_tags(preg_replace('/<(br|\/p|\/h\d|\/li|\/tr|\/div)>/i', "\n", $html)), ENT_QUOTES, 'UTF-8');
        return trim(preg_replace("/\n{3,}/", "\n\n", preg_replace('/[ \t]+/', ' ', $t)));
    }

    /** Which way mail leaves: smtp, ses (the active Amazon SES partner), mail (PHP mail()) or log (kept in the outbox only). */
    public static function driver(): string
    {
        $d = Settings::get('mail_driver');
        if ($d === 'auto' || $d === '') {
            if (Settings::get('smtp_host') !== '') return 'smtp';
            return Partners::firstActive('mail', 'ses') ? 'ses' : 'mail';
        }
        return $d;
    }

    /** Send one message now. Returns [ok, error]. */
    public static function send(string $to, string $subject, string $html, string $text = '', array $headers = []): array
    {
        $fromName = Settings::get('mail_from_name');
        $fromAddr = Settings::get('mail_from_address');
        $replyTo = Settings::get('support_email');
        try {
            switch (self::driver()) {
                case 'log':
                    return [true, ''];
                case 'smtp':
                    $m = new \PHPMailer\PHPMailer\PHPMailer(true);
                    $m->isSMTP();
                    $m->Host = Settings::get('smtp_host');
                    $m->Port = (int) (Settings::get('smtp_port') ?: 587);
                    $enc = Settings::get('smtp_encryption');
                    $m->SMTPSecure = $enc === 'ssl' ? \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_SMTPS : ($enc === 'tls' ? \PHPMailer\PHPMailer\PHPMailer::ENCRYPTION_STARTTLS : '');
                    $m->SMTPAutoTLS = $enc !== 'none';
                    if (Settings::get('smtp_username') !== '') {
                        $m->SMTPAuth = true;
                        $m->Username = Settings::get('smtp_username');
                        $m->Password = Settings::get('smtp_password');
                    }
                    $m->Timeout = 15;
                    $m->CharSet = 'UTF-8';
                    $m->setFrom($fromAddr, $fromName);
                    $m->addReplyTo($replyTo);
                    $m->addAddress($to);
                    foreach ($headers as $k => $v) $m->addCustomHeader($k, $v);
                    $m->isHTML(true);
                    $m->Subject = $subject;
                    $m->Body = $html;
                    $m->AltBody = $text ?: self::text($html);
                    $m->send();
                    return [true, ''];
                case 'ses':
                    $ses = Partners::firstActive('mail', 'ses');
                    if (!$ses) return [false, 'No active Amazon SES partner'];
                    $res = Adapters::sesSend($ses, ['from' => sprintf('%s <%s>', $fromName, $fromAddr), 'to' => [$to], 'subject' => $subject, 'html' => $html, 'text' => $text]);
                    return [(bool) $res['ok'], (string) ($res['error'] ?? '')];
                default:
                    $h = "MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nFrom: " . mb_encode_mimeheader($fromName) . " <$fromAddr>\r\nReply-To: $replyTo";
                    foreach ($headers as $k => $v) $h .= "\r\n$k: $v";
                    $ok = @mail($to, mb_encode_mimeheader($subject), $html, $h);
                    return [$ok, $ok ? '' : 'mail() returned false. Set up SMTP under Admin, Settings, Email delivery.'];
            }
        } catch (Throwable $e) {
            return [false, $e->getMessage()];
        }
    }

    /** Send queued mail, retrying up to five times. */
    public static function deliver(int $limit = 50): int
    {
        $sent = 0;
        $rows = DB::all("SELECT * FROM email_outbox WHERE status = 'queued' AND attempts < 5 ORDER BY id LIMIT " . (int) $limit);
        foreach ($rows as $m) {
            $headers = json_decode((string) ($m['headers'] ?? ''), true) ?: [];
            [$ok, $error] = self::send($m['to_addr'], $m['subject'], $m['html'], (string) $m['text_body'], $headers);
            DB::update('email_outbox', [
                'status' => $ok ? 'sent' : ((int) $m['attempts'] + 1 >= 5 ? 'failed' : 'queued'),
                'attempts' => (int) $m['attempts'] + 1, 'last_error' => mb_substr($error, 0, 500),
                'sent_at' => $ok ? now() : null,
            ], 'id = ?', [$m['id']]);
            if ($ok) $sent++;
        }
        return $sent;
    }
}
