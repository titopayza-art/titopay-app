<?php
// /api/me/* — tickets, QR codes, transfers, orders, support. Wristbands and
// cashless wallets are in routes/cashless.php; linked payment methods
// (TitoPay wallet) are not available in this edition.
declare(strict_types=1);

route('GET', '/api/me/tickets', fn() => ['tickets' => tickets_for_user(require_auth()['id'])]);

route('GET', '/api/me/tickets/:id/qr.svg', function ($a) {
    $t = owned_ticket(require_auth()['id'], $a['id']);
    return raw_out(tr_qr_svg(qr_payload($t), ['ecc' => 'M', 'margin' => 1, 'dark' => '#0B1A33', 'light' => '#FFFFFF']), 'image/svg+xml', 200, ['Cache-Control' => 'no-store']);
});

route('PATCH', '/api/me/tickets/:id', function ($a) {
    $u = require_auth();
    $b = check(body(), ['holderName' => R::str(['min' => 2, 'max' => 120])]);
    $t = owned_ticket($u['id'], $a['id']);
    if ($t['status'] !== 'valid') throw conflict('Only valid tickets can be renamed.');
    q('UPDATE tickets SET holder_name = ?, updated_at = ? WHERE id = ?', [$b['holderName'], now_iso(), $t['id']]);
    return ['ok' => true];
});

route('POST', '/api/me/tickets/:id/transfer', function ($a) {
    $u = require_auth();
    limit('transfer', 20, 3600, $u['id']);
    $b = check(body(), ['toEmail' => R::email()]);
    return json_out(['transfer' => start_transfer($u, $a['id'], $b['toEmail'])], 201);
});

route('GET', '/api/me/transfers', function () {
    $u = require_auth();
    $outgoing = rows('SELECT tr.id, tr.to_email, tr.status, tr.created_at, tr.expires_at, tr.completed_at, e.title FROM ticket_transfers tr
                        JOIN tickets t ON t.id = tr.ticket_id JOIN events e ON e.id = t.event_id WHERE tr.from_user_id = ? ORDER BY tr.created_at DESC LIMIT 50', [$u['id']]);
    $incoming = $u['emailVerified'] ? rows("SELECT tr.id, tr.status, tr.created_at, tr.expires_at, e.title, u.full_name AS from_name FROM ticket_transfers tr
                        JOIN tickets t ON t.id = tr.ticket_id JOIN events e ON e.id = t.event_id JOIN users u ON u.id = tr.from_user_id
                       WHERE lower(tr.to_email) = lower(?) AND tr.status = 'pending' AND tr.expires_at > ?", [$u['email'], now_iso()]) : [];
    return ['outgoing' => $outgoing, 'incoming' => $incoming, 'emailVerified' => $u['emailVerified']];
});

route('POST', '/api/me/transfers/:id/cancel', function ($a) {
    $u = require_auth();
    if (affected("UPDATE ticket_transfers SET status = 'cancelled', completed_at = ? WHERE id = ? AND from_user_id = ? AND status = 'pending'", [now_iso(), $a['id'], $u['id']]) === 0) throw not_found('Transfer not found.');
    audit('ticket.transfer_cancelled', ['entityType' => 'ticket_transfer', 'entityId' => $a['id']]);
    return ['ok' => true];
});

route('POST', '/api/me/transfers/claim', function () {
    $u = require_auth();
    limit('claim', 20, 3600, $u['id']);
    $b = check(body(), ['token' => R::str(['optional' => true, 'max' => 100]), 'transferId' => R::uuid(['optional' => true])]);
    if (!empty($b['transferId'])) {
        q("UPDATE ticket_transfers SET to_user_id = ? WHERE id = ? AND lower(to_email) = lower(?) AND status = 'pending'", [$u['id'], $b['transferId'], $u['email']]);
    }
    return claim_transfer($u, $b['token'] ?? null, $b['transferId'] ?? null);
});

route('GET', '/api/me/orders', fn() => ['orders' => rows('SELECT o.reference, o.status, o.total_cents, o.refunded_cents, o.created_at, o.paid_at, e.title, e.slug, e.starts_at
    FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 100', [require_auth()['id']])]);

route('GET', '/api/me/support', fn() => ['cases' => rows('SELECT reference, category, subject, status, resolution, created_at, updated_at FROM support_cases WHERE user_id = ? ORDER BY created_at DESC', [require_auth()['id']])]);

// Not in this edition: answer consistently so pages can show "coming soon".
route('GET', '/api/me/payment-methods', function () { require_auth(); return ['links' => [], 'titopayAvailable' => false, 'titopayEnvironment' => null]; });
foreach (['POST /api/me/payment-methods/titopay/link', 'POST /api/me/payment-methods/titopay/confirm', 'DELETE /api/me/payment-methods/:id'] as $r) {
    [$m, $p] = explode(' ', $r);
    route($m, $p, function () { require_auth(); throw not_available(); });
}

// ---- Apple Wallet and Google Wallet ----------------------------------------------
route('GET', '/api/me/tickets/:id/wallet/apple', function ($a) {
    $u = require_auth();
    limit('walletpass', 60, 3600, $u['id']);
    if (!wallet_apple_ready()) throw not_available();
    return wallet_apple_download(wallet_ticket($u, $a['id']));
});
route('GET', '/api/me/tickets/:id/wallet/google', function ($a) {
    $u = require_auth();
    limit('walletpass', 60, 3600, $u['id']);
    if (!wallet_google_ready()) throw not_available();
    return ['url' => wallet_google_url(wallet_ticket($u, $a['id']))];
});
// The same from the order page's private link (guests too).
route('GET', '/api/public/orders/:ref/tickets/:id/wallet/apple', function ($a) {
    limit('walletpass', 60, 3600);
    if (!wallet_apple_ready()) throw not_available();
    $o = order_access($a['ref'], qs('k'));
    if (!order_tickets_visible($o, qs('k'))) throw not_found('Ticket not found.');
    return wallet_apple_download(wallet_order_ticket($o, $a['id']));
});
route('GET', '/api/public/orders/:ref/tickets/:id/wallet/google', function ($a) {
    limit('walletpass', 60, 3600);
    if (!wallet_google_ready()) throw not_available();
    $o = order_access($a['ref'], qs('k'));
    if (!order_tickets_visible($o, qs('k'))) throw not_found('Ticket not found.');
    return ['url' => wallet_google_url(wallet_order_ticket($o, $a['id']))];
});
// The logo Google Wallet shows on the pass (Google fetches it from here).
route('GET', '/api/wallet/logo.png', fn() => raw_out((string) file_get_contents(TR_APP . '/wallet/google-logo.png'), 'image/png', 200, ['Cache-Control' => 'public, max-age=86400']));

// ---- Apple Wallet pass web service (developer.apple.com, "Wallet Passes web service")
// Devices register for updates to a pass and fetch its newest version. Each
// call carries the pass's own token ("ApplePass <token>"), never a session.
function passkit_auth(string $type, string $serial): array
{
    $a = wallet_apple_creds();
    $h = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    if ($type !== $a['passTypeId'] || !preg_match('/^ApplePass\s+(\S+)$/', $h, $m) || !safe_equal(wallet_apple_token($serial), $m[1])) throw new AppError(401, 'unauthorised', 'Not authorised.');
    $p = row("SELECT * FROM wallet_passes WHERE serial = ? AND kind = 'apple'", [$serial]);
    if (!$p) throw not_found('Pass not found.');
    return $p;
}
route('POST', '/api/passkit/v1/devices/:device/registrations/:type/:serial', function ($a) {
    limit('passkit', 120, 3600);
    if (!wallet_apple_ready()) throw not_available();
    passkit_auth($a['type'], $a['serial']);
    $b = json_decode((string) $GLOBALS['TR_REQ']['raw'], true);
    $token = is_array($b) ? (string) ($b['pushToken'] ?? '') : '';
    if (!preg_match('/^[A-Za-z0-9]{8,200}$/', $token) || !preg_match('/^[A-Za-z0-9]{1,200}$/', $a['device'])) throw bad('pushToken missing.');
    $had = val('SELECT 1 FROM wallet_devices WHERE device_id = ? AND serial = ?', [$a['device'], $a['serial']]);
    q('INSERT INTO wallet_devices (device_id, serial, push_token, created_at) VALUES (?,?,?,?) ON CONFLICT (device_id, serial) DO UPDATE SET push_token = excluded.push_token', [$a['device'], $a['serial'], $token, now_iso()]);
    return raw_out('', 'text/plain', $had ? 200 : 201);
});
route('DELETE', '/api/passkit/v1/devices/:device/registrations/:type/:serial', function ($a) {
    limit('passkit', 120, 3600);
    if (!wallet_apple_ready()) throw not_available();
    passkit_auth($a['type'], $a['serial']);
    q('DELETE FROM wallet_devices WHERE device_id = ? AND serial = ?', [$a['device'], $a['serial']]);
    return raw_out('', 'text/plain', 200);
});
// Which of this device's passes changed since the tag it last saw.
route('GET', '/api/passkit/v1/devices/:device/registrations/:type', function ($a) {
    limit('passkit', 240, 3600);
    if (!wallet_apple_ready() || $a['type'] !== wallet_apple_creds()['passTypeId']) throw not_found('Unknown pass type.');
    $since = qs('passesUpdatedSince');
    $list = rows("SELECT p.serial, p.updated_at FROM wallet_devices d JOIN wallet_passes p ON p.serial = d.serial WHERE d.device_id = ?" . ($since ? ' AND p.updated_at > ?' : ''), $since ? [$a['device'], $since] : [$a['device']]);
    if (!$list) return raw_out('', 'text/plain', 204);
    return ['serialNumbers' => array_column($list, 'serial'), 'lastUpdated' => max(array_column($list, 'updated_at'))];
});
route('GET', '/api/passkit/v1/passes/:type/:serial', function ($a) {
    limit('passkit', 240, 3600);
    if (!wallet_apple_ready()) throw not_available();
    $p = passkit_auth($a['type'], $a['serial']);
    $since = (string) ($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? '');
    $mod = (int) to_unix($p['updated_at']);
    if ($since !== '' && strtotime($since) >= $mod) return raw_out('', 'text/plain', 304);
    $s = wallet_pass_state($p);
    return raw_out(wallet_apple_pkpass($s['ticket'], $s['void']), 'application/vnd.apple.pkpass', 200, ['Last-Modified' => gmdate('D, d M Y H:i:s \G\M\T', $mod), 'Cache-Control' => 'no-store']);
});
route('POST', '/api/passkit/v1/log', function () {
    limit('passkit-log', 30, 3600);
    $b = json_decode((string) $GLOBALS['TR_REQ']['raw'], true);
    foreach (array_slice((array) ($b['logs'] ?? []), 0, 10) as $line) error_log('[wallet] Apple: ' . substr(preg_replace('/[^\x20-\x7E]/', '', (string) $line), 0, 300));
    return raw_out('', 'text/plain', 200);
});
