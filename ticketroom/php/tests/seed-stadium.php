<?php
// Load-test data: one stadium match with 100,000 free tickets across four
// stands, booked by 40,000 fans. Usage: php seed-stadium.php <data-dir>
declare(strict_types=1);
$dir = $argv[1];
$GLOBALS['TR_DATA_DIR'] = $dir;
$GLOBALS['TR_CONFIG'] = require "$dir/config.php";
require dirname(__DIR__) . '/api/lib/core.php';
$t0 = microtime(true);
$pdo = db();
$pdo->exec('PRAGMA synchronous = OFF');
$now = now_iso();
$admin = val("SELECT id FROM users WHERE email = 'hello@ticketroom.co.za'");
$org = uuid();
$pdo->beginTransaction();
insert('organisers', ['id' => $org, 'name' => 'Soweto FC', 'slug' => 'soweto-fc', 'contact_email' => 'club@test.local', 'status' => 'approved', 'created_at' => $now]);
insert('organiser_members', ['organiser_id' => $org, 'user_id' => $admin, 'role' => 'owner', 'created_at' => $now]);
$ev = uuid();
insert('events', ['id' => $ev, 'organiser_id' => $org, 'slug' => 'derby-day', 'title' => 'Derby Day: Soweto FC vs Orlando United', 'category' => 'sport', 'venue_name' => 'FNB Stadium',
    'city' => 'Johannesburg', 'starts_at' => iso_in(1800), 'ends_at' => iso_in(4 * 3600), 'capacity' => 100000, 'status' => 'published', 'is_free' => 1, 'created_at' => $now, 'updated_at' => $now]);
$stands = ['North Stand' => 30000, 'South Stand' => 30000, 'East Stand' => 25000, 'West Stand' => 15000];
$tt = [];
foreach ($stands as $name => $n) { $id = uuid(); $tt[$name] = $id; insert('ticket_types', ['id' => $id, 'event_id' => $ev, 'name' => $name, 'price_cents' => 0, 'quantity_total' => $n, 'quantity_sold' => 0, 'per_order_limit' => 10, 'created_at' => $now]); }
$hash = password_hash('fan-password-1', PASSWORD_DEFAULT);
$u = $pdo->prepare('INSERT INTO users (id,email,full_name,password_hash,status,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
$o = $pdo->prepare("INSERT INTO orders (id,reference,event_id,user_id,status,buyer_name,buyer_email,subtotal_cents,total_cents,idempotency_key,expires_at,paid_at,created_at,updated_at) VALUES (?,?,?,?, 'paid',?,?,0,0,?,?,?,?,?)");
$oi = $pdo->prepare('INSERT INTO order_items (id,order_id,ticket_type_id,quantity,unit_price_cents) VALUES (?,?,?,?,0)');
$t = $pdo->prepare("INSERT INTO tickets (id,code,qr_version,order_id,order_item_id,event_id,ticket_type_id,owner_user_id,holder_name,price_cents,status,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?,?,0,'valid',?,?)");
$left = $stands; $made = 0; $i = 0; $names = array_keys($stands);
while ($made < 100000) {
    $i++;
    $uid = uuid(); $name = "Fan $i";
    $u->execute([$uid, "fan$i@load.test", $name, $hash, 'active', $now, $now, $now]);
    $stand = $names[$i % 4]; if ($left[$stand] <= 0) { foreach ($names as $s) if ($left[$s] > 0) { $stand = $s; break; } }
    $q = min(1 + ($i % 4), $left[$stand], 100000 - $made);
    $oid = uuid(); $iid = uuid();
    $o->execute([$oid, 'TR-' . strtoupper(substr(bin2hex(random_bytes(5)), 0, 8)), $ev, $uid, $name, "fan$i@load.test", "seed-$i", $now, $now, $now, $now]);
    $oi->execute([$iid, $oid, $tt[$stand], $q]);
    for ($k = 0; $k < $q; $k++) $t->execute([uuid(), random_code(10), $oid, $iid, $ev, $tt[$stand], $uid, $name, $now, $now]);
    $left[$stand] -= $q; $made += $q;
}
foreach ($stands as $name => $n) q('UPDATE ticket_types SET quantity_sold = ? WHERE id = ?', [$n - $left[$name], $tt[$name]]);
$pdo->commit();
printf("seeded %d tickets for %d fans in %.1fs; event %s; org %s\n", $made, $i, microtime(true) - $t0, $ev, $org);
