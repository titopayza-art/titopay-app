<?php
// /api/admin/test-events/* — Admin portal, Test event (see lib/testevent.php).
// Admin role only; every change is in the audit log.
declare(strict_types=1);

function te_admin(): array { require_role('admin', 'finance', 'support'); return require_role('admin'); }
function te_list(): array { return array_map('test_event_view', rows('SELECT * FROM events WHERE is_test = 1 ORDER BY created_at DESC LIMIT 20')); }

route('GET', '/api/admin/test-events', function () {
    te_admin();
    return ['events' => te_list(), 'keepDays' => TEST_EVENT_KEEP_DAYS];
});

route('POST', '/api/admin/test-events', function () {
    $u = te_admin();
    limit('testevent', 20, 3600, $u['id']);
    $b = check(body(), [
        'title' => R::str(['optional' => true, 'min' => 3, 'max' => 120]), 'venueName' => R::str(['optional' => true, 'min' => 2, 'max' => 120]),
        'city' => R::str(['optional' => true, 'min' => 2, 'max' => 80]), 'startsAt' => R::date(['optional' => true]), 'endsAt' => R::date(['optional' => true]),
        'ticketName' => R::str(['optional' => true, 'min' => 2, 'max' => 80]), 'quantity' => R::int(['optional' => true, 'min' => 1, 'max' => 500]),
        'perPerson' => R::int(['optional' => true, 'min' => 1, 'max' => 10]),
        'secondTicketName' => R::str(['optional' => true, 'min' => 2, 'max' => 80]), 'secondQuantity' => R::int(['optional' => true, 'min' => 1, 'max' => 500]),
    ]);
    $ev = test_event_create($u, array_filter($b, fn($v) => $v !== null));
    return json_out(['event' => test_event_view($ev)], 201);
});

route('DELETE', '/api/admin/test-events/:id', function ($a) {
    $u = te_admin();
    $b = check(body(), ['confirm' => R::oneOf(['DELETE'], ['message' => 'Confirm the delete.'])]);
    return ['deleted' => true, 'removed' => test_event_delete($a['id'], $u)];
});

// The event team for phone scanning: people with their own customer or organiser account.
route('POST', '/api/admin/test-events/:id/staff', function ($a) {
    $u = te_admin();
    $ev = test_event_require($a['id']);
    $b = check(body(), ['email' => R::email()]);
    $p = user_by_email($b['email']);
    if (!$p || (int) $p['guest'] === 1) throw bad('There is no TicketRoom account with that email yet. Ask them to create a free account on ticketroom.co.za and confirm it, then add them here.', ['email' => 'No account yet.']);
    if ($p['status'] !== 'active') throw conflict('That account is suspended or closed.', 'account_inactive');
    if (account_type($p) === 'staff') throw conflict('That is a TicketRoom staff account. Staff use "Open the scanner" on this page; phone scanners need a customer or organiser account.', 'staff_account', ['email' => 'Use a different email.']);
    q('INSERT OR IGNORE INTO event_staff (event_id, user_id, can_scan, can_manage_tags, can_sell_tickets, added_by, created_at) VALUES (?,?,1,0,0,?,?)', [$ev['id'], $p['id'], $u['id'], now_iso()]);
    audit('test_event.staff_added', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['userId' => $p['id']]]);
    return ['event' => test_event_view($ev)];
});
route('DELETE', '/api/admin/test-events/:id/staff/:userId', function ($a) {
    $u = te_admin();
    $ev = test_event_require($a['id']);
    q('DELETE FROM event_staff WHERE event_id = ? AND user_id = ?', [$ev['id'], $a['userId']]);
    audit('test_event.staff_removed', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['userId' => $a['userId']]]);
    return ['event' => test_event_view($ev)];
});

// Practice at the gate.
route('GET', '/api/admin/test-events/:id/practice-tickets', function ($a) {
    te_admin();
    return ['tickets' => test_event_practice_list(test_event_require($a['id']))];
});
route('POST', '/api/admin/test-events/:id/practice-tickets', function ($a) {
    $u = te_admin();
    limit('testevent-practice', 30, 3600, $u['id']);
    $ev = test_event_require($a['id']);
    test_event_practice_tickets($u, $ev, 4);
    return json_out(['tickets' => test_event_practice_list($ev)], 201);
});
route('POST', '/api/admin/test-events/:id/practice-scan', function ($a) {
    $u = te_admin();
    limit('scan', 240, 60, $u['id']);
    $ev = test_event_require($a['id']);
    $b = check(body(), ['kind' => R::oneOf(['valid', 'again', 'madeup', 'replaced', 'wrong_event', 'typed']), 'code' => R::str(['optional' => true, 'max' => 120])]);
    return test_event_practice_scan($u, $ev, $b['kind'], $b['code'] ?? null);
});
route('POST', '/api/admin/test-events/:id/reset-scans', function ($a) {
    $u = te_admin();
    return ['reset' => test_event_reset_scans($u, test_event_require($a['id']))];
});
