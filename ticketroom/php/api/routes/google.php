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
    $parts = ["tr_gstate=$value", 'Path=/api/auth/google', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' . $ttl];
    if (cfg('cookieSecure', true) && is_https()) $parts[] = 'Secure';
    return implode('; ', $parts);
}
// Only paths on this site, so the sign-in can never send someone elsewhere.
function google_next(?string $next, string $fallback): string
{
    return is_string($next) && preg_match('#^/(?!/)[A-Za-z0-9/_\-.?=&%\#]*$#', $next) && !str_contains($next, '\\') ? $next : $fallback;
}
function google_fail(string $portal, string $code): Response
{
    return raw_out('', 'text/html', 302, ['Location' => GOOGLE_PORTALS[$portal] . '?google=' . $code, 'Cache-Control' => 'no-store']);
}

route('GET', '/api/auth/google/start', function () {
    limit('gstart', 30, 600);
    $portal = isset(GOOGLE_PORTALS[qs('portal') ?? '']) ? qs('portal') : 'site';
    if (!google_ready()) return google_fail($portal, 'off');
    $nonce = random_token(24);
    $state = sign_link(['g' => sha256($nonce), 'p' => $portal, 'n' => google_next(qs('next'), GOOGLE_PORTALS[$portal])], 600);
    header('Set-Cookie: ' . google_cookie($nonce, 600), false);
    $url = cfg('google.authUrl', 'https://accounts.google.com/o/oauth2/v2/auth') . '?' . http_build_query([
        'client_id' => cfg('google.clientId'), 'redirect_uri' => google_redirect_uri(), 'response_type' => 'code',
        'scope' => 'openid email profile', 'state' => $state, 'prompt' => 'select_account',
    ]);
    return raw_out('', 'text/html', 302, ['Location' => $url, 'Cache-Control' => 'no-store']);
});

route('GET', '/api/auth/google/callback', function () {
    limit('gcallback', 30, 600);
    $st = verify_link(qs('state'));
    $portal = isset(GOOGLE_PORTALS[$st['p'] ?? '']) ? $st['p'] : 'site';
    $nonce = (string) ($_COOKIE['tr_gstate'] ?? '');
    header('Set-Cookie: ' . google_cookie('', 0), false);
    // The state must be ours, recent, and belong to this browser.
    if (!$st || $nonce === '' || !safe_equal((string) ($st['g'] ?? ''), sha256($nonce))) return google_fail($portal, 'expired');
    if (qs('error')) return google_fail($portal, 'cancelled');
    if (!google_ready() || !qs('code')) return google_fail($portal, 'off');
    try {
        $r = http_request('POST', (string) cfg('google.tokenUrl', 'https://oauth2.googleapis.com/token'), ['Content-Type' => 'application/x-www-form-urlencoded'], http_build_query([
            'code' => qs('code'), 'client_id' => cfg('google.clientId'), 'client_secret' => cfg('google.clientSecret'),
            'redirect_uri' => google_redirect_uri(), 'grant_type' => 'authorization_code',
        ]), 10);
    } catch (Throwable $e) { error_log('[google] token: ' . integration_scrub($e->getMessage())); return google_fail($portal, 'unavailable'); }
    $idToken = $r['json']['id_token'] ?? null;
    if ($r['status'] !== 200 || !is_string($idToken)) { error_log("[google] token exchange HTTP {$r['status']}"); return google_fail($portal, 'unavailable'); }
    // Received straight from Google over TLS in exchange for our secret, so the
    // claims can be read without checking the signature again (Google's guidance).
    $parts = explode('.', $idToken);
    $claims = count($parts) === 3 ? json_decode(b64url_dec($parts[1]), true) : null;
    if (!is_array($claims) || ($claims['aud'] ?? '') !== cfg('google.clientId') || !in_array($claims['iss'] ?? '', ['https://accounts.google.com', 'accounts.google.com'], true)
        || (int) ($claims['exp'] ?? 0) < time()) return google_fail($portal, 'unavailable');
    $email = strtolower(trim((string) ($claims['email'] ?? '')));
    if ($email === '' || ($claims['email_verified'] ?? false) !== true) return google_fail($portal, 'unverified');
    $name = mb_substr(trim((string) ($claims['name'] ?? '')), 0, 120) ?: explode('@', $email)[0];
    if (settings_all()['maintenance']['enabled']) return google_fail($portal, 'maintenance');

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
    if (isset($result['fail'])) return google_fail($portal, $result['fail']);
    create_session($result['user']['id']);
    $dest = $result['new'] && $portal === 'organiser' ? '/organisers' : google_next($st['n'] ?? null, GOOGLE_PORTALS[$portal]);
    return raw_out('', 'text/html', 302, ['Location' => $dest, 'Cache-Control' => 'no-store']);
});
