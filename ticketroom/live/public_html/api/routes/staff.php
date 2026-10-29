<?php
// /api/staff/* — gate scanning on phones, with live counts. The tag desk
// (linking and replacing wristbands) is in routes/cashless.php.
declare(strict_types=1);

route('GET', '/api/staff/events', function () {
    $u = require_auth();
    $all = 0; // only the events this person was added to, or their organisation's
    $list = rows("SELECT DISTINCT e.id, e.title, e.venue_name, e.city, e.starts_at, e.ends_at, e.status, e.cashless_enabled,
                         COALESCE(s.can_scan, CASE WHEN m.role IN ('owner','manager') THEN 1 END, ?) AS can_scan,
                         COALESCE(s.can_manage_tags, CASE WHEN m.role IN ('owner','manager') THEN 1 END, 0) AS can_manage_tags,
                         CASE WHEN m.role IN ('owner','manager') THEN 1 ELSE COALESCE(s.can_sell_tickets, 0) END AS can_sell_tickets
                    FROM events e
                    LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = ?
                    LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = ? AND m.role IN ('owner','manager')
                   WHERE e.status IN ('published','completed') AND (e.ends_at > ? OR EXISTS (SELECT 1 FROM door_shifts ds WHERE ds.event_id = e.id AND ds.opened_at > ?))
                     AND (? = 1 OR s.user_id IS NOT NULL OR m.user_id IS NOT NULL)
                   ORDER BY e.starts_at", [$all, $u['id'], $u['id'], iso_in(-86400), iso_in(-30 * 86400), $all]);
    // The tag desk is there only while wristbands can be used at all.
    foreach ($list as &$e) { $e['cashless_enabled'] = cashless_open_event($e); $e['can_manage_tags'] = $e['can_manage_tags'] && cashless_ready(); }
    return ['events' => $list];
});

route('POST', '/api/staff/scan', function () {
    $u = require_auth();
    limit('scan', 240, 60, $u['id']);
    $b = check(body(), ['eventId' => R::uuid(), 'payload' => R::str(['optional' => true, 'max' => 120]), 'tagInput' => R::str(['optional' => true, 'max' => 120]), 'gate' => R::str(['optional' => true, 'max' => 40])]);
    if (empty($b['payload']) && empty($b['tagInput'])) throw bad('Scan a ticket or tag.');
    event_staff_access($u, $b['eventId'], 'can_scan');
    return admit($u, $b);
});

// Organiser door sales: every tender begins with a server-side order hold.
route('GET', '/api/staff/events/:eventId/door-shifts/current', function ($a) {
    $u = require_auth(); $ev = event_staff_access($u, $a['eventId'], 'can_sell_tickets');
    return ['shift' => door_current_shift($ev['id'], $u['id'])];
});
route('GET', '/api/staff/events/:eventId/box-office', function ($a) {
    $u = require_auth(); $ev = event_staff_access($u, $a['eventId'], 'can_sell_tickets');
    $ticketTypes = rows('SELECT id, name, price_cents, quantity_total, quantity_sold, quantity_held, per_order_limit, status, sales_start_at, sales_end_at FROM ticket_types WHERE event_id = ? ORDER BY created_at', [$ev['id']]);
    $manager = in_array($ev['member_role'] ?? '', ['owner','manager'], true);
    $pending = rows("SELECT o.id AS order_id, o.reference, o.total_cents, o.expires_at, i.tender_method, i.created_at FROM door_order_intents i JOIN orders o ON o.id = i.order_id
                      WHERE i.event_id = ? AND i.retail_partner_id IS NULL AND (? = 1 OR i.cashier_id = ?) AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' ORDER BY i.created_at", [$ev['id'], $manager ? 1 : 0, $u['id']]);
    foreach ($pending as &$p) $p['accessKey'] = order_key($p['order_id']);
    unset($p);
    $shift = door_current_shift($ev['id'], $u['id']);
    if (!$shift) { $last = row('SELECT id FROM door_shifts WHERE event_id = ? AND cashier_id = ? ORDER BY opened_at DESC LIMIT 1', [$ev['id'], $u['id']]); if ($last) $shift = door_shift_view($last['id']); }
    $shiftRows = $manager
        ? rows('SELECT s.id, u.full_name AS cashier_name FROM door_shifts s JOIN users u ON u.id = s.cashier_id WHERE s.event_id = ? AND s.retail_partner_id IS NULL ORDER BY s.opened_at DESC LIMIT 30', [$ev['id']])
        : rows('SELECT s.id, u.full_name AS cashier_name FROM door_shifts s JOIN users u ON u.id = s.cashier_id WHERE s.event_id = ? AND s.retail_partner_id IS NULL AND s.cashier_id = ? ORDER BY s.opened_at DESC LIMIT 15', [$ev['id'], $u['id']]);
    $history = array_map(fn($x) => door_shift_view($x['id']) + ['cashierName' => $x['cashier_name']], $shiftRows);
    return ['event' => ['id' => $ev['id'], 'title' => $ev['title'], 'slug' => $ev['slug'], 'status' => $ev['status'], 'starts_at' => $ev['starts_at'], 'ends_at' => $ev['ends_at'], 'sales_start_at' => $ev['sales_start_at'], 'sales_end_at' => $ev['sales_end_at']],
        'ticketTypes' => $ticketTypes, 'shift' => $shift, 'pending' => $pending, 'shifts' => $history];
});
route('POST', '/api/staff/events/:eventId/door-shifts', function ($a) {
    $u = require_auth(); $ev = event_staff_access($u, $a['eventId'], 'can_sell_tickets');
    $b = check(body(), ['openingFloatCents' => R::int(['min' => 0, 'max' => 100000000])]);
    $s = tx(function () use ($u, $ev, $b) {
        if ($ev['status'] !== 'published') throw conflict('Cashier shifts can open only for published events.', 'event_not_live');
        if (row("SELECT id FROM door_shifts WHERE event_id = ? AND cashier_id = ? AND status = 'open'", [$ev['id'], $u['id']])) throw conflict('You already have an open shift for this event.', 'door_shift_open');
        $id = uuid(); insert('door_shifts', ['id' => $id, 'event_id' => $ev['id'], 'cashier_id' => $u['id'], 'opening_float_cents' => $b['openingFloatCents'],
            'counted_cash_cents' => null, 'counted_card_cents' => null, 'cash_variance_cents' => null, 'card_variance_cents' => null, 'status' => 'open', 'opened_at' => now_iso(), 'closed_at' => null]);
        return door_shift_view($id);
    });
    audit('door_shift.opened', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['shiftId' => $s['id'], 'openingFloatCents' => $s['openingFloatCents']]]);
    return json_out(['shift' => $s], 201);
});
route('POST', '/api/staff/events/:eventId/door-shifts/:shiftId/close', function ($a) {
    $u = require_auth(); $ev = event_staff_access($u, $a['eventId'], 'can_sell_tickets');
    $b = check(body(), ['countedCashCents' => R::int(['min' => 0, 'max' => 100000000]), 'countedCardCents' => R::int(['min' => 0, 'max' => 100000000])]);
    $s = tx(function () use ($u, $ev, $a, $b) {
        $shift = row('SELECT * FROM door_shifts WHERE id = ? AND event_id = ? AND retail_partner_id IS NULL', [$a['shiftId'], $ev['id']]);
        if (!$shift) throw not_found('Cash-up shift not found.');
        if ($shift['cashier_id'] !== $u['id'] && !in_array($ev['member_role'] ?? '', ['owner','manager'], true)) throw not_found('Cash-up shift not found.');
        if ($shift['status'] !== 'open') throw conflict('This shift has already been closed.', 'door_shift_closed');
        foreach (rows("SELECT o.* FROM door_order_intents i JOIN orders o ON o.id = i.order_id WHERE i.shift_id = ? AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' AND o.expires_at <= ?", [$shift['id'], now_iso()]) as $expired) {
            release_holds($expired);
            q("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_payment'", [now_iso(), $expired['id']]);
            q("UPDATE door_order_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'awaiting_tender'", [$expired['id']]);
        }
        if (val("SELECT 1 FROM door_order_intents i JOIN orders o ON o.id = i.order_id WHERE i.shift_id = ? AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' LIMIT 1", [$shift['id']])) throw conflict('A sale is still waiting for payment. Resolve or let its reservation expire before closing this shift.', 'door_pending_tender');
        $v = door_shift_view($shift['id']); $now = now_iso();
        q("UPDATE door_shifts SET counted_cash_cents = ?, counted_card_cents = ?, cash_variance_cents = ?, card_variance_cents = ?, status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'",
            [$b['countedCashCents'], $b['countedCardCents'], $b['countedCashCents'] - $v['expectedCashCents'], $b['countedCardCents'] - $v['expectedCardCents'], $now, $shift['id']]);
        return door_shift_view($shift['id']);
    });
    audit('door_shift.closed', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['shiftId' => $s['id'], 'cashVarianceCents' => $s['cashVarianceCents'], 'cardVarianceCents' => $s['cardVarianceCents']]]);
    return ['shift' => $s];
});
route('POST', '/api/staff/events/:eventId/door-orders', function ($a) {
    $u = require_auth(); $ev = event_staff_access($u, $a['eventId'], 'can_sell_tickets');
    return door_create_order($u, $ev);
});
route('POST', '/api/staff/events/:eventId/door-orders/:reference/tender', function ($a) {
    $u = require_auth(); event_staff_access($u, $a['eventId'], 'can_sell_tickets');
    return ['tender' => door_record_tender($u, $a['eventId'], $a['reference'])];
});

// Event totals are shared by every scanner and the organiser's live view, so
// they are counted at most once every 3 seconds per event.
function staff_event_counts(string $eventId): array
{
    $key = "counts:$eventId";
    $c = row('SELECT value FROM meta WHERE key = ?', [$key]);
    if ($c) { $v = json_decode($c['value'], true); if (($v['at'] ?? 0) > microtime(true) - 3) return $v; }
    // People, not tickets: a couple ticket lets two in.
    $r = row("SELECT COALESCE(SUM(CASE WHEN t.status = 'used' THEN tt.admits ELSE 0 END),0) AS admitted, COALESCE(SUM(CASE WHEN t.status IN ('valid','used') THEN tt.admits ELSE 0 END),0) AS issued
                FROM tickets t JOIN ticket_types tt ON tt.id = t.ticket_type_id WHERE t.event_id = ?", [$eventId]);
    $v = ['admitted' => (int) $r['admitted'], 'issued' => (int) $r['issued'], 'at' => microtime(true)];
    q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [$key, json_encode($v)]);
    return $v;
}

route('GET', '/api/staff/events/:eventId/stats', function ($a) {
    $u = require_auth();
    event_staff_access($u, $a['eventId'], 'can_scan');
    $c = staff_event_counts($a['eventId']);
    $mine = (int) val("SELECT count(*) FROM admission_log WHERE event_id = ? AND scanned_by = ? AND outcome = 'admitted'", [$a['eventId'], $u['id']]);
    $recent = rows('SELECT a.outcome, a.occurred_at, a.gate, COALESCE(t.holder_name, g.holder_name) AS holder_name FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id LEFT JOIN gate_passes g ON g.id = a.pass_id
                     WHERE a.event_id = ? AND a.scanned_by = ? ORDER BY a.id DESC LIMIT 15', [$a['eventId'], $u['id']]);
    return ['admitted' => $c['admitted'], 'issued' => $c['issued'], 'mine' => $mine, 'recent' => $recent];
});

// "Lerato Mokoena" becomes "Lerato M.": enough for the gate, less to lose on a phone.
function staff_short_name(?string $name): string
{
    $n = trim((string) $name);
    if ($n === '') return '';
    $parts = preg_split('/\s+/', $n);
    return count($parts) > 1 ? $parts[0] . ' ' . mb_substr($parts[1], 0, 1) . '.' : $parts[0];
}

// Offline scanning. Before the gates open, each scanner phone downloads the
// event's ticket list (code, QR version, status, holder first name, stand) so
// it can keep checking tickets if the stadium's mobile data fails. With
// ?since= it only returns tickets that changed, for quick refreshes.
route('GET', '/api/staff/events/:eventId/offline-pack', function ($a) {
    $u = require_auth();
    limit('offlinepack', 60, 3600, $u['id']);
    $ev = event_staff_access($u, $a['eventId'], 'can_scan');
    $since = parse_iso(qs('since'));
    $types = [];
    foreach (rows('SELECT id, name, kind, admits FROM ticket_types WHERE event_id = ?', [$ev['id']]) as $t) $types[$t['id']] = gate_label($t);
    $generatedAt = now_iso();
    $st = q('SELECT code, qr_version, status, holder_name, ticket_type_id, test, revoked_reason FROM tickets WHERE event_id = ?' . ($since ? ' AND updated_at >= ?' : ''), $since ? [$ev['id'], $since] : [$ev['id']]);
    $list = [];
    while ($t = $st->fetch(PDO::FETCH_NUM)) {
        $first = staff_short_name($t[3]);
        // Test tickets ride along as "not valid", so offline phones refuse them too.
        $list[] = [$t[0], (int) $t[1], (int) $t[5] === 1 ? 0 : ($t[2] === 'valid' ? 1 : ($t[2] === 'used' ? 2 : 0)), $first, $t[6] === 'resold' ? 'Resold' : ((int) $t[5] === 1 ? 'Test ticket' : ($types[$t[4]] ?? ''))];
    }
    $st->closeCursor();
    // Gate passes ride along; the sixth field marks a re-entry pass.
    foreach (rows('SELECT code, qr_version, status, holder_name, role, access_note, reentry, scans FROM gate_passes WHERE event_id = ?' . ($since ? ' AND updated_at >= ?' : ''), $since ? [$ev['id'], $since] : [$ev['id']]) as $g) {
        $list[] = [$g['code'], (int) $g['qr_version'], $g['status'] !== 'active' ? 0 : ((int) $g['reentry'] === 0 && (int) $g['scans'] > 0 ? 2 : 1), staff_short_name($g['holder_name']),
            'Gate pass · ' . (PASS_ROLES[$g['role']] ?? $g['role']) . ($g['access_note'] ? " · {$g['access_note']}" : ''), (int) $g['reentry']];
    }
    audit('scan.offline_pack', ['entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['tickets' => count($list), 'incremental' => (bool) $since]]);
    return ['event' => ['id' => $ev['id'], 'title' => $ev['title'], 'starts_at' => $ev['starts_at'], 'ends_at' => $ev['ends_at']],
        'generatedAt' => $generatedAt, 'full' => !$since, 'tickets' => $list];
});

// Scans made while offline are sent here once the phone is back online. Each is
// checked by the server exactly as a live scan would be; a ticket that another
// gate already let in comes back as "already_used" so the supervisor can see it.
route('POST', '/api/staff/scan/sync', function () {
    $u = require_auth();
    limit('scansync', 120, 60, $u['id']);
    $b = check(body(), ['eventId' => R::uuid(), 'scans' => R::arr(R::obj(['id' => R::str(['max' => 40]), 'payload' => R::str(['max' => 120]), 'gate' => R::str(['optional' => true, 'max' => 40]), 'at' => R::str(['optional' => true, 'max' => 40])]), ['min' => 1, 'max' => 500])]);
    event_staff_access($u, $b['eventId'], 'can_scan');
    $out = [];
    $oldest = microtime(true) - 2 * 86400;
    foreach ($b['scans'] as $s) {
        // The phone's scan time, if it is believable (not in the future, not days old).
        $t = isset($s['at']) ? parse_iso($s['at']) : null;
        $at = $t && to_unix($t) <= microtime(true) + 60 && to_unix($t) > $oldest ? $t : null;
        $r = admit($u, ['eventId' => $b['eventId'], 'payload' => $s['payload'], 'gate' => trim(($s['gate'] ?? '') . ' (offline)'), 'at' => $at]);
        $out[] = ['id' => $s['id'], 'outcome' => $r['outcome']];
    }
    return ['results' => $out];
});
