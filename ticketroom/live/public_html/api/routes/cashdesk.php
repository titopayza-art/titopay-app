<?php
// The top-up desk and the cash-out desk (/api/cashdesk, for organisers, their
// wristband staff and TicketRoom staff), guests cashing out their balance
// (/api/me), and finance paying EFT cash-outs (/api/admin/cashouts).
// The rules live in lib/cashdesk.php.
declare(strict_types=1);

function cd_access(array $a): array { return desk_access(require_auth(), $a['eventId']); }

route('GET', '/api/cashdesk/events', fn() => ['events' => desk_events(require_auth())]);

route('GET', '/api/cashdesk/events/:eventId', function ($a) {
    $u = require_auth();
    $acc = desk_access($u, $a['eventId']);
    $ev = $acc['event'];
    $s = cashless_event_settings($ev['id']);
    $lim = cashless_limits();
    return [
        'event' => ['id' => $ev['id'], 'title' => $ev['title'], 'startsAt' => $ev['starts_at'], 'endsAt' => $ev['ends_at'], 'status' => $ev['status'], 'cashlessOpen' => cashless_open_event($ev) && $ev['status'] === 'published'],
        'kind' => $acc['kind'], 'manager' => $acc['manager'], 'settings' => $s, 'test' => pay_test(),
        'limits' => ['quickCents' => [5000, 10000, 20000, 50000], 'minCents' => 1000, 'maxTopupCents' => $lim['maxTopupCents'], 'maxBalanceCents' => $lim['maxBalanceCents'],
            'deskDailyCapCents' => $s['deskDailyCapCents'], 'todayCents' => (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM desk_topups WHERE staff_id = ? AND status = 'confirmed' AND created_at >= ?", [$u['id'], desk_day_start()]),
            'undoMinutes' => DESK_UNDO_MINUTES],
    ];
});
route('POST', '/api/cashdesk/events/:eventId/lookup', function ($a) {
    $u = require_auth();
    limit('desklookup', 120, 60, $u['id']);
    $acc = desk_access($u, $a['eventId']);
    $b = check(body(), ['query' => R::str(['min' => 3, 'max' => 120])]);
    return ['guest' => desk_find_guest($acc['event'], $b['query'])];
});
route('POST', '/api/cashdesk/events/:eventId/topups', function ($a) {
    $u = require_auth();
    limit('desktopup', 60, 60, $u['id']);
    $acc = desk_access($u, $a['eventId']);
    $b = check(body(), ['userId' => R::uuid(), 'amountCents' => R::int(['min' => 1000, 'max' => 10000000]), 'method' => R::oneOf(['cash', 'card']),
        'idempotencyKey' => R::idemKey(), 'receipt' => R::bool()]);
    $r = desk_topup($u, $acc, $b);
    return json_out($r, $r['replay'] ? 200 : 201);
});
route('POST', '/api/cashdesk/events/:eventId/topups/:ref/undo', function ($a) {
    $u = require_auth();
    limit('deskundo', 30, 3600, $u['id']);
    $b = check(body(), ['reason' => R::str(['optional' => true, 'max' => 200])]);
    return desk_undo($u, desk_access($u, $a['eventId']), $a['ref'], $b['reason'] ?? null, false);
});
route('POST', '/api/cashdesk/events/:eventId/topups/:ref/reverse', function ($a) {
    $u = require_auth();
    limit('deskundo', 30, 3600, $u['id']);
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 200])]);
    return desk_undo($u, desk_access($u, $a['eventId']), $a['ref'], $b['reason'], true);
});
route('GET', '/api/cashdesk/events/:eventId/cashup', function ($a) {
    $u = require_auth();
    return desk_cashup($u, desk_access($u, $a['eventId']));
});
// The cash-out desk: find the guest's code, then pay.
route('POST', '/api/cashdesk/events/:eventId/cashouts/find', function ($a) {
    $u = require_auth();
    limit('deskcashout', 120, 60, $u['id']);
    $acc = desk_access($u, $a['eventId']);
    $b = check(body(), ['code' => R::str(['min' => 8, 'max' => 40])]);
    $c = cashout_desk_find($acc, $b['code']);
    return ['cashout' => cashout_view($c) + ['name' => $c['full_name']]];
});
route('POST', '/api/cashdesk/events/:eventId/cashouts/pay', function ($a) {
    $u = require_auth();
    limit('deskcashout', 120, 60, $u['id']);
    $acc = desk_access($u, $a['eventId']);
    $b = check(body(), ['code' => R::str(['min' => 8, 'max' => 40])]);
    return ['cashout' => cashout_desk_pay($u, $acc, $b['code'])];
});

// The organiser opens the venue's cash-out desk and sets the daily desk limit.
route('PUT', '/api/organiser/:orgId/events/:eventId/cashdesk', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), ['cashoutDeskOpen' => R::bool(['optional' => true, 'fallback' => null]), 'deskDailyCapCents' => R::int(['optional' => true, 'min' => 10000, 'max' => 100000000])]);
    return ['settings' => cashless_event_settings_save($u, $event, $b)];
});

// ============================================================== guests
route('POST', '/api/me/wallets/:eventId/cashout', function ($a) {
    $u = require_auth();
    limit('cashout', 10, 3600, $u['id']);
    $b = check(body(), ['method' => R::oneOf(['card', 'eft', 'cash']),
        'bank' => R::obj(['accountHolder' => R::str(['min' => 2, 'max' => 120]), 'bankName' => R::str(['min' => 2, 'max' => 60]),
            'branchCode' => R::str(['min' => 4, 'max' => 10, 'pattern' => '/^\d{4,10}$/', 'message' => 'Use the digits of the branch code.']),
            'accountNumber' => R::str(['min' => 6, 'max' => 20, 'pattern' => '/^[\d ]{6,20}$/', 'message' => 'Use the digits of the account number.'])], ['optional' => true])]);
    if ($b['method'] === 'card') {
        $made = wallet_refund_request($u, $a['eventId']);
        return json_out(['cashout' => ['method' => 'card', 'reference' => $made[0]['reference'], 'status' => 'requested', 'amountCents' => array_sum(array_map(fn($r) => (int) $r['amount_cents'], $made)), 'feeCents' => 0],
            'leftCents' => wallet_total($u['id'], $a['eventId'])], 201);
    }
    if ($b['method'] === 'eft' && empty($b['bank'])) throw invalid(['bank' => 'Add the bank account to pay into.']);
    $made = cashout_request($u, $a['eventId'], $b['method'], $b['bank'] ?? null);
    return json_out(['cashout' => $made[0] + ['amountCents' => array_sum(array_column($made, 'amountCents'))], 'cashouts' => $made, 'leftCents' => wallet_total($u['id'], $a['eventId'])], 201);
});
// The code to show at the venue's cash-out desk, as a QR code.
route('GET', '/api/me/cashouts/:ref/qr.svg', function ($a) {
    $u = require_auth();
    $c = row("SELECT * FROM wallet_cashouts WHERE reference = ? AND user_id = ? AND method = 'cash' AND status = 'requested'", [strtoupper($a['ref']), $u['id']]);
    if (!$c) throw not_found('Cash-out not found.');
    return raw_out(tr_qr_svg(cashout_view($c)['qrPayload'], ['ecc' => 'M', 'margin' => 1, 'dark' => '#0B1A33', 'light' => '#FFFFFF']), 'image/svg+xml', 200, ['Cache-Control' => 'no-store']);
});
route('POST', '/api/me/cashouts/:ref/cancel', function ($a) {
    $u = require_auth();
    return ['cashout' => cashout_cancel($u, $a['ref'])];
});

// ============================================================== finance
route('GET', '/api/admin/cashouts', function () {
    adm_any();
    $st = qs('status');
    return ['cashouts' => $st ? cashout_rows('c.status = ?', [$st]) : cashout_rows('1 = 1', []), 'dualApprovalCents' => cashout_dual_cents()];
});
route('POST', '/api/admin/cashouts/:id/decide', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['approve' => R::bool(), 'note' => R::str(['optional' => true, 'max' => 400])]);
    if (!$b['approve'] && empty($b['note'])) throw bad('Say why, so the guest knows.', ['note' => 'Required when rejecting.']);
    return ['cashout' => cashout_rows('c.id = ?', [cashout_decide($u, $a['id'], $b['approve'], $b['note'] ?? null)['id']])[0]];
});
// The full account number, for making the EFT. Every view is in the audit log.
route('POST', '/api/admin/cashouts/:id/reveal-account', function ($a) {
    $u = adm_finance();
    limit('reveal', 30, 3600, $u['id']);
    $c = row("SELECT * FROM wallet_cashouts WHERE id = ? AND method = 'eft' AND status = 'approved'", [$a['id']]);
    if (!$c) throw conflict('Approve the cash-out first.', 'bad_transition');
    audit('wallet.cashout_account_revealed', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id']]);
    return ['accountNumber' => decrypt_str((string) $c['bank_account_enc'])];
});
route('POST', '/api/admin/cashouts/:id/mark-paid', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['bankReference' => R::str(['min' => 3, 'max' => 120])]);
    return ['cashout' => cashout_rows('c.id = ?', [cashout_mark_paid($u, $a['id'], $b['bankReference'])['id']])[0]];
});
