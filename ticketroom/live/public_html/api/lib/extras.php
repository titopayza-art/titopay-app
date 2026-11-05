<?php
// Three things sold or sent with a ticket:
//   WhatsApp delivery  the buyer's tickets as a WhatsApp message (Meta's
//                      WhatsApp Business Cloud API, an approved template).
//   Add-ons            parking, merchandise, VIP upgrades and the like, bought
//                      with tickets and collected at the event.
//   Reserved seats     a seated ticket type sells exactly its seats; buyers
//                      pick theirs on the seat map, or take the best available.
declare(strict_types=1);

// ============================================================== WhatsApp
const WHATSAPP_GRAPH = 'https://graph.facebook.com/v21.0';
// The API address; the config file can point it at a test server.
function whatsapp_base(): string { return rtrim((string) (cfg('whatsapp.graphBase') ?: WHATSAPP_GRAPH), '/'); }
function whatsapp_mode(): string { $m = (string) cfg('whatsapp.provider', 'none'); return in_array($m, ['cloud', 'log'], true) ? $m : 'none'; }
function whatsapp_ready(): bool
{
    return match (whatsapp_mode()) {
        'log' => true,
        'cloud' => (string) cfg('whatsapp.phoneNumberId', '') !== '' && (string) cfg('whatsapp.accessToken', '') !== '' && (string) cfg('whatsapp.templateName', '') !== '',
        default => false,
    };
}
// WhatsApp wants the number in international form without the plus: 27821234567.
function whatsapp_number(string $phone): string
{
    $d = preg_replace('/\D+/', '', $phone);
    return str_starts_with($d, '0') ? '27' . substr($d, 1) : $d;
}
// The message as stored in the queue: the template's four values, and the
// text the buyer reads (the template filled in), for the Messages page.
function whatsapp_ticket_message(array $order, array $event, int $count, string $link): array
{
    $params = [first_name($order['buyer_name']), mb_substr((string) $event['title'], 0, 120), when_str($event['starts_at']), $link];
    $text = "Hi {$params[0]}, your " . plural($count, 'ticket') . " for {$params[1]} on {$params[2]} " . ($count === 1 ? 'is' : 'are') . " ready. Open them here: {$params[3]}";
    return ['subject' => json_encode(['template' => 'ticket', 'params' => $params], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'body' => $text];
}
function whatsapp_send(string $to, string $body, ?string $meta): string
{
    if (!whatsapp_ready()) throw new RuntimeException('WhatsApp is not set up (Admin portal → Integrations).');
    if (whatsapp_mode() === 'log') return 'log';
    $m = json_decode((string) $meta, true);
    $params = is_array($m['params'] ?? null) ? $m['params'] : [$body];
    $payload = ['messaging_product' => 'whatsapp', 'recipient_type' => 'individual', 'to' => whatsapp_number($to), 'type' => 'template',
        'template' => ['name' => (string) cfg('whatsapp.templateName'), 'language' => ['code' => (string) (cfg('whatsapp.templateLanguage') ?: 'en')],
            'components' => [['type' => 'body', 'parameters' => array_map(fn($p) => ['type' => 'text', 'text' => (string) $p], $params)]]]];
    $r = http_request('POST', whatsapp_base() . '/' . rawurlencode((string) cfg('whatsapp.phoneNumberId')) . '/messages',
        ['Content-Type' => 'application/json', 'Authorization' => 'Bearer ' . cfg('whatsapp.accessToken')], json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    if ($r['status'] >= 200 && $r['status'] < 300 && !empty($r['json']['messages'][0]['id'])) return (string) $r['json']['messages'][0]['id'];
    $err = $r['json']['error'] ?? [];
    // 131026: the number is not on WhatsApp. 132xxx: the template is wrong. Neither gets better by trying again.
    $code = (int) ($err['code'] ?? 0);
    $msg = 'WhatsApp: ' . ($err['message'] ?? "HTTP {$r['status']}") . ($code ? " (code $code)" : '');
    if ($code === 131026 || ($code >= 132000 && $code < 133000) || $r['status'] === 400) throw new WhatsAppRejected($msg);
    throw new RuntimeException($msg);
}
final class WhatsAppRejected extends RuntimeException {}
function whatsapp_health(): array
{
    if (whatsapp_mode() === 'log') return ['ok' => true, 'detail' => 'Practice mode: messages appear under Messages and nothing is sent.'];
    if (!whatsapp_ready()) return ['ok' => false, 'detail' => 'Choose WhatsApp Business and enter the phone number ID, access token and template name first.'];
    try {
        $r = http_request('GET', whatsapp_base() . '/' . rawurlencode((string) cfg('whatsapp.phoneNumberId')) . '?fields=display_phone_number,verified_name,quality_rating',
            ['Authorization' => 'Bearer ' . cfg('whatsapp.accessToken')], null, 10);
        if ($r['status'] !== 200) return ['ok' => false, 'detail' => 'Meta did not accept the token or phone number ID (' . ($r['json']['error']['message'] ?? "HTTP {$r['status']}") . ').'];
        $j = $r['json'];
        return ['ok' => true, 'detail' => 'Connected to ' . ($j['verified_name'] ?? 'your business') . ' on ' . ($j['display_phone_number'] ?? 'WhatsApp') . (isset($j['quality_rating']) ? ", quality {$j['quality_rating']}" : '') . '.'];
    } catch (Throwable $e) { return ['ok' => false, 'detail' => $e->getMessage()]; }
}

// ============================================================== add-ons
const ADDON_KINDS = ['parking' => 'Parking', 'merch' => 'Merchandise', 'vip' => 'VIP upgrade', 'food' => 'Food and drink', 'other' => 'Extra'];
const ADDONS_PER_ORDER = 20;
// Checks the add-ons asked for. Returns lines like the ticket lines.
function addon_lines(array $event, array $items, int $ticketCount): array
{
    $lines = [];
    $seen = [];
    $count = 0;
    foreach ($items as $it) {
        $id = (string) ($it['addonId'] ?? '');
        $n = (int) ($it['quantity'] ?? 0);
        if ($n <= 0) continue;
        if (isset($seen[$id])) throw bad('Each extra may appear once.');
        $seen[$id] = true;
        $a = row('SELECT * FROM event_addons WHERE id = ? AND event_id = ?', [$id, $event['id']]);
        if (!$a || $a['status'] !== 'on_sale') throw conflict('A selected extra is not available.', 'addon_unavailable');
        if ($n > (int) $a['per_order_limit']) throw conflict("You can add at most {$a['per_order_limit']} × {$a['name']} per order.", 'limit_exceeded');
        $count += $n;
        $lines[] = ['addon' => $a, 'quantity' => $n, 'unitPrice' => (int) $a['price_cents']];
    }
    if ($lines && $ticketCount === 0) throw bad('Extras are sold with tickets. Choose a ticket too.');
    if ($count > ADDONS_PER_ORDER) throw conflict('At most ' . ADDONS_PER_ORDER . ' extras per order.', 'limit_exceeded');
    return $lines;
}
// Inside create_order's transaction: stock is held like tickets.
function addons_hold(array $order, array $lines): void
{
    $now = now_iso();
    foreach ($lines as $l) {
        if (affected('UPDATE event_addons SET quantity_held = quantity_held + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$l['quantity'], $l['addon']['id'], $l['quantity']]) === 0) {
            throw conflict("Not enough {$l['addon']['name']} left.", 'sold_out');
        }
        insert('order_addons', ['id' => uuid(), 'order_id' => $order['id'], 'addon_id' => $l['addon']['id'], 'event_id' => $order['event_id'], 'quantity' => $l['quantity'],
            'unit_price_cents' => $l['unitPrice'], 'status' => 'pending', 'created_at' => $now, 'updated_at' => $now]);
    }
}
function addons_fulfil(string $orderId): void
{
    foreach (rows("SELECT * FROM order_addons WHERE order_id = ? AND status = 'pending'", [$orderId]) as $x) {
        q('UPDATE event_addons SET quantity_held = MAX(quantity_held - ?, 0), quantity_sold = quantity_sold + ? WHERE id = ?', [$x['quantity'], $x['quantity'], $x['addon_id']]);
        q("UPDATE order_addons SET status = 'valid', updated_at = ? WHERE id = ?", [now_iso(), $x['id']]);
    }
}
function addons_release(string $orderId): void
{
    foreach (rows("SELECT * FROM order_addons WHERE order_id = ? AND status = 'pending'", [$orderId]) as $x) {
        q('UPDATE event_addons SET quantity_held = MAX(quantity_held - ?, 0) WHERE id = ?', [$x['quantity'], $x['addon_id']]);
        q("UPDATE order_addons SET status = 'cancelled', updated_at = ? WHERE id = ?", [now_iso(), $x['id']]);
    }
}
// A payment that arrived after the reservation lapsed: the extras are taken
// again if they are still there. False (and nothing held) if any is gone.
function addons_rehold(string $orderId): bool
{
    $got = [];
    foreach (rows("SELECT * FROM order_addons WHERE order_id = ? AND status = 'cancelled'", [$orderId]) as $x) {
        if (affected('UPDATE event_addons SET quantity_held = quantity_held + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$x['quantity'], $x['addon_id'], $x['quantity']]) === 0) {
            foreach ($got as $g) q('UPDATE event_addons SET quantity_held = MAX(quantity_held - ?, 0) WHERE id = ?', [$g['quantity'], $g['addon_id']]);
            return false;
        }
        $got[] = $x;
    }
    foreach ($got as $g) q("UPDATE order_addons SET status = 'pending', updated_at = ? WHERE id = ?", [now_iso(), $g['id']]);
    return true;
}
// Money still to give back for an order's extras (refunded with its last tickets).
function addons_open_cents(string $orderId): int
{
    return (int) val("SELECT COALESCE(SUM(quantity * unit_price_cents),0) FROM order_addons WHERE order_id = ? AND status = 'valid'", [$orderId]);
}
// What an order's buyer, the gate and emails see.
function order_addon_list(string $orderId, bool $all = false): array
{
    $list = rows('SELECT x.id, x.quantity, x.unit_price_cents, x.collected, x.status, a.name, a.kind FROM order_addons x JOIN event_addons a ON a.id = x.addon_id
                   WHERE x.order_id = ?' . ($all ? '' : " AND x.status = 'valid'") . ' ORDER BY a.sort_order, a.name', [$orderId]);
    return array_map(fn($x) => ['id' => $x['id'], 'name' => $x['name'], 'kind' => $x['kind'], 'quantity' => (int) $x['quantity'], 'collected' => (int) $x['collected'],
        'unitPriceCents' => (int) $x['unit_price_cents'], 'status' => $x['status']], $list);
}
function addon_text(array $list): array
{
    return array_map(fn($x) => "{$x['quantity']} × {$x['name']}", $list);
}

// ============================================================== reserved seats
function seat_label(array $s): string { return "{$s['section']}, row {$s['row_label']}, seat {$s['seat_number']}"; }
function seated_type_ids(string $eventId): array
{
    return array_column(rows('SELECT DISTINCT ticket_type_id FROM seats WHERE event_id = ?', [$eventId]), 'ticket_type_id');
}
// The best open seats of a type: side by side in one row if any row has
// room, nearest the front first; otherwise the first open seats.
function seats_best(string $ticketTypeId, int $n): array
{
    $open = rows("SELECT id, section, row_label, pos FROM seats WHERE ticket_type_id = ? AND status = 'open' ORDER BY section_order, row_order, pos", [$ticketTypeId]);
    $run = [];
    $key = null;
    foreach ($open as $s) {
        $k = $s['section'] . "\0" . $s['row_label'];
        if ($k !== $key || !$run || (int) end($run)['pos'] + 1 !== (int) $s['pos']) { $run = []; $key = $k; }
        $run[] = $s;
        if (count($run) === $n) return array_column($run, 'id');
    }
    return count($open) >= $n ? array_column(array_slice($open, 0, $n), 'id') : [];
}
// Inside create_order's transaction: the seats picked (or the best ones) are
// held with the order. A seat someone else took a moment ago is refused.
function seats_hold(array $order, array $lines, array $picked): void
{
    $seated = array_flip(seated_type_ids($order['event_id']));
    $picked = array_values(array_unique(array_map('strval', $picked)));
    $byType = [];
    if ($picked) {
        foreach (rows('SELECT * FROM seats WHERE event_id = ? AND id IN (' . placeholders($picked) . ')', array_merge([$order['event_id']], $picked)) as $s) $byType[$s['ticket_type_id']][] = $s;
        if (array_sum(array_map('count', $byType)) !== count($picked)) throw conflict('A chosen seat is not at this event.', 'seat_unavailable');
    }
    $types = array_column(array_map(fn($l) => $l['ticketType'], $lines), null, 'id');
    foreach (array_keys($byType) as $tt) if (!isset($types[$tt])) throw conflict('A chosen seat does not match the tickets in your cart.', 'seat_unavailable');
    $now = now_iso();
    foreach ($lines as $l) {
        $tt = $l['ticketType'];
        if (!isset($seated[$tt['id']])) continue;
        $mine = $byType[$tt['id']] ?? [];
        if ($mine && count($mine) !== (int) $l['quantity']) throw conflict('Choose ' . plural((int) $l['quantity'], 'seat') . " for {$tt['name']}, or let us pick the best available.", 'seat_count');
        $ids = $mine ? array_column($mine, 'id') : seats_best($tt['id'], (int) $l['quantity']);
        if (count($ids) !== (int) $l['quantity']) throw conflict("Not enough {$tt['name']} seats left.", 'sold_out');
        foreach ($ids as $id) {
            if (affected("UPDATE seats SET status = 'held', order_id = ?, updated_at = ? WHERE id = ? AND status = 'open'", [$order['id'], $now, $id]) === 0) {
                $s = row('SELECT * FROM seats WHERE id = ?', [$id]);
                throw conflict(seat_label($s) . ' was just taken. Choose another seat.', 'seat_taken');
            }
        }
    }
}
function seats_release(string $orderId): void
{
    q("UPDATE seats SET status = 'open', order_id = NULL, updated_at = ? WHERE order_id = ? AND status = 'held'", [now_iso(), $orderId]);
}
// The seat a new ticket of a seated type gets: one held for it, or (a
// payment that arrived after its hold lapsed) the best one still open.
function seat_for_ticket(string $orderId, string $ticketTypeId): ?array
{
    $s = row("SELECT * FROM seats WHERE order_id = ? AND ticket_type_id = ? AND status = 'held' ORDER BY section_order, row_order, pos LIMIT 1", [$orderId, $ticketTypeId]);
    if (!$s) {
        $id = seats_best($ticketTypeId, 1)[0] ?? null;
        $s = $id ? row('SELECT * FROM seats WHERE id = ?', [$id]) : null;
    }
    return $s;
}
function seat_sold(array $seat, string $orderId, string $ticketId): void
{
    q("UPDATE seats SET status = 'sold', order_id = ?, ticket_id = ?, updated_at = ? WHERE id = ?", [$orderId, $ticketId, now_iso(), $seat['id']]);
}
// Tickets whose places went back on sale: their seats open again.
function seats_free_tickets(array $ticketIds): void
{
    if (!$ticketIds) return;
    q("UPDATE seats SET status = 'open', order_id = NULL, ticket_id = NULL, updated_at = ? WHERE ticket_id IN (" . placeholders($ticketIds) . ')', array_merge([now_iso()], $ticketIds));
}
// A seated type sells exactly its seats (blocked ones aside).
function seats_sync_type(string $ticketTypeId): void
{
    $n = (int) val("SELECT count(*) FROM seats WHERE ticket_type_id = ? AND status <> 'blocked'", [$ticketTypeId]);
    q('UPDATE ticket_types SET quantity_total = MAX(?, quantity_sold + quantity_held) WHERE id = ?', [$n, $ticketTypeId]);
}
// Row labels: "A-J", "AA-AD", "1-20" or a list "A,B,C".
function seat_rows(string $spec): array
{
    $spec = strtoupper(trim($spec));
    if (preg_match('/^(\d{1,3})\s*-\s*(\d{1,3})$/', $spec, $m)) return (int) $m[1] <= (int) $m[2] && (int) $m[2] - (int) $m[1] < 100 ? array_map('strval', range((int) $m[1], (int) $m[2])) : [];
    if (preg_match('/^([A-Z]{1,2})\s*-\s*([A-Z]{1,2})$/', $spec, $m)) {
        $out = [];
        for ($r = $m[1], $i = 0; $i < 100; $r++, $i++) { $out[] = $r; if ($r === $m[2]) return $out; }
        return [];
    }
    $list = array_values(array_filter(array_map('trim', explode(',', $spec)), 'strlen'));
    foreach ($list as $r) if (!preg_match('/^[A-Z0-9]{1,4}$/', $r)) return [];
    return count($list) <= 100 ? $list : [];
}
// The seat map as the public sees it: sections, rows and seats with their
// state (open, taken or not for sale). Never whose a seat is.
function seat_map(string $eventId): array
{
    $types = array_column(rows('SELECT id, name, price_cents, status FROM ticket_types WHERE event_id = ?', [$eventId]), null, 'id');
    $sections = [];
    foreach (rows('SELECT id, ticket_type_id, section, section_order, row_label, seat_number, pos, step_free, status FROM seats WHERE event_id = ? ORDER BY section_order, section, row_order, pos', [$eventId]) as $s) {
        $k = $s['section'];
        if (!isset($sections[$k])) $sections[$k] = ['name' => $k, 'ticketTypeId' => $s['ticket_type_id'], 'ticketType' => $types[$s['ticket_type_id']]['name'] ?? '', 'priceCents' => (int) ($types[$s['ticket_type_id']]['price_cents'] ?? 0), 'rows' => []];
        $sections[$k]['rows'][$s['row_label']][] = ['id' => $s['id'], 'n' => (int) $s['seat_number'], 'p' => (int) $s['pos'], 'a' => (int) $s['step_free'], 's' => $s['status'] === 'open' ? 'open' : ($s['status'] === 'blocked' ? 'blocked' : 'taken')];
    }
    return array_values(array_map(fn($sec) => ['rows' => array_map(fn($label, $seats) => ['label' => (string) $label, 'seats' => $seats], array_keys($sec['rows']), array_values($sec['rows']))] + $sec, $sections));
}
