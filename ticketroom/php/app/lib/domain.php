<?php
// Business rules: access control, consent, orders, tickets, admission, uploads.
declare(strict_types=1);

// ============================================================== access
// Out-of-tenancy objects return 404, not 403, so their existence is hidden.
function organiser_access(array $u, string $orgId, array $roles = ['owner', 'manager', 'marketing', 'finance', 'viewer']): array
{
    $org = row('SELECT o.*, m.role AS member_role FROM organisers o LEFT JOIN organiser_members m ON m.organiser_id = o.id AND m.user_id = ? WHERE o.id = ?', [$u['id'], $orgId]);
    if (!$org) throw not_found('Organiser not found.');
    if (has_role($u, 'admin')) return ['organiser' => $org, 'role' => $org['member_role'] ?: 'admin'];
    if (!$org['member_role']) throw not_found('Organiser not found.');
    if (!in_array($org['member_role'], $roles, true)) throw forbidden('Your role in this organisation does not allow that.');
    return ['organiser' => $org, 'role' => $org['member_role']];
}
function event_access(array $u, string $orgId, string $eventId, ?array $roles = null): array
{
    $a = $roles ? organiser_access($u, $orgId, $roles) : organiser_access($u, $orgId);
    $ev = row('SELECT * FROM events WHERE id = ? AND organiser_id = ?', [$eventId, $orgId]);
    if (!$ev) throw not_found('Event not found.');
    return $a + ['event' => $ev];
}
function event_staff_access(array $u, string $eventId, string $cap = 'can_scan'): array
{
    $ev = row('SELECT e.*, s.can_scan, s.can_manage_tags, m.role AS member_role FROM events e
                 LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = ?
                 LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = ? WHERE e.id = ?', [$u['id'], $u['id'], $eventId]);
    if (!$ev) throw not_found('Event not found.');
    if (has_role($u, 'admin', 'support') || in_array($ev['member_role'], ['owner', 'manager'], true) || !empty($ev[$cap])) return $ev;
    throw not_found('Event not found.');
}

// ============================================================== profile
function profile(string $userId): array
{
    $u = row('SELECT id, email, full_name, phone, email_verified_at, created_at FROM users WHERE id = ?', [$userId]);
    $u['has_pin'] = false;
    $u['platform_roles'] = array_column(rows('SELECT role FROM platform_roles WHERE user_id = ?', [$userId]), 'role');
    $u['organisers'] = array_map(fn($r) => ['id' => $r['id'], 'name' => $r['name'], 'status' => $r['status'], 'role' => $r['role']],
        rows('SELECT o.id, o.name, o.status, m.role FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = ? ORDER BY m.created_at', [$userId]));
    $u['vendors'] = [];
    $u['staff_events'] = array_map(fn($r) => ['eventId' => $r['id'], 'title' => $r['title'], 'canScan' => (bool) $r['can_scan'], 'canManageTags' => (bool) $r['can_manage_tags']],
        rows('SELECT e.id, e.title, s.can_scan, s.can_manage_tags FROM event_staff s JOIN events e ON e.id = s.event_id WHERE s.user_id = ?', [$userId]));
    return $u;
}

// ============================================================== consent (POPIA s69)
function set_consent(string $userId, ?string $orgId, string $channel, bool $granted, string $source): void
{
    $now = now_iso();
    q("INSERT INTO marketing_consents (id, user_id, organiser_id, channel, granted, source, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (user_id, COALESCE(organiser_id, ''), channel) DO UPDATE SET granted = excluded.granted, source = excluded.source, updated_at = excluded.updated_at",
        [uuid(), $userId, $orgId, $channel, $granted ? 1 : 0, $source, $now]);
    q('INSERT INTO consent_log (user_id, organiser_id, channel, granted, source, occurred_at) VALUES (?,?,?,?,?,?)', [$userId, $orgId, $channel, $granted ? 1 : 0, $source, $now]);
}
function consents_for(string $userId): array
{
    return rows('SELECT c.organiser_id, o.name AS organiser_name, c.channel, c.granted, c.updated_at FROM marketing_consents c LEFT JOIN organisers o ON o.id = c.organiser_id
                  WHERE c.user_id = ? ORDER BY (o.name IS NOT NULL), o.name, c.channel', [$userId]);
}

// ============================================================== orders
const MAX_TICKETS_PER_ORDER = 20;
const HOLD_MINUTES = 10;
function sales_open(array $e, ?float $now = null): bool
{
    $now ??= microtime(true);
    if ($e['status'] !== 'published') return false;
    if ($e['sales_start_at'] && to_unix($e['sales_start_at']) > $now) return false;
    return to_unix($e['sales_end_at'] ?: $e['ends_at']) > $now;
}
function card_payments_enabled(): bool { return false; } // the PHP edition has no payment gateway yet

// Prices come from the database only; client-sent prices are never read.
function order_quote(array $event, array $items, ?string $promoCode): array
{
    if (!sales_open($event)) throw conflict('Ticket sales for this event are closed.', 'sales_closed');
    $seen = [];
    $count = 0;
    $lines = [];
    foreach ($items as $it) {
        if (isset($seen[$it['ticketTypeId']])) throw bad('Each ticket type may appear once.');
        $seen[$it['ticketTypeId']] = true;
        $tt = row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$it['ticketTypeId'], $event['id']]);
        if (!$tt || $tt['status'] !== 'on_sale') throw conflict('A selected ticket type is not on sale.', 'ticket_type_unavailable');
        $now = microtime(true);
        if (($tt['sales_start_at'] && to_unix($tt['sales_start_at']) > $now) || ($tt['sales_end_at'] && to_unix($tt['sales_end_at']) <= $now)) throw conflict("{$tt['name']} is not on sale right now.", 'ticket_type_unavailable');
        if ($it['quantity'] > $tt['per_order_limit']) throw conflict("You can buy at most {$tt['per_order_limit']} × {$tt['name']} per order.", 'limit_exceeded');
        $count += $it['quantity'];
        $lines[] = ['ticketType' => $tt, 'quantity' => $it['quantity'], 'unitPrice' => (int) $tt['price_cents'], 'unitFee' => ticket_fee((int) $tt['price_cents'])];
    }
    if ($count === 0) throw bad('Choose at least one ticket.');
    if ($count > MAX_TICKETS_PER_ORDER) throw conflict('At most ' . MAX_TICKETS_PER_ORDER . ' tickets per order.', 'limit_exceeded');
    $subtotal = array_sum(array_map(fn($l) => $l['unitPrice'] * $l['quantity'], $lines));
    $discount = 0;
    $promo = null;
    if ($promoCode) {
        $promo = row('SELECT * FROM promo_codes WHERE event_id = ? AND upper(code) = upper(?) AND active = 1 AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to > ?)
                       AND (max_uses IS NULL OR used_count < max_uses)', [$event['id'], $promoCode, now_iso(), now_iso()]);
        if (!$promo) throw conflict('That promo code is not valid for this event.', 'promo_invalid');
        $discount = $promo['kind'] === 'percent' ? bps_of($subtotal, (int) $promo['value'] * 100) : min((int) $promo['value'], $subtotal);
    }
    $fee = array_sum(array_map(fn($l) => $l['unitFee'] * $l['quantity'], $lines));
    if ($subtotal - $discount === 0) { $fee = 0; foreach ($lines as &$l) $l['unitFee'] = 0; unset($l); }
    return ['lines' => $lines, 'subtotal' => $subtotal, 'discount' => $discount, 'fee' => $fee, 'total' => $subtotal - $discount + $fee, 'promo' => $promo];
}
function public_quote(array $qt): array
{
    return [
        'lines' => array_map(fn($l) => ['ticketTypeId' => $l['ticketType']['id'], 'name' => $l['ticketType']['name'], 'quantity' => $l['quantity'], 'unitPriceCents' => $l['unitPrice'], 'unitFeeCents' => $l['unitFee']], $qt['lines']),
        'subtotalCents' => $qt['subtotal'], 'discountCents' => $qt['discount'], 'feeCents' => $qt['fee'], 'totalCents' => $qt['total'],
        'promoCode' => $qt['promo']['code'] ?? null, 'currency' => 'ZAR',
    ];
}
function create_order(array $user, array $in): array
{
    return tx(function () use ($user, $in) {
        $prior = row('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?', [$user['id'], $in['idempotencyKey']]);
        if ($prior) return ['order' => $prior, 'replay' => true];
        $event = row('SELECT * FROM events WHERE slug = ?', [$in['eventSlug']]);
        if (!$event) throw not_found('Event not found.');
        $qt = order_quote($event, $in['items'], $in['promoCode'] ?? null);
        $used = (int) val('SELECT COALESCE(SUM(quantity_sold + quantity_held),0) FROM ticket_types WHERE event_id = ?', [$event['id']]);
        $wanted = array_sum(array_column($qt['lines'], 'quantity'));
        if ($used + $wanted > $event['capacity']) throw conflict('Not enough tickets left for this event.', 'sold_out');
        if ($qt['total'] > 0) throw new AppError(503, 'payments_not_configured', 'Card payments are not switched on yet. Free tickets are available; paid tickets go on sale soon.');
        foreach ($qt['lines'] as $l) {
            if (affected('UPDATE ticket_types SET quantity_held = quantity_held + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$l['quantity'], $l['ticketType']['id'], $l['quantity']]) === 0) {
                throw conflict("Not enough {$l['ticketType']['name']} tickets left.", 'sold_out');
            }
        }
        if ($qt['promo']) q('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?', [$qt['promo']['id']]);
        $trackingId = !empty($in['ref']) ? val('SELECT id FROM tracking_links WHERE event_id = ? AND code = ?', [$event['id'], $in['ref']]) : null;
        $orgBps = val('SELECT commission_bps FROM organisers WHERE id = ?', [$event['organiser_id']]);
        $now = now_iso();
        $order = insert('orders', [
            'id' => uuid(), 'reference' => reference('TR'), 'event_id' => $event['id'], 'user_id' => $user['id'], 'status' => 'pending_payment',
            'buyer_name' => $user['fullName'], 'buyer_email' => $user['email'], 'buyer_phone' => $in['buyerPhone'] ?? $user['phone'],
            'subtotal_cents' => $qt['subtotal'], 'discount_cents' => $qt['discount'], 'fee_cents' => $qt['fee'], 'total_cents' => $qt['total'], 'refunded_cents' => 0,
            'organiser_fee_cents' => bps_of($qt['subtotal'] - $qt['discount'], $orgBps === null ? (int) cfg('fees.organiserCommissionBps', 500) : (int) $orgBps),
            'promo_code_id' => $qt['promo']['id'] ?? null, 'tracking_link_id' => $trackingId ?: null, 'idempotency_key' => $in['idempotencyKey'],
            'expires_at' => iso_in(HOLD_MINUTES * 60), 'created_at' => $now, 'updated_at' => $now,
        ]);
        foreach ($qt['lines'] as $l) {
            insert('order_items', ['id' => uuid(), 'order_id' => $order['id'], 'ticket_type_id' => $l['ticketType']['id'], 'quantity' => $l['quantity'], 'unit_price_cents' => $l['unitPrice'], 'unit_fee_cents' => $l['unitFee']]);
        }
        foreach (['email', 'sms'] as $ch) if (!empty($in['marketingOptIn'][$ch])) set_consent($user['id'], $event['organiser_id'], $ch, true, "checkout:{$order['reference']}");
        $order = fulfil_order($order['id'])['order'];
        audit('order.created', ['actor' => $user, 'entityType' => 'order', 'entityId' => $order['id'], 'organiserId' => $event['organiser_id'], 'details' => ['reference' => $order['reference'], 'total' => $order['total_cents']]]);
        return ['order' => $order, 'replay' => false];
    });
}
// Converts holds into sales and issues tickets (free orders, in this edition).
function fulfil_order(string $orderId): array
{
    $order = row('SELECT * FROM orders WHERE id = ?', [$orderId]);
    if (in_array($order['status'], ['paid', 'paid_unfulfilled', 'refunded', 'partially_refunded'], true)) return ['order' => $order];
    $items = rows('SELECT * FROM order_items WHERE order_id = ?', [$orderId]);
    foreach ($items as $it) q('UPDATE ticket_types SET quantity_held = quantity_held - ?, quantity_sold = quantity_sold + ? WHERE id = ?', [$it['quantity'], $it['quantity'], $it['ticket_type_id']]);
    $now = now_iso();
    q("UPDATE orders SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?", [$now, $now, $orderId]);
    $order = row('SELECT * FROM orders WHERE id = ?', [$orderId]);
    $n = 0;
    foreach ($items as $it) {
        for ($i = 0; $i < $it['quantity']; $i++) {
            insert('tickets', ['id' => uuid(), 'code' => random_code(10), 'qr_version' => 1, 'order_id' => $orderId, 'order_item_id' => $it['id'], 'event_id' => $order['event_id'],
                'ticket_type_id' => $it['ticket_type_id'], 'owner_user_id' => $order['user_id'], 'holder_name' => $order['buyer_name'], 'price_cents' => $it['unit_price_cents'],
                'fee_cents' => $it['unit_fee_cents'], 'status' => 'valid', 'created_at' => $now, 'updated_at' => $now]);
            $n++;
        }
    }
    $event = row('SELECT * FROM events WHERE id = ?', [$order['event_id']]);
    outbox_enqueue(['to' => $order['buyer_email'], 'userId' => $order['user_id']] + tpl('orderConfirmed', ['order' => $order, 'event' => $event, 'ticketCount' => $n]));
    return ['order' => $order];
}
function release_holds(array $order): void
{
    foreach (rows('SELECT * FROM order_items WHERE order_id = ?', [$order['id']]) as $it) q('UPDATE ticket_types SET quantity_held = MAX(quantity_held - ?, 0) WHERE id = ?', [$it['quantity'], $it['ticket_type_id']]);
    if ($order['promo_code_id']) q('UPDATE promo_codes SET used_count = used_count - 1 WHERE id = ? AND used_count > 0', [$order['promo_code_id']]);
}
function expire_due_orders(): int
{
    $n = 0;
    foreach (rows("SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at < ? LIMIT 100", [now_iso()]) as $o) {
        tx(function () use ($o, &$n) {
            $order = row('SELECT * FROM orders WHERE id = ?', [$o['id']]);
            if ($order['status'] !== 'pending_payment') return;
            release_holds($order);
            q("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?", [now_iso(), $order['id']]);
            $n++;
        });
    }
    return $n;
}
function order_for_user(array $user, string $ref): array
{
    $o = row('SELECT o.*, e.title, e.slug, e.starts_at, e.venue_name, e.city FROM orders o JOIN events e ON e.id = o.event_id WHERE o.reference = ? AND o.user_id = ?', [$ref, $user['id']]);
    if (!$o) throw not_found('Order not found.');
    $items = rows('SELECT oi.quantity, oi.unit_price_cents, oi.unit_fee_cents, tt.name FROM order_items oi JOIN ticket_types tt ON tt.id = oi.ticket_type_id WHERE oi.order_id = ?', [$o['id']]);
    return ['order' => $o, 'items' => $items];
}

// ============================================================== tickets
// QR payload TR1.<code>.<version>.<sig>: random code + HMAC, so guessed or
// edited payloads fail before any lookup; bumping qr_version voids old copies.
function qr_sig(string $code, int $version): string { return substr(b64url(hmac_raw(key_hex('qr'), "T|$code|$version")), 0, 22); }
function qr_payload(array $t): string { return "TR1.{$t['code']}.{$t['qr_version']}." . qr_sig($t['code'], (int) $t['qr_version']); }
function qr_parse(?string $input): ?array
{
    $s = trim((string) $input);
    if (preg_match('/^TR1\.([2-9A-HJ-NP-TV-Z]{10})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/', $s, $m)) {
        return safe_equal(qr_sig($m[1], (int) $m[2]), $m[3]) ? ['code' => $m[1], 'version' => (int) $m[2], 'signed' => true] : null;
    }
    $typed = preg_replace('/[\s-]/', '', strtoupper($s));
    return preg_match('/^[2-9A-HJ-NP-TV-Z]{10}$/', $typed) ? ['code' => $typed, 'signed' => false] : null;
}
function tickets_for_user(string $userId): array
{
    $list = rows("SELECT t.id, t.code, t.status, t.holder_name, t.admitted_at, t.qr_version, t.price_cents,
                         tt.name AS ticket_type, e.id AS event_id, e.title, e.slug, e.venue_name, e.city, e.starts_at, e.ends_at,
                         e.status AS event_status, e.transfers_enabled, e.image_upload_id, e.category, o.reference AS order_reference
                    FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id
                   WHERE t.owner_user_id = ? ORDER BY e.starts_at, t.created_at", [$userId]);
    foreach ($list as &$t) {
        $tr = row("SELECT id, to_email, expires_at FROM ticket_transfers WHERE ticket_id = ? AND status = 'pending'", [$t['id']]);
        $t['pending_transfer'] = $tr ? ['id' => $tr['id'], 'toEmail' => $tr['to_email'], 'expiresAt' => $tr['expires_at']] : null;
        $t['qrPayload'] = $t['status'] === 'valid' ? qr_payload($t) : null;
        unset($t['qr_version']);
    }
    return $list;
}
function owned_ticket(string $userId, string $ticketId): array
{
    $t = row('SELECT t.*, e.title, e.starts_at, e.status AS event_status, e.transfers_enabled FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = ? AND t.owner_user_id = ?', [$ticketId, $userId]);
    if (!$t) throw not_found('Ticket not found.');
    return $t;
}
function start_transfer(array $user, string $ticketId, string $toEmail): array
{
    if ($toEmail === strtolower($user['email'])) throw bad('You already own this ticket.');
    return tx(function () use ($user, $ticketId, $toEmail) {
        $t = owned_ticket($user['id'], $ticketId);
        if (!$t['transfers_enabled']) throw conflict('The organiser has switched off transfers for this event.', 'transfers_disabled');
        if ($t['status'] !== 'valid') throw conflict('Only unused, valid tickets can be transferred.', 'ticket_not_valid');
        if ($t['event_status'] !== 'published' || to_unix($t['starts_at']) <= microtime(true)) throw conflict('Transfers close when the event starts.', 'transfer_closed');
        if (val("SELECT 1 FROM ticket_transfers WHERE ticket_id = ? AND status = 'pending'", [$t['id']])) throw conflict('This ticket already has a transfer waiting. Cancel it first.', 'duplicate');
        $token = random_token(24);
        $recipient = val("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", [$toEmail]);
        $tr = insert('ticket_transfers', ['id' => uuid(), 'ticket_id' => $t['id'], 'from_user_id' => $user['id'], 'to_email' => $toEmail, 'to_user_id' => $recipient ?: null,
            'claim_token_hash' => sha256($token), 'status' => 'pending', 'created_at' => now_iso(), 'expires_at' => iso_in(7 * 86400)]);
        outbox_enqueue(['to' => $toEmail, 'userId' => $recipient ?: null] + tpl('transferOffer', ['fromName' => $user['fullName'], 'event' => $t, 'claimUrl' => base_url() . "/account#/claim/$token"]));
        audit('ticket.transfer_started', ['actor' => $user, 'entityType' => 'ticket', 'entityId' => $t['id'], 'details' => ['toEmail' => $toEmail]]);
        return ['id' => $tr['id'], 'expiresAt' => $tr['expires_at']] + (cfg('dev') ? ['devClaimToken' => $token] : []);
    });
}
function claim_transfer(array $user, ?string $token, ?string $transferId): array
{
    return tx(function () use ($user, $token, $transferId) {
        $tr = $token ? row('SELECT * FROM ticket_transfers WHERE claim_token_hash = ?', [sha256($token)]) : row('SELECT * FROM ticket_transfers WHERE id = ? AND to_user_id = ?', [$transferId, $user['id']]);
        if (!$tr) throw not_found('This transfer link is not valid.');
        if (!$token && !$user['emailVerified']) throw forbidden('Confirm your email address first, or use the link in the transfer email.');
        if ($tr['status'] !== 'pending') throw conflict('This transfer has already been completed or cancelled.', 'transfer_closed');
        if (to_unix($tr['expires_at']) < microtime(true)) {
            q("UPDATE ticket_transfers SET status = 'expired' WHERE id = ?", [$tr['id']]);
            throw conflict('This transfer has expired. Ask the sender to send it again.', 'transfer_expired');
        }
        if ($tr['from_user_id'] === $user['id']) throw bad('You cannot accept your own transfer.');
        $t = row('SELECT t.*, e.title, e.starts_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.id = ?', [$tr['ticket_id']]);
        if ($t['owner_user_id'] !== $tr['from_user_id'] || $t['status'] !== 'valid') {
            q("UPDATE ticket_transfers SET status = 'cancelled', completed_at = ? WHERE id = ?", [now_iso(), $tr['id']]);
            throw conflict('This ticket can no longer be transferred.', 'ticket_not_valid');
        }
        q('UPDATE tickets SET owner_user_id = ?, holder_name = ?, qr_version = qr_version + 1, updated_at = ? WHERE id = ?', [$user['id'], $user['fullName'], now_iso(), $t['id']]);
        q("UPDATE ticket_transfers SET status = 'accepted', to_user_id = ?, completed_at = ? WHERE id = ?", [$user['id'], now_iso(), $tr['id']]);
        $sender = val('SELECT email FROM users WHERE id = ?', [$tr['from_user_id']]);
        outbox_enqueue(['to' => $sender, 'userId' => $tr['from_user_id']] + tpl('transferDone', ['event' => $t, 'toEmail' => $user['email']]));
        audit('ticket.transfer_accepted', ['actor' => $user, 'entityType' => 'ticket', 'entityId' => $t['id'], 'details' => ['from' => $tr['from_user_id']]]);
        return ['ticketId' => $t['id'], 'eventTitle' => $t['title']];
    });
}
const ADMIT_BEFORE_H = 12;
const ADMIT_AFTER_H = 6;
// One IMMEDIATE transaction per scan: two gates scanning one ticket at the
// same moment are serialised, so exactly one is admitted.
function admit(array $staff, array $b): array
{
    return tx(function () use ($staff, $b) {
        $eventId = $b['eventId'];
        $ev = row('SELECT id, title, status, starts_at, ends_at FROM events WHERE id = ?', [$eventId]);
        $log = function (string $outcome, ?string $ticketId = null) use ($eventId, $staff, $b) {
            q('INSERT INTO admission_log (event_id, ticket_id, scanned_by, outcome, gate, occurred_at) VALUES (?,?,?,?,?,?)', [$eventId, $ticketId, $staff['id'], $outcome, $b['gate'] ?? null, now_iso()]);
        };
        $now = microtime(true);
        if ($ev['status'] !== 'published' || $now < to_unix($ev['starts_at']) - ADMIT_BEFORE_H * 3600 || $now > to_unix($ev['ends_at']) + ADMIT_AFTER_H * 3600) {
            $log('event_not_live');
            return ['outcome' => 'event_not_live', 'message' => 'This event is not open for entry right now.'];
        }
        if (empty($b['payload'])) { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'Wristbands and tags are not available yet. Scan the ticket QR code.']; }
        $p = qr_parse($b['payload']);
        if (!$p) { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'Not a TicketRoom ticket, or the code has been altered.']; }
        $t = row('SELECT * FROM tickets WHERE code = ?', [$p['code']]);
        if (!$t) { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'Ticket not found.']; }
        if ($p['signed'] && $p['version'] !== (int) $t['qr_version']) { $log('invalid', $t['id']); return ['outcome' => 'invalid', 'message' => 'This QR code was replaced (ticket transferred or reissued). Ask for the current ticket.']; }
        if ($t['event_id'] !== $eventId) { $log('wrong_event', $t['id']); return ['outcome' => 'wrong_event', 'message' => 'This ticket is for a different event.']; }
        if (in_array($t['status'], ['revoked', 'refunded'], true)) { $log($t['status'], $t['id']); return ['outcome' => $t['status'], 'message' => "This ticket was {$t['status']}."]; }
        $type = val('SELECT name FROM ticket_types WHERE id = ?', [$t['ticket_type_id']]);
        $at = now_iso();
        if (affected("UPDATE tickets SET status = 'used', admitted_at = ?, admitted_by = ?, updated_at = ? WHERE id = ? AND status = 'valid'", [$at, $staff['id'], $at, $t['id']]) === 0) {
            $log('already_used', $t['id']);
            return ['outcome' => 'already_used', 'message' => 'Already scanned.', 'admittedAt' => $t['admitted_at'], 'holderName' => $t['holder_name'], 'ticketType' => $type];
        }
        $log('admitted', $t['id']);
        return ['outcome' => 'admitted', 'message' => 'Admit', 'holderName' => $t['holder_name'], 'ticketType' => $type, 'code' => $t['code']];
    });
}

// ============================================================== uploads
function sniff_image(string $buf): ?string
{
    if (str_starts_with($buf, "\x89PNG\r\n\x1a\n")) return 'image/png';
    if (str_starts_with($buf, "\xFF\xD8\xFF")) return 'image/jpeg';
    if (substr($buf, 0, 4) === 'RIFF' && substr($buf, 8, 4) === 'WEBP') return 'image/webp';
    return null;
}
function store_upload(string $ownerId, ?string $orgId, string $buf): string
{
    if ($buf === '' || strlen($buf) > 2097152) throw new AppError(413, 'too_large', 'Images must be 2 MB or smaller.');
    $mime = sniff_image($buf);
    if (!$mime) throw new AppError(415, 'unsupported_media_type', 'Upload a PNG, JPEG or WebP image.');
    $id = uuid();
    $dir = data_dir() . '/uploads';
    if (!is_dir($dir)) mkdir($dir, 0750, true);
    file_put_contents("$dir/$id", $buf, LOCK_EX);
    insert('uploads', ['id' => $id, 'owner_id' => $ownerId, 'organiser_id' => $orgId, 'mime_type' => $mime, 'size_bytes' => strlen($buf), 'sha256' => hash('sha256', $buf), 'created_at' => now_iso()]);
    return $id;
}
function raw_body(): string { return (string) file_get_contents('php://input', false, null, 0, 2097153); }
