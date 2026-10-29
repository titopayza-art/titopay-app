<?php
// /api/organiser/* — organiser portal: organisation, team, events, ticket
// types, promo codes, tracking links, analytics, orders, attendees, staff and
// live check-ins, and email marketing. Mirrors src/routes/organiser.js.
// Money (refunds, payouts) is in routes/finance.php; vendors, tills and
// wristbands for cashless events are in routes/cashless.php.
// SMS campaigns come with Promote (lib/promote.php): an event with an active
// promotion can be sent SMS campaigns once SMS is set up.
declare(strict_types=1);

const ORG_ALL = ['owner', 'manager', 'marketing', 'finance', 'viewer'];
const ORG_EDIT = ['owner', 'manager'];
const ORG_MONEY = ['owner', 'finance'];
const ORG_MKT = ['owner', 'manager', 'marketing'];
const ORG_PAID = "('paid','partially_refunded','refunded')";
const ORG_DAILY_CAMPAIGN_LIMIT = 10;
const ORG_UNSUB_TTL = 60 * 86400;

// ============================================================== helpers
function org_slugify(string $s): string
{
    $s = mb_strtolower($s);
    if (class_exists('Normalizer')) $s = (string) Normalizer::normalize($s, Normalizer::FORM_KD);
    $s = trim((string) preg_replace('/[^a-z0-9]+/', '-', $s), '-');
    $s = substr($s, 0, 60);
    return $s !== '' ? $s : 'event';
}

// Same rule as R::bool(), but honours the caller's fallback (R::bool() in
// core.php always falls back to false — see the report). No fallback given:
// an absent value is skipped (Node's `fallback: undefined`).
function org_bool(array $o = ['optional' => true]): Closure
{
    return v_rule(function ($v) {
        if ($v === true || $v === 'true' || $v === 'on' || $v === 1) return true;
        if ($v === false || $v === 'false' || $v === 0) return false;
        vfail('Must be true or false.');
    }, $o);
}

function org_view(array $o, string $role): array
{
    return [
        'id' => $o['id'], 'ref' => $o['ref'] ?? null, 'name' => $o['name'], 'slug' => $o['slug'], 'status' => $o['status'], 'contactEmail' => $o['contact_email'], 'contactPhone' => $o['contact_phone'],
        'description' => $o['description'], 'logoUploadId' => $o['logo_upload_id'] ?? null, 'payoutHoldDays' => (int) $o['payout_hold_days'], 'role' => $role,
        'bank' => in_array($role, ORG_MONEY, true) || $role === 'admin'
            ? ['bankName' => $o['bank_name'], 'accountHolder' => $o['bank_account_holder'], 'last4' => $o['bank_account_last4'], 'branchCode' => $o['bank_branch_code']]
            : null,
    ];
}

function org_mask(?string $addr): string
{
    $s = (string) $addr;
    if (str_contains($s, '@')) {
        [$u, $d] = explode('@', $s, 2);
        return substr($u, 0, 1) . '***@' . $d;
    }
    return strlen($s) > 4 ? substr($s, 0, 3) . '*****' . substr($s, -2) : '***';
}

// ============================================================== analytics
function org_dashboard(string $orgId): array
{
    $events = rows("SELECT e.id, e.ref, e.title, e.slug, e.status, e.starts_at, e.capacity,
                           COALESCE((SELECT SUM(quantity_sold) FROM ticket_types WHERE event_id = e.id),0) AS sold,
                           e.is_free, (SELECT count(*) FROM ticket_types WHERE event_id = e.id) AS ticket_types,
                           COALESCE((SELECT SUM(subtotal_cents - discount_cents) FROM orders WHERE event_id = e.id AND status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL),0) AS revenue_cents,
                           COALESCE((SELECT SUM(organiser_fee_cents) FROM orders WHERE event_id = e.id AND status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL),0) AS organiser_fee_cents
                      FROM events e WHERE e.organiser_id = ? ORDER BY e.starts_at DESC", [$orgId]);
    foreach ($events as &$e) foreach (['sold', 'revenue_cents', 'organiser_fee_cents', 'capacity', 'ticket_types'] as $k) $e[$k] = (int) $e[$k];
    unset($e);
    $last7 = row("SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0) AS revenue_cents, COUNT(*) AS orders
                    FROM orders o JOIN events e ON e.id = o.event_id WHERE e.organiser_id = ? AND o.status IN " . ORG_PAID . " AND o.test = 0 AND o.resale_listing_id IS NULL AND o.paid_at > ?", [$orgId, iso_in(-7 * 86400)]);
    $now = now_iso();
    return [
        'events' => $events,
        'totals' => [
            'events' => count($events),
            'live' => count(array_filter($events, fn($e) => $e['status'] === 'published' && $e['starts_at'] > $now)),
            'ticketsSold' => array_sum(array_column($events, 'sold')),
            'revenueCents' => array_sum(array_column($events, 'revenue_cents')),
            'organiserFeeCents' => array_sum(array_column($events, 'organiser_fee_cents')),
            'last7RevenueCents' => (int) $last7['revenue_cents'],
            'last7Orders' => (int) $last7['orders'],
        ],
    ];
}

function org_event_analytics(array $event): array
{
    $id = $event['id'];
    $tr = row("SELECT COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL THEN 1 ELSE 0 END),0) AS orders,
                      COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL THEN subtotal_cents - discount_cents ELSE 0 END),0) AS ticket_revenue_cents,
                      COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL THEN fee_cents ELSE 0 END),0) AS fees_cents,
                      COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL THEN organiser_fee_cents ELSE 0 END),0) AS organiser_fee_cents,
                      COALESCE(SUM(refunded_cents),0) AS refunded_cents,
                      COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END),0) AS abandoned,
                      COALESCE(SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END),0) AS pending
                 FROM orders WHERE event_id = ? AND resale_listing_id IS NULL", [$id]);
    $tr = array_map('intval', $tr);

    // Last 30 days (UTC dates), oldest first, every day present.
    $since = gmdate('Y-m-d', time() - 29 * 86400);
    $tick = [];
    foreach (rows("SELECT substr(o.paid_at,1,10) AS d, SUM(oi.quantity) AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    WHERE o.event_id = ? AND o.status IN " . ORG_PAID . " AND o.test = 0 AND o.resale_listing_id IS NULL AND o.paid_at >= ? GROUP BY 1", [$id, $since]) as $r) $tick[$r['d']] = (int) $r['n'];
    $rev = [];
    foreach (rows("SELECT substr(paid_at,1,10) AS d, SUM(subtotal_cents - discount_cents) AS c FROM orders
                    WHERE event_id = ? AND status IN " . ORG_PAID . " AND test = 0 AND resale_listing_id IS NULL AND paid_at >= ? GROUP BY 1", [$id, $since]) as $r) $rev[$r['d']] = (int) $r['c'];
    $daily = [];
    for ($i = 29; $i >= 0; $i--) {
        $d = gmdate('Y-m-d', time() - $i * 86400);
        $daily[] = ['day' => $d, 'tickets' => $tick[$d] ?? 0, 'revenue_cents' => $rev[$d] ?? 0];
    }

    $byType = rows("SELECT tt.id, tt.name, tt.kind, tt.admits, tt.price_cents, tt.quantity_total, tt.quantity_sold, tt.quantity_held,
                           (SELECT count(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status = 'used') AS checked_in,
                           (SELECT count(*) FROM waitlist_entries w WHERE w.ticket_type_id = tt.id AND w.status IN ('waiting','offered')) AS waiting,
                           (SELECT count(*) FROM resale_listings r WHERE r.ticket_type_id = tt.id AND r.status IN ('active','offered','held')) AS on_resale,
                           (SELECT count(*) FROM resale_listings r WHERE r.ticket_type_id = tt.id AND r.status = 'sold') AS resold
                      FROM ticket_types tt WHERE tt.event_id = ? ORDER BY tt.sort_order, tt.price_cents", [$id]);
    $checkins = row("SELECT COALESCE(SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END),0) AS admitted,
                            COALESCE(SUM(CASE WHEN status IN ('valid','used') THEN 1 ELSE 0 END),0) AS issued FROM tickets WHERE event_id = ?", [$id]);
    // Africa/Johannesburg is UTC+2 all year (no daylight saving).
    $byHour = rows("SELECT strftime('%H:00', occurred_at, '+2 hours') AS hour, count(*) AS n FROM admission_log
                     WHERE event_id = ? AND outcome = 'admitted' GROUP BY 1 ORDER BY 1", [$id]);
    $links = rows("SELECT l.code, l.label, l.clicks,
                          (SELECT count(*) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN " . ORG_PAID . " AND o.test = 0) AS orders,
                          (SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN " . ORG_PAID . " AND o.test = 0) AS revenue_cents
                     FROM tracking_links l WHERE l.event_id = ? ORDER BY revenue_cents DESC", [$id]);
    $promos = rows("SELECT p.code, p.kind, p.value, p.used_count, p.max_uses, p.active,
                           (SELECT COALESCE(SUM(o.discount_cents),0) FROM orders o WHERE o.promo_code_id = p.id AND o.status IN " . ORG_PAID . " AND o.test = 0) AS discount_given_cents
                      FROM promo_codes p WHERE p.event_id = ? ORDER BY p.used_count DESC", [$id]);
    $sold = array_sum(array_map(fn($t) => (int) $t['quantity_sold'], $byType));
    $operations = [
        'gateStaff' => (int) val('SELECT count(*) FROM event_staff WHERE event_id = ? AND can_scan = 1', [$id]),
        'vendors' => (int) val("SELECT count(*) FROM vendors WHERE event_id = ? AND status = 'active'", [$id]),
        'vendorsWithoutProducts' => (int) val("SELECT count(*) FROM vendors v WHERE v.event_id = ? AND v.status = 'active' AND NOT EXISTS (SELECT 1 FROM products p WHERE p.vendor_id = v.id AND p.active = 1)", [$id]),
        'activeTerminals' => (int) val("SELECT count(*) FROM terminals WHERE event_id = ? AND status = 'active' AND last_seen_at >= ?", [$id, iso_in(-300)]),
        'staleTerminals' => (int) val("SELECT count(*) FROM terminals WHERE event_id = ? AND status = 'active' AND (last_seen_at IS NULL OR last_seen_at < ?)", [$id, iso_in(-300)]),
        'pendingOrders' => (int) val("SELECT count(*) FROM orders WHERE event_id = ? AND status = 'pending_payment'", [$id]),
        'openRefunds' => (int) val("SELECT count(*) FROM refunds WHERE event_id = ? AND status IN ('requested','processing','manual_pending')", [$id]),
        'ticketsRemaining' => max(0, (int) $event['capacity'] - (int) val('SELECT COALESCE(SUM((quantity_sold + quantity_held) * admits),0) FROM ticket_types WHERE event_id = ?', [$id])),
    ];
    return [
        'totals' => $tr + ['ticketsSold' => $sold, 'capacity' => (int) $event['capacity'], 'payableCents' => 0, 'isFree' => (bool) $event['is_free']],
        'daily' => $daily, 'byType' => $byType, 'checkins' => ['admitted' => (int) $checkins['admitted'], 'issued' => (int) $checkins['issued']],
        'checkinsByHour' => $byHour, 'trackingLinks' => $links, 'promoCodes' => $promos, 'operations' => $operations,
    ] + cashless_event_analytics($event);
}

// ============================================================== events
function org_event_shape(bool $partial = false): array
{
    $o = $partial ? ['optional' => true] : [];
    return [
        'title' => R::str(['min' => 3, 'max' => 140] + $o), 'summary' => R::str(['optional' => true, 'max' => 240]), 'description' => R::text(['optional' => true, 'max' => 8000]),
        'category' => R::oneOf(['music', 'festival', 'comedy', 'sport', 'arts', 'food', 'business', 'family', 'nightlife', 'other'], $o),
        'venueName' => R::str(['min' => 2, 'max' => 140] + $o), 'address' => R::str(['optional' => true, 'max' => 240]), 'city' => R::str(['min' => 2, 'max' => 80] + $o),
        'province' => R::oneOf(['Eastern Cape', 'Free State', 'Gauteng', 'KwaZulu-Natal', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape', 'Western Cape'], ['optional' => true]),
        'startsAt' => R::date($o), 'endsAt' => R::date($o), 'doorsOpenAt' => R::date(['optional' => true]), 'capacity' => R::int(['min' => 1, 'max' => 200000] + $o),
        'salesStartAt' => R::date(['optional' => true]), 'salesEndAt' => R::date(['optional' => true]),
        'presaleQueueEnabled' => org_bool(),
        'parkRideInfo' => R::text(['optional' => true, 'max' => 1200]),
        'parkRideUrl' => R::str(['optional' => true, 'max' => 500, 'pattern' => '#^https://[^\\s]+$#i', 'message' => 'Use a secure https:// link.']),
        'refundPolicy' => R::text(['optional' => true, 'max' => 2000]), 'accessibilityInfo' => R::text(['optional' => true, 'max' => 2000]), 'ageRestriction' => R::str(['optional' => true, 'max' => 60]),
        'transfersEnabled' => org_bool(), 'resaleEnabled' => org_bool(), 'cashlessEnabled' => org_bool(), 'imageUploadId' => R::uuid(['optional' => true]),
        'serviceFeePayer' => R::oneOf(['customer', 'organiser'], $partial ? $o : ['optional' => true, 'fallback' => 'customer']),
        'isFree' => org_bool(), 'ageGroups' => R::arr(R::oneOf(array_keys(AGE_GROUPS)), ['optional' => true, 'max' => 8]),
        'lineup' => R::text(['optional' => true, 'max' => 4000]),
        'prohibitedItems' => R::text(['optional' => true, 'max' => 1200]),
        // JSON list of {name, note, imageUploadId}; checked by org_ticket_groups().
        'ticketGroups' => R::text(['optional' => true, 'max' => 6000]),
    ];
}
// Ticket groups: a banner image and a note for each group name used on ticket types.
// Stored as JSON: [{"name":"VIP","note":"…","imageUploadId":"…"}].
function org_ticket_groups(array $b, string $orgId): array
{
    if (!array_key_exists('ticketGroups', $b)) return $b;
    $raw = trim((string) $b['ticketGroups']);
    $list = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($list) || !array_is_list($list)) throw bad('Ticket groups could not be read.', ['ticketGroups' => 'Invalid ticket groups.']);
    if (count($list) > 12) throw bad('Up to 12 ticket groups.', ['ticketGroups' => 'Up to 12 groups.']);
    $out = []; $seen = [];
    foreach ($list as $g) {
        if (!is_array($g)) continue;
        $name = mb_substr(trim(preg_replace('/\s+/u', ' ', (string) ($g['name'] ?? ''))), 0, 60);
        if ($name === '' || isset($seen[mb_strtolower($name)])) continue;
        $seen[mb_strtolower($name)] = true;
        $img = (string) ($g['imageUploadId'] ?? '');
        if ($img !== '' && !preg_match('/^[0-9a-f-]{36}$/', $img)) $img = '';
        if ($img !== '') org_assert_upload($orgId, $img);
        $out[] = ['name' => $name, 'note' => mb_substr(trim((string) ($g['note'] ?? '')), 0, 240), 'imageUploadId' => $img ?: null];
    }
    $b['ticketGroups'] = $out ? json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '';
    return $b;
}
// The line-up is typed one act per line, optionally starting with a time:
// "20:00 Black Coffee". Stored as JSON: [{"name":"Black Coffee","time":"20:00"}].
function org_lineup(array $b): array
{
    if (!array_key_exists('lineup', $b)) return $b;
    $acts = [];
    foreach (preg_split('/\R/', (string) $b['lineup']) as $line) {
        $line = trim(preg_replace('/\s+/', ' ', $line));
        if ($line === '') continue;
        $time = null;
        if (preg_match('/^([01]?\d|2[0-3])[:h.]([0-5]\d)\s*[-,|]?\s*(.+)$/u', $line, $m)) { $time = sprintf('%02d:%s', (int) $m[1], $m[2]); $line = $m[3]; }
        $name = mb_substr(trim($line, " -,|"), 0, 80);
        if ($name !== '') $acts[] = ['name' => $name, 'time' => $time];
    }
    if (count($acts) > 60) throw bad('A line-up can list up to 60 acts.', ['lineup' => 'Up to 60 lines.']);
    $b['lineup'] = $acts ? json_encode($acts, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '';
    return $b;
}
// Target age groups are stored as "18_24,25_34". An 18+ event cannot be aimed
// at children, which would only confuse buyers.
function org_age_groups(array $b, ?string $restriction): array
{
    if (!array_key_exists('ageGroups', $b)) return $b;
    $g = array_values(array_intersect(array_keys(AGE_GROUPS), (array) $b['ageGroups']));
    if (in_array('all', $g, true)) $g = ['all'];
    if (preg_match('/\b(16|18|21)\s*\+/', (string) $restriction) && array_intersect($g, ['all', 'kids', 'teens', 'families'])) {
        throw bad('This event has an age restriction, so it cannot be aimed at children, teens or families.', ['ageGroups' => 'Remove the under-18 groups, or the age restriction.']);
    }
    $b['ageGroups'] = $g ? implode(',', $g) : null;
    return $b;
}
const ORG_EVENT_COLS = ['title' => 'title', 'summary' => 'summary', 'description' => 'description', 'category' => 'category', 'venueName' => 'venue_name', 'address' => 'address',
    'city' => 'city', 'province' => 'province', 'startsAt' => 'starts_at', 'endsAt' => 'ends_at', 'doorsOpenAt' => 'doors_open_at', 'capacity' => 'capacity',
    'salesStartAt' => 'sales_start_at', 'salesEndAt' => 'sales_end_at', 'presaleQueueEnabled' => 'presale_queue_enabled', 'parkRideInfo' => 'park_ride_info', 'parkRideUrl' => 'park_ride_url', 'refundPolicy' => 'refund_policy', 'accessibilityInfo' => 'accessibility_info',
    'ageRestriction' => 'age_restriction', 'transfersEnabled' => 'transfers_enabled', 'resaleEnabled' => 'resale_enabled', 'cashlessEnabled' => 'cashless_enabled', 'imageUploadId' => 'image_upload_id', 'isFree' => 'is_free',
    'ageGroups' => 'age_groups', 'lineup' => 'lineup', 'serviceFeePayer' => 'service_fee_payer', 'prohibitedItems' => 'prohibited_items', 'ticketGroups' => 'ticket_groups'];

function org_assert_upload(string $orgId, ?string $uploadId): void
{
    if (!$uploadId) return;
    if (!val('SELECT 1 FROM uploads WHERE id = ? AND organiser_id = ?', [$uploadId, $orgId])) throw bad('Image not found.');
}

function org_tt_shape(array $o = []): array
{
    return [
        'name' => R::str(['min' => 1, 'max' => 80] + $o), 'description' => R::str(['optional' => true, 'max' => 240]), 'priceCents' => R::int(['min' => 0, 'max' => 10000000] + $o),
        'quantityTotal' => R::int(['min' => 0, 'max' => 200000] + $o), 'perOrderLimit' => R::int(['min' => 1, 'max' => 50, 'optional' => true]),
        'salesStartAt' => R::date(['optional' => true]), 'salesEndAt' => R::date(['optional' => true]), 'status' => R::oneOf(['on_sale', 'paused', 'hidden'], ['optional' => true]),
        'sortOrder' => R::int(['optional' => true, 'min' => 0, 'max' => 1000]),
        'kind' => R::oneOf(array_keys(TICKET_KINDS), ['optional' => true]), 'admits' => R::int(['optional' => true, 'min' => 1, 'max' => 20]),
        // Optional group shown on the ticket page (e.g. "VIP"); empty means ungrouped.
        'group' => R::text(['optional' => true, 'max' => 60]),
        // Phase: the ticket type this one follows (opens when that one sells out); empty for none.
        'releaseAfter' => R::text(['optional' => true, 'max' => 40]),
    ];
}
const ORG_TT_COLS = ['name' => 'name', 'description' => 'description', 'priceCents' => 'price_cents', 'quantityTotal' => 'quantity_total', 'perOrderLimit' => 'per_order_limit',
    'salesStartAt' => 'sales_start_at', 'salesEndAt' => 'sales_end_at', 'status' => 'status', 'sortOrder' => 'sort_order', 'kind' => 'kind', 'admits' => 'admits', 'group' => 'group_name', 'releaseAfter' => 'release_after'];

// A phase must follow another ticket type of the same event, and phases cannot go round in a circle.
function org_release_after(string $eventId, ?string $ttId, array $b): array
{
    if (!array_key_exists('releaseAfter', $b)) return $b;
    $after = trim((string) $b['releaseAfter']);
    if ($after === '') { $b['releaseAfter'] = null; return $b; }
    if ($after === $ttId) throw bad('A ticket cannot follow itself.', ['releaseAfter' => 'Choose a different ticket.']);
    $seen = [];
    for ($cur = $after; $cur; $cur = val('SELECT release_after FROM ticket_types WHERE id = ? AND event_id = ?', [$cur, $eventId])) {
        if (!val('SELECT 1 FROM ticket_types WHERE id = ? AND event_id = ?', [$cur, $eventId])) throw bad('That ticket is not part of this event.', ['releaseAfter' => 'Choose a ticket from this event.']);
        if ($cur === $ttId || isset($seen[$cur])) throw bad('Those phases would go round in a circle.', ['releaseAfter' => 'Choose an earlier ticket.']);
        $seen[$cur] = true;
    }
    $b['releaseAfter'] = $after;
    return $b;
}

function org_event_change_input(array $raw, array $event): array
{
    $shape = org_event_shape(true);
    if ($unknown = array_diff(array_keys($raw), array_keys($shape))) throw invalid(['changes' => 'One or more event fields are not editable.']);
    $input = $raw;
    $cleared = [];
    foreach (['summary', 'address', 'province', 'ageRestriction', 'parkRideUrl'] as $key) {
        if (array_key_exists($key, $raw) && is_string($raw[$key]) && trim($raw[$key]) === '') { $input[$key] = null; $cleared[] = $key; }
    }
    $b = check($input, $shape);
    if (array_key_exists('parkRideInfo', $raw) && trim((string) $raw['parkRideInfo']) === '') $b['parkRideInfo'] = '';
    if (array_key_exists('parkRideUrl', $raw) && trim((string) $raw['parkRideUrl']) === '') $b['parkRideUrl'] = '';
    foreach ($cleared as $key) $b[$key] = null;
    if (array_key_exists('ageGroups', $raw) && !isset($b['ageGroups'])) $b['ageGroups'] = [];
    $b = org_ticket_groups(org_lineup(org_age_groups($b, array_key_exists('ageRestriction', $b) ? $b['ageRestriction'] : $event['age_restriction'])), $event['organiser_id']);
    return array_filter($b, fn($v, $k) => $v !== null || $k === 'ageGroups' || in_array($k, $cleared, true), ARRAY_FILTER_USE_BOTH);
}

function org_event_change_revalidate(array $stored, array $event): array
{
    $raw = $stored;
    foreach (['summary', 'address', 'province', 'ageRestriction', 'parkRideUrl'] as $key) if (array_key_exists($key, $raw) && $raw[$key] === null) $raw[$key] = '';
    if (array_key_exists('ageGroups', $raw)) $raw['ageGroups'] = is_string($raw['ageGroups']) && $raw['ageGroups'] !== '' ? explode(',', $raw['ageGroups']) : [];
    if (array_key_exists('lineup', $raw) && is_string($raw['lineup'])) {
        $acts = json_decode($raw['lineup'], true);
        $raw['lineup'] = is_array($acts) ? implode("\n", array_map(fn($a) => (!empty($a['time']) ? $a['time'] . ' ' : '') . (string) ($a['name'] ?? ''), $acts)) : '';
    }
    return org_event_change_input($raw, $event);
}

function org_event_change_assert(array $event, array $b, bool $review = false): array
{
    if (in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event can no longer be edited.', 'event_locked');
    cashless_guard_switch($event, $b);
    org_assert_upload($event['organiser_id'], $b['imageUploadId'] ?? null);
    $occupied = (int) val('SELECT COALESCE(SUM((quantity_sold + quantity_held) * admits),0) FROM ticket_types WHERE event_id = ?', [$event['id']]);
    $material = array_values(array_filter(['title', 'startsAt', 'endsAt', 'venueName', 'city', 'address', 'province'], function ($k) use ($b, $event) {
        if (!array_key_exists($k, $b)) return false;
        $cur = $event[ORG_EVENT_COLS[$k]];
        $next = is_bool($b[$k]) ? (int) $b[$k] : $b[$k];
        return (string) $next !== (string) ($cur ?? '');
    }));
    if (!$review && $occupied > 0 && $material) throw conflict('Tickets have been sold, so date and venue changes must be submitted for admin review. Buyers are notified after approval.', 'material_change', ['fields' => $material]);
    if (isset($b['capacity']) && $b['capacity'] < $occupied) throw conflict("Capacity cannot be below the $occupied tickets already sold or held.", 'capacity_below_sold');
    $starts = $b['startsAt'] ?? $event['starts_at'];
    $ends = $b['endsAt'] ?? $event['ends_at'];
    if (!empty($b['presaleQueueEnabled']) && empty($b['salesStartAt']) && empty($event['sales_start_at'])) throw bad('Set a sales opening time before enabling the presale queue.', ['salesStartAt' => 'Required for the presale queue.']);
    if (to_unix($ends) <= to_unix($starts)) throw bad('The event must end after it starts.');
    if (array_key_exists('isFree', $b) && (bool) $b['isFree'] !== (bool) $event['is_free']) {
        $paid = (int) val('SELECT COALESCE(SUM(CASE WHEN price_cents > 0 THEN 1 ELSE 0 END),0) FROM ticket_types WHERE event_id = ?', [$event['id']]);
        if ($occupied > 0) throw conflict('An event with sales cannot be switched between free and paid.', 'free_switch_locked');
        if ($b['isFree'] && $paid > 0) throw conflict('Remove or set to R0 the paid ticket types before making this a free event.', 'free_event');
    }
    return ['occupied' => $occupied, 'materialFields' => $material];
}

function org_ticket_change_fields(array $raw, ?string $id): array
{
    $shape = $id ? org_tt_shape(['optional' => true]) : org_tt_shape();
    if ($unknown = array_diff(array_keys($raw), array_keys($shape))) throw invalid(['ticketType' => 'One or more ticket fields are not editable.']);
    $input = $raw;
    $cleared = [];
    foreach (['description', 'salesStartAt', 'salesEndAt', 'releaseAfter'] as $key) {
        if (array_key_exists($key, $raw) && ($raw[$key] === null || (is_string($raw[$key]) && trim($raw[$key]) === ''))) { $input[$key] = null; $cleared[] = $key; }
    }
    $b = check($input, $shape);
    foreach ($cleared as $key) $b[$key] = null;
    if (!$b) throw invalid(['ticketType' => 'Add at least one ticket change.']);
    return $b;
}

function org_ticket_change_input(array $raw, array $event): array
{
    if ($unknown = array_diff(array_keys($raw), ['id', 'changes'])) throw invalid(['ticketType' => 'One or more ticket fields are not editable.']);
    $id = isset($raw['id']) && $raw['id'] !== '' ? check(['id' => $raw['id']], ['id' => R::uuid()])['id'] : null;
    if (!isset($raw['changes']) || !is_array($raw['changes']) || ($raw['changes'] !== [] && array_is_list($raw['changes']))) throw invalid(['ticketType' => 'Add the proposed ticket changes.']);
    $changes = org_ticket_change_fields($raw['changes'], $id);
    $current = $id ? row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$id, $event['id']]) : null;
    if ($id && !$current) throw not_found('Ticket type not found.');
    if ($current) $changes = array_filter($changes, fn($v, $k) => (string) ($v ?? '') !== (string) ($current[ORG_TT_COLS[$k]] ?? ''), ARRAY_FILTER_USE_BOTH);
    if (!$changes) throw invalid(['ticketType' => 'The proposed ticket changes are the same as the current ticket.']);
    org_ticket_change_assert($event, $changes, $current);
    return ['id' => $id, 'changes' => $changes, 'current' => $current];
}

function org_ticket_change_assert(array $event, array $b, ?array $current): void
{
    if (!empty($b['releaseAfter'])) org_release_after($event['id'], $current['id'] ?? null, $b);
    $price = $b['priceCents'] ?? ($current ? (int) $current['price_cents'] : 0);
    if (!empty($event['is_free']) && $price > 0) throw conflict('This is a free event, so every ticket type costs R0.', 'free_event');
    if ($price > 0 && $price < 1000) throw bad('Paid tickets must cost at least R10.', ['priceCents' => 'Minimum R10, or R0 for free.']);
    if (!$current) return;
    $taken = (int) $current['quantity_sold'] + (int) $current['quantity_held'];
    if (isset($b['priceCents']) && $b['priceCents'] !== (int) $current['price_cents'] && $taken > 0) throw conflict('Price cannot change after tickets of this type are sold. Create a new ticket type (e.g. a new release) instead.', 'price_locked');
    if (isset($b['quantityTotal']) && $b['quantityTotal'] < $taken) throw conflict("Quantity cannot go below $taken (sold + reserved).", 'quantity_below_sold');
    if (isset($b['admits']) && $b['admits'] !== (int) $current['admits'] && $taken > 0) throw conflict('People per ticket cannot change after tickets of this type are sold. Create a new ticket type instead.', 'admits_locked');
}

function org_event_db_value(string $key, $value)
{
    return is_bool($value) ? (int) $value : $value;
}

function org_link_url(array $event, string $code): string { return base_url() . '/events/' . $event['slug'] . '?ref=' . $code; }

function org_csv_esc($v): string
{
    $s = (string) ($v ?? '');
    $q = str_replace('"', '""', $s);
    // A cell starting with = + - @ (or tab/CR) would run as a formula in Excel.
    return preg_match('/^[=+\-@\t\r]/', $s) ? "\"'$q\"" : "\"$q\"";
}

// ============================================================== marketing
// Consented audience: people who bought from (or hold tickets for) this
// organiser AND opted in to its marketing on that channel (POPIA s69).
function org_audience(string $orgId, string $channel, ?array $eventIds): array
{
    $contact = $channel === 'sms' ? 'u.phone' : 'u.email';
    $ids = array_values(array_filter((array) $eventIds));
    $evf = $ids ? 'AND e.id IN (' . placeholders($ids) . ')' : '';
    $p = array_merge([$orgId, $channel, $orgId], $ids, [$orgId], $ids);
    return rows("SELECT DISTINCT u.id AS user_id, u.full_name, $contact AS address
                   FROM users u
                   JOIN marketing_consents mc ON mc.user_id = u.id AND mc.organiser_id = ? AND mc.channel = ? AND mc.granted = 1
                  WHERE u.status = 'active' AND $contact IS NOT NULL
                    AND (EXISTS (SELECT 1 FROM orders o JOIN events e ON e.id = o.event_id
                                  WHERE o.user_id = u.id AND e.organiser_id = ? AND o.status IN " . ORG_PAID . " AND o.test = 0 $evf)
                      OR EXISTS (SELECT 1 FROM tickets t JOIN events e ON e.id = t.event_id
                                  WHERE t.owner_user_id = u.id AND e.organiser_id = ? $evf))", $p);
}

function org_audience_summary(string $orgId, array $eventIds): array
{
    $evf = $eventIds ? 'AND e.id IN (' . placeholders($eventIds) . ')' : '';
    $n = (int) val("SELECT COUNT(DISTINCT t.owner_user_id) FROM tickets t JOIN events e ON e.id = t.event_id
                     WHERE e.organiser_id = ? AND t.status IN ('valid','used') $evf", array_merge([$orgId], $eventIds));
    return ['ticketHolders' => $n, 'emailOptIns' => count(org_audience($orgId, 'email', $eventIds)), 'smsOptIns' => count(org_audience($orgId, 'sms', $eventIds))];
}

function org_unsubscribe_url(string $userId, string $orgId, string $channel): string
{
    return base_url() . '/unsubscribe?t=' . sign_link(['u' => $userId, 'o' => $orgId, 'c' => $channel], ORG_UNSUB_TTL);
}

// $link: the campaign's own tracking link (promoted events). It goes where
// the message says {{event_link}}, or at the end. Without one, {{event_link}}
// becomes the event's plain address (or is left out for several events).
function org_render(array $camp, array $org, array $recipient, ?string $link = null): array
{
    $first = explode(' ', (string) ($recipient['full_name'] ?? ''))[0];
    if ($first === '') $first = 'there';
    $body = preg_replace_callback('/\{\{\s*first_name\s*\}\}/', fn() => $first, (string) $camp['body']);
    $has = (bool) preg_match('/\{\{\s*event_link\s*\}\}/', $body);
    if ($has || $link !== null) {
        $url = $link ?? org_plain_event_link($camp);
        if ($has) $body = preg_replace_callback('/\{\{\s*event_link\s*\}\}/', fn() => $url, $body);
        elseif ($link !== null) $body .= ($camp['channel'] === 'sms' ? ' ' : "\n\nGet your tickets: ") . $link;
    }
    $unsub = org_unsubscribe_url((string) $recipient['user_id'], $camp['organiser_id'], $camp['channel']);
    if ($camp['channel'] === 'sms') return ['body' => "{$org['name']}: $body Opt out: $unsub"];
    return [
        'subject' => $camp['subject'],
        'body' => "$body\n\n-- \nYou're getting this because you booked with {$org['name']} on TicketRoom and said you'd like to hear from them.\nUnsubscribe: $unsub\nTicketRoom (Pty) Ltd · Reg. no. 2026/811077/07",
    ];
}

function org_sms_unavailable(): AppError
{
    if (!sms_ready()) return conflict('SMS is not set up on TicketRoom yet. Send an email campaign instead.', 'sms_not_available', ['channel' => 'Only email is available for now.']);
    return conflict('SMS campaigns come with Promote. Promote the event, then choose only that event as the audience.', 'sms_not_available', ['channel' => 'SMS needs an active Promote package for the one event in the audience.']);
}
// SMS goes out only for a promoted event, and only once SMS is set up.
function org_sms_allowed(array $camp): bool { return sms_ready() && promo_for_campaign($camp) !== null; }
function org_plain_event_link(array $camp): string
{
    $aud = is_array($camp['audience'] ?? null) ? $camp['audience'] : (json_decode((string) ($camp['audience'] ?? ''), true) ?: []);
    $ids = (array) ($aud['eventIds'] ?? []);
    $slug = count($ids) === 1 ? val('SELECT slug FROM events WHERE id = ?', [$ids[0]]) : null;
    return base_url() . ($slug ? "/events/$slug" : '/');
}
// Campaigns sent today that count towards the daily cap: those for promoted
// events have their own hourly cap instead (PROMO_HOURLY_LIMIT).
function org_campaign_caps(string $orgId, ?array $promo): void
{
    if ($promo) {
        $hour = (int) val("SELECT count(*) FROM campaigns WHERE organiser_id = ? AND status IN ('sending','sent') AND sent_at > ?", [$orgId, iso_in(-3600)]);
        if ($hour >= PROMO_HOURLY_LIMIT) throw conflict('You can send up to ' . PROMO_HOURLY_LIMIT . ' campaigns an hour. Please wait a little before the next one.', 'campaign_limit');
        return;
    }
    $today = (int) val("SELECT count(*) FROM campaigns WHERE organiser_id = ? AND status IN ('sending','sent') AND sent_at > ? AND promotion_id IS NULL", [$orgId, iso_in(-86400)]);
    if ($today >= ORG_DAILY_CAMPAIGN_LIMIT) throw conflict('You can send at most ' . ORG_DAILY_CAMPAIGN_LIMIT . ' campaigns a day.', 'campaign_limit');
}

function org_campaign_shape(array $o = []): array
{
    return [
        'channel' => R::oneOf(['email', 'sms'], $o), 'name' => R::str(['min' => 2, 'max' => 100] + $o), 'subject' => R::str(['optional' => true, 'max' => 150]),
        'body' => R::text(['max' => 5000] + $o), 'eventIds' => R::arr(R::uuid(), ['optional' => true, 'max' => 50]),
    ];
}

function org_validate_campaign(string $orgId, array $b): void
{
    if (($b['channel'] ?? null) === 'sms' && !org_sms_allowed(['organiser_id' => $orgId, 'audience' => ['eventIds' => $b['eventIds'] ?? []]])) throw org_sms_unavailable();
    if (($b['channel'] ?? null) === 'email' && empty($b['subject'])) throw bad('Email campaigns need a subject.', ['subject' => 'Required for email.']);
    $ids = $b['eventIds'] ?? [];
    if ($ids) {
        $ids = array_values(array_unique($ids));
        $n = (int) val('SELECT count(*) FROM events WHERE organiser_id = ? AND id IN (' . placeholders($ids) . ')', array_merge([$orgId], $ids));
        if ($n !== count($b['eventIds'])) throw bad('Audience includes events that are not yours.');
    }
}

function org_get_campaign(string $orgId, string $id): array
{
    $c = row('SELECT * FROM campaigns WHERE id = ? AND organiser_id = ?', [$id, $orgId]);
    if (!$c) throw not_found('Campaign not found.');
    return $c;
}

// Queues one marketing email per consented recipient. The unique
// (campaign, user) index in the outbox makes a double send harmless.
function org_send_campaign(array $actor, string $orgId, string $campaignId): array
{
    return tx(function () use ($actor, $orgId, $campaignId) {
        $camp = org_get_campaign($orgId, $campaignId);
        if (!in_array($camp['status'], ['draft', 'scheduled'], true)) throw conflict("This campaign is already {$camp['status']}.", 'bad_transition');
        // A campaign for one promoted event: no daily cap (an hourly one
        // instead), SMS allowed, and its own tracking link for the analytics.
        $promo = promo_for_campaign($camp);
        if ($camp['channel'] !== 'email' && !org_sms_allowed($camp)) throw org_sms_unavailable();
        $org = row('SELECT * FROM organisers WHERE id = ?', [$orgId]);
        if ($org['status'] !== 'approved') throw conflict('Your organiser account must be approved before sending marketing.', 'organiser_not_approved');
        org_campaign_caps($orgId, $promo);
        $link = null;
        if ($promo) {
            $event = row('SELECT * FROM events WHERE id = ?', [$promo['event_id']]);
            $code = 'C' . random_code(7);
            insert('tracking_links', ['id' => uuid(), 'event_id' => $event['id'], 'code' => $code, 'label' => ($camp['channel'] === 'sms' ? 'SMS: ' : 'Email: ') . mb_substr($camp['name'], 0, 70),
                'clicks' => 0, 'created_at' => now_iso(), 'campaign_id' => $camp['id']]);
            $link = org_link_url($event, $code);
        }
        $recipients = org_audience($orgId, $camp['channel'], $camp['audience']['eventIds'] ?? []);
        $segments = 0;
        foreach ($recipients as $r) {
            $msg = org_render($camp, $org, $r, $link);
            if ($camp['channel'] === 'sms') $segments += promo_sms_segments($msg['body']);
            outbox_enqueue(['channel' => $camp['channel'], 'kind' => 'marketing', 'to' => $r['address'], 'subject' => $msg['subject'] ?? null, 'body' => $msg['body'],
                'userId' => $r['user_id'], 'campaignId' => $camp['id']]);
        }
        $now = now_iso();
        q("UPDATE campaigns SET status = 'sent', sent_at = ?, recipients_count = ?, estimated_cost_cents = ?, promotion_id = ?, updated_at = ? WHERE id = ?",
            [$now, count($recipients), $segments * promo_sms_cost(), $promo['id'] ?? null, $now, $camp['id']]);
        audit('campaign.sent', ['actor' => $actor, 'entityType' => 'campaign', 'entityId' => $camp['id'], 'organiserId' => $orgId,
            'details' => ['channel' => $camp['channel'], 'recipients' => count($recipients)] + ($promo ? ['promotion' => $promo['reference']] : [])]);
        return row('SELECT * FROM campaigns WHERE id = ?', [$camp['id']]);
    });
}

// Sends campaigns whose scheduled time has come (the 'scheduled-campaigns' job).
function org_due_scheduled_campaigns(): int
{
    $list = rows("SELECT id, organiser_id, created_by FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 20", [now_iso()]);
    foreach ($list as $r) {
        try {
            org_send_campaign(['id' => $r['created_by']], $r['organiser_id'], $r['id']);
        } catch (Throwable $e) {
            q("UPDATE campaigns SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'scheduled'", [now_iso(), $r['id']]);
            error_log("[campaigns] scheduled send failed {$r['id']}: " . $e->getMessage());
        }
    }
    return count($list);
}

// ============================================================== organiser account
route('POST', '/api/organiser/apply', function () {
    $u = require_auth();
    limit('orgapply', 5, 24 * 3600, $u['id']);
    // Only organiser accounts run organisations. Customers and staff never become organisers.
    if (account_type($u) !== 'organiser') throw new AppError(403, 'not_organiser_account', "Organisations are run from an organiser account. Sign out, then create an organiser account with a different email.");
    $b = check(body(), ['name' => R::str(['min' => 2, 'max' => 120]), 'contactEmail' => R::email(), 'contactPhone' => R::phone(['optional' => true]), 'description' => R::text(['optional' => true, 'max' => 2000])]);
    $org = tx(function () use ($u, $b) {
        $now = now_iso();
        $o = insert('organisers', ['id' => uuid(), 'ref' => new_ref('organisers'), 'name' => $b['name'], 'slug' => org_slugify($b['name']) . '-' . strtolower(random_code(4)), 'contact_email' => $b['contactEmail'],
            'contact_phone' => $b['contactPhone'] ?? null, 'description' => ($b['description'] ?? '') !== '' ? $b['description'] : null, 'status' => 'pending', 'created_at' => $now]);
        insert('organiser_members', ['organiser_id' => $o['id'], 'user_id' => $u['id'], 'role' => 'owner', 'created_at' => $now]);
        audit('organiser.applied', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $o['id'], 'organiserId' => $o['id']]);
        return $o;
    });
    return json_out(['organiser' => ['id' => $org['id'], 'name' => $org['name'], 'status' => $org['status']]], 201);
});

// One step for someone new: their account and their organisation together.
// Same rules as any sign-up: one account per email, confirmed before use.
route('POST', '/api/organiser/signup', function () {
    limit('register', 60, 3600);
    $b = check(body(), ['fullName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(), 'phone' => R::phone(['optional' => true]), 'password' => R::password(),
        'organisation' => R::str(['min' => 2, 'max' => 120]), 'description' => R::text(['optional' => true, 'max' => 2000]), 'acceptTerms' => R::bool()]);
    if (!$b['acceptTerms']) throw bad('Please accept the Terms and Privacy Notice.', ['acceptTerms' => 'Required.']);
    tx(function () use ($b) {
        $now = now_iso();
        $existing = user_by_email($b['email']);
        // One email, one account: an email already used by a customer (even
        // one who only bought as a guest), organiser or staff account is taken.
        // The answer looks the same as for a new account (so it never says who
        // has one); the email's owner is told how to go on.
        if ($existing) {
            if ($existing['status'] === 'active') send_account_exists($existing);
            return;
        }
        if (!empty($b['phone']) && val("SELECT 1 FROM users WHERE phone = ? AND status = 'active' AND guest = 0", [$b['phone']])) {
            throw conflict('This mobile number is already on another TicketRoom account.', 'phone_taken', ['phone' => 'Already on another account.']);
        }
        $u = insert('users', ['id' => uuid(), 'email' => $b['email'], 'email_key' => email_key($b['email']), 'phone' => $b['phone'] ?? null, 'full_name' => $b['fullName'],
            'password_hash' => hash_secret($b['password']), 'status' => 'active', 'account_type' => 'organiser', 'created_at' => $now, 'updated_at' => $now]);
        $o = insert('organisers', ['id' => uuid(), 'ref' => new_ref('organisers'), 'name' => $b['organisation'], 'slug' => org_slugify($b['organisation']) . '-' . strtolower(random_code(4)),
            'contact_email' => $b['email'], 'contact_phone' => $b['phone'] ?? null, 'description' => ($b['description'] ?? '') !== '' ? $b['description'] : null, 'status' => 'pending', 'created_at' => $now]);
        insert('organiser_members', ['organiser_id' => $o['id'], 'user_id' => $u['id'], 'role' => 'owner', 'created_at' => $now]);
        send_verification($u);
        audit('organiser.applied', ['actor' => ['id' => $u['id']], 'entityType' => 'organiser', 'entityId' => $o['id'], 'organiserId' => $o['id'], 'ip' => client_ip(), 'details' => ['withAccount' => true]]);
    });
    return json_out(['needsVerification' => true, 'email' => $b['email'],
        'message' => "We've sent a confirmation link to {$b['email']}. Open it and your organiser portal is ready."], 201);
});

route('GET', '/api/organiser/orgs', function () {
    $u = require_auth();
    return ['organisers' => rows('SELECT o.id, o.name, o.status, m.role FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = ? ORDER BY o.name', [$u['id']])];
});

route('GET', '/api/organiser/:orgId', function ($a) {
    ['organiser' => $o, 'role' => $role] = organiser_access(require_auth(), $a['orgId'], ORG_ALL);
    return ['organiser' => org_view($o, $role)];
});

route('PATCH', '/api/organiser/:orgId', function ($a) {
    ['role' => $role] = organiser_access(require_auth(), $a['orgId'], ORG_EDIT);
    $b = check(body(), ['name' => R::str(['min' => 2, 'max' => 120]), 'contactEmail' => R::email(), 'contactPhone' => R::phone(['optional' => true]), 'description' => R::text(['optional' => true, 'max' => 2000])]);
    q('UPDATE organisers SET name = ?, contact_email = ?, contact_phone = ?, description = ? WHERE id = ?',
        [$b['name'], $b['contactEmail'], $b['contactPhone'] ?? null, ($b['description'] ?? '') !== '' ? $b['description'] : null, $a['orgId']]);
    // The logo: an uploaded image of this organiser's, or "" to remove it.
    if (array_key_exists('logoUploadId', body())) {
        $logo = trim((string) body()['logoUploadId']);
        if ($logo !== '' && !preg_match('/^[0-9a-f-]{36}$/', $logo)) throw bad('Logo not found.', ['logoUploadId' => 'Upload the logo again.']);
        if ($logo !== '') org_assert_upload($a['orgId'], $logo);
        q('UPDATE organisers SET logo_upload_id = ? WHERE id = ?', [$logo !== '' ? $logo : null, $a['orgId']]);
    }
    return ['organiser' => org_view(row('SELECT * FROM organisers WHERE id = ?', [$a['orgId']]), $role)];
});

route('PUT', '/api/organiser/:orgId/bank', function ($a) {
    $u = require_auth();
    limit('bank', 10, 3600, $u['id']);
    ['role' => $role] = organiser_access($u, $a['orgId'], ORG_MONEY);
    $b = check(body(), [
        'bankName' => R::str(['min' => 2, 'max' => 80]), 'accountHolder' => R::str(['min' => 2, 'max' => 120]),
        'accountNumber' => R::str(['min' => 6, 'max' => 16, 'pattern' => '/^\d+$/', 'message' => 'Digits only.']),
        'branchCode' => R::str(['min' => 6, 'max' => 6, 'pattern' => '/^\d{6}$/', 'message' => '6 digits.']),
    ]);
    $last4 = substr($b['accountNumber'], -4);
    // A different account needs a new bank confirmation letter before payouts.
    $old = row('SELECT bank_account_enc, bank_branch_code FROM organisers WHERE id = ?', [$a['orgId']]);
    $same = $old['bank_account_enc'] && $old['bank_branch_code'] === $b['branchCode'] && decrypt_str((string) $old['bank_account_enc']) === $b['accountNumber'];
    if (!$same) q("UPDATE verification_documents SET status = 'replaced', replaced_at = ? WHERE organiser_id = ? AND event_id IS NULL AND requirement = 'bank_confirmation' AND status IN ('submitted','approved')", [now_iso(), $a['orgId']]);
    q('UPDATE organisers SET bank_name = ?, bank_account_holder = ?, bank_account_enc = ?, bank_account_last4 = ?, bank_branch_code = ? WHERE id = ?',
        [$b['bankName'], $b['accountHolder'], encrypt_str($b['accountNumber']), $last4, $b['branchCode'], $a['orgId']]);
    // Changing where money goes is high-risk, so it is audited.
    audit('organiser.bank_changed', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['orgId'], 'organiserId' => $a['orgId'], 'details' => ['last4' => $last4]]);
    kyc_vn_start($a['orgId'], $u['id'], false); // a new account is checked again before payouts
    return ['organiser' => org_view(row('SELECT * FROM organisers WHERE id = ?', [$a['orgId']]), $role)];
});

route('GET', '/api/organiser/:orgId/dashboard', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_ALL);
    return org_dashboard($a['orgId']);
});

// ============================================================== team
route('GET', '/api/organiser/:orgId/members', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_ALL);
    return ['members' => rows('SELECT u.id, u.full_name, u.email, m.role, m.created_at FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = ? ORDER BY m.created_at', [$a['orgId']])];
});

// Inviting people (team members, scanners) sends email from hello@, so it
// waits until TicketRoom has approved the organiser.
function org_require_approved(array $org): void
{
    if (($org['status'] ?? '') !== 'approved') throw conflict('Your organiser account is waiting for approval. You can add people once TicketRoom has approved it.', 'organiser_not_approved');
}

route('POST', '/api/organiser/:orgId/members', function ($a) {
    $u = require_auth();
    limit('orgmember', 30, 3600, $u['id']);
    org_require_approved(organiser_access($u, $a['orgId'], ['owner'])['organiser']);
    $b = check(body(), ['email' => R::email(), 'role' => R::oneOf(['manager', 'marketing', 'finance', 'viewer'])]);
    $f = user_by_email($b['email']);
    // Team members are organiser accounts. Someone new gets one, with an email
    // to set their password; a customer's or TicketRoom staff email is refused
    // (they need a separate work email for the team).
    if ($f && account_type($f) !== 'organiser') throw conflict("That email belongs to a TicketRoom account that isn't an organiser account. Ask them for a separate work email for your team.", 'not_organiser_account', ['email' => 'Not an organiser account.']);
    if ($f && $f['status'] !== 'active') throw conflict('That account is suspended or closed.', 'account_inactive');
    $org = row('SELECT name FROM organisers WHERE id = ?', [$a['orgId']]);
    $invited = !$f;
    $uid = tx(function () use ($u, $a, $b, $f, $org) {
        $now = now_iso();
        $uid = $f['id'] ?? null;
        if (!$uid) {
            $name = explode('@', $b['email'])[0];
            $uid = insert('users', ['id' => uuid(), 'email' => $b['email'], 'email_key' => email_key($b['email']), 'full_name' => $name, 'password_hash' => hash_secret(random_token(24)),
                'status' => 'active', 'account_type' => 'organiser', 'created_at' => $now, 'updated_at' => $now])['id'];
            $token = random_token(32);
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $uid, 'expires_at' => iso_in(7 * 86400), 'created_at' => $now]);
            outbox_enqueue(['to' => $b['email'], 'userId' => $uid] + tpl('orgMemberInvite', ['by' => $u['fullName'], 'organiser' => $org['name'], 'role' => $b['role'], 'url' => base_url() . "/organisers#/reset/$token"]));
        }
        q('INSERT INTO organiser_members (organiser_id, user_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT (organiser_id, user_id) DO UPDATE SET role = excluded.role',
            [$a['orgId'], $uid, $b['role'], $now]);
        audit('organiser.member_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $a['orgId'], 'details' => ['role' => $b['role'], 'invited' => !$f]]);
        return $uid;
    });
    return json_out(['ok' => true, 'invited' => $invited], 201);
});

route('DELETE', '/api/organiser/:orgId/members/:userId', function ($a) {
    $u = require_auth();
    organiser_access($u, $a['orgId'], ['owner']);
    if ($a['userId'] === $u['id']) throw bad('You cannot remove yourself.');
    q("DELETE FROM organiser_members WHERE organiser_id = ? AND user_id = ? AND role <> 'owner'", [$a['orgId'], $a['userId']]);
    audit('organiser.member_removed', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['userId'], 'organiserId' => $a['orgId']]);
    return ['ok' => true];
});

// ============================================================== image uploads
// Type decided by magic bytes (store_upload); served from /media with nosniff.
route('POST', '/api/organiser/:orgId/uploads', function ($a) {
    $u = require_auth();
    limit('upload', 30, 3600, $u['id']);
    organiser_access($u, $a['orgId'], ORG_EDIT);
    return json_out(['uploadId' => store_upload($u['id'], $a['orgId'], raw_body())], 201);
});

// ============================================================== events
route('GET', '/api/organiser/:orgId/events', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_ALL);
    return org_dashboard($a['orgId'])['events'];
});

route('POST', '/api/organiser/:orgId/events', function ($a) {
    $u = require_auth();
    ['organiser' => $org] = organiser_access($u, $a['orgId'], ORG_EDIT);
    $b = check(body(), org_event_shape());
    if (array_key_exists('parkRideInfo', body()) && trim((string) body()['parkRideInfo']) === '') $b['parkRideInfo'] = '';
    if (array_key_exists('parkRideUrl', body()) && trim((string) body()['parkRideUrl']) === '') $b['parkRideUrl'] = '';
    cashless_guard_switch(null, $b);
    $b = org_ticket_groups(org_lineup(org_age_groups($b, $b['ageRestriction'] ?? null)), $org['id']);
    if ($b['endsAt'] <= $b['startsAt']) throw bad('The event must end after it starts.', ['endsAt' => 'Must be after the start.']);
    if (!empty($b['presaleQueueEnabled']) && empty($b['salesStartAt'])) throw bad('Set a sales opening time before enabling the presale queue.', ['salesStartAt' => 'Required for the presale queue.']);
    org_assert_upload($org['id'], $b['imageUploadId'] ?? null);
    // The same event twice (same name, same start) is almost always a double
    // click or a copy made by mistake; listings and tickets would be split.
    $dup = val("SELECT id FROM events WHERE organiser_id = ? AND lower(trim(title)) = lower(trim(?)) AND starts_at = ? AND status NOT IN ('cancelled')", [$org['id'], $b['title'], $b['startsAt']]);
    if ($dup) throw conflict('You already have an event with this name starting at this time. Open it from My events instead of creating it again.', 'duplicate_event', ['eventId' => $dup]);
    $id = tx(function () use ($u, $org, $b) {
        $now = now_iso();
        $row = ['id' => uuid(), 'ref' => new_ref('events'), 'organiser_id' => $org['id'], 'slug' => org_slugify($b['title']) . '-' . strtolower(random_code(4)), 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now];
        foreach ($b as $k => $v) if ($v !== null) $row[ORG_EVENT_COLS[$k]] = $v;
        insert('events', $row);
        // A free event starts with one free registration type covering its capacity.
        if (!empty($b['isFree'])) {
            insert('ticket_types', ['id' => uuid(), 'event_id' => $row['id'], 'name' => 'Free admission', 'description' => 'Free entry. No payment needed.', 'price_cents' => 0,
                'quantity_total' => $b['capacity'], 'per_order_limit' => 4, 'created_at' => $now]);
        }
        audit('event.created', ['actor' => $u, 'entityType' => 'event', 'entityId' => $row['id'], 'organiserId' => $org['id'], 'details' => ['free' => !empty($b['isFree'])]]);
        return $row['id'];
    });
    return json_out(['event' => row('SELECT * FROM events WHERE id = ?', [$id])], 201);
});

route('GET', '/api/organiser/:orgId/events/:eventId', function ($a) {
    ['event' => $event, 'role' => $role] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $links = rows('SELECT * FROM tracking_links WHERE event_id = ? ORDER BY created_at DESC', [$event['id']]);
    foreach ($links as &$l) $l['url'] = org_link_url($event, $l['code']);
    unset($l);
    $changeRequests = rows('SELECT id, requested_by, request_reason, changes_json, before_json, status, review_note, created_at, reviewed_at FROM event_change_requests WHERE event_id = ? ORDER BY created_at DESC LIMIT 20', [$event['id']]);
    foreach ($changeRequests as &$r) {
        $r['changes'] = json_decode($r['changes_json'], true) ?: [];
        $r['before'] = json_decode($r['before_json'], true) ?: [];
        unset($r['changes_json'], $r['before_json']);
    }
    unset($r);
    return [
        'event' => $event, 'role' => $role,
        'ticketTypes' => rows("SELECT tt.*, (SELECT count(*) FROM waitlist_entries w WHERE w.ticket_type_id = tt.id AND w.status IN ('waiting','offered')) AS waiting
                                 FROM ticket_types tt WHERE tt.event_id = ? ORDER BY tt.sort_order, tt.price_cents", [$event['id']]),
        'promoCodes' => rows('SELECT * FROM promo_codes WHERE event_id = ? ORDER BY created_at DESC', [$event['id']]),
        'trackingLinks' => $links,
        'eventChangeRequests' => $changeRequests,
    ];
});

// Reuse an event's setup without carrying over its sales, payments, staff,
// promotions, queue entries or check-in history. The copy is always a draft;
// organisers must review it and submit it for approval like any new event.
route('POST', '/api/organiser/:orgId/events/:eventId/duplicate', function ($a) {
    $u = require_auth();
    ['event' => $source, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), [
        'title' => R::str(['min' => 3, 'max' => 140]),
        'startsAt' => R::date(), 'endsAt' => R::date(),
        'capacity' => R::int(['min' => 1, 'max' => 200000]),
    ]);
    if (to_unix($b['endsAt']) <= to_unix($b['startsAt'])) throw bad('The event must end after it starts.');
    $id = tx(function () use ($u, $org, $source, $b) {
        $now = now_iso();
        $event = [
            'id' => uuid(), 'ref' => new_ref('events'), 'organiser_id' => $org['id'],
            'slug' => org_slugify($b['title']) . '-' . strtolower(random_code(4)),
            'title' => $b['title'], 'summary' => $source['summary'], 'description' => $source['description'],
            'category' => $source['category'], 'venue_name' => $source['venue_name'], 'address' => $source['address'],
            'city' => $source['city'], 'province' => $source['province'], 'starts_at' => $b['startsAt'], 'ends_at' => $b['endsAt'],
            'doors_open_at' => null, 'image_upload_id' => $source['image_upload_id'], 'capacity' => $b['capacity'],
            'status' => 'draft', 'sales_start_at' => null, 'sales_end_at' => null, 'presale_queue_enabled' => 0,
            'park_ride_info' => $source['park_ride_info'], 'park_ride_url' => $source['park_ride_url'],
            'refund_policy' => $source['refund_policy'], 'accessibility_info' => $source['accessibility_info'],
            'age_restriction' => $source['age_restriction'], 'transfers_enabled' => $source['transfers_enabled'],
            // Cashless uses real balances and devices, so it must be explicitly enabled per new event.
            'cashless_enabled' => 0, 'is_free' => $source['is_free'], 'created_by' => $u['id'], 'created_at' => $now,
            'updated_at' => $now, 'age_groups' => $source['age_groups'], 'lineup' => $source['lineup'],
            'resale_enabled' => $source['resale_enabled'], 'service_fee_payer' => $source['service_fee_payer'],
            'prohibited_items' => $source['prohibited_items'] ?? null, 'ticket_groups' => $source['ticket_groups'] ?? null,
        ];
        insert('events', $event);
        $newIds = []; $links = [];
        foreach (rows('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, created_at', [$source['id']]) as $ticket) {
            $newIds[$ticket['id']] = $newId = uuid();
            if (!empty($ticket['release_after'])) $links[$newId] = $ticket['release_after'];
            insert('ticket_types', [
                'id' => $newId, 'event_id' => $event['id'], 'name' => $ticket['name'], 'description' => $ticket['description'],
                'price_cents' => (int) $ticket['price_cents'], 'quantity_total' => (int) $ticket['quantity_total'],
                'quantity_sold' => 0, 'quantity_held' => 0, 'per_order_limit' => (int) $ticket['per_order_limit'],
                'sales_start_at' => null, 'sales_end_at' => null, 'status' => $ticket['status'], 'sort_order' => (int) $ticket['sort_order'],
                'created_at' => $now, 'kind' => $ticket['kind'], 'admits' => (int) $ticket['admits'], 'group_name' => $ticket['group_name'] ?? null,
            ]);
        }
        foreach ($links as $newId => $oldAfter) if (isset($newIds[$oldAfter])) q('UPDATE ticket_types SET release_after = ? WHERE id = ?', [$newIds[$oldAfter], $newId]);
        audit('event.duplicated', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $org['id'],
            'details' => ['sourceEventId' => $source['id'], 'ticketTypes' => (int) val('SELECT count(*) FROM ticket_types WHERE event_id = ?', [$source['id']])]]);
        return $event['id'];
    });
    return json_out(['event' => row('SELECT * FROM events WHERE id = ?', [$id])], 201);
});

route('POST', '/api/organiser/:orgId/events/:eventId/change-requests', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if (!in_array($event['status'], ['published', 'suspended'], true)) throw conflict('Only published or suspended events need an edit request. Drafts can still be edited directly.', 'event_not_live');
    $src = body();
    if ($unknown = array_diff(array_keys($src), ['reason', 'eventChanges', 'ticketType'])) throw invalid(['request' => 'One or more fields are not allowed.']);
    $reason = check($src, ['reason' => R::str(['min' => 10, 'max' => 1000])])['reason'];
    $eventChanges = [];
    if (array_key_exists('eventChanges', $src)) {
        if (!is_array($src['eventChanges']) || ($src['eventChanges'] !== [] && array_is_list($src['eventChanges']))) throw invalid(['eventChanges' => 'Invalid event changes.']);
        $eventChanges = org_event_change_input($src['eventChanges'], $event);
        $eventChanges = array_filter($eventChanges, fn($v, $k) => (string) (org_event_db_value($k, $v) ?? '') !== (string) (org_event_db_value($k, $event[ORG_EVENT_COLS[$k]]) ?? ''), ARRAY_FILTER_USE_BOTH);
    }
    $ticketChange = null;
    if (array_key_exists('ticketType', $src)) {
        if (!is_array($src['ticketType']) || ($src['ticketType'] !== [] && array_is_list($src['ticketType']))) throw invalid(['ticketType' => 'Invalid ticket changes.']);
        $ticketChange = org_ticket_change_input($src['ticketType'], $event);
    }
    if (!$eventChanges && !$ticketChange) throw invalid(['changes' => 'Add at least one event or ticket change.']);
    org_event_change_assert($event, $eventChanges, true);
    $proposed = $event;
    foreach ($eventChanges as $k => $v) $proposed[ORG_EVENT_COLS[$k]] = org_event_db_value($k, $v);
    if ($ticketChange) org_ticket_change_assert($proposed, $ticketChange['changes'], $ticketChange['current']);

    $request = tx(function () use ($u, $a, $event, $reason, $eventChanges, $ticketChange) {
        $currentEvent = row('SELECT * FROM events WHERE id = ? AND organiser_id = ?', [$event['id'], $a['orgId']]);
        if (!$currentEvent || !in_array($currentEvent['status'], ['published', 'suspended'], true)) throw conflict('This event is no longer eligible for an edit request.', 'event_not_live');
        if ($pending = row("SELECT id, requested_by, request_reason, created_at FROM event_change_requests WHERE event_id = ? AND status = 'pending' LIMIT 1", [$event['id']])) {
            throw conflict('There is already a pending change request for this event. Review or withdraw it before sending another.', 'change_request_pending', ['requestId' => $pending['id']]);
        }
        org_event_change_assert($currentEvent, $eventChanges, true);
        $before = ['event' => [], 'ticketType' => null];
        foreach ($eventChanges as $k => $_) $before['event'][$k] = org_event_db_value($k, $currentEvent[ORG_EVENT_COLS[$k]]);
        $changes = ['event' => $eventChanges, 'ticketType' => null];
        if ($ticketChange) {
            $currentTicket = $ticketChange['id'] ? row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$ticketChange['id'], $event['id']]) : null;
            if ($ticketChange['id'] && !$currentTicket) throw not_found('Ticket type not found.');
            org_ticket_change_assert($currentEvent, $ticketChange['changes'], $currentTicket);
            $changes['ticketType'] = ['id' => $ticketChange['id'], 'changes' => $ticketChange['changes']];
            if ($currentTicket) {
                $before['ticketType'] = ['id' => $currentTicket['id'], 'fields' => []];
                foreach ($ticketChange['changes'] as $k => $_) $before['ticketType']['fields'][$k] = $currentTicket[ORG_TT_COLS[$k]];
            }
        }
        $id = uuid();
        $now = now_iso();
        insert('event_change_requests', ['id' => $id, 'event_id' => $event['id'], 'organiser_id' => $currentEvent['organiser_id'], 'requested_by' => $u['id'], 'request_reason' => $reason,
            'changes_json' => json_encode_out($changes), 'before_json' => json_encode_out($before), 'status' => 'pending', 'created_at' => $now, 'updated_at' => $now]);
        audit('event.change_requested', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['requestId' => $id, 'eventFields' => array_keys($eventChanges), 'ticketTypeId' => $ticketChange['id'] ?? null, 'ticketFields' => array_keys($ticketChange['changes'] ?? [])]]);
        return row('SELECT id, event_id, request_reason, changes_json, before_json, status, created_at FROM event_change_requests WHERE id = ?', [$id]);
    });
    $request['changes'] = json_decode($request['changes_json'], true) ?: [];
    $request['before'] = json_decode($request['before_json'], true) ?: [];
    unset($request['changes_json'], $request['before_json']);
    return json_out(['changeRequest' => $request], 201);
});

route('POST', '/api/organiser/:orgId/events/:eventId/change-requests/:requestId/withdraw', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $request = tx(function () use ($a, $event, $u) {
        $r = row("SELECT * FROM event_change_requests WHERE id = ? AND event_id = ?", [$a['requestId'], $event['id']]);
        if (!$r) throw not_found('Change request not found.');
        if ($r['status'] !== 'pending') throw conflict('Only pending change requests can be withdrawn.', 'bad_transition');
        q("UPDATE event_change_requests SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'pending'", [now_iso(), $r['id']]);
        audit('event.change_request_withdrawn', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['requestId' => $r['id']]]);
        return true;
    });
    return ['ok' => $request];
});

route('PATCH', '/api/organiser/:orgId/events/:eventId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if (!in_array($event['status'], ['draft', 'pending_approval'], true)) throw conflict('Published and suspended events cannot be changed directly. Submit the changes for admin review.', 'event_change_review');
    $b = org_event_change_input(body(), $event);
    org_event_change_assert($event, $b);
    if (!$b) return ['event' => $event];
    $sets = [];
    $p = [];
    foreach ($b as $k => $v) { $sets[] = ORG_EVENT_COLS[$k] . ' = ?'; $p[] = $v; }
    $p[] = now_iso();
    $p[] = $event['id'];
    q('UPDATE events SET ' . implode(', ', $sets) . ', updated_at = ? WHERE id = ?', $p);
    audit('event.updated', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['fields' => array_keys($b)]]);
    if (function_exists('kyc_recheck_live_event')) kyc_recheck_live_event($event['id']);
    if (array_key_exists('resaleEnabled', $b) && !$b['resaleEnabled'] && (int) $event['resale_enabled'] === 1) resale_close_event($u, $event['id'], 'resale_off');
    return ['event' => row('SELECT * FROM events WHERE id = ?', [$event['id']])];
});

route('POST', '/api/organiser/:orgId/events/:eventId/submit', function ($a) {
    $u = require_auth();
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if ($event['status'] !== 'draft') throw conflict('Only drafts can be submitted.', 'bad_transition');
    if ($org['status'] !== 'approved') throw conflict('Your organiser account is awaiting approval. You can submit events once it is approved.', 'organiser_not_approved');
    if (!(int) val('SELECT count(*) FROM ticket_types WHERE event_id = ?', [$event['id']])) throw conflict('Add at least one ticket type first.', 'no_ticket_types');
    // FICA: the organiser's ID, signed terms (and the event's own permits when
    // its risk calls for them) must be uploaded before it goes to review.
    kyc_require_for_event($event, 'submitted');
    // VerifyNow checks that are due (never run, or details changed) are queued
    // to run in the background; the first time asks for POPIA consent (409 consent_required).
    kyc_vn_start($event['organiser_id'], $u['id'], true);
    q("UPDATE events SET status = 'pending_approval', updated_at = ? WHERE id = ?", [now_iso(), $event['id']]);
    audit('event.submitted', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id']]);
    return ['status' => 'pending_approval'];
});

// Preview: a private link to the event page as buyers will see it, for the
// organiser's team (and anyone they share it with) while it is not yet live.
route('GET', '/api/organiser/:orgId/events/:eventId/preview-link', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $url = '/events/' . $event['slug'] . ($event['status'] === 'published' ? '' : '?preview=' . rawurlencode(sign_link(['pv' => $event['id']], 14 * 86400)));
    return ['url' => $url, 'expiresInDays' => $event['status'] === 'published' ? null : 14];
});

route('POST', '/api/organiser/:orgId/events/:eventId/request-cancellation', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ['owner']);
    $b = check(body(), ['reason' => R::text(['max' => 2000])]);
    if (!in_array($event['status'], ['published', 'pending_approval', 'draft', 'suspended'], true)) throw conflict('This event cannot be cancelled.', 'bad_transition');
    $n = (int) val("SELECT count(*) FROM orders WHERE event_id = ? AND status IN ('paid','partially_refunded','pending_payment')", [$event['id']]);
    $now = now_iso();
    if (!$n && $event['status'] !== 'published') {
        q("UPDATE events SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE id = ?", [$b['reason'], $now, $event['id']]);
        audit('event.cancelled', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['reason' => $b['reason']]]);
        return ['status' => 'cancelled'];
    }
    q('UPDATE events SET cancellation_requested_at = ?, cancellation_reason = ? WHERE id = ?', [$now, $b['reason'], $event['id']]);
    audit('event.cancellation_requested', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['reason' => $b['reason']]]);
    return ['status' => 'cancellation_requested'];
});

// ============================================================== ticket types, promo codes, tracking links
route('POST', '/api/organiser/:orgId/events/:eventId/ticket-types', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if (in_array($event['status'], ['published', 'suspended'], true)) throw conflict('Ticket types on published or suspended events must be submitted for admin review.', 'event_change_review');
    if (in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event can no longer be edited.', 'event_locked');
    $b = org_release_after($event['id'], null, check(body(), org_tt_shape()));
    if ($event['is_free'] && $b['priceCents'] > 0) throw conflict('This is a free event, so every ticket type costs R0.', 'free_event');
    if ($b['priceCents'] > 0 && $b['priceCents'] < 1000) throw bad('Paid tickets must cost at least R10.', ['priceCents' => 'Minimum R10, or R0 for free.']);
    $b['kind'] ??= 'general';
    $b['admits'] ??= TICKET_KINDS[$b['kind']]['admits'] ?? 1;
    $row = ['id' => uuid(), 'event_id' => $event['id'], 'created_at' => now_iso()];
    foreach ($b as $k => $v) $row[ORG_TT_COLS[$k]] = $v;
    insert('ticket_types', $row);
    audit('ticket_type.created', ['actor' => $u, 'entityType' => 'ticket_type', 'entityId' => $row['id'], 'organiserId' => $event['organiser_id'], 'details' => ['price' => $b['priceCents'], 'qty' => $b['quantityTotal']]]);
    if (function_exists('kyc_recheck_live_event')) kyc_recheck_live_event($row['event_id']);
    return json_out(['ticketType' => row('SELECT * FROM ticket_types WHERE id = ?', [$row['id']])], 201);
});

route('PATCH', '/api/organiser/:orgId/events/:eventId/ticket-types/:ttId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if (in_array($event['status'], ['published', 'suspended'], true)) throw conflict('Ticket types on published or suspended events must be submitted for admin review.', 'event_change_review');
    if (in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event can no longer be edited.', 'event_locked');
    $raw = body();
    $b = check($raw, org_tt_shape(['optional' => true]));
    // Clearing the sales window or the phase: empty values switch them off.
    foreach (['salesStartAt', 'salesEndAt', 'releaseAfter'] as $key) if (array_key_exists($key, $raw) && ($raw[$key] === null || $raw[$key] === '')) $b[$key] = $key === 'releaseAfter' ? '' : null;
    $b = org_release_after($event['id'], $a['ttId'], $b);
    $cur = row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$a['ttId'], $event['id']]);
    if (!$cur) throw not_found('Ticket type not found.');
    $price = $b['priceCents'] ?? null;
    if ($event['is_free'] && $price > 0) throw conflict('This is a free event, so every ticket type costs R0.', 'free_event');
    if ($price > 0 && $price < 1000) throw bad('Paid tickets must cost at least R10.', ['priceCents' => 'Minimum R10, or R0 for free.']);
    $taken = (int) $cur['quantity_sold'] + (int) $cur['quantity_held'];
    if ($price !== null && $price !== (int) $cur['price_cents'] && $taken > 0) throw conflict('Price cannot change after tickets of this type are sold. Create a new ticket type (e.g. a new release) instead.', 'price_locked');
    if (isset($b['quantityTotal']) && $b['quantityTotal'] < $taken) throw conflict("Quantity cannot go below $taken (sold + reserved).", 'quantity_below_sold');
    if (isset($b['admits']) && $b['admits'] !== (int) $cur['admits'] && $taken > 0) throw conflict('People per ticket cannot change after tickets of this type are sold. Create a new ticket type instead.', 'admits_locked');
    if (!$b) return ['ticketType' => $cur];
    $sets = [];
    $p = [];
    foreach ($b as $k => $v) { $sets[] = ORG_TT_COLS[$k] . ' = ?'; $p[] = $v; }
    $p[] = $cur['id'];
    // Checked again in the update itself: a sale can land between the read
    // above and this write, and must never be left above the new total.
    $guard = '';
    if (isset($b['quantityTotal'])) { $guard .= ' AND quantity_sold + quantity_held <= ?'; $p[] = $b['quantityTotal']; }
    if (($price !== null && $price !== (int) $cur['price_cents']) || (isset($b['admits']) && $b['admits'] !== (int) $cur['admits'])) $guard .= ' AND quantity_sold + quantity_held = 0';
    if (affected('UPDATE ticket_types SET ' . implode(', ', $sets) . ' WHERE id = ?' . $guard, $p) === 0) {
        $taken = (int) val('SELECT quantity_sold + quantity_held FROM ticket_types WHERE id = ?', [$cur['id']]);
        throw conflict("Tickets were booked while you were editing. Quantity cannot go below $taken (sold + reserved), and the price and people per ticket are fixed once tickets are sold. Check the numbers and save again.", 'quantity_below_sold');
    }
    audit('ticket_type.updated', ['actor' => $u, 'entityType' => 'ticket_type', 'entityId' => $cur['id'], 'organiserId' => $event['organiser_id'], 'details' => ['fields' => array_keys($b)]]);
    if (function_exists('kyc_recheck_live_event')) kyc_recheck_live_event($cur['event_id']);
    return ['ticketType' => row('SELECT * FROM ticket_types WHERE id = ?', [$cur['id']])];
});

route('POST', '/api/organiser/:orgId/events/:eventId/promo-codes', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_MKT);
    $b = check(body(), promo_code_shape());
    return json_out(['promoCode' => promo_code_create($event, $u, $b)], 201);
});

route('PATCH', '/api/organiser/:orgId/events/:eventId/promo-codes/:id', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_MKT);
    $b = check(body(), ['active' => R::bool()]);
    if (affected('UPDATE promo_codes SET active = ? WHERE id = ? AND event_id = ?', [$b['active'], $a['id'], $event['id']]) === 0) throw not_found('Promo code not found.');
    return ['promoCode' => row('SELECT * FROM promo_codes WHERE id = ?', [$a['id']])];
});

route('POST', '/api/organiser/:orgId/events/:eventId/tracking-links', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_MKT);
    $b = check(body(), ['label' => R::str(['min' => 2, 'max' => 80]), 'code' => R::str(['optional' => true, 'min' => 2, 'max' => 30, 'pattern' => '/^[A-Za-z0-9_-]+$/'])]);
    $code = $b['code'] ?? '';
    if ($code === '') $code = substr(org_slugify($b['label']), 0, 24);
    if ($code === '') $code = random_code(6);
    $code = strtoupper($code);
    $id = uuid();
    insert('tracking_links', ['id' => $id, 'event_id' => $event['id'], 'code' => $code, 'label' => $b['label'], 'clicks' => 0, 'created_at' => now_iso()]);
    $l = row('SELECT * FROM tracking_links WHERE id = ?', [$id]);
    return json_out(['trackingLink' => $l + ['url' => org_link_url($event, $code)]], 201);
});

// ============================================================== analytics, orders, attendees
route('GET', '/api/organiser/:orgId/events/:eventId/analytics', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    return org_event_analytics($event);
});

// Compatibility route for organiser portal builds. Cash and external tenders
// are recorded through the same server-locked door-sale workflow as /api/staff.
route('POST', '/api/organiser/:orgId/events/:eventId/door-orders', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    return door_create_order($u, $event);
});

route('GET', '/api/organiser/:orgId/events/:eventId/orders', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ['owner', 'manager', 'finance', 'viewer']);
    $q = str_replace(['%', '_', '\\'], '', mb_substr((string) qs('q', ''), 0, 80));
    $like = '%' . $q . '%';
    return ['orders' => rows("SELECT o.id, o.reference, o.status, o.buyer_name, o.buyer_email, o.total_cents, o.refunded_cents, o.discount_cents, o.fee_cents, o.created_at, o.paid_at,
                                     (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS tickets,
                                     (SELECT COALESCE(dt.method, p.provider) FROM payments p LEFT JOIN door_tenders dt ON dt.payment_id = p.id WHERE p.order_id = o.id AND p.status IN ('confirmed','partially_refunded','refunded') ORDER BY p.confirmed_at DESC LIMIT 1) AS payment_method,
                                     (SELECT dt.receipt_reference FROM door_tenders dt WHERE dt.order_id = o.id LIMIT 1) AS door_receipt,
                                     (SELECT dt.external_reference FROM door_tenders dt WHERE dt.order_id = o.id LIMIT 1) AS terminal_reference,
                                     NULL AS refund_status
                                FROM orders o WHERE o.event_id = ? AND o.status <> 'expired'
                                 AND (? = '' OR lower(o.reference) LIKE lower(?) OR lower(o.buyer_email) LIKE lower(?) OR lower(o.buyer_name) LIKE lower(?))
                               ORDER BY o.created_at DESC LIMIT 200", [$event['id'], $q, $like, $like, $like])];
});

// Attendees. The screen shows 500 at a time with search and totals, so a
// 100,000-ticket stadium stays quick; the CSV export has every ticket.
route('GET', '/api/organiser/:orgId/events/:eventId/attendees', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ['owner', 'manager', 'viewer']);
    $sql = 'SELECT t.code, t.status, t.holder_name, tt.name AS ticket_type, o.reference, o.buyer_email, t.admitted_at
              FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id JOIN orders o ON o.id = t.order_id WHERE t.event_id = ?';
    if (qs('format') === 'csv') {
        @set_time_limit(120);
        $st = q($sql . ' ORDER BY t.holder_name NULLS LAST, t.created_at', [$event['id']]);
        $out = "code,status,holder_name,ticket_type,order_reference,buyer_email,admitted_at\n";
        $n = 0;
        while ($x = $st->fetch(PDO::FETCH_NUM)) { $out .= implode(',', array_map('org_csv_esc', array_map(fn($v) => $v ?? '', $x))) . "\n"; $n++; }
        $st->closeCursor();
        audit('attendees.exported', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['rows' => $n]]);
        return raw_out($out, 'text/csv; charset=utf-8', 200, ['Content-Disposition' => "attachment; filename=\"attendees-{$event['slug']}.csv\""]);
    }
    $tot = row("SELECT count(*) AS total, COALESCE(SUM(status = 'used'),0) AS checked_in FROM tickets WHERE event_id = ?", [$event['id']]);
    $q = str_replace(['%', '_', '\\'], '', mb_substr(trim((string) qs('q', '')), 0, 80));
    $page = max(1, min(1000, (int) qs('page', '1')));
    $p = [$event['id']];
    if ($q !== '') {
        $sql .= ' AND (lower(t.holder_name) LIKE lower(?) OR upper(t.code) LIKE upper(?) OR upper(o.reference) LIKE upper(?) OR lower(o.buyer_email) LIKE lower(?))';
        array_push($p, "%$q%", "$q%", "$q%", "%$q%");
    }
    $list = rows($sql . ' ORDER BY t.holder_name NULLS LAST, t.created_at LIMIT 501 OFFSET ' . (($page - 1) * 500), $p);
    $more = count($list) > 500;
    return ['attendees' => array_slice($list, 0, 500), 'total' => (int) $tot['total'], 'checkedIn' => (int) $tot['checked_in'], 'page' => $page, 'more' => $more];
});

// Ticket refunds, finance and payouts: routes/finance.php.

// ============================================================== event staff
route('GET', '/api/organiser/:orgId/events/:eventId/staff', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    return ['staff' => rows("SELECT u.id, u.full_name, u.email, s.can_scan, s.can_manage_tags, s.can_sell_tickets, s.created_at,
                                    (SELECT count(*) FROM admission_log a WHERE a.scanned_by = u.id AND a.event_id = s.event_id AND a.outcome = 'admitted') AS admitted
                               FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = ? ORDER BY s.created_at", [$event['id']])];
});

// Add a scanner / desk staff member. Someone without an account is created and
// emailed an invite to set their password (link valid 7 days).
route('POST', '/api/organiser/:orgId/events/:eventId/staff', function ($a) {
    $u = require_auth();
    limit('staffadd', 30, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    org_require_approved($org);
    $b = check(body(), ['email' => R::email(), 'fullName' => R::str(['optional' => true, 'min' => 2, 'max' => 120]),
        'canScan' => org_bool(['optional' => true, 'fallback' => true]), 'canManageTags' => R::bool(), 'canSellTickets' => R::bool(['optional' => true, 'fallback' => false])]);
    $found = user_by_email($b['email']);
    if ($found && $found['status'] !== 'active') throw conflict('That account is suspended or closed, so it cannot scan tickets.', 'account_inactive');
    if ($found && account_type($found) === 'staff') throw conflict('That email belongs to a TicketRoom staff account. Scanners need their own email.', 'staff_account', ['email' => 'Use a different email.']);
    $uid = $found['id'] ?? null;
    $invited = false;
    $already = $uid && val('SELECT 1 FROM event_staff WHERE event_id = ? AND user_id = ?', [$event['id'], $uid]);
    // Someone new, or someone who has only bought tickets as a guest, gets an email to set a password.
    if (!$uid || (int) $found['guest'] === 1) {
        $token = random_token(32);
        $name = $b['fullName'] ?? ($found['full_name'] ?? explode('@', $b['email'])[0]);
        $uid = tx(function () use ($u, $b, $token, $name, $event, $org, $uid) {
            $now = now_iso();
            if (!$uid) $uid = insert('users', ['id' => uuid(), 'email' => $b['email'], 'email_key' => email_key($b['email']), 'full_name' => $name, 'password_hash' => hash_secret(random_token(24)), 'status' => 'active', 'account_type' => 'customer', 'created_at' => $now, 'updated_at' => $now])['id'];
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $uid, 'expires_at' => iso_in(7 * 86400), 'created_at' => $now]);
            outbox_enqueue(['to' => $b['email'], 'userId' => $uid] + tpl('staffInvite', ['name' => $name, 'organiser' => $org['name'], 'event' => $event['title'], 'url' => base_url() . "/scan#/reset/$token",
                'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags'], 'canSellTickets' => $b['canSellTickets']]));
            audit('staff.invited', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $event['organiser_id'], 'details' => ['eventId' => $event['id']]]);
            return $uid;
        });
        $invited = true;
    }
    q('INSERT INTO event_staff (event_id, user_id, can_scan, can_manage_tags, can_sell_tickets, added_by, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET can_scan = excluded.can_scan, can_manage_tags = excluded.can_manage_tags, can_sell_tickets = excluded.can_sell_tickets',
        [$event['id'], $uid, $b['canScan'], $b['canManageTags'], $b['canSellTickets'], $u['id'], now_iso()]);
    audit('event.staff_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $event['organiser_id'], 'details' => ['eventId' => $event['id'], 'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags'], 'canSellTickets' => $b['canSellTickets']]]);
    // Someone who already has an account is told they were added, and how to
    // be taken off the team if they did not expect it.
    if (!$invited && !$already) {
        outbox_enqueue(['to' => $found['email'], 'userId' => $uid] + tpl('staffAdded', ['name' => $found['full_name'], 'organiser' => $org['name'], 'event' => $event['title'],
            'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags'], 'canSellTickets' => $b['canSellTickets']]));
    }
    return json_out(['ok' => true, 'invited' => $invited], 201);
});

// Live check-in view for the organiser (polled every few seconds).
route('GET', '/api/organiser/:orgId/events/:eventId/checkins/live', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $tot = staff_event_counts($event['id']);
    $scanners = rows("SELECT u.full_name, COALESCE(SUM(CASE WHEN a.outcome = 'admitted' THEN 1 ELSE 0 END),0) AS admitted,
                             COALESCE(SUM(CASE WHEN a.outcome <> 'admitted' THEN 1 ELSE 0 END),0) AS refused, max(a.occurred_at) AS last_scan
                        FROM admission_log a JOIN users u ON u.id = a.scanned_by WHERE a.event_id = ? GROUP BY u.id ORDER BY admitted DESC", [$event['id']]);
    $recent = rows('SELECT a.outcome, a.occurred_at, a.gate, COALESCE(t.holder_name, g.holder_name) AS holder_name, u.full_name AS scanner
                      FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id LEFT JOIN gate_passes g ON g.id = a.pass_id JOIN users u ON u.id = a.scanned_by WHERE a.event_id = ? ORDER BY a.id DESC LIMIT 20', [$event['id']]);
    $rate = (int) val("SELECT count(*) FROM admission_log WHERE event_id = ? AND outcome = 'admitted' AND occurred_at > ?", [$event['id'], iso_in(-15 * 60)]);
    return ['admitted' => (int) $tot['admitted'], 'issued' => (int) $tot['issued'], 'last15min' => $rate, 'scanners' => $scanners, 'recent' => $recent, 'at' => now_iso()];
});

route('DELETE', '/api/organiser/:orgId/events/:eventId/staff/:userId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    q('DELETE FROM event_staff WHERE event_id = ? AND user_id = ?', [$event['id'], $a['userId']]);
    audit('event.staff_removed', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['userId'], 'organiserId' => $event['organiser_id']]);
    return ['ok' => true];
});

// Vendors, tills and wristbands: routes/cashless.php.

// ============================================================== marketing (email; SMS with Promote)
route('GET', '/api/organiser/:orgId/marketing/audience', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_MKT);
    $ids = array_values(array_filter(explode(',', (string) qs('eventIds', '')), fn($x) => (bool) preg_match('/^[0-9a-f-]{36}$/', $x)));
    return org_audience_summary($a['orgId'], $ids);
});

route('GET', '/api/organiser/:orgId/campaigns', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_MKT);
    return ['campaigns' => rows('SELECT * FROM campaigns WHERE organiser_id = ? ORDER BY created_at DESC LIMIT 100', [$a['orgId']])];
});

route('POST', '/api/organiser/:orgId/campaigns', function ($a) {
    $u = require_auth();
    organiser_access($u, $a['orgId'], ORG_MKT);
    $b = check(body(), org_campaign_shape());
    org_validate_campaign($a['orgId'], $b);
    $id = uuid();
    $now = now_iso();
    insert('campaigns', ['id' => $id, 'organiser_id' => $a['orgId'], 'channel' => $b['channel'], 'name' => $b['name'], 'subject' => $b['channel'] === 'email' ? $b['subject'] : null,
        'body' => $b['body'], 'audience' => json_encode(['eventIds' => $b['eventIds'] ?? []]), 'status' => 'draft', 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now]);
    return json_out(['campaign' => row('SELECT * FROM campaigns WHERE id = ?', [$id])], 201);
});

route('PATCH', '/api/organiser/:orgId/campaigns/:id', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_MKT);
    $camp = org_get_campaign($a['orgId'], $a['id']);
    if ($camp['status'] !== 'draft') throw conflict('Only drafts can be edited.', 'bad_transition');
    $b = ['channel' => $camp['channel']] + check(body(), org_campaign_shape(['optional' => true]));
    $b['channel'] = $camp['channel'];
    org_validate_campaign($a['orgId'], ['subject' => $b['subject'] ?? $camp['subject']] + $b + ['eventIds' => $camp['audience']['eventIds'] ?? []]);
    $nz = fn($v) => ($v === null || $v === '') ? null : $v;
    q('UPDATE campaigns SET name = COALESCE(?, name), subject = COALESCE(?, subject), body = COALESCE(?, body), audience = COALESCE(?, audience), updated_at = ? WHERE id = ?',
        [$nz($b['name'] ?? null), $nz($b['subject'] ?? null), $nz($b['body'] ?? null), isset($b['eventIds']) ? json_encode(['eventIds' => $b['eventIds']]) : null, now_iso(), $camp['id']]);
    return ['campaign' => row('SELECT * FROM campaigns WHERE id = ?', [$camp['id']])];
});

route('GET', '/api/organiser/:orgId/campaigns/:id/preview', function ($a) {
    $u = require_auth();
    ['organiser' => $org] = organiser_access($u, $a['orgId'], ORG_MKT);
    $camp = org_get_campaign($a['orgId'], $a['id']);
    if ($camp['channel'] !== 'email' && !org_sms_allowed($camp)) throw org_sms_unavailable();
    $recipients = count(org_audience($a['orgId'], $camp['channel'], $camp['audience']['eventIds'] ?? []));
    $promo = promo_for_campaign($camp);
    // The real link is made when the campaign goes out; the preview shows its shape.
    $link = $promo ? org_link_url(row('SELECT * FROM events WHERE id = ?', [$promo['event_id']]), 'CXXXXXXX') : null;
    $sample = org_render($camp, $org, ['user_id' => $u['id'], 'full_name' => $u['fullName']], $link);
    $sms = $camp['channel'] === 'sms';
    $segments = $sms ? promo_sms_segments($sample['body']) : null;
    return ['preview' => $sample, 'recipients' => $recipients, 'segments' => $segments, 'estimatedCostCents' => $sms ? (promo_sms_cost() ? $recipients * $segments * promo_sms_cost() : null) : 0,
        'smsCostPerSegmentCents' => $sms ? (promo_sms_cost() ?: null) : null, 'promotion' => $promo ? ['reference' => $promo['reference'], 'endsAt' => $promo['ends_at'], 'test' => (int) $promo['test'] === 1] : null];
});

route('POST', '/api/organiser/:orgId/campaigns/:id/test', function ($a) {
    $u = require_auth();
    limit('camptest', 10, 3600, $u['id']);
    organiser_access($u, $a['orgId'], ORG_MKT);
    $camp = org_get_campaign($a['orgId'], $a['id']);
    if ($camp['channel'] !== 'email' && !org_sms_allowed($camp)) throw org_sms_unavailable();
    $org = row('SELECT * FROM organisers WHERE id = ?', [$a['orgId']]);
    $promo = promo_for_campaign($camp);
    $link = $promo ? org_plain_event_link($camp) : null;
    $msg = org_render($camp, $org, ['user_id' => $u['id'], 'full_name' => $u['fullName']], $link);
    // An SMS test goes to your own phone; without a number on your account it comes by email.
    if ($camp['channel'] === 'sms' && !empty($u['phone'])) {
        tx(fn() => outbox_enqueue(['channel' => 'sms', 'kind' => 'transactional', 'to' => $u['phone'], 'body' => "[TEST] {$msg['body']}", 'userId' => $u['id']]));
        return ['sentTo' => org_mask($u['phone'])];
    }
    tx(fn() => outbox_enqueue(['channel' => 'email', 'kind' => 'transactional', 'to' => $u['email'], 'subject' => "[TEST] " . ($msg['subject'] ?? 'SMS: ' . $camp['name']), 'body' => $msg['body'], 'userId' => $u['id']]));
    return ['sentTo' => org_mask($u['email'])];
});

route('POST', '/api/organiser/:orgId/campaigns/:id/send', function ($a) {
    $u = require_auth();
    organiser_access($u, $a['orgId'], ['owner', 'manager', 'marketing']);
    $b = check(body(), ['scheduledAt' => R::date(['optional' => true])]);
    if (!empty($b['scheduledAt']) && to_unix($b['scheduledAt']) > microtime(true) + 60) {
        $camp = org_get_campaign($a['orgId'], $a['id']);
        if ($camp['status'] !== 'draft') throw conflict('Only drafts can be scheduled.', 'bad_transition');
        if ($camp['channel'] !== 'email' && !org_sms_allowed($camp)) throw org_sms_unavailable();
        q("UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?", [$b['scheduledAt'], now_iso(), $camp['id']]);
        audit('campaign.scheduled', ['actor' => $u, 'entityType' => 'campaign', 'entityId' => $camp['id'], 'organiserId' => $a['orgId'], 'details' => ['at' => $b['scheduledAt']]]);
        return ['campaign' => row('SELECT * FROM campaigns WHERE id = ?', [$camp['id']])];
    }
    return ['campaign' => org_send_campaign($u, $a['orgId'], $a['id'])];
});

route('POST', '/api/organiser/:orgId/campaigns/:id/cancel', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_MKT);
    if (affected("UPDATE campaigns SET status = 'cancelled', updated_at = ? WHERE id = ? AND organiser_id = ? AND status IN ('draft','scheduled')", [now_iso(), $a['id'], $a['orgId']]) === 0) {
        throw conflict('Only drafts or scheduled campaigns can be cancelled.', 'bad_transition');
    }
    return ['campaign' => row('SELECT * FROM campaigns WHERE id = ?', [$a['id']])];
});

// QR code for the event's public page, for posters, flyers and socials.
route('GET', '/api/organiser/:orgId/events/:eventId/qr', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $url = base_url() . '/events/' . $event['slug'];
    return ['url' => $url, 'title' => $event['title'], 'status' => $event['status'],
        'svg' => qr_for_people($url, ['dark' => qs('dark'), 'light' => qs('light'), 'ecc' => qs('ecc') ?? 'Q'])];
});

// ============================================================== gate passes
// Crew, artists, media, vendors and guests get a gate pass instead of a
// ticket. Each pass has a private link (only its hash is stored); reissuing a
// pass makes a new link and QR code, so old copies stop working.
const ORG_PASS_LIMIT = 5000;
function org_pass_view(array $g): array
{
    return ['id' => $g['id'], 'code' => $g['code'], 'holderName' => $g['holder_name'], 'email' => $g['email'], 'role' => $g['role'], 'roleLabel' => PASS_ROLES[$g['role']] ?? $g['role'],
        'accessNote' => $g['access_note'], 'reentry' => (bool) $g['reentry'], 'status' => $g['status'], 'scans' => (int) $g['scans'],
        'firstScannedAt' => $g['first_scanned_at'], 'lastScannedAt' => $g['last_scanned_at'], 'createdAt' => $g['created_at']];
}
function org_pass_shape(): array
{
    return ['role' => R::oneOf(array_keys(PASS_ROLES)), 'accessNote' => R::str(['optional' => true, 'max' => 60]), 'reentry' => org_bool(['optional' => true, 'fallback' => true])];
}
function org_pass_send(array $g, array $event, string $url): void
{
    if (!$g['email']) return;
    $org = val('SELECT name FROM organisers WHERE id = ?', [$event['organiser_id']]);
    outbox_enqueue(['to' => $g['email']] + tpl('gatePass', ['name' => $g['holder_name'], 'organiser' => $org, 'role' => PASS_ROLES[$g['role']] ?? $g['role'], 'event' => $event['title'],
        'when' => wallet_when($event['starts_at']), 'venue' => trim($event['venue_name'] . ', ' . $event['city'], ', '), 'url' => $url, 'reentry' => (bool) $g['reentry']]));
}
// Creates passes for a list of people in one go. Returns each pass with its link.
function org_issue_passes(array $u, array $event, array $org, array $people, array $opts): array
{
    if (array_filter(array_column($people, 'email'))) org_require_approved($org);
    return tx(function () use ($u, $event, $people, $opts) {
        // Counted inside the write transaction, so two bulk uploads at once cannot pass the limit together.
        $have = (int) val('SELECT count(*) FROM gate_passes WHERE event_id = ?', [$event['id']]);
        if ($have + count($people) > ORG_PASS_LIMIT) throw conflict('An event can have at most ' . ORG_PASS_LIMIT . ' gate passes.', 'pass_limit');
        $out = [];
        $now = now_iso();
        foreach ($people as $p) {
            $token = random_token(24);
            $g = insert('gate_passes', ['id' => uuid(), 'event_id' => $event['id'], 'code' => new_pass_code(), 'qr_version' => 1, 'holder_name' => $p['holderName'],
                'email' => isset($p['email']) && $p['email'] !== '' ? strtolower($p['email']) : null, 'role' => $opts['role'], 'access_note' => ($opts['accessNote'] ?? '') !== '' ? $opts['accessNote'] : null,
                'reentry' => !empty($opts['reentry']) ? 1 : 0, 'status' => 'active', 'link_token_hash' => sha256($token), 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now]);
            $g = row('SELECT * FROM gate_passes WHERE id = ?', [$g['id']]);
            $url = base_url() . "/pass?t=$token";
            org_pass_send($g, $event, $url);
            $out[] = ['pass' => org_pass_view($g), 'url' => $url];
        }
        audit('gate_pass.issued', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['count' => count($out), 'role' => $opts['role']]]);
        return $out;
    });
}
function org_get_pass(array $event, string $passId): array
{
    $g = row('SELECT * FROM gate_passes WHERE id = ? AND event_id = ?', [$passId, $event['id']]);
    if (!$g) throw not_found('Pass not found.');
    return $g;
}

route('GET', '/api/organiser/:orgId/events/:eventId/passes', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $list = array_map('org_pass_view', rows('SELECT * FROM gate_passes WHERE event_id = ? ORDER BY created_at DESC, holder_name', [$event['id']]));
    return ['passes' => $list, 'roles' => PASS_ROLES];
});

route('POST', '/api/organiser/:orgId/events/:eventId/passes', function ($a) {
    $u = require_auth();
    limit('gatepass', 300, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if (in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event has ended or was cancelled.', 'event_locked');
    $b = check(body(), ['holderName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(['optional' => true])] + org_pass_shape());
    $r = org_issue_passes($u, $event, $org, [$b], $b);
    return json_out($r[0], 201);
});

route('POST', '/api/organiser/:orgId/events/:eventId/passes/bulk', function ($a) {
    $u = require_auth();
    limit('gatepass', 300, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if (in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event has ended or was cancelled.', 'event_locked');
    $b = check(body(), ['people' => R::arr(R::obj(['holderName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(['optional' => true])]), ['min' => 1, 'max' => 200])] + org_pass_shape());
    return json_out(['passes' => org_issue_passes($u, $event, $org, $b['people'], $b)], 201);
});

// The pass's QR code, for printing a badge or sending it another way.
route('GET', '/api/organiser/:orgId/events/:eventId/passes/:passId', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_EDIT);
    $g = org_get_pass($event, $a['passId']);
    return ['pass' => org_pass_view($g), 'svg' => $g['status'] === 'active' ? tr_qr_svg(pass_payload($g), ['ecc' => 'M', 'margin' => 1, 'dark' => '#0B1A33', 'light' => '#FFFFFF']) : null];
});

route('POST', '/api/organiser/:orgId/events/:eventId/passes/:passId/revoke', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $g = org_get_pass($event, $a['passId']);
    q("UPDATE gate_passes SET status = 'revoked', updated_at = ? WHERE id = ?", [now_iso(), $g['id']]);
    audit('gate_pass.revoked', ['actor' => $u, 'entityType' => 'gate_pass', 'entityId' => $g['id'], 'organiserId' => $event['organiser_id']]);
    return ['pass' => org_pass_view(org_get_pass($event, $g['id']))];
});

// New link and QR code (lost phone, link shared by mistake). Old copies stop working.
route('POST', '/api/organiser/:orgId/events/:eventId/passes/:passId/reissue', function ($a) {
    $u = require_auth();
    limit('gatepass', 300, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $g = org_get_pass($event, $a['passId']);
    if ($g['status'] !== 'active') throw conflict('This pass was cancelled. Issue a new one instead.', 'pass_revoked');
    if ($g['email']) org_require_approved($org);
    $token = random_token(24);
    tx(function () use ($g, $token) {
        q('UPDATE gate_passes SET link_token_hash = ?, updated_at = ? WHERE id = ?', [sha256($token), now_iso(), $g['id']]);
        // A new code as well as a new QR: the old one, typed in, no longer works.
        replace_pass_code($g, 'reissue');
    });
    $g = org_get_pass($event, $g['id']);
    $url = base_url() . "/pass?t=$token";
    org_pass_send($g, $event, $url);
    audit('gate_pass.reissued', ['actor' => $u, 'entityType' => 'gate_pass', 'entityId' => $g['id'], 'organiserId' => $event['organiser_id']]);
    return ['pass' => org_pass_view($g), 'url' => $url];
});
