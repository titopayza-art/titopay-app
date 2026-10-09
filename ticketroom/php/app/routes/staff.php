<?php
// /api/staff/* — gate scanning on phones, with live counts.
declare(strict_types=1);

route('GET', '/api/staff/events', function () {
    $u = require_auth();
    $all = has_role($u, 'admin', 'support') ? 1 : 0;
    $list = rows("SELECT DISTINCT e.id, e.title, e.venue_name, e.city, e.starts_at, e.ends_at, e.status, e.cashless_enabled,
                         COALESCE(s.can_scan, CASE WHEN m.role IN ('owner','manager') THEN 1 END, ?) AS can_scan,
                         0 AS can_manage_tags
                    FROM events e
                    LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = ?
                    LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = ? AND m.role IN ('owner','manager')
                   WHERE e.status = 'published' AND e.ends_at > ? AND (? = 1 OR s.user_id IS NOT NULL OR m.user_id IS NOT NULL)
                   ORDER BY e.starts_at", [$all, $u['id'], $u['id'], iso_in(-86400), $all]);
    foreach ($list as &$e) $e['cashless_enabled'] = false;
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

// Event totals are shared by every scanner and the organiser's live view, so
// they are counted at most once every 3 seconds per event.
function staff_event_counts(string $eventId): array
{
    $key = "counts:$eventId";
    $c = row('SELECT value FROM meta WHERE key = ?', [$key]);
    if ($c) { $v = json_decode($c['value'], true); if (($v['at'] ?? 0) > microtime(true) - 3) return $v; }
    $r = row("SELECT COALESCE(SUM(status = 'used'),0) AS admitted, COALESCE(SUM(status IN ('valid','used')),0) AS issued FROM tickets WHERE event_id = ?", [$eventId]);
    $v = ['admitted' => (int) $r['admitted'], 'issued' => (int) $r['issued'], 'at' => microtime(true)];
    q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [$key, json_encode($v)]);
    return $v;
}

route('GET', '/api/staff/events/:eventId/stats', function ($a) {
    $u = require_auth();
    event_staff_access($u, $a['eventId'], 'can_scan');
    $c = staff_event_counts($a['eventId']);
    $mine = (int) val("SELECT count(*) FROM admission_log WHERE event_id = ? AND scanned_by = ? AND outcome = 'admitted'", [$a['eventId'], $u['id']]);
    $recent = rows('SELECT a.outcome, a.occurred_at, a.gate, t.holder_name FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id
                     WHERE a.event_id = ? AND a.scanned_by = ? ORDER BY a.id DESC LIMIT 15', [$a['eventId'], $u['id']]);
    return ['admitted' => $c['admitted'], 'issued' => $c['issued'], 'mine' => $mine, 'recent' => $recent];
});

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
    foreach (rows('SELECT id, name FROM ticket_types WHERE event_id = ?', [$ev['id']]) as $t) $types[$t['id']] = $t['name'];
    $generatedAt = now_iso();
    $st = q('SELECT code, qr_version, status, holder_name, ticket_type_id FROM tickets WHERE event_id = ?' . ($since ? ' AND updated_at >= ?' : ''), $since ? [$ev['id'], $since] : [$ev['id']]);
    $list = [];
    while ($t = $st->fetch(PDO::FETCH_NUM)) {
        $first = $t[3] ? trim(explode(' ', trim($t[3]))[0] . (str_contains(trim($t[3]), ' ') ? ' ' . mb_substr(trim(substr(trim($t[3]), strpos(trim($t[3]), ' '))), 0, 1) . '.' : '')) : '';
        $list[] = [$t[0], (int) $t[1], $t[2] === 'valid' ? 1 : ($t[2] === 'used' ? 2 : 0), $first, $types[$t[4]] ?? ''];
    }
    $st->closeCursor();
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

foreach (['POST /api/staff/tags/link', 'POST /api/staff/tags/lookup', 'POST /api/staff/tags/replace', 'POST /api/staff/tags/:tagId/block'] as $r) {
    [$m, $p] = explode(' ', $r);
    route($m, $p, function () { require_auth(); throw not_available(); });
}
// Vendor point of sale is not part of this edition.
foreach (['GET /api/pos/context', 'GET /api/pos/vendors', 'GET /api/pos/sales', 'GET /api/pos/summary', 'POST /api/pos/sales', 'GET /api/pos/sales/by-key/:key',
    'POST /api/pos/sales/:id/refund', 'POST /api/pos/vendors/:id/products'] as $r) {
    [$m, $p] = explode(' ', $r);
    route($m, $p, function () { throw not_available(); });
}
