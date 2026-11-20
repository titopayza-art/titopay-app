<?php
// /api/organiser/:orgId/events/:eventId/promotion* and /api/admin/promotions*:
// buying Promote for an event, the socials request, the promotion's
// analytics, and TicketRoom's Promotions queue (social posts, revenue, refunds).
// The money and campaign rules live in lib/promote.php.
declare(strict_types=1);

const PROMO_URL = '/^https?:\/\/[^\s<>"]{3,290}$/i';

function promo_latest(string $eventId): ?array
{
    return row("SELECT * FROM event_promotions WHERE event_id = ? AND status <> 'cancelled'
                 ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending_payment' THEN 1 ELSE 2 END, created_at DESC LIMIT 1", [$eventId]);
}

// ============================================================== organiser
route('GET', '/api/organiser/:orgId/events/:eventId/promotion', function ($a) {
    $u = require_auth();
    ['event' => $event, 'role' => $role, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_ALL);
    $promo = promo_latest($event['id']);
    $pay = $promo ? row('SELECT id, provider, status, failure_reason, environment FROM promotion_payments WHERE promotion_id = ? ORDER BY created_at DESC LIMIT 1', [$promo['id']]) : null;
    // Back from Yoco before its notification: ask Yoco directly, like the order page does.
    if ($pay && $promo['status'] === 'pending_payment' && $pay['provider'] === 'yoco' && $pay['status'] === 'pending' && limit_ok('promosync', 20, 600, $u['id'])) {
        try { payment_sync($pay['id']); } catch (Throwable $e) { error_log('[promote] sync: ' . $e->getMessage()); }
        $promo = promo_latest($event['id']);
        $pay = row('SELECT id, provider, status, failure_reason, environment FROM promotion_payments WHERE promotion_id = ? ORDER BY created_at DESC LIMIT 1', [$promo['id']]);
    }
    $blocked = promo_blocked($org, $event);
    $paid = $promo && $promo['paid_at'];
    $money = $role === 'owner' ? organiser_money($org) : null;
    return [
        'priceCents' => promo_price(),
        'promotion' => promo_view($promo),
        'payment' => $pay ? ['provider' => $pay['provider'], 'status' => $pay['status'], 'test' => $pay['environment'] !== 'live'] : null,
        'blocked' => $blocked && (!$promo || $promo['status'] !== 'active') ? ['code' => $blocked[0], 'message' => $blocked[1]] : null,
        'canBuy' => !$blocked && in_array($role, ORG_MKT, true),
        'methods' => ['card' => pay_ready(), 'cardTest' => pay_ready() && pay_test(), 'balance' => $money ? ['availableCents' => (int) $money['availableCents']] : null],
        'sms' => ['ready' => sms_ready(), 'costPerSegmentCents' => promo_sms_cost() ?: null],
        'poster' => $event['image_upload_id'] ? '/media/' . $event['image_upload_id'] : null,
        'audience' => org_audience_summary($org['id'], [$event['id']]),
        'analytics' => $paid ? promo_analytics($event, $promo) : null,
        'hourlyLimit' => PROMO_HOURLY_LIMIT,
    ];
});

route('POST', '/api/organiser/:orgId/events/:eventId/promotion/checkout', function ($a) {
    $u = require_auth();
    limit('promobuy', 20, 3600, $u['id']);
    $b = check(body(), ['method' => R::oneOf(['card', 'balance'])]);
    ['event' => $event, 'organiser' => $org, 'role' => $role] = event_access($u, $a['orgId'], $a['eventId'], ORG_MKT);
    if ($b['method'] === 'balance') {
        // Spending the balance is the owner's call, like a payout.
        if ($role !== 'owner') throw forbidden('Only the owner can pay from the balance. Pay by card, or ask the owner.');
        $promo = promo_pay_from_balance($u, $org, $event);
        return ['promotion' => promo_view($promo), 'paid' => true];
    }
    $promo = promo_open($u, $org, $event);
    $payment = promo_payment_start($promo, $u);
    audit('promotion.checkout', ['actor' => $u, 'entityType' => 'promotion', 'entityId' => $promo['id'], 'organiserId' => $org['id'], 'details' => ['provider' => $payment['provider'], 'test' => pay_test()]]);
    return ['promotion' => promo_view(row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']])), 'payment' => $payment];
});

// The socials request: what TicketRoom should post, and when.
route('POST', '/api/organiser/:orgId/events/:eventId/promotion/social', function ($a) {
    $u = require_auth();
    limit('promosocial', 10, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_MKT);
    $b = check(body(), [
        'caption' => R::text(['max' => 2200]), 'preferredDates' => R::str(['optional' => true, 'max' => 200]),
        'links' => R::arr(R::str(['max' => 300, 'pattern' => PROMO_URL, 'message' => 'Links start with https://']), ['optional' => true, 'max' => PROMO_SOCIAL_LINKS]),
        'usePoster' => org_bool(), 'imageUploadIds' => R::arr(R::uuid(), ['optional' => true, 'max' => 3]),
    ]);
    if (mb_strlen($b['caption']) < 10) throw bad('Write a caption of at least a sentence.', ['caption' => 'At least 10 characters.']);
    $promo = promo_active($event['id']);
    if (!$promo) throw conflict('Social posts come with Promote. Promote this event first.', 'not_promoted');
    if ($promo['social_status'] === 'posted') throw conflict('Your post is already live. Ask TicketRoom by email if you need a change.', 'already_posted');
    $images = [];
    if (($b['usePoster'] ?? true) && $event['image_upload_id']) $images[] = $event['image_upload_id'];
    foreach ($b['imageUploadIds'] ?? [] as $id) { org_assert_upload($org['id'], $id); $images[] = $id; }
    $req = ['caption' => $b['caption'], 'preferredDates' => $b['preferredDates'] ?? null, 'links' => array_values(array_filter($b['links'] ?? [])),
        'images' => array_values(array_unique($images)), 'requestedBy' => $u['fullName'], 'requestedAt' => now_iso()];
    q("UPDATE event_promotions SET social_request = ?, social_status = 'requested', social_updated_at = ?, updated_at = ? WHERE id = ?",
        [json_encode($req, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), now_iso(), now_iso(), $promo['id']]);
    audit('promotion.social_requested', ['actor' => $u, 'entityType' => 'promotion', 'entityId' => $promo['id'], 'organiserId' => $org['id'], 'details' => ['images' => count($req['images']), 'links' => count($req['links'])]]);
    tx(fn() => outbox_enqueue(['to' => settings_all()['support']['email']] + tpl('socialRequested', ['organiser' => $org['name'], 'event' => $event, 'promotion' => $promo, 'request' => $req])));
    return ['promotion' => promo_view(row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]))];
});

// Promoted events across the organisation (the Marketing page).
route('GET', '/api/organiser/:orgId/promotions', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_ALL);
    return ['priceCents' => promo_price(), 'promotions' => array_map('promo_view', rows("SELECT p.*, e.title AS event_title FROM event_promotions p JOIN events e ON e.id = p.event_id
                                                            WHERE p.organiser_id = ? AND p.status IN ('active','ended','refunded') ORDER BY p.paid_at DESC LIMIT 100", [$a['orgId']]))];
});

// ============================================================== admin
route('GET', '/api/admin/promotions', function () {
    adm_any();
    $status = (string) qs('status', '');
    $where = match ($status) {
        'social' => "p.status = 'active' AND p.social_status IN ('requested','scheduled')",
        'active', 'pending_payment', 'ended', 'refunded', 'cancelled' => 'p.status = ?',
        default => '1 = 1',
    };
    $params = in_array($status, ['active', 'pending_payment', 'ended', 'refunded', 'cancelled'], true) ? [$status] : [];
    $list = rows("SELECT p.*, e.title AS event_title, e.slug AS event_slug, e.status AS event_status, e.starts_at AS event_starts_at, e.cancellation_requested_at,
                         o.name AS organiser_name, u.email AS bought_by_email, u.full_name AS bought_by_name
                    FROM event_promotions p JOIN events e ON e.id = p.event_id JOIN organisers o ON o.id = p.organiser_id LEFT JOIN users u ON u.id = p.created_by
                   WHERE $where ORDER BY CASE WHEN p.social_status = 'requested' THEN 0 ELSE 1 END, COALESCE(p.paid_at, p.created_at) DESC LIMIT 300", $params);
    return ['promotions' => array_map('promo_admin_row', $list), 'revenue' => promo_revenue()];
});

route('POST', '/api/admin/promotions/:id/social', function ($a) {
    $u = adm_admin_or_support();
    $b = check(body(), ['status' => R::oneOf(['scheduled', 'posted']), 'notes' => R::text(['optional' => true, 'max' => 1000]),
        'links' => R::arr(R::str(['max' => 300, 'pattern' => PROMO_URL, 'message' => 'Links start with https://']), ['optional' => true, 'max' => PROMO_SOCIAL_LINKS])]);
    $p = row('SELECT * FROM event_promotions WHERE id = ?', [$a['id']]);
    if (!$p) throw not_found('Promotion not found.');
    if (!in_array($p['status'], ['active', 'ended'], true)) throw conflict('Only a paid promotion gets social posts.', 'bad_transition');
    $links = array_values(array_filter($b['links'] ?? []));
    if ($b['status'] === 'posted' && !$links) throw bad('Add the link to the post.', ['links' => 'At least one link.']);
    $was = $p['social_status'];
    q('UPDATE event_promotions SET social_status = ?, social_notes = COALESCE(?, social_notes), social_links = ?, social_updated_at = ?, updated_at = ? WHERE id = ?',
        [$b['status'], ($b['notes'] ?? '') !== '' ? $b['notes'] : null, json_encode($links, JSON_UNESCAPED_SLASHES), now_iso(), now_iso(), $p['id']]);
    audit('promotion.social_' . $b['status'], ['actor' => $u, 'entityType' => 'promotion', 'entityId' => $p['id'], 'organiserId' => $p['organiser_id'], 'details' => ['links' => $links]]);
    if ($b['status'] === 'posted' && $was !== 'posted') {
        $buyer = row('SELECT id, email, full_name FROM users WHERE id = ?', [$p['created_by']]);
        $event = row('SELECT * FROM events WHERE id = ?', [$p['event_id']]);
        if ($buyer) tx(fn() => outbox_enqueue(['to' => $buyer['email'], 'userId' => $buyer['id']] + tpl('socialPostLive', ['name' => $buyer['full_name'], 'event' => $event, 'promotion' => $p, 'links' => $links])));
    }
    return ['promotion' => promo_admin_row(row('SELECT * FROM event_promotions WHERE id = ?', [$p['id']]))];
});

route('POST', '/api/admin/promotions/:id/refund', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['reason' => R::str(['min' => 5, 'max' => 400])]);
    $p = row('SELECT * FROM event_promotions WHERE id = ?', [$a['id']]);
    if (!$p) throw not_found('Promotion not found.');
    return ['promotion' => promo_admin_row(promo_refund($p, $u, $b['reason']))];
});

// PayFast refunds are made in the PayFast dashboard, then recorded here; so is
// a card refund that failed and was then paid in the provider's own dashboard.
route('POST', '/api/admin/promotions/:id/refund/complete', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['providerReference' => R::str(['min' => 3, 'max' => 120])]);
    $p = row('SELECT * FROM event_promotions WHERE id = ?', [$a['id']]);
    if (!$p) throw not_found('Promotion not found.');
    if (!in_array($p['refund_status'], ['manual_pending', 'failed'], true)) throw conflict('This refund is not waiting to be recorded.', 'bad_transition');
    tx(fn() => promo_refund_complete($p['id'], $b['providerReference'], $u));
    return ['promotion' => promo_admin_row(row('SELECT * FROM event_promotions WHERE id = ?', [$p['id']]))];
});
