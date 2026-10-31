<?php
// Server-authoritative, online-only door sales. Cash/external-card are
// recorded after the cashier confirms the physical tender succeeded.
declare(strict_types=1);

function door_receipt_ref(): string { return 'DR-' . random_code(8); }
function door_shift_view(string $shiftId): array
{
    $s = row('SELECT * FROM door_shifts WHERE id = ?', [$shiftId]);
    if (!$s) throw not_found('Cash-up shift not found.');
    $sales = row("SELECT COALESCE(SUM(CASE WHEN method = 'cash' THEN amount_cents ELSE 0 END),0) AS cash,
                         COALESCE(SUM(CASE WHEN method <> 'cash' THEN amount_cents ELSE 0 END),0) AS card
                    FROM door_tenders WHERE shift_id = ?", [$shiftId]);
    $refunds = row("SELECT COALESCE(SUM(CASE WHEN p.provider = 'door_cash' THEN r.amount_cents + r.fee_refund_cents ELSE 0 END),0) AS cash,
                           COALESCE(SUM(CASE WHEN p.provider <> 'door_cash' THEN r.amount_cents + r.fee_refund_cents ELSE 0 END),0) AS card
                      FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN door_tenders t ON t.payment_id = p.id
                     WHERE t.shift_id = ? AND r.status = 'completed'", [$shiftId]);
    // TicketRoom finance pays door-order refunds manually; the cashier did
    // not remove those amounts from the till or terminal settlement.
    $cashExpected = (int) $s['opening_float_cents'] + (int) $sales['cash'];
    $cardExpected = (int) $sales['card'];
    return ['id' => $s['id'], 'eventId' => $s['event_id'], 'cashierId' => $s['cashier_id'], 'status' => $s['status'],
        'openingFloatCents' => (int) $s['opening_float_cents'], 'cashSalesCents' => (int) $sales['cash'], 'cardSalesCents' => (int) $sales['card'],
        'cashRefundsCents' => (int) $refunds['cash'], 'cardRefundsCents' => (int) $refunds['card'],
        'expectedCashCents' => $cashExpected, 'expectedCardCents' => $cardExpected,
        'countedCashCents' => $s['counted_cash_cents'] === null ? null : (int) $s['counted_cash_cents'],
        'countedCardCents' => $s['counted_card_cents'] === null ? null : (int) $s['counted_card_cents'],
        'cashVarianceCents' => $s['cash_variance_cents'] === null ? null : (int) $s['cash_variance_cents'],
        'cardVarianceCents' => $s['card_variance_cents'] === null ? null : (int) $s['card_variance_cents'],
        'openedAt' => $s['opened_at'], 'closedAt' => $s['closed_at']];
}
function door_current_shift(string $eventId, string $cashierId): ?array
{
    $s = row("SELECT id FROM door_shifts WHERE event_id = ? AND retail_partner_id IS NULL AND cashier_id = ? AND status = 'open'", [$eventId, $cashierId]);
    return $s ? door_shift_view($s['id']) : null;
}
function door_create_order(array $u, array $event, ?array $retailPartner = null): Response
{
    limit('doororder', 30, 60, $u['id']);
    if ($event['status'] !== 'published') throw conflict('Door sales are available only for published events.', 'event_not_live');
    $b = check(body(), [
        'items' => items_rule(), 'idempotencyKey' => R::idemKey(), 'promoCode' => R::str(['optional' => true, 'max' => 40]),
        'tenderMethod' => R::oneOf(['online','cash','external_card','yoco','snapscan','titopay'], ['optional' => true]),
        'buyer' => R::obj(['fullName' => R::str(['min' => 2, 'max' => 120]), 'email' => R::email(), 'phone' => R::phone(['optional' => true])]),
    ]);
    $method = $b['tenderMethod'] ?? 'online';
    if ($retailPartner) {
        $channels = json_decode((string) ($retailPartner['sales_channels'] ?? '[]'), true) ?: [];
        if ($method === 'online' && !in_array('online', $channels, true)) throw forbidden('This partner is not approved for online selling.');
        if ($method !== 'online' && !in_array('physical', $channels, true)) throw forbidden('This partner is not approved for in-store sales.');
    }
    foreach ($b['items'] as $item) if (!val('SELECT 1 FROM ticket_types WHERE id = ? AND event_id = ?', [$item['ticketTypeId'], $event['id']])) throw not_found('Ticket type not found for this event.');
    $shift = null;
    if ($method !== 'online') {
        $shift = $retailPartner ? retail_open_shift($event['id'], $retailPartner['id'], $u['id']) : door_current_shift($event['id'], $u['id']);
        if (!$shift) throw conflict('Open a cashier shift before taking cash or recording an external payment.', 'door_shift_required');
    }
    $guest = ['fullName' => $b['buyer']['fullName'], 'email' => $b['buyer']['email']];
    if (!empty($b['buyer']['phone'])) $guest['phone'] = $b['buyer']['phone'];
    $buyer = tx(fn() => guest_buyer($guest));
    $created = create_order($buyer, ['eventSlug' => $event['slug'], 'items' => $b['items'], 'promoCode' => $b['promoCode'] ?? null, 'retailPartnerId' => $retailPartner['id'] ?? null,
        'idempotencyKey' => $b['idempotencyKey'], 'buyerPhone' => $b['buyer']['phone'] ?? null]);
    $order = $created['order'];
    if (!in_array($order['status'], ['pending_payment','paid'], true)) throw conflict('That Box Office order is no longer active. Start a new sale.', 'door_order_closed');
    $payment = null;
    $existingIntent = row('SELECT * FROM door_order_intents WHERE order_id = ?', [$order['id']]);
    $onlineAttempt = row("SELECT id FROM payments WHERE order_id = ? AND provider NOT LIKE 'door_%' AND status IN ('initiated','pending','confirmed') LIMIT 1", [$order['id']]);
    if ($order['status'] === 'pending_payment' && $existingIntent && $method === 'online') throw conflict('This order is already reserved for an in-person tender. Finish or let that reservation expire before starting online checkout.', 'door_order_assigned');
    if ($order['status'] === 'pending_payment' && $existingIntent && $existingIntent['tender_method'] !== $method) throw conflict('This order is already assigned to a different tender. Start a new sale instead.', 'door_order_assigned');
    if ($order['status'] === 'pending_payment' && $method !== 'online' && $onlineAttempt) throw conflict('Online checkout has already been started for this order. Do not collect a second payment; use that checkout or start a new sale after it is cancelled.', 'door_online_payment_started');
    if ($order['status'] === 'pending_payment' && $method !== 'online') {
        tx(function () use ($order, $event, $u, $shift, $method, $retailPartner) {
            $existing = row('SELECT * FROM door_order_intents WHERE order_id = ?', [$order['id']]);
            if ($existing) {
                if ($existing['cashier_id'] !== $u['id'] || $existing['shift_id'] !== $shift['id'] || $existing['tender_method'] !== $method) throw conflict('This order is already assigned to another tender. Start a new sale.', 'door_order_assigned');
                return;
            }
            $open = row("SELECT id FROM door_shifts WHERE id = ? AND event_id = ? AND cashier_id = ? AND status = 'open'", [$shift['id'], $event['id'], $u['id']]);
            $pending = row("SELECT * FROM orders WHERE id = ? AND event_id = ? AND status = 'pending_payment'", [$order['id'], $event['id']]);
            if (!$open || !$pending || to_unix($pending['expires_at']) <= microtime(true)) throw conflict('The order hold expired. Start a new sale.', 'door_order_closed');
            insert('door_order_intents', ['order_id' => $order['id'], 'event_id' => $event['id'], 'retail_partner_id' => $retailPartner['id'] ?? null, 'shift_id' => $shift['id'], 'cashier_id' => $u['id'], 'tender_method' => $method, 'status' => 'awaiting_tender', 'created_at' => now_iso()]);
        });
    } elseif ($order['status'] === 'pending_payment' && $method === 'online') {
        try { $payment = payment_start($order); }
        catch (AppError $e) {
            tx(function () use ($order) { $cur = row('SELECT * FROM orders WHERE id = ?', [$order['id']]); if ($cur && $cur['status'] === 'pending_payment') { release_holds($cur); q("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?", [now_iso(), $order['id']]); } });
            throw $e;
        }
    }
    audit('door_order.created', ['actor' => $u, 'entityType' => 'order', 'entityId' => $order['id'], 'organiserId' => $event['organiser_id'],
        'details' => ['reference' => $order['reference'], 'status' => $order['status'], 'tenderMethod' => $method, 'totalCents' => (int) $order['total_cents']]]);
    return json_out(['order' => ['reference' => $order['reference'], 'status' => $order['status'], 'totalCents' => (int) $order['total_cents'], 'expiresAt' => $order['expires_at']],
        'accessKey' => order_key($order['id']), 'payment' => $payment, 'tenderMethod' => $method,
        'shift' => $shift ? ['id' => $shift['id']] : null], $created['replay'] ? 200 : 201);
}
function door_record_tender(array $u, string $eventId, string $reference): array
{
    limit('doortender', 30, 60, $u['id']);
    $b = check(body(), ['cashReceivedCents' => R::int(['optional' => true, 'min' => 0, 'max' => 100000000]),
        'externalReference' => R::str(['optional' => true, 'min' => 2, 'max' => 100])]);
    return tx(function () use ($u, $eventId, $reference, $b) {
        $order = row('SELECT o.* FROM orders o WHERE o.reference = ? AND o.event_id = ?', [$reference, $eventId]);
        if (!$order) throw not_found('Door order not found.');
        $old = row('SELECT t.*, p.provider FROM door_tenders t JOIN payments p ON p.id = t.payment_id WHERE t.order_id = ?', [$order['id']]);
        if ($old) return ['receipt' => $old['receipt_reference'], 'method' => $old['method'], 'amountCents' => (int) $old['amount_cents'], 'changeCents' => (int) $old['change_cents'], 'replayed' => true];
        $intent = row('SELECT * FROM door_order_intents WHERE order_id = ? AND event_id = ? AND status = \'awaiting_tender\'', [$order['id'], $eventId]);
        if (!$intent) throw conflict('This order is not waiting for an in-person payment.', 'door_tender_not_expected');
        $partnerOwner = !empty($intent['retail_partner_id']) && (row("SELECT role FROM retail_partner_members WHERE partner_id = ? AND user_id = ?", [$intent['retail_partner_id'], $u['id']])['role'] ?? '') === 'owner';
        if (!empty($intent['retail_partner_id'])) {
            if ($intent['cashier_id'] !== $u['id'] && !$partnerOwner) throw forbidden('Only this cashier or the retail partner owner can record this tender.');
        } elseif ($intent['cashier_id'] !== $u['id'] && !in_array((row('SELECT role FROM organiser_members WHERE organiser_id = (SELECT organiser_id FROM events WHERE id = ?) AND user_id = ?', [$eventId, $u['id']])['role'] ?? ''), ['owner','manager'], true)) throw forbidden('Only the cashier who opened the sale or an event manager can record this tender.');
        $shift = row("SELECT * FROM door_shifts WHERE id = ? AND event_id = ? AND retail_partner_id IS ? AND status = 'open'", [$intent['shift_id'], $eventId, $intent['retail_partner_id']]);
        if (!$shift) throw conflict('The cashier shift is closed. A manager must review this pending sale.', 'door_shift_closed');
        if ($order['status'] !== 'pending_payment' || to_unix($order['expires_at']) <= microtime(true)) throw conflict('This order hold has expired. Do not take payment; start a new sale.', 'door_order_closed');
        if ((int) $order['total_cents'] <= 0) throw conflict('Free orders do not need a tender.', 'door_free_order');
        if ($intent['tender_method'] === 'cash') {
            $received = $b['cashReceivedCents'] ?? 0;
            if ($received < (int) $order['total_cents']) throw invalid(['cashReceivedCents' => 'Cash received must cover the exact amount due.']);
            $externalRef = null;
        } else {
            if (empty($b['externalReference'])) throw invalid(['externalReference' => 'Enter the successful card-terminal receipt or transaction reference.']);
            if (isset($b['cashReceivedCents'])) throw invalid(['cashReceivedCents' => 'Cash received is only used for cash tenders.']);
            $received = null; $externalRef = trim($b['externalReference']);
        }
        foreach (rows('SELECT ticket_type_id, quantity FROM order_items WHERE order_id = ?', [$order['id']]) as $item) {
            $stock = row('SELECT quantity_held FROM ticket_types WHERE id = ? AND event_id = ?', [$item['ticket_type_id'], $eventId]);
            if (!$stock || (int) $stock['quantity_held'] < (int) $item['quantity']) throw conflict('The ticket reservation is no longer valid. Do not take payment; start a new sale.', 'door_inventory_hold_lost');
        }
        $receipt = door_receipt_ref(); $pid = uuid(); $now = now_iso();
        $provider = 'door_' . $intent['tender_method'];
        $providerRef = $externalRef ?: $receipt;
        if (val('SELECT 1 FROM payments WHERE provider = ? AND provider_reference = ?', [$provider, $providerRef])) throw conflict('That terminal reference has already been recorded.', 'door_duplicate_terminal_reference');
        insert('payments', ['id' => $pid, 'order_id' => $order['id'], 'provider' => $provider, 'environment' => 'door', 'provider_reference' => $providerRef,
            'amount_cents' => (int) $order['total_cents'], 'status' => 'confirmed', 'refunded_cents' => 0, 'failure_reason' => null, 'created_at' => $now, 'updated_at' => $now, 'confirmed_at' => $now]);
        $cashAccount = "organiser:" . val('SELECT organiser_id FROM events WHERE id = ?', [$eventId]) . ":event:$eventId:door_" . ($intent['tender_method'] === 'cash' ? 'cash' : 'card');
        $net = (int) $order['subtotal_cents'] - (int) $order['discount_cents'];
        ledger_post('door_sale', $receipt, [[$cashAccount, (int) $order['total_cents']], [ledger_org_account($order), -($net - (int) $order['organiser_fee_cents'] - (int) $order['organiser_service_fee_cents'])],
            ['revenue:commission', -(int) $order['organiser_fee_cents']], ['revenue:service_fees', -(int) $order['organiser_service_fee_cents']], ['revenue:booking_fees', -((int) $order['total_cents'] - $net)], ...retail_ledger_lines($order)]);
        insert('door_tenders', ['id' => uuid(), 'order_id' => $order['id'], 'event_id' => $eventId, 'shift_id' => $shift['id'], 'cashier_id' => $u['id'], 'payment_id' => $pid,
            'method' => $intent['tender_method'], 'amount_cents' => (int) $order['total_cents'], 'cash_received_cents' => $received,
            'change_cents' => $received === null ? 0 : $received - (int) $order['total_cents'], 'external_reference' => $externalRef, 'receipt_reference' => $receipt, 'created_at' => $now]);
        q("UPDATE door_order_intents SET status = 'confirmed', confirmed_at = ? WHERE order_id = ?", [$now, $order['id']]);
        // Same fulfilment function as confirmed online checkout: one ticket per
        // item, sold quantity updated, private order link emailed after commit.
        fulfil_order($order['id']);
        audit('door_tender.recorded', ['actor' => $u, 'entityType' => 'order', 'entityId' => $order['id'], 'organiserId' => val('SELECT organiser_id FROM events WHERE id = ?', [$eventId]),
            'details' => ['receipt' => $receipt, 'method' => $intent['tender_method'], 'amountCents' => (int) $order['total_cents'], 'terminalReference' => $externalRef]]);
        return ['receipt' => $receipt, 'method' => $intent['tender_method'], 'amountCents' => (int) $order['total_cents'], 'changeCents' => $received === null ? 0 : $received - (int) $order['total_cents'], 'replayed' => false];
    });
}
