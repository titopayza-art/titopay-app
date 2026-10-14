<?php
// /api/public/* — discovery, free checkout, order status, unsubscribe.
declare(strict_types=1);

const PUBLIC_EVENT = "e.id, e.slug, e.title, e.is_free, e.summary, e.category, e.venue_name, e.address, e.city, e.province, e.starts_at, e.ends_at,
  e.doors_open_at, e.image_upload_id, e.featured, e.age_restriction, e.age_groups, e.ref, e.status, e.sales_start_at, e.sales_end_at, o.name AS organiser_name, o.ref AS organiser_ref,
  (SELECT MIN(price_cents) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale') AS from_price_cents,
  (SELECT COALESCE(SUM(quantity_total - quantity_sold - quantity_held),0) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale') AS remaining,
  (SELECT count(*) FROM event_likes l WHERE l.event_id = e.id) AS likes";

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
    // An age group also matches events for all ages.
    if (isset(AGE_GROUPS[qs('age') ?? ''])) { $where[] = "(',' || COALESCE(e.age_groups, '') || ',' LIKE ? OR e.age_groups = 'all')"; $p[] = '%,' . qs('age') . ',%'; }
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
    $types = rows("SELECT id, name, description, kind, admits, price_cents, per_order_limit, sales_start_at, sales_end_at, MAX(quantity_total - quantity_sold - quantity_held, 0) AS remaining
                     FROM ticket_types WHERE event_id = ? AND status = 'on_sale' ORDER BY sort_order, price_cents", [$ev['id']]);
    foreach ($types as &$t) $t['fee_cents'] = ticket_fee((int) $t['price_cents']);
    $ev['salesOpen'] = sales_open($ev);
    $ev['liked'] = user() ? (bool) val('SELECT 1 FROM event_likes WHERE user_id = ? AND event_id = ?', [user()['id'], $ev['id']]) : false;
    return ['event' => $ev, 'ticketTypes' => $types];
});

// Like (or unlike) an event. Liked events are saved in the customer portal.
route('POST', '/api/public/events/:slug/like', function ($a) {
    $u = require_auth();
    limit('like', 120, 60, $u['id']);
    $b = check(body(), ['liked' => R::bool()]);
    $id = val("SELECT id FROM events WHERE slug = ? AND status IN ('published','completed')", [$a['slug']]);
    if (!$id) throw not_found('Event not found.');
    if ($b['liked']) q('INSERT OR IGNORE INTO event_likes (user_id, event_id, created_at) VALUES (?,?,?)', [$u['id'], $id, now_iso()]);
    else q('DELETE FROM event_likes WHERE user_id = ? AND event_id = ?', [$u['id'], $id]);
    return ['liked' => $b['liked'], 'likes' => (int) val('SELECT count(*) FROM event_likes WHERE event_id = ?', [$id])];
});
route('GET', '/api/me/likes', function () {
    $u = require_auth();
    return ['events' => rows('SELECT ' . PUBLIC_EVENT . " FROM event_likes l JOIN events e ON e.id = l.event_id JOIN organisers o ON o.id = e.organiser_id
                               WHERE l.user_id = ? AND e.status IN ('published','completed') ORDER BY (e.ends_at < ?), e.starts_at LIMIT 200", [$u['id'], now_iso()])];
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

// Booking. Signed in, or as a guest with a name and email: no account needed.
route('POST', '/api/public/orders', function () {
    $b = check(body(), [
        'eventSlug' => R::str(['max' => 120]), 'items' => items_rule(), 'promoCode' => R::str(['optional' => true, 'max' => 40]),
        'ref' => R::str(['optional' => true, 'max' => 40, 'pattern' => '/^[A-Za-z0-9_-]+$/']), 'buyerPhone' => R::phone(['optional' => true]),
        'marketingOptIn' => R::obj(['email' => R::bool(), 'sms' => R::bool()], ['optional' => true]), 'idempotencyKey' => R::idemKey(),
        'paymentMethod' => R::oneOf(['card', 'titopay_wallet'], ['optional' => true, 'fallback' => 'card']),
        'guest' => R::obj(['fullName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(), 'phone' => R::phone(['optional' => true])], ['optional' => true]),
    ]);
    $u = user();
    if ($u) limit('order', 20, 60, $u['id']);
    else {
        if (empty($b['guest'])) throw bad('Tell us your name and email so we can send your tickets.', ['guest' => 'Required.']);
        limit('guestorder', 15, 3600);
        $u = tx(fn() => guest_buyer($b['guest']));
    }
    $r = create_order($u, $b);
    $o = $r['order'];
    $payment = null;
    if ($o['status'] === 'pending_payment') {
        // A paid order: open the provider's payment page. If the provider
        // can't be reached, the reservation is released and nothing is charged.
        try { $payment = payment_start($o); }
        catch (AppError $e) {
            tx(function () use ($o) { $cur = row('SELECT * FROM orders WHERE id = ?', [$o['id']]); if ($cur['status'] === 'pending_payment') { release_holds($cur); q("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [now_iso(), $o['id']]); } });
            throw $e;
        }
    }
    return json_out(['order' => ['reference' => $o['reference'], 'status' => $o['status'], 'totalCents' => $o['total_cents'], 'expiresAt' => $o['expires_at']],
        'accessKey' => user() ? null : order_key($o['id']), 'payment' => $payment], $r['replay'] ? 200 : 201);
});

// An order and its tickets, for the buyer (signed in, or with the private link).
route('GET', '/api/public/orders/:ref', function ($a) {
    limit('orderview', 120, 60);
    $key = qs('k');
    $o = order_access($a['ref'], $key);
    // Waiting for payment: ask the provider directly every few seconds, in case its notification is slow.
    if ($o['status'] === 'pending_payment') {
        $p = row("SELECT id, updated_at FROM payments WHERE order_id = ? AND status = 'pending' AND provider = 'yoco' ORDER BY created_at DESC LIMIT 1", [$o['id']]);
        if ($p && to_unix($p['updated_at']) < microtime(true) - 6) {
            q('UPDATE payments SET updated_at = ? WHERE id = ?', [now_iso(), $p['id']]);
            try { payment_sync($p['id']); } catch (Throwable $e) { error_log('[payments] sync: ' . $e->getMessage()); }
            $o = order_access($a['ref'], $key);
        }
    }
    $items = rows('SELECT oi.quantity, oi.unit_price_cents, oi.unit_fee_cents, tt.name FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ?', [$o['id']]);
    $owner = row('SELECT email, guest FROM users WHERE id = ?', [$o['user_id']]);
    $tickets = rows("SELECT t.id, t.code, t.status, t.holder_name, t.admitted_at, tt.name AS ticket_type, tt.admits FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id
                      WHERE t.order_id = ? AND t.owner_user_id = ? ORDER BY t.created_at", [$o['id'], $o['user_id']]);
    $k = $key && verify_link($key) ? $key : order_key($o['id']);
    foreach ($tickets as &$t) $t['qrUrl'] = $t['status'] === 'valid' ? "/api/public/orders/{$o['reference']}/tickets/{$t['id']}/qr.svg?k=" . rawurlencode($k) : null;
    unset($t);
    return [
        'order' => [
            'reference' => $o['reference'], 'status' => $o['status'], 'subtotalCents' => $o['subtotal_cents'], 'discountCents' => $o['discount_cents'],
            'feeCents' => $o['fee_cents'], 'totalCents' => $o['total_cents'], 'refundedCents' => $o['refunded_cents'], 'expiresAt' => $o['expires_at'], 'paidAt' => $o['paid_at'],
            'buyerName' => $o['buyer_name'],
            'event' => ['title' => $o['title'], 'slug' => $o['slug'], 'startsAt' => $o['starts_at'], 'endsAt' => $o['ends_at'], 'venue' => $o['venue_name'], 'city' => $o['city']],
        ],
        'guest' => (int) $owner['guest'] === 1, 'email' => (int) $owner['guest'] === 1 ? $owner['email'] : null,
        'items' => $items, 'tickets' => $tickets, 'payment' => order_payment_view($o),
    ];
});

route('GET', '/api/public/orders/:ref/tickets/:id/qr.svg', function ($a) {
    limit('orderqr', 240, 60);
    $o = order_access($a['ref'], qs('k'));
    $t = row("SELECT * FROM tickets WHERE id = ? AND order_id = ? AND owner_user_id = ? AND status = 'valid'", [$a['id'], $o['id'], $o['user_id']]);
    if (!$t) throw not_found('Ticket not found.');
    return raw_out(tr_qr_svg(qr_payload($t), ['ecc' => 'M', 'margin' => 1, 'dark' => '#0B1A33', 'light' => '#FFFFFF']), 'image/svg+xml', 200, ['Cache-Control' => 'no-store']);
});

// Try paying again (the payment page was closed or the card declined), while the tickets are still held.
route('POST', '/api/public/orders/:ref/pay', function ($a) {
    limit('repay', 10, 600);
    $o = order_access($a['ref'], qs('k'));
    if ($o['status'] !== 'pending_payment') throw conflict('This order is not waiting for payment.', 'order_not_pending');
    if (to_unix($o['expires_at']) < microtime(true)) throw conflict('Your reservation has expired. Please start again from the event page.', 'order_expired');
    return ['payment' => payment_start(row('SELECT * FROM orders WHERE id = ?', [$o['id']]))];
});

// PayFast: the signed form the buyer's browser posts to PayFast (see /pay).
route('GET', '/api/public/payments/:id/payfast', function ($a) {
    limit('payform', 30, 600);
    $d = verify_link(qs('k'));
    if (!$d || ($d['p'] ?? '') !== $a['id']) throw not_found('This payment link has expired. Go back to your order and try again.');
    $p = row("SELECT * FROM payments WHERE id = ? AND provider = 'payfast' AND status = 'pending'", [$a['id']]);
    if (!$p) throw conflict('This payment is no longer open.', 'payment_closed');
    $o = row('SELECT * FROM orders WHERE id = ?', [$p['order_id']]);
    if ($o['status'] !== 'pending_payment') throw conflict('This order is not waiting for payment.', 'order_not_pending');
    return payfast_form($p, $o);
});

route('POST', '/api/public/orders/:ref/cancel', function ($a) {
    $key = qs('k');
    return tx(function () use ($a, $key) {
        $o = order_access($a['ref'], $key);
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
    // TicketRoom updates subscriber (no account needed).
    if ($d && !empty($d['n']) && empty($d['confirm'])) {
        q("UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE id = ?", [now_iso(), now_iso(), $d['n']]);
        return ['ok' => true, 'organiser' => 'TicketRoom updates', 'channel' => 'email'];
    }
    if (!$d || empty($d['u'])) throw bad('This unsubscribe link is invalid or has expired. You can manage preferences in your account.');
    if (!empty($d['all'])) {
        tx(function () use ($d) {
            foreach (rows('SELECT organiser_id, channel FROM marketing_consents WHERE user_id = ? AND granted = 1', [$d['u']]) as $x) set_consent($d['u'], $x['organiser_id'], $x['channel'], false, 'unsubscribe_all');
            set_consent($d['u'], null, 'email', false, 'unsubscribe_all');
            set_consent($d['u'], null, 'sms', false, 'unsubscribe_all');
            q("UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE lower(email) = (SELECT lower(email) FROM users WHERE id = ?) AND status <> 'unsubscribed'", [now_iso(), now_iso(), $d['u']]);
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

// A gate pass opened from its private link (no account needed).
route('GET', '/api/public/pass', function () {
    limit('passview', 60, 60);
    $t = (string) qs('t', '');
    if (!preg_match('/^[A-Za-z0-9_-]{20,64}$/', $t)) throw not_found('This pass link is not valid.');
    $g = row('SELECT * FROM gate_passes WHERE link_token_hash = ?', [sha256($t)]);
    if (!$g) throw not_found('This pass link is not valid. If the organiser sent you a new one, use that.');
    $e = row('SELECT e.title, e.ref, e.starts_at, e.ends_at, e.venue_name, e.city, e.status, o.name AS organiser FROM events e JOIN organisers o ON o.id = e.organiser_id WHERE e.id = ?', [$g['event_id']]);
    $live = $g['status'] === 'active' && !in_array($e['status'], ['cancelled', 'suspended'], true);
    return [
        'pass' => ['holderName' => $g['holder_name'], 'role' => PASS_ROLES[$g['role']] ?? $g['role'], 'accessNote' => $g['access_note'], 'reentry' => (bool) $g['reentry'],
            'status' => $live ? 'active' : 'revoked', 'code' => $g['code'], 'used' => !$g['reentry'] && (int) $g['scans'] > 0],
        'event' => $e,
        'svg' => $live ? tr_qr_svg(pass_payload($g), ['ecc' => 'M', 'margin' => 1, 'dark' => '#0B1A33', 'light' => '#FFFFFF']) : null,
    ];
});
