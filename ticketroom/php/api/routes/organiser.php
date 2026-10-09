<?php
// /api/organiser/* — organiser portal: organisation, team, events, ticket
// types, promo codes, tracking links, analytics, orders, attendees, staff and
// live check-ins, and email marketing. Mirrors src/routes/organiser.js.
// Payments, refunds of paid orders, payouts, vendors and terminals are not part
// of this edition: those routes answer not_available() (or an empty list where
// the page only lists them). SMS campaigns are not available either.
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
        'id' => $o['id'], 'name' => $o['name'], 'slug' => $o['slug'], 'status' => $o['status'], 'contactEmail' => $o['contact_email'], 'contactPhone' => $o['contact_phone'],
        'description' => $o['description'], 'payoutHoldDays' => (int) $o['payout_hold_days'], 'role' => $role,
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
    $events = rows("SELECT e.id, e.title, e.slug, e.status, e.starts_at, e.capacity,
                           COALESCE((SELECT SUM(quantity_sold) FROM ticket_types WHERE event_id = e.id),0) AS sold,
                           e.is_free,
                           COALESCE((SELECT SUM(subtotal_cents - discount_cents) FROM orders WHERE event_id = e.id AND status IN " . ORG_PAID . "),0) AS revenue_cents,
                           COALESCE((SELECT SUM(organiser_fee_cents) FROM orders WHERE event_id = e.id AND status IN " . ORG_PAID . "),0) AS organiser_fee_cents
                      FROM events e WHERE e.organiser_id = ? ORDER BY e.starts_at DESC", [$orgId]);
    foreach ($events as &$e) foreach (['sold', 'revenue_cents', 'organiser_fee_cents', 'capacity'] as $k) $e[$k] = (int) $e[$k];
    unset($e);
    $last7 = row("SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0) AS revenue_cents, COUNT(*) AS orders
                    FROM orders o JOIN events e ON e.id = o.event_id WHERE e.organiser_id = ? AND o.status IN " . ORG_PAID . " AND o.paid_at > ?", [$orgId, iso_in(-7 * 86400)]);
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
    $tr = row("SELECT COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " THEN 1 ELSE 0 END),0) AS orders,
                      COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " THEN subtotal_cents - discount_cents ELSE 0 END),0) AS ticket_revenue_cents,
                      COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " THEN fee_cents ELSE 0 END),0) AS fees_cents,
                      COALESCE(SUM(CASE WHEN status IN " . ORG_PAID . " THEN organiser_fee_cents ELSE 0 END),0) AS organiser_fee_cents,
                      COALESCE(SUM(refunded_cents),0) AS refunded_cents,
                      COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END),0) AS abandoned,
                      COALESCE(SUM(CASE WHEN status = 'pending_payment' THEN 1 ELSE 0 END),0) AS pending
                 FROM orders WHERE event_id = ?", [$id]);
    $tr = array_map('intval', $tr);

    // Last 30 days (UTC dates), oldest first, every day present.
    $since = gmdate('Y-m-d', time() - 29 * 86400);
    $tick = [];
    foreach (rows("SELECT substr(o.paid_at,1,10) AS d, SUM(oi.quantity) AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    WHERE o.event_id = ? AND o.status IN " . ORG_PAID . " AND o.paid_at >= ? GROUP BY 1", [$id, $since]) as $r) $tick[$r['d']] = (int) $r['n'];
    $rev = [];
    foreach (rows("SELECT substr(paid_at,1,10) AS d, SUM(subtotal_cents - discount_cents) AS c FROM orders
                    WHERE event_id = ? AND status IN " . ORG_PAID . " AND paid_at >= ? GROUP BY 1", [$id, $since]) as $r) $rev[$r['d']] = (int) $r['c'];
    $daily = [];
    for ($i = 29; $i >= 0; $i--) {
        $d = gmdate('Y-m-d', time() - $i * 86400);
        $daily[] = ['day' => $d, 'tickets' => $tick[$d] ?? 0, 'revenue_cents' => $rev[$d] ?? 0];
    }

    $byType = rows("SELECT tt.id, tt.name, tt.price_cents, tt.quantity_total, tt.quantity_sold, tt.quantity_held,
                           (SELECT count(*) FROM tickets t WHERE t.ticket_type_id = tt.id AND t.status = 'used') AS checked_in
                      FROM ticket_types tt WHERE tt.event_id = ? ORDER BY tt.sort_order, tt.price_cents", [$id]);
    $checkins = row("SELECT COALESCE(SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END),0) AS admitted,
                            COALESCE(SUM(CASE WHEN status IN ('valid','used') THEN 1 ELSE 0 END),0) AS issued FROM tickets WHERE event_id = ?", [$id]);
    // Africa/Johannesburg is UTC+2 all year (no daylight saving).
    $byHour = rows("SELECT strftime('%H:00', occurred_at, '+2 hours') AS hour, count(*) AS n FROM admission_log
                     WHERE event_id = ? AND outcome = 'admitted' GROUP BY 1 ORDER BY 1", [$id]);
    $links = rows("SELECT l.code, l.label, l.clicks,
                          (SELECT count(*) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN " . ORG_PAID . ") AS orders,
                          (SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN " . ORG_PAID . ") AS revenue_cents
                     FROM tracking_links l WHERE l.event_id = ? ORDER BY revenue_cents DESC", [$id]);
    $promos = rows("SELECT p.code, p.kind, p.value, p.used_count, p.max_uses, p.active,
                           (SELECT COALESCE(SUM(o.discount_cents),0) FROM orders o WHERE o.promo_code_id = p.id AND o.status IN " . ORG_PAID . ") AS discount_given_cents
                      FROM promo_codes p WHERE p.event_id = ? ORDER BY p.used_count DESC", [$id]);
    $sold = array_sum(array_map(fn($t) => (int) $t['quantity_sold'], $byType));
    return [
        'totals' => $tr + ['ticketsSold' => $sold, 'capacity' => (int) $event['capacity'], 'payableCents' => 0, 'isFree' => (bool) $event['is_free']],
        'daily' => $daily, 'byType' => $byType, 'checkins' => ['admitted' => (int) $checkins['admitted'], 'issued' => (int) $checkins['issued']],
        'checkinsByHour' => $byHour, 'trackingLinks' => $links, 'promoCodes' => $promos,
        'vendors' => [], 'cashless' => ['topups_cents' => 0, 'wallets' => 0],
    ];
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
        'refundPolicy' => R::text(['optional' => true, 'max' => 2000]), 'accessibilityInfo' => R::text(['optional' => true, 'max' => 2000]), 'ageRestriction' => R::str(['optional' => true, 'max' => 60]),
        'transfersEnabled' => org_bool(), 'cashlessEnabled' => org_bool(), 'imageUploadId' => R::uuid(['optional' => true]),
        'isFree' => org_bool(),
    ];
}
const ORG_EVENT_COLS = ['title' => 'title', 'summary' => 'summary', 'description' => 'description', 'category' => 'category', 'venueName' => 'venue_name', 'address' => 'address',
    'city' => 'city', 'province' => 'province', 'startsAt' => 'starts_at', 'endsAt' => 'ends_at', 'doorsOpenAt' => 'doors_open_at', 'capacity' => 'capacity',
    'salesStartAt' => 'sales_start_at', 'salesEndAt' => 'sales_end_at', 'refundPolicy' => 'refund_policy', 'accessibilityInfo' => 'accessibility_info',
    'ageRestriction' => 'age_restriction', 'transfersEnabled' => 'transfers_enabled', 'cashlessEnabled' => 'cashless_enabled', 'imageUploadId' => 'image_upload_id', 'isFree' => 'is_free'];

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
    ];
}
const ORG_TT_COLS = ['name' => 'name', 'description' => 'description', 'priceCents' => 'price_cents', 'quantityTotal' => 'quantity_total', 'perOrderLimit' => 'per_order_limit',
    'salesStartAt' => 'sales_start_at', 'salesEndAt' => 'sales_end_at', 'status' => 'status', 'sortOrder' => 'sort_order'];

function org_link_url(array $event, string $code): string { return base_url() . '/events/' . $event['slug'] . '?ref=' . $code; }

function org_csv_esc($v): string
{
    $s = (string) ($v ?? '');
    $q = str_replace('"', '""', $s);
    return preg_match('/^[=+\-@]/', $s) ? "\"'$q\"" : "\"$q\"";
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
                                  WHERE o.user_id = u.id AND e.organiser_id = ? AND o.status IN " . ORG_PAID . " $evf)
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

function org_render(array $camp, array $org, array $recipient): array
{
    $first = explode(' ', (string) ($recipient['full_name'] ?? ''))[0];
    if ($first === '') $first = 'there';
    $body = preg_replace_callback('/\{\{\s*first_name\s*\}\}/', fn() => $first, (string) $camp['body']);
    $unsub = org_unsubscribe_url((string) $recipient['user_id'], $camp['organiser_id'], $camp['channel']);
    if ($camp['channel'] === 'sms') return ['body' => "{$org['name']}: $body Opt out: $unsub"];
    return [
        'subject' => $camp['subject'],
        'body' => "$body\n\n-- \nYou're getting this because you booked with {$org['name']} on TicketRoom and said you'd like to hear from them.\nUnsubscribe: $unsub\nTicketRoom (Pty) Ltd · Reg. no. 2026811077",
    ];
}

function org_sms_unavailable(): AppError
{
    return conflict('SMS campaigns are not available yet. Send an email campaign instead.', 'sms_not_available', ['channel' => 'Only email is available for now.']);
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
    if (($b['channel'] ?? null) === 'sms') throw org_sms_unavailable();
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
        if ($camp['channel'] !== 'email') throw org_sms_unavailable();
        $org = row('SELECT * FROM organisers WHERE id = ?', [$orgId]);
        if ($org['status'] !== 'approved') throw conflict('Your organiser account must be approved before sending marketing.', 'organiser_not_approved');
        $today = (int) val("SELECT count(*) FROM campaigns WHERE organiser_id = ? AND status IN ('sending','sent') AND sent_at > ?", [$orgId, iso_in(-86400)]);
        if ($today >= ORG_DAILY_CAMPAIGN_LIMIT) throw conflict('You can send at most ' . ORG_DAILY_CAMPAIGN_LIMIT . ' campaigns a day.', 'campaign_limit');
        $recipients = org_audience($orgId, $camp['channel'], $camp['audience']['eventIds'] ?? []);
        foreach ($recipients as $r) {
            $msg = org_render($camp, $org, $r);
            outbox_enqueue(['channel' => $camp['channel'], 'kind' => 'marketing', 'to' => $r['address'], 'subject' => $msg['subject'] ?? null, 'body' => $msg['body'],
                'userId' => $r['user_id'], 'campaignId' => $camp['id']]);
        }
        $now = now_iso();
        q("UPDATE campaigns SET status = 'sent', sent_at = ?, recipients_count = ?, estimated_cost_cents = 0, updated_at = ? WHERE id = ?", [$now, count($recipients), $now, $camp['id']]);
        audit('campaign.sent', ['actor' => $actor, 'entityType' => 'campaign', 'entityId' => $camp['id'], 'organiserId' => $orgId, 'details' => ['channel' => $camp['channel'], 'recipients' => count($recipients)]]);
        return row('SELECT * FROM campaigns WHERE id = ?', [$camp['id']]);
    });
}

// Sends campaigns whose scheduled time has come. Not wired into jobs() yet:
// add ['scheduled-campaigns', 60, fn() => org_due_scheduled_campaigns()] there.
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
    // Staff accounts run the admin portal; they never become organisers.
    if (has_role($u, 'admin', 'finance', 'support')) throw new AppError(403, 'staff_account', "This is a TicketRoom staff account. Organisers need their own account: sign out, then create one with the organiser's own email.");
    $b = check(body(), ['name' => R::str(['min' => 2, 'max' => 120]), 'contactEmail' => R::email(), 'contactPhone' => R::phone(['optional' => true]), 'description' => R::text(['optional' => true, 'max' => 2000])]);
    $org = tx(function () use ($u, $b) {
        $now = now_iso();
        $o = insert('organisers', ['id' => uuid(), 'name' => $b['name'], 'slug' => org_slugify($b['name']) . '-' . strtolower(random_code(4)), 'contact_email' => $b['contactEmail'],
            'contact_phone' => $b['contactPhone'] ?? null, 'description' => ($b['description'] ?? '') !== '' ? $b['description'] : null, 'status' => 'pending', 'created_at' => $now]);
        insert('organiser_members', ['organiser_id' => $o['id'], 'user_id' => $u['id'], 'role' => 'owner', 'created_at' => $now]);
        audit('organiser.applied', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $o['id'], 'organiserId' => $o['id']]);
        return $o;
    });
    return json_out(['organiser' => ['id' => $org['id'], 'name' => $org['name'], 'status' => $org['status']]], 201);
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
    q('UPDATE organisers SET bank_name = ?, bank_account_holder = ?, bank_account_enc = ?, bank_account_last4 = ?, bank_branch_code = ? WHERE id = ?',
        [$b['bankName'], $b['accountHolder'], encrypt_str($b['accountNumber']), $last4, $b['branchCode'], $a['orgId']]);
    // Changing where money goes is high-risk, so it is audited.
    audit('organiser.bank_changed', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['orgId'], 'organiserId' => $a['orgId'], 'details' => ['last4' => $last4]]);
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

route('POST', '/api/organiser/:orgId/members', function ($a) {
    $u = require_auth();
    organiser_access($u, $a['orgId'], ['owner']);
    $b = check(body(), ['email' => R::email(), 'role' => R::oneOf(['manager', 'marketing', 'finance', 'viewer'])]);
    $uid = val("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", [$b['email']]);
    if (!$uid) throw not_found('No TicketRoom account uses that email. Ask them to sign up first.');
    q('INSERT INTO organiser_members (organiser_id, user_id, role, created_at) VALUES (?,?,?,?) ON CONFLICT (organiser_id, user_id) DO UPDATE SET role = excluded.role',
        [$a['orgId'], $uid, $b['role'], now_iso()]);
    audit('organiser.member_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $a['orgId'], 'details' => ['role' => $b['role']]]);
    return json_out(['ok' => true], 201);
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
    if ($b['endsAt'] <= $b['startsAt']) throw bad('The event must end after it starts.', ['endsAt' => 'Must be after the start.']);
    org_assert_upload($org['id'], $b['imageUploadId'] ?? null);
    $id = tx(function () use ($u, $org, $b) {
        $now = now_iso();
        $row = ['id' => uuid(), 'organiser_id' => $org['id'], 'slug' => org_slugify($b['title']) . '-' . strtolower(random_code(4)), 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now];
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
    return [
        'event' => $event, 'role' => $role,
        'ticketTypes' => rows('SELECT * FROM ticket_types WHERE event_id = ? ORDER BY sort_order, price_cents', [$event['id']]),
        'promoCodes' => rows('SELECT * FROM promo_codes WHERE event_id = ? ORDER BY created_at DESC', [$event['id']]),
        'trackingLinks' => $links,
    ];
});

route('PATCH', '/api/organiser/:orgId/events/:eventId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = array_filter(check(body(), org_event_shape(true)), fn($v) => $v !== null);
    if (in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event can no longer be edited.', 'event_locked');
    org_assert_upload($event['organiser_id'], $b['imageUploadId'] ?? null);
    $sold = (int) val('SELECT COALESCE(SUM(quantity_sold + quantity_held),0) FROM ticket_types WHERE event_id = ?', [$event['id']]);
    // Material changes after tickets are sold go through TicketRoom support so buyers can be notified and offered refunds (CPA s47).
    $material = array_values(array_filter(['startsAt', 'endsAt', 'venueName', 'city', 'address'], function ($k) use ($b, $event) {
        if (!array_key_exists($k, $b)) return false;
        $cur = $event[ORG_EVENT_COLS[$k]];
        return (string) $b[$k] !== ($cur === null ? 'null' : (string) $cur);
    }));
    if ($sold > 0 && $material) throw conflict('Tickets have been sold, so date and venue changes must go through TicketRoom support so buyers are told and offered refunds.', 'material_change', ['fields' => $material]);
    if (isset($b['capacity']) && $b['capacity'] < $sold) throw conflict("Capacity cannot be below the $sold tickets already sold or held.", 'capacity_below_sold');
    $starts = $b['startsAt'] ?? $event['starts_at'];
    $ends = $b['endsAt'] ?? $event['ends_at'];
    if (to_unix($ends) <= to_unix($starts)) throw bad('The event must end after it starts.');
    if (array_key_exists('isFree', $b) && $b['isFree'] !== (bool) $event['is_free']) {
        $paid = (int) val('SELECT COALESCE(SUM(CASE WHEN price_cents > 0 THEN 1 ELSE 0 END),0) FROM ticket_types WHERE event_id = ?', [$event['id']]);
        if ($sold > 0) throw conflict('An event with sales cannot be switched between free and paid.', 'free_switch_locked');
        if ($b['isFree'] && $paid > 0) throw conflict('Remove or set to R0 the paid ticket types before making this a free event.', 'free_event');
    }
    if (!$b) return ['event' => $event];
    $sets = [];
    $p = [];
    foreach ($b as $k => $v) { $sets[] = ORG_EVENT_COLS[$k] . ' = ?'; $p[] = $v; }
    $p[] = now_iso();
    $p[] = $event['id'];
    q('UPDATE events SET ' . implode(', ', $sets) . ', updated_at = ? WHERE id = ?', $p);
    audit('event.updated', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['fields' => array_keys($b)]]);
    return ['event' => row('SELECT * FROM events WHERE id = ?', [$event['id']])];
});

route('POST', '/api/organiser/:orgId/events/:eventId/submit', function ($a) {
    $u = require_auth();
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    if ($event['status'] !== 'draft') throw conflict('Only drafts can be submitted.', 'bad_transition');
    if ($org['status'] !== 'approved') throw conflict('Your organiser account is awaiting approval. You can submit events once it is approved.', 'organiser_not_approved');
    if (!(int) val('SELECT count(*) FROM ticket_types WHERE event_id = ?', [$event['id']])) throw conflict('Add at least one ticket type first.', 'no_ticket_types');
    q("UPDATE events SET status = 'pending_approval', updated_at = ? WHERE id = ?", [now_iso(), $event['id']]);
    audit('event.submitted', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id']]);
    return ['status' => 'pending_approval'];
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
    $b = check(body(), org_tt_shape());
    if ($event['is_free'] && $b['priceCents'] > 0) throw conflict('This is a free event, so every ticket type costs R0.', 'free_event');
    if ($b['priceCents'] > 0 && $b['priceCents'] < 1000) throw bad('Paid tickets must cost at least R10.', ['priceCents' => 'Minimum R10, or R0 for free.']);
    $row = ['id' => uuid(), 'event_id' => $event['id'], 'created_at' => now_iso()];
    foreach ($b as $k => $v) $row[ORG_TT_COLS[$k]] = $v;
    insert('ticket_types', $row);
    audit('ticket_type.created', ['actor' => $u, 'entityType' => 'ticket_type', 'entityId' => $row['id'], 'organiserId' => $event['organiser_id'], 'details' => ['price' => $b['priceCents'], 'qty' => $b['quantityTotal']]]);
    return json_out(['ticketType' => row('SELECT * FROM ticket_types WHERE id = ?', [$row['id']])], 201);
});

route('PATCH', '/api/organiser/:orgId/events/:eventId/ticket-types/:ttId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), org_tt_shape(['optional' => true]));
    $cur = row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$a['ttId'], $event['id']]);
    if (!$cur) throw not_found('Ticket type not found.');
    $price = $b['priceCents'] ?? null;
    if ($event['is_free'] && $price > 0) throw conflict('This is a free event, so every ticket type costs R0.', 'free_event');
    if ($price > 0 && $price < 1000) throw bad('Paid tickets must cost at least R10.', ['priceCents' => 'Minimum R10, or R0 for free.']);
    $taken = (int) $cur['quantity_sold'] + (int) $cur['quantity_held'];
    if ($price !== null && $price !== (int) $cur['price_cents'] && $taken > 0) throw conflict('Price cannot change after tickets of this type are sold. Create a new ticket type (e.g. a new release) instead.', 'price_locked');
    if (isset($b['quantityTotal']) && $b['quantityTotal'] < $taken) throw conflict("Quantity cannot go below $taken (sold + reserved).", 'quantity_below_sold');
    if (!$b) return ['ticketType' => $cur];
    $sets = [];
    $p = [];
    foreach ($b as $k => $v) { $sets[] = ORG_TT_COLS[$k] . ' = ?'; $p[] = $v; }
    $p[] = $cur['id'];
    q('UPDATE ticket_types SET ' . implode(', ', $sets) . ' WHERE id = ?', $p);
    audit('ticket_type.updated', ['actor' => $u, 'entityType' => 'ticket_type', 'entityId' => $cur['id'], 'organiserId' => $event['organiser_id'], 'details' => ['fields' => array_keys($b)]]);
    return ['ticketType' => row('SELECT * FROM ticket_types WHERE id = ?', [$cur['id']])];
});

route('POST', '/api/organiser/:orgId/events/:eventId/promo-codes', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_MKT);
    $b = check(body(), [
        'code' => R::str(['min' => 3, 'max' => 30, 'pattern' => '/^[A-Za-z0-9_-]+$/', 'message' => 'Letters, digits, - and _ only.']), 'kind' => R::oneOf(['percent', 'fixed']),
        'value' => R::int(['min' => 1, 'max' => 10000000]), 'maxUses' => R::int(['optional' => true, 'min' => 1, 'max' => 100000]),
        'validFrom' => R::date(['optional' => true]), 'validTo' => R::date(['optional' => true]),
    ]);
    if ($b['kind'] === 'percent' && $b['value'] > 100) throw bad('A percentage cannot exceed 100.', ['value' => 'Max 100.']);
    $id = uuid();
    $code = strtoupper($b['code']);
    insert('promo_codes', ['id' => $id, 'event_id' => $event['id'], 'code' => $code, 'kind' => $b['kind'], 'value' => $b['value'], 'max_uses' => $b['maxUses'] ?? null,
        'valid_from' => $b['validFrom'] ?? null, 'valid_to' => $b['validTo'] ?? null, 'used_count' => 0, 'active' => 1, 'created_at' => now_iso()]);
    audit('promo.created', ['actor' => $u, 'entityType' => 'promo_code', 'entityId' => $id, 'organiserId' => $event['organiser_id'], 'details' => ['code' => $code, 'kind' => $b['kind'], 'value' => $b['value']]]);
    return json_out(['promoCode' => row('SELECT * FROM promo_codes WHERE id = ?', [$id])], 201);
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

route('GET', '/api/organiser/:orgId/events/:eventId/orders', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ['owner', 'manager', 'finance', 'viewer']);
    $q = str_replace(['%', '_', '\\'], '', mb_substr((string) qs('q', ''), 0, 80));
    $like = '%' . $q . '%';
    return ['orders' => rows("SELECT o.id, o.reference, o.status, o.buyer_name, o.buyer_email, o.total_cents, o.refunded_cents, o.discount_cents, o.fee_cents, o.created_at, o.paid_at,
                                     (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS tickets,
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

// Ticket refunds: free orders have nothing to refund (as in Node); paid
// refunds need the payment gateway, which this edition does not have.
route('POST', '/api/organiser/:orgId/events/:eventId/orders/:orderId/refund', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ['owner', 'finance']);
    check(body(), ['reason' => R::str(['min' => 3, 'max' => 400]), 'ticketIds' => R::arr(R::uuid(), ['optional' => true, 'max' => 50]), 'includeFees' => R::bool()]);
    $o = row('SELECT * FROM orders WHERE id = ? AND event_id = ?', [$a['orderId'], $event['id']]);
    if (!$o) throw not_found('Order not found.');
    if (!in_array($o['status'], ['paid', 'partially_refunded'], true)) throw conflict('Only paid orders can be refunded.', 'order_not_refundable');
    if ((int) $o['total_cents'] === 0) throw conflict('Free orders have nothing to refund.', 'order_not_refundable');
    throw not_available();
});

route('GET', '/api/organiser/:orgId/refunds', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ['owner', 'manager', 'finance']);
    return ['refunds' => []];
});
route('POST', '/api/organiser/:orgId/refunds/:refundId/decide', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ['owner', 'manager']);
    throw not_available();
});

// ============================================================== event staff
route('GET', '/api/organiser/:orgId/events/:eventId/staff', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    return ['staff' => rows("SELECT u.id, u.full_name, u.email, s.can_scan, s.can_manage_tags, s.created_at,
                                    (SELECT count(*) FROM admission_log a WHERE a.scanned_by = u.id AND a.event_id = s.event_id AND a.outcome = 'admitted') AS admitted
                               FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = ? ORDER BY s.created_at", [$event['id']])];
});

// Add a scanner / desk staff member. Someone without an account is created and
// emailed an invite to set their password (link valid 7 days).
route('POST', '/api/organiser/:orgId/events/:eventId/staff', function ($a) {
    $u = require_auth();
    limit('staffadd', 60, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), ['email' => R::email(), 'fullName' => R::str(['optional' => true, 'min' => 2, 'max' => 120]),
        'canScan' => org_bool(['optional' => true, 'fallback' => true]), 'canManageTags' => R::bool()]);
    $uid = val("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", [$b['email']]);
    $invited = false;
    if (!$uid) {
        $token = random_token(32);
        $name = $b['fullName'] ?? explode('@', $b['email'])[0];
        $uid = tx(function () use ($u, $b, $token, $name, $event, $org) {
            $now = now_iso();
            $nu = insert('users', ['id' => uuid(), 'email' => $b['email'], 'full_name' => $name, 'password_hash' => hash_secret(random_token(24)), 'status' => 'active', 'created_at' => $now, 'updated_at' => $now]);
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $nu['id'], 'expires_at' => iso_in(7 * 86400), 'created_at' => $now]);
            outbox_enqueue(['to' => $b['email'], 'userId' => $nu['id']] + tpl('staffInvite', ['name' => $name, 'organiser' => $org['name'], 'event' => $event['title'], 'url' => base_url() . "/account#/reset/$token"]));
            audit('staff.invited', ['actor' => $u, 'entityType' => 'user', 'entityId' => $nu['id'], 'organiserId' => $event['organiser_id'], 'details' => ['eventId' => $event['id']]]);
            return $nu['id'];
        });
        $invited = true;
    }
    q('INSERT INTO event_staff (event_id, user_id, can_scan, can_manage_tags, added_by, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET can_scan = excluded.can_scan, can_manage_tags = excluded.can_manage_tags',
        [$event['id'], $uid, $b['canScan'], $b['canManageTags'], $u['id'], now_iso()]);
    audit('event.staff_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $event['organiser_id'], 'details' => ['eventId' => $event['id'], 'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags']]]);
    return json_out(['ok' => true, 'invited' => $invited], 201);
});

// Live check-in view for the organiser (polled every few seconds).
route('GET', '/api/organiser/:orgId/events/:eventId/checkins/live', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $tot = staff_event_counts($event['id']);
    $scanners = rows("SELECT u.full_name, COALESCE(SUM(CASE WHEN a.outcome = 'admitted' THEN 1 ELSE 0 END),0) AS admitted,
                             COALESCE(SUM(CASE WHEN a.outcome <> 'admitted' THEN 1 ELSE 0 END),0) AS refused, max(a.occurred_at) AS last_scan
                        FROM admission_log a JOIN users u ON u.id = a.scanned_by WHERE a.event_id = ? GROUP BY u.id ORDER BY admitted DESC", [$event['id']]);
    $recent = rows('SELECT a.outcome, a.occurred_at, a.gate, t.holder_name, u.full_name AS scanner
                      FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id JOIN users u ON u.id = a.scanned_by WHERE a.event_id = ? ORDER BY a.id DESC LIMIT 20', [$event['id']]);
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

// ============================================================== vendors & terminals (not in this edition)
route('GET', '/api/organiser/:orgId/events/:eventId/vendors', function ($a) {
    event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    return ['vendors' => []];
});
foreach (['POST /api/organiser/:orgId/events/:eventId/vendors', 'PATCH /api/organiser/:orgId/events/:eventId/vendors/:vendorId',
    'POST /api/organiser/:orgId/events/:eventId/vendors/:vendorId/members', 'POST /api/organiser/:orgId/events/:eventId/vendors/:vendorId/terminals',
    'PATCH /api/organiser/:orgId/events/:eventId/terminals/:terminalId'] as $r) {
    [$m, $p] = explode(' ', $r);
    route($m, $p, function ($a) { event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_EDIT); throw not_available(); });
}
route('POST', '/api/organiser/:orgId/events/:eventId/vendors/:vendorId/payout', function ($a) {
    event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_MONEY);
    throw not_available();
});

// ============================================================== finance (not in this edition: zero balances)
route('GET', '/api/organiser/:orgId/finance', function ($a) {
    ['organiser' => $org] = organiser_access(require_auth(), $a['orgId'], ['owner', 'finance', 'manager']);
    $hold = (int) $org['payout_hold_days'];
    $now = microtime(true);
    $events = array_map(fn($e) => [
        'event_id' => $e['id'], 'title' => $e['title'], 'status' => $e['status'], 'ends_at' => $e['ends_at'], 'payout_hold_days' => $hold, 'balance_cents' => 0,
        'releasable' => !in_array($e['status'], ['cancelled', 'suspended'], true) && to_unix($e['ends_at']) + $hold * 86400 < $now, 'code' => null,
    ], rows('SELECT id, title, status, ends_at FROM events WHERE organiser_id = ? ORDER BY ends_at', [$a['orgId']]));
    return ['events' => $events, 'totalCents' => 0, 'availableCents' => 0, 'inFlightCents' => 0, 'pendingRefundsCents' => 0, 'payouts' => []];
});
route('POST', '/api/organiser/:orgId/payouts', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ORG_MONEY);
    throw not_available();
});

// ============================================================== marketing (email only)
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
    org_validate_campaign($a['orgId'], ['subject' => $b['subject'] ?? $camp['subject']] + $b);
    $nz = fn($v) => ($v === null || $v === '') ? null : $v;
    q('UPDATE campaigns SET name = COALESCE(?, name), subject = COALESCE(?, subject), body = COALESCE(?, body), audience = COALESCE(?, audience), updated_at = ? WHERE id = ?',
        [$nz($b['name'] ?? null), $nz($b['subject'] ?? null), $nz($b['body'] ?? null), isset($b['eventIds']) ? json_encode(['eventIds' => $b['eventIds']]) : null, now_iso(), $camp['id']]);
    return ['campaign' => row('SELECT * FROM campaigns WHERE id = ?', [$camp['id']])];
});

route('GET', '/api/organiser/:orgId/campaigns/:id/preview', function ($a) {
    $u = require_auth();
    ['organiser' => $org] = organiser_access($u, $a['orgId'], ORG_MKT);
    $camp = org_get_campaign($a['orgId'], $a['id']);
    if ($camp['channel'] !== 'email') throw org_sms_unavailable();
    $recipients = count(org_audience($a['orgId'], $camp['channel'], $camp['audience']['eventIds'] ?? []));
    $sample = org_render($camp, $org, ['user_id' => $u['id'], 'full_name' => $u['fullName']]);
    return ['preview' => $sample, 'recipients' => $recipients, 'segments' => null, 'estimatedCostCents' => 0];
});

route('POST', '/api/organiser/:orgId/campaigns/:id/test', function ($a) {
    $u = require_auth();
    limit('camptest', 10, 3600, $u['id']);
    organiser_access($u, $a['orgId'], ORG_MKT);
    $camp = org_get_campaign($a['orgId'], $a['id']);
    if ($camp['channel'] !== 'email') throw org_sms_unavailable();
    $org = row('SELECT * FROM organisers WHERE id = ?', [$a['orgId']]);
    $msg = org_render($camp, $org, ['user_id' => $u['id'], 'full_name' => $u['fullName']]);
    tx(fn() => outbox_enqueue(['channel' => 'email', 'kind' => 'transactional', 'to' => $u['email'], 'subject' => $msg['subject'] ? "[TEST] {$msg['subject']}" : null, 'body' => $msg['body'], 'userId' => $u['id']]));
    return ['sentTo' => org_mask($u['email'])];
});

route('POST', '/api/organiser/:orgId/campaigns/:id/send', function ($a) {
    $u = require_auth();
    organiser_access($u, $a['orgId'], ['owner', 'manager', 'marketing']);
    $b = check(body(), ['scheduledAt' => R::date(['optional' => true])]);
    if (!empty($b['scheduledAt']) && to_unix($b['scheduledAt']) > microtime(true) + 60) {
        $camp = org_get_campaign($a['orgId'], $a['id']);
        if ($camp['status'] !== 'draft') throw conflict('Only drafts can be scheduled.', 'bad_transition');
        if ($camp['channel'] !== 'email') throw org_sms_unavailable();
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
