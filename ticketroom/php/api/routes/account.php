<?php
// /api/me/* — tickets, QR codes, transfers, orders, support. Cashless,
// wristbands and payment methods are not available in this edition.
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

route('GET', '/api/me/refunds', function () { require_auth(); return ['refunds' => []]; });
route('GET', '/api/me/support', fn() => ['cases' => rows('SELECT reference, category, subject, status, resolution, created_at, updated_at FROM support_cases WHERE user_id = ? ORDER BY created_at DESC', [require_auth()['id']])]);

// Not in this edition: answer consistently so pages can show "coming soon".
route('GET', '/api/me/payment-methods', function () { require_auth(); return ['links' => [], 'titopayAvailable' => false, 'titopayEnvironment' => null]; });
route('GET', '/api/me/wallets', function () { require_auth(); return ['wallets' => []]; });
route('GET', '/api/me/tags', function () { require_auth(); return ['tags' => []]; });
foreach (['POST /api/me/payment-methods/titopay/link', 'POST /api/me/payment-methods/titopay/confirm', 'DELETE /api/me/payment-methods/:id', 'POST /api/me/tags/link',
    'POST /api/me/tags/:id/lost', 'GET /api/me/wallets/:eventId', 'POST /api/me/wallets/:eventId/topups', 'POST /api/me/wallets/:eventId/refund'] as $r) {
    [$m, $p] = explode(' ', $r);
    route($m, $p, function () { require_auth(); throw not_available(); });
}

// ---- Apple Wallet and Google Wallet ----------------------------------------------
route('GET', '/api/me/tickets/:id/wallet/apple', function ($a) {
    $u = require_auth();
    limit('walletpass', 60, 3600, $u['id']);
    if (!wallet_apple_ready()) throw not_available();
    $t = wallet_ticket($u, $a['id']);
    return raw_out(wallet_apple_pkpass($t), 'application/vnd.apple.pkpass', 200, ['Content-Disposition' => 'attachment; filename="ticketroom-' . $t['code'] . '.pkpass"', 'Cache-Control' => 'no-store']);
});
route('GET', '/api/me/tickets/:id/wallet/google', function ($a) {
    $u = require_auth();
    limit('walletpass', 60, 3600, $u['id']);
    if (!wallet_google_ready()) throw not_available();
    return ['url' => wallet_google_url(wallet_ticket($u, $a['id']))];
});
