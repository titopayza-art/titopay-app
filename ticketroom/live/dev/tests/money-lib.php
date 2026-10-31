<?php
// Helpers for dev/tests/money.js: loads a harness instance's copy of the live
// package in the PHP CLI and builds money scenarios through the site's own
// functions (orders, sandbox payments, refunds, resale, payouts).
//
//   php -r "require 'money-lib.php'; tm_boot('<dir>'); ...; tm_out(...);"
//
// tm_rollback() runs a scenario inside one transaction and rolls it back, so
// settings it changes (live mode, webhook secrets) never reach the web server.
declare(strict_types=1);

function tm_boot(string $dir): void
{
    $_SERVER += ['REMOTE_ADDR' => '127.0.0.1', 'HTTP_HOST' => 'localhost', 'REQUEST_METHOD' => 'GET', 'REQUEST_URI' => '/cli'];
    require $dir . '/public_html/api/bootstrap.php';
    tr_load();
    foreach (glob(TR_APP . '/routes/*.php') as $f) require_once $f;
}
function tm_out($v): void { echo "\n@@TM@@" . json_encode($v, JSON_UNESCAPED_SLASHES) . "\n"; }
// The error code of what $fn throws, or 'none'.
function tm_err(callable $fn): string
{
    try { $fn(); return 'none'; }
    catch (AppError $e) { return $e->errCode; }
}
final class TmRollback extends Exception { public $value; public function __construct($v) { parent::__construct('rollback'); $this->value = $v; } }
function tm_rollback(callable $fn)
{
    try { tx(function () use ($fn) { throw new TmRollback($fn()); }); }
    catch (TmRollback $r) { $GLOBALS['TR_INTEG_RESET'] = true; return $r->value; }
    return null;
}
// Payments in live mode, PayFast with a made-up merchant (nothing is sent anywhere).
function tm_go_live(): void
{
    integration_save('payments', ['provider' => 'payfast', 'mode' => 'live', 'payfastMerchantId' => '19876543', 'payfastMerchantKey' => 'tmlivemerchant01'], [], tm_admin()['id']);
    $GLOBALS['TR_INTEG_RESET'] = true;
}

function tm_actor(array $u, array $roles): array
{
    return ['id' => $u['id'], 'email' => $u['email'], 'fullName' => $u['full_name'], 'phone' => $u['phone'] ?? null, 'platformRoles' => $roles, 'accountType' => $u['account_type'],
        'primaryRole' => array_values(array_intersect(['admin', 'finance', 'support'], $roles))[0] ?? 'user'];
}
function tm_admin(): array
{
    $u = row("SELECT u.* FROM users u JOIN platform_roles r ON r.user_id = u.id AND r.role = 'admin' ORDER BY u.created_at LIMIT 1");
    return tm_actor($u, array_column(rows('SELECT role FROM platform_roles WHERE user_id = ?', [$u['id']]), 'role'));
}
// A second finance person (made once).
function tm_finance(): array
{
    $u = row("SELECT * FROM users WHERE email = 'money.finance@example.test'");
    if (!$u) {
        $now = now_iso();
        $u = insert('users', ['id' => uuid(), 'email' => 'money.finance@example.test', 'email_key' => email_key('money.finance@example.test'), 'full_name' => 'Money Finance',
            'password_hash' => hash_secret(bin2hex(random_bytes(12))), 'status' => 'active', 'account_type' => 'staff', 'email_verified_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
        q('INSERT INTO platform_roles (user_id, role, granted_at) VALUES (?,?,?)', [$u['id'], 'finance', $now]);
    }
    return tm_actor($u, ['finance']);
}
function tm_buyer(?string $email = null): array
{
    $email ??= 'money+' . bin2hex(random_bytes(5)) . '@example.test';
    $u = tx(fn() => guest_buyer(['fullName' => 'Money Tester', 'email' => $email]));
    return exchange_buyer($u);
}
// A fresh paid event, copied from the seeded one: on sale, starting in three weeks.
function tm_event(array $o = []): array
{
    $src = row("SELECT * FROM events WHERE status = 'published' AND id IN (SELECT event_id FROM ticket_types WHERE price_cents > 0) ORDER BY created_at LIMIT 1");
    $ev = $src;
    $tag = bin2hex(random_bytes(4));
    $ev['id'] = uuid();
    $ev['slug'] = 'money-test-' . $tag;
    $ev['ref'] = function_exists('new_ref') ? new_ref('events') : null;
    $ev['title'] = 'Money test ' . $tag;
    $ev['created_at'] = $ev['updated_at'] = now_iso();
    foreach ($o as $k => $v) if ($k[0] !== '_') $ev[$k] = $v;
    $ev = array_filter($ev, fn($v) => $v !== null);
    insert('events', $ev);
    $price = (int) ($o['_price'] ?? 15000);
    $tt = row('SELECT * FROM ticket_types WHERE event_id = ? AND price_cents > 0 ORDER BY sort_order LIMIT 1', [$src['id']]);
    $tt['id'] = uuid();
    $tt['event_id'] = $ev['id'];
    $tt['price_cents'] = $price;
    $tt['quantity_sold'] = 0;
    $tt['quantity_held'] = 0;
    $tt['quantity_total'] = 100;
    $tt['release_after'] = null;
    insert('ticket_types', array_filter($tt, fn($v) => $v !== null));
    return row('SELECT * FROM events WHERE id = ?', [$ev['id']]) + ['ticketTypeId' => $tt['id']];
}
function tm_order(array $ev, int $qty = 1, ?array $buyer = null): array
{
    $buyer ??= tm_buyer();
    return create_order($buyer, ['eventSlug' => $ev['slug'], 'items' => [['ticketTypeId' => $ev['ticketTypeId'], 'quantity' => $qty]], 'idempotencyKey' => uuid()])['order'];
}
// The sandbox says "paid" for the order's open payment, exactly as /pay does.
function tm_pay(array $order): array
{
    $p = row("SELECT * FROM payments WHERE order_id = ? AND status IN ('initiated','pending') ORDER BY created_at DESC LIMIT 1", [$order['id']]);
    if (!$p) { payment_start(row('SELECT * FROM orders WHERE id = ?', [$order['id']])); $p = row("SELECT * FROM payments WHERE order_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", [$order['id']]); }
    $result = payment_apply('sandbox', $p['provider_reference'], 'paid', (int) $p['amount_cents']);
    return row('SELECT * FROM orders WHERE id = ?', [$order['id']]) + ['payResult' => $result];
}
function tm_start(array $order): array { payment_start(row('SELECT * FROM orders WHERE id = ?', [$order['id']])); return row('SELECT * FROM orders WHERE id = ?', [$order['id']]); }
function tm_buy(array $ev, int $qty = 1, ?array $buyer = null): array { $o = tm_order($ev, $qty, $buyer); tm_start($o); return tm_pay($o); }
function tm_tickets(string $orderId): array { return rows('SELECT * FROM tickets WHERE order_id = ? ORDER BY created_at, id', [$orderId]); }
function tm_user_of(array $order): array { return exchange_buyer(row('SELECT * FROM users WHERE id = ?', [$order['user_id']])); }
// A ticket on TicketRoom Exchange: the buyer of $order lists their first ticket.
function tm_list(array $order, int $price = 12000): array
{
    $t = tm_tickets($order['id'])[0];
    return resale_list(['id' => $order['user_id']], $t['id'], $price, null);
}
// Someone else starts paying for a listing (the listing is then held).
function tm_resale_order(string $listingId, ?array $buyer = null): array
{
    $buyer ??= tm_buyer();
    $o = resale_checkout($buyer, $listingId, null, ['idempotencyKey' => uuid()])['order'];
    return tm_start($o);
}
function tm_balance(string $account): int { return ledger_balance((pay_test() ? 'test:' : '') . $account); }
