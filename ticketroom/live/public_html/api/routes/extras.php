<?php
// Organisers set up extras (add-ons) and seat maps; gate staff hand extras
// over. The selling side is in create_order() and lib/extras.php.
declare(strict_types=1);

function ext_event(string $orgId, string $eventId, bool $edit = true): array
{
    $u = require_auth();
    ['event' => $event] = event_access($u, $orgId, $eventId, $edit ? ORG_EDIT : ORG_ALL);
    if ($edit && in_array($event['status'], ['cancelled', 'completed'], true)) throw conflict('This event can no longer be edited.', 'event_locked');
    return [$u, $event];
}

// ============================================================== add-ons
function ext_addon_shape(array $o = []): array
{
    $opt = $o + ['optional' => false];
    return ['name' => R::str(['min' => 2, 'max' => 80] + $opt), 'kind' => R::oneOf(array_keys(ADDON_KINDS), $opt), 'description' => R::str(['max' => 240, 'optional' => true]),
        'priceCents' => R::int(['min' => 0, 'max' => 10000000] + $opt), 'quantityTotal' => R::int(['min' => 0, 'max' => 200000] + $opt),
        'perOrderLimit' => R::int(['min' => 1, 'max' => 20, 'optional' => true]), 'status' => R::oneOf(['on_sale', 'paused', 'hidden'], ['optional' => true])];
}
function ext_addon_price(array $event, int $price): void
{
    if ($event['is_free'] && $price > 0) throw conflict('This is a free event, so extras are free too.', 'free_event');
    if ($price > 0 && $price < 500) throw bad('Paid extras cost at least R5.', ['priceCents' => 'Minimum R5, or R0 for free.']);
}
route('GET', '/api/organiser/:orgId/events/:eventId/addons', function ($a) {
    [, $event] = ext_event($a['orgId'], $a['eventId'], false);
    $list = rows('SELECT a.*, (SELECT COALESCE(SUM(x.collected),0) FROM order_addons x WHERE x.addon_id = a.id AND x.status = \'valid\') AS collected
                    FROM event_addons a WHERE a.event_id = ? ORDER BY a.sort_order, a.name', [$event['id']]);
    return ['addons' => $list, 'kinds' => ADDON_KINDS];
});
route('POST', '/api/organiser/:orgId/events/:eventId/addons', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $b = check(body(), ext_addon_shape());
    ext_addon_price($event, $b['priceCents']);
    if ((int) val('SELECT count(*) FROM event_addons WHERE event_id = ?', [$event['id']]) >= 30) throw conflict('An event can have up to 30 extras.', 'limit_exceeded');
    $now = now_iso();
    $row = insert('event_addons', ['id' => uuid(), 'event_id' => $event['id'], 'name' => $b['name'], 'kind' => $b['kind'], 'description' => $b['description'] ?? null,
        'price_cents' => $b['priceCents'], 'quantity_total' => $b['quantityTotal'], 'per_order_limit' => $b['perOrderLimit'] ?? 4, 'status' => $b['status'] ?? 'on_sale',
        'sort_order' => (int) val('SELECT COALESCE(MAX(sort_order),0) + 1 FROM event_addons WHERE event_id = ?', [$event['id']]), 'created_at' => $now, 'updated_at' => $now]);
    audit('addon.created', ['actor' => $u, 'entityType' => 'event_addon', 'entityId' => $row['id'], 'organiserId' => $event['organiser_id'], 'details' => ['name' => $b['name'], 'price' => $b['priceCents'], 'qty' => $b['quantityTotal']]]);
    return json_out(['addon' => $row], 201);
});
route('PATCH', '/api/organiser/:orgId/events/:eventId/addons/:id', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $cur = row('SELECT * FROM event_addons WHERE id = ? AND event_id = ?', [$a['id'], $event['id']]);
    if (!$cur) throw not_found('Extra not found.');
    $b = check(body(), ext_addon_shape(['optional' => true]));
    $taken = (int) $cur['quantity_sold'] + (int) $cur['quantity_held'];
    if (isset($b['priceCents']) && $b['priceCents'] !== (int) $cur['price_cents']) {
        if ($taken > 0) throw conflict('The price cannot change once some are sold. Add a new extra instead.', 'price_locked');
        ext_addon_price($event, $b['priceCents']);
    }
    if (isset($b['quantityTotal']) && $b['quantityTotal'] < $taken) throw conflict("Quantity cannot go below $taken (sold + reserved).", 'quantity_below_sold');
    $cols = ['name' => 'name', 'kind' => 'kind', 'description' => 'description', 'priceCents' => 'price_cents', 'quantityTotal' => 'quantity_total', 'perOrderLimit' => 'per_order_limit', 'status' => 'status'];
    $sets = []; $p = [];
    foreach ($b as $k => $v) { $sets[] = $cols[$k] . ' = ?'; $p[] = $v; }
    if (!$sets) return ['addon' => $cur];
    $sets[] = 'updated_at = ?'; $p[] = now_iso(); $p[] = $cur['id'];
    $guard = isset($b['quantityTotal']) ? ' AND quantity_sold + quantity_held <= ' . (int) $b['quantityTotal'] : '';
    if (affected('UPDATE event_addons SET ' . implode(', ', $sets) . ' WHERE id = ?' . $guard, $p) === 0) throw conflict('Some were just sold. Reload and try again.', 'quantity_below_sold');
    audit('addon.updated', ['actor' => $u, 'entityType' => 'event_addon', 'entityId' => $cur['id'], 'organiserId' => $event['organiser_id'], 'details' => array_keys($b)]);
    return ['addon' => row('SELECT * FROM event_addons WHERE id = ?', [$cur['id']])];
});
route('DELETE', '/api/organiser/:orgId/events/:eventId/addons/:id', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $cur = row('SELECT * FROM event_addons WHERE id = ? AND event_id = ?', [$a['id'], $event['id']]);
    if (!$cur) throw not_found('Extra not found.');
    if (val('SELECT 1 FROM order_addons WHERE addon_id = ? LIMIT 1', [$cur['id']])) throw conflict('People have bought this extra, so it stays on record. Set it to hidden to stop selling it.', 'addon_sold');
    q('DELETE FROM event_addons WHERE id = ?', [$cur['id']]);
    audit('addon.deleted', ['actor' => $u, 'entityType' => 'event_addon', 'entityId' => $cur['id'], 'organiserId' => $event['organiser_id'], 'details' => ['name' => $cur['name']]]);
    return ['ok' => true];
});

// ============================================================== seat maps
function ext_seat_summary(string $eventId): array
{
    return rows("SELECT s.section, s.ticket_type_id, tt.name AS ticket_type, count(*) AS seats, SUM(s.status = 'sold') AS sold, SUM(s.status = 'held') AS held, SUM(s.status = 'blocked') AS blocked
                   FROM seats s JOIN ticket_types tt ON tt.id = s.ticket_type_id WHERE s.event_id = ? GROUP BY s.section, s.ticket_type_id, tt.name ORDER BY MIN(s.section_order)", [$eventId]);
}
route('GET', '/api/organiser/:orgId/events/:eventId/seats', function ($a) {
    [, $event] = ext_event($a['orgId'], $a['eventId'], false);
    return ['sections' => seat_map($event['id']), 'summary' => ext_seat_summary($event['id']), 'layout' => seat_layout($event['id'])];
});
// The venue map: where each block sits (centre x, y on the map), how far it
// is turned and curved, and the picture of the venue's plan behind it.
route('PUT', '/api/organiser/:orgId/events/:eventId/seats/layout', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $b = check(body(), ['sections' => R::arr(R::obj(['name' => R::str(['min' => 1, 'max' => 40]), 'x' => R::num(['min' => -20000, 'max' => 20000]), 'y' => R::num(['min' => -20000, 'max' => 20000]),
        'rotation' => R::num(['min' => -360, 'max' => 360]), 'curve' => R::num(['min' => 0, 'max' => 180])]), ['max' => 300]),
        'imageUploadId' => R::str(['max' => 64, 'optional' => true]), 'imageWidth' => R::int(['min' => 200, 'max' => 20000, 'optional' => true]), 'imageHeight' => R::int(['min' => 0, 'max' => 40000, 'optional' => true])]);
    $raw = body();
    return tx(function () use ($u, $event, $b, $raw) {
        $now = now_iso();
        $names = array_flip(array_column(rows('SELECT DISTINCT section FROM seats WHERE event_id = ?', [$event['id']]), 'section'));
        foreach ($b['sections'] as $sec) {
            if (!isset($names[$sec['name']])) throw invalid(['sections' => "There is no section called {$sec['name']}."]);
            if (affected('UPDATE seat_sections SET x = ?, y = ?, rotation = ?, curve = ?, updated_at = ? WHERE event_id = ? AND name = ?', [$sec['x'], $sec['y'], $sec['rotation'], $sec['curve'], $now, $event['id'], $sec['name']]) === 0) {
                q('INSERT INTO seat_sections (id, event_id, name, x, y, rotation, curve, updated_at) VALUES (?,?,?,?,?,?,?,?)', [uuid(), $event['id'], $sec['name'], $sec['x'], $sec['y'], $sec['rotation'], $sec['curve'], $now]);
            }
        }
        if (array_key_exists('imageUploadId', $raw) || isset($b['imageWidth'])) {
            $cur = seat_layout($event['id']);
            $img = array_key_exists('imageUploadId', $raw) ? (($raw['imageUploadId'] ?? '') !== '' ? (string) $b['imageUploadId'] : null) : $cur['imageUploadId'];
            // Only a picture this organiser uploaded.
            if ($img !== null && !val('SELECT 1 FROM uploads WHERE id = ? AND organiser_id = ?', [$img, $event['organiser_id']])) throw invalid(['imageUploadId' => 'Upload the plan again.']);
            q('DELETE FROM seat_layouts WHERE event_id = ?', [$event['id']]);
            q('INSERT INTO seat_layouts (event_id, image_upload_id, image_width, image_height, updated_at) VALUES (?,?,?,?,?)', [$event['id'], $img, $b['imageWidth'] ?? $cur['imageWidth'], $b['imageHeight'] ?? $cur['imageHeight'], $now]);
        }
        audit('seats.layout_saved', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['sections' => count($b['sections'])]]);
        return ['sections' => seat_map($event['id']), 'summary' => ext_seat_summary($event['id']), 'layout' => seat_layout($event['id'])];
    });
});
// Events of this organiser with a seat map, to copy from (every show at the same venue).
route('GET', '/api/organiser/:orgId/events/:eventId/seats/sources', function ($a) {
    [, $event] = ext_event($a['orgId'], $a['eventId'], false);
    return ['events' => rows("SELECT e.id, e.title, e.starts_at, e.venue_name, count(s.id) AS seats FROM events e JOIN seats s ON s.event_id = e.id
                                WHERE e.organiser_id = ? AND e.id <> ? GROUP BY e.id, e.title, e.starts_at, e.venue_name ORDER BY e.starts_at DESC LIMIT 50", [$event['organiser_id'], $event['id']])];
});
route('POST', '/api/organiser/:orgId/events/:eventId/seats/copy', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $b = check(body(), ['fromEventId' => R::uuid()]);
    return tx(function () use ($u, $event, $b) {
        // Only from this organiser's own events.
        $from = row('SELECT * FROM events WHERE id = ? AND organiser_id = ?', [$b['fromEventId'], $event['organiser_id']]);
        if (!$from) throw not_found('Event not found.');
        $r = seats_copy($from, row('SELECT * FROM events WHERE id = ?', [$event['id']]), $u);
        return $r + ['sections' => seat_map($event['id']), 'summary' => ext_seat_summary($event['id']), 'layout' => seat_layout($event['id'])];
    });
});
// A block of seats: rows with the same number of seats in each (rows +
// seatsPerRow), or each row its own number (rowSeats "A:10, B:12, C-F:14").
// Shorter rows are centred, so a block can be a wedge like the ones facing a stage.
route('POST', '/api/organiser/:orgId/events/:eventId/seats/sections', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $b = check(body(), ['ticketTypeId' => R::uuid(), 'section' => R::str(['min' => 1, 'max' => 40]), 'rows' => R::str(['min' => 1, 'max' => 400, 'optional' => true]),
        'seatsPerRow' => R::int(['min' => 1, 'max' => 120, 'optional' => true]), 'rowSeats' => R::str(['max' => 1000, 'optional' => true]),
        'startNumber' => R::int(['min' => 1, 'max' => 9999, 'optional' => true]), 'accessibleRows' => R::str(['max' => 100, 'optional' => true])]);
    return tx(function () use ($u, $event, $b) {
        $tt = row('SELECT * FROM ticket_types WHERE id = ? AND event_id = ?', [$b['ticketTypeId'], $event['id']]);
        if (!$tt) throw not_found('Ticket type not found.');
        $seated = in_array($tt['id'], seated_type_ids($event['id']), true);
        if (!$seated && (int) $tt['quantity_sold'] + (int) $tt['quantity_held'] > 0) throw conflict("{$tt['name']} has already sold general admission tickets. Make a new ticket type for seats.", 'ticket_type_sold');
        $section = trim(preg_replace('/\s+/', ' ', $b['section']));
        if (val('SELECT 1 FROM seats WHERE event_id = ? AND section = ? LIMIT 1', [$event['id'], $section])) throw conflict("There is already a section called $section. Choose another name.", 'section_exists');
        if (trim((string) ($b['rowSeats'] ?? '')) !== '') {
            $counts = seat_row_counts((string) $b['rowSeats']);
            if (!$counts) throw invalid(['rowSeats' => 'Write each row and its seats, like A:10, B:12, C-F:14 (up to 100 rows, 120 seats a row).']);
        } else {
            $rows = seat_rows((string) ($b['rows'] ?? ''));
            if (!$rows) throw invalid(['rows' => 'Use a range like A-J or 1-20, or a list like A,B,C (up to 100 rows).']);
            if (empty($b['seatsPerRow'])) throw invalid(['seatsPerRow' => 'How many seats in each row?']);
            $counts = array_map(fn($r) => [$r, $b['seatsPerRow']], $rows);
        }
        $total = array_sum(array_column($counts, 1));
        $widest = max(array_column($counts, 1));
        if ($total + (int) val('SELECT count(*) FROM seats WHERE event_id = ?', [$event['id']]) > 50000) throw conflict('A seat map can hold up to 50 000 seats.', 'limit_exceeded');
        $access = $b['accessibleRows'] ?? '' ? array_flip(seat_rows((string) $b['accessibleRows'])) : [];
        $order = (int) val('SELECT COALESCE(MAX(section_order),0) + 1 FROM seats WHERE event_id = ?', [$event['id']]);
        $start = $b['startNumber'] ?? 1;
        $now = now_iso();
        foreach ($counts as $ri => [$label, $n]) {
            $offset = intdiv($widest - $n, 2);
            for ($i = 0; $i < $n; $i++) {
                q('INSERT INTO seats (id, event_id, ticket_type_id, section, section_order, row_label, row_order, seat_number, pos, step_free, status, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    [uuid(), $event['id'], $tt['id'], $section, $order, $label, $ri, $start + $i, $offset + $i, isset($access[$label]) ? 1 : 0, 'open', $now]);
            }
        }
        q('DELETE FROM seat_sections WHERE event_id = ? AND name = ?', [$event['id'], $section]);
        q('INSERT INTO seat_sections (id, event_id, name, x, y, rotation, curve, updated_at) VALUES (?,?,?,NULL,NULL,0,0,?)', [uuid(), $event['id'], $section, $now]);
        seats_sync_type($tt['id']);
        audit('seats.section_added', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['section' => $section, 'seats' => $total, 'ticketType' => $tt['name']]]);
        return json_out(['sections' => seat_map($event['id']), 'summary' => ext_seat_summary($event['id']), 'layout' => seat_layout($event['id'])], 201);
    });
});
route('POST', '/api/organiser/:orgId/events/:eventId/seats/sections/remove', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $b = check(body(), ['section' => R::str(['min' => 1, 'max' => 40])]);
    return tx(function () use ($u, $event, $b) {
        $types = array_column(rows('SELECT DISTINCT ticket_type_id FROM seats WHERE event_id = ? AND section = ?', [$event['id'], $b['section']]), 'ticket_type_id');
        if (!$types) throw not_found('Section not found.');
        if (val("SELECT 1 FROM seats WHERE event_id = ? AND section = ? AND status IN ('held','sold') LIMIT 1", [$event['id'], $b['section']])) throw conflict('Seats in this section are sold or being paid for. Block the seats you do not want to sell instead.', 'section_sold');
        q('DELETE FROM seats WHERE event_id = ? AND section = ?', [$event['id'], $b['section']]);
        q('DELETE FROM seat_sections WHERE event_id = ? AND name = ?', [$event['id'], $b['section']]);
        foreach ($types as $t) {
            // A type with no seats left goes back to general admission at its old quantity.
            if (val('SELECT 1 FROM seats WHERE ticket_type_id = ? LIMIT 1', [$t])) seats_sync_type($t);
        }
        audit('seats.section_removed', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['section' => $b['section']]]);
        return ['sections' => seat_map($event['id']), 'summary' => ext_seat_summary($event['id']), 'layout' => seat_layout($event['id'])];
    });
});
// Seats kept off sale (a sound desk, a pillar, house seats), or put back on.
route('POST', '/api/organiser/:orgId/events/:eventId/seats/block', function ($a) {
    [$u, $event] = ext_event($a['orgId'], $a['eventId']);
    $b = check(body(), ['seatIds' => R::arr(R::uuid(), ['min' => 1, 'max' => 500]), 'blocked' => R::bool()]);
    return tx(function () use ($u, $event, $b) {
        $ids = array_values(array_unique($b['seatIds']));
        $from = $b['blocked'] ? 'open' : 'blocked';
        $n = affected("UPDATE seats SET status = ?, updated_at = ? WHERE event_id = ? AND status = ? AND id IN (" . placeholders($ids) . ')',
            array_merge([$b['blocked'] ? 'blocked' : 'open', now_iso(), $event['id'], $from], $ids));
        foreach (array_column(rows('SELECT DISTINCT ticket_type_id FROM seats WHERE id IN (' . placeholders($ids) . ')', $ids), 'ticket_type_id') as $t) seats_sync_type($t);
        audit($b['blocked'] ? 'seats.blocked' : 'seats.unblocked', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['seats' => $n]]);
        return ['changed' => $n, 'sections' => seat_map($event['id']), 'summary' => ext_seat_summary($event['id']), 'layout' => seat_layout($event['id'])];
    });
});

// ============================================================== at the event
// Gate staff hand over extras (a parking pass, a T-shirt) to the ticket holder.
route('POST', '/api/staff/events/:eventId/extras/:id/collect', function ($a) {
    $u = require_auth();
    event_staff_access($u, $a['eventId']);
    $b = check(body(), ['quantity' => R::int(['min' => 1, 'max' => 20, 'optional' => true])]);
    return tx(function () use ($u, $a, $b) {
        $x = row("SELECT x.*, ad.name FROM order_addons x JOIN event_addons ad ON ad.id = x.addon_id WHERE x.id = ? AND x.event_id = ?", [$a['id'], $a['eventId']]);
        if (!$x) throw not_found('Extra not found.');
        if ($x['status'] !== 'valid') throw conflict('This extra was refunded or cancelled.', 'addon_not_valid');
        if ((int) val("SELECT test FROM orders WHERE id = ?", [$x['order_id']]) === 1) throw conflict('Test order: not valid at the event.', 'test_ticket');
        $n = $b['quantity'] ?? 1;
        if (affected('UPDATE order_addons SET collected = collected + ?, collected_at = ?, collected_by = ?, updated_at = ? WHERE id = ? AND collected + ? <= quantity', [$n, now_iso(), $u['id'], now_iso(), $x['id'], $n]) === 0) {
            throw conflict("Already handed over: {$x['collected']} of {$x['quantity']} × {$x['name']}.", 'addon_collected');
        }
        audit('addon.collected', ['actor' => $u, 'entityType' => 'order_addon', 'entityId' => $x['id'], 'details' => ['quantity' => $n]]);
        return ['extras' => order_addon_list($x['order_id'])];
    });
});
