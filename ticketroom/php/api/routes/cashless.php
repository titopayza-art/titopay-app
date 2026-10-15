<?php
// Cashless at events: the attendee's wristbands and event wallets (/api/me),
// the registration desk (/api/staff/tags), vendors, tills and wristband
// registration for organisers, the vendor till itself (/api/pos), and the
// admin's tag, till and settlement pages. The rules live in lib/cashless.php.
// Same JSON shapes as the Node edition (src/routes/{account,staff,pos,organiser,admin}.js).
declare(strict_types=1);

function cl_require_ready(): void
{
    if (!cashless_ready()) throw conflict('Cashless payments are not switched on yet.', 'cashless_unavailable');
}

// ============================================================== attendee: wristbands
route('GET', '/api/me/tags', fn() => ['tags' => tags_for_user(require_auth()['id'])]);

route('POST', '/api/me/tags/link', function () {
    $u = require_auth();
    limit('taglink', 10, 900, $u['id']);
    cl_require_ready();
    $b = check(body(), ['displayCode' => R::str(['min' => 8, 'max' => 12, 'pattern' => '/^[A-Za-z0-9 -]+$/']), 'activationCode' => R::str(['min' => 6, 'max' => 6, 'pattern' => '/^[A-Za-z0-9]+$/']), 'eventId' => R::uuid()]);
    return json_out(tag_link_by_attendee($u, $b['displayCode'], $b['activationCode'], $b['eventId']), 201);
});

// Lost or stolen: blocked at every till and gate at once. The balance stays
// on the account and is spent with the next band linked.
route('POST', '/api/me/tags/:id/lost', function ($a) {
    $u = require_auth();
    limit('taglost', 20, 3600, $u['id']);
    tag_report_lost($u, $a['id']);
    return ['ok' => true];
});

// ============================================================== attendee: wallets
route('GET', '/api/me/wallets', fn() => ['wallets' => wallets_for(require_auth()['id'])]);

route('GET', '/api/me/wallets/:eventId', function ($a) {
    $u = require_auth();
    $ev = row('SELECT * FROM events WHERE id = ?', [$a['eventId']]);
    if (!$ev) throw not_found('Event not found.');
    // Money already on the wallet can always be seen (and asked back), even if cashless was switched off later.
    $has = (bool) val('SELECT 1 FROM cashless_wallets WHERE user_id = ? AND event_id = ?', [$u['id'], $ev['id']]);
    if (!$has && !cashless_open_event($ev)) throw conflict('Cashless payments are not enabled for this event.', 'cashless_disabled');
    // A card top-up still waiting: ask the provider directly, in case its notification is slow.
    $p = row("SELECT p.id, p.updated_at FROM payments p JOIN wallet_topups t ON t.id = p.topup_id WHERE t.user_id = ? AND t.event_id = ? AND p.status = 'pending' AND p.provider = 'yoco' ORDER BY p.created_at DESC LIMIT 1", [$u['id'], $ev['id']]);
    if ($p && to_unix($p['updated_at']) < microtime(true) - 6) {
        q('UPDATE payments SET updated_at = ? WHERE id = ?', [now_iso(), $p['id']]);
        try { payment_sync($p['id']); } catch (Throwable $e) { error_log('[cashless] sync: ' . $e->getMessage()); }
    }
    $w = wallet_get($u['id'], $ev['id']);
    return [
        'event' => ['id' => $ev['id'], 'title' => $ev['title'], 'startsAt' => $ev['starts_at'], 'endsAt' => $ev['ends_at'], 'status' => $ev['status']],
        'balanceCents' => (int) $w['balance_cents'] + (int) $w['test_balance_cents'], 'testBalanceCents' => (int) $w['test_balance_cents'],
        'pendingRefundCents' => (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM refunds WHERE kind = 'wallet_balance' AND user_id = ? AND event_id = ? AND status IN ('requested','processing','manual_pending','failed')", [$u['id'], $ev['id']]),
        'history' => wallet_history($u['id'], $ev['id']),
        'limits' => cashless_limits() + ['topupFeeCents' => 0, 'refundFeeCents' => 0],
        'tags' => array_values(array_filter(tags_for_user($u['id']), fn($t) => $t['event_id'] === $ev['id'] && $t['status'] === 'active')),
    ];
});

route('POST', '/api/me/wallets/:eventId/topups', function ($a) {
    $u = require_auth();
    limit('topup', 10, 900, $u['id']);
    $b = check(body(), ['amountCents' => R::int(['min' => 1, 'max' => 100000000]), 'idempotencyKey' => R::idemKey(), 'paymentMethod' => R::oneOf(['card'], ['optional' => true, 'fallback' => 'card'])]);
    $out = topup_start($u, $a['eventId'], $b['amountCents'], $b['idempotencyKey']);
    return json_out(['topup' => ['reference' => $out['topup']['reference'], 'status' => $out['topup']['status']], 'payment' => $out['payment']], empty($out['replay']) ? 201 : 200);
});

route('POST', '/api/me/wallets/:eventId/refund', function ($a) {
    $u = require_auth();
    limit('walletrefund', 5, 3600, $u['id']);
    $made = wallet_refund_request($u, $a['eventId']);
    return json_out(['refund' => ['reference' => $made[0]['reference'], 'status' => 'requested', 'amountCents' => array_sum(array_map(fn($r) => (int) $r['amount_cents'], $made)),
        'references' => array_column($made, 'reference')]], 201);
});

// ============================================================== registration desk
route('POST', '/api/staff/tags/link', function () {
    $u = require_auth();
    limit('desk', 120, 60, $u['id']);
    cl_require_ready();
    $b = check(body(), ['eventId' => R::uuid(), 'tagInput' => R::str(['max' => 120]), 'ticketPayload' => R::str(['max' => 120])]);
    $ev = event_staff_access($u, $b['eventId'], 'can_manage_tags');
    return json_out(tag_link_by_staff($u, $ev, $b['ticketPayload'], $b['tagInput']), 201);
});
route('POST', '/api/staff/tags/lookup', function () {
    $u = require_auth();
    limit('desk', 120, 60, $u['id']);
    $b = check(body(), ['eventId' => R::uuid(), 'tagInput' => R::str(['max' => 120])]);
    event_staff_access($u, $b['eventId'], 'can_manage_tags');
    $tag = tag_resolve($b['tagInput']);
    // Only this event's tags are described; anything else is simply "not found".
    if (!$tag || $tag['event_id'] !== $b['eventId']) return ['found' => false];
    $holder = $tag['ticket_id'] ? val('SELECT holder_name FROM tickets WHERE id = ?', [$tag['ticket_id']]) : null;
    return ['found' => true, 'tag' => ['id' => $tag['id'], 'status' => $tag['status'], 'type' => $tag['tag_type'], 'displayCode' => tag_display($tag['display_code']), 'holder' => $holder, 'securityLevel' => $tag['security_level']]];
});
route('POST', '/api/staff/tags/replace', function () {
    $u = require_auth();
    limit('desk', 120, 60, $u['id']);
    $b = check(body(), ['eventId' => R::uuid(), 'oldTagId' => R::uuid(), 'newTagInput' => R::str(['max' => 120])]);
    $ev = event_staff_access($u, $b['eventId'], 'can_manage_tags');
    return tag_replace($u, $ev, $b['oldTagId'], $b['newTagInput']);
});
route('POST', '/api/staff/tags/:tagId/block', function ($a) {
    $u = require_auth();
    $b = check(body(), ['eventId' => R::uuid(), 'reason' => R::str(['min' => 3, 'max' => 200])]);
    event_staff_access($u, $b['eventId'], 'can_manage_tags');
    if (!val('SELECT 1 FROM tags WHERE id = ? AND event_id = ?', [$a['tagId'], $b['eventId']])) throw not_found('Tag not found.');
    tag_set_status($u, $a['tagId'], 'blocked', $b['reason']);
    return ['ok' => true];
});
// Desk staff who may manage tags can register a box of bands in one go.
route('POST', '/api/staff/events/:eventId/tags', function ($a) {
    $u = require_auth();
    limit('tagreg', 20, 3600, $u['id']);
    cl_require_ready();
    $ev = event_staff_access($u, $a['eventId'], 'can_manage_tags');
    return json_out(cl_register_bands($u, $ev, body()), 201);
});
function cl_register_bands(array $u, array $ev, array $body): array
{
    $b = check($body, ['tagType' => R::oneOf(['nfc_wristband', 'nfc_card'], ['optional' => true, 'fallback' => 'nfc_wristband']), 'uids' => R::arr(R::str(['max' => 40]), ['min' => 1, 'max' => 2000]), 'notes' => R::str(['optional' => true, 'max' => 200])]);
    if (in_array($ev['status'], ['cancelled', 'completed'], true)) throw conflict('This event is over.', 'event_locked');
    return tag_create_batch($u, ['tagType' => $b['tagType'], 'mode' => 'import', 'uids' => $b['uids'], 'eventId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'notes' => $b['notes'] ?? null]);
}

// ============================================================== organiser: wristbands
route('GET', '/api/organiser/:orgId/events/:eventId/tags', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $list = rows('SELECT g.id, g.display_code, g.tag_type, g.status, g.security_level, g.linked_at, g.last_used_at, g.status_reason, t.holder_name
                    FROM tags g LEFT JOIN tickets t ON t.id = g.ticket_id WHERE g.event_id = ? ORDER BY g.created_at DESC LIMIT 500', [$event['id']]);
    foreach ($list as &$t) $t['display_code'] = tag_display($t['display_code']);
    $counts = [];
    foreach (rows('SELECT status, count(*) AS n FROM tags WHERE event_id = ? GROUP BY status', [$event['id']]) as $r) $counts[$r['status']] = (int) $r['n'];
    return ['tags' => $list, 'counts' => (object) $counts];
});
// Bulk registration of the bands' chip UIDs. The answer is the only copy of
// the codes printed on each band (display code and activation code).
route('POST', '/api/organiser/:orgId/events/:eventId/tags', function ($a) {
    $u = require_auth();
    limit('tagreg', 20, 3600, $u['id']);
    cl_require_ready();
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    org_require_approved($org);
    return json_out(cl_register_bands($u, $event, body()), 201);
});

// ============================================================== organiser: vendors & tills
function cl_event_vendor(array $event, string $vendorId): array
{
    $v = row('SELECT * FROM vendors WHERE id = ? AND event_id = ?', [$vendorId, $event['id']]);
    if (!$v) throw not_found('Vendor not found.');
    return $v;
}
route('GET', '/api/organiser/:orgId/events/:eventId/vendors', function ($a) {
    ['event' => $event] = event_access(require_auth(), $a['orgId'], $a['eventId'], ORG_ALL);
    $figures = [];
    foreach (vendor_settlement_rows('v.event_id = ?', [$event['id']]) as $f) $figures[$f['id']] = $f;
    $list = rows('SELECT * FROM vendors WHERE event_id = ? ORDER BY created_at', [$event['id']]);
    foreach ($list as &$v) {
        $v['terminals'] = array_map(fn($t) => ['id' => $t['id'], 'label' => $t['label'], 'status' => $t['status'], 'lastSeenAt' => $t['last_seen_at']],
            rows('SELECT id, label, status, last_seen_at FROM terminals WHERE vendor_id = ? ORDER BY created_at', [$v['id']]));
        $v['members'] = array_map(fn($m) => ['userId' => $m['id'], 'name' => $m['full_name'], 'email' => $m['email'], 'role' => $m['role']],
            rows('SELECT u.id, u.full_name, u.email, vm.role FROM vendor_members vm JOIN users u ON u.id = vm.user_id WHERE vm.vendor_id = ? ORDER BY vm.created_at', [$v['id']]));
        $f = $figures[$v['id']] ?? [];
        foreach (['sales', 'gross_cents', 'commission_cents', 'payable_cents', 'in_flight_cents', 'paid_cents', 'test_gross_cents'] as $k) $v[$k] = $f[$k] ?? 0;
    }
    return ['vendors' => $list];
});
route('POST', '/api/organiser/:orgId/events/:eventId/vendors', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), ['name' => R::str(['min' => 2, 'max' => 100]), 'description' => R::str(['optional' => true, 'max' => 240]), 'commissionBps' => R::int(['min' => 0, 'max' => 5000, 'optional' => true, 'fallback' => 0])]);
    $now = now_iso();
    $v = insert('vendors', ['id' => uuid(), 'event_id' => $event['id'], 'organiser_id' => $event['organiser_id'], 'name' => $b['name'], 'description' => $b['description'] ?? null,
        'status' => 'active', 'commission_bps' => $b['commissionBps'], 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now]);
    audit('vendor.created', ['actor' => $u, 'entityType' => 'vendor', 'entityId' => $v['id'], 'organiserId' => $event['organiser_id'], 'details' => ['name' => $b['name'], 'commissionBps' => $b['commissionBps']]]);
    return json_out(['vendor' => row('SELECT * FROM vendors WHERE id = ?', [$v['id']])], 201);
});
route('PATCH', '/api/organiser/:orgId/events/:eventId/vendors/:vendorId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $v = cl_event_vendor($event, $a['vendorId']);
    $b = check(body(), ['status' => R::oneOf(['active', 'suspended'])]);
    q('UPDATE vendors SET status = ?, updated_at = ? WHERE id = ?', [$b['status'], now_iso(), $v['id']]);
    audit("vendor.{$b['status']}", ['actor' => $u, 'entityType' => 'vendor', 'entityId' => $v['id'], 'organiserId' => $event['organiser_id']]);
    return ['ok' => true];
});
// Vendor staff, like gate staff: someone without an account gets one (a
// customer account) and an email to choose a password.
route('POST', '/api/organiser/:orgId/events/:eventId/vendors/:vendorId/members', function ($a) {
    $u = require_auth();
    limit('staffadd', 30, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $v = cl_event_vendor($event, $a['vendorId']);
    $b = check(body(), ['email' => R::email(), 'role' => R::oneOf(['manager', 'cashier']), 'fullName' => R::str(['optional' => true, 'min' => 2, 'max' => 120])]);
    $found = user_by_email($b['email']);
    if ($found && $found['status'] !== 'active') throw conflict('That account is suspended or closed.', 'account_inactive');
    if ($found && account_type($found) === 'staff') throw conflict('That email belongs to a TicketRoom staff account. Vendor staff need their own email.', 'staff_account', ['email' => 'Use a different email.']);
    $invited = false;
    $uid = tx(function () use ($u, $b, $found, $v, $event, $org, &$invited) {
        $uid = $found['id'] ?? null;
        if (!$uid || (int) $found['guest'] === 1) {
            $now = now_iso();
            $name = $b['fullName'] ?? ($found['full_name'] ?? explode('@', $b['email'])[0]);
            if (!$uid) $uid = insert('users', ['id' => uuid(), 'email' => $b['email'], 'email_key' => email_key($b['email']), 'full_name' => $name, 'password_hash' => hash_secret(random_token(24)),
                'status' => 'active', 'account_type' => 'customer', 'created_at' => $now, 'updated_at' => $now])['id'];
            $token = random_token(32);
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $uid, 'expires_at' => iso_in(7 * 86400), 'created_at' => $now]);
            outbox_enqueue(['to' => $b['email'], 'userId' => $uid] + tpl('vendorInvite', ['name' => $name, 'organiser' => $org['name'], 'vendor' => $v['name'], 'event' => $event['title'], 'url' => base_url() . "/account#/reset/$token"]));
            $invited = true;
        }
        q('INSERT INTO vendor_members (vendor_id, user_id, role, added_by, created_at) VALUES (?,?,?,?,?) ON CONFLICT (vendor_id, user_id) DO UPDATE SET role = excluded.role', [$v['id'], $uid, $b['role'], $u['id'], now_iso()]);
        audit('vendor.member_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $event['organiser_id'], 'details' => ['vendorId' => $v['id'], 'role' => $b['role'], 'invited' => $invited]]);
        return $uid;
    });
    return json_out(['ok' => true, 'invited' => $invited, 'userId' => $uid], 201);
});
route('DELETE', '/api/organiser/:orgId/events/:eventId/vendors/:vendorId/members/:userId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $v = cl_event_vendor($event, $a['vendorId']);
    q('DELETE FROM vendor_members WHERE vendor_id = ? AND user_id = ?', [$v['id'], $a['userId']]);
    audit('vendor.member_removed', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['userId'], 'organiserId' => $event['organiser_id'], 'details' => ['vendorId' => $v['id']]]);
    return ['ok' => true];
});
route('POST', '/api/organiser/:orgId/events/:eventId/vendors/:vendorId/terminals', function ($a) {
    $u = require_auth();
    limit('terminalreg', 30, 3600, $u['id']);
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $v = cl_event_vendor($event, $a['vendorId']);
    if ($v['status'] !== 'active') throw conflict('This vendor is suspended.', 'vendor_suspended');
    $b = check(body(), ['label' => R::str(['min' => 1, 'max' => 60])]);
    return json_out(['terminal' => terminal_register($u, $v, $b['label'])], 201);
});
route('PATCH', '/api/organiser/:orgId/events/:eventId/terminals/:terminalId', function ($a) {
    $u = require_auth();
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ORG_EDIT);
    $b = check(body(), ['status' => R::oneOf(['active', 'suspended', 'retired'])]);
    if (affected("UPDATE terminals SET status = ? WHERE id = ? AND event_id = ? AND status <> 'retired'", [$b['status'], $a['terminalId'], $event['id']]) !== 1) throw not_found('Till not found.');
    audit("terminal.{$b['status']}", ['actor' => $u, 'entityType' => 'terminal', 'entityId' => $a['terminalId'], 'organiserId' => $event['organiser_id']]);
    return ['ok' => true];
});
route('POST', '/api/organiser/:orgId/events/:eventId/vendors/:vendorId/payout', function ($a) {
    $u = require_auth();
    limit('payoutreq', 10, 3600, $u['id']);
    ['event' => $event, 'organiser' => $org] = event_access($u, $a['orgId'], $a['eventId'], ORG_MONEY);
    $v = cl_event_vendor($event, $a['vendorId']);
    $po = vendor_payout_request($u, $org, $v);
    fin_payout_mail($po, 'payoutRequested');
    return json_out(['payout' => $po], 201);
});

// ============================================================== the vendor till
function cl_terminal(array $u): array { return terminal_context($u, $_SERVER['HTTP_X_TERMINAL_KEY'] ?? null); }

route('GET', '/api/pos/vendors', function () {
    $u = require_auth();
    return ['vendors' => rows('SELECT v.id, v.name, v.status, vm.role, e.id AS event_id, e.title AS event_title, e.starts_at, e.cashless_enabled
                                 FROM vendor_members vm JOIN vendors v ON v.id = vm.vendor_id JOIN events e ON e.id = v.event_id WHERE vm.user_id = ? ORDER BY e.starts_at DESC', [$u['id']])];
});
route('GET', '/api/pos/context', function () {
    $t = cl_terminal(require_auth());
    return [
        'terminal' => ['id' => $t['id'], 'label' => $t['label']], 'vendor' => ['id' => $t['vendor_id'], 'name' => $t['vendor_name'], 'role' => $t['member_role'] ?: 'organiser'],
        'event' => ['id' => $t['event_id'], 'title' => $t['event_title'], 'cashlessOpen' => cashless_open_event(['cashless_enabled' => $t['cashless_enabled']]) && $t['event_status'] === 'published'],
        'products' => rows('SELECT id, name, price_cents FROM products WHERE vendor_id = ? AND active = 1 ORDER BY sort_order, name', [$t['vendor_id']]),
        'serverTime' => now_iso(), 'limits' => ['pinThresholdCents' => cashless_limits()['pinThresholdCents'], 'maxSaleCents' => cashless_max_sale()],
        'test' => pay_test(),
    ];
});
route('POST', '/api/pos/sales', function () {
    $u = require_auth();
    $t = cl_terminal($u);
    limit('possale', 120, 60, 'terminal:' . $t['id']);
    $b = check(body(), [
        'items' => R::arr(R::obj(['productId' => R::uuid(), 'quantity' => R::int(['min' => 1, 'max' => 99])]), ['min' => 1, 'max' => 30]),
        'tagInput' => R::str(['max' => 120]), 'pin' => R::str(['optional' => true, 'max' => 6, 'pattern' => '/^\d{4,6}$/']), 'idempotencyKey' => R::idemKey(),
    ]);
    return pos_charge($u, $t, $b);
});
// Settles an uncertain outcome (timeout, dropped signal) without charging again.
route('GET', '/api/pos/sales/by-key/:key', function ($a) {
    $t = cl_terminal(require_auth());
    $s = row('SELECT * FROM pos_sales WHERE terminal_id = ? AND idempotency_key = ?', [$t['id'], substr($a['key'], 0, 80)]);
    return $s ? pos_sale_view($s) : ['status' => 'not_found'];
});
route('GET', '/api/pos/sales', function () {
    $t = cl_terminal(require_auth());
    return ['sales' => pos_vendor_sales($t['vendor_id'], 100)];
});
route('GET', '/api/pos/summary', function () {
    $t = cl_terminal(require_auth());
    return pos_vendor_summary(['id' => $t['vendor_id'], 'event_id' => $t['event_id']]);
});
// Balance check at the till: the amount only, never who the band belongs to.
route('POST', '/api/pos/balance', function () {
    $t = cl_terminal(require_auth());
    limit('posbalance', 60, 60, 'terminal:' . $t['id']);
    $b = check(body(), ['tagInput' => R::str(['max' => 120])]);
    $tag = tag_resolve($b['tagInput']);
    if (!$tag || $tag['event_id'] !== $t['event_id'] || $tag['status'] !== 'active') return ['found' => false, 'message' => 'This tag cannot be used here.'];
    return ['found' => true, 'balanceCents' => wallet_total($tag['user_id'], $t['event_id'])];
});
function cl_terminal_sale(array $t, string $saleId): array
{
    $s = row('SELECT * FROM pos_sales WHERE id = ? AND vendor_id = ?', [$saleId, $t['vendor_id']]);
    if (!$s) throw not_found('Sale not found.');
    return $s;
}
route('POST', '/api/pos/sales/:saleId/refund', function ($a) {
    $u = require_auth();
    $t = cl_terminal($u);
    limit('posrefund', 30, 3600, $u['id']);
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 300])]);
    $r = pos_refund_request($u, cl_terminal_sale($t, $a['saleId']), $b['reason']);
    return json_out(['refund' => ['reference' => $r['reference'], 'status' => $r['status']]], 201);
});
route('POST', '/api/pos/sales/:saleId/void', function ($a) {
    $u = require_auth();
    $t = cl_terminal($u);
    limit('posrefund', 30, 3600, $u['id']);
    if (($t['member_role'] ?? '') !== 'manager' && !in_array($t['org_role'], ['owner', 'manager'], true)) throw forbidden('Only a vendor manager or the organiser can void a sale.');
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 300])]);
    $s = cl_terminal_sale($t, $a['saleId']);
    $r = pos_void($u, $s, $b['reason']);
    return ['refund' => ['reference' => $r['reference'], 'status' => $r['status']], 'sale' => pos_sale_view(row('SELECT * FROM pos_sales WHERE id = ?', [$s['id']]))];
});
route('GET', '/api/pos/vendors/:vendorId/products', function ($a) {
    vendor_access(require_auth(), $a['vendorId'], ['manager', 'cashier']);
    return ['products' => rows('SELECT * FROM products WHERE vendor_id = ? ORDER BY sort_order, name', [$a['vendorId']])];
});
route('POST', '/api/pos/vendors/:vendorId/products', function ($a) {
    $u = require_auth();
    vendor_access($u, $a['vendorId'], ['manager']);
    $b = check(body(), ['name' => R::str(['min' => 1, 'max' => 60]), 'priceCents' => R::int(['min' => 100, 'max' => 1000000]), 'sortOrder' => R::int(['optional' => true, 'min' => 0, 'max' => 1000, 'fallback' => 0])]);
    $now = now_iso();
    $p = insert('products', ['id' => uuid(), 'vendor_id' => $a['vendorId'], 'name' => $b['name'], 'price_cents' => $b['priceCents'], 'active' => 1, 'sort_order' => $b['sortOrder'], 'created_at' => $now, 'updated_at' => $now]);
    audit('product.created', ['actor' => $u, 'entityType' => 'product', 'entityId' => $p['id'], 'details' => ['vendorId' => $a['vendorId'], 'price' => $b['priceCents']]]);
    return json_out(['product' => row('SELECT * FROM products WHERE id = ?', [$p['id']])], 201);
});
route('PATCH', '/api/pos/vendors/:vendorId/products/:productId', function ($a) {
    $u = require_auth();
    vendor_access($u, $a['vendorId'], ['manager']);
    $b = check(body(), ['name' => R::str(['optional' => true, 'min' => 1, 'max' => 60]), 'priceCents' => R::int(['optional' => true, 'min' => 100, 'max' => 1000000]), 'active' => R::bool(['optional' => true, 'fallback' => null])]);
    if (affected('UPDATE products SET name = COALESCE(?, name), price_cents = COALESCE(?, price_cents), active = COALESCE(?, active), updated_at = ? WHERE id = ? AND vendor_id = ?',
        [$b['name'] ?? null, $b['priceCents'] ?? null, isset($b['active']) ? (int) $b['active'] : null, now_iso(), $a['productId'], $a['vendorId']]) !== 1) throw not_found('Product not found.');
    audit('product.updated', ['actor' => $u, 'entityType' => 'product', 'entityId' => $a['productId'], 'details' => array_keys(array_filter($b, fn($v) => $v !== null))]);
    return ['product' => row('SELECT * FROM products WHERE id = ?', [$a['productId']])];
});
// A vendor manager can register their own tills too.
route('POST', '/api/pos/vendors/:vendorId/terminals', function ($a) {
    $u = require_auth();
    limit('terminalreg', 30, 3600, $u['id']);
    ['vendor' => $v] = vendor_access($u, $a['vendorId'], ['manager']);
    if ($v['status'] !== 'active') throw conflict('This vendor is suspended.', 'vendor_suspended');
    $b = check(body(), ['label' => R::str(['min' => 1, 'max' => 60])]);
    return json_out(['terminal' => terminal_register($u, $v, $b['label'])], 201);
});

// ============================================================== admin
route('POST', '/api/admin/tag-batches', function () {
    $u = adm_admin();
    limit('tagreg', 20, 3600, $u['id']);
    $b = check(body(), ['tagType' => R::oneOf(['nfc_wristband', 'nfc_card', 'qr_tag']), 'mode' => R::oneOf(['generate', 'import']),
        'quantity' => R::int(['optional' => true, 'min' => 1, 'max' => 2000]), 'uids' => R::arr(R::str(['max' => 40]), ['optional' => true, 'max' => 2000]),
        'eventId' => R::uuid(['optional' => true]), 'notes' => R::str(['optional' => true, 'max' => 200])]);
    if (!empty($b['eventId'])) {
        $ev = row('SELECT id, organiser_id FROM events WHERE id = ?', [$b['eventId']]);
        if (!$ev) throw not_found('Event not found.');
        $b['organiserId'] = $ev['organiser_id'];
    }
    return json_out(tag_create_batch($u, $b), 201);
});
route('GET', '/api/admin/tags', function () {
    adm_any();
    $q = substr((string) preg_replace('/[^A-Z0-9]/', '', strtoupper((string) qs('q', ''))), 0, 12);
    $list = rows("SELECT t.id, t.tag_type, t.display_code, t.status, t.security_level, t.linked_at, t.last_used_at, t.status_reason, e.title AS event_title, u.email AS owner_email
                    FROM tags t LEFT JOIN events e ON e.id = t.event_id LEFT JOIN users u ON u.id = t.user_id
                   WHERE ? = '' OR t.display_code LIKE ? ORDER BY t.created_at DESC LIMIT 200", [$q, $q . '%']);
    foreach ($list as &$t) $t['display_code'] = tag_display($t['display_code']);
    return ['tags' => $list];
});
route('GET', '/api/admin/tags/:id/history', function ($a) {
    adm_any();
    return ['history' => array_map(function ($h) { $h['details'] = $h['details'] ?: (object) []; return $h; },
        rows('SELECT te.action, te.details AS details, te.occurred_at, u.full_name AS actor FROM tag_events te LEFT JOIN users u ON u.id = te.actor_id WHERE te.tag_id = ? ORDER BY te.id DESC', [$a['id']]))];
});
route('POST', '/api/admin/tags/:id/status', function ($a) {
    $u = adm_admin_or_support();
    $b = check(body(), ['status' => R::oneOf(['blocked', 'active', 'revoked']), 'reason' => R::str(['min' => 3, 'max' => 200])]);
    tag_set_status($u, $a['id'], $b['status'], $b['reason']);
    return ['ok' => true];
});
route('GET', '/api/admin/terminals', function () {
    adm_any();
    return ['terminals' => rows('SELECT t.id, t.label, t.status, t.last_seen_at, t.created_at, v.name AS vendor_name, e.title AS event_title
                                   FROM terminals t JOIN vendors v ON v.id = t.vendor_id JOIN events e ON e.id = t.event_id ORDER BY t.created_at DESC LIMIT 300')];
});
route('POST', '/api/admin/terminals/:id/status', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['status' => R::oneOf(['active', 'suspended', 'retired'])]);
    if (affected('UPDATE terminals SET status = ? WHERE id = ?', [$b['status'], $a['id']]) !== 1) throw not_found('Till not found.');
    audit("terminal.{$b['status']}", ['actor' => $u, 'entityType' => 'terminal', 'entityId' => $a['id']]);
    return ['ok' => true];
});
// Cashless money per event and per vendor, for TicketRoom finance.
route('GET', '/api/admin/cashless', function () {
    adm_any();
    $events = rows("SELECT e.id, e.title, e.starts_at, e.ends_at, o.name AS organiser_name,
                           (SELECT COALESCE(SUM(amount_cents),0) FROM wallet_topups t WHERE t.event_id = e.id AND t.status = 'confirmed' AND t.test = 0) AS topups_cents,
                           (SELECT COALESCE(SUM(balance_cents),0) FROM cashless_wallets w WHERE w.event_id = e.id) AS outstanding_cents,
                           (SELECT COALESCE(SUM(amount_cents),0) FROM refunds r WHERE r.event_id = e.id AND r.kind = 'wallet_balance' AND r.status IN ('requested','processing','manual_pending','failed')) AS refunds_pending_cents,
                           (SELECT COALESCE(SUM(amount_cents),0) FROM refunds r WHERE r.event_id = e.id AND r.kind = 'wallet_balance' AND r.status = 'completed') AS refunded_cents
                      FROM events e JOIN organisers o ON o.id = e.organiser_id
                     WHERE e.cashless_enabled = 1 OR EXISTS (SELECT 1 FROM cashless_wallets w WHERE w.event_id = e.id) ORDER BY e.starts_at DESC LIMIT 200");
    foreach ($events as &$e) foreach (['topups_cents', 'outstanding_cents', 'refunds_pending_cents', 'refunded_cents'] as $k) $e[$k] = (int) $e[$k];
    return ['events' => $events, 'vendors' => vendor_settlement_rows('1 = 1', []), 'commissionCents' => -ledger_balance(CASHLESS_COMMISSION)];
});
