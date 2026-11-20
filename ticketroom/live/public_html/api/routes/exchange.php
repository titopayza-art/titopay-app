<?php
// Waitlists, TicketRoom Exchange (fair resale) and inviting a friend to top
// up. The rules live in lib/exchange.php.
declare(strict_types=1);

// The signed-in customer, if any (organisers and staff buy and wait as guests).
function ex_customer(): ?array { return user() && account_type(user()) === 'customer' ? user() : null; }

// ============================================================== waitlist
route('POST', '/api/public/events/:slug/waitlist', function ($a) {
    limit('waitlist', 30, 3600);
    $u = ex_customer();
    $b = check(body(), ['ticketTypeId' => R::uuid(), 'fullName' => R::str(['optional' => true, 'min' => 2, 'max' => 120]), 'email' => R::email(['optional' => true])]);
    $ev = row("SELECT * FROM events WHERE slug = ? AND status = 'published'", [$a['slug']]);
    if (!$ev) throw not_found('Event not found.');
    if (!$u) {
        if (empty($b['email']) || empty($b['fullName'])) throw invalid(array_filter(['fullName' => empty($b['fullName']) ? 'Tell us your name.' : null, 'email' => empty($b['email']) ? 'We email you when a ticket comes up.' : null]));
        limit('waitlistmail', 10, 3600, email_key($b['email']));
        $u = tx(fn() => guest_buyer(['fullName' => $b['fullName'], 'email' => $b['email']]));
    }
    return json_out(['waitlist' => waitlist_join($u, $ev, $b['ticketTypeId'])], 201);
});

route('GET', '/api/public/waitlist/offer', function () {
    limit('offerview', 60, 60);
    $t = (string) qs('t', '');
    if (!preg_match('/^[A-Za-z0-9_-]{20,64}$/', $t)) throw not_found('This offer link is not valid.');
    return ['offer' => waitlist_offer_view(waitlist_offer($t))];
});

// The "leave the waitlist" link in the joining email (no account needed).
route('POST', '/api/public/waitlist/leave', function () {
    limit('waitleave', 30, 3600);
    $b = check(body(), ['token' => R::str(['max' => 600])]);
    $d = verify_link($b['token']);
    $w = $d && !empty($d['wl']) ? row('SELECT * FROM waitlist_entries WHERE id = ?', [$d['wl']]) : null;
    if (!$w) throw bad('This link is not valid any more.');
    return ['waitlist' => waitlist_leave($w, ['id' => $w['user_id']])];
});

route('GET', '/api/me/waitlists', function () {
    $u = require_auth();
    return ['waitlists' => array_map('waitlist_view', rows("SELECT * FROM waitlist_entries WHERE user_id = ? AND (status IN ('waiting','offered') OR updated_at > ?) ORDER BY created_at DESC LIMIT 100", [$u['id'], iso_in(-30 * 86400)]))];
});
route('POST', '/api/me/waitlists/:id/leave', function ($a) {
    $u = require_auth();
    $w = row('SELECT * FROM waitlist_entries WHERE id = ? AND user_id = ?', [$a['id'], $u['id']]);
    if (!$w) throw not_found('Waitlist place not found.');
    return ['waitlist' => waitlist_leave($w, $u)];
});

// ============================================================== exchange: sellers
function ex_bank_rule(): Closure
{
    return R::obj(['accountHolder' => R::str(['min' => 2, 'max' => 120]), 'bankName' => R::str(['min' => 2, 'max' => 60]), 'branchCode' => R::str(['min' => 4, 'max' => 10, 'pattern' => '/^\d{4,10}$/']),
        'accountNumber' => R::str(['min' => 6, 'max' => 20, 'pattern' => '/^[\d ]{6,20}$/', 'message' => 'Use the digits of the account number.'])], ['optional' => true]);
}
route('POST', '/api/me/tickets/:id/resale', function ($a) {
    $u = require_auth();
    limit('resalelist', 30, 3600, $u['id']);
    $b = check(body(), ['priceCents' => R::int(['min' => 1, 'max' => 100000000]), 'bank' => ex_bank_rule()]);
    return json_out(['listing' => resale_list($u, $a['id'], $b['priceCents'], $b['bank'] ?? null)], 201);
});
route('GET', '/api/me/resale', function () {
    $u = require_auth();
    $listings = rows('SELECT l.*, e.title, e.slug, e.starts_at, tt.name AS ticket_type FROM resale_listings l JOIN events e ON e.id = l.event_id JOIN ticket_types tt ON tt.id = l.ticket_type_id
                       WHERE l.seller_id = ? ORDER BY l.created_at DESC LIMIT 100', [$u['id']]);
    $payouts = array_column(rows('SELECT listing_id, reference, method, status, amount_cents, paid_at FROM resale_payouts WHERE user_id = ?', [$u['id']]), null, 'listing_id');
    return ['listings' => array_map(function ($l) use ($payouts) {
        $p = $payouts[$l['id']] ?? null;
        return resale_listing_view($l) + ['event' => ['title' => $l['title'], 'slug' => $l['slug'], 'startsAt' => $l['starts_at']], 'ticketType' => $l['ticket_type'],
            'payout' => $p ? ['reference' => $p['reference'], 'method' => $p['method'], 'status' => $p['status'], 'amountCents' => (int) $p['amount_cents'], 'paidAt' => $p['paid_at']] : null];
    }, $listings), 'policy' => ['capBps' => RESALE_PRICE_CAP_BPS, 'minPriceCents' => RESALE_MIN_PRICE_CENTS, 'sellerFeeCents' => RESALE_SELLER_FEE_CENTS, 'offerMinutes' => WAITLIST_OFFER_MINUTES]];
});
route('POST', '/api/me/resale/:id/cancel', function ($a) {
    $u = require_auth();
    return ['listing' => resale_cancel($u, $a['id'])];
});

// ============================================================== exchange: buyers
route('POST', '/api/public/resale/:id/orders', function ($a) {
    $b = check(body(), [
        'idempotencyKey' => R::idemKey(), 'offer' => R::str(['optional' => true, 'max' => 100]), 'buyerPhone' => R::phone(['optional' => true]),
        'marketingOptIn' => R::obj(['email' => R::bool(), 'sms' => R::bool()], ['optional' => true]),
        'guest' => R::obj(['fullName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(), 'phone' => R::phone(['optional' => true])], ['optional' => true]),
    ]);
    $u = ex_customer();
    if ($u) limit('order', 20, 60, $u['id']);
    else {
        limit('guestorder', 120, 3600);
        if (!empty($b['offer'])) {
            // The private offer link was sent to this person: they buy as themselves.
            $w = waitlist_offer($b['offer']);
            $u = exchange_buyer(row('SELECT * FROM users WHERE id = ?', [$w['user_id']]));
        } else {
            if (empty($b['guest'])) throw bad('Tell us your name and email so we can send your ticket.', ['guest' => 'Required.']);
            limit('guestordermail', 15, 3600, email_key((string) $b['guest']['email']));
            $u = tx(fn() => guest_buyer($b['guest']));
        }
    }
    $r = resale_checkout(exchange_buyer($u), $a['id'], $b['offer'] ?? null, $b);
    $o = $r['order'];
    $payment = null;
    if ($o['status'] === 'pending_payment') {
        try { $payment = payment_start($o); }
        catch (AppError $e) {
            tx(function () use ($o) { $cur = row('SELECT * FROM orders WHERE id = ?', [$o['id']]); if ($cur['status'] === 'pending_payment') { release_holds($cur); q("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [now_iso(), $o['id']]); } });
            throw $e;
        }
    }
    return json_out(['order' => ['reference' => $o['reference'], 'status' => $o['status'], 'totalCents' => (int) $o['total_cents'], 'expiresAt' => $o['expires_at']],
        'accessKey' => ex_customer() ? null : order_key($o['id']), 'payment' => $payment], $r['replay'] ? 200 : 201);
});

// ============================================================== top up a friend: invite
route('POST', '/api/me/wallets/:eventId/invite', function ($a) {
    $u = require_auth();
    limit('friendinvite', 10, 3600, $u['id']);
    $b = check(body(), ['email' => R::email()]);
    $ev = row('SELECT id, title, slug, organiser_id FROM events WHERE id = ?', [$a['eventId']]);
    if (!$ev) throw not_found('Event not found.');
    $f = user_by_email($b['email']);
    // The same answer whether or not they have an account (so it never says
    // who has one). Someone who has one is told they can be topped up now.
    $member = $f && (int) $f['guest'] === 0 && $f['status'] === 'active';
    outbox_enqueue(['to' => $b['email'], 'userId' => $member ? $f['id'] : null] + tpl($member ? 'friendInviteMember' : 'friendInvite', ['fromName' => $u['fullName'], 'event' => $ev, 'url' => base_url() . '/account', 'eventUrl' => base_url() . "/events/{$ev['slug']}"]));
    audit('wallet.friend_invited', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['to' => $b['email']]]);
    return ['ok' => true];
});

// ============================================================== finance: paying sellers
route('GET', '/api/admin/resale-payouts', function () {
    adm_any();
    $st = qs('status');
    return ['payouts' => $st ? resale_payout_rows('po.status = ?', [$st]) : resale_payout_rows('1 = 1', [])];
});
route('POST', '/api/admin/resale-payouts/:id/approve', function ($a) {
    $u = adm_finance();
    return ['payout' => resale_payout_rows('po.id = ?', [resale_payout_approve($u, $a['id'])['id']])[0]];
});
// The full account number, for making the EFT. Every view is in the audit log.
route('POST', '/api/admin/resale-payouts/:id/reveal-account', function ($a) {
    $u = adm_finance();
    limit('reveal', 30, 3600, $u['id']);
    $po = row("SELECT * FROM resale_payouts WHERE id = ? AND method = 'eft' AND status = 'approved'", [$a['id']]);
    if (!$po) throw conflict('Approve the payout first.', 'bad_transition');
    audit('resale.payout_account_revealed', ['actor' => $u, 'entityType' => 'resale_payout', 'entityId' => $po['id']]);
    return ['accountNumber' => decrypt_str((string) $po['bank_account_enc'])];
});
route('POST', '/api/admin/resale-payouts/:id/mark-paid', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['reference' => R::str(['min' => 3, 'max' => 120])]);
    return ['payout' => resale_payout_rows('po.id = ?', [resale_payout_mark_paid($u, $a['id'], $b['reference'])['id']])[0]];
});
route('POST', '/api/admin/resale-payouts/:id/retry', function ($a) {
    $u = adm_finance();
    return ['payout' => resale_payout_rows('po.id = ?', [resale_payout_process($a['id'], $u)['id']])[0]];
});
