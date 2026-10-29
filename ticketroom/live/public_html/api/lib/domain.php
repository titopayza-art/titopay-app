<?php
// Business rules: access control, consent, orders, tickets, admission, uploads.
declare(strict_types=1);

// ============================================================== access
// Out-of-tenancy objects return 404, not 403, so their existence is hidden.
// ============================================================== account types
// One account, one portal. Customers buy tickets, organisers run events,
// staff run TicketRoom; each signs in on its own portal only.
const ACCOUNT_PORTALS = ['customer' => '/account', 'organiser' => '/organisers', 'staff' => '/admin'];
const ACCOUNT_NAMES = ['customer' => 'customer', 'organiser' => 'organiser', 'staff' => 'TicketRoom staff'];
// Which accounts each sign-in box accepts ('site' is the public website).
// The vendor till ('pos') is for vendor staff (customer accounts) and the organiser's own team.
const PORTAL_ACCEPTS = ['site' => ['customer', 'organiser'], 'customer' => ['customer'], 'organiser' => ['organiser'], 'admin' => ['staff'], 'scanner' => ['customer', 'organiser'], 'pos' => ['customer', 'organiser']];
function account_type(?array $u): string { return (string) ($u['account_type'] ?? $u['accountType'] ?? 'customer'); }
// Where an emailed link for this account opens: its own portal.
function portal_link(array $u, string $hash): string { return base_url() . ACCOUNT_PORTALS[account_type($u)] . "#/$hash"; }
function require_account(string ...$types): array
{
    $u = require_auth();
    if (!in_array(account_type($u), $types, true)) throw forbidden('This part of TicketRoom is not for your kind of account.');
    return $u;
}

function organiser_access(array $u, string $orgId, array $roles = ['owner', 'manager', 'marketing', 'finance', 'viewer']): array
{
    $org = row('SELECT o.*, m.role AS member_role FROM organisers o LEFT JOIN organiser_members m ON m.organiser_id = o.id AND m.user_id = ? WHERE o.id = ?', [$u['id'], $orgId]);
    if (!$org) throw not_found('Organiser not found.');
    // Only the organisation's own team works here. TicketRoom staff oversee
    // organisers from the admin portal and never act as one (no bank details,
    // payouts, campaigns or replies in an organiser's name).
    if (account_type($u) !== 'organiser') throw not_found('Organiser not found.');
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
    $ev = row('SELECT e.*, s.can_scan, s.can_manage_tags, s.can_sell_tickets, m.role AS member_role FROM events e
                 LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = ?
                 LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = ? WHERE e.id = ?', [$u['id'], $u['id'], $eventId]);
    if (!$ev) throw not_found('Event not found.');
    // The organiser's owners and managers, and the gate staff they added. Never TicketRoom staff.
    if (account_type($u) === 'staff') throw not_found('Event not found.');
    if (in_array($ev['member_role'], ['owner', 'manager'], true) || !empty($ev[$cap])) return $ev;
    throw not_found('Event not found.');
}

// ============================================================== profile
// Coarse key for queue de-duplication and rate limits only. Mail providers do
// not all treat plus-addressing or dots alike, so never use this key to decide
// account ownership or expose tickets/orders. Those lookups must use the
// exact verified email address (case-insensitively).
function email_key(string $email): string
{
    $e = strtolower(trim($email));
    $at = strrpos($e, '@');
    if ($at === false) return $e;
    $local = substr($e, 0, $at);
    $domain = substr($e, $at + 1);
    $local = explode('+', $local, 2)[0];
    if (in_array($domain, ['gmail.com', 'googlemail.com'], true)) { $local = str_replace('.', '', $local); $domain = 'gmail.com'; }
    return "$local@$domain";
}
// Exact email identity lookup. Do not match on email_key: it deliberately
// folds aliases for non-security purposes and could attach someone else's
// guest purchases or account membership to a different mailbox.
function user_by_email(string $email): ?array
{
    return row("SELECT * FROM users WHERE lower(email) = ? AND status <> 'deleted' ORDER BY created_at LIMIT 1", [strtolower(trim($email))]);
}

function profile(string $userId): array
{
    $u = row('SELECT id, email, full_name, phone, phone_verified_at, email_verified_at, created_at, account_type, email_otp_enabled, spending_pin_hash IS NOT NULL AS has_pin FROM users WHERE id = ?', [$userId]);
    $u['platform_roles'] = $u['account_type'] === 'staff' ? array_column(rows('SELECT role FROM platform_roles WHERE user_id = ?', [$userId]), 'role') : [];
    $u['organisers'] = array_map(fn($r) => ['id' => $r['id'], 'name' => $r['name'], 'status' => $r['status'], 'role' => $r['role']],
        rows('SELECT o.id, o.name, o.status, m.role FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = ? ORDER BY m.created_at', [$userId]));
    $u['vendors'] = array_map(fn($r) => ['id' => $r['id'], 'name' => $r['name'], 'role' => $r['role'], 'eventId' => $r['event_id'], 'eventTitle' => $r['title']],
        rows('SELECT v.id, v.name, vm.role, v.event_id, e.title FROM vendor_members vm JOIN vendors v ON v.id = vm.vendor_id JOIN events e ON e.id = v.event_id WHERE vm.user_id = ? ORDER BY e.starts_at DESC', [$userId]));
    $u['staff_events'] = array_map(fn($r) => ['eventId' => $r['id'], 'title' => $r['title'], 'canScan' => (bool) $r['can_scan'], 'canManageTags' => (bool) $r['can_manage_tags']],
        rows('SELECT e.id, e.title, s.can_scan, s.can_manage_tags, s.can_sell_tickets FROM event_staff s JOIN events e ON e.id = s.event_id WHERE s.user_id = ?', [$userId]));
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

// ============================================================== IDs, ticket kinds, age groups
// Short IDs people can read out on the phone: EV-7K3M9Q for an event,
// ORG-4H8T2W for an organiser. Same alphabet as ticket codes (no 0/O, 1/I).
function new_ref(string $table): string
{
    $prefix = $table === 'events' ? 'EV-' : 'ORG-';
    do { $ref = $prefix . random_code(6); } while (val("SELECT 1 FROM $table WHERE ref = ?", [$ref]));
    return $ref;
}
// Ticket kinds an organiser can sell. 'check' is what the gate is told to look
// at; 'admits' is the usual number of people one ticket lets in.
const TICKET_KINDS = [
    'general' => ['label' => 'General admission'], 'early_bird' => ['label' => 'Early bird'], 'vip' => ['label' => 'VIP'], 'vvip' => ['label' => 'VVIP'],
    'golden_circle' => ['label' => 'Golden circle'], 'seated' => ['label' => 'Reserved seating'], 'standing' => ['label' => 'Standing'],
    'student' => ['label' => 'Student', 'check' => 'Check student card'], 'child' => ['label' => 'Child', 'check' => 'Check age'],
    'pensioner' => ['label' => 'Pensioner', 'check' => 'Check ID'], 'couple' => ['label' => 'Couple', 'admits' => 2],
    'group' => ['label' => 'Group', 'admits' => 4], 'table' => ['label' => 'Table / booth', 'admits' => 8],
    'day_pass' => ['label' => 'Day pass'], 'multi_day' => ['label' => 'Weekend / multi-day pass'], 'season' => ['label' => 'Season pass'],
    'backstage' => ['label' => 'Backstage / meet & greet'], 'hospitality' => ['label' => 'Hospitality'],
    'accessible' => ['label' => 'Accessible', 'check' => 'Companion may enter with this ticket'], 'late_entry' => ['label' => 'Late entry'],
];
const AGE_GROUPS = ['all' => 'All ages', 'kids' => 'Kids (under 13)', 'teens' => 'Teens (13 to 17)', '18_24' => '18 to 24', '25_34' => '25 to 34',
    '35_49' => '35 to 49', '50_plus' => '50 and over', 'families' => 'Families'];
// What the scanner shows under the name: "VIP · Admit 2 · Check ID".
function gate_label(array $tt): string
{
    $k = TICKET_KINDS[$tt['kind'] ?? 'general'] ?? [];
    $parts = [$tt['name']];
    if ((int) ($tt['admits'] ?? 1) > 1) $parts[] = 'Admit ' . (int) $tt['admits'];
    if (!empty($k['check'])) $parts[] = $k['check'];
    return implode(' · ', $parts);
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
// Presale queue passes are short-lived and bound to one booking. Only the
// first 100 unexpired admissions may hold a checkout place at a time.
function presale_queue_active(array $event, ?float $now = null): bool
{
    $now ??= microtime(true);
    if (empty($event['presale_queue_enabled']) || empty($event['sales_start_at'])) return false;
    $starts = to_unix($event['sales_start_at']);
    return $now >= $starts - 900 && $now < $starts + 3600;
}
function presale_queue_refresh(string $eventId): void
{
    $now = now_iso();
    q("UPDATE presale_queue_entries SET status = 'expired' WHERE event_id = ? AND status = 'admitted' AND admitted_until < ?", [$eventId, $now]);
    $active = (int) val("SELECT count(*) FROM presale_queue_entries WHERE event_id = ? AND status = 'admitted' AND admitted_until >= ?", [$eventId, $now]);
    $slots = max(0, 100 - $active);
    if ($slots > 0) {
        $next = rows("SELECT id FROM presale_queue_entries WHERE event_id = ? AND status = 'waiting' ORDER BY joined_at, id LIMIT $slots", [$eventId]);
        foreach ($next as $entry) q("UPDATE presale_queue_entries SET status = 'admitted', admitted_until = ? WHERE id = ? AND status = 'waiting'", [iso_in(10 * 60), $entry['id']]);
    }
}
function presale_queue_entry(string $token): ?array
{
    if (strlen($token) < 32 || strlen($token) > 128) return null;
    return row('SELECT * FROM presale_queue_entries WHERE token_hash = ?', [hash('sha256', $token)]);
}
function presale_queue_status(array $entry): array
{
    presale_queue_refresh($entry['event_id']);
    $entry = row('SELECT * FROM presale_queue_entries WHERE id = ?', [$entry['id']]);
    $position = $entry['status'] === 'waiting' ? (int) val("SELECT count(*) FROM presale_queue_entries WHERE event_id = ? AND status = 'waiting' AND (joined_at < ? OR (joined_at = ? AND id <= ?))", [$entry['event_id'], $entry['joined_at'], $entry['joined_at'], $entry['id']]) : 0;
    return ['status' => $entry['status'], 'position' => $position, 'admittedUntil' => $entry['admitted_until']];
}
function card_payments_enabled(): bool { return pay_ready(); }

// Prices come from the database only; client-sent prices are never read.
function promo_code_shape(): array
{
    return [
        'code' => R::str(['min' => 3, 'max' => 30, 'pattern' => '/^[A-Za-z0-9_-]+$/', 'message' => 'Letters, digits, - and _ only.']),
        'codeType' => R::oneOf(['promo', 'voucher'], ['optional' => true, 'fallback' => 'promo']),
        'kind' => R::oneOf(['percent', 'fixed']),
        'value' => R::int(['min' => 1, 'max' => 10000000]),
        'maxUses' => R::int(['optional' => true, 'min' => 1, 'max' => 100000]),
        'maxUsesPerEmail' => R::int(['optional' => true, 'min' => 1, 'max' => 100000]),
        'minimumSubtotalCents' => R::int(['optional' => true, 'min' => 0, 'max' => 100000000]),
        'validFrom' => R::date(['optional' => true]), 'validTo' => R::date(['optional' => true]),
    ];
}
function promo_code_create(array $event, array $actor, array $b): array
{
    if ($b['kind'] === 'percent' && $b['value'] > 100) throw bad('A percentage cannot exceed 100.', ['value' => 'Max 100.']);
    if (!empty($b['validFrom']) && !empty($b['validTo']) && $b['validFrom'] >= $b['validTo']) throw bad('The expiry must be after the start date.', ['validTo' => 'Choose a later date and time.']);
    $id = uuid();
    $code = strtoupper($b['code']);
    $codeType = $b['codeType'] ?? 'promo';
    if ($codeType === 'voucher' && strlen($code) < 14) throw bad('Voucher codes must be at least 14 characters.', ['code' => 'Use Generate code or enter at least 14 characters.']);
    $maxUses = $b['maxUses'] ?? ($codeType === 'voucher' ? 1 : null);
    $maxPerEmail = $b['maxUsesPerEmail'] ?? ($codeType === 'voucher' ? 1 : null);
    try {
        insert('promo_codes', ['id' => $id, 'event_id' => $event['id'], 'code' => $code, 'code_type' => $codeType, 'kind' => $b['kind'], 'value' => $b['value'],
            'max_uses' => $maxUses, 'max_uses_per_email' => $maxPerEmail, 'minimum_subtotal_cents' => $b['minimumSubtotalCents'] ?? 0,
            'valid_from' => $b['validFrom'] ?? null, 'valid_to' => $b['validTo'] ?? null, 'used_count' => 0, 'active' => 1, 'created_at' => now_iso()]);
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'promo_codes.event_id') || str_contains($e->getMessage(), 'promo_codes_event_code_uq')) throw conflict('That code already exists for this event.', 'promo_code_exists');
        throw $e;
    }
    audit('promo.created', ['actor' => $actor, 'entityType' => 'promo_code', 'entityId' => $id, 'organiserId' => $event['organiser_id'], 'details' => ['code' => $code, 'codeType' => $codeType, 'kind' => $b['kind'], 'value' => $b['value'], 'maxUses' => $maxUses, 'maxUsesPerEmail' => $maxPerEmail]]);
    return row('SELECT * FROM promo_codes WHERE id = ?', [$id]);
}

// Whether a ticket type can be bought right now, with its own sales window and
// phases: a type with "release_after" opens once that earlier type sells out
// (or stops selling: paused, hidden or past its end time).
function tt_release_state(array $tt): array
{
    $now = microtime(true);
    if (!empty($tt['sales_end_at']) && to_unix($tt['sales_end_at']) <= $now) return ['state' => 'ended'];
    if (!empty($tt['sales_start_at']) && to_unix($tt['sales_start_at']) > $now) return ['state' => 'scheduled', 'opensAt' => $tt['sales_start_at']];
    if (!empty($tt['release_after'])) {
        $prev = row('SELECT name, status, quantity_total, quantity_sold, quantity_held, sales_end_at FROM ticket_types WHERE id = ? AND event_id = ?', [$tt['release_after'], $tt['event_id']]);
        if ($prev && $prev['status'] === 'on_sale' && (int) $prev['quantity_total'] - (int) $prev['quantity_sold'] - (int) $prev['quantity_held'] > 0
            && !(!empty($prev['sales_end_at']) && to_unix($prev['sales_end_at']) <= $now)) return ['state' => 'next', 'after' => $prev['name']];
    }
    return ['state' => 'on_sale'];
}

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
        $release = tt_release_state($tt);
        if ($release['state'] === 'next') throw conflict("{$tt['name']} goes on sale when {$release['after']} sells out.", 'ticket_type_unavailable');
        if ($release['state'] !== 'on_sale') throw conflict("{$tt['name']} is not on sale right now.", 'ticket_type_unavailable');
        if ($it['quantity'] > $tt['per_order_limit']) throw conflict("You can buy at most {$tt['per_order_limit']} × {$tt['name']} per order.", 'limit_exceeded');
        $count += $it['quantity'];
        $serviceFee = ticket_fee((int) $tt['price_cents']);
        $organiserPaysFee = ($event['service_fee_payer'] ?? 'customer') === 'organiser';
        $lines[] = ['ticketType' => $tt, 'quantity' => $it['quantity'], 'unitPrice' => (int) $tt['price_cents'], 'unitFee' => event_ticket_fee($event, (int) $tt['price_cents']), 'unitOrganiserServiceFee' => $organiserPaysFee ? $serviceFee : 0];
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
        if ((int) ($promo['minimum_subtotal_cents'] ?? 0) > $subtotal) throw conflict('The minimum ticket subtotal for this code is ' . format_zar((int) $promo['minimum_subtotal_cents']) . '.', 'promo_minimum_not_met');
        $discount = $promo['kind'] === 'percent' ? bps_of($subtotal, (int) $promo['value'] * 100) : min((int) $promo['value'], $subtotal);
    }
    $fee = array_sum(array_map(fn($l) => $l['unitFee'] * $l['quantity'], $lines));
    $organiserServiceFee = array_sum(array_map(fn($l) => $l['unitOrganiserServiceFee'] * $l['quantity'], $lines));
    if ($subtotal - $discount === 0) { $fee = 0; $organiserServiceFee = 0; foreach ($lines as &$l) { $l['unitFee'] = 0; $l['unitOrganiserServiceFee'] = 0; } unset($l); }
    return ['lines' => $lines, 'subtotal' => $subtotal, 'discount' => $discount, 'fee' => $fee, 'organiserServiceFee' => $organiserServiceFee, 'total' => $subtotal - $discount + $fee, 'promo' => $promo];
}
function public_quote(array $qt): array
{
    return [
        'lines' => array_map(fn($l) => ['ticketTypeId' => $l['ticketType']['id'], 'name' => $l['ticketType']['name'], 'quantity' => $l['quantity'], 'unitPriceCents' => $l['unitPrice'], 'unitFeeCents' => $l['unitFee']], $qt['lines']),
        'subtotalCents' => $qt['subtotal'], 'discountCents' => $qt['discount'], 'feeCents' => $qt['fee'], 'totalCents' => $qt['total'],
        'promoCode' => $qt['promo']['code'] ?? null, 'currency' => 'ZAR',
    ];
}
// Retail shares are snapshots on an order. They are transferred out of the
// commission and service-fee revenue already charged, never added to checkout.
function retail_order_shares(?string $partnerId, int $net, array $lines, int $commission, int $commissionBps): array
{
    if (!$partnerId || !val("SELECT 1 FROM retail_partners WHERE id = ? AND status = 'approved'", [$partnerId])) return [0, 0];
    $fees = settings_all()['fees'] ?? [];
    $paid = 0; $feeRevenue = 0;
    foreach ($lines as $l) {
        if ((int) $l['unitPrice'] > 0) {
            $paid += (int) $l['quantity'];
            $feeRevenue += ((int) $l['unitFee'] + (int) $l['unitOrganiserServiceFee']) * (int) $l['quantity'];
        }
    }
    $commissionShare = min($commission, bps_of(max(0, $net), $commissionBps), bps_of(max(0, $net), (int) ($fees['retailCommissionShareBps'] ?? 150)));
    $serviceShare = min($feeRevenue, max(0, (int) ($fees['retailServiceFeeShareCents'] ?? 300)) * $paid);
    return [$commissionShare, $serviceShare];
}
function retail_ledger_lines(array $order, ?int $commissionShare = null, ?int $serviceShare = null): array
{
    if (empty($order['retail_partner_id'])) return [];
    $commissionShare ??= (int) ($order['retail_commission_share_cents'] ?? 0);
    $serviceShare ??= (int) ($order['retail_service_share_cents'] ?? 0);
    // Customer-paid fees sit in booking_fees; organiser-absorbed fees sit in
    // service_fees. Reclassify the share from the source actually credited.
    $serviceAccount = (int) ($order['organiser_service_fee_cents'] ?? 0) > 0 ? 'revenue:service_fees' : 'revenue:booking_fees';
    return [['revenue:commission', $commissionShare], [$serviceAccount, $serviceShare],
        ['payable:retail:' . $order['retail_partner_id'], -($commissionShare + $serviceShare)]];
}
function create_order(array $user, array $in): array
{
    // Reservations that ran out are let go first (in their own transaction,
    // so a "sold out" answer below does not undo it), instead of blocking
    // sales until the background job gets to them.
    $lapsed = row('SELECT id FROM events WHERE slug = ?', [$in['eventSlug']]);
    if ($lapsed) release_lapsed_holds($lapsed['id']);
    return tx(function () use ($user, $in) {
        $prior = row('SELECT * FROM orders WHERE user_id = ? AND idempotency_key = ?', [$user['id'], $in['idempotencyKey']]);
        if ($prior) return ['order' => $prior, 'replay' => true];
        $event = row('SELECT * FROM events WHERE slug = ?', [$in['eventSlug']]);
        if (!$event) throw not_found('Event not found.');
        $queueEntry = null;
        if (presale_queue_active($event) && empty($in['waitlistOffer'])) {
            $queueEntry = !empty($in['presaleQueueToken']) ? presale_queue_entry((string) $in['presaleQueueToken']) : null;
            if (!$queueEntry || $queueEntry['event_id'] !== $event['id'] || $queueEntry['status'] !== 'admitted' || !$queueEntry['admitted_until'] || $queueEntry['admitted_until'] < now_iso()) throw conflict('Join the presale queue and wait until you are admitted before checking out.', 'presale_queue_required');
            if (email_key((string) ($user['email'] ?? '')) !== (string) $queueEntry['email_key']) throw conflict('Use the same email address you used to join the presale queue.', 'presale_queue_email_mismatch');
        }
        // A waitlist offer: the place held for this person goes to this order.
        $waitEntry = !empty($in['waitlistOffer']) ? waitlist_take_primary($in['waitlistOffer'], $event, $in['items']) : null;
        $qt = order_quote($event, $in['items'], $in['promoCode'] ?? null);
        if ($qt['promo'] && (int) ($qt['promo']['max_uses_per_email'] ?? 0) > 0) {
            $alreadyUsed = (int) val("SELECT count(*) FROM orders WHERE event_id = ? AND promo_code_id = ? AND lower(buyer_email) = lower(?) AND status IN ('pending_payment','paid','paid_unfulfilled','partially_refunded','refunded')",
                [$event['id'], $qt['promo']['id'], (string) ($user['email'] ?? '')]);
            if ($alreadyUsed >= (int) $qt['promo']['max_uses_per_email']) throw conflict('This code has already been used the maximum number of times for your email address.', 'promo_email_limit');
        }
        // Capacity counts people: a couple ticket uses two places.
        $used = (int) val('SELECT COALESCE(SUM((quantity_sold + quantity_held) * admits),0) FROM ticket_types WHERE event_id = ?', [$event['id']]);
        $wanted = array_sum(array_map(fn($l) => $l['quantity'] * max(1, (int) ($l['ticketType']['admits'] ?? 1)), $qt['lines']));
        if ($used + $wanted > $event['capacity']) throw conflict('Not enough tickets left for this event.', 'sold_out');
        if ($qt['total'] > 0 && !pay_ready()) throw new AppError(503, 'payments_not_configured', 'Card payments are not switched on yet. Free tickets are available; paid tickets go on sale soon.');
        // Free tickets: the per-person limit counts every order this person
        // already has for the event, so one account cannot take them all. An
        // email typed at checkout is not proven, so the count also takes in
        // every account whose address folds to the same mailbox (dots and
        // "+" tags in Gmail addresses and the like).
        $mailKey = email_key((string) ($user['email'] ?? ''));
        foreach ($qt['total'] > 0 ? [] : $qt['lines'] as $l) {
            $have = (int) val("SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                WHERE (o.user_id = ? OR o.user_id IN (SELECT id FROM users WHERE email_key = ?)) AND o.event_id = ? AND oi.ticket_type_id = ? AND o.status IN ('pending_payment','paid','paid_unfulfilled','partially_refunded')",
                [$user['id'], $mailKey, $event['id'], $l['ticketType']['id']]);
            $max = (int) $l['ticketType']['per_order_limit'];
            // Someone booking for an email they typed in is not told what that
            // address already holds.
            if ($have + $l['quantity'] > $max) throw conflict($have && empty($user['viaGuest']) ? "Free tickets are limited to $max × {$l['ticketType']['name']} per person, and you already have $have." : "Free tickets are limited to $max × {$l['ticketType']['name']} per person.", 'limit_exceeded');
        }
        foreach ($qt['lines'] as $l) {
            if (affected('UPDATE ticket_types SET quantity_held = quantity_held + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$l['quantity'], $l['ticketType']['id'], $l['quantity']]) === 0) {
                throw conflict("Not enough {$l['ticketType']['name']} tickets left.", 'sold_out');
            }
        }
        if ($qt['promo']) q('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?', [$qt['promo']['id']]);
        $trackingId = !empty($in['ref']) ? val('SELECT id FROM tracking_links WHERE event_id = ? AND code = ?', [$event['id'], $in['ref']]) : null;
        $orgBps = val('SELECT commission_bps FROM organisers WHERE id = ?', [$event['organiser_id']]);
        $feeSettings = settings_all()['fees'] ?? [];
        $paidTicketCount = array_sum(array_map(fn($l) => $l['unitPrice'] > 0 ? $l['quantity'] : 0, $qt['lines']));
        $commissionRate = $orgBps === null ? (int) ($feeSettings['organiserCommissionBps'] ?? 500) : (int) $orgBps;
        $organiserCommission = bps_of($qt['subtotal'] - $qt['discount'], $commissionRate)
            + (($qt['subtotal'] - $qt['discount']) > 0 ? (int) ($feeSettings['organiserCommissionFixedCents'] ?? 250) * $paidTicketCount : 0);
        $retailPartnerId = !empty($in['retailPartnerId']) ? (string) $in['retailPartnerId'] : null;
        if ($retailPartnerId !== null && empty(settings_all()['retail']['enabled'])) {
            $retailSettings = settings_all()['retail'];
            throw new AppError(503, 'retail_paused', $retailSettings['message'] ?: 'Retail applications and sales will open soon.');
        }
        [$retailCommissionShare, $retailServiceShare] = retail_order_shares($retailPartnerId, $qt['subtotal'] - $qt['discount'], $qt['lines'], $organiserCommission, $commissionRate);
        $now = now_iso();
        $order = insert('orders', [
            'id' => uuid(), 'reference' => reference('TR'), 'event_id' => $event['id'], 'user_id' => $user['id'], 'status' => 'pending_payment',
            'buyer_name' => $user['fullName'], 'buyer_email' => $user['email'], 'buyer_phone' => $in['buyerPhone'] ?? $user['phone'],
            'subtotal_cents' => $qt['subtotal'], 'discount_cents' => $qt['discount'], 'fee_cents' => $qt['fee'], 'total_cents' => $qt['total'], 'refunded_cents' => 0,
            'organiser_fee_cents' => $organiserCommission,
            'organiser_commission_fixed_cents' => (($qt['subtotal'] - $qt['discount']) > 0 ? (int) ($feeSettings['organiserCommissionFixedCents'] ?? 250) : 0),
            'organiser_service_fee_cents' => $qt['organiserServiceFee'],
            'retail_partner_id' => $retailPartnerId, 'retail_commission_share_cents' => $retailCommissionShare, 'retail_service_share_cents' => $retailServiceShare,
            'promo_code_id' => $qt['promo']['id'] ?? null, 'tracking_link_id' => $trackingId ?: null, 'idempotency_key' => $in['idempotencyKey'],
            'expires_at' => iso_in(HOLD_MINUTES * 60), 'created_at' => $now, 'updated_at' => $now,
            'link_shows_tickets' => order_link_shows_tickets($user),
        ]);
        if ($waitEntry) q('UPDATE waitlist_entries SET order_id = ? WHERE id = ?', [$order['id'], $waitEntry]);
        if ($queueEntry) q("UPDATE presale_queue_entries SET status = 'used', order_id = ? WHERE id = ? AND status = 'admitted'", [$order['id'], $queueEntry['id']]);
        foreach ($qt['lines'] as $l) {
            insert('order_items', ['id' => uuid(), 'order_id' => $order['id'], 'ticket_type_id' => $l['ticketType']['id'], 'quantity' => $l['quantity'], 'unit_price_cents' => $l['unitPrice'], 'unit_fee_cents' => $l['unitFee'], 'unit_organiser_service_fee_cents' => $l['unitOrganiserServiceFee']]);
        }
        foreach (['email', 'sms'] as $ch) if (!empty($in['marketingOptIn'][$ch])) set_consent($user['id'], $event['organiser_id'], $ch, true, "checkout:{$order['reference']}");
        // Free orders are done now; paid ones wait for the provider to confirm payment.
        if ((int) $order['total_cents'] === 0) $order = fulfil_order($order['id'])['order'];
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
            insert('tickets', ['id' => uuid(), 'code' => new_pass_code(), 'qr_version' => 1, 'order_id' => $orderId, 'order_item_id' => $it['id'], 'event_id' => $order['event_id'],
                'ticket_type_id' => $it['ticket_type_id'], 'owner_user_id' => $order['user_id'], 'holder_name' => $order['buyer_name'], 'price_cents' => $it['unit_price_cents'],
                'fee_cents' => $it['unit_fee_cents'], 'status' => 'valid', 'test' => (int) ($order['test'] ?? 0), 'created_at' => $now, 'updated_at' => $now]);
            $n++;
        }
    }
    // A waitlist place that was held for this order is now used.
    q("UPDATE waitlist_entries SET status = 'claimed', offer_token_hash = NULL, updated_at = ? WHERE order_id = ? AND status = 'offered'", [$now, $orderId]);
    $event = row('SELECT * FROM events WHERE id = ?', [$order['event_id']]);
    $guest = (int) val('SELECT guest FROM users WHERE id = ?', [$order['user_id']]) === 1;
    $link = order_email_link($order);
    $doorReceipt = row('SELECT method, receipt_reference, amount_cents FROM door_tenders WHERE order_id = ?', [$orderId]);
    outbox_enqueue(['to' => $order['buyer_email'], 'userId' => $order['user_id']] + tpl('orderConfirmed', ['order' => $order, 'event' => $event, 'ticketCount' => $n, 'guestLink' => $link, 'doorTender' => $doorReceipt]));
    // A short SMS too, when the buyer gave a mobile number and SMS is set up.
    if ($order['buyer_phone'] && sms_ready()) {
        outbox_enqueue(['channel' => 'sms', 'to' => $order['buyer_phone'], 'userId' => $order['user_id'],
            'body' => "TicketRoom: you're booked for {$event['title']} (" . plural($n, 'ticket') . "). Order {$order['reference']}. " . ($guest ? 'Tickets: ' . order_link($order) : ($link ? 'Your tickets are in your email.' : 'Tickets: ' . base_url() . '/account#/tickets'))]);
    }
    return ['order' => $order];
}
function release_holds(array $order): void
{
    // A resale order holds a listing, not places on sale.
    if (!empty($order['resale_listing_id'])) { resale_release_order($order); return; }
    // A waitlist offer this order was paying for: while the offer still has
    // time left, its place stays held for that person (a failed or abandoned
    // payment does not lose them their place). After that it goes as usual.
    $offer = row("SELECT * FROM waitlist_entries WHERE order_id = ? AND status = 'offered' AND offer_kind = 'primary'", [$order['id']]);
    $keep = $offer && to_unix($offer['offer_expires_at']) > microtime(true) ? $offer['ticket_type_id'] : null;
    if ($offer) {
        $keep ? q('UPDATE waitlist_entries SET order_id = NULL, updated_at = ? WHERE id = ?', [now_iso(), $offer['id']])
              : q("UPDATE waitlist_entries SET status = 'expired', offer_token_hash = NULL, updated_at = ? WHERE id = ?", [now_iso(), $offer['id']]);
    }
    foreach (rows('SELECT * FROM order_items WHERE order_id = ?', [$order['id']]) as $it) {
        $free = (int) $it['quantity'] - ($keep === $it['ticket_type_id'] ? WAITLIST_TICKETS_PER_PERSON : 0);
        if ($keep === $it['ticket_type_id']) $keep = null;
        if ($free > 0) q('UPDATE ticket_types SET quantity_held = MAX(quantity_held - ?, 0) WHERE id = ?', [$free, $it['ticket_type_id']]);
    }
    if ($order['promo_code_id']) q('UPDATE promo_codes SET used_count = used_count - 1 WHERE id = ? AND used_count > 0', [$order['promo_code_id']]);
    // Places that come free go to the waitlist first.
    if (val("SELECT 1 FROM waitlist_entries WHERE event_id = ? AND status = 'waiting' LIMIT 1", [$order['event_id']])) waitlist_sweep($order['event_id']);
}
// Lets one lapsed reservation go (inside its own transaction).
function expire_order(string $orderId): bool
{
    return tx(function () use ($orderId) {
        $order = row('SELECT * FROM orders WHERE id = ?', [$orderId]);
        if (!$order || $order['status'] !== 'pending_payment') return false;
        release_holds($order);
        q("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?", [now_iso(), $order['id']]);
        q("UPDATE door_order_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'awaiting_tender'", [$order['id']]);
        return true;
    });
}
// Reservations with no card payment under way can go at once, without asking
// the payment provider anything. A payment still under way gets a quarter of
// an hour's grace before its reservation is let go here; if it does go
// through later, the payment code takes the tickets again or refunds.
const LAPSED_ORDERS_SQL = "SELECT o.id FROM orders o WHERE o.status = 'pending_payment' AND o.expires_at < ?%s
    AND (o.expires_at < ? OR NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status IN ('initiated','pending'))) LIMIT %d";
function release_lapsed_holds(string $eventId): int
{
    $n = 0;
    foreach (rows(sprintf(LAPSED_ORDERS_SQL, ' AND o.event_id = ?', 50), [now_iso(), $eventId, iso_in(-15 * 60)]) as $o) if (expire_order($o['id'])) $n++;
    return $n;
}
function expire_due_orders(): int
{
    // Most lapsed reservations need no provider check: let them all go first.
    $n = 0;
    foreach (rows(sprintf(LAPSED_ORDERS_SQL, '', 500), [now_iso(), iso_in(-15 * 60)]) as $o) if (expire_order($o['id'])) $n++;
    // A handful each run with a card payment under way: before letting the
    // reservation go, check the provider hasn't taken the money already.
    foreach (rows("SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at < ? ORDER BY expires_at LIMIT 20", [now_iso()]) as $o) {
        foreach (rows("SELECT id FROM payments WHERE order_id = ? AND status = 'pending' AND provider = 'yoco'", [$o['id']]) as $p) {
            try { payment_sync($p['id']); } catch (Throwable $e) { error_log('[payments] expiry check: ' . $e->getMessage()); }
        }
        if (expire_order($o['id'])) $n++;
    }
    return $n;
}
// ============================================================== guest checkout
// Someone buying without signing in. Their email gets a quiet "guest"
// account with no password: the tickets live there. If they sign up later
// with the same email and confirm it, that account (and its tickets) is
// theirs. An email that already has an account books into that account.
function guest_buyer(array $g): array
{
    $u = user_by_email($g['email']);
    // Nothing about someone else's account is said to whoever typed the email.
    if ($u && $u['status'] !== 'active') throw new AppError(403, 'email_unavailable', "We can't book tickets for this email address. Use another email, or use the contact form at /contact if it's yours.");
    if (!$u) {
        $now = now_iso();
        $u = insert('users', ['id' => uuid(), 'email' => $g['email'], 'email_key' => email_key($g['email']), 'phone' => $g['phone'] ?? null, 'full_name' => $g['fullName'],
            'password_hash' => '!', 'status' => 'active', 'guest' => 1, 'created_at' => $now, 'updated_at' => $now]);
        audit('user.guest_created', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
    }
    // 'own' is false when the email belongs to a full account: the tickets go
    // into that account, and only its owner (signed in, or through the link in
    // the email) gets to see them. The person at the checkout does not.
    return ['id' => $u['id'], 'fullName' => $g['fullName'], 'email' => $u['email'], 'phone' => $g['phone'] ?? $u['phone'], 'guest' => (int) $u['guest'] === 1,
        'viaGuest' => true, 'own' => (int) $u['guest'] === 1];
}
// A private link to one order, for buyers without an account (and the order
// email). Signed, so it cannot be guessed or edited; valid for 13 months.
function order_key(string $orderId): string { return sign_link(['o' => $orderId], 400 * 86400); }
function order_link(array $order): string { return base_url() . '/orders/' . $order['reference'] . '?k=' . rawurlencode(order_key($order['id'])); }
// The link sent only to the account's own mailbox. Unlike order_key() (which
// also reaches whoever stood at the checkout), it shows the tickets of an
// order booked into a full account.
function order_mail_key(string $orderId): string { return sign_link(['o' => $orderId, 'm' => 1], 400 * 86400); }
function order_mail_link(array $order): string { return base_url() . '/orders/' . $order['reference'] . '?k=' . rawurlencode(order_mail_key($order['id'])); }
// Whether the order's private link (the one the checkout page and payment
// page return to) may show its tickets: only when whoever was at the checkout
// owns the account. Someone typing an email that already has an account
// (a full one, or an earlier guest's) books into it, but the tickets show
// only to that account: signed in, or through the link in its own email.
// The link in the order email, or null when the tickets are in the buyer's
// customer portal. Organiser and staff accounts have no ticket wallet, so
// their email carries the private order link as well.
function order_email_link(array $order): ?string
{
    $owner = row('SELECT guest, account_type FROM users WHERE id = ?', [$order['user_id']]);
    $guest = (int) ($owner['guest'] ?? 0) === 1;
    if (!$guest && account_type($owner) === 'customer') return null;
    return (int) ($order['link_shows_tickets'] ?? 1) === 1 && $guest ? order_link($order) : order_mail_link($order);
}
function order_link_shows_tickets(array $buyer): int { return empty($buyer['viaGuest']) || !empty($buyer['own']) ? 1 : 0; }
function order_tickets_visible(array $o, ?string $key): bool
{
    $u = user();
    if ($u && $u['id'] === $o['user_id']) return true;
    $d = $key ? verify_link($key) : null;
    if (!$d || ($d['o'] ?? '') !== $o['id']) return false;
    return (int) ($o['link_shows_tickets'] ?? 1) === 1 || !empty($d['m']);
}
// The order behind a reference, for its owner or for the holder of its private link.
function order_access(string $ref, ?string $key): array
{
    $o = row('SELECT o.*, e.title, e.slug, e.starts_at, e.ends_at, e.venue_name, e.city FROM orders o JOIN events e ON e.id = o.event_id WHERE o.reference = ?', [$ref]);
    $d = $key ? verify_link($key) : null;
    $u = user();
    if (!$o || !(($d && ($d['o'] ?? '') === $o['id']) || ($u && $u['id'] === $o['user_id']))) {
        if (!$u && !$key) throw unauthenticated();
        throw not_found('Order not found.');
    }
    return $o;
}

// The payment behind an order, as the buyer's page shows it.
function order_payment_view(array $o): ?array
{
    $p = row("SELECT id, provider, status, amount_cents FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1", [$o['id']]);
    if (!$p) return null;
    $door = row('SELECT method, receipt_reference, external_reference FROM door_tenders WHERE payment_id = ?', [$p['id']]);
    return ['id' => $p['id'], 'provider' => $p['provider'], 'status' => $p['status'], 'amountCents' => (int) $p['amount_cents'],
        'method' => $door['method'] ?? 'card', 'receiptReference' => $door['receipt_reference'] ?? null, 'externalReference' => $door['external_reference'] ?? null];
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
// Gate passes use their own prefix and signing label, so a pass code can never
// be passed off as a ticket or the other way round.
function pass_sig(string $code, int $version): string { return substr(b64url(hmac_raw(key_hex('qr'), "P|$code|$version")), 0, 22); }
function pass_payload(array $g): string { return "TP1.{$g['code']}.{$g['qr_version']}." . pass_sig($g['code'], (int) $g['qr_version']); }
function pass_parse(?string $input): ?array
{
    if (!preg_match('/^TP1\.([2-9A-HJ-NP-TV-Z]{10})\.(\d{1,6})\.([A-Za-z0-9_-]{22})$/', trim((string) $input), $m)) return null;
    return safe_equal(pass_sig($m[1], (int) $m[2]), $m[3]) ? ['code' => $m[1], 'version' => (int) $m[2], 'signed' => true] : null;
}
// A code no ticket or pass uses yet.
function new_pass_code(): string
{
    do { $c = random_code(10); } while (val('SELECT 1 FROM tickets WHERE code = ? UNION ALL SELECT 1 FROM gate_passes WHERE code = ? UNION ALL SELECT 1 FROM replaced_codes WHERE code = ?', [$c, $c, $c]));
    return $c;
}
// A transfer or reissue gives the ticket (or pass) a brand-new code, not just
// a new QR version: the old code is also printed on the ticket and can be
// typed in at the gate. The old code is kept so that it scans as "replaced"
// and is never handed out again.
function replace_ticket_code(array $t, string $reason): string
{
    $code = new_pass_code();
    q('INSERT INTO replaced_codes (code, kind, ref_id, event_id, reason, replaced_at) VALUES (?,?,?,?,?,?)', [$t['code'], 'ticket', $t['id'], $t['event_id'], $reason, now_iso()]);
    q('UPDATE tickets SET code = ?, qr_version = qr_version + 1, updated_at = ? WHERE id = ?', [$code, now_iso(), $t['id']]);
    return $code;
}
function replace_pass_code(array $g, string $reason): string
{
    $code = new_pass_code();
    q('INSERT INTO replaced_codes (code, kind, ref_id, event_id, reason, replaced_at) VALUES (?,?,?,?,?,?)', [$g['code'], 'pass', $g['id'], $g['event_id'], $reason, now_iso()]);
    q('UPDATE gate_passes SET code = ?, qr_version = qr_version + 1, updated_at = ? WHERE id = ?', [$code, now_iso(), $g['id']]);
    return $code;
}
// Ticket kinds that let their holder in once on each day of the event.
const PER_DAY_KINDS = ['multi_day', 'season'];
// The calendar day (South African time) of a moment, for per-day passes.
function sa_day(string $iso): string { return (new DateTimeImmutable($iso))->setTimezone(new DateTimeZone('Africa/Johannesburg'))->format('Y-m-d'); }
const PASS_ROLES = ['crew' => 'Crew', 'artist' => 'Artist / performer', 'media' => 'Media', 'vendor' => 'Vendor', 'security' => 'Security', 'medical' => 'Medical',
    'sponsor' => 'Sponsor', 'guest' => 'Guest list', 'staff' => 'Event staff', 'all_access' => 'All access'];
// Passes work from two days before the event (build) to a day after (strike).
const PASS_BEFORE_H = 48;
const PASS_AFTER_H = 24;

function tickets_for_user(string $userId): array
{
    $list = rows("SELECT t.id, t.code, t.status, t.revoked_reason, t.holder_name, t.admitted_at, t.qr_version, t.price_cents, t.test, t.order_id, t.ticket_type_id, e.resale_enabled, e.doors_open_at,
                         tt.name AS ticket_type, tt.kind AS ticket_kind, tt.admits, e.id AS event_id, e.ref AS event_ref, e.title, e.slug, e.venue_name, e.city, e.starts_at, e.ends_at,
                         e.status AS event_status, e.transfers_enabled, e.image_upload_id, e.category, o.reference AS order_reference
                    FROM tickets t JOIN events e ON e.id = t.event_id JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id
                   WHERE t.owner_user_id = ? ORDER BY e.starts_at, t.created_at", [$userId]);
    foreach ($list as &$t) {
        $tr = row("SELECT id, to_email, expires_at FROM ticket_transfers WHERE ticket_id = ? AND status = 'pending'", [$t['id']]);
        $t['pending_transfer'] = $tr ? ['id' => $tr['id'], 'toEmail' => $tr['to_email'], 'expiresAt' => $tr['expires_at']] : null;
        $t['qrPayload'] = $t['status'] === 'valid' ? qr_payload($t) : null;
        $t['resale'] = resale_ticket_info($t, $userId);
        // A refund asked for or under way: the ticket can't be passed on, sold or used meanwhile.
        $t['refund_open'] = $t['status'] === 'valid' && ticket_has_open_refund($t['id']);
        unset($t['qr_version'], $t['order_id']);
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
        if (val("SELECT 1 FROM resale_listings WHERE ticket_id = ? AND status IN ('active','offered','held')", [$t['id']])) throw conflict('This ticket is up for resale. Take it off TicketRoom Exchange first.', 'ticket_listed');
        if (ticket_has_open_refund($t['id'])) throw conflict('Refund in progress. This ticket cannot be transferred while its refund is open.', 'refund_in_progress');
        $token = random_token(24);
        $recipient = val("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", [$toEmail]);
        $tr = insert('ticket_transfers', ['id' => uuid(), 'ticket_id' => $t['id'], 'from_user_id' => $user['id'], 'to_email' => $toEmail, 'to_user_id' => $recipient ?: null,
            'claim_token_hash' => sha256($token), 'status' => 'pending', 'created_at' => now_iso(), 'expires_at' => iso_in(7 * 86400)]);
        outbox_enqueue(['to' => $toEmail, 'userId' => $recipient ?: null] + tpl('transferOffer', ['fromName' => $user['fullName'], 'event' => $t, 'claimUrl' => base_url() . "/account#/claim/$token"]));
        audit('ticket.transfer_started', ['actor' => $user, 'entityType' => 'ticket', 'entityId' => $t['id'], 'details' => ['toEmail' => $toEmail]]);
        return ['id' => $tr['id'], 'expiresAt' => $tr['expires_at']];
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
        if ($t['owner_user_id'] !== $tr['from_user_id'] || $t['status'] !== 'valid' || ticket_has_open_refund($t['id'])) {
            q("UPDATE ticket_transfers SET status = 'cancelled', completed_at = ? WHERE id = ?", [now_iso(), $tr['id']]);
            throw conflict('This ticket can no longer be transferred.', 'ticket_not_valid');
        }
        q('UPDATE tickets SET owner_user_id = ?, holder_name = ?, updated_at = ? WHERE id = ?', [$user['id'], $user['fullName'], now_iso(), $t['id']]);
        // New owner, new code: the sender's copy (QR or typed code) stops working.
        replace_ticket_code($t, 'transfer');
        q("UPDATE ticket_transfers SET status = 'accepted', to_user_id = ?, completed_at = ? WHERE id = ?", [$user['id'], now_iso(), $tr['id']]);
        $sender = val('SELECT email FROM users WHERE id = ?', [$tr['from_user_id']]);
        outbox_enqueue(['to' => $sender, 'userId' => $tr['from_user_id']] + tpl('transferDone', ['event' => $t, 'toEmail' => $user['email']]));
        audit('ticket.transfer_accepted', ['actor' => $user, 'entityType' => 'ticket', 'entityId' => $t['id'], 'details' => ['from' => $tr['from_user_id']]]);
        return ['ticketId' => $t['id'], 'eventTitle' => $t['title']];
    });
}
const ADMIT_BEFORE_H = 12;
const ADMIT_AFTER_H = 6;
// The moment a scan counts for: the phone's own time for scans synced after
// an offline spell (checked by the sync route), otherwise now. The entry
// windows are judged at that moment, so a scan made at the gate is not
// refused because the phone only got its signal back hours later.
function admit_moment(array $b): float { return !empty($b['at']) ? to_unix($b['at']) : microtime(true); }
// One IMMEDIATE transaction per scan: two gates scanning one ticket at the
// same moment are serialised, so exactly one is admitted.
function admit(array $staff, array $b): array
{
    return tx(function () use ($staff, $b) {
        $eventId = $b['eventId'];
        $ev = row('SELECT id, title, status, starts_at, ends_at, age_restriction FROM events WHERE id = ?', [$eventId]);
        $log = function (string $outcome, ?string $ticketId = null) use ($eventId, $staff, $b) {
            q('INSERT INTO admission_log (event_id, ticket_id, scanned_by, outcome, gate, occurred_at) VALUES (?,?,?,?,?,?)', [$eventId, $ticketId, $staff['id'], $outcome, $b['gate'] ?? null, $b['at'] ?? now_iso()]);
        };
        $notLive = function () use ($log) { $log('event_not_live'); return ['outcome' => 'event_not_live', 'message' => 'This event is not open for entry right now.']; };
        $replaced = function (?string $ticketId) use ($log) {
            $log('invalid', $ticketId);
            return ['outcome' => 'replaced', 'message' => 'This code was replaced (ticket transferred or reissued). Ask for the current ticket.'];
        };
        if ($ev['status'] !== 'published') return $notLive();
        // The event's age rule rides along with every answer, for the gate to check.
        $age = trim((string) ($ev['age_restriction'] ?? '')) ?: null;
        // Gate passes have their own, longer window (setup and strike days).
        $isPass = str_starts_with(trim((string) ($b['payload'] ?? '')), 'TP1.');
        $now = admit_moment($b);
        if (!$isPass && ($now < to_unix($ev['starts_at']) - ADMIT_BEFORE_H * 3600 || $now > to_unix($ev['ends_at']) + ADMIT_AFTER_H * 3600)) {
            $typed = qr_parse($b['payload'] ?? '');
            if (!$typed || $typed['signed'] || !val("SELECT 1 FROM gate_passes WHERE code = ? UNION ALL SELECT 1 FROM replaced_codes WHERE code = ? AND kind = 'pass'", [$typed['code'], $typed['code']])) return $notLive();
        }
        if (empty($b['payload'])) {
            // A wristband or tag: it opens the gate through the ticket it is
            // linked to. The answer never says whose band an unknown one is.
            // The code printed on a band is not enough here: anyone who saw the
            // band could type it in. Tap the band or scan its QR instead.
            if ((tag_normalise($b['tagInput'] ?? '')['kind'] ?? '') === 'code') { $log('invalid'); return ['outcome' => 'invalid', 'message' => "The code printed on a band can't open the gate. Tap the band or scan its QR code."]; }
            $tag = tag_resolve($b['tagInput'] ?? '', false);
            if (!$tag || $tag['event_id'] !== $eventId || in_array($tag['status'], TAG_STATUS_OPEN, true)) { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'This tag is not linked to a ticket for this event.']; }
            if ($tag['status'] !== 'active') { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'This tag was blocked (lost, stolen or replaced). Send the guest to the registration desk.']; }
            $t = $tag['ticket_id'] ? row('SELECT * FROM tickets WHERE id = ?', [$tag['ticket_id']]) : null;
            // The ticket was sent to someone else after the band was linked.
            if (!$t || $t['owner_user_id'] !== $tag['user_id']) { $log('invalid', $t['id'] ?? null); return ['outcome' => 'invalid', 'message' => 'This tag no longer matches its ticket. Send the guest to the registration desk.']; }
            q('UPDATE tags SET last_used_at = ? WHERE id = ?', [now_iso(), $tag['id']]);
        } else {
            if ($isPass) return admit_pass($staff, $b, $ev);
            $p = qr_parse($b['payload']);
            if (!$p) { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'Not a TicketRoom ticket, or the code has been altered.']; }
            $t = row('SELECT * FROM tickets WHERE code = ?', [$p['code']]);
            if (!$t) {
                // A typed code may belong to a gate pass.
                if (!$p['signed'] && ($g = row('SELECT * FROM gate_passes WHERE code = ?', [$p['code']]))) return admit_pass($staff, $b + ['typed' => $g], $ev);
                // The old code of a ticket or pass that was transferred or reissued.
                $old = row('SELECT kind, ref_id FROM replaced_codes WHERE code = ?', [$p['code']]);
                if ($old && $old['kind'] === 'pass') return admit_pass($staff, $b + ['replacedPass' => $old['ref_id']], $ev);
                if ($old) return $replaced($old['ref_id']);
                $log('invalid');
                return ['outcome' => 'invalid', 'message' => 'Ticket not found.'];
            }
            if ($p['signed'] && $p['version'] !== (int) $t['qr_version']) return $replaced($t['id']);
        }
        if ($t['event_id'] !== $eventId) { $log('wrong_event', $t['id']); return ['outcome' => 'wrong_event', 'message' => 'This ticket is for a different event.']; }
        // Sold on TicketRoom Exchange: the buyer has a new code, this one is void.
        if ($t['status'] === 'revoked' && $t['revoked_reason'] === 'resold') { $log('revoked', $t['id']); return ['outcome' => 'resold', 'message' => 'This ticket was resold on TicketRoom Exchange. The new owner has a new code.', 'holderName' => $t['holder_name']]; }
        if (in_array($t['status'], ['revoked', 'refunded'], true)) { $log($t['status'], $t['id']); return ['outcome' => $t['status'], 'message' => "This ticket was {$t['status']}."]; }
        // Bought in test mode (sandbox): never valid for entry.
        if ((int) $t['test'] === 1) { $log('invalid', $t['id']); return ['outcome' => 'test_ticket', 'message' => 'Test ticket, bought while payments were in test mode. Not valid for entry.', 'holderName' => $t['holder_name']]; }
        // Money is on its way back for this ticket: it can't be used as well.
        if (ticket_has_open_refund($t['id'])) { $log('invalid', $t['id']); return ['outcome' => 'refund_pending', 'message' => 'Refund in progress. This ticket is not valid for entry while its refund is open.', 'holderName' => $t['holder_name']]; }
        // Up for resale: it can't be used and sold too.
        if ($t['status'] === 'valid' && val("SELECT 1 FROM resale_listings WHERE ticket_id = ? AND status IN ('active','offered','held')", [$t['id']])) {
            $log('invalid', $t['id']);
            return ['outcome' => 'listed', 'message' => 'This ticket is up for resale. The holder must take it off TicketRoom Exchange first.', 'holderName' => $t['holder_name']];
        }
        $tt = row('SELECT name, kind, admits FROM ticket_types WHERE id = ?', [$t['ticket_type_id']]);
        $type = gate_label($tt);
        // Offline scans synced later keep the time the fan actually walked in.
        $at = $b['at'] ?? now_iso();
        // Weekend, multi-day and season passes: once on each day of the event.
        // The ticket stays valid (its QR keeps working); each day is recorded.
        if (in_array($tt['kind'], PER_DAY_KINDS, true) && $t['status'] === 'valid') {
            $day = sa_day($at);
            $first = val('SELECT admitted_at FROM ticket_entry_days WHERE ticket_id = ? AND day = ?', [$t['id'], $day]);
            if ($first) {
                $log('already_used', $t['id']);
                return ['outcome' => 'already_used', 'message' => 'Already scanned today.', 'admittedAt' => $first, 'holderName' => $t['holder_name'], 'ticketType' => $type, 'ageRestriction' => $age];
            }
            q('INSERT INTO ticket_entry_days (ticket_id, day, admitted_at, admitted_by) VALUES (?,?,?,?)', [$t['id'], $day, $at, $staff['id']]);
            q('UPDATE tickets SET admitted_at = COALESCE(admitted_at, ?), admitted_by = COALESCE(admitted_by, ?), updated_at = ? WHERE id = ?', [$at, $staff['id'], now_iso(), $t['id']]);
            $log('admitted', $t['id']);
            return ['outcome' => 'admitted', 'message' => 'Admit', 'holderName' => $t['holder_name'], 'ticketType' => "$type · Today only", 'code' => $t['code'], 'admits' => (int) $tt['admits'], 'perDay' => true, 'ageRestriction' => $age];
        }
        if (affected("UPDATE tickets SET status = 'used', admitted_at = ?, admitted_by = ?, updated_at = ? WHERE id = ? AND status = 'valid'", [$at, $staff['id'], now_iso(), $t['id']]) === 0) {
            $log('already_used', $t['id']);
            return ['outcome' => 'already_used', 'message' => 'Already scanned.', 'admittedAt' => $t['admitted_at'], 'holderName' => $t['holder_name'], 'ticketType' => $type, 'ageRestriction' => $age];
        }
        $log('admitted', $t['id']);
        return ['outcome' => 'admitted', 'message' => 'Admit', 'holderName' => $t['holder_name'], 'ticketType' => $type, 'code' => $t['code'], 'admits' => (int) $tt['admits'], 'ageRestriction' => $age];
    });
}
// Runs inside admit()'s transaction. Re-entry passes are let in every time
// (each entry is logged); single-entry passes work once, like a ticket.
function admit_pass(array $staff, array $b, array $ev): array
{
    $log = function (string $outcome, ?string $passId = null) use ($ev, $staff, $b) {
        q('INSERT INTO admission_log (event_id, pass_id, scanned_by, outcome, gate, occurred_at) VALUES (?,?,?,?,?,?)', [$ev['id'], $passId, $staff['id'], $outcome, $b['gate'] ?? null, $b['at'] ?? now_iso()]);
    };
    $replaced = function (?string $passId) use ($log) { $log('invalid', $passId); return ['outcome' => 'replaced', 'message' => 'This pass was replaced. Ask for the current pass.']; };
    if (isset($b['replacedPass'])) return $replaced($b['replacedPass']);
    if (isset($b['typed'])) $g = $b['typed'];
    else {
        $p = pass_parse($b['payload']);
        if (!$p) { $log('invalid'); return ['outcome' => 'invalid', 'message' => 'Not a TicketRoom pass, or the code has been altered.']; }
        $g = row('SELECT * FROM gate_passes WHERE code = ?', [$p['code']]);
        if (!$g) {
            $old = val("SELECT ref_id FROM replaced_codes WHERE code = ? AND kind = 'pass'", [$p['code']]);
            if ($old) return $replaced($old);
            $log('invalid');
            return ['outcome' => 'invalid', 'message' => 'Pass not found.'];
        }
        if ($p['version'] !== (int) $g['qr_version']) return $replaced($g['id']);
    }
    $label = 'Gate pass · ' . (PASS_ROLES[$g['role']] ?? $g['role']) . ($g['access_note'] ? " · {$g['access_note']}" : '');
    if ($g['event_id'] !== $ev['id']) { $log('wrong_event', $g['id']); return ['outcome' => 'wrong_event', 'message' => 'This pass is for a different event.', 'holderName' => $g['holder_name']]; }
    if ($g['status'] !== 'active') { $log('revoked', $g['id']); return ['outcome' => 'revoked', 'message' => 'This pass was cancelled by the organiser.', 'holderName' => $g['holder_name']]; }
    $now = admit_moment($b);
    if ($now < to_unix($ev['starts_at']) - PASS_BEFORE_H * 3600 || $now > to_unix($ev['ends_at']) + PASS_AFTER_H * 3600) {
        $log('event_not_live', $g['id']);
        return ['outcome' => 'event_not_live', 'message' => 'Passes for this event are not valid right now.'];
    }
    $at = $b['at'] ?? now_iso();
    $once = (int) $g['reentry'] === 0;
    if (affected('UPDATE gate_passes SET scans = scans + 1, first_scanned_at = COALESCE(first_scanned_at, ?), last_scanned_at = ?, updated_at = ? WHERE id = ?' . ($once ? ' AND scans = 0' : ''), [$at, $at, now_iso(), $g['id']]) === 0) {
        $log('already_used', $g['id']);
        return ['outcome' => 'already_used', 'message' => 'Single-entry pass, already scanned.', 'admittedAt' => $g['first_scanned_at'], 'holderName' => $g['holder_name'], 'ticketType' => $label];
    }
    $log('admitted', $g['id']);
    return ['outcome' => 'admitted', 'message' => 'Admit', 'holderName' => $g['holder_name'], 'ticketType' => $label, 'code' => $g['code'], 'pass' => true, 'reentry' => !$once];
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
    upload_quota_check($orgId, strlen($buf));
    $id = uuid();
    $dir = data_dir() . '/uploads';
    if (!is_dir($dir)) mkdir($dir, 0750, true);
    file_put_contents("$dir/$id", $buf, LOCK_EX);
    // Images are served through the application media route; the web/PHP
    // account needs access, but other local users do not.
    @chmod("$dir/$id", 0600);
    insert('uploads', ['id' => $id, 'owner_id' => $ownerId, 'organiser_id' => $orgId, 'mime_type' => $mime, 'size_bytes' => strlen($buf), 'sha256' => hash('sha256', $buf), 'created_at' => now_iso()]);
    return $id;
}
function raw_body(): string { return (string) file_get_contents('php://input', false, null, 0, 2097153); }
