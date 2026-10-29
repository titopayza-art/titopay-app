<?php
// Sign in with Google (OpenID Connect, authorisation code flow).
//
// Customers and organisers can continue with Google instead of a password.
// Google tells us the person's email and that Google has verified it; we
// match it to an existing TicketRoom account or create one. Staff accounts
// never sign in this way: they use the admin portal's password sign-in only.
// Set up by an admin under Integrations (client ID and secret from Google
// Cloud); the redirect address to register is shown on that card.
declare(strict_types=1);

const GOOGLE_PORTALS = ['site' => '/', 'customer' => '/account', 'organiser' => '/organisers'];

function google_ready(): bool
{
    return cfg('google.enabled') === 'on' && (string) cfg('google.clientId', '') !== '' && (string) cfg('google.clientSecret', '') !== '';
}
function google_redirect_uri(): string { return base_url() . '/api/auth/google/callback'; }
function google_cookie(string $value, int $ttl): string
{
    $parts = ["tr_gstate=$value", 'Path=/api/auth/google', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=' . $ttl];
    return implode('; ', $parts);
}
// Only paths on this site, so the sign-in can never send someone elsewhere.
function google_next(?string $next, string $fallback): string
{
    return is_string($next) && preg_match('#^/(?!/)[A-Za-z0-9/_\-.?=&%\#]*$#', $next) && !str_contains($next, '\\') ? $next : $fallback;
}
function google_fail(string $portal, string $code, ?string $next = null): Response
{
    $destination = google_next($next, GOOGLE_PORTALS[$portal]);
    [$path, $fragment] = array_pad(explode('#', $destination, 2), 2, '');
    $location = $path . (str_contains($path, '?') ? '&' : '?') . 'google=' . rawurlencode($code) . ($fragment !== '' ? '#' . $fragment : '');
    return raw_out('', 'text/html', 302, ['Location' => $location, 'Cache-Control' => 'no-store']);
}

// Verify the Google-issued ID token locally. Parsing a JWT payload without its
// signature is not OpenID Connect validation, even when the token arrived over
// TLS. JWKS is cached in private storage for a short period to avoid a network
// dependency on every sign-in.
function google_der_len(int $len): string
{
    if ($len < 128) return chr($len);
    $out = '';
    while ($len > 0) { $out = chr($len & 255) . $out; $len >>= 8; }
    return chr(128 | strlen($out)) . $out;
}
function google_der(string $tag, string $value): string { return $tag . google_der_len(strlen($value)) . $value; }
function google_der_int(string $value): string
{
    $value = ltrim($value, "\0");
    if ($value === '' || (ord($value[0]) & 128)) $value = "\0" . $value;
    return google_der("\x02", $value);
}
function google_jwk_pem(array $jwk): ?string
{
    if (($jwk['kty'] ?? '') !== 'RSA' || !is_string($jwk['n'] ?? null) || !is_string($jwk['e'] ?? null)) return null;
    $rsa = google_der("\x30", google_der_int(b64url_dec($jwk['n'])) . google_der_int(b64url_dec($jwk['e'])));
    $alg = google_der("\x30", google_der("\x06", "\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01") . google_der("\x05", ''));
    $spki = google_der("\x30", $alg . google_der("\x03", "\0" . $rsa));
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
}
function google_jwks(): array
{
    $file = data_dir() . '/google-jwks.json';
    $cached = is_file($file) ? json_decode((string) @file_get_contents($file), true) : null;
    if (is_array($cached) && is_array($cached['keys'] ?? null) && (int) ($cached['fetchedAt'] ?? 0) > time() - 3600) return $cached['keys'];
    $r = http_request('GET', 'https://www.googleapis.com/oauth2/v3/certs', ['Accept' => 'application/json'], null, 10);
    if ($r['status'] !== 200 || !is_array($r['json']['keys'] ?? null)) {
        if (is_array($cached) && is_array($cached['keys'] ?? null) && (int) ($cached['fetchedAt'] ?? 0) > time() - 86400) return $cached['keys'];
        throw new RuntimeException('Google signing keys are unavailable.');
    }
    $value = json_encode(['fetchedAt' => time(), 'keys' => $r['json']['keys']], JSON_UNESCAPED_SLASHES);
    @file_put_contents($file, $value, LOCK_EX);
    @chmod($file, 0600);
    return $r['json']['keys'];
}
function google_validate_id_token(string $idToken, string $nonce): ?array
{
    $parts = explode('.', $idToken);
    if (count($parts) !== 3) return null;
    [$head, $body, $sig] = $parts;
    $h = json_decode(b64url_dec($head), true);
    $claims = json_decode(b64url_dec($body), true);
    if (!is_array($h) || !is_array($claims) || ($h['alg'] ?? '') !== 'RS256' || empty($h['kid'])) return null;
    $pem = null;
    foreach (google_jwks() as $jwk) if (($jwk['kid'] ?? '') === $h['kid']) { $pem = google_jwk_pem($jwk); break; }
    if (!$pem || openssl_verify($head . '.' . $body, b64url_dec($sig), $pem, OPENSSL_ALGO_SHA256) !== 1) return null;
    $client = (string) cfg('google.clientId');
    $aud = $claims['aud'] ?? null;
    $audOk = is_string($aud) ? hash_equals($client, $aud) : (is_array($aud) && in_array($client, $aud, true));
    $multiAud = is_array($aud) && count($aud) > 1;
    if (!$audOk || ($multiAud && !hash_equals($client, (string) ($claims['azp'] ?? ''))) || !in_array($claims['iss'] ?? '', ['https://accounts.google.com', 'accounts.google.com'], true)
        || (int) ($claims['exp'] ?? 0) < time() - 60 || (int) ($claims['iat'] ?? 0) > time() + 300 || !is_string($claims['nonce'] ?? null) || !safe_equal($nonce, $claims['nonce']) || empty($claims['sub'])) return null;
    return $claims;
}

route('GET', '/api/auth/google/start', function () {
    limit('gstart', 30, 600);
    $portal = isset(GOOGLE_PORTALS[qs('portal') ?? '']) ? qs('portal') : 'site';
    if (!google_ready()) return google_fail($portal, 'off', google_next(qs('next'), GOOGLE_PORTALS[$portal]));
    $nonce = random_token(24);
    $state = sign_link(['g' => sha256($nonce), 'p' => $portal, 'n' => google_next(qs('next'), GOOGLE_PORTALS[$portal])], 600);
    header('Set-Cookie: ' . google_cookie($nonce, 600), false);
    $url = cfg('google.authUrl', 'https://accounts.google.com/o/oauth2/v2/auth') . '?' . http_build_query([
        'client_id' => cfg('google.clientId'), 'redirect_uri' => google_redirect_uri(), 'response_type' => 'code',
        'scope' => 'openid email profile', 'state' => $state, 'nonce' => $nonce, 'prompt' => 'select_account',
    ]);
    return raw_out('', 'text/html', 302, ['Location' => $url, 'Cache-Control' => 'no-store']);
});

route('GET', '/api/auth/google/callback', function () {
    limit('gcallback', 30, 600);
    $st = verify_link(qs('state'));
    $portal = isset(GOOGLE_PORTALS[$st['p'] ?? '']) ? $st['p'] : 'site';
    $next = google_next($st['n'] ?? null, GOOGLE_PORTALS[$portal]);
    $nonce = (string) ($_COOKIE['tr_gstate'] ?? '');
    header('Set-Cookie: ' . google_cookie('', 0), false);
    // The state must be ours, recent, and belong to this browser.
    if (!$st || $nonce === '' || !safe_equal((string) ($st['g'] ?? ''), sha256($nonce))) return google_fail($portal, 'expired', $next);
    if (qs('error')) return google_fail($portal, 'cancelled', $next);
    if (!google_ready() || !qs('code')) return google_fail($portal, 'off', $next);
    try {
        $r = http_request('POST', (string) cfg('google.tokenUrl', 'https://oauth2.googleapis.com/token'), ['Content-Type' => 'application/x-www-form-urlencoded'], http_build_query([
            'code' => qs('code'), 'client_id' => cfg('google.clientId'), 'client_secret' => cfg('google.clientSecret'),
            'redirect_uri' => google_redirect_uri(), 'grant_type' => 'authorization_code',
        ]), 10);
    } catch (Throwable $e) { error_log('[google] token: ' . integration_scrub($e->getMessage())); return google_fail($portal, 'unavailable', $next); }
    $idToken = $r['json']['id_token'] ?? null;
    if ($r['status'] !== 200 || !is_string($idToken)) { error_log("[google] token exchange HTTP {$r['status']}"); return google_fail($portal, 'unavailable', $next); }
    try { $claims = google_validate_id_token($idToken, $nonce); }
    catch (Throwable $e) { error_log('[google] token validation: ' . integration_scrub($e->getMessage())); $claims = null; }
    if (!$claims) return google_fail($portal, 'unavailable', $next);
    $email = strtolower(trim((string) ($claims['email'] ?? '')));
    if ($email === '' || ($claims['email_verified'] ?? false) !== true) return google_fail($portal, 'unverified', $next);
    $name = mb_substr(trim((string) ($claims['name'] ?? '')), 0, 120) ?: explode('@', $email)[0];
    if (settings_all()['maintenance']['enabled']) return google_fail($portal, 'maintenance', $next);

    $result = tx(function () use ($email, $name, $portal) {
        $now = now_iso();
        $u = user_by_email($email);
        if ($u && in_array($u['status'], ['suspended', 'deleted'], true)) return ['fail' => 'suspended'];
        // Staff never sign in with Google; say nothing about the account.
        if ($u && account_type($u) === 'staff') return ['fail' => 'not_allowed'];
        if ($u) {
            $type = account_type($u);
            if (!in_array($type, PORTAL_ACCEPTS[$portal], true)) return ['fail' => $type === 'organiser' ? 'organiser_account' : 'customer_account'];
            // Google has confirmed the email: a guest becomes a full account and an unconfirmed one is confirmed.
            q('UPDATE users SET guest = 0, email_verified_at = COALESCE(email_verified_at, ?), full_name = COALESCE(NULLIF(full_name, \'\'), ?), failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
                [$now, $name, $now, $u['id']]);
            audit('user.google_signin', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip(), 'details' => ['portal' => $portal, 'wasGuest' => (int) $u['guest'] === 1]]);
            return ['user' => $u, 'new' => false];
        }
        // New: the account type follows the portal (organiser portal: organiser; anywhere else: customer).
        $type = $portal === 'organiser' ? 'organiser' : 'customer';
        $u = insert('users', ['id' => uuid(), 'email' => $email, 'email_key' => email_key($email), 'full_name' => $name,
            'password_hash' => hash_secret(random_token(32)), 'status' => 'active', 'account_type' => $type, 'email_verified_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
        audit('user.registered', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip(), 'details' => ['via' => 'google', 'type' => $type]]);
        return ['user' => $u, 'new' => true];
    });
    if (isset($result['fail'])) return google_fail($portal, $result['fail'], $next);
    if (!$result['new'] && (int) ($result['user']['email_otp_enabled'] ?? 0) === 1) {
        limit('user-login-code-send', 5, 3600, $result['user']['id']);
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $challenge = random_token(32);
        tx(function () use ($result, $code, $challenge, $portal) {
            $u = $result['user'];
            q('INSERT INTO user_login_codes (user_id, challenge_hash, code_hash, portal, attempts, expires_at, created_at) VALUES (?,?,?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET challenge_hash = excluded.challenge_hash, code_hash = excluded.code_hash, portal = excluded.portal, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at',
                [$u['id'], sha256($challenge), hash_secret($code), $portal, iso_in(600), now_iso()]);
            outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('loginCode', ['name' => $u['full_name'], 'code' => $code]));
            audit('security.user_login_code_sent', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip(), 'details' => ['via' => 'google']]);
        });
        $next = google_next($st['n'] ?? null, GOOGLE_PORTALS[$portal]);
        return raw_out('', 'text/html', 302, ['Location' => '/login-otp?challenge=' . rawurlencode($challenge) . '&next=' . rawurlencode($next), 'Cache-Control' => 'no-store']);
    }
    create_session($result['user']['id']);
    $dest = $result['new'] && $portal === 'organiser' ? '/organisers' : google_next($st['n'] ?? null, GOOGLE_PORTALS[$portal]);
    return raw_out('', 'text/html', 302, ['Location' => $dest, 'Cache-Control' => 'no-store']);
});
