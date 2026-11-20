<?php
// Load testing: create signed-in sessions for N seeded fans without paying the
// password-hashing cost N times, plus a fresh 100k match to book.
// Usage: php mint-sessions.php <data-dir> <count>  -> JSON on stdout
declare(strict_types=1);
$dir = $argv[1]; $n = (int) $argv[2];
$GLOBALS['TR_DATA_DIR'] = $dir; $GLOBALS['TR_CONFIG'] = require "$dir/config.php";
require dirname(__DIR__) . '/api/lib/core.php';
$now = now_iso();
$org = val("SELECT id FROM organisers WHERE slug = 'soweto-fc'");
$ev = uuid();
insert('events', ['id' => $ev, 'organiser_id' => $org, 'slug' => 'cup-final-' . substr($ev, 0, 6), 'title' => 'Cup Final', 'category' => 'sport', 'venue_name' => 'FNB Stadium', 'city' => 'Johannesburg',
    'starts_at' => iso_in(7 * 86400), 'ends_at' => iso_in(7 * 86400 + 10800), 'capacity' => 100000, 'status' => 'published', 'is_free' => 1, 'created_at' => $now, 'updated_at' => $now]);
$types = [];
foreach (['North Stand' => 40000, 'South Stand' => 40000, 'VIP' => 20000] as $name => $q) { $id = uuid(); $types[] = $id; insert('ticket_types', ['id' => $id, 'event_id' => $ev, 'name' => $name, 'price_cents' => 0, 'quantity_total' => $q, 'per_order_limit' => 10, 'created_at' => $now]); }
$out = [];
db()->beginTransaction();
foreach (rows('SELECT id FROM users WHERE email LIKE ? LIMIT ?', ['%@load.test', $n]) as $u) {
    $token = random_token(32); $csrf = random_token(24);
    insert('sessions', ['id' => uuid(), 'token_hash' => sha256($token), 'user_id' => $u['id'], 'csrf_token' => $csrf, 'created_at' => $now, 'expires_at' => iso_in(86400)]);
    $out[] = [$token, $csrf];
}
db()->commit();
echo json_encode(['slug' => val('SELECT slug FROM events WHERE id = ?', [$ev]), 'types' => $types, 'sessions' => $out]);
