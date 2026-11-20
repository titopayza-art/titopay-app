<?php
// Staff two-step sign-in with an authenticator app (time-based codes,
// RFC 6238), the admin switch that makes it compulsory, and the "I am
// human" checks on public forms: hidden traps always, Cloudflare Turnstile
// when its keys are saved (Admin portal, Site settings, Security).
declare(strict_types=1);

const TOTP_STEP = 30;
const TOTP_DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32_encode(string $bin): string
{
    $bits = '';
    foreach (str_split($bin) as $c) $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
    $out = '';
    foreach (str_split($bits, 5) as $chunk) $out .= B32[bindec(str_pad($chunk, 5, '0'))];
    return $out;
}
function b32_decode(string $s): string
{
    $s = strtoupper(preg_replace('/[^A-Za-z2-7]/', '', $s));
    $bits = '';
    foreach (str_split($s) as $c) $bits .= str_pad(decbin(strpos(B32, $c)), 5, '0', STR_PAD_LEFT);
    $out = '';
    foreach (str_split($bits, 8) as $byte) if (strlen($byte) === 8) $out .= chr(bindec($byte));
    return $out;
}
function totp_at(string $secretB32, int $step): string
{
    $h = hash_hmac('sha1', pack('N2', 0, $step), b32_decode($secretB32), true);
    $o = ord($h[19]) & 0xf;
    $n = ((ord($h[$o]) & 0x7f) << 24) | (ord($h[$o + 1]) << 16) | (ord($h[$o + 2]) << 8) | ord($h[$o + 3]);
    return str_pad((string) ($n % (10 ** TOTP_DIGITS)), TOTP_DIGITS, '0', STR_PAD_LEFT);
}
// The step the code belongs to (one step of clock drift either way), or null.
// A step at or before $lastStep was used already: never accepted twice.
function totp_match(string $secretB32, string $code, int $lastStep = 0): ?int
{
    if (!preg_match('/^\d{6}$/', $code)) return null;
    $now = intdiv(time(), TOTP_STEP);
    foreach ([0, -1, 1] as $d) {
        $step = $now + $d;
        if ($step > $lastStep && hash_equals(totp_at($secretB32, $step), $code)) return $step;
    }
    return null;
}
function totp_uri(string $secretB32, string $email): string
{
    return 'otpauth://totp/' . rawurlencode("TicketRoom:$email") . '?secret=' . $secretB32 . '&issuer=TicketRoom&algorithm=SHA1&digits=6&period=30';
}

// ---- staff two-step ----------------------------------------------------------
function staff_two_step_required(): bool { return !empty(settings_all()['security']['staffTwoStep']); }
function staff_two_step_on(string $userId): bool { return (bool) val('SELECT totp_enabled_at FROM users WHERE id = ?', [$userId]); }
// Staff who have not set up an authenticator app yet (shown on the Security card).
function staff_two_step_missing(): array
{
    return array_column(rows("SELECT u.full_name FROM users u WHERE u.account_type = 'staff' AND u.status = 'active' AND u.totp_enabled_at IS NULL
                               AND EXISTS (SELECT 1 FROM platform_roles r WHERE r.user_id = u.id) ORDER BY u.full_name"), 'full_name');
}
// While two-step is compulsory, a staff member without it can only set it up.
function staff_two_step_guard(string $method, string $path): void
{
    $u = user();
    if (!$u || ($u['accountType'] ?? '') !== 'staff' || !empty($u['twoStep']) || !staff_two_step_required()) return;
    if (str_starts_with($path, '/api/admin/me/two-step') || in_array($path, ['/api/auth/me', '/api/auth/logout', '/api/config', '/api/site', '/api/health'], true)) return;
    throw new AppError(403, 'two_step_required', 'Set up two-step sign-in with an authenticator app to open the admin portal.');
}
// Setting it up: a new secret waits (encrypted) until a first code proves the app has it.
function staff_two_step_start(array $u): array
{
    $secret = b32_encode(random_bytes(20));
    q('UPDATE users SET totp_pending = ?, updated_at = ? WHERE id = ?', [encrypt_str($secret), now_iso(), $u['id']]);
    $uri = totp_uri($secret, $u['email']);
    return ['secret' => trim(chunk_split($secret, 4, ' ')), 'uri' => $uri, 'qrSvg' => tr_qr_svg($uri, ['ecc' => 'M', 'margin' => 2])];
}
function staff_two_step_confirm(array $u, string $code): void
{
    $enc = val('SELECT totp_pending FROM users WHERE id = ?', [$u['id']]);
    if (!$enc) throw conflict('Start setting up first.', 'two_step_not_started');
    $secret = decrypt_str((string) $enc);
    $step = totp_match($secret, $code);
    if ($step === null) throw invalid(['code' => 'That code is not right. Check the time on your phone and try the newest code.']);
    q('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ?, updated_at = ? WHERE id = ?', [encrypt_str($secret), now_iso(), $step, now_iso(), $u['id']]);
    audit('security.two_step_enabled', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id']]);
}
function staff_two_step_clear(string $userId): void
{
    q('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', [now_iso(), $userId]);
}
// At sign-in: the code from the app, once only.
function staff_two_step_check(string $userId, string $code): bool
{
    $r = row('SELECT totp_secret, totp_last_step FROM users WHERE id = ? AND totp_enabled_at IS NOT NULL', [$userId]);
    if (!$r || !$r['totp_secret']) return false;
    $step = totp_match(decrypt_str((string) $r['totp_secret']), $code, (int) ($r['totp_last_step'] ?? 0));
    if ($step === null) return false;
    return affected('UPDATE users SET totp_last_step = ? WHERE id = ? AND COALESCE(totp_last_step, 0) < ?', [$step, $userId, $step]) === 1;
}

// ---- "I am human" ------------------------------------------------------------
function turnstile_site_key(): string { return trim((string) cfg('turnstile.siteKey', '')); }
function turnstile_ready(): bool { return turnstile_site_key() !== '' && (string) cfg('turnstile.secretKey', '') !== ''; }
// Public forms: the hidden trap fields must stay empty (people never see
// them; form-filling bots fill everything), and with Turnstile on, its token
// must check out with Cloudflare.
function human_check(?array $body = null): void
{
    $b = $body ?? body();
    if (trim((string) ($b['fax_number'] ?? '')) !== '') {
        audit('security.form_trap', ['ip' => client_ip(), 'details' => ['path' => $GLOBALS['TR_REQ']['path'] ?? '']]);
        throw bad('Something went wrong. Refresh the page and try again.');
    }
    if (!turnstile_ready()) return;
    $token = (string) ($b['turnstileToken'] ?? $b['cf-turnstile-response'] ?? '');
    if ($token === '' || strlen($token) > 2048) throw new AppError(400, 'human_check', 'Please complete the check that you are human, then try again.');
    try {
        $r = http_request('POST', (string) (cfg('turnstile.verifyUrl') ?: 'https://challenges.cloudflare.com/turnstile/v0/siteverify'), ['Content-Type' => 'application/x-www-form-urlencoded'],
            http_build_query(['secret' => (string) cfg('turnstile.secretKey'), 'response' => $token, 'remoteip' => client_ip()]), 8);
    } catch (Throwable $e) {
        // Cloudflare unreachable: let people through rather than lock everyone out; the traps still apply.
        error_log('[turnstile] ' . integration_scrub($e->getMessage()));
        return;
    }
    if (empty($r['json']['success'])) throw new AppError(400, 'human_check', 'The check that you are human did not go through. Please try it again.');
}
