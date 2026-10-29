<?php
// Waitlists for sold-out tickets, TicketRoom Exchange (fair resale) and
// topping up a friend's wallet. Routes in routes/exchange.php.
//
// Waitlist: one place in line per person per ticket type. When a ticket
// comes free (a refund, an order that was cancelled or not paid in time, or
// a resale listing) the next person in line gets a private link that holds
// it for WAITLIST_OFFER_MINUTES; if they don't take it, it goes to the next.
//
// Exchange: a ticket holder lists a ticket at no more than they paid for it.
// The waitlist gets the first offer; after that it shows on the event page
// as a resale ticket while the ticket type is sold out. The buyer pays the
// listing price plus the usual booking fee through the normal checkout. On
// payment the seller's ticket is voided (it scans as RESOLD) and the buyer
// gets a new ticket with a new code. The seller is paid the listing price:
// back to the card they paid with, or by EFT (finance approves and pays).
//
// Ledger (lib/payments.php conventions, test: accounts in test mode):
//   sale        provider:<p> DR price+fee, resale:sellers CR price, revenue:booking_fees CR fee
//   card payout resale:sellers DR, provider:<original provider> CR
//   EFT payout  resale:sellers DR, bank:payouts CR
// The organiser keeps what they were paid for the original sale; resale
// orders never touch an organiser's balance or sales figures.
declare(strict_types=1);

// ============================================================== policy
// Policy values for the owner to approve. Changing them changes the rules
// for new listings and offers only.
const RESALE_PRICE_CAP_BPS = 10000;          // a listing can ask at most 100% of what the seller paid (booking fee excluded)
const RESALE_MIN_PRICE_CENTS = 1000;         // and at least R10
const RESALE_CLOSE_MINUTES_BEFORE_DOORS = 0; // listings close when doors open (the start time if no doors time is set)
const RESALE_SELLER_FEE_CENTS = 0;           // the seller gets the full listing price
// The buyer pays the normal booking fee on the listing price: ticket_fee() in lib/core.php.
const WAITLIST_OFFER_MINUTES = 30;           // how long a waitlist offer holds a ticket
const WAITLIST_TICKETS_PER_PERSON = 1;       // one ticket per place in line
const RESALE_SELLERS = 'resale:sellers';     // ledger: owed to sellers until they are paid

function tr_upgrade_exchange(): void
{
    $add = ['events' => ['resale_enabled' => 'INTEGER NOT NULL DEFAULT 1'], 'orders' => ['resale_listing_id' => 'TEXT'], 'wallet_topups' => ['paid_by' => 'TEXT REFERENCES users(id)']];
    foreach ($add as $table => $cols) {
        $have = array_column(rows("PRAGMA table_info($table)"), 'name');
        foreach ($cols as $c => $def) if (!in_array($c, $have, true)) db()->exec("ALTER TABLE $table ADD COLUMN $c $def");
    }
    $sql = (string) file_get_contents(TR_APP . '/schema.sql');
    if (!preg_match('/-- exchange:begin\n(.*)-- exchange:end/s', $sql, $m)) throw new RuntimeException('schema.sql has no exchange block. Upload the complete TicketRoom package.');
    db()->exec($m[1]);
}

// ============================================================== shared
// A refund asked for or under way that covers this ticket. Until it is
// finished or turned down, the ticket can't be passed on, sold or scanned in.
// (The payments library may bring its own copy of this check.)
if (!function_exists('ticket_has_open_refund')) {
    function ticket_has_open_refund(string $ticketId): bool
    {
        return (bool) val("SELECT 1 FROM tickets t JOIN refunds r ON r.order_id = t.order_id
                            WHERE t.id = ? AND r.status IN ('requested','processing','manual_pending','failed') AND r.kind IN ('customer','event_cancelled','goodwill','unfulfilled')
                              AND (r.ticket_ids IS NULL OR r.ticket_ids IN ('', '[]') OR EXISTS (SELECT 1 FROM json_each(r.ticket_ids) j WHERE j.value = t.id)) LIMIT 1", [$ticketId]);
    }
}
function resale_cutoff(array $ev): string
{
    $at = to_unix($ev['doors_open_at'] ?: $ev['starts_at']) - RESALE_CLOSE_MINUTES_BEFORE_DOORS * 60;
    return iso_at($at);
}
function resale_open(array $ev): bool
{
    return $ev['status'] === 'published' && !empty($ev['resale_enabled']) && to_unix(resale_cutoff($ev)) > microtime(true);
}
// What the holder paid for the ticket, booking fee excluded (a promo
// discount is shared across the order's tickets, as for refunds).
function resale_face_value(array $t): int
{
    $o = row('SELECT subtotal_cents, discount_cents FROM orders WHERE id = ?', [$t['order_id']]);
    $gross = (int) ($o['subtotal_cents'] ?? 0);
    if ($gross <= 0) return 0;
    return (int) round((int) $t['price_cents'] * ($gross - (int) $o['discount_cents']) / $gross);
}
function resale_max_price(int $face): int { return intdiv($face * RESALE_PRICE_CAP_BPS, 10000); }
// The card payment a seller's money can go back to: their own order, paid by
// card through a provider, in the same mode (live or test) as the ticket.
function resale_card_payment(array $t, string $sellerId): ?array
{
    $o = row('SELECT user_id FROM orders WHERE id = ?', [$t['order_id']]);
    if (!$o || $o['user_id'] !== $sellerId) return null;
    $p = row("SELECT * FROM payments WHERE order_id = ? AND status IN ('confirmed','partially_refunded') ORDER BY created_at DESC LIMIT 1", [$t['order_id']]);
    if (!$p || (($p['environment'] !== 'live') !== ((int) $t['test'] === 1))) return null;
    $held = (int) val("SELECT COALESCE(SUM(amount_cents + fee_refund_cents),0) FROM refunds WHERE payment_id = ? AND status IN ('requested','processing','manual_pending','failed')", [$p['id']])
        + (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM resale_payouts WHERE payment_id = ? AND status IN ('processing','manual_pending','failed')", [$p['id']]);
    $p['room'] = (int) $p['amount_cents'] - (int) $p['refunded_cents'] - $held;
    return $p;
}
function exchange_buyer(array $u): array
{
    return ['id' => $u['id'], 'fullName' => $u['fullName'] ?? $u['full_name'], 'email' => $u['email'], 'phone' => $u['phone'] ?? null,
        'viaGuest' => !empty($u['viaGuest']), 'own' => !empty($u['own'])];
}

// ============================================================== waitlist
function waitlist_position(array $w): int
{
    return 1 + (int) val("SELECT count(*) FROM waitlist_entries WHERE ticket_type_id = ? AND status IN ('waiting','offered') AND created_at < ?", [$w['ticket_type_id'], $w['created_at']]);
}
function waitlist_view(array $w): array
{
    $e = row('SELECT e.title, e.slug, e.starts_at, e.venue_name, e.city, tt.name AS ticket_type, tt.price_cents FROM waitlist_entries w JOIN events e ON e.id = w.event_id JOIN ticket_types tt ON tt.id = w.ticket_type_id WHERE w.id = ?', [$w['id']]);
    $open = in_array($w['status'], ['waiting', 'offered'], true);
    return ['id' => $w['id'], 'status' => $w['status'], 'position' => $open ? waitlist_position($w) : null, 'offerKind' => $w['offer_kind'], 'offerExpiresAt' => $w['status'] === 'offered' ? $w['offer_expires_at'] : null,
        'createdAt' => $w['created_at'], 'event' => ['title' => $e['title'], 'slug' => $e['slug'], 'startsAt' => $e['starts_at'], 'venue' => $e['venue_name'], 'city' => $e['city']],
        'ticketType' => $e['ticket_type'], 'priceCents' => (int) $e['price_cents']];
}
function waitlist_leave_link(string $entryId): string { return sign_link(['wl' => $entryId], 120 * 86400); }

// Join the line for a sold-out ticket type. Joining twice keeps the first place.
function waitlist_join(array $u, array $ev, string $ticketTypeId): array
{
    return tx(function () use ($u, $ev, $ticketTypeId) {
        $tt = row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$ticketTypeId, $ev['id']]);
        if (!$tt || $tt['status'] !== 'on_sale') throw not_found('Ticket type not found.');
        $have = row("SELECT * FROM waitlist_entries WHERE ticket_type_id = ? AND user_id = ? AND status IN ('waiting','offered')", [$tt['id'], $u['id']]);
        if ($have) return waitlist_view($have) + ['already' => true];
        if (!sales_open($ev)) throw conflict('Ticket sales for this event are closed.', 'sales_closed');
        if ((int) $tt['quantity_total'] - (int) $tt['quantity_sold'] - (int) $tt['quantity_held'] > 0) throw conflict("{$tt['name']} tickets are still on sale. Grab yours now.", 'not_sold_out');
        $now = now_iso();
        $w = insert('waitlist_entries', ['id' => uuid(), 'event_id' => $ev['id'], 'ticket_type_id' => $tt['id'], 'user_id' => $u['id'], 'status' => 'waiting', 'created_at' => $now, 'updated_at' => $now]);
        $pos = waitlist_position($w);
        outbox_enqueue(['to' => $u['email'], 'userId' => $u['id']] + tpl('waitlistJoined', ['name' => $u['fullName'] ?? $u['full_name'] ?? '', 'event' => $ev, 'ticketType' => $tt['name'], 'position' => $pos,
            'leaveUrl' => base_url() . "/events/{$ev['slug']}?leave=" . rawurlencode(waitlist_leave_link($w['id'])), 'minutes' => WAITLIST_OFFER_MINUTES]));
        audit('waitlist.joined', ['actor' => $u, 'entityType' => 'waitlist_entry', 'entityId' => $w['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['ticketType' => $tt['id'], 'position' => $pos]]);
        // A resale ticket may already be waiting for someone in line.
        waitlist_sweep($ev['id']);
        return waitlist_view(row('SELECT * FROM waitlist_entries WHERE id = ?', [$w['id']])) + ['already' => false];
    });
}
function waitlist_leave(array $w, ?array $actor): array
{
    return tx(function () use ($w, $actor) {
        $w = row('SELECT * FROM waitlist_entries WHERE id = ?', [$w['id']]);
        if (!in_array($w['status'], ['waiting', 'offered'], true)) return waitlist_view($w);
        // While a checkout is open on the offer, that order holds the place and lets it go.
        $paying = $w['order_id'] && val("SELECT 1 FROM orders WHERE id = ? AND status = 'pending_payment'", [$w['order_id']]);
        if ($w['status'] === 'offered' && !$paying) waitlist_release_offer($w);
        q("UPDATE waitlist_entries SET status = 'left', offer_token_hash = NULL, updated_at = ? WHERE id = ?", [now_iso(), $w['id']]);
        audit('waitlist.left', ['actor' => $actor ?? ['id' => $w['user_id']], 'entityType' => 'waitlist_entry', 'entityId' => $w['id']]);
        waitlist_sweep($w['event_id']);
        return waitlist_view(row('SELECT * FROM waitlist_entries WHERE id = ?', [$w['id']]));
    });
}
// An offer that was not taken gives its ticket back: the held place to the
// ticket type, or the resale listing back to the exchange.
function waitlist_release_offer(array $w): void
{
    if ($w['offer_kind'] === 'primary') q('UPDATE ticket_types SET quantity_held = MAX(quantity_held - 1, 0) WHERE id = ?', [$w['ticket_type_id']]);
    elseif ($w['offer_kind'] === 'resale' && $w['listing_id']) q("UPDATE resale_listings SET status = 'active', updated_at = ? WHERE id = ? AND status = 'offered'", [now_iso(), $w['listing_id']]);
}
function waitlist_next(string $ticketTypeId): ?array
{
    return row("SELECT w.*, u.email, u.full_name, u.phone FROM waitlist_entries w JOIN users u ON u.id = w.user_id
                 WHERE w.ticket_type_id = ? AND w.status = 'waiting' AND u.status = 'active' ORDER BY w.created_at LIMIT 1", [$ticketTypeId]);
}
function waitlist_send_offer(array $w, array $ev, array $tt, string $kind, ?array $listing): void
{
    $token = random_token(24);
    $now = now_iso();
    $until = iso_in(WAITLIST_OFFER_MINUTES * 60);
    q("UPDATE waitlist_entries SET status = 'offered', offer_kind = ?, listing_id = ?, offer_token_hash = ?, offered_at = ?, offer_expires_at = ?, updated_at = ? WHERE id = ?",
        [$kind, $listing['id'] ?? null, sha256($token), $now, $until, $now, $w['id']]);
    $price = $listing ? (int) $listing['price_cents'] : (int) $tt['price_cents'];
    $url = base_url() . "/events/{$ev['slug']}?offer=$token";
    outbox_enqueue(['to' => $w['email'], 'userId' => $w['user_id']] + tpl('waitlistOffer', ['name' => $w['full_name'], 'event' => $ev, 'ticketType' => $tt['name'], 'priceCents' => $price,
        'feeCents' => $kind === 'primary' ? event_ticket_fee($ev, $price) : ticket_fee($price), 'resale' => $kind === 'resale', 'url' => $url, 'until' => $until, 'minutes' => WAITLIST_OFFER_MINUTES]));
    if ($w['phone'] && sms_ready()) {
        outbox_enqueue(['channel' => 'sms', 'to' => $w['phone'], 'userId' => $w['user_id'],
            'body' => "TicketRoom: a {$tt['name']} ticket for {$ev['title']} is yours if you want it. It's held for you until " . time_str($until) . ". Get it: $url"]);
    }
    audit('waitlist.offered', ['actor' => ['id' => null, 'primaryRole' => 'system'], 'entityType' => 'waitlist_entry', 'entityId' => $w['id'], 'organiserId' => $ev['organiser_id'],
        'details' => ['kind' => $kind, 'listing' => $listing['reference'] ?? null, 'until' => $until]]);
}
// Hands free tickets to the people in line, first come first served.
// Safe to call any time; runs in one transaction.
function waitlist_sweep(string $eventId): int
{
    return tx(function () use ($eventId) {
        $ev = row('SELECT * FROM events WHERE id = ?', [$eventId]);
        if (!$ev || !sales_open($ev)) return 0;
        $n = 0;
        $types = rows("SELECT tt.* FROM ticket_types tt WHERE tt.event_id = ? AND tt.status = 'on_sale' AND EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.ticket_type_id = tt.id AND w.status = 'waiting')", [$eventId]);
        foreach ($types as $tt) {
            // New places first (refunds, lapsed reservations, more tickets released)...
            while (true) {
                $used = (int) val('SELECT COALESCE(SUM((quantity_sold + quantity_held) * admits),0) FROM ticket_types WHERE event_id = ?', [$eventId]);
                if ($used + max(1, (int) $tt['admits']) > (int) $ev['capacity']) break;
                $w = waitlist_next($tt['id']);
                if (!$w) break;
                if (affected('UPDATE ticket_types SET quantity_held = quantity_held + 1 WHERE id = ? AND quantity_sold + quantity_held + 1 <= quantity_total', [$tt['id']]) === 0) break;
                waitlist_send_offer($w, $ev, $tt, 'primary', null);
                $n++;
            }
            // ...then resale tickets, oldest listing first.
            if (!resale_open($ev)) continue;
            foreach (rows("SELECT * FROM resale_listings WHERE ticket_type_id = ? AND status = 'active' AND test = ? ORDER BY created_at", [$tt['id'], pay_test() ? 1 : 0]) as $l) {
                $w = waitlist_next($tt['id']);
                if (!$w) break;
                if ($w['user_id'] === $l['seller_id']) continue;
                q("UPDATE resale_listings SET status = 'offered', updated_at = ? WHERE id = ? AND status = 'active'", [now_iso(), $l['id']]);
                waitlist_send_offer($w, $ev, $tt, 'resale', $l);
                $n++;
            }
        }
        return $n;
    });
}
// Offers that ran out pass to the next person in line.
function waitlist_expire_offers(?string $eventId = null): int
{
    // An offer with a checkout still open is settled when that order is paid or lapses.
    $due = rows("SELECT * FROM waitlist_entries w WHERE status = 'offered' AND offer_expires_at < ?" . ($eventId ? ' AND event_id = ?' : '')
        . " AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = w.order_id AND o.status = 'pending_payment') LIMIT 200", $eventId ? [now_iso(), $eventId] : [now_iso()]);
    $events = [];
    foreach ($due as $w) {
        tx(function () use ($w) {
            $cur = row('SELECT * FROM waitlist_entries WHERE id = ?', [$w['id']]);
            if ($cur['status'] !== 'offered' || ($cur['order_id'] && val("SELECT 1 FROM orders WHERE id = ? AND status = 'pending_payment'", [$cur['order_id']]))) return;
            waitlist_release_offer($cur);
            q("UPDATE waitlist_entries SET status = 'expired', offer_token_hash = NULL, updated_at = ? WHERE id = ?", [now_iso(), $cur['id']]);
            audit('waitlist.offer_expired', ['actor' => ['id' => null, 'primaryRole' => 'system'], 'entityType' => 'waitlist_entry', 'entityId' => $cur['id'], 'details' => ['kind' => $cur['offer_kind']]]);
        });
        $events[$w['event_id']] = true;
    }
    foreach (array_keys($events) as $id) waitlist_sweep($id);
    return count($due);
}
// The offer behind a private link, if it is still open.
function waitlist_offer(string $token): array
{
    $w = row('SELECT * FROM waitlist_entries WHERE offer_token_hash = ?', [sha256($token)]);
    if (!$w || $w['status'] !== 'offered') throw not_found('This offer has ended. It may have been used, or passed to the next person in line.');
    if (to_unix($w['offer_expires_at']) < microtime(true)) {
        waitlist_expire_offers($w['event_id']);
        throw conflict('This offer ran out and has gone to the next person in line. You can join the waitlist again.', 'offer_expired');
    }
    return $w;
}
function waitlist_offer_view(array $w): array
{
    $tt = row('SELECT id, name, price_cents FROM ticket_types WHERE id = ?', [$w['ticket_type_id']]);
    $u = row('SELECT full_name, email FROM users WHERE id = ?', [$w['user_id']]);
    $l = $w['listing_id'] ? row('SELECT id, reference, price_cents FROM resale_listings WHERE id = ?', [$w['listing_id']]) : null;
    $price = $l ? (int) $l['price_cents'] : (int) $tt['price_cents'];
    $event = row('SELECT service_fee_payer FROM events WHERE id = ?', [$w['event_id']]) ?? [];
    return ['kind' => $w['offer_kind'], 'expiresAt' => $w['offer_expires_at'], 'ticketType' => ['id' => $tt['id'], 'name' => $tt['name']], 'priceCents' => $price, 'feeCents' => $w['offer_kind'] === 'primary' ? event_ticket_fee($event, $price) : ticket_fee($price),
        'listingId' => $l['id'] ?? null, 'name' => $u['full_name'], 'email' => $u['email']];
}
// Inside create_order(): the held place is handed to this order.
function waitlist_take_primary(string $token, array $ev, array $items): string
{
    $w = waitlist_offer($token);
    if ($w['offer_kind'] !== 'primary' || $w['event_id'] !== $ev['id']) throw conflict('This offer is not for these tickets.', 'offer_mismatch');
    if (count($items) !== 1 || $items[0]['ticketTypeId'] !== $w['ticket_type_id'] || (int) $items[0]['quantity'] !== WAITLIST_TICKETS_PER_PERSON) {
        throw conflict('This offer is for ' . WAITLIST_TICKETS_PER_PERSON . ' ticket of the type you waited for.', 'offer_mismatch');
    }
    // A checkout already open on this offer: one payment at a time.
    if ($w['order_id'] && val("SELECT 1 FROM orders WHERE id = ? AND status = 'pending_payment'", [$w['order_id']])) {
        throw conflict('A payment for this ticket is already open. Finish it, or wait a few minutes and try again from the same link.', 'offer_in_checkout');
    }
    // The place held for the offer moves to the order. The offer itself stays
    // open until the tickets are issued: if the payment fails or is abandoned,
    // the place comes back to this person for the rest of the offer time.
    q('UPDATE ticket_types SET quantity_held = MAX(quantity_held - 1, 0) WHERE id = ?', [$w['ticket_type_id']]);
    audit('waitlist.checkout', ['actor' => ['id' => $w['user_id']], 'entityType' => 'waitlist_entry', 'entityId' => $w['id'], 'details' => ['kind' => 'primary']]);
    return $w['id'];
}
// A refunded ticket goes to the waitlist first: if people are waiting for its
// type, the place goes back on sale for them (inside refund_complete()).
function waitlist_tickets_returned(array $ticketIds, string $kind): void
{
    if (!$ticketIds || !in_array($kind, ['customer', 'goodwill'], true)) return;
    $events = [];
    foreach (rows('SELECT ticket_type_id, event_id, count(*) AS n FROM tickets WHERE id IN (' . placeholders($ticketIds) . ') GROUP BY ticket_type_id, event_id', $ticketIds) as $r) {
        $waiting = (int) val("SELECT count(*) FROM waitlist_entries WHERE ticket_type_id = ? AND status = 'waiting'", [$r['ticket_type_id']]);
        $free = min((int) $r['n'], $waiting);
        if ($free <= 0) continue;
        q('UPDATE ticket_types SET quantity_sold = MAX(quantity_sold - ?, 0) WHERE id = ?', [$free, $r['ticket_type_id']]);
        $events[$r['event_id']] = true;
    }
    foreach (array_keys($events) as $id) waitlist_sweep($id);
}

// ============================================================== exchange: listings
function resale_listing_view(array $l): array
{
    return ['id' => $l['id'], 'reference' => $l['reference'], 'ticketId' => $l['ticket_id'], 'status' => $l['status'], 'priceCents' => (int) $l['price_cents'], 'faceValueCents' => (int) $l['face_value_cents'],
        'feeCents' => ticket_fee((int) $l['price_cents']), 'payoutMethod' => $l['payout_method'], 'bank' => $l['bank_account_last4'] ? "{$l['bank_name']} ••••{$l['bank_account_last4']}" : null,
        'test' => (int) $l['test'] === 1, 'createdAt' => $l['created_at'], 'soldAt' => $l['sold_at'], 'closeReason' => $l['close_reason'], 'withdrawRequested' => !empty($l['withdraw_requested_at'])];
}
// What the ticket page needs to offer "Sell on TicketRoom Exchange".
function resale_ticket_info(array $t, string $userId): array
{
    $l = row("SELECT * FROM resale_listings WHERE ticket_id = ? AND status IN ('active','offered','held') ORDER BY created_at DESC LIMIT 1", [$t['id']]);
    $ev = ['status' => $t['event_status'], 'resale_enabled' => $t['resale_enabled'], 'doors_open_at' => $t['doors_open_at'], 'starts_at' => $t['starts_at']];
    $face = $t['status'] === 'valid' ? resale_face_value($t) : 0;
    $card = $face > 0 ? resale_card_payment($t, $userId) : null;
    return ['listing' => $l ? resale_listing_view($l) : null, 'open' => resale_open($ev), 'enabled' => (bool) $t['resale_enabled'], 'closesAt' => resale_cutoff($ev),
        'faceValueCents' => $face, 'maxPriceCents' => resale_max_price($face), 'minPriceCents' => min(RESALE_MIN_PRICE_CENTS, resale_max_price($face)),
        'payoutMethod' => $card && $card['room'] >= $face ? 'card' : 'eft'];
}
function resale_list(array $u, string $ticketId, int $price, ?array $bank): array
{
    return tx(function () use ($u, $ticketId, $price, $bank) {
        $t = owned_ticket($u['id'], $ticketId);
        $ev = row('SELECT * FROM events WHERE id = ?', [$t['event_id']]);
        if ($t['status'] !== 'valid') throw conflict('Only unused, valid tickets can be sold.', 'ticket_not_valid');
        if (ticket_has_open_refund($t['id'])) throw conflict('Refund in progress. This ticket cannot be sold while its refund is open.', 'refund_in_progress');
        if (empty($ev['resale_enabled'])) throw conflict('The organiser has switched off resale for this event. You can still pass your ticket to a friend.', 'resale_disabled');
        if (!resale_open($ev)) throw conflict('Resale for this event has closed. Listings close when the doors open.', 'resale_closed');
        if (val("SELECT 1 FROM ticket_transfers WHERE ticket_id = ? AND status = 'pending'", [$t['id']])) throw conflict('This ticket has a transfer waiting. Cancel the transfer first.', 'transfer_pending');
        if (val("SELECT 1 FROM resale_listings WHERE ticket_id = ? AND status IN ('active','offered','held')", [$t['id']])) throw conflict('This ticket is already up for resale.', 'already_listed');
        $face = resale_face_value($t);
        if ($face <= 0) throw conflict("Free tickets can't be sold. You can pass it on to a friend for free with Transfer.", 'free_ticket');
        $max = resale_max_price($face);
        if ($price > $max) throw new AppError(422, 'above_face_value', 'You can ask at most ' . format_zar($max) . ', what you paid for this ticket.', ['priceCents' => 'At most ' . format_zar($max) . '.']);
        if ($price < min(RESALE_MIN_PRICE_CENTS, $max)) throw new AppError(422, 'below_minimum', 'The lowest price is ' . format_zar(RESALE_MIN_PRICE_CENTS) . '.', ['priceCents' => 'At least ' . format_zar(RESALE_MIN_PRICE_CENTS) . '.']);
        $card = resale_card_payment($t, $u['id']);
        $method = $card && $card['room'] >= $face ? 'card' : 'eft';
        $now = now_iso();
        $row = ['id' => uuid(), 'reference' => reference('RS'), 'ticket_id' => $t['id'], 'event_id' => $ev['id'], 'ticket_type_id' => $t['ticket_type_id'], 'seller_id' => $u['id'],
            'price_cents' => $price, 'face_value_cents' => $face, 'payout_method' => $method, 'status' => 'active', 'test' => (int) $t['test'], 'created_at' => $now, 'updated_at' => $now];
        if ($method === 'eft') {
            if (!$bank) throw new AppError(422, 'bank_needed', 'Add the bank account we should pay you into. This ticket was not paid by your card, so we pay you by EFT.', ['bank' => 'Add your bank account.']);
            $digits = (string) preg_replace('/\D/', '', $bank['accountNumber']);
            $row += ['bank_account_holder' => $bank['accountHolder'], 'bank_name' => $bank['bankName'], 'bank_branch_code' => $bank['branchCode'], 'bank_account_enc' => encrypt_str($digits), 'bank_account_last4' => substr($digits, -4)];
        }
        $l = insert('resale_listings', $row);
        audit('resale.listed', ['actor' => $u, 'entityType' => 'resale_listing', 'entityId' => $l['id'], 'organiserId' => $ev['organiser_id'],
            'details' => ['reference' => $l['reference'], 'ticket' => $t['id'], 'price' => $price, 'faceValue' => $face, 'payout' => $method, 'test' => (int) $t['test'] === 1]]);
        // People on the waitlist get the first offer.
        waitlist_sweep($ev['id']);
        return resale_listing_view(row('SELECT * FROM resale_listings WHERE id = ?', [$l['id']]));
    });
}
// Takes a listing off the exchange. An open waitlist offer for it ends, and
// that person keeps their place in line.
function resale_close_listing(array $l, string $status, string $reason): void
{
    q('UPDATE resale_listings SET status = ?, close_reason = ?, updated_at = ? WHERE id = ?', [$status, $reason, now_iso(), $l['id']]);
    q("UPDATE waitlist_entries SET status = 'waiting', offer_kind = NULL, listing_id = NULL, offer_token_hash = NULL, offered_at = NULL, offer_expires_at = NULL, updated_at = ? WHERE listing_id = ? AND status = 'offered'", [now_iso(), $l['id']]);
}
function resale_cancel(array $u, string $id): array
{
    return tx(function () use ($u, $id) {
        $l = row('SELECT * FROM resale_listings WHERE id = ? AND seller_id = ?', [$id, $u['id']]);
        if (!$l) throw not_found('Listing not found.');
        if ($l['status'] === 'held') {
            // Someone is paying for it right now. If their payment does not go
            // through, it comes off instead of going back on the exchange.
            q('UPDATE resale_listings SET withdraw_requested_at = COALESCE(withdraw_requested_at, ?), updated_at = ? WHERE id = ?', [now_iso(), now_iso(), $l['id']]);
            audit('resale.withdraw_requested', ['actor' => $u, 'entityType' => 'resale_listing', 'entityId' => $l['id'], 'details' => ['reference' => $l['reference']]]);
            return resale_listing_view(row('SELECT * FROM resale_listings WHERE id = ?', [$l['id']]));
        }
        if (!in_array($l['status'], ['active', 'offered'], true)) throw conflict('This listing is already closed.', 'bad_transition');
        resale_close_listing($l, 'cancelled', 'seller');
        audit('resale.cancelled', ['actor' => $u, 'entityType' => 'resale_listing', 'entityId' => $l['id'], 'details' => ['reference' => $l['reference']]]);
        return resale_listing_view(row('SELECT * FROM resale_listings WHERE id = ?', [$l['id']]));
    });
}
// The organiser switched resale off (or the event changed): open listings close.
function resale_close_event(?array $actor, string $eventId, string $reason): int
{
    return tx(function () use ($actor, $eventId, $reason) {
        $n = 0;
        foreach (rows("SELECT * FROM resale_listings WHERE event_id = ? AND status IN ('active','offered')", [$eventId]) as $l) {
            resale_close_listing($l, 'closed', $reason);
            $n++;
        }
        if ($n) audit('resale.closed', ['actor' => $actor ?? ['id' => null, 'primaryRole' => 'system'], 'entityType' => 'event', 'entityId' => $eventId, 'details' => ['listings' => $n, 'reason' => $reason]]);
        return $n;
    });
}
// Listings shown on the event page: only while the ticket type is sold out
// and nobody in line is being offered them.
function resale_public_listings(array $ev, array $types): array
{
    if (!resale_open($ev)) return [];
    $soldOut = array_column(array_filter($types, fn($t) => (int) $t['remaining'] === 0), 'name', 'id');
    if (!$soldOut) return [];
    $out = [];
    foreach (rows("SELECT id, ticket_type_id, price_cents FROM resale_listings WHERE event_id = ? AND status = 'active' AND test = ? AND ticket_type_id IN (" . placeholders(array_keys($soldOut)) . ') ORDER BY price_cents, created_at LIMIT 50',
        array_merge([$ev['id'], pay_test() ? 1 : 0], array_keys($soldOut))) as $l) {
        $out[] = ['id' => $l['id'], 'ticketTypeId' => $l['ticket_type_id'], 'ticketType' => $soldOut[$l['ticket_type_id']], 'priceCents' => (int) $l['price_cents'], 'feeCents' => ticket_fee((int) $l['price_cents'])];
    }
    return $out;
}

// ============================================================== exchange: buying
// A resale order: the buyer pays the listing price plus the booking fee
// through the normal checkout. The listing is held while they pay.
function resale_checkout(array $buyer, string $listingId, ?string $offerToken, array $in): array
{
    return tx(function () use ($buyer, $listingId, $offerToken, $in) {
        $prior = row('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?', [$buyer['id'], $in['idempotencyKey']]);
        if ($prior) return ['order' => $prior, 'replay' => true];
        $l = row('SELECT * FROM resale_listings WHERE id = ?', [$listingId]);
        if (!$l) throw not_found('This resale ticket is no longer available.');
        $ev = row('SELECT * FROM events WHERE id = ?', [$l['event_id']]);
        $entry = null;
        if ($offerToken) {
            $entry = waitlist_offer($offerToken);
            if ($entry['offer_kind'] !== 'resale' || $entry['listing_id'] !== $l['id'] || $l['status'] !== 'offered') throw conflict('This offer is not for this ticket.', 'offer_mismatch');
        } elseif ($l['status'] !== 'active') {
            throw conflict('Someone else got this resale ticket first. Join the waitlist and we will tell you when the next one comes up.', 'listing_unavailable');
        }
        if (!resale_open($ev)) throw conflict('Resale for this event has closed.', 'resale_closed');
        if ((int) $l['test'] !== (pay_test() ? 1 : 0)) throw conflict('This resale ticket is not available right now.', 'listing_unavailable');
        if ($l['seller_id'] === $buyer['id']) throw conflict('This is your own ticket.', 'own_listing');
        // Holding a listing again and again without paying keeps it from everyone else.
        if ((int) val("SELECT count(*) FROM orders WHERE resale_listing_id = ? AND user_id = ? AND status IN ('expired','cancelled') AND created_at > ?", [$l['id'], $buyer['id'], iso_in(-3600)]) >= 2) {
            throw conflict('This resale ticket was held for you twice without payment. Try again in an hour, or join the waitlist.', 'listing_hold_limit');
        }
        if ((int) val("SELECT count(*) FROM orders WHERE resale_listing_id IS NOT NULL AND user_id = ? AND event_id = ? AND status = 'pending_payment'", [$buyer['id'], $ev['id']]) >= 2) {
            throw conflict('You already have resale tickets for this event waiting for payment. Finish paying for those first.', 'listing_hold_limit');
        }
        if (!pay_ready()) throw new AppError(503, 'payments_not_configured', 'Card payments are not switched on yet.');
        $fee = ticket_fee((int) $l['price_cents']);
        $now = now_iso();
        $order = insert('orders', [
            'id' => uuid(), 'reference' => reference('TR'), 'event_id' => $ev['id'], 'user_id' => $buyer['id'], 'status' => 'pending_payment',
            'buyer_name' => $buyer['fullName'], 'buyer_email' => $buyer['email'], 'buyer_phone' => $in['buyerPhone'] ?? $buyer['phone'],
            'subtotal_cents' => (int) $l['price_cents'], 'discount_cents' => 0, 'fee_cents' => $fee, 'total_cents' => (int) $l['price_cents'] + $fee, 'refunded_cents' => 0, 'organiser_fee_cents' => 0,
            'idempotency_key' => $in['idempotencyKey'], 'expires_at' => iso_in(HOLD_MINUTES * 60), 'created_at' => $now, 'updated_at' => $now, 'resale_listing_id' => $l['id'],
            'link_shows_tickets' => order_link_shows_tickets($buyer),
        ]);
        insert('order_items', ['id' => uuid(), 'order_id' => $order['id'], 'ticket_type_id' => $l['ticket_type_id'], 'quantity' => 1, 'unit_price_cents' => (int) $l['price_cents'], 'unit_fee_cents' => $fee]);
        q("UPDATE resale_listings SET status = 'held', held_order_id = ?, updated_at = ? WHERE id = ?", [$order['id'], $now, $l['id']]);
        if ($entry) {
            q("UPDATE waitlist_entries SET status = 'claimed', offer_token_hash = NULL, order_id = ?, updated_at = ? WHERE id = ?", [$order['id'], $now, $entry['id']]);
            audit('waitlist.claimed', ['actor' => $buyer, 'entityType' => 'waitlist_entry', 'entityId' => $entry['id'], 'details' => ['kind' => 'resale', 'order' => $order['reference']]]);
        }
        foreach (['email', 'sms'] as $ch) if (!empty($in['marketingOptIn'][$ch])) set_consent($buyer['id'], $ev['organiser_id'], $ch, true, "checkout:{$order['reference']}");
        audit('order.created', ['actor' => $buyer, 'entityType' => 'order', 'entityId' => $order['id'], 'organiserId' => $ev['organiser_id'],
            'details' => ['reference' => $order['reference'], 'total' => $order['total_cents'], 'resale' => $l['reference']]]);
        return ['order' => $order, 'replay' => false];
    });
}
// Inside release_holds(): an unpaid resale order lets go of its listing,
// which goes to the waitlist first, then back on the exchange.
function resale_release_order(array $order): void
{
    // The seller asked to take it off while it was held: it comes off now.
    if (affected("UPDATE resale_listings SET status = 'cancelled', close_reason = 'seller', held_order_id = NULL, updated_at = ? WHERE id = ? AND status = 'held' AND held_order_id = ? AND withdraw_requested_at IS NOT NULL", [now_iso(), $order['resale_listing_id'], $order['id']])) return;
    $n = affected("UPDATE resale_listings SET status = 'active', held_order_id = NULL, updated_at = ? WHERE id = ? AND status = 'held' AND held_order_id = ?", [now_iso(), $order['resale_listing_id'], $order['id']]);
    if ($n) waitlist_sweep($order['event_id']);
}
// Inside payment_apply()'s transaction, once the provider confirmed the money.
function resale_payment_confirmed(array $order, array $p): void
{
    $test = $p['environment'] !== 'live';
    $price = (int) $order['subtotal_cents'];
    ledger_post('resale_payment', $order['reference'], [['provider:' . $p['provider'], (int) $p['amount_cents']], [RESALE_SELLERS, -$price], ['revenue:booking_fees', -((int) $p['amount_cents'] - $price)]], $test);
    if ($order['status'] === 'paid') return;
    $l = row('SELECT * FROM resale_listings WHERE id = ?', [$order['resale_listing_id']]);
    $t = $l ? row('SELECT * FROM tickets WHERE id = ?', [$l['ticket_id']]) : null;
    $mine = $l && (($l['status'] === 'held' && $l['held_order_id'] === $order['id']) || $l['status'] === 'active');
    if (!$mine || !$t || $t['status'] !== 'valid' || $t['owner_user_id'] !== $l['seller_id']) {
        // The ticket went elsewhere while this payment was slow: full refund.
        q("UPDATE orders SET status = 'paid_unfulfilled', paid_at = ?, updated_at = ? WHERE id = ?", [now_iso(), now_iso(), $order['id']]);
        $order = row('SELECT * FROM orders WHERE id = ?', [$order['id']]);
        $rf = refund_create($order, null, [], true, 'unfulfilled', 'Payment arrived after the resale ticket was no longer available.', null, 'processing');
        $GLOBALS['TR_AFTER_COMMIT'][] = fn() => refund_process_safe($rf['id']);
        return;
    }
    $now = now_iso();
    // The seller's ticket stops working: screenshots of its QR code scan as RESOLD.
    q("UPDATE tickets SET status = 'revoked', revoked_reason = 'resold', updated_at = ? WHERE id = ?", [$now, $t['id']]);
    q("UPDATE ticket_transfers SET status = 'cancelled', completed_at = ? WHERE ticket_id = ? AND status = 'pending'", [$now, $t['id']]);
    $item = row('SELECT * FROM order_items WHERE order_id = ?', [$order['id']]);
    $new = insert('tickets', ['id' => uuid(), 'code' => new_pass_code(), 'qr_version' => 1, 'order_id' => $order['id'], 'order_item_id' => $item['id'], 'event_id' => $order['event_id'],
        'ticket_type_id' => $item['ticket_type_id'], 'owner_user_id' => $order['user_id'], 'holder_name' => $order['buyer_name'], 'price_cents' => $price, 'fee_cents' => (int) $item['unit_fee_cents'],
        'status' => 'valid', 'test' => $test ? 1 : 0, 'created_at' => $now, 'updated_at' => $now]);
    q("UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ?, test = ? WHERE id = ?", [$now, $now, $test ? 1 : 0, $order['id']]);
    q("UPDATE resale_listings SET status = 'sold', held_order_id = ?, new_ticket_id = ?, sold_at = ?, updated_at = ? WHERE id = ?", [$order['id'], $new['id'], $now, $now, $l['id']]);
    $payout = resale_payout_create(row('SELECT * FROM resale_listings WHERE id = ?', [$l['id']]), $t, $test);
    $order = row('SELECT * FROM orders WHERE id = ?', [$order['id']]);
    $ev = row('SELECT * FROM events WHERE id = ?', [$order['event_id']]);
    outbox_enqueue(['to' => $order['buyer_email'], 'userId' => $order['user_id']] + tpl('orderConfirmed', ['order' => $order, 'event' => $ev, 'ticketCount' => 1, 'guestLink' => order_email_link($order)]));
    $seller = row('SELECT email, full_name FROM users WHERE id = ?', [$l['seller_id']]);
    outbox_enqueue(['to' => $seller['email'], 'userId' => $l['seller_id']] + tpl('resaleSold', ['name' => $seller['full_name'], 'event' => $ev, 'amountCents' => (int) $payout['amount_cents'],
        'method' => $payout['method'], 'reference' => $payout['reference'], 'test' => $test]));
    audit('resale.sold', ['actor' => ['id' => $order['user_id']], 'entityType' => 'resale_listing', 'entityId' => $l['id'], 'organiserId' => $ev['organiser_id'],
        'details' => ['reference' => $l['reference'], 'order' => $order['reference'], 'oldTicket' => $t['id'], 'newTicket' => $new['id'], 'price' => $price, 'payout' => $payout['reference'], 'test' => $test]]);
    if ($payout['method'] === 'card') $GLOBALS['TR_AFTER_COMMIT'][] = fn() => resale_payout_process_safe($payout['id']);
}

// ============================================================== exchange: paying sellers
function resale_payout_create(array $l, array $t, bool $test): array
{
    $now = now_iso();
    $amount = (int) $l['price_cents'] - RESALE_SELLER_FEE_CENTS;
    $row = ['id' => uuid(), 'reference' => reference('RP'), 'listing_id' => $l['id'], 'user_id' => $l['seller_id'], 'event_id' => $l['event_id'], 'amount_cents' => $amount, 'test' => $test ? 1 : 0,
        'created_at' => $now, 'updated_at' => $now];
    $card = $l['payout_method'] === 'card' ? resale_card_payment($t, $l['seller_id']) : null;
    if ($card && $card['room'] >= $amount) {
        $row += ['method' => 'card', 'status' => 'processing', 'payment_id' => $card['id'], 'provider' => $card['provider']];
    } else {
        // EFT. A card payout that is no longer possible falls back to EFT; with no bank account on file, finance asks the seller for one.
        $row += ['method' => 'eft', 'status' => 'requested', 'bank_account_holder' => $l['bank_account_holder'], 'bank_name' => $l['bank_name'], 'bank_branch_code' => $l['bank_branch_code'],
            'bank_account_enc' => $l['bank_account_enc'], 'bank_account_last4' => $l['bank_account_last4'], 'failure_reason' => $l['bank_account_enc'] ? null : 'No bank account on file: ask the seller for one.'];
    }
    $p = insert('resale_payouts', $row);
    audit('resale.payout_created', ['actor' => ['id' => null, 'primaryRole' => 'system'], 'entityType' => 'resale_payout', 'entityId' => $p['id'], 'details' => ['reference' => $p['reference'], 'method' => $p['method'], 'amount' => $amount]]);
    return $p;
}
// Card payouts go back to the seller's original payment: the sandbox at
// once, Yoco by API, PayFast by finance in the PayFast dashboard.
function resale_payout_process(string $id, ?array $actor = null): array
{
    $po = row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
    if (!$po || $po['method'] !== 'card' || !in_array($po['status'], ['processing', 'failed'], true)) throw conflict('This payout cannot be sent now.', 'bad_transition');
    $p = row('SELECT * FROM payments WHERE id = ?', [$po['payment_id']]);
    q("UPDATE resale_payouts SET status = 'processing', failure_reason = NULL, updated_at = ? WHERE id = ?", [now_iso(), $id]);
    if ($p['provider'] === 'sandbox') return tx(fn() => resale_payout_complete($id, 'SANDBOX-' . $po['reference'], $actor));
    if ($p['provider'] !== 'yoco') {
        q("UPDATE resale_payouts SET status = 'manual_pending', updated_at = ? WHERE id = ?", [now_iso(), $id]);
        return row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
    }
    try {
        $ref = yoco_refund($p, (int) $po['amount_cents'], $po['id']);
    } catch (Throwable $e) {
        q("UPDATE resale_payouts SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr($e->getMessage(), 0, 240), now_iso(), $id]);
        audit('resale.payout_failed', ['actor' => $actor, 'entityType' => 'resale_payout', 'entityId' => $id, 'details' => ['error' => substr($e->getMessage(), 0, 120)]]);
        return row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
    }
    return tx(fn() => resale_payout_complete($id, $ref, $actor));
}
function resale_payout_process_safe(string $id): void
{
    try { resale_payout_process($id); } catch (Throwable $e) { error_log("[exchange] payout $id: " . $e->getMessage()); }
}
// The money reached the seller: books it, and tells them.
function resale_payout_complete(string $id, string $ref, ?array $actor): array
{
    $po = row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
    if ($po['status'] === 'paid') return $po;
    $now = now_iso();
    $amount = (int) $po['amount_cents'];
    if ($po['method'] === 'card') {
        $p = row('SELECT * FROM payments WHERE id = ?', [$po['payment_id']]);
        $pr = (int) $p['refunded_cents'] + $amount;
        q('UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$pr, $pr >= (int) $p['amount_cents'] ? 'refunded' : 'partially_refunded', $now, $p['id']]);
        q("UPDATE resale_payouts SET status = 'paid', provider_reference = ?, paid_by = ?, paid_at = ?, updated_at = ? WHERE id = ?", [$ref, $actor['id'] ?? null, $now, $now, $id]);
        ledger_post('resale_payout', $po['reference'], [[RESALE_SELLERS, $amount], ['provider:' . $p['provider'], -$amount]], (int) $po['test'] === 1);
    } else {
        q("UPDATE resale_payouts SET status = 'paid', bank_reference = ?, paid_by = ?, paid_at = ?, updated_at = ? WHERE id = ?", [$ref, $actor['id'] ?? null, $now, $now, $id]);
        ledger_post('resale_payout', $po['reference'], [[RESALE_SELLERS, $amount], ['bank:payouts', -$amount]], (int) $po['test'] === 1);
    }
    $u = row('SELECT email, full_name FROM users WHERE id = ?', [$po['user_id']]);
    $ev = row('SELECT title FROM events WHERE id = ?', [$po['event_id']]);
    outbox_enqueue(['to' => $u['email'], 'userId' => $po['user_id']] + tpl('resalePaid', ['name' => $u['full_name'], 'event' => $ev, 'amountCents' => $amount, 'reference' => $po['reference'],
        'method' => $po['method'], 'bank' => $po['bank_account_last4'] ? "{$po['bank_name']} ••••{$po['bank_account_last4']}" : null]));
    audit('resale.payout_paid', ['actor' => $actor, 'entityType' => 'resale_payout', 'entityId' => $id, 'details' => ['method' => $po['method'], 'amount' => $amount, 'reference' => $ref]]);
    return row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
}
function resale_payout_approve(array $u, string $id): array
{
    return tx(function () use ($u, $id) {
        $po = row("SELECT * FROM resale_payouts WHERE id = ? AND method = 'eft'", [$id]);
        if (!$po) throw not_found('Payout not found.');
        if ($po['status'] !== 'requested') throw conflict('This payout has already been approved.', 'bad_transition');
        if (!$po['bank_account_enc']) throw conflict('There is no bank account for this payout yet. Ask the seller for one.', 'bank_needed');
        q("UPDATE resale_payouts SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?", [$u['id'], now_iso(), $id]);
        audit('resale.payout_approved', ['actor' => $u, 'entityType' => 'resale_payout', 'entityId' => $id]);
        return row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
    });
}
function resale_payout_mark_paid(array $u, string $id, string $ref): array
{
    return tx(function () use ($u, $id, $ref) {
        $po = row('SELECT * FROM resale_payouts WHERE id = ?', [$id]);
        if (!$po) throw not_found('Payout not found.');
        $ok = ($po['method'] === 'eft' && $po['status'] === 'approved') || ($po['method'] === 'card' && $po['status'] === 'manual_pending');
        if (!$ok) throw conflict($po['method'] === 'eft' ? 'Approve the payout first.' : 'Only payouts waiting for a manual refund can be marked as paid.', 'bad_transition');
        return resale_payout_complete($id, $ref, $u);
    });
}
function resale_payout_rows(string $where, array $p): array
{
    return array_map(function ($r) {
        unset($r['bank_account_enc']);
        foreach (['amount_cents', 'test'] as $k) $r[$k] = (int) $r[$k];
        return $r;
    }, rows("SELECT po.*, u.full_name AS seller_name, u.email AS seller_email, e.title AS event_title, l.reference AS listing_reference, a.full_name AS approved_by_name
               FROM resale_payouts po JOIN users u ON u.id = po.user_id JOIN events e ON e.id = po.event_id JOIN resale_listings l ON l.id = po.listing_id LEFT JOIN users a ON a.id = po.approved_by
              WHERE $where ORDER BY po.created_at DESC LIMIT 300", $p));
}
// Ledger check: what resale:sellers holds matches the sellers not yet paid.
function resale_ledger_check(): array
{
    $ledger = -ledger_balance(RESALE_SELLERS);
    $expected = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM resale_payouts WHERE test = 0 AND status <> 'paid'");
    return ['account' => RESALE_SELLERS, 'ledgerCents' => $ledger, 'expectedCents' => $expected, 'ok' => $ledger === $expected];
}

// ============================================================== housekeeping
// Background job (every minute): offers that ran out move on, listings
// close at the doors (or when resale is switched off or the event changes),
// waitlists close with ticket sales, and free places go to people in line.
function exchange_housekeeping(): int
{
    $n = waitlist_expire_offers();
    foreach (rows("SELECT l.* FROM resale_listings l JOIN events e ON e.id = l.event_id WHERE l.status IN ('active','offered')
                     AND (e.status <> 'published' OR e.resale_enabled = 0 OR COALESCE(e.doors_open_at, e.starts_at) <= ?) LIMIT 200", [iso_in(RESALE_CLOSE_MINUTES_BEFORE_DOORS * 60)]) as $l) {
        tx(fn() => resale_close_listing($l, 'closed', 'resale_closed'));
        $n++;
    }
    foreach (rows("SELECT DISTINCT w.event_id FROM waitlist_entries w WHERE w.status = 'waiting' LIMIT 100") as $r) {
        $ev = row('SELECT * FROM events WHERE id = ?', [$r['event_id']]);
        if (!sales_open($ev) && ($ev['status'] !== 'published' || to_unix($ev['sales_end_at'] ?: $ev['ends_at']) <= microtime(true))) {
            $n += affected("UPDATE waitlist_entries SET status = 'closed', updated_at = ? WHERE event_id = ? AND status = 'waiting'", [now_iso(), $ev['id']]);
            continue;
        }
        $n += waitlist_sweep($ev['id']);
    }
    return $n;
}

// ============================================================== top up a friend
// The account a friend top-up goes to: a real customer account (not a guest
// checkout record), and not the payer's own.
function friend_wallet_user(string $email, array $payer): array
{
    $f = user_by_email($email);
    if (!$f || (int) $f['guest'] === 1 || $f['status'] !== 'active' || ($f['account_type'] ?? 'customer') !== 'customer') {
        throw conflict("We couldn't find a TicketRoom account for $email. Send them an invite, and once they've signed up you can top them up.", 'friend_not_found', ['friendEmail' => 'No TicketRoom account with this email.']);
    }
    if ($f['id'] === $payer['id']) throw conflict('That is your own email. Choose "Me" to top up your own balance.', 'friend_is_you', ['friendEmail' => 'This is you.']);
    return $f;
}
