<?php
// Approved third-party retail partners. All sales use TicketRoom's online
// order holds, payment confirmation, ticket issuance and append-only ledger.
declare(strict_types=1);

function retail_member(array $u, bool $seller = true): array
{
    $m = row("SELECT p.*, m.role FROM retail_partner_members m JOIN retail_partners p ON p.id = m.partner_id WHERE m.user_id = ? AND p.status = 'approved' ORDER BY m.role = 'owner' DESC LIMIT 1", [$u['id']]);
    if (!$m) throw forbidden('A retail partner account must be approved before selling.');
    if (!$seller && $m['role'] !== 'owner') throw forbidden('Only the retail partner owner can do that.');
    return $m;
}
function retail_code(): string { return 'RP-' . random_code(8); }
function retail_require_enabled(): void
{
    $retail = settings_all()['retail'];
    if (empty($retail['enabled'])) {
        throw new AppError(503, 'retail_paused', $retail['message'] ?: 'Retail applications and sales will open soon.');
    }
}

// Public directory: disclose only the business name and public shop address
// for approved partners that sell tickets in person. Never expose owner data.
route('GET', '/api/retail/locations', function () {
    retail_require_enabled();
    $rows = rows("SELECT business_name, store_address, website_url, location_lat_e6, location_lng_e6, sales_channels
      FROM retail_partners WHERE status = 'approved' ORDER BY business_name COLLATE NOCASE LIMIT 1000");
    $retailers = [];
    foreach ($rows as $p) {
        $channels = json_decode((string) $p['sales_channels'], true) ?: [];
        if (!in_array('physical', $channels, true)) continue;
        $retailers[] = ['name' => $p['business_name'], 'address' => $p['store_address'], 'website' => $p['website_url'],
            'latE6' => $p['location_lat_e6'] === null ? null : (int) $p['location_lat_e6'],
            'lngE6' => $p['location_lng_e6'] === null ? null : (int) $p['location_lng_e6']];
    }
    return ['retailers' => $retailers];
});

function retail_open_shift(string $eventId, string $partnerId, string $cashierId): ?array
{
    $s = row("SELECT id FROM door_shifts WHERE event_id = ? AND retail_partner_id = ? AND cashier_id = ? AND status = 'open'", [$eventId, $partnerId, $cashierId]);
    return $s ? door_shift_view($s['id']) : null;
}
function retail_events_for(array $p): array
{
    return ['events' => rows("SELECT e.id, e.title, e.slug, e.venue_name, e.city, e.starts_at, e.ends_at, e.sales_start_at, e.sales_end_at,
      (SELECT count(*) FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale' AND tt.quantity_total > tt.quantity_sold + tt.quantity_held) AS ticket_types_available
      FROM events e WHERE e.status = 'published' AND e.ends_at > ? ORDER BY e.starts_at LIMIT 300", [now_iso()]),
      'partner' => ['id' => $p['id'], 'name' => $p['business_name'], 'ref' => $p['ref'], 'salesChannels' => json_decode((string) $p['sales_channels'], true) ?: [], 'locationSet' => $p['location_lat_e6'] !== null && $p['location_lng_e6'] !== null],
      'rates' => ['commissionShareBps' => (int) (settings_all()['fees']['retailCommissionShareBps'] ?? 150), 'serviceShareCents' => (int) (settings_all()['fees']['retailServiceFeeShareCents'] ?? 300), 'serviceFeeCents' => (int) (settings_all()['fees']['ticketFeeFixedCents'] ?? 1000), 'serviceFeeBps' => (int) (settings_all()['fees']['ticketFeeBps'] ?? 0)]];
}

route('GET', '/api/retail/me', function () {
    retail_require_enabled();
    $u = require_auth();
    $p = row('SELECT p.*, m.role FROM retail_partners p JOIN retail_partner_members m ON m.partner_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC LIMIT 1', [$u['id']]);
    if (!$p) return ['application' => null, 'user' => ['fullName' => $u['fullName'], 'email' => $u['email'], 'emailVerified' => !empty($u['emailVerified']), 'accountType' => $u['accountType']]];
    unset($p['owner_user_id'], $p['approved_by']);
    $p['salesChannels'] = json_decode((string) $p['sales_channels'], true) ?: [];
    $p['balanceCents'] = -ledger_balance('payable:retail:' . $p['id']);
    return ['application' => $p, 'user' => ['fullName' => $u['fullName'], 'email' => $u['email'], 'emailVerified' => !empty($u['emailVerified']), 'accountType' => $u['accountType']]];
});

route('POST', '/api/retail/location', function () {
    retail_require_enabled();
    $u = require_auth(); $p = retail_member($u, false);
    if (!in_array('physical', json_decode((string) $p['sales_channels'], true) ?: [], true)) {
        throw forbidden('Only partners approved for in-person sales can publish a shop location.');
    }
    $b = check(body(), ['latE6' => R::int(['min' => -90000000, 'max' => 90000000]), 'lngE6' => R::int(['min' => -180000000, 'max' => 180000000])]);
    q('UPDATE retail_partners SET location_lat_e6 = ?, location_lng_e6 = ?, updated_at = ? WHERE id = ?', [$b['latE6'], $b['lngE6'], now_iso(), $p['id']]);
    audit('retail_partner.location_updated', ['actor' => $u, 'entityType' => 'retail_partner', 'entityId' => $p['id'], 'details' => ['locationSet' => true]]);
    return ['ok' => true];
});
route('POST', '/api/retail/apply', function () {
    retail_require_enabled();
    $u = require_auth();
    if (account_type($u) === 'staff') throw forbidden('Platform staff cannot apply for retail selling access.');
    if (empty($u['emailVerified'])) throw conflict('Verify your TicketRoom email before applying.', 'email_verification_required');
    $b = check(body(), ['businessName' => R::str(['min' => 2, 'max' => 160]), 'registrationNumber' => R::str(['optional' => true, 'max' => 50]),
      'contactPhone' => R::phone(), 'storeAddress' => R::str(['min' => 5, 'max' => 300]), 'salesChannels' => R::arr(R::oneOf(['physical','online']), ['min' => 1, 'max' => 2]),
      'websiteUrl' => R::str(['optional' => true, 'max' => 250, 'pattern' => '#^https://[^/\\\s]+#'])]);
    $id = uuid(); $now = now_iso(); $ref = retail_code();
    tx(function () use ($u, $b, $id, $ref, $now) {
        if (val('SELECT 1 FROM retail_partners WHERE owner_user_id = ? LIMIT 1', [$u['id']])) throw conflict('Your retail partner application already exists.', 'retail_application_exists');
        if (val('SELECT 1 FROM retail_partner_members WHERE user_id = ? LIMIT 1', [$u['id']])) throw conflict('This account already belongs to a retail partner. Contact TicketRoom if you need to apply for another business.', 'retail_account_linked');
        insert('retail_partners', ['id' => $id, 'ref' => $ref, 'owner_user_id' => $u['id'], 'business_name' => trim($b['businessName']), 'registration_number' => $b['registrationNumber'] ?? null,
          'contact_phone' => $b['contactPhone'], 'store_address' => trim($b['storeAddress']), 'sales_channels' => json_encode(array_values(array_unique($b['salesChannels']))), 'website_url' => $b['websiteUrl'] ?? null,
          'status' => 'pending', 'review_note' => null, 'created_at' => $now, 'updated_at' => $now, 'approved_at' => null, 'approved_by' => null]);
        insert('retail_partner_members', ['partner_id' => $id, 'user_id' => $u['id'], 'role' => 'owner', 'created_at' => $now]);
    });
    audit('retail_partner.applied', ['actor' => $u, 'entityType' => 'retail_partner', 'entityId' => $id, 'details' => ['reference' => $ref, 'channels' => $b['salesChannels']]]);
    outbox_enqueue(['to' => $u['email'], 'userId' => $u['id'], 'subject' => "Retail partner application $ref received", 'body' => "Hi {$u['fullName']},\n\nWe have received your application to sell TicketRoom tickets as {$b['businessName']}. Your reference is $ref. TicketRoom will review the application and email you when a decision has been made.\n\nYou can follow its status in the Retail partners portal."]);
    outbox_enqueue(['to' => settings_all()['support']['email'], 'subject' => "Retail partner application $ref", 'body' => "A new retail partner application is ready for review.\n\nBusiness: {$b['businessName']}\nApplicant: {$u['fullName']} ({$u['email']})\nChannels: " . implode(', ', $b['salesChannels']) . "\nReference: $ref\n\nReview it in Admin portal → Retail partners."]);
    return json_out(['application' => ['ref' => $ref, 'status' => 'pending']], 201);
});

route('GET', '/api/admin/retail-partners', function () {
    adm_any();
    $list = rows("SELECT p.*, u.full_name AS owner_name, u.email AS owner_email,
       (SELECT count(*) FROM orders o WHERE o.retail_partner_id = p.id AND o.status IN ('paid','paid_unfulfilled','partially_refunded','refunded')) AS paid_orders
       FROM retail_partners p JOIN users u ON u.id = p.owner_user_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END, p.created_at DESC LIMIT 500");
    foreach ($list as &$p) { $p['sales_channels'] = json_decode((string) $p['sales_channels'], true) ?: []; $p['balance_cents'] = -ledger_balance('payable:retail:' . $p['id']); }
    return ['partners' => $list];
});
route('POST', '/api/admin/retail-partners/:id/status', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['status' => R::oneOf(['approved','rejected','suspended']), 'note' => R::str(['optional' => true, 'max' => 400])]);
    $p = row('SELECT p.*, u.full_name, u.email FROM retail_partners p JOIN users u ON u.id = p.owner_user_id WHERE p.id = ?', [$a['id']]);
    if (!$p) throw not_found('Retail partner application not found.');
    if ($b['status'] !== 'approved' && val("SELECT 1 FROM door_shifts WHERE retail_partner_id = ? AND status = 'open' LIMIT 1", [$a['id']])) {
        throw conflict('The partner has an open cashier shift. Close and reconcile it before disabling sales access.', 'retail_shift_open');
    }
    if ($b['status'] !== 'approved' && val("SELECT 1 FROM door_order_intents i JOIN orders o ON o.id = i.order_id WHERE i.retail_partner_id = ? AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' LIMIT 1", [$a['id']])) {
        throw conflict('The partner has a reserved sale awaiting payment. Resolve it before disabling sales access.', 'retail_sale_pending');
    }
    $now = now_iso();
    q('UPDATE retail_partners SET status = ?, review_note = ?, updated_at = ?, approved_at = CASE WHEN ? = \'approved\' THEN ? ELSE approved_at END, approved_by = CASE WHEN ? = \'approved\' THEN ? ELSE approved_by END WHERE id = ?',
      [$b['status'], $b['note'] ?? null, $now, $b['status'], $now, $b['status'], $u['id'], $a['id']]);
    audit('retail_partner.' . $b['status'], ['actor' => $u, 'entityType' => 'retail_partner', 'entityId' => $a['id'], 'details' => ['note' => $b['note'] ?? null]]);
    outbox_enqueue(['to' => $p['email'], 'userId' => $p['owner_user_id'], 'subject' => 'Retail partner application update',
      'body' => $b['status'] === 'approved' ? "Hi {$p['full_name']},\n\nYour retail partner application for {$p['business_name']} has been approved. Sign in to TicketRoom and open Retail sales to begin.\n\nYour partner reference is {$p['ref']}." : "Hi {$p['full_name']},\n\nYour retail partner application for {$p['business_name']} is {$b['status']}." . (!empty($b['note']) ? "\n\nNote: {$b['note']}" : '')]);
    return ['partner' => row('SELECT id, ref, status, updated_at FROM retail_partners WHERE id = ?', [$a['id']])];
});

route('GET', '/api/admin/retail-partners/:id/sales', function ($a) {
    adm_any(); $p = row('SELECT id FROM retail_partners WHERE id = ?', [$a['id']]); if (!$p) throw not_found('Retail partner not found.');
    $orders = rows("SELECT o.reference,o.status,o.buyer_name,o.buyer_email,o.total_cents,o.retail_commission_share_cents,o.retail_service_share_cents,o.created_at,e.title,
      (SELECT dt.method FROM door_tenders dt WHERE dt.order_id = o.id LIMIT 1) AS tender_method,
      (SELECT dt.external_reference FROM door_tenders dt WHERE dt.order_id = o.id LIMIT 1) AS tender_reference
      FROM orders o JOIN events e ON e.id = o.event_id WHERE o.retail_partner_id = ? ORDER BY o.created_at DESC LIMIT 500", [$a['id']]);
    return ['orders' => $orders, 'balanceCents' => -ledger_balance('payable:retail:' . $a['id'])];
});
route('POST', '/api/admin/retail-partners/:id/payout', function ($a) {
    $u = adm_finance(); $b = check(body(), ['amountCents' => R::int(['min' => 1, 'max' => 1000000000]), 'bankReference' => R::str(['min' => 3, 'max' => 100])]);
    if (trim($b['bankReference']) === '') throw bad('Enter the bank or EFT reference for this payout.');
    $p = row('SELECT id, ref, business_name FROM retail_partners WHERE id = ? AND status = \'approved\'', [$a['id']]); if (!$p) throw not_found('Approved retail partner not found.');
    return tx(function () use ($u, $b, $p) {
        $balance = max(0, -ledger_balance('payable:retail:' . $p['id']));
        if ($b['amountCents'] > $balance) throw conflict('The payout exceeds the partner’s available recorded balance.', 'retail_payout_exceeds_balance');
        $id = uuid(); $ref = trim($b['bankReference']);
        insert('retail_partner_payouts', ['id' => $id, 'partner_id' => $p['id'], 'amount_cents' => $b['amountCents'], 'bank_reference' => $ref, 'paid_by' => $u['id'], 'created_at' => now_iso()]);
        ledger_post('retail_partner_payout', 'RTP-' . $id, [['payable:retail:' . $p['id'], $b['amountCents']], ['bank:retail_payouts', -$b['amountCents']]]);
        audit('retail_partner.payout_recorded', ['actor' => $u, 'entityType' => 'retail_partner', 'entityId' => $p['id'], 'details' => ['amountCents' => $b['amountCents'], 'bankReference' => $ref]]);
        return ['payout' => ['id' => $id, 'amountCents' => $b['amountCents'], 'bankReference' => $ref], 'balanceCents' => $balance - $b['amountCents']];
    });
});

route('GET', '/api/retail/events', function () {
    retail_require_enabled();
    return retail_events_for(retail_member(require_auth()));
});
route('GET', '/api/retail/sales', function () {
    retail_require_enabled();
    $p = retail_member(require_auth());
    $orders = rows("SELECT o.reference,o.status,o.buyer_name,o.total_cents,o.retail_commission_share_cents,o.retail_service_share_cents,o.created_at,e.title,
      (SELECT dt.method FROM door_tenders dt WHERE dt.order_id=o.id LIMIT 1) AS tender_method,
      (SELECT dt.receipt_reference FROM door_tenders dt WHERE dt.order_id=o.id LIMIT 1) AS receipt_reference
      FROM orders o JOIN events e ON e.id=o.event_id WHERE o.retail_partner_id=? ORDER BY o.created_at DESC LIMIT 300", [$p['id']]);
    return ['orders'=>$orders, 'balanceCents'=>-ledger_balance('payable:retail:' . $p['id'])];
});
route('GET', '/api/retail/members', function () {
    retail_require_enabled();
    $p = retail_member(require_auth(), false);
    return ['members' => rows('SELECT u.id,u.full_name,u.email,m.role,m.created_at FROM retail_partner_members m JOIN users u ON u.id=m.user_id WHERE m.partner_id=? ORDER BY m.role DESC,m.created_at', [$p['id']])];
});
route('POST', '/api/retail/members', function () {
    retail_require_enabled();
    $u = require_auth();
    $p = retail_member($u, false);
    $b = check(body(), ['email' => R::email()]);
    $target = row("SELECT id,full_name,email,email_verified_at,account_type FROM users WHERE lower(email)=lower(?) AND status='active' AND guest=0", [$b['email']]);
    if (!$target || empty($target['email_verified_at']) || $target['account_type'] === 'staff') throw not_found('Ask this seller to create and verify a TicketRoom account first.');
    if ($target['id'] === $u['id']) throw conflict('The partner owner already has access.', 'retail_member_exists');
    tx(function () use ($target, $p) {
        if (val('SELECT 1 FROM retail_partner_members WHERE user_id = ? LIMIT 1', [$target['id']])) throw conflict('This account is already linked to a retail partner.', 'retail_member_linked');
        insert('retail_partner_members', ['partner_id' => $p['id'], 'user_id' => $target['id'], 'role' => 'seller', 'created_at' => now_iso()]);
    });
    audit('retail_partner.seller_added', ['actor' => $u, 'entityType' => 'retail_partner', 'entityId' => $p['id'], 'details' => ['sellerUserId' => $target['id'], 'sellerEmail' => $target['email']]]);
    outbox_enqueue(['to' => $target['email'], 'userId' => $target['id'], 'subject' => 'You can now sell tickets for ' . $p['business_name'],
        'body' => "Hi {$target['full_name']},\n\n{$u['fullName']} added you as a seller for {$p['business_name']}. Sign in to TicketRoom and open Retail partners to sell tickets. You can only access this partner's sales."]);
    return json_out(['member' => ['fullName' => $target['full_name'], 'email' => $target['email'], 'role' => 'seller']], 201);
});
route('DELETE', '/api/retail/members/:userId', function ($a) {
    retail_require_enabled();
    $u = require_auth();
    $p = retail_member($u, false);
    if ($a['userId'] === $u['id']) throw conflict('The owner cannot remove their own access.', 'retail_owner_required');
    if (val("SELECT 1 FROM door_shifts WHERE retail_partner_id = ? AND cashier_id = ? AND status = 'open' LIMIT 1", [$p['id'], $a['userId']])) {
        throw conflict('Ask this seller to close their cashier shifts before removing access.', 'retail_seller_shift_open');
    }
    if (val("SELECT 1 FROM door_order_intents i JOIN orders o ON o.id = i.order_id WHERE i.retail_partner_id = ? AND i.cashier_id = ? AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' LIMIT 1", [$p['id'], $a['userId']])) {
        throw conflict('Resolve this seller’s reserved sale before removing access.', 'retail_seller_sale_pending');
    }
    if (!affected("DELETE FROM retail_partner_members WHERE partner_id = ? AND user_id = ? AND role = 'seller'", [$p['id'], $a['userId']])) throw not_found('Retail seller not found.');
    audit('retail_partner.seller_removed', ['actor' => $u, 'entityType' => 'retail_partner', 'entityId' => $p['id'], 'details' => ['sellerUserId' => $a['userId']]]);
    return ['removed' => true];
});
route('GET', '/api/retail/events/:eventId/box-office', function ($a) {
    retail_require_enabled();
    $u = require_auth(); $p = retail_member($u);
    $ev = row("SELECT * FROM events WHERE id = ? AND status = 'published' AND ends_at > ?", [$a['eventId'], now_iso()]); if (!$ev) throw not_found('Event not found.');
    $ticketTypes = rows('SELECT id,name,price_cents,quantity_total,quantity_sold,quantity_held,per_order_limit,status,sales_start_at,sales_end_at FROM ticket_types WHERE event_id = ? ORDER BY created_at', [$ev['id']]);
    $shift = retail_open_shift($ev['id'], $p['id'], $u['id']);
    $pending = rows("SELECT o.id AS order_id,o.reference,o.total_cents,o.expires_at,i.tender_method,i.created_at FROM door_order_intents i JOIN orders o ON o.id=i.order_id WHERE i.event_id=? AND i.retail_partner_id=? AND (?=1 OR i.cashier_id=?) AND i.status='awaiting_tender' AND o.status='pending_payment' ORDER BY i.created_at", [$ev['id'],$p['id'],$p['role']==='owner'?1:0,$u['id']]);
    foreach ($pending as &$x) $x['accessKey'] = order_key($x['order_id']);
    $history = rows('SELECT id,cashier_id FROM door_shifts WHERE event_id=? AND retail_partner_id=? AND (?=1 OR cashier_id=?) ORDER BY opened_at DESC LIMIT 30', [$ev['id'],$p['id'],$p['role']==='owner'?1:0,$u['id']]);
    $shifts = array_map(fn($x) => door_shift_view($x['id']) + ['cashierName' => val('SELECT full_name FROM users WHERE id=?',[$x['cashier_id']])], $history);
    return ['event' => ['id'=>$ev['id'],'title'=>$ev['title'],'slug'=>$ev['slug'],'status'=>$ev['status'],'starts_at'=>$ev['starts_at'],'ends_at'=>$ev['ends_at'],'sales_start_at'=>$ev['sales_start_at'],'sales_end_at'=>$ev['sales_end_at']], 'ticketTypes'=>$ticketTypes,'shift'=>$shift,'pending'=>$pending,'shifts'=>$shifts,'retailChannels'=>json_decode((string)$p['sales_channels'],true)?:[]];
});
route('POST', '/api/retail/events/:eventId/door-shifts', function ($a) {
    retail_require_enabled();
    $u = require_auth(); $p = retail_member($u);
    if (!in_array('physical', json_decode((string) $p['sales_channels'], true) ?: [], true)) throw forbidden('This partner is not approved for in-store sales.');
    $b = check(body(), ['openingFloatCents' => R::int(['min' => 0, 'max' => 100000000])]);
    $ev = row("SELECT id,status FROM events WHERE id = ? AND status = 'published'", [$a['eventId']]);
    if (!$ev) throw not_found('Event not found.');
    $s = tx(function () use ($u, $p, $ev, $b) {
        if (retail_open_shift($ev['id'], $p['id'], $u['id'])) throw conflict('You already have an open shift for this event.', 'door_shift_open');
        $id = uuid();
        insert('door_shifts', ['id' => $id, 'event_id' => $ev['id'], 'retail_partner_id' => $p['id'], 'cashier_id' => $u['id'], 'opening_float_cents' => $b['openingFloatCents'],
            'counted_cash_cents' => null, 'counted_card_cents' => null, 'cash_variance_cents' => null, 'card_variance_cents' => null, 'status' => 'open', 'opened_at' => now_iso(), 'closed_at' => null]);
        return door_shift_view($id);
    });
    audit('retail_shift.opened', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'details' => ['partnerId' => $p['id'], 'shiftId' => $s['id']]]);
    return json_out(['shift' => $s], 201);
});
route('POST', '/api/retail/events/:eventId/door-shifts/:shiftId/close', function ($a) {
    retail_require_enabled();
    $u = require_auth();
    $p = retail_member($u);
    $b = check(body(), [
        'countedCashCents' => R::int(['min' => 0, 'max' => 100000000]),
        'countedCardCents' => R::int(['min' => 0, 'max' => 100000000]),
    ]);
    $s = tx(function () use ($u, $p, $a, $b) {
        $shift = row('SELECT * FROM door_shifts WHERE id = ? AND event_id = ? AND retail_partner_id = ?', [$a['shiftId'], $a['eventId'], $p['id']]);
        if (!$shift) throw not_found('Cash-up shift not found.');
        if ($shift['cashier_id'] !== $u['id'] && $p['role'] !== 'owner') throw forbidden('Only this cashier or the partner owner can close this shift.');
        if ($shift['status'] !== 'open') throw conflict('This shift is already closed.', 'door_shift_closed');

        $expired = rows("SELECT o.* FROM door_order_intents i JOIN orders o ON o.id = i.order_id
                          WHERE i.shift_id = ? AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' AND o.expires_at <= ?", [$shift['id'], now_iso()]);
        foreach ($expired as $order) {
            release_holds($order);
            q("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_payment'", [now_iso(), $order['id']]);
            q("UPDATE door_order_intents SET status = 'cancelled' WHERE order_id = ? AND status = 'awaiting_tender'", [$order['id']]);
        }
        if (val("SELECT 1 FROM door_order_intents i JOIN orders o ON o.id = i.order_id
                  WHERE i.shift_id = ? AND i.status = 'awaiting_tender' AND o.status = 'pending_payment' LIMIT 1", [$shift['id']])) {
            throw conflict('A sale is still waiting for payment. Resolve it before closing this shift.', 'door_pending_tender');
        }
        $view = door_shift_view($shift['id']);
        q("UPDATE door_shifts SET counted_cash_cents = ?, counted_card_cents = ?, cash_variance_cents = ?, card_variance_cents = ?, status = 'closed', closed_at = ?
            WHERE id = ? AND status = 'open'", [$b['countedCashCents'], $b['countedCardCents'], $b['countedCashCents'] - $view['expectedCashCents'], $b['countedCardCents'] - $view['expectedCardCents'], now_iso(), $shift['id']]);
        return door_shift_view($shift['id']);
    });
    audit('retail_shift.closed', ['actor' => $u, 'entityType' => 'event', 'entityId' => $a['eventId'], 'details' => ['partnerId' => $p['id'], 'shiftId' => $s['id'], 'cashVarianceCents' => $s['cashVarianceCents'], 'cardVarianceCents' => $s['cardVarianceCents']]]);
    return ['shift' => $s];
});
route('POST', '/api/retail/events/:eventId/door-orders', function ($a) {
    retail_require_enabled();
    $u = require_auth(); $p = retail_member($u);
    $ev = row("SELECT * FROM events WHERE id = ? AND status = 'published' AND ends_at > ?", [$a['eventId'], now_iso()]);
    if (!$ev) throw not_found('Event not found.');
    return door_create_order($u, $ev, $p);
});
route('POST', '/api/retail/events/:eventId/door-orders/:reference/tender', function ($a) {
    retail_require_enabled();
    $u = require_auth(); $p = retail_member($u);
    $intent = row('SELECT 1 FROM door_order_intents WHERE event_id = ? AND retail_partner_id = ? AND order_id = (SELECT id FROM orders WHERE reference = ?)', [$a['eventId'], $p['id'], $a['reference']]);
    if (!$intent) throw not_found('Door order not found.');
    return ['tender' => door_record_tender($u, $a['eventId'], $a['reference'])];
});
