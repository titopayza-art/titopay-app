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

route('GET', '/api/staff/events/:eventId/stats', function ($a) {
    $u = require_auth();
    event_staff_access($u, $a['eventId'], 'can_scan');
    $r = row("SELECT COALESCE(SUM(status = 'used'),0) AS admitted, COALESCE(SUM(status IN ('valid','used')),0) AS issued FROM tickets WHERE event_id = ?", [$a['eventId']]);
    $mine = (int) val("SELECT count(*) FROM admission_log WHERE event_id = ? AND scanned_by = ? AND outcome = 'admitted'", [$a['eventId'], $u['id']]);
    $recent = rows('SELECT a.outcome, a.occurred_at, a.gate, t.holder_name FROM admission_log a LEFT JOIN tickets t ON t.id = a.ticket_id
                     WHERE a.event_id = ? AND a.scanned_by = ? ORDER BY a.id DESC LIMIT 15', [$a['eventId'], $u['id']]);
    return ['admitted' => (int) $r['admitted'], 'issued' => (int) $r['issued'], 'mine' => $mine, 'recent' => $recent];
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
