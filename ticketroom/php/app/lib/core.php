<?php
// TicketRoom PHP edition — core: errors, time, config, database, HTTP routing,
// validation, crypto, sessions/CSRF, rate limiting and the audit chain.
// Mirrors the Node edition's behaviour and JSON shapes so the same browser
// code works against either server.
declare(strict_types=1);

// ============================================================== errors
final class AppError extends Exception
{
    public function __construct(public int $status, public string $errCode, string $message, public mixed $details = null)
    {
        parent::__construct($message);
    }
}
function bad(string $m, $d = null): AppError { return new AppError(400, 'bad_request', $m, $d); }
function invalid(array $d): AppError { return new AppError(422, 'validation_failed', 'Some fields need attention.', $d); }
function unauthenticated(): AppError { return new AppError(401, 'unauthenticated', 'Please sign in.'); }
function forbidden(string $m = 'You do not have permission to do that.'): AppError { return new AppError(403, 'forbidden', $m); }
function not_found(string $m = 'Not found'): AppError { return new AppError(404, 'not_found', $m); }
function conflict(string $m, string $code = 'conflict', $d = null): AppError { return new AppError(409, $code, $m, $d); }
function too_many(): AppError { return new AppError(429, 'rate_limited', 'Too many requests. Please wait a moment and try again.'); }
function not_available(): AppError
{
    return new AppError(501, 'not_available', 'This feature is not available yet. Free events, tickets and scanning are fully available; payments, cashless and vendor tools arrive with the payment gateway.');
}

// ============================================================== time
// Timestamps are ISO-8601 UTC with milliseconds, exactly like JSON from the
// Node edition ("2026-10-09T12:00:00.000Z"); string order equals time order.
function iso_at(float $unix): string
{
    $sec = (int) floor($unix);
    $ms = (int) floor(($unix - $sec) * 1000);
    return gmdate('Y-m-d\TH:i:s', $sec) . sprintf('.%03dZ', $ms);
}
function now_iso(): string { return iso_at(microtime(true)); }
function iso_in(float $seconds): string { return iso_at(microtime(true) + $seconds); }
function to_unix(?string $iso): ?float
{
    if ($iso === null || $iso === '') return null;
    $t = strtotime($iso);
    if ($t === false) return null;
    if (preg_match('/\.(\d{1,6})/', $iso, $m)) $t += (float) ('0.' . $m[1]);
    return (float) $t;
}
function parse_iso($v): ?string
{
    if (!is_string($v) && !is_int($v) && !is_float($v)) return null;
    if (is_numeric($v)) return iso_at(((float) $v) / 1000);
    $s = trim((string) $v);
    if ($s === '' || strlen($s) > 40) return null;
    try {
        $d = new DateTimeImmutable($s, new DateTimeZone('UTC'));
    } catch (Exception) {
        return null;
    }
    return iso_at((float) $d->format('U.u'));
}

// ============================================================== config
function cfg(?string $key = null, $default = null)
{
    $c = $GLOBALS['TR_CONFIG'] ?? [];
    if ($key === null) return $c;
    $cur = $c;
    foreach (explode('.', $key) as $part) {
        if (!is_array($cur) || !array_key_exists($part, $cur)) return $default;
        $cur = $cur[$part];
    }
    return $cur;
}
function base_url(): string { return rtrim((string) cfg('baseUrl', 'https://ticketroom.co.za'), '/'); }
function data_dir(): string { return (string) $GLOBALS['TR_DATA_DIR']; }

// ============================================================== database
const BOOL_COLS = ['is_free', 'featured', 'transfers_enabled', 'cashless_enabled', 'can_scan', 'can_manage_tags', 'active', 'granted',
    'has_pin', 'helpful', 'overdue', 'mine', 'resolved', 'signature_valid', 'email_verified'];
const JSON_COLS = ['details', 'keywords', 'audience'];

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . data_dir() . '/ticketroom.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_STRINGIFY_FETCHES => false,
        PDO::ATTR_TIMEOUT => 10,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 10000');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    return $pdo;
}
function norm_row(array $r): array
{
    foreach ($r as $k => $v) {
        if ($v === null) continue;
        if (in_array($k, BOOL_COLS, true)) $r[$k] = (bool) $v;
        elseif (in_array($k, JSON_COLS, true) && is_string($v)) $r[$k] = json_decode($v, true);
    }
    return $r;
}
function q(string $sql, array $p = []): PDOStatement
{
    // Prepared statements are reused within a request (bookings run the same
    // dozen statements, so this saves parsing them every time).
    static $cache = [];
    if (count($cache) > 200) $cache = [];
    $st = $cache[$sql] ??= db()->prepare($sql);
    $st->closeCursor();
    foreach (array_values($p) as $i => $v) {
        $type = is_int($v) ? PDO::PARAM_INT : (is_bool($v) ? PDO::PARAM_INT : ($v === null ? PDO::PARAM_NULL : PDO::PARAM_STR));
        $st->bindValue($i + 1, is_bool($v) ? (int) $v : $v, $type);
    }
    $st->execute();
    return $st;
}
// Every helper closes its cursor straight away: a cached statement left half
// read would keep a read snapshot open and make the next write fail as "busy".
function rows(string $sql, array $p = []): array { $st = q($sql, $p); $r = $st->fetchAll(); $st->closeCursor(); return array_map('norm_row', $r); }
function row(string $sql, array $p = []): ?array { $st = q($sql, $p); $r = $st->fetch(); $st->closeCursor(); return $r ? norm_row($r) : null; }
function val(string $sql, array $p = []) { $st = q($sql, $p); $v = $st->fetchColumn(); $st->closeCursor(); return $v === false ? null : $v; }
function affected(string $sql, array $p = []): int { $st = q($sql, $p); $n = $st->rowCount(); $st->closeCursor(); return $n; }
// Writes go through one IMMEDIATE transaction at a time: SQLite then
// serialises every check-and-update (capacity, admission) across workers.
function tx(callable $fn)
{
    static $depth = 0;
    $pdo = db();
    if ($depth > 0) {
        $depth++;
        try { return $fn(); } finally { $depth--; }
    }
    $pdo->exec('BEGIN IMMEDIATE');
    $depth = 1;
    try {
        $out = $fn();
        $pdo->exec('COMMIT');
        return $out;
    } catch (Throwable $e) {
        try { $pdo->exec('ROLLBACK'); } catch (Throwable) { /* already rolled back */ }
        throw $e;
    } finally {
        $depth = 0;
    }
}
function uuid(): string
{
    $b = random_bytes(16);
    $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
    $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
    $h = bin2hex($b);
    return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20);
}
function insert(string $table, array $data): array
{
    $cols = array_keys($data);
    q('INSERT INTO ' . $table . ' (' . implode(',', $cols) . ') VALUES (' . implode(',', array_fill(0, count($cols), '?')) . ')', array_values($data));
    return $data;
}
function placeholders(array $list): string { return implode(',', array_fill(0, max(1, count($list)), '?')); }
function like_escape(string $s): string { return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $s); }

// ============================================================== request / response
function req(): array { return $GLOBALS['TR_REQ']; }
function body(): array { return $GLOBALS['TR_REQ']['body']; }
function qs(string $k, $default = null) { $v = $_GET[$k] ?? $default; return is_string($v) ? $v : $default; }
function client_ip(): string { return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'); }

function send_security_headers(): void
{
    header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Cross-Origin-Opener-Policy: same-origin');
    header('Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()');
    if (is_https()) header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}
function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') || (($_SERVER['SERVER_PORT'] ?? '') === '443');
}

final class Response
{
    public function __construct(public $data, public int $status = 200, public array $headers = [], public bool $raw = false) {}
}
function json_out($data, int $status = 200): Response { return new Response($data, $status); }
function raw_out(string $body, string $type, int $status = 200, array $headers = []): Response
{
    return new Response($body, $status, ['Content-Type' => $type] + $headers, true);
}
function json_encode_out($data): string
{
    return json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE);
}
function emit(Response $r): void
{
    http_response_code($r->status);
    foreach ($r->headers as $k => $v) header("$k: $v");
    if ($r->raw) { echo $r->data; return; }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode_out($r->data);
}

// ---- router
$GLOBALS['TR_ROUTES'] = [];
function route(string $method, string $pattern, callable $handler): void
{
    $keys = [];
    $re = preg_replace_callback('#:([A-Za-z_]+)#', function ($m) use (&$keys) { $keys[] = $m[1]; return '([^/]+)'; }, $pattern);
    $GLOBALS['TR_ROUTES'][] = [$method, '#^' . $re . '$#', $keys, $handler];
}
function dispatch(string $method, string $path): Response
{
    $allowed = false;
    foreach ($GLOBALS['TR_ROUTES'] as [$m, $re, $keys, $handler]) {
        if (!preg_match($re, $path, $mm)) continue;
        if ($m !== $method && !($m === 'GET' && $method === 'HEAD')) { $allowed = true; continue; }
        $params = [];
        foreach ($keys as $i => $k) $params[$k] = rawurldecode($mm[$i + 1]);
        $out = $handler($params);
        return $out instanceof Response ? $out : json_out($out);
    }
    if ($allowed) throw new AppError(405, 'method_not_allowed', 'Method not allowed.');
    throw not_found('Unknown API route.');
}

// ============================================================== validation
// Same rules and messages as the Node edition's lib/validate.js.
final class Fail extends Exception {}
function vfail(string $m): never { throw new Fail($m); }
function v_empty($v): bool { return $v === null || (is_string($v) && trim($v) === ''); }
function v_rule(callable $fn, array $o = []): Closure
{
    $optional = $o['optional'] ?? false;
    $hasFallback = array_key_exists('fallback', $o);
    $fallback = $o['fallback'] ?? null;
    return function ($v) use ($fn, $optional, $fallback, $hasFallback) {
        if (v_empty($v)) {
            if ($optional) return $hasFallback ? $fallback : V_SKIP;
            vfail('This field is required.');
        }
        return $fn($v);
    };
}
const V_SKIP = "\0__skip__";
final class R
{
    public static function str(array $o = []): Closure
    {
        $min = $o['min'] ?? 1; $max = $o['max'] ?? 200; $pattern = $o['pattern'] ?? null; $message = $o['message'] ?? 'Invalid format.';
        return v_rule(function ($v) use ($min, $max, $pattern, $message) {
            if (!is_string($v)) vfail('Must be text.');
            $s = preg_replace('/\s+/u', ' ', trim($v));
            $len = mb_strlen($s);
            if ($len < $min) vfail("Must be at least $min characters.");
            if ($len > $max) vfail("Must be at most $max characters.");
            if ($pattern && !preg_match($pattern, $s)) vfail($message);
            return $s;
        }, $o);
    }
    public static function text(array $o = []): Closure
    {
        $max = $o['max'] ?? 5000;
        return v_rule(function ($v) use ($max) {
            if (!is_string($v)) vfail('Must be text.');
            $s = trim(str_replace("\r\n", "\n", $v));
            if (mb_strlen($s) > $max) vfail("Must be at most $max characters.");
            return $s;
        }, $o);
    }
    public static function email(array $o = []): Closure
    {
        return v_rule(function ($v) {
            $s = strtolower(trim((string) (is_scalar($v) ? $v : '')));
            if (strlen($s) > 254 || !preg_match('/^[^\s@<>()"\',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/', $s)) vfail('Enter a valid email address.');
            return $s;
        }, $o);
    }
    public static function phone(array $o = []): Closure
    {
        return v_rule(function ($v) {
            $d = preg_replace('/[\s()-]/', '', (string) (is_scalar($v) ? $v : ''));
            if (!preg_match('/^(?:\+?27|0)([6-8]\d{8})$/', $d, $m)) vfail('Enter a valid South African mobile number.');
            return '+27' . $m[1];
        }, $o);
    }
    public static function contactPhone(array $o = []): Closure
    {
        return v_rule(function ($v) {
            $d = preg_replace('/[\s()-]/', '', (string) (is_scalar($v) ? $v : ''));
            if (preg_match('/^(?:\+?27|0)([1-9]\d{8})$/', $d, $m)) return '+27' . $m[1];
            if (preg_match('/^\+[1-9]\d{7,14}$/', $d)) return $d;
            vfail('Enter a valid phone number, e.g. 082 123 4567 or 021 123 4567.');
        }, $o);
    }
    public static function password(array $o = []): Closure
    {
        return v_rule(function ($v) {
            if (!is_string($v) || mb_strlen($v) < 10) vfail('Use at least 10 characters.');
            if (mb_strlen($v) > 200) vfail('Too long.');
            return $v;
        }, $o);
    }
    public static function int(array $o = []): Closure
    {
        $min = $o['min'] ?? PHP_INT_MIN; $max = $o['max'] ?? PHP_INT_MAX;
        return v_rule(function ($v) use ($min, $max) {
            if (is_int($v)) $n = $v;
            elseif (is_float($v) && floor($v) == $v) $n = (int) $v;
            elseif (is_string($v) && preg_match('/^\s*-?\d+\s*$/', $v)) $n = (int) trim($v);
            else vfail('Must be a whole number.');
            if ($n < $min) vfail("Must be at least $min.");
            if ($n > $max) vfail("Must be at most $max.");
            return $n;
        }, $o);
    }
    public static function bool(array $o = []): Closure
    {
        return v_rule(function ($v) {
            if ($v === true || $v === 'true' || $v === 'on' || $v === 1) return true;
            if ($v === false || $v === 'false' || $v === 0) return false;
            vfail('Must be true or false.');
        }, ['optional' => true, 'fallback' => false] + $o);
    }
    public static function uuid(array $o = []): Closure
    {
        return v_rule(function ($v) {
            $s = strtolower((string) (is_scalar($v) ? $v : ''));
            if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $s)) vfail('Invalid identifier.');
            return $s;
        }, $o);
    }
    public static function oneOf(array $values, array $o = []): Closure
    {
        return v_rule(function ($v) use ($values) {
            if (!in_array($v, $values, true)) vfail('Must be one of: ' . implode(', ', $values) . '.');
            return $v;
        }, $o);
    }
    public static function date(array $o = []): Closure
    {
        return v_rule(function ($v) {
            $d = parse_iso($v);
            if ($d === null) vfail('Enter a valid date and time.');
            return $d;
        }, $o);
    }
    public static function idemKey(array $o = []): Closure
    {
        return self::str(['min' => 8, 'max' => 80, 'pattern' => '/^[A-Za-z0-9_.:-]+$/', 'message' => 'Invalid idempotency key.'] + $o);
    }
    public static function arr(Closure $item, array $o = []): Closure
    {
        $min = $o['min'] ?? 0; $max = $o['max'] ?? 50;
        return v_rule(function ($v) use ($item, $min, $max) {
            if (!is_array($v) || !array_is_list($v)) vfail('Must be a list.');
            if (count($v) < $min) vfail("Add at least $min.");
            if (count($v) > $max) vfail("At most $max allowed.");
            $out = [];
            foreach ($v as $i => $x) {
                try { $c = $item($x); } catch (Fail $e) { vfail('Item ' . ($i + 1) . ': ' . $e->getMessage()); }
                $out[] = $c === V_SKIP ? null : $c;
            }
            return $out;
        }, $o);
    }
    public static function obj(array $shape, array $o = []): Closure
    {
        return v_rule(function ($v) use ($shape) {
            if (!is_array($v) || ($v !== [] && array_is_list($v))) vfail('Invalid value.');
            $out = [];
            foreach ($shape as $k => $fn) {
                try { $c = $fn($v[$k] ?? null); } catch (Fail $e) { vfail("$k: " . $e->getMessage()); }
                if ($c !== V_SKIP) $out[$k] = $c;
            }
            return $out;
        }, $o);
    }
}
// Returns only the declared fields, cleaned; throws 422 with per-field messages.
function check($input, array $shape): array
{
    $src = is_array($input) ? $input : [];
    $out = [];
    $errors = [];
    foreach ($shape as $k => $fn) {
        try {
            $c = $fn($src[$k] ?? null);
            if ($c !== V_SKIP) $out[$k] = $c;
        } catch (Fail $e) {
            $errors[$k] = $e->getMessage();
        }
    }
    if ($errors) throw invalid($errors);
    return $out;
}

// ============================================================== crypto
function b64url(string $bin): string { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
function b64url_dec(string $s): string { return (string) base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4)); }
function random_token(int $bytes = 32): string { return b64url(random_bytes($bytes)); }
function sha256(string $s): string { return hash('sha256', $s); }
function hmac_raw(string $keyHex, string $data): string { return hash_hmac('sha256', $data, hex2bin($keyHex), true); }
function safe_equal(string $a, string $b): bool { return hash_equals($a, $b); }
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
function random_code(int $len): string
{
    $out = '';
    while (strlen($out) < $len) {
        foreach (str_split(random_bytes($len * 2)) as $ch) {
            $b = ord($ch);
            if ($b < 240 && strlen($out) < $len) $out .= CODE_ALPHABET[$b % 30];
        }
    }
    return $out;
}
function reference(string $prefix): string { return $prefix . '-' . random_code(8); }
function hash_secret(string $plain): string { return password_hash($plain, PASSWORD_DEFAULT); }
function verify_secret(string $plain, ?string $stored): bool { return $stored ? password_verify($plain, $stored) : false; }
function key_hex(string $name): string
{
    $k = cfg("keys.$name");
    if (!is_string($k) || strlen($k) !== 64) throw new RuntimeException("Missing key $name");
    return $k;
}
function encrypt_str(string $plain): string
{
    $iv = random_bytes(12);
    $tag = '';
    $enc = openssl_encrypt($plain, 'aes-256-gcm', hex2bin(key_hex('data')), OPENSSL_RAW_DATA, $iv, $tag);
    return 'v1.' . b64url($iv) . '.' . b64url($tag) . '.' . b64url($enc);
}
function decrypt_str(string $payload): string
{
    [$v, $iv, $tag, $enc] = array_pad(explode('.', $payload), 4, '');
    if ($v !== 'v1') throw new RuntimeException('unknown ciphertext version');
    $out = openssl_decrypt(b64url_dec($enc), 'aes-256-gcm', hex2bin(key_hex('data')), OPENSSL_RAW_DATA, b64url_dec($iv), b64url_dec($tag));
    if ($out === false) throw new RuntimeException('decryption failed');
    return $out;
}
// Signed, expiring links (unsubscribe, verification). Tamper-proof, not secret.
function sign_link(array $data, int $ttl): string
{
    $body = b64url(json_encode($data + ['exp' => time() + $ttl], JSON_UNESCAPED_SLASHES));
    return $body . '.' . substr(b64url(hmac_raw(key_hex('links'), $body)), 0, 32);
}
function verify_link(?string $token): ?array
{
    $parts = explode('.', (string) $token);
    if (count($parts) !== 2 || $parts[0] === '' || !safe_equal(substr(b64url(hmac_raw(key_hex('links'), $parts[0])), 0, 32), $parts[1])) return null;
    $data = json_decode(b64url_dec($parts[0]), true);
    return is_array($data) && ($data['exp'] ?? 0) >= time() ? $data : null;
}

// ============================================================== sessions & auth
const SESSION_COOKIE = 'tr_sid';
const SESSION_DAYS = 14;

function load_session(): void
{
    $GLOBALS['TR_USER'] = null;
    $GLOBALS['TR_SESSION'] = null;
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || $token === '' || strlen($token) > 100) return;
    $r = row('SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.full_name, u.phone, u.status, u.email_verified_at
                FROM sessions s JOIN users u ON u.id = s.user_id
               WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?', [sha256($token), now_iso()]);
    if (!$r || $r['status'] !== 'active') return;
    $roles = array_column(rows('SELECT role FROM platform_roles WHERE user_id = ?', [$r['id']]), 'role');
    $GLOBALS['TR_SESSION'] = ['id' => $r['session_id'], 'csrfToken' => $r['csrf_token']];
    $GLOBALS['TR_USER'] = [
        'id' => $r['id'], 'email' => $r['email'], 'fullName' => $r['full_name'], 'phone' => $r['phone'],
        'emailVerified' => $r['email_verified_at'] !== null, 'platformRoles' => $roles,
        'primaryRole' => array_values(array_intersect(['admin', 'finance', 'support'], $roles))[0] ?? 'user',
    ];
}
function user(): ?array { return $GLOBALS['TR_USER'] ?? null; }
function session(): ?array { return $GLOBALS['TR_SESSION'] ?? null; }
function require_auth(): array { $u = user(); if (!$u) throw unauthenticated(); return $u; }
function has_role(?array $u, string ...$roles): bool { return $u && array_intersect($roles, $u['platformRoles']) !== []; }
function require_role(string ...$roles): array
{
    $u = require_auth();
    if (!has_role($u, ...$roles)) throw forbidden();
    return $u;
}
function cookie_header(string $value, ?int $expires): string
{
    $parts = [SESSION_COOKIE . '=' . $value, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Expires=' . gmdate('D, d M Y H:i:s \G\M\T', $expires ?? 0)];
    if (cfg('cookieSecure', true) && is_https()) $parts[] = 'Secure';
    return implode('; ', $parts);
}
function create_session(string $userId): void
{
    $token = random_token(32);
    $expires = time() + SESSION_DAYS * 86400;
    insert('sessions', ['id' => uuid(), 'token_hash' => sha256($token), 'user_id' => $userId, 'csrf_token' => random_token(24),
        'created_at' => now_iso(), 'expires_at' => iso_at($expires), 'user_agent' => substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), 'ip' => client_ip()]);
    header('Set-Cookie: ' . cookie_header($token, $expires), false);
}
function clear_session_cookie(): void { header('Set-Cookie: ' . cookie_header('', 0), false); }

// CSRF: (1) state-changing calls must be JSON or a declared image upload, which
// a cross-site HTML form cannot send; (2) with a session, the per-session token
// must be echoed in X-CSRF-Token.
function csrf_check(string $method, string $path): void
{
    if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) return;
    $type = strtolower((string) ($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
    $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if (str_ends_with($path, '/uploads')) {
        if (!preg_match('#^image/(png|jpeg|webp)$#', $type)) throw new AppError(415, 'unsupported_media_type', 'Upload a PNG, JPEG or WebP image.');
    } elseif (!($type === '' && $len === 0) && !str_starts_with($type, 'application/json')) {
        throw new AppError(415, 'unsupported_media_type', 'Requests must be JSON.');
    }
    $s = session();
    if ($s) {
        $sent = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        if ($sent === '' || !safe_equal($s['csrfToken'], $sent)) {
            throw new AppError(403, 'csrf_failed', 'Your session security token is missing or stale. Refresh the page and try again.');
        }
    }
}

// ============================================================== rate limiting
function limit(string $bucket, int $max, int $windowSeconds, ?string $key = null): void
{
    if (cfg('rateLimitDisabled', false)) return;
    $k = $bucket . ':' . ($key ?? client_ip());
    $now = time();
    $hit = tx(function () use ($k, $now, $windowSeconds) {
        $r = row('SELECT count, reset_at FROM rate_limits WHERE key = ?', [$k]);
        if (!$r || $r['reset_at'] < $now) {
            q('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = excluded.reset_at', [$k, $now + $windowSeconds]);
            return 1;
        }
        q('UPDATE rate_limits SET count = count + 1 WHERE key = ?', [$k]);
        return $r['count'] + 1;
    });
    if ($hit > $max) throw too_many();
}

// ============================================================== audit
// Append-only, hash-chained. Every row's hash covers the previous row's hash,
// so an out-of-band edit breaks the chain (Back office → Audit log → Verify).
function audit_scrub($value, int $depth = 0)
{
    if ($depth > 4 || !is_array($value)) return $value;
    $out = [];
    foreach ($value as $k => $v) {
        $out[$k] = (is_string($k) && preg_match('/pass|pin|token|secret|key|card|cvv|account_?number|activation/i', $k)) ? '[redacted]' : audit_scrub($v, $depth + 1);
    }
    return $out;
}
function canonical($v): string
{
    if (is_array($v)) {
        if (array_is_list($v)) return '[' . implode(',', array_map('canonical', $v)) . ']';
        $keys = array_keys($v);
        sort($keys, SORT_STRING);
        return '{' . implode(',', array_map(fn($k) => json_encode((string) $k, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ':' . canonical($v[$k]), $keys)) . '}';
    }
    return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
function audit_hash(string $prev, array $r): string
{
    return hash('sha256', canonical([$prev, $r['occurred_at'], $r['actor_id'], $r['actor_role'], $r['action'], $r['entity_type'], $r['entity_id'], $r['organiser_id'], $r['details']]));
}
function audit(string $action, array $o = []): void
{
    tx(function () use ($action, $o) {
        $actor = $o['actor'] ?? user();
        $prev = val('SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1') ?: 'GENESIS';
        $r = [
            'occurred_at' => now_iso(),
            'actor_id' => $actor['id'] ?? null,
            'actor_role' => $o['actorRole'] ?? ($actor ? ($actor['primaryRole'] ?? 'user') : 'system'),
            'action' => $action,
            'entity_type' => $o['entityType'] ?? null,
            'entity_id' => isset($o['entityId']) ? (string) $o['entityId'] : null,
            'organiser_id' => $o['organiserId'] ?? null,
            'details' => audit_scrub($o['details'] ?? []),
        ];
        insert('audit_log', array_merge($r, [
            'details' => $r['details'] ? json_encode($r['details'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : '{}',
            'ip' => $o['ip'] ?? null, 'prev_hash' => $prev, 'row_hash' => audit_hash($prev, $r),
        ]));
    });
}
function audit_verify(): array
{
    $prev = 'GENESIS';
    $n = 0;
    foreach (q('SELECT * FROM audit_log ORDER BY id')->fetchAll() as $r) {
        $n++;
        $r['details'] = json_decode($r['details'], true) ?? [];
        if ($r['prev_hash'] !== $prev || $r['row_hash'] !== audit_hash($prev, $r)) return ['ok' => false, 'brokenAt' => $r['id'], 'checked' => $n];
        $prev = $r['row_hash'];
    }
    return ['ok' => true, 'checked' => $n];
}

// ============================================================== money
function ticket_fee(int $priceCents): int
{
    if ($priceCents === 0) return 0;
    return (int) cfg('fees.ticketFeeFixedCents', 1000) + bps_of($priceCents, (int) cfg('fees.ticketFeeBps', 0));
}
function bps_of(int $cents, int $bps): int { return (int) round($cents * $bps / 10000, 0, PHP_ROUND_HALF_UP); }
function format_zar(int $cents): string
{
    $abs = abs($cents);
    return ($cents < 0 ? '-' : '') . 'R ' . number_format(intdiv($abs, 100), 0, '.', ' ') . '.' . str_pad((string) ($abs % 100), 2, '0', STR_PAD_LEFT);
}
