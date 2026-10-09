<?php
// /api/health, /api/config and /api/auth/* — accounts, sessions, POPIA rights.
declare(strict_types=1);

route('GET', '/api/health', function () {
    val('SELECT 1');
    return ['ok' => true, 'service' => 'ticketroom', 'edition' => 'php', 'version' => TR_VERSION, 'provider' => 'none'];
});
route('GET', '/api/config', fn() => [
    'operator' => 'TicketRoom', 'edition' => 'php', 'provider' => 'none', 'simulatedPayments' => false, 'cardPaymentsEnabled' => false, 'titopayWallet' => false,
    'features' => ['payments' => false, 'cashless' => false, 'pos' => false, 'finance' => false, 'sms' => false, 'tags' => false,
        'walletApple' => wallet_apple_ready(), 'walletGoogle' => wallet_google_ready()],
    'messaging' => ['email' => mail_mode(), 'sms' => 'none'],
    'cashless' => ['pinThresholdCents' => 20000, 'minTopupCents' => 5000, 'maxTopupCents' => 300000, 'maxBalanceCents' => 500000],
    'fees' => cfg('fees'), 'holdMinutes' => HOLD_MINUTES,
]);

function send_verification(array $u): void
{
    $url = base_url() . '/account#/verify/' . sign_link(['v' => $u['id'], 'e' => $u['email']], 7 * 86400);
    outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('verifyEmail', ['name' => $u['full_name'], 'url' => $url]));
}

route('POST', '/api/auth/register', function () {
    limit('register', 10, 3600);
    $b = check(body(), ['fullName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(), 'phone' => R::phone(['optional' => true]),
        'password' => R::password(), 'marketingOptIn' => R::bool(), 'acceptTerms' => R::bool()]);
    if (!$b['acceptTerms']) throw bad('Please accept the Terms and Privacy Notice.', ['acceptTerms' => 'Required.']);
    $id = tx(function () use ($b) {
        if (val('SELECT 1 FROM users WHERE lower(email) = ?', [$b['email']])) throw conflict('An account with this email already exists. Sign in instead.', 'email_taken');
        $now = now_iso();
        $u = insert('users', ['id' => uuid(), 'email' => $b['email'], 'phone' => $b['phone'] ?? null, 'full_name' => $b['fullName'], 'password_hash' => hash_secret($b['password']), 'status' => 'active', 'created_at' => $now, 'updated_at' => $now]);
        if ($b['marketingOptIn']) set_consent($u['id'], null, 'email', true, 'signup');
        send_verification($u);
        audit('user.registered', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        create_session($u['id']);
        return $u['id'];
    });
    return json_out(['user' => profile($id)], 201);
});

route('POST', '/api/auth/login', function () {
    limit('login', 20, 900);
    $b = check(body(), ['email' => R::email(), 'password' => R::str(['min' => 1, 'max' => 200])]);
    $u = row('SELECT * FROM users WHERE lower(email) = ?', [$b['email']]);
    // Compare against a real hash even for unknown emails, so timing does not reveal accounts.
    $ok = verify_secret($b['password'], $u['password_hash'] ?? '$2y$10$WPT59Gnb/QYXeEjTyv1sp.pD4KgnvD5SRlQY9iG6ybrv4y.LW5AXy') && $u;
    // The same answer for an unknown email, a wrong password and a locked
    // account, so the sign-in box never reveals who has an account.
    $generic = new AppError(401, 'bad_credentials', 'Email or password is incorrect. After several tries, wait 15 minutes or use "Forgot password?".');
    if (!$u || $u['status'] === 'deleted') throw $generic;
    // 5 tries per email from one connection every 15 minutes, and a pause for
    // the whole account only after 30 failures from anywhere, which then
    // clears itself: nobody can keep someone else locked out for long.
    limit('loginpair', 5, 900, $b['email'] . '|' . client_ip());
    $locked = $u['locked_until'] && to_unix($u['locked_until']) > microtime(true);
    if ($u['locked_until'] && !$locked) { q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [$u['id']]); $u['failed_logins'] = 0; }
    if ($locked) throw $generic;
    if (!$ok) {
        q('UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 30 THEN ? END WHERE id = ?', [iso_in(900), $u['id']]);
        throw $generic;
    }
    if ($u['status'] === 'suspended') throw new AppError(403, 'suspended', 'This account is suspended. Contact hello@ticketroom.co.za.');
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) q('UPDATE users SET password_hash = ? WHERE id = ?', [hash_secret($b['password']), $u['id']]);
    q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [$u['id']]);
    create_session($u['id']);
    return ['user' => profile($u['id'])];
});

route('POST', '/api/auth/logout', function () {
    if (session()) q('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now_iso(), session()['id']]);
    clear_session_cookie();
    return ['ok' => true];
});

route('GET', '/api/auth/me', function () {
    if (!user()) return ['user' => null];
    $p = profile(user()['id']);
    // The first administrator signs in with a temporary password; the pages
    // keep reminding them until it is changed.
    if (val('SELECT 1 FROM meta WHERE key = ?', ['temp_password:' . user()['id']])) $p['mustChangePassword'] = true;
    return ['user' => $p, 'csrfToken' => session()['csrfToken']];
});

route('PATCH', '/api/auth/me', function () {
    $u = require_auth();
    $b = check(body(), ['fullName' => R::str(['min' => 2, 'max' => 120]), 'phone' => R::phone(['optional' => true])]);
    q('UPDATE users SET full_name = ?, phone = ?, updated_at = ? WHERE id = ?', [$b['fullName'], $b['phone'] ?? null, now_iso(), $u['id']]);
    return ['user' => profile($u['id'])];
});

route('POST', '/api/auth/me/password', function () {
    $u = require_auth();
    limit('pwchange', 10, 900, $u['id']);
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'newPassword' => R::password()]);
    if (!verify_secret($b['currentPassword'], val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Current password is incorrect.');
    q('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash_secret($b['newPassword']), now_iso(), $u['id']]);
    q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [now_iso(), $u['id'], session()['id']]);
    q('DELETE FROM meta WHERE key = ?', ["temp_password:{$u['id']}"]);
    audit('user.password_changed', ['entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
    return ['ok' => true];
});

route('POST', '/api/auth/me/pin', function () { require_auth(); throw not_available(); });

route('POST', '/api/auth/verify-email', function () {
    $b = check(body(), ['token' => R::str(['max' => 600])]);
    $d = verify_link($b['token']);
    if (!$d || empty($d['v'])) throw bad('This verification link is invalid or has expired.');
    q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ? AND lower(email) = lower(?)', [now_iso(), $d['v'], $d['e'] ?? '']);
    return ['ok' => true];
});

route('POST', '/api/auth/verify-email/resend', function () {
    $u = require_auth();
    limit('verify', 3, 3600, $u['id']);
    send_verification(row('SELECT * FROM users WHERE id = ?', [$u['id']]));
    return ['ok' => true];
});

route('POST', '/api/auth/password/forgot', function () {
    limit('forgot', 5, 3600);
    $b = check(body(), ['email' => R::email()]);
    $u = row("SELECT * FROM users WHERE lower(email) = ? AND status = 'active'", [$b['email']]);
    if ($u) {
        $token = random_token(32);
        tx(function () use ($u, $token) {
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $u['id'], 'expires_at' => iso_in(3600), 'created_at' => now_iso()]);
            outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('passwordReset', ['name' => $u['full_name'], 'url' => base_url() . "/account#/reset/$token"]));
        });
        if (cfg('dev')) header("X-Dev-Reset-Token: $token");
    }
    return ['ok' => true, 'message' => 'If that email has an account, a reset link is on its way.'];
});

route('POST', '/api/auth/password/reset', function () {
    limit('reset', 10, 3600);
    $b = check(body(), ['token' => R::str(['max' => 100]), 'password' => R::password()]);
    tx(function () use ($b) {
        $r = row('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [sha256($b['token']), now_iso()]);
        if (!$r) throw bad('This reset link is invalid or has expired.');
        $now = now_iso();
        q('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', [$now, sha256($b['token'])]);
        // A staff invite doubles as email proof, so mark the address verified.
        q('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', [hash_secret($b['password']), $now, $now, $r['user_id']]);
        q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [$now, $r['user_id']]);
        q('DELETE FROM meta WHERE key = ?', ["temp_password:{$r['user_id']}"]);
        audit('user.password_reset', ['actor' => ['id' => $r['user_id']], 'entityType' => 'user', 'entityId' => $r['user_id'], 'ip' => client_ip()]);
    });
    return ['ok' => true];
});

// POPIA: access to personal information.
route('GET', '/api/auth/me/export', function () {
    $u = require_auth();
    limit('export', 5, 3600, $u['id']);
    $id = $u['id'];
    $data = [
        'exportedAt' => now_iso(), 'operator' => 'TicketRoom',
        'profile' => row('SELECT id, email, full_name, phone, email_verified_at, created_at FROM users WHERE id = ?', [$id]),
        'orders' => rows('SELECT reference, status, total_cents, buyer_name, buyer_email, buyer_phone, created_at, paid_at FROM orders WHERE user_id = ?', [$id]),
        'tickets' => rows('SELECT code, status, holder_name, admitted_at, created_at FROM tickets WHERE owner_user_id = ?', [$id]),
        'marketingConsents' => rows('SELECT organiser_id, channel, granted, source, updated_at FROM marketing_consents WHERE user_id = ?', [$id]),
        'supportCases' => rows('SELECT reference, subject, status, created_at FROM support_cases WHERE user_id = ?', [$id]),
    ];
    return new Response($data, 200, ['Content-Disposition' => 'attachment; filename=ticketroom-my-data.json']);
});

// POPIA: deletion. Personal details go; order records stay de-identified.
route('POST', '/api/auth/me/delete', function () {
    $u = require_auth();
    $b = check(body(), ['password' => R::str(['max' => 200])]);
    if (!verify_secret($b['password'], val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Password is incorrect.');
    tx(function () use ($u) {
        if (val("SELECT 1 FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.owner_user_id = ? AND t.status = 'valid' AND e.ends_at > ? LIMIT 1", [$u['id'], now_iso()])) {
            throw conflict('You have tickets for upcoming events. Transfer or use them before deleting your account.', 'has_live_tickets');
        }
        $now = now_iso();
        q("UPDATE users SET email = 'deleted+' || id || '@invalid.ticketroom', full_name = 'Deleted user', phone = NULL, status = 'deleted', password_hash = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?", [$now, $now, $u['id']]);
        q("UPDATE orders SET buyer_name = 'Deleted user', buyer_email = 'deleted@invalid.ticketroom', buyer_phone = NULL WHERE user_id = ?", [$u['id']]);
        q('UPDATE tickets SET holder_name = NULL WHERE owner_user_id = ?', [$u['id']]);
        q('UPDATE marketing_consents SET granted = 0, updated_at = ? WHERE user_id = ?', [$now, $u['id']]);
        q('UPDATE sessions SET revoked_at = ? WHERE user_id = ?', [$now, $u['id']]);
        q("UPDATE message_outbox SET status = 'suppressed' WHERE user_id = ? AND status = 'queued'", [$u['id']]);
        audit('user.deleted', ['entityType' => 'user', 'entityId' => $u['id']]);
    });
    clear_session_cookie();
    return ['ok' => true];
});

route('POST', '/api/auth/me/consents/unsubscribe-all', function () {
    $u = require_auth();
    tx(function () use ($u) {
        foreach (rows('SELECT organiser_id, channel FROM marketing_consents WHERE user_id = ? AND granted = 1', [$u['id']]) as $x) set_consent($u['id'], $x['organiser_id'], $x['channel'], false, 'account_unsubscribe_all');
    });
    return ['consents' => consents_for($u['id'])];
});
route('GET', '/api/auth/me/consents', fn() => ['consents' => consents_for(require_auth()['id'])]);
route('PUT', '/api/auth/me/consents', function () {
    $u = require_auth();
    $b = check(body(), ['organiserId' => R::uuid(['optional' => true]), 'channel' => R::oneOf(['email', 'sms']), 'granted' => R::bool()]);
    tx(fn() => set_consent($u['id'], $b['organiserId'] ?? null, $b['channel'], $b['granted'], 'account_settings'));
    return ['consents' => consents_for($u['id'])];
});
