<?php
// /api/health, /api/config and /api/auth/* — accounts, sessions, POPIA rights.
declare(strict_types=1);

// For uptime monitors: "ok" means the site and its database answer;
// "healthy" also means the background jobs ran on time, email is not backed
// up and a recent backup exists. Counts and times only, nothing private.
route('GET', '/api/health', function () {
    val('SELECT 1');
    $s = ops_status();
    return ['ok' => true, 'healthy' => !ops_problems($s), 'service' => 'ticketroom', 'edition' => 'php', 'version' => TR_VERSION, 'provider' => pay_provider()] + $s;
});
route('GET', '/api/config', fn() => [
    'operator' => 'TicketRoom', 'edition' => 'php', 'provider' => pay_provider(), 'simulatedPayments' => false, 'cardPaymentsEnabled' => pay_ready(), 'paymentsTest' => pay_ready() && pay_test(), 'googleSignIn' => google_ready(), 'titopayWallet' => false,
    // Cashless (event wallets, wristbands and the vendor till) switches on
    // with card payments, because top-ups are card payments. Each event then
    // opts in with its own "cashless event" setting. tagRegistry: organisers
    // register their own wristbands (this edition's organiser portal).
    'features' => ['payments' => pay_ready(), 'cashless' => cashless_ready(), 'pos' => cashless_ready(), 'finance' => true, 'sms' => sms_ready(), 'tags' => cashless_ready(), 'tagRegistry' => cashless_ready(), 'cashDesk' => cashless_ready(), 'promote' => true,
        'walletApple' => wallet_apple_ready(), 'walletGoogle' => wallet_google_ready()],
    'messaging' => ['email' => mail_mode(), 'sms' => sms_provider()],
    'cashless' => cashless_limits(),
    'fees' => settings_all()['fees'] ?? cfg('fees'), 'holdMinutes' => HOLD_MINUTES, 'promote' => ['priceCents' => promo_price()],
]);

// Someone signs up with an email that has only bought as a guest. The
// password is chosen from a link sent to that inbox, never typed into the
// sign-up form, so nobody can pick a password for someone else's tickets.
function send_finish_account(array $u, ?string $context = null): void
{
    $token = random_token(32);
    // Keep only the newest account-activation link usable. A forwarded or
    // otherwise exposed older email must not remain a second valid credential.
    q('UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND used_at IS NULL', [now_iso(), $u['id']]);
    insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $u['id'], 'expires_at' => iso_in(86400), 'created_at' => now_iso()]);
    $returnContext = $context === 'retail' ? '?context=retail' : '';
    $url = $context === 'retail' ? base_url() . "/retail#/reset/$token$returnContext" : portal_link($u, "reset/$token");
    outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('finishAccount', ['name' => $u['full_name'], 'url' => $url]));
}
function send_verification(array $u, ?string $context = null): void
{
    $claims = ['v' => $u['id'], 'e' => $u['email']];
    if ($context === 'retail') $claims['c'] = 'retail';
    $token = sign_link($claims, 7 * 86400);
    $url = $context === 'retail' ? base_url() . "/retail#/verify/$token" : portal_link($u, "verify/$token");
    outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('verifyEmail', ['name' => $u['full_name'], 'url' => $url]));
}

// Someone tried to sign up with an email that already has an account. The
// sign-up form answers exactly as for a new account (so it never says who
// has one); the owner of the email gets a note instead.
function send_account_exists(array $u): void
{
    if (!limit_ok('existsend', 3, 3600, $u['id'])) return;
    outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('accountExists', ['name' => $u['full_name'], 'url' => base_url() . ACCOUNT_PORTALS[account_type($u)]]));
}

// Sign-up. Every account confirms its email before it can sign in, and one
// email (or mobile number) belongs to one account. Someone who bought as a
// guest signs up with the same email: once they confirm it, the guest
// account becomes theirs, with every ticket already in it.
route('POST', '/api/auth/register', function () {
    limit('register', 60, 3600);
    $b = check(body(), ['fullName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(), 'phone' => R::phone(['optional' => true]),
        'password' => R::password(), 'marketingOptIn' => R::bool(), 'acceptTerms' => R::bool(), 'context' => R::oneOf(['retail'], ['optional' => true])]);
    if (!$b['acceptTerms']) throw bad('Please accept the Terms and Privacy Notice.', ['acceptTerms' => 'Required.']);
    $taken = tx(function () use ($b) {
        $now = now_iso();
        $existing = user_by_email($b['email']);
        // Customer sign-up makes customer accounts only; any other account on
        // this email (organiser or staff) means the email is taken. The
        // answer looks the same; the email's owner is told.
        if ($existing && ((int) $existing['guest'] !== 1 || account_type($existing) !== 'customer')) {
            if ($existing['status'] === 'active') send_account_exists($existing);
            return true;
        }
        if (!empty($b['phone']) && val("SELECT 1 FROM users WHERE phone = ? AND status = 'active' AND guest = 0 AND id <> ?", [$b['phone'], $existing['id'] ?? ''])) {
            throw conflict('This mobile number is already on another TicketRoom account. Sign in to that account, or leave the number out.', 'phone_taken', ['phone' => 'Already on another account.']);
        }
        if ($existing) {
            // A guest's account: they choose the password from their inbox.
            $u = $existing;
            if (limit_ok('finishsend', 3, 3600, $u['id'])) send_finish_account($u, $b['context'] ?? null);
        } else {
            $u = insert('users', ['id' => uuid(), 'email' => $b['email'], 'email_key' => email_key($b['email']), 'phone' => $b['phone'] ?? null, 'full_name' => $b['fullName'],
                'password_hash' => hash_secret($b['password']), 'status' => 'active', 'account_type' => 'customer', 'created_at' => $now, 'updated_at' => $now]);
            send_verification($u, $b['context'] ?? null);
        }
        if ($b['marketingOptIn']) set_consent($u['id'], null, 'email', true, 'signup');
        audit('user.registered', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip(), 'details' => ['fromGuest' => (bool) $existing]]);
        return false;
    });
    if ($taken) audit('user.signup_existing_email', ['actor' => null, 'actorRole' => 'system', 'entityType' => 'user', 'ip' => client_ip()]);
    return json_out(['needsVerification' => true, 'email' => $b['email'],
        'message' => "We've sent a confirmation link to {$b['email']}. Open it to finish creating your account."], 201);
});

route('POST', '/api/auth/login', function () {
    limit('login', 120, 900);
    $b = check(body(), ['email' => R::email(), 'password' => R::str(['min' => 1, 'max' => 200]), 'portal' => R::oneOf(array_keys(PORTAL_ACCEPTS), ['optional' => true]), 'context' => R::oneOf(['retail'], ['optional' => true])]);
    $portal = $b['portal'] ?? 'site';
    $u = row("SELECT * FROM users WHERE lower(email) = ? AND status <> 'deleted'", [$b['email']]) ?? user_by_email($b['email']);
    // Compare against a real hash even for unknown emails, so timing does not reveal accounts.
    $ok = verify_secret($b['password'], $u['password_hash'] ?? '$2y$10$WPT59Gnb/QYXeEjTyv1sp.pD4KgnvD5SRlQY9iG6ybrv4y.LW5AXy') && $u;
    // The same answer for an unknown email, a wrong password and a locked
    // account, so the sign-in box never reveals who has an account.
    // The staff sign-in says "access denied" and nothing more, for an unknown
    // email, a wrong password and a customer or organiser account alike.
    $generic = $portal === 'admin'
        ? new AppError(401, 'bad_credentials', 'Access denied. This sign-in is for TicketRoom staff only. Check your email and password, or ask the platform owner for a new password link.')
        : new AppError(401, 'bad_credentials', 'Email or password is incorrect. After several tries, wait 15 minutes or use "Forgot password?".');
    if (!$u || $u['status'] === 'deleted') throw $generic;
    // 5 wrong passwords per email from one connection every 15 minutes. After
    // 30 wrong passwords from anywhere the account is "under attack" for 15
    // minutes: each connection then gets one try in that time, so guessing
    // slows right down, but the owner (whose own connection has not been
    // guessing) can still sign in. Nobody can lock someone else out.
    // Signing in correctly never counts, so several devices are fine.
    $pair = $b['email'] . '|' . client_ip();
    $locked = $u['locked_until'] && to_unix($u['locked_until']) > microtime(true);
    if (limit_reached('loginpair', $locked ? 1 : 5, $pair)) throw too_many();
    if ($u['locked_until'] && !$locked) { q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [$u['id']]); $u['failed_logins'] = 0; }
    if (!$ok) {
        limit_ok('loginpair', 5, 900, $pair);
        q('UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN failed_logins + 1 >= 30 THEN ? END WHERE id = ?', [iso_in(900), $u['id']]);
        throw $generic;
    }
    if ($u['status'] === 'suspended') throw new AppError(403, 'suspended', 'This account is suspended. Use the contact form at /contact and include your account email.');
    // Maintenance: only TicketRoom staff can sign in until it is over, and
    // gate staff on the scanner or till, so an event that is on keeps going.
    if (account_type($u) !== 'staff' && !in_array($portal, ['scanner', 'pos'], true) && settings_all()['maintenance']['enabled']) {
        throw new AppError(503, 'maintenance', settings_all()['maintenance']['message']);
    }
    // One account, one portal. The admin sign-in never says what kind of
    // account an email has; staff accounts never sign in anywhere else.
    $type = account_type($u);
    if (!in_array($type, PORTAL_ACCEPTS[$portal], true)) {
        if ($portal === 'admin' || $type === 'staff') throw $generic;
        $where = ['customer' => 'the customer portal', 'organiser' => 'the organiser portal'][$type];
        throw new AppError(403, 'wrong_portal', ($type === 'organiser' ? 'This is an organiser account.' : 'This is a customer account.') . " Sign in on {$where}.", ['portal' => ACCOUNT_PORTALS[$type]]);
    }
    // Right password, email not confirmed yet: send a fresh link (a few per hour at most).
    if (!$u['email_verified_at']) {
        if (limit_ok('verifysend', 3, 3600, $u['id'])) send_verification($u, $b['context'] ?? null);
        throw new AppError(403, 'email_not_verified', "Please confirm your email first. We've sent a link to {$u['email']}: open it and you're in.");
    }
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) q('UPDATE users SET password_hash = ? WHERE id = ?', [hash_secret($b['password']), $u['id']]);
    q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [$u['id']]);
    limit_clear('loginpair', $pair);
    if ($type === 'staff') {
        // Password alone never creates a staff session: issue a short-lived,
        // one-use code to the verified address on the staff account.
        limit('staff-code-send', 5, 3600, $u['id']);
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $challenge = random_token(32);
        tx(function () use ($u, $code, $challenge) {
            q('INSERT INTO staff_login_codes (user_id, challenge_hash, code_hash, attempts, expires_at, created_at) VALUES (?,?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET challenge_hash = excluded.challenge_hash, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at',
                [$u['id'], sha256($challenge), hash_secret($code), iso_in(600), now_iso()]);
            outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('staffLoginCode', ['name' => $u['full_name'], 'code' => $code]));
            audit('security.staff_login_code_sent', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        });
        return ['mfaRequired' => true, 'mfaType' => 'staff', 'challenge' => $challenge, 'expiresIn' => 600];
    }
    if ((int) ($u['email_otp_enabled'] ?? 0) === 1) {
        limit('user-login-code-send', 5, 3600, $u['id']);
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $challenge = random_token(32);
        tx(function () use ($u, $code, $challenge, $portal) {
            q('INSERT INTO user_login_codes (user_id, challenge_hash, code_hash, portal, attempts, expires_at, created_at) VALUES (?,?,?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET challenge_hash = excluded.challenge_hash, code_hash = excluded.code_hash, portal = excluded.portal, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at',
                [$u['id'], sha256($challenge), hash_secret($code), $portal, iso_in(600), now_iso()]);
            outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('loginCode', ['name' => $u['full_name'], 'code' => $code]));
            audit('security.user_login_code_sent', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        });
        return ['mfaRequired' => true, 'mfaType' => 'email', 'challenge' => $challenge, 'expiresIn' => 600];
    }
    create_session($u['id']);
    return ['user' => profile($u['id'])];
});

route('POST', '/api/auth/login-code/verify', function () {
    limit('user-login-code-verify-ip', 20, 900);
    $b = check(body(), ['challenge' => R::str(['min' => 40, 'max' => 100]), 'code' => R::str(['min' => 6, 'max' => 6, 'pattern' => '/^[0-9]{6}$/'])]);
    $result = tx(function () use ($b) {
        $c = row('SELECT * FROM user_login_codes WHERE challenge_hash = ?', [sha256($b['challenge'])]);
        if (!$c) return 'invalid';
        if (to_unix($c['expires_at']) < microtime(true)) { q('DELETE FROM user_login_codes WHERE user_id = ?', [$c['user_id']]); return 'expired'; }
        if ((int) $c['attempts'] >= 5) return 'locked';
        if (!verify_secret($b['code'], $c['code_hash'])) {
            q('UPDATE user_login_codes SET attempts = attempts + 1 WHERE user_id = ?', [$c['user_id']]);
            audit('security.user_login_code_rejected', ['entityType' => 'user', 'entityId' => $c['user_id'], 'ip' => client_ip()]);
            return 'wrong';
        }
        $u = row("SELECT * FROM users WHERE id = ? AND status = 'active' AND email_verified_at IS NOT NULL AND email_otp_enabled = 1 AND account_type IN ('customer','organiser')", [$c['user_id']]);
        q('DELETE FROM user_login_codes WHERE user_id = ?', [$c['user_id']]);
        if (!$u || !isset(PORTAL_ACCEPTS[$c['portal']])) return 'invalid';
        if (!in_array($u['account_type'], PORTAL_ACCEPTS[$c['portal']], true)) return 'invalid';
        audit('security.user_login_otp_verified', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        return $u['id'];
    });
    if ($result === 'expired') throw bad('That sign-in code expired. Sign in again to get a new one.');
    if ($result === 'locked') throw too_many();
    if ($result === 'wrong') throw bad('That sign-in code is not right. Check your email and try again.');
    if ($result === 'invalid') throw new AppError(401, 'bad_credentials', 'That sign-in request is no longer valid. Sign in again.');
    create_session($result);
    return ['user' => profile($result)];
});

route('POST', '/api/auth/staff-code/verify', function () {
    limit('staff-code-verify-ip', 20, 900);
    $b = check(body(), ['challenge' => R::str(['min' => 40, 'max' => 100]), 'code' => R::str(['min' => 6, 'max' => 6, 'pattern' => '/^[0-9]{6}$/'])]);
    $result = tx(function () use ($b) {
        $c = row('SELECT * FROM staff_login_codes WHERE challenge_hash = ?', [sha256($b['challenge'])]);
        if (!$c) return 'invalid';
        if (to_unix($c['expires_at']) < microtime(true)) { q('DELETE FROM staff_login_codes WHERE user_id = ?', [$c['user_id']]); return 'expired'; }
        if ((int) $c['attempts'] >= 5) return 'locked';
        if (!verify_secret($b['code'], $c['code_hash'])) {
            q('UPDATE staff_login_codes SET attempts = attempts + 1 WHERE user_id = ?', [$c['user_id']]);
            audit('security.staff_login_code_rejected', ['entityType' => 'user', 'entityId' => $c['user_id'], 'ip' => client_ip()]);
            return 'wrong';
        }
        $u = row("SELECT * FROM users WHERE id = ? AND status = 'active' AND account_type = 'staff' AND EXISTS (SELECT 1 FROM platform_roles r WHERE r.user_id = users.id)", [$c['user_id']]);
        q('DELETE FROM staff_login_codes WHERE user_id = ?', [$c['user_id']]);
        if (!$u) return 'invalid';
        audit('security.staff_login_otp_verified', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        return $u['id'];
    });
    if ($result === 'expired') throw bad('That sign-in code expired. Sign in again to get a new one.');
    if ($result === 'locked') throw too_many();
    if ($result === 'wrong') throw bad('That sign-in code is not right. Check your email and try again.');
    if ($result === 'invalid') throw new AppError(401, 'bad_credentials', 'That sign-in request is no longer valid. Sign in again.');
    create_session($result);
    return ['user' => profile($result)];
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
    // A new number needs confirming again.
    q('UPDATE users SET full_name = ?, phone = ?, phone_verified_at = CASE WHEN phone IS ? THEN phone_verified_at END, updated_at = ? WHERE id = ?',
        [$b['fullName'], $b['phone'] ?? null, $b['phone'] ?? null, now_iso(), $u['id']]);
    return ['user' => profile($u['id'])];
});

route('PUT', '/api/auth/me/email-otp', function () {
    $u = require_auth();
    if (!in_array($u['accountType'], ['customer', 'organiser'], true)) throw forbidden();
    limit('email-otp-setting', 10, 900, $u['id']);
    $b = check(body(), ['enabled' => R::bool(), 'password' => R::str(['min' => 1, 'max' => 200])]);
    if (!verify_secret($b['password'], val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.');
    if ($b['enabled'] && !val('SELECT email_verified_at FROM users WHERE id = ?', [$u['id']])) throw conflict('Confirm your email address before enabling email sign-in codes.', 'email_not_verified');
    q('UPDATE users SET email_otp_enabled = ?, updated_at = ? WHERE id = ?', [$b['enabled'] ? 1 : 0, now_iso(), $u['id']]);
    if (!$b['enabled']) q('DELETE FROM user_login_codes WHERE user_id = ?', [$u['id']]);
    audit('security.email_otp_setting_changed', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip(), 'details' => ['enabled' => $b['enabled']]]);
    return ['enabled' => $b['enabled']];
});

// Confirm a mobile number: a 6-digit code by SMS, valid 10 minutes, 5 tries.
route('POST', '/api/auth/phone/send', function () {
    $u = require_auth();
    $b = check(body(), ['phone' => R::phone()]);
    if (!sms_ready()) throw conflict('Phone confirmation needs SMS, which is not set up yet. Nothing is held up by this.', 'sms_off');
    limit('phonesend', 5, 3600, $u['id']);
    limit('phonesendto', 3, 3600, $b['phone']);
    if (val("SELECT 1 FROM users WHERE phone = ? AND phone_verified_at IS NOT NULL AND status = 'active' AND id <> ?", [$b['phone'], $u['id']])) {
        throw conflict('This mobile number is already confirmed on another TicketRoom account.', 'phone_taken', ['phone' => 'Already confirmed on another account.']);
    }
    $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    q('INSERT INTO phone_codes (user_id, phone, code_hash, attempts, expires_at, created_at) VALUES (?,?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET phone = excluded.phone, code_hash = excluded.code_hash, attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at',
        [$u['id'], $b['phone'], hash_secret($code), iso_in(600), now_iso()]);
    try { sms_send($b['phone'], "Your TicketRoom code is $code. It expires in 10 minutes. Never share it."); }
    catch (Throwable $e) { error_log('[phone] send: ' . integration_scrub($e->getMessage())); throw new AppError(502, 'sms_failed', 'We could not send the SMS just now. Please try again in a minute.'); }
    audit('user.phone_code_sent', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
    return ['sent' => true, 'sentTo' => substr($b['phone'], 0, 5) . str_repeat('•', 4) . substr($b['phone'], -3)];
});
route('POST', '/api/auth/phone/verify', function () {
    $u = require_auth();
    $b = check(body(), ['code' => R::str(['min' => 4, 'max' => 10])]);
    $c = row('SELECT * FROM phone_codes WHERE user_id = ?', [$u['id']]);
    if (!$c || to_unix($c['expires_at']) < microtime(true)) throw bad('That code has expired. Send a new one.', ['code' => 'Expired.']);
    if ((int) $c['attempts'] >= 5) throw bad('Too many wrong codes. Send a new one.', ['code' => 'Too many tries.']);
    if (!verify_secret(preg_replace('/\D/', '', $b['code']), $c['code_hash'])) {
        q('UPDATE phone_codes SET attempts = attempts + 1 WHERE user_id = ?', [$u['id']]);
        throw bad('That code is not right. Check the SMS and try again.', ['code' => 'Incorrect.']);
    }
    $now = now_iso();
    tx(function () use ($u, $c, $now) {
        q('UPDATE users SET phone = ?, phone_verified_at = ?, updated_at = ? WHERE id = ?', [$c['phone'], $now, $now, $u['id']]);
        q('DELETE FROM phone_codes WHERE user_id = ?', [$u['id']]);
    });
    audit('user.phone_verified', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
    return ['user' => profile($u['id'])];
});

route('POST', '/api/auth/me/password', function () {
    $u = require_auth();
    limit('pwchange', 10, 900, $u['id']);
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'newPassword' => R::password()]);
    if (!verify_secret($b['currentPassword'], val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Current password is incorrect.');
    q('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash_secret($b['newPassword']), now_iso(), $u['id']]);
    q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [now_iso(), $u['id'], session()['id']]);
    q('DELETE FROM user_login_codes WHERE user_id = ?', [$u['id']]);
    q('DELETE FROM meta WHERE key = ?', ["temp_password:{$u['id']}"]);
    audit('user.password_changed', ['entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
    return ['ok' => true];
});

// Spending PIN for cashless purchases at or above the PIN threshold. Stored
// only as a password hash; five wrong tries at a till lock it for 15 minutes.
route('POST', '/api/auth/me/pin', function () {
    $u = require_auth();
    limit('pin', 10, 900, $u['id']);
    $b = check(body(), ['pin' => R::str(['min' => 4, 'max' => 6, 'pattern' => '/^\d{4,6}$/', 'message' => 'Use 4 to 6 digits.']), 'password' => R::str(['max' => 200])]);
    pin_set($u, $b['pin'], $b['password']);
    return ['ok' => true];
});

// The link in the confirmation email. The first time it is used it confirms
// the address and signs the person in (proof enough: only the inbox's owner
// has the link); a guest account becomes a full one, tickets and all.
route('POST', '/api/auth/verify-email', function () {
    limit('verifylink', 30, 3600);
    $b = check(body(), ['token' => R::str(['max' => 600])]);
    $d = verify_link($b['token']);
    if (!$d || empty($d['v'])) throw bad('This confirmation link is invalid or has expired.');
    $r = tx(function () use ($d) {
        $u = row("SELECT * FROM users WHERE id = ? AND lower(email) = lower(?) AND status = 'active'", [$d['v'], $d['e'] ?? '']);
        if (!$u) throw bad('This confirmation link is invalid or has expired.');
        // A guest account has no password yet: it is finished from the
        // choose-a-password email, never from a confirmation link.
        if ((int) $u['guest'] === 1) return ['user' => $u, 'guest' => true];
        if ($u['email_verified_at']) return ['user' => $u, 'first' => false];
        $now = now_iso();
        q('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?', [$now, $now, $u['id']]);
        audit('user.email_verified', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        return ['user' => $u, 'first' => true];
    });
    if (!empty($r['guest'])) {
        if (limit_ok('finishsend', 3, 3600, $r['user']['id'])) tx(fn() => send_finish_account($r['user']));
        throw bad("This link has been replaced. We've emailed {$r['user']['email']} a link to choose your password: open the newest email from us.");
    }
    if ($r['first'] && account_type($r['user']) !== 'staff') create_session($r['user']['id']);
    $tickets = (int) val("SELECT count(*) FROM tickets WHERE owner_user_id = ? AND status = 'valid'", [$r['user']['id']]);
    $organiser = account_type($r['user']) === 'organiser';
    return ['ok' => true, 'signedIn' => $r['first'] && account_type($r['user']) !== 'staff', 'accountType' => account_type($r['user']), 'firstName' => explode(' ', trim($r['user']['full_name']))[0], 'tickets' => $tickets, 'organiser' => $organiser,
        'context' => ($d['c'] ?? null) === 'retail' ? 'retail' : null];
});

// "Didn't get the email?" Same answer whether or not the address has an account.
route('POST', '/api/auth/verify-email/resend', function () {
    // Many phones share one address (mobile networks, venue Wi-Fi): a roomy
    // limit per address, the tight one per account (verifysend below).
    limit('verifyresend', 60, 3600);
    $b = check(body(), ['email' => R::email(['optional' => true]), 'context' => R::oneOf(['retail'], ['optional' => true])]);
    $u = user() ? row('SELECT * FROM users WHERE id = ?', [user()['id']]) : (isset($b['email']) ? user_by_email($b['email']) : null);
    if ($u && $u['status'] === 'active' && account_type($u) !== 'staff' && (!$u['email_verified_at'] || (int) $u['guest'] === 1) && limit_ok('verifysend', 3, 3600, $u['id'])) {
        (int) $u['guest'] === 1 ? send_finish_account($u, $b['context'] ?? null) : send_verification($u, $b['context'] ?? null);
    }
    return ['ok' => true, 'message' => 'If that email is waiting to be confirmed, a new link is on its way.'];
});

route('POST', '/api/auth/password/forgot', function () {
    // A roomy limit per connection (many phones share one address) and a
    // quiet one per email, so nobody can flood one inbox.
    limit('forgot', 60, 3600);
    $b = check(body(), ['email' => R::email()]);
    $u = user_by_email($b['email']);
    // Staff passwords are reset by the platform owner from the admin portal,
    // never by email from the public sign-in. The answer is the same, so it
    // reveals nothing about which emails are staff.
    if ($u && $u['status'] === 'active' && account_type($u) !== 'staff' && limit_ok('forgotmail', 5, 3600, email_key($b['email']))) {
        $token = random_token(32);
        tx(function () use ($u, $token) {
            // A newly issued reset supersedes any older link for this account.
            q('UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND used_at IS NULL', [now_iso(), $u['id']]);
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $u['id'], 'expires_at' => iso_in(3600), 'created_at' => now_iso()]);
            outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('passwordReset', ['name' => $u['full_name'], 'url' => portal_link($u, "reset/$token")]));
        });
    }
    return ['ok' => true, 'message' => 'If that email has an account, a reset link is on its way.'];
});

route('POST', '/api/auth/password/reset', function () {
    limit('reset', 10, 3600);
    $b = check(body(), ['token' => R::str(['max' => 100]), 'password' => R::password(), 'context' => R::oneOf(['retail'], ['optional' => true])]);
    $uid = tx(function () use ($b) {
        $r = row('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [sha256($b['token']), now_iso()]);
        if (!$r) throw bad('This reset link is invalid or has expired.');
        $now = now_iso();
        q('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', [$now, sha256($b['token'])]);
        // Invalidate any other outstanding recovery or account-activation
        // link. Keep records for auditability; only their usability changes.
        q('UPDATE password_resets SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND used_at IS NULL', [$now, $r['user_id']]);
        // A staff invite doubles as email proof, so mark the address verified.
        // A reset link proves the inbox too: the email is confirmed, and a guest account becomes a full one.
        q('UPDATE users SET password_hash = ?, guest = 0, failed_logins = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?', [hash_secret($b['password']), $now, $now, $r['user_id']]);
        q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [$now, $r['user_id']]);
        q('DELETE FROM staff_login_codes WHERE user_id = ?', [$r['user_id']]);
        q('DELETE FROM user_login_codes WHERE user_id = ?', [$r['user_id']]);
        q('DELETE FROM meta WHERE key = ?', ["temp_password:{$r['user_id']}"]);
        audit('user.password_reset', ['actor' => ['id' => $r['user_id']], 'entityType' => 'user', 'entityId' => $r['user_id'], 'ip' => client_ip()]);
        return $r['user_id'];
    });
    // Staff always complete the separate one-time email-code login step; a
    // password-reset link alone must not mint a privileged session.
    $active = val("SELECT status FROM users WHERE id = ?", [$uid]) === 'active';
    $tickets = (int) val("SELECT count(*) FROM tickets WHERE owner_user_id = ? AND status = 'valid'", [$uid]);
    $account = row('SELECT account_type, email_otp_enabled FROM users WHERE id = ?', [$uid]);
    $type = (string) $account['account_type'];
    $needsOtp = $type === 'staff' || ((int) $account['email_otp_enabled'] === 1 && in_array($type, ['customer', 'organiser'], true));
    if ($active && !$needsOtp) create_session($uid);
    return ['ok' => true, 'signedIn' => $active && !$needsOtp, 'needsEmailOtp' => $active && $needsOtp && $type !== 'staff', 'tickets' => $tickets, 'accountType' => $type, 'staff' => $type === 'staff', 'organiser' => $type === 'organiser',
        'context' => ($b['context'] ?? null) === 'retail' ? 'retail' : null];
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

// POPIA: account deletion is a reviewed support request. Keep the account and
// its records intact until TicketRoom has checked tickets, balances,
// organisation ownership and any legal or financial retention duties.
function auth_account_deletion_request(bool $requireConfirmation): array
{
    $u = require_auth();
    $type = account_type($u);
    if (!in_array($type, ['customer', 'organiser'], true)) throw forbidden('Staff account requests are handled by an administrator.');
    $b = check(body(), ['password' => R::str(['max' => 200]), 'confirmRequest' => R::bool(['optional' => true, 'fallback' => false])]);
    if ($requireConfirmation && !$b['confirmRequest']) throw bad('Confirm that you understand this request does not immediately delete your account.');
    limit('account-deletion-password', 10, 900, $u['id']);
    if (!verify_secret($b['password'], val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Password is incorrect.');
    return tx(function () use ($u, $type) {
        // Make retries safe: one open deletion request per account, even if a
        // user double-clicks or loses the response after the case is saved.
        $existing = row("SELECT reference FROM support_cases WHERE user_id = ? AND source = 'account_deletion' AND status IN ('open','in_progress') ORDER BY created_at DESC LIMIT 1", [$u['id']]);
        if ($existing) return ['reference' => $existing['reference'], 'status' => 'open', 'alreadySubmitted' => true];

        limit('account-deletion-request', 3, 86400, $u['id']);
        $settings = settings_all();
        $now = now_iso();
        $caseId = uuid();
        $ref = reference('CQ');
        $subject = 'Account deletion request';
        $review = "Requested action: review deletion of this {$type} TicketRoom account and personal information where legally permitted.\n\n"
            . "This request does not authorise immediate deletion. Please check upcoming tickets, unused balances, organiser ownership and event obligations, payment and accounting records, and any information TicketRoom is required to retain.\n\n"
            . "The account remains active until the request is reviewed and any next steps are confirmed with the account holder.";
        insert('support_cases', ['id' => $caseId, 'reference' => $ref, 'user_id' => $u['id'], 'email' => $u['email'], 'category' => 'account',
            'subject' => $subject, 'body' => $review, 'status' => 'open', 'full_name' => $u['fullName'], 'phone' => $u['phone'] ?? null,
            'source' => 'account_deletion', 'due_at' => iso_in(48 * 3600), 'created_at' => $now, 'updated_at' => $now]);
        outbox_enqueue(['to' => $settings['support']['email'], 'subject' => "[TicketRoom] $ref Account deletion request",
            'body' => "Account deletion request $ref\n\nAccount: {$u['fullName']} <{$u['email']}>\nAccount type: $type\n\n$review\n\nReview this case in Admin portal → Support."]);
        outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('accountDeletionReceived', ['name' => $u['fullName'], 'reference' => $ref,
            'responseTime' => $settings['support']['responseTime']]));
        audit('user.deletion_requested', ['actor' => $u, 'entityType' => 'user', 'entityId' => $u['id'], 'details' => ['reference' => $ref, 'accountType' => $type]]);
        return ['reference' => $ref, 'status' => 'open', 'alreadySubmitted' => false];
    });
}
route('POST', '/api/auth/me/deletion-request', fn() => auth_account_deletion_request(true));
// Keep older clients safe during rollout: the previous "delete" endpoint is
// now a password-confirmed request and never performs immediate erasure.
route('POST', '/api/auth/me/delete', fn() => auth_account_deletion_request(false));

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
