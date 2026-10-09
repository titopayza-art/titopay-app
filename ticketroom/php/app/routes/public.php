<?php
// /api/public/* — discovery, free checkout, order status, unsubscribe.
declare(strict_types=1);

const PUBLIC_EVENT = "e.id, e.slug, e.title, e.is_free, e.summary, e.category, e.venue_name, e.address, e.city, e.province, e.starts_at, e.ends_at,
  e.doors_open_at, e.image_upload_id, e.featured, e.age_restriction, e.status, e.sales_start_at, e.sales_end_at, o.name AS organiser_name,
  (SELECT MIN(price_cents) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale') AS from_price_cents,
  (SELECT COALESCE(SUM(quantity_total - quantity_sold - quantity_held),0) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale') AS remaining";

route('GET', '/api/public/events', function () {
    limit('browse', 300, 60);
    $where = ["e.status = 'published'", 'e.ends_at > ?'];
    $p = [now_iso()];
    $q = trim(mb_substr((string) qs('q', ''), 0, 80));
    if ($q !== '') {
        $like = '%' . like_escape(mb_strtolower($q)) . '%';
        $where[] = "(lower(e.title) LIKE ? ESCAPE '\\' OR lower(e.venue_name) LIKE ? ESCAPE '\\' OR lower(e.city) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')";
        array_push($p, $like, $like, $like, $like);
    }
    if (qs('category')) { $where[] = 'e.category = ?'; $p[] = qs('category'); }
    if (qs('city')) { $where[] = 'e.city = ?'; $p[] = qs('city'); }
    if (qs('free') === '1') $where[] = "(e.is_free = 1 OR NOT EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale' AND tt.price_cents > 0))";
    if (qs('when') === 'weekend') {
        // Friday 00:00 to Monday 00:00 of this week, Johannesburg time (ISO week starts Monday).
        $monday = (new DateTimeImmutable('monday this week', new DateTimeZone('Africa/Johannesburg')));
        $where[] = 'e.starts_at > ? AND e.starts_at < ?';
        array_push($p, iso_at((float) $monday->modify('+4 days')->format('U')), iso_at((float) $monday->modify('+7 days')->format('U')));
    }
    if (qs('when') === 'month') { $where[] = 'e.starts_at < ?'; $p[] = iso_in(30 * 86400); }
    $events = rows('SELECT ' . PUBLIC_EVENT . ' FROM events e JOIN organisers o ON o.id = e.organiser_id WHERE ' . implode(' AND ', $where) . ' ORDER BY e.featured DESC, e.starts_at LIMIT 60', $p);
    $cities = rows("SELECT city, count(*) AS n FROM events WHERE status = 'published' AND ends_at > ? GROUP BY city ORDER BY n DESC", [now_iso()]);
    return ['events' => $events, 'cities' => $cities];
});

route('GET', '/api/public/events/:slug', function ($a) {
    $ev = row('SELECT ' . PUBLIC_EVENT . ", e.description, e.refund_policy, e.accessibility_info, e.transfers_enabled, e.cashless_enabled, e.capacity
                FROM events e JOIN organisers o ON o.id = e.organiser_id WHERE e.slug = ? AND e.status IN ('published','cancelled','completed')", [$a['slug']]);
    if (!$ev) throw not_found('Event not found.');
    $types = rows("SELECT id, name, description, price_cents, per_order_limit, sales_start_at, sales_end_at, MAX(quantity_total - quantity_sold - quantity_held, 0) AS remaining
                     FROM ticket_types WHERE event_id = ? AND status = 'on_sale' ORDER BY sort_order, price_cents", [$ev['id']]);
    foreach ($types as &$t) $t['fee_cents'] = ticket_fee((int) $t['price_cents']);
    $ev['salesOpen'] = sales_open($ev);
    return ['event' => $ev, 'ticketTypes' => $types];
});

route('POST', '/api/public/events/:slug/click', function ($a) {
    limit('click', 30, 60);
    $b = check(body(), ['ref' => R::str(['max' => 40, 'pattern' => '/^[A-Za-z0-9_-]+$/'])]);
    q('UPDATE tracking_links SET clicks = clicks + 1 WHERE code = ? AND event_id = (SELECT id FROM events WHERE slug = ?)', [$b['ref'], $a['slug']]);
    return ['ok' => true];
});

function items_rule(): Closure { return R::arr(R::obj(['ticketTypeId' => R::uuid(), 'quantity' => R::int(['min' => 1, 'max' => 50])]), ['min' => 1, 'max' => 10]); }

route('POST', '/api/public/checkout/quote', function () {
    limit('quote', 120, 60);
    $b = check(body(), ['eventSlug' => R::str(['max' => 120]), 'items' => items_rule(), 'promoCode' => R::str(['optional' => true, 'max' => 40])]);
    $ev = row('SELECT * FROM events WHERE slug = ?', [$b['eventSlug']]);
    if (!$ev) throw not_found('Event not found.');
    return ['quote' => public_quote(order_quote($ev, $b['items'], $b['promoCode'] ?? null))];
});

route('POST', '/api/public/orders', function () {
    $u = require_auth();
    limit('order', 20, 60, $u['id']);
    $b = check(body(), [
        'eventSlug' => R::str(['max' => 120]), 'items' => items_rule(), 'promoCode' => R::str(['optional' => true, 'max' => 40]),
        'ref' => R::str(['optional' => true, 'max' => 40, 'pattern' => '/^[A-Za-z0-9_-]+$/']), 'buyerPhone' => R::phone(['optional' => true]),
        'marketingOptIn' => R::obj(['email' => R::bool(), 'sms' => R::bool()], ['optional' => true]), 'idempotencyKey' => R::idemKey(),
        'paymentMethod' => R::oneOf(['card', 'titopay_wallet'], ['optional' => true, 'fallback' => 'card']),
    ]);
    $r = create_order($u, $b);
    $o = $r['order'];
    return json_out(['order' => ['reference' => $o['reference'], 'status' => $o['status'], 'totalCents' => $o['total_cents'], 'expiresAt' => $o['expires_at']], 'payment' => null], $r['replay'] ? 200 : 201);
});

route('GET', '/api/public/orders/:ref', function ($a) {
    $u = require_auth();
    ['order' => $o, 'items' => $items] = order_for_user($u, $a['ref']);
    $tickets = rows('SELECT id, code, status FROM tickets WHERE order_id = ? AND owner_user_id = ?', [$o['id'], $u['id']]);
    return [
        'order' => [
            'reference' => $o['reference'], 'status' => $o['status'], 'subtotalCents' => $o['subtotal_cents'], 'discountCents' => $o['discount_cents'],
            'feeCents' => $o['fee_cents'], 'totalCents' => $o['total_cents'], 'refundedCents' => $o['refunded_cents'], 'expiresAt' => $o['expires_at'], 'paidAt' => $o['paid_at'],
            'event' => ['title' => $o['title'], 'slug' => $o['slug'], 'startsAt' => $o['starts_at'], 'venue' => $o['venue_name'], 'city' => $o['city']],
        ],
        'items' => $items, 'tickets' => $tickets, 'payment' => null,
    ];
});

route('POST', '/api/public/orders/:ref/pay', function () { require_auth(); throw not_available(); });

route('POST', '/api/public/orders/:ref/cancel', function ($a) {
    $u = require_auth();
    return tx(function () use ($u, $a) {
        $o = row('SELECT * FROM orders WHERE reference = ? AND user_id = ?', [$a['ref'], $u['id']]);
        if (!$o) throw not_found('Order not found.');
        if ($o['status'] !== 'pending_payment') throw conflict('Only unpaid orders can be cancelled.', 'order_not_pending');
        release_holds($o);
        q("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [now_iso(), $o['id']]);
        return ['status' => 'cancelled'];
    });
});

// One-click unsubscribe from a signed link (POST, so link scanners cannot opt people out).
route('POST', '/api/public/unsubscribe', function () {
    limit('unsub', 30, 60);
    $b = check(body(), ['token' => R::str(['max' => 600])]);
    $d = verify_link($b['token']);
    if (!$d || empty($d['u'])) throw bad('This unsubscribe link is invalid or has expired. You can manage preferences in your account.');
    if (!empty($d['all'])) {
        tx(function () use ($d) {
            foreach (rows('SELECT organiser_id, channel FROM marketing_consents WHERE user_id = ? AND granted = 1', [$d['u']]) as $x) set_consent($d['u'], $x['organiser_id'], $x['channel'], false, 'unsubscribe_all');
            set_consent($d['u'], null, 'email', false, 'unsubscribe_all');
            set_consent($d['u'], null, 'sms', false, 'unsubscribe_all');
        });
        return ['ok' => true, 'all' => true];
    }
    tx(fn() => set_consent($d['u'], $d['o'] ?? null, $d['c'] ?? 'email', false, 'unsubscribe_link'));
    $name = !empty($d['o']) ? val('SELECT name FROM organisers WHERE id = ?', [$d['o']]) : 'TicketRoom';
    return ['ok' => true, 'organiser' => $name, 'channel' => $d['c'] ?? 'email'];
});

route('POST', '/api/public/support', function () {
    limit('support', 5, 3600);
    $u = user();
    $b = check(body(), ['email' => $u ? R::email(['optional' => true]) : R::email(), 'category' => R::oneOf(['tickets', 'refund', 'tag', 'payment', 'account', 'other']),
        'subject' => R::str(['min' => 3, 'max' => 140]), 'body' => R::text(['max' => 4000])]);
    $ref = reference('SC');
    $now = now_iso();
    insert('support_cases', ['id' => uuid(), 'reference' => $ref, 'user_id' => $u['id'] ?? null, 'email' => $u['email'] ?? $b['email'], 'category' => $b['category'],
        'subject' => $b['subject'], 'body' => $b['body'], 'status' => 'open', 'source' => 'web', 'due_at' => iso_in(48 * 3600), 'created_at' => $now, 'updated_at' => $now]);
    return json_out(['reference' => $ref], 201);
});
