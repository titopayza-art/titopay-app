<?php
// Test events (Admin portal, Test event): a free event the TicketRoom team
// makes to try the whole journey on the real site (booking signed in or as a
// guest, the emails, My tickets, transfers, the waitlist and the gate).
//
// - It belongs to the built-in "TicketRoom Test" organiser (organisers.is_test),
//   made on first use, approved, and never shown anywhere public.
// - The event is marked events.is_test. It is never listed (home, search,
//   filters, trending, retail, recently viewed) and opens only from its
//   private link. Its pages, emails and tickets say TEST EVENT.
// - Its orders, tickets and scans are left out of every report and KPI.
// - At the gate its tickets ADMIT as usual; the answer carries testEvent.
// - Deleting it removes everything that belongs to it. Only an event marked
//   is_test can be deleted (a database trigger refuses any other), and test
//   events are deleted on their own 7 days after they end.
declare(strict_types=1);

const TEST_EVENT_KEEP_DAYS = 7;
const TEST_EVENT_LABEL = 'TEST EVENT';

function is_test_event(?string $eventId): bool
{
    static $seen = [];
    if (!$eventId) return false;
    return $seen[$eventId] ??= (int) val('SELECT is_test FROM events WHERE id = ?', [$eventId]) === 1;
}
// The event a message template is about, when that is a test event.
function test_event_of(array $a): ?string
{
    $e = $a['event'] ?? null;
    if (is_array($e) && isset($e['is_test'])) return (int) $e['is_test'] === 1 ? ($e['id'] ?? ($a['order']['event_id'] ?? null)) : null;
    // A ticket row (with the event's title joined in) has the event in event_id.
    $id = is_array($e) ? ($e['event_id'] ?? $e['id'] ?? null) : null;
    $id ??= $a['order']['event_id'] ?? null;
    return is_string($id) && is_test_event($id) ? $id : null;
}
// Every email about a test event says so at the top and in the subject, and
// is tied to the event so deleting it deletes the email too.
function test_event_mark(array $m, array $a): array
{
    $id = test_event_of($a);
    if (!$id) return $m;
    $m['subject'] = '[' . TEST_EVENT_LABEL . '] ' . ($m['subject'] ?? '');
    $m['body'] = TEST_EVENT_LABEL . ": this is a TicketRoom test event, made by the TicketRoom team to try bookings, tickets and the gate. It is not a real event.\n\n" . ($m['body'] ?? '');
    $m['eventId'] = $id;
    return $m;
}

// The built-in organiser that owns every test event. Approved and verified
// from the start, with no team members, so nobody can open it as an organiser.
function test_organiser_id(array $actor): string
{
    $id = val('SELECT id FROM organisers WHERE is_test = 1 ORDER BY created_at LIMIT 1');
    if ($id) return $id;
    $id = uuid();
    $now = now_iso();
    insert('organisers', ['id' => $id, 'name' => 'TicketRoom Test', 'slug' => 'ticketroom-test-' . strtolower(random_code(8)),
        'contact_email' => (string) cfg('admin.email', 'hello@ticketroom.co.za'), 'description' => 'Built-in organiser for TicketRoom test events. Never shown to the public.',
        'status' => 'approved', 'created_at' => $now, 'approved_at' => $now, 'approved_by' => $actor['id'], 'ref' => new_ref('organisers'), 'is_test' => 1]);
    insert('organiser_verification', ['organiser_id' => $id, 'entity_type' => 'company', 'legal_name' => 'TicketRoom (Pty) Ltd (test organiser)', 'plans_paid' => 0,
        'completed_at' => $now, 'completed_scope' => 'free', 'updated_at' => $now]);
    audit('test_organiser.created', ['actor' => $actor, 'entityType' => 'organiser', 'entityId' => $id, 'organiserId' => $id]);
    return $id;
}

// A poster drawn on the server (navy to amber, the words TEST EVENT and the
// title), so a test event looks like a real one. Null without GD.
function test_event_poster(string $title, string $ownerId, string $orgId): ?string
{
    if (!function_exists('imagecreatetruecolor')) return null;
    [$w, $h] = [1200, 1500];
    $im = imagecreatetruecolor($w, $h);
    $a = [11, 29, 63]; $b = [242, 169, 59];
    for ($y = 0; $y < $h; $y++) {
        $t = $y / $h;
        imageline($im, 0, $y, $w, $y, imagecolorallocate($im, (int) ($a[0] + ($b[0] - $a[0]) * $t), (int) ($a[1] + ($b[1] - $a[1]) * $t), (int) ($a[2] + ($b[2] - $a[2]) * $t)));
    }
    imagefilledellipse($im, 600, 600, 640, 640, imagecolorallocatealpha($im, 255, 255, 255, 100));
    $draw = function (string $txt, int $y, float $scale) use ($im, $w) {
        $f = 5; $tw = imagefontwidth($f) * strlen($txt); $th = imagefontheight($f);
        $tmp = imagecreatetruecolor(max(1, $tw), $th);
        imagealphablending($tmp, false); imagesavealpha($tmp, true);
        imagefill($tmp, 0, 0, imagecolorallocatealpha($tmp, 0, 0, 0, 127));
        imagestring($tmp, $f, 0, 0, $txt, imagecolorallocate($tmp, 255, 255, 255));
        imagecopyresampled($im, $tmp, (int) (($w - $tw * $scale) / 2), $y, 0, 0, (int) ($tw * $scale), (int) ($th * $scale), $tw, $th);
    };
    $draw(TEST_EVENT_LABEL, 470, 9);
    $draw('TICKETROOM', 1020, 6);
    $draw(mb_strimwidth(preg_replace('/[^\x20-\x7E]/', '', $title) ?: 'Test event', 0, 34, '...'), 1250, 3);
    ob_start(); imagepng($im); $png = (string) ob_get_clean();
    return store_upload($ownerId, $orgId, $png);
}

function test_event_require(string $id): array
{
    $ev = row('SELECT * FROM events WHERE id = ? AND is_test = 1', [$id]);
    if (!$ev) throw not_found('Test event not found.');
    return $ev;
}

// What the admin page shows for one test event.
function test_event_view(array $ev): array
{
    $types = rows('SELECT id, name, price_cents, quantity_total, quantity_sold, quantity_held, per_order_limit FROM ticket_types WHERE event_id = ? ORDER BY sort_order, created_at', [$ev['id']]);
    $c = row("SELECT (SELECT count(*) FROM orders WHERE event_id = ? AND status IN ('paid','partially_refunded')) AS orders,
                     (SELECT count(*) FROM tickets WHERE event_id = ? AND status IN ('valid','used')) AS tickets,
                     (SELECT count(*) FROM tickets WHERE event_id = ? AND status = 'used') AS scanned,
                     (SELECT count(*) FROM waitlist_entries WHERE event_id = ? AND status IN ('waiting','offered')) AS waitlist", [$ev['id'], $ev['id'], $ev['id'], $ev['id']]);
    $staff = rows('SELECT u.id, u.full_name, u.email, s.created_at FROM event_staff s JOIN users u ON u.id = s.user_id WHERE s.event_id = ? ORDER BY s.created_at', [$ev['id']]);
    return ['id' => $ev['id'], 'ref' => $ev['ref'], 'title' => $ev['title'], 'slug' => $ev['slug'], 'status' => $ev['status'], 'venue' => $ev['venue_name'], 'city' => $ev['city'],
        'startsAt' => $ev['starts_at'], 'endsAt' => $ev['ends_at'], 'imageUploadId' => $ev['image_upload_id'], 'createdAt' => $ev['created_at'],
        'link' => base_url() . '/events/' . $ev['slug'], 'deletesAt' => iso_at(to_unix($ev['ends_at']) + TEST_EVENT_KEEP_DAYS * 86400),
        'ticketTypes' => array_map(fn($t) => ['id' => $t['id'], 'name' => $t['name'], 'total' => (int) $t['quantity_total'], 'sold' => (int) $t['quantity_sold'], 'perPerson' => (int) $t['per_order_limit']], $types),
        'counts' => array_map('intval', $c), 'staff' => $staff];
}

function test_event_create(array $actor, array $b): array
{
    $starts = $b['startsAt'] ?? iso_at(floor((microtime(true) + 2 * 3600) / 60) * 60);
    $ends = $b['endsAt'] ?? iso_at(to_unix($starts) + 4 * 3600);
    if (to_unix($ends) <= to_unix($starts)) throw bad('The end must be after the start.', ['endsAt' => 'After the start, please.']);
    if (to_unix($ends) < microtime(true)) throw bad('Choose an end time that has not passed yet.', ['endsAt' => 'In the future, please.']);
    $types = [['name' => $b['ticketName'] ?? 'Free test ticket', 'qty' => $b['quantity'] ?? 50, 'limit' => $b['perPerson'] ?? 4]];
    if (!empty($b['secondTicketName'])) $types[] = ['name' => $b['secondTicketName'], 'qty' => $b['secondQuantity'] ?? 20, 'limit' => $b['perPerson'] ?? 4];
    $id = tx(function () use ($actor, $b, $starts, $ends, $types) {
        $orgId = test_organiser_id($actor);
        $now = now_iso();
        $title = $b['title'] ?? 'TicketRoom test event';
        $id = uuid();
        insert('events', ['id' => $id, 'ref' => new_ref('events'), 'organiser_id' => $orgId,
            // The private link: long and random, so it cannot be guessed.
            'slug' => 'ticketroom-test-event-' . bin2hex(random_bytes(8)), 'title' => $title,
            'summary' => 'A TicketRoom test event, for trying bookings, tickets and the gate. Not a real event.',
            'description' => "This is a TicketRoom test event. The TicketRoom team uses it to try the whole booking journey on the real site: free tickets, the confirmation email, My tickets, transfers, the waitlist and scanning at the gate.\n\nIt is not a real event, nobody can find it on the website, and it is deleted with all its bookings " . TEST_EVENT_KEEP_DAYS . ' days after it ends.',
            'category' => 'other', 'venue_name' => $b['venueName'] ?? 'TicketRoom test venue', 'address' => $b['address'] ?? 'Test only, not a real address', 'city' => $b['city'] ?? 'Johannesburg', 'province' => 'Gauteng',
            'starts_at' => $starts, 'ends_at' => $ends, 'capacity' => array_sum(array_column($types, 'qty')), 'status' => 'published', 'is_free' => 1, 'is_test' => 1,
            'refund_policy' => 'Test tickets are free. Nothing to refund.', 'transfers_enabled' => 1, 'resale_enabled' => 0,
            'created_by' => $actor['id'], 'created_at' => $now, 'updated_at' => $now, 'published_at' => $now]);
        foreach ($types as $i => $t) {
            insert('ticket_types', ['id' => uuid(), 'event_id' => $id, 'name' => $t['name'], 'description' => 'Free test ticket. Not for a real event.', 'price_cents' => 0,
                'quantity_total' => $t['qty'], 'per_order_limit' => $t['limit'], 'sort_order' => $i, 'created_at' => $now]);
        }
        return $id;
    });
    // The poster is drawn once the event exists (its upload is then never cleared as unused).
    try {
        $orgId = (string) val('SELECT organiser_id FROM events WHERE id = ?', [$id]);
        $up = test_event_poster((string) val('SELECT title FROM events WHERE id = ?', [$id]), $actor['id'], $orgId);
        if ($up) q('UPDATE events SET image_upload_id = ? WHERE id = ?', [$up, $id]);
    } catch (Throwable $e) { error_log('[ticketroom] test event poster: ' . $e->getMessage()); }
    $ev = test_event_require($id);
    audit('test_event.created', ['actor' => $actor, 'entityType' => 'event', 'entityId' => $id, 'organiserId' => $ev['organiser_id'],
        'details' => ['title' => $ev['title'], 'startsAt' => $starts, 'ticketTypes' => count($types)]]);
    return $ev;
}

// Deletes a test event and everything that belongs to it. Returns what was
// removed. Refuses any event not marked is_test (and the database trigger
// events_delete_only_test refuses it too).
function test_event_delete(string $eventId, ?array $actor = null, string $why = 'manual'): array
{
    $out = tx(function () use ($eventId) {
        $ev = test_event_require($eventId);
        $id = $ev['id'];
        $T = 'SELECT id FROM tickets WHERE event_id = ?';
        $O = 'SELECT id FROM orders WHERE event_id = ?';
        $guests = array_column(rows("SELECT DISTINCT u.id FROM orders o JOIN users u ON u.id = o.user_id WHERE o.event_id = ? AND u.guest = 1", [$id]), 'id');
        $n = [];
        $del = function (string $what, string $sql, array $p) use (&$n) { $n[$what] = ($n[$what] ?? 0) + affected($sql, $p); };
        $del('scans', "DELETE FROM admission_log WHERE event_id = ? OR ticket_id IN ($T)", [$id, $id]);
        $del('entryDays', "DELETE FROM ticket_entry_days WHERE ticket_id IN ($T)", [$id]);
        $del('transfers', "DELETE FROM ticket_transfers WHERE ticket_id IN ($T)", [$id]);
        $del('resale', 'DELETE FROM resale_payouts WHERE event_id = ?', [$id]);
        $del('resale', 'DELETE FROM resale_listings WHERE event_id = ?', [$id]);
        $del('waitlist', 'DELETE FROM waitlist_entries WHERE event_id = ?', [$id]);
        $del('queue', 'DELETE FROM presale_queue_entries WHERE event_id = ?', [$id]);
        $del('replacedCodes', 'DELETE FROM replaced_codes WHERE event_id = ?', [$id]);
        $del('door', 'DELETE FROM door_tenders WHERE event_id = ?', [$id]);
        $del('door', 'DELETE FROM door_order_intents WHERE event_id = ?', [$id]);
        $del('door', 'DELETE FROM door_shifts WHERE event_id = ?', [$id]);
        $del('refunds', "DELETE FROM refunds WHERE event_id = ? OR order_id IN ($O)", [$id, $id]);
        $del('payments', "DELETE FROM payments WHERE order_id IN ($O)", [$id]);
        $del('tickets', 'DELETE FROM tickets WHERE event_id = ?', [$id]);
        $del('orderItems', "DELETE FROM order_items WHERE order_id IN ($O)", [$id]);
        $del('orders', 'DELETE FROM orders WHERE event_id = ?', [$id]);
        $del('promo', 'DELETE FROM promo_codes WHERE event_id = ?', [$id]);
        $del('links', 'DELETE FROM tracking_links WHERE event_id = ?', [$id]);
        $del('staff', 'DELETE FROM event_staff WHERE event_id = ?', [$id]);
        $del('passes', 'DELETE FROM gate_passes WHERE event_id = ?', [$id]);
        $del('likes', 'DELETE FROM event_likes WHERE event_id = ?', [$id]);
        $del('viewed', 'DELETE FROM recently_viewed_events WHERE event_id = ?', [$id]);
        $del('changes', 'DELETE FROM event_change_requests WHERE event_id = ?', [$id]);
        $del('risk', 'DELETE FROM event_risk WHERE event_id = ?', [$id]);
        q('UPDATE support_cases SET event_id = NULL WHERE event_id = ?', [$id]);
        $del('messages', 'DELETE FROM message_outbox WHERE event_id = ?', [$id]);
        q("DELETE FROM notification_log WHERE key LIKE ? ESCAPE '\\'", ['%:' . like_escape($id) . ':%']);
        $del('ticketTypes', 'DELETE FROM ticket_types WHERE event_id = ?', [$id]);
        $del('events', 'DELETE FROM events WHERE id = ? AND is_test = 1', [$id]);
        if ($ev['image_upload_id'] && !val('SELECT 1 FROM events WHERE image_upload_id = ?', [$ev['image_upload_id']])) {
            q('DELETE FROM uploads WHERE id = ?', [$ev['image_upload_id']]);
            @unlink(data_dir() . '/uploads/' . basename((string) $ev['image_upload_id']));
        }
        // Guest accounts made only for this event's bookings go too, if nothing else uses them.
        $n['guests'] = 0;
        foreach ($guests as $g) {
            if (val('SELECT 1 FROM orders WHERE user_id = ? UNION ALL SELECT 1 FROM tickets WHERE owner_user_id = ? UNION ALL SELECT 1 FROM waitlist_entries WHERE user_id = ? LIMIT 1', [$g, $g, $g])) continue;
            q('SAVEPOINT test_guest');
            try {
                q('DELETE FROM marketing_consents WHERE user_id = ? AND organiser_id = ?', [$g, $ev['organiser_id']]);
                q('DELETE FROM consent_log WHERE user_id = ? AND organiser_id = ?', [$g, $ev['organiser_id']]);
                $n['guests'] += affected('DELETE FROM users WHERE id = ? AND guest = 1', [$g]);
                q('RELEASE test_guest');
            } catch (PDOException $e) {
                q('ROLLBACK TO test_guest'); q('RELEASE test_guest');
            }
        }
        return ['event' => $ev, 'removed' => array_filter($n)];
    });
    audit('test_event.deleted', ['actor' => $actor ?? ['id' => null, 'primaryRole' => 'system'], 'entityType' => 'event', 'entityId' => $eventId, 'organiserId' => $out['event']['organiser_id'],
        'details' => ['title' => $out['event']['title'], 'why' => $why, 'removed' => $out['removed']]]);
    return $out['removed'];
}

// Background job: test events go 7 days after they end.
function test_events_cleanup(): int
{
    $n = 0;
    foreach (rows('SELECT id FROM events WHERE is_test = 1 AND ends_at < ? LIMIT 20', [iso_in(-TEST_EVENT_KEEP_DAYS * 86400)]) as $e) {
        try { test_event_delete($e['id'], null, 'expired'); $n++; } catch (Throwable $ex) { error_log('[ticketroom] test event cleanup: ' . $ex->getMessage()); }
    }
    return $n;
}

// ---- practice at the gate --------------------------------------------------
// Practice tickets: a set of free tickets for the test event, booked into
// the admin's own account without an email, to print and scan.
function test_event_practice_tickets(array $actor, array $ev, int $count = 4): array
{
    return tx(function () use ($actor, $ev, $count) {
        $tt = row("SELECT * FROM ticket_types WHERE event_id = ? AND status = 'on_sale' ORDER BY quantity_total - quantity_sold - quantity_held DESC, sort_order LIMIT 1", [$ev['id']]);
        if (!$tt) throw conflict('This test event has no ticket type.', 'no_ticket_type');
        if (affected('UPDATE ticket_types SET quantity_sold = quantity_sold + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$count, $tt['id'], $count]) === 0) {
            throw conflict('There are not enough tickets left on this test event for practice tickets. Make a new test event, or delete some bookings.', 'sold_out');
        }
        $now = now_iso();
        $order = insert('orders', ['id' => uuid(), 'reference' => reference('TR'), 'event_id' => $ev['id'], 'user_id' => $actor['id'], 'status' => 'paid',
            'buyer_name' => 'Practice ticket', 'buyer_email' => $actor['email'], 'subtotal_cents' => 0, 'total_cents' => 0, 'idempotency_key' => 'practice:' . uuid(),
            'expires_at' => $now, 'paid_at' => $now, 'created_at' => $now, 'updated_at' => $now, 'link_shows_tickets' => 0]);
        $item = insert('order_items', ['id' => uuid(), 'order_id' => $order['id'], 'ticket_type_id' => $tt['id'], 'quantity' => $count, 'unit_price_cents' => 0]);
        for ($i = 1; $i <= $count; $i++) {
            insert('tickets', ['id' => uuid(), 'code' => new_pass_code(), 'qr_version' => 1, 'order_id' => $order['id'], 'order_item_id' => $item['id'], 'event_id' => $ev['id'],
                'ticket_type_id' => $tt['id'], 'owner_user_id' => $actor['id'], 'holder_name' => "Practice ticket $i", 'price_cents' => 0, 'status' => 'valid', 'created_at' => $now, 'updated_at' => $now]);
        }
        audit('test_event.practice_tickets', ['actor' => $actor, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['order' => $order['reference'], 'count' => $count]]);
        return $order;
    });
}
function test_event_practice_list(array $ev): array
{
    $list = rows("SELECT t.*, tt.name AS ticket_type FROM tickets t JOIN orders o ON o.id = t.order_id JOIN ticket_types tt ON tt.id = t.ticket_type_id
                   WHERE t.event_id = ? AND o.idempotency_key LIKE 'practice:%' ORDER BY t.created_at DESC, t.holder_name LIMIT 40", [$ev['id']]);
    return array_map(fn($t) => ['id' => $t['id'], 'code' => $t['code'], 'status' => $t['status'], 'holderName' => $t['holder_name'], 'ticketType' => $t['ticket_type'], 'admittedAt' => $t['admitted_at'],
        'svg' => $t['status'] === 'valid' ? tr_qr_svg(qr_payload($t), ['ecc' => 'M', 'margin' => 1, 'dark' => '#0B1A33', 'light' => '#FFFFFF']) : null], $list);
}
// Runs one real scan through the gate (admit()) against the test event, the
// way the scanner would, and says what was scanned.
function test_event_practice_scan(array $actor, array $ev, string $kind, ?string $code = null): array
{
    $pick = fn(string $status) => row("SELECT * FROM tickets WHERE event_id = ? AND status = ? ORDER BY (holder_name LIKE 'Practice ticket%') DESC, created_at LIMIT 1", [$ev['id'], $status]);
    $fresh = function () use ($actor, $ev, $pick) {
        $t = $pick('valid');
        if ($t && !val("SELECT 1 FROM resale_listings WHERE ticket_id = ? AND status IN ('active','offered','held')", [$t['id']])) return $t;
        test_event_practice_tickets($actor, $ev, 1);
        return $pick('valid');
    };
    $what = '';
    switch ($kind) {
        case 'valid':
            $t = $fresh(); $payload = qr_payload($t); $what = "A valid ticket ({$t['code']})"; break;
        case 'again':
            $t = row("SELECT * FROM tickets WHERE event_id = ? AND status = 'used' ORDER BY admitted_at DESC LIMIT 1", [$ev['id']]);
            if (!$t) { $t = $fresh(); admit($actor, ['eventId' => $ev['id'], 'payload' => qr_payload($t)]); $t = row('SELECT * FROM tickets WHERE id = ?', [$t['id']]); }
            $payload = qr_payload($t); $what = "The same ticket again ({$t['code']})"; break;
        case 'madeup':
            do { $c = random_code(10); } while (val('SELECT 1 FROM tickets WHERE code = ? UNION ALL SELECT 1 FROM gate_passes WHERE code = ? UNION ALL SELECT 1 FROM replaced_codes WHERE code = ?', [$c, $c, $c]));
            $payload = $c; $what = "A made-up code ($c)"; break;
        case 'replaced':
            // As a transfer does: the ticket gets a new code and the old one is kept as replaced.
            $t = $fresh();
            tx(fn() => replace_ticket_code($t, 'practice'));
            $payload = $t['code']; $what = "The old code of a ticket that was passed on ({$t['code']})"; break;
        case 'wrong_event':
            // A ticket for another event: another test event first, otherwise any
            // other event's ticket. Only read: nothing changes on that event.
            $t = row("SELECT t.* FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.event_id <> ? ORDER BY e.is_test DESC, t.created_at DESC LIMIT 1", [$ev['id']]);
            if (!$t) throw conflict('There is no ticket for another event to try this with yet. Make a second test event and book a ticket on it.', 'no_other_ticket');
            $payload = qr_payload($t); $what = 'A ticket for a different event'; break;
        default:
            $payload = trim((string) $code);
            if ($payload === '') throw bad('Type or paste a ticket code.', ['code' => 'Required.']);
            $what = 'The code you typed';
    }
    $r = admit($actor, ['eventId' => $ev['id'], 'payload' => $payload, 'gate' => 'Practice']);
    audit('test_event.practice_scan', ['actor' => $actor, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['kind' => $kind, 'outcome' => $r['outcome']]]);
    return ['scanned' => $what, 'result' => $r];
}
function test_event_reset_scans(array $actor, array $ev): int
{
    $n = tx(function () use ($ev) {
        q("DELETE FROM ticket_entry_days WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = ?)", [$ev['id']]);
        q("UPDATE gate_passes SET scans = 0, first_scanned_at = NULL, last_scanned_at = NULL, updated_at = ? WHERE event_id = ?", [now_iso(), $ev['id']]);
        return affected("UPDATE tickets SET status = 'valid', admitted_at = NULL, admitted_by = NULL, updated_at = ? WHERE event_id = ? AND (status = 'used' OR (status = 'valid' AND admitted_at IS NOT NULL))", [now_iso(), $ev['id']]);
    });
    audit('test_event.scans_reset', ['actor' => $actor, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['tickets' => $n]]);
    return $n;
}
