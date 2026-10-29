<?php
// Promote: an organiser pays once (R1600 by default, editable in Admin) to
// promote one event until it ends.
//
// While a promotion is active the organiser can send as many email campaigns
// to that event's opted-in buyers as they like (an hourly cap still stops
// floods, and consent and unsubscribe work exactly as for every campaign),
// send SMS campaigns when SMS is set up, ask TicketRoom to post the event on
// its socials, and see what each campaign did: messages sent, clicks on the
// campaign's own tracking link, and the tickets and revenue that came through it.
//
// Money: a promotion is paid by card through the same providers and test mode
// as ticket orders (its own payment records, promotion_payments), or straight
// from the organiser's available balance. Either way the ledger books it to
// revenue:promotions. A test-mode purchase is a TEST promotion: its money goes
// to test: accounts and never counts as revenue.
declare(strict_types=1);

const PROMO_HOURLY_LIMIT = 6;          // campaign sends per organiser per hour while promoting
const PROMO_SOCIAL_LINKS = 5;

function promo_price(): int { return max(100, (int) (settings_all()['fees']['promotionPriceCents'] ?? 160000)); }
// What one SMS segment costs, if the site has a figure for it (0: not set).
function promo_sms_cost(): int { return max(0, (int) cfg('promote.smsCostPerSegmentCents', 0)); }

// GSM-7 segments: 160 single, 153 per part when concatenated. Anything else
// (emoji and so on) is sent as UCS-2: 70 / 67. Same rule as the Node edition.
function promo_sms_segments(string $text): int
{
    $gsm = (bool) preg_match('/^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&\'()*+,\-.\/:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\\\\[~\]|€]*$/u', $text);
    [$single, $multi] = $gsm ? [160, 153] : [70, 67];
    $n = mb_strlen($text);
    return $n <= $single ? 1 : (int) ceil($n / $multi);
}

function promo_active(string $eventId): ?array
{
    // The event's own end counts (it may have been moved since the purchase).
    // A TEST package counts only while payments are in test mode: once real
    // money is on it unlocks nothing (no real SMS on practice money).
    return row("SELECT p.* FROM event_promotions p JOIN events e ON e.id = p.event_id WHERE p.event_id = ? AND p.status = 'active' AND e.ends_at > ? AND (p.test = 0 OR ? = 1) LIMIT 1",
        [$eventId, now_iso(), pay_test() ? 1 : 0]);
}
// The single-event campaign this promotion covers, if any.
function promo_for_campaign(array $camp): ?array
{
    $aud = is_array($camp['audience'] ?? null) ? $camp['audience'] : (json_decode((string) ($camp['audience'] ?? ''), true) ?: []);
    $ids = array_values(array_unique((array) ($aud['eventIds'] ?? [])));
    if (count($ids) !== 1) return null;
    $p = promo_active($ids[0]);
    return $p && $p['organiser_id'] === $camp['organiser_id'] ? $p : null;
}

function promo_view(?array $p): ?array
{
    if (!$p) return null;
    $p['test'] = (int) $p['test'] === 1;
    $p['social_request'] = $p['social_request'] ? json_decode((string) $p['social_request'], true) : null;
    $p['social_links'] = $p['social_links'] ? json_decode((string) $p['social_links'], true) : [];
    return $p;
}

// Promotions end with their event. A purchase nobody finished lapses after a day.
function promo_expire(): int
{
    $now = now_iso();
    // A promotion follows its event: moved dates move its end too.
    q("UPDATE event_promotions SET ends_at = (SELECT ends_at FROM events WHERE id = event_promotions.event_id) WHERE status = 'active'
        AND ends_at <> (SELECT ends_at FROM events WHERE id = event_promotions.event_id)");
    $n = affected("UPDATE event_promotions SET status = 'ended', updated_at = ? WHERE status = 'active' AND ends_at <= ?", [$now, $now]);
    foreach (rows("SELECT id FROM event_promotions WHERE status = 'pending_payment' AND (created_at < ? OR ends_at <= ?)", [iso_in(-86400), $now]) as $r) {
        tx(function () use ($r, $now) {
            if (affected("UPDATE event_promotions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending_payment'", [$now, $r['id']])) {
                q("UPDATE promotion_payments SET status = 'cancelled', updated_at = ? WHERE promotion_id = ? AND status IN ('initiated','pending')", [$now, $r['id']]);
            }
        });
        $n++;
    }
    return $n;
}

// Why this event can't be promoted right now, or null if it can.
function promo_blocked(array $org, array $event): ?array
{
    if (($org['status'] ?? '') !== 'approved') return ['organiser_not_approved', 'Your organiser account must be approved before you can promote an event.'];
    if (!in_array($event['status'], ['published', 'pending_approval'], true)) return ['event_not_promotable', 'Only published events, or events waiting to be published, can be promoted.'];
    if (to_unix($event['ends_at']) <= microtime(true)) return ['event_over', 'This event has ended.'];
    if (promo_active($event['id'])) return ['already_promoted', 'This event is already promoted until it ends.'];
    // The verification (FICA) rules that let the event be listed still hold:
    // approved for a published event, submitted for one waiting to be published.
    try { kyc_require_for_event($event, $event['status'] === 'published' ? 'approved' : 'submitted'); }
    catch (AppError $e) { return ['verification_required', $e->getMessage()]; }
    return null;
}

// The unpaid promotion for this event, made if there isn't one yet.
function promo_open(array $u, array $org, array $event): array
{
    return tx(function () use ($u, $org, $event) {
        $b = promo_blocked($org, $event);
        if ($b) throw conflict($b[1], $b[0]);
        $p = row("SELECT * FROM event_promotions WHERE event_id = ? AND status = 'pending_payment'", [$event['id']]);
        if ($p) return $p;
        $now = now_iso();
        return insert('event_promotions', ['id' => uuid(), 'reference' => reference('PR'), 'event_id' => $event['id'], 'organiser_id' => $org['id'], 'status' => 'pending_payment',
            'price_cents' => promo_price(), 'test' => 0, 'created_by' => $u['id'], 'ends_at' => $event['ends_at'], 'created_at' => $now, 'updated_at' => $now]);
    });
}

function promo_return_url(array $promo): string { return '/organisers#/events/' . $promo['event_id'] . '/promote'; }

// Card: opens the provider's payment page, exactly like a ticket order.
function promo_payment_start(array $promo, array $u): array
{
    if (!pay_ready()) throw new AppError(503, 'payments_not_configured', 'Card payments are not switched on yet. Pay from your balance, or ask TicketRoom.');
    $now = now_iso();
    q("UPDATE promotion_payments SET status = 'cancelled', updated_at = ? WHERE promotion_id = ? AND status IN ('initiated','pending')", [$now, $promo['id']]);
    $p = insert('promotion_payments', ['id' => uuid(), 'promotion_id' => $promo['id'], 'provider' => pay_provider(), 'environment' => pay_mode(), 'amount_cents' => (int) $promo['price_cents'],
        'status' => 'initiated', 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now]);
    // A test-mode payment makes this a TEST promotion, start to finish.
    q('UPDATE event_promotions SET test = ?, updated_at = ? WHERE id = ?', [pay_test() ? 1 : 0, $now, $promo['id']]);
    $back = base_url() . promo_return_url($promo);
    try {
        if ($p['provider'] === 'yoco') {
            $c = yoco_checkout($p, ['reference' => $promo['reference']], $back, $back);
            q("UPDATE promotion_payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ?", [$c['reference'], now_iso(), $p['id']]);
            return ['id' => $p['id'], 'provider' => 'yoco', 'redirectUrl' => $c['redirectUrl']];
        }
        if ($p['provider'] === 'peach') {
            $c = peach_checkout($p, ['reference' => $promo['reference'], 'item_name' => "TicketRoom Promote {$promo['reference']}"], $back);
            q("UPDATE promotion_payments SET provider_reference = ?, provider_payment_id = ?, checkout_url = ?, status = 'pending', updated_at = ? WHERE id = ?", [$p['id'], $c['paymentId'], $c['redirectUrl'], now_iso(), $p['id']]);
            return ['id' => $p['id'], 'provider' => 'peach', 'redirectUrl' => $c['redirectUrl']];
        }
        q("UPDATE promotion_payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ?", [$p['id'], now_iso(), $p['id']]);
        return ['id' => $p['id'], 'provider' => $p['provider'], 'redirectUrl' => '/pay?p=' . $p['id'] . ($p['provider'] === 'sandbox' ? '&m=sandbox' : '') . '&k=' . rawurlencode(sign_link(['p' => $p['id']], 3600))];
    } catch (Throwable $e) {
        q("UPDATE promotion_payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr('checkout: ' . $e->getMessage(), 0, 240), now_iso(), $p['id']]);
        error_log('[promote] checkout failed: ' . $e->getMessage());
        throw pay_error('provider_unavailable', 'We could not reach the payment provider. Nothing was charged. Please try again in a moment.');
    }
}

// Seamless cashout: the price comes off the organiser's available balance
// (money from events that are over and past their hold). One transaction:
// the balance is checked and the ledger written together, so two purchases
// or a payout at the same moment can't spend the same rand twice.
function promo_pay_from_balance(array $u, array $org, array $event): array
{
    return tx(function () use ($u, $org, $event) {
        // Spending the balance follows the payout rules: a verified organiser and bank account.
        try { kyc_require_for_payout($org['id']); }
        catch (AppError $e) { throw conflict('Paying from your balance needs the same verification as a payout. ' . $e->getMessage() . ' Or pay by card.', $e->errCode, $e->details); }
        $promo = promo_open($u, $org, $event);
        $price = (int) $promo['price_cents'];
        $money = organiser_money(row('SELECT * FROM organisers WHERE id = ?', [$org['id']]));
        if ($money['availableCents'] < $price) {
            throw conflict('Your available balance is ' . format_zar((int) $money['availableCents']) . ', which is not enough. Pay by card instead.', 'insufficient_balance');
        }
        $now = now_iso();
        q("UPDATE promotion_payments SET status = 'cancelled', updated_at = ? WHERE promotion_id = ? AND status IN ('initiated','pending')", [$now, $promo['id']]);
        $id = uuid();
        insert('promotion_payments', ['id' => $id, 'promotion_id' => $promo['id'], 'provider' => 'balance', 'environment' => 'live', 'provider_reference' => $id, 'amount_cents' => $price,
            'status' => 'confirmed', 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now, 'confirmed_at' => $now]);
        ledger_post('promotion', $promo['reference'], [["organiser:{$org['id']}:deductions", $price], ['revenue:promotions', -$price]]);
        audit('promotion.paid_from_balance', ['actor' => $u, 'entityType' => 'promotion', 'entityId' => $promo['id'], 'organiserId' => $org['id'],
            'details' => ['reference' => $promo['reference'], 'amount' => $price, 'availableBefore' => (int) $money['availableCents']]]);
        q('UPDATE event_promotions SET test = 0 WHERE id = ?', [$promo['id']]);
        promo_activate(row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]), 'balance');
        return row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]);
    });
}

// A provider's answer for a promotion payment (from payment_apply, so it
// arrives through the same webhook, ITN, status check or sandbox page).
function promo_payment_apply(array $pp, string $outcome, int $amountCents): string
{
    if ($outcome === 'paid') {
        if (in_array($pp['status'], ['confirmed', 'refunded'], true)) return 'duplicate';
        if ($amountCents !== (int) $pp['amount_cents']) {
            q("UPDATE promotion_payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", ["amount mismatch: provider $amountCents, expected {$pp['amount_cents']}", now_iso(), $pp['id']]);
            audit('payment.amount_mismatch', ['entityType' => 'promotion_payment', 'entityId' => $pp['id'], 'details' => ['providerAmount' => $amountCents, 'expected' => (int) $pp['amount_cents']]]);
            return 'mismatch';
        }
        $now = now_iso();
        $test = $pp['environment'] !== 'live';
        q("UPDATE promotion_payments SET status = 'confirmed', confirmed_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?", [$now, $now, $pp['id']]);
        $promo = row('SELECT * FROM event_promotions WHERE id = ?', [$pp['promotion_id']]);
        ledger_post('promotion', $promo['reference'], [['provider:' . $pp['provider'], (int) $pp['amount_cents']], ['revenue:promotions', -(int) $pp['amount_cents']]], $test);
        $event = row('SELECT * FROM events WHERE id = ?', [$promo['event_id']]);
        $running = to_unix($event['ends_at']) > microtime(true) && !in_array($event['status'], ['cancelled', 'suspended'], true);
        $other = val("SELECT id FROM event_promotions WHERE event_id = ? AND status = 'active' AND id <> ?", [$promo['event_id'], $promo['id']]);
        if (in_array($promo['status'], ['pending_payment', 'cancelled'], true) && $running && !$other) {
            // A lapsed purchase paid late wins over a newer unpaid one.
            q("UPDATE event_promotions SET status = 'cancelled', updated_at = ? WHERE event_id = ? AND status = 'pending_payment' AND id <> ?", [$now, $promo['event_id'], $promo['id']]);
            q('UPDATE event_promotions SET test = ? WHERE id = ?', [$test ? 1 : 0, $promo['id']]);
            promo_activate(row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]), 'card');
        } else {
            // Paid twice, or after the event: the money goes straight back.
            audit('promotion.payment_unmatched', ['entityType' => 'promotion_payment', 'entityId' => $pp['id'], 'details' => ['promotion' => $promo['reference'], 'status' => $promo['status']]]);
            $GLOBALS['TR_AFTER_COMMIT'][] = fn() => promo_payment_reverse($pp['id']);
        }
        audit('payment.confirmed', ['entityType' => 'promotion_payment', 'entityId' => $pp['id'], 'details' => ['promotion' => $promo['reference'], 'amount' => (int) $pp['amount_cents'], 'test' => $test]]);
        return 'confirmed';
    }
    if ($outcome === 'failed' || $outcome === 'cancelled') {
        if (in_array($pp['status'], ['confirmed', 'refunded'], true)) return 'ignored';
        q('UPDATE promotion_payments SET status = ?, updated_at = ? WHERE id = ?', [$outcome, now_iso(), $pp['id']]);
        return $outcome;
    }
    return 'ignored';
}

function promo_activate(array $promo, string $paidWith): void
{
    $event = row('SELECT * FROM events WHERE id = ?', [$promo['event_id']]);
    $now = now_iso();
    q("UPDATE event_promotions SET status = 'active', paid_with = ?, paid_at = ?, ends_at = ?, updated_at = ? WHERE id = ?", [$paidWith, $now, $event['ends_at'], $now, $promo['id']]);
    $promo = row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]);
    $buyer = row('SELECT id, email, full_name FROM users WHERE id = ?', [$promo['created_by']]);
    if ($buyer) outbox_enqueue(['to' => $buyer['email'], 'userId' => $buyer['id']] + tpl('promotionConfirmed', ['name' => $buyer['full_name'], 'promotion' => $promo, 'event' => $event,
        'organiser' => (string) val('SELECT name FROM organisers WHERE id = ?', [$promo['organiser_id']])]));
    audit('promotion.activated', ['entityType' => 'promotion', 'entityId' => $promo['id'], 'organiserId' => $promo['organiser_id'],
        'details' => ['reference' => $promo['reference'], 'event' => $event['id'], 'paidWith' => $paidWith, 'amount' => (int) $promo['price_cents'], 'test' => (int) $promo['test'] === 1]]);
}

// A card payment that matched no open promotion goes back at once (sandbox
// and Yoco). PayFast refunds are done in the PayFast dashboard, so finance
// is told through the payment's note and the audit log.
function promo_payment_reverse(string $ppId): void
{
    try {
        $pp = row('SELECT * FROM promotion_payments WHERE id = ?', [$ppId]);
        if (!$pp || $pp['status'] !== 'confirmed') return;
        if ($pp['provider'] === 'payfast') {
            q('UPDATE promotion_payments SET failure_reason = ?, updated_at = ? WHERE id = ?', ['paid twice or after the event: refund it in the PayFast dashboard', now_iso(), $pp['id']]);
            return;
        }
        $ref = $pp['provider'] === 'yoco' ? yoco_refund($pp, (int) $pp['amount_cents'], 'reverse-' . $pp['id']) : 'SANDBOX-' . $pp['id'];
        tx(function () use ($pp, $ref) {
            $promo = row('SELECT * FROM event_promotions WHERE id = ?', [$pp['promotion_id']]);
            q("UPDATE promotion_payments SET status = 'refunded', refunded_cents = amount_cents, failure_reason = ?, updated_at = ? WHERE id = ?", ["returned: $ref", now_iso(), $pp['id']]);
            ledger_post('promotion_refund', $promo['reference'] . ':' . substr($pp['id'], 0, 8), [['revenue:promotions', (int) $pp['amount_cents']], ['provider:' . $pp['provider'], -(int) $pp['amount_cents']]], $pp['environment'] !== 'live');
            audit('promotion.payment_returned', ['entityType' => 'promotion_payment', 'entityId' => $pp['id'], 'details' => ['providerReference' => $ref]]);
        });
    } catch (Throwable $e) {
        error_log("[promote] reverse $ppId: " . $e->getMessage());
    }
}

// ============================================================== refunds
// TicketRoom finance refunds a promotion when its event is cancelled. Card
// payments go back through the provider (sandbox at once, Yoco by API,
// PayFast in its dashboard and then recorded here); a balance payment goes
// back to the balance.
function promo_refund(array $promo, array $actor, string $reason): array
{
    $out = tx(function () use ($promo, $actor, $reason) {
        $promo = row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]);
        if (!in_array($promo['status'], ['active', 'ended'], true) || !$promo['paid_at']) throw conflict('Only a paid promotion can be refunded.', 'promotion_not_refundable');
        if (in_array($promo['refund_status'], ['processing', 'manual_pending', 'completed'], true)) throw conflict('A refund for this promotion is already in progress.', 'refund_in_progress');
        $event = row('SELECT status, cancellation_requested_at FROM events WHERE id = ?', [$promo['event_id']]);
        if ($event['status'] !== 'cancelled' && !$event['cancellation_requested_at']) throw conflict('Promotions are refunded when their event is cancelled.', 'event_not_cancelled');
        $pp = row("SELECT * FROM promotion_payments WHERE promotion_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1", [$promo['id']]);
        if (!$pp) throw conflict('This promotion has no payment to refund.', 'promotion_not_refundable');
        // A retry after a failure keeps its reference: the provider sees the same
        // idempotency key, so the refund can never be paid twice.
        $ref = $promo['refund_status'] === 'failed' && $promo['refund_reference'] ? (string) $promo['refund_reference'] : reference('RF');
        q("UPDATE event_promotions SET refund_status = 'processing', refund_reference = ?, refund_reason = ?, refund_failure = NULL, refunded_by = ?, updated_at = ? WHERE id = ?",
            [$ref, $reason, $actor['id'], now_iso(), $promo['id']]);
        audit('promotion.refund_requested', ['actor' => $actor, 'entityType' => 'promotion', 'entityId' => $promo['id'], 'organiserId' => $promo['organiser_id'],
            'details' => ['reference' => $ref, 'amount' => (int) $pp['amount_cents'], 'provider' => $pp['provider']]]);
        if ($pp['provider'] === 'balance' || $pp['provider'] === 'sandbox') { promo_refund_complete($promo['id'], strtoupper($pp['provider']) . '-' . $ref, $actor); return null; }
        if ($pp['provider'] === 'payfast') { q("UPDATE event_promotions SET refund_status = 'manual_pending', updated_at = ? WHERE id = ?", [now_iso(), $promo['id']]); return null; }
        return [$pp, $ref];
    });
    if ($out) {
        [$pp, $ref] = $out;
        try {
            $providerRef = yoco_refund($pp, (int) $pp['amount_cents'], $ref);
            tx(fn() => promo_refund_complete($promo['id'], $providerRef, $actor));
        } catch (Throwable $e) {
            q("UPDATE event_promotions SET refund_status = 'failed', refund_failure = ?, updated_at = ? WHERE id = ?", [substr($e->getMessage(), 0, 240), now_iso(), $promo['id']]);
            audit('promotion.refund_failed', ['actor' => $actor, 'entityType' => 'promotion', 'entityId' => $promo['id'], 'details' => ['error' => substr($e->getMessage(), 0, 120)]]);
        }
    }
    return row('SELECT * FROM event_promotions WHERE id = ?', [$promo['id']]);
}

function promo_refund_complete(string $promoId, string $providerRef, ?array $actor): void
{
    $promo = row('SELECT * FROM event_promotions WHERE id = ?', [$promoId]);
    if ($promo['refund_status'] === 'completed') return;
    $pp = row("SELECT * FROM promotion_payments WHERE promotion_id = ? AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1", [$promoId]);
    if (!$pp) throw conflict('This promotion has no payment to refund.', 'promotion_not_refundable');
    $now = now_iso();
    $amt = (int) $pp['amount_cents'];
    q("UPDATE promotion_payments SET status = 'refunded', refunded_cents = amount_cents, updated_at = ? WHERE id = ?", [$now, $pp['id']]);
    q("UPDATE event_promotions SET status = 'refunded', refund_status = 'completed', refund_provider_reference = ?, refunded_at = ?, updated_at = ? WHERE id = ?", [$providerRef, $now, $now, $promoId]);
    if ($pp['provider'] === 'balance') ledger_post('promotion_refund', (string) $promo['refund_reference'], [["organiser:{$promo['organiser_id']}:deductions", -$amt], ['revenue:promotions', $amt]]);
    else ledger_post('promotion_refund', (string) $promo['refund_reference'], [['revenue:promotions', $amt], ['provider:' . $pp['provider'], -$amt]], $pp['environment'] !== 'live');
    $buyer = row('SELECT id, email, full_name FROM users WHERE id = ?', [$promo['created_by']]);
    $event = row('SELECT * FROM events WHERE id = ?', [$promo['event_id']]);
    if ($buyer) outbox_enqueue(['to' => $buyer['email'], 'userId' => $buyer['id']] + tpl('promotionRefunded', ['name' => $buyer['full_name'], 'promotion' => $promo, 'event' => $event, 'amountCents' => $amt, 'toBalance' => $pp['provider'] === 'balance']));
    audit('promotion.refunded', ['actor' => $actor, 'entityType' => 'promotion', 'entityId' => $promoId, 'organiserId' => $promo['organiser_id'], 'details' => ['amount' => $amt, 'providerReference' => $providerRef]]);
}

// ============================================================== analytics
// What the promotion's campaigns did. Opens are not tracked (no tracking
// pixels), so none are reported. Clicks are counted on each campaign's own
// tracking link; tickets and revenue are orders that came through that link.
// Test orders are counted apart and never added to revenue.
function promo_analytics(array $event, array $promo): array
{
    $paid = "('paid','partially_refunded','refunded')";
    $camps = rows("SELECT c.id, c.name, c.channel, c.subject, c.status, c.sent_at, c.scheduled_at, c.recipients_count, c.estimated_cost_cents, l.code, l.clicks,
                          (SELECT count(*) FROM message_outbox m WHERE m.campaign_id = c.id AND m.status = 'sent') AS delivered,
                          (SELECT count(*) FROM message_outbox m WHERE m.campaign_id = c.id AND m.status IN ('failed','suppressed')) AS not_delivered,
                          (SELECT count(*) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN $paid AND o.test = 0) AS orders,
                          (SELECT COALESCE(SUM(oi.quantity),0) FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.tracking_link_id = l.id AND o.status IN $paid AND o.test = 0) AS tickets,
                          (SELECT COALESCE(SUM(o.subtotal_cents - o.discount_cents),0) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN $paid AND o.test = 0) AS revenue_cents,
                          (SELECT count(*) FROM orders o WHERE o.tracking_link_id = l.id AND o.status IN $paid AND o.test = 1) AS test_orders
                     FROM campaigns c LEFT JOIN tracking_links l ON l.campaign_id = c.id
                    WHERE c.promotion_id = ? ORDER BY COALESCE(c.sent_at, c.created_at) DESC", [$promo['id']]);
    foreach ($camps as &$c) {
        foreach (['recipients_count', 'estimated_cost_cents', 'clicks', 'delivered', 'not_delivered', 'orders', 'tickets', 'revenue_cents', 'test_orders'] as $k) $c[$k] = (int) ($c[$k] ?? 0);
        $c['url'] = $c['code'] ? org_link_url($event, $c['code']) : null;
    }
    unset($c);
    $sent = array_values(array_filter($camps, fn($c) => $c['status'] === 'sent'));
    $sum = fn(string $k, ?string $ch = null) => array_sum(array_map(fn($c) => $c[$k], array_filter($sent, fn($c) => $ch === null || $c['channel'] === $ch)));

    // Last 30 days, every day present (UTC dates, like the event analytics).
    $since = gmdate('Y-m-d', time() - 29 * 86400);
    $msgs = []; $tix = []; $rev = []; $all = [];
    foreach (rows("SELECT substr(m.sent_at,1,10) AS d, count(*) AS n FROM message_outbox m JOIN campaigns c ON c.id = m.campaign_id
                    WHERE c.promotion_id = ? AND m.status = 'sent' AND m.sent_at >= ? GROUP BY 1", [$promo['id'], $since]) as $r) $msgs[$r['d']] = (int) $r['n'];
    foreach (rows("SELECT substr(o.paid_at,1,10) AS d, SUM(oi.quantity) AS n, SUM(oi.quantity * 0) AS z FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    JOIN tracking_links l ON l.id = o.tracking_link_id JOIN campaigns c ON c.id = l.campaign_id
                    WHERE c.promotion_id = ? AND o.status IN $paid AND o.test = 0 AND o.paid_at >= ? GROUP BY 1", [$promo['id'], $since]) as $r) $tix[$r['d']] = (int) $r['n'];
    foreach (rows("SELECT substr(o.paid_at,1,10) AS d, SUM(o.subtotal_cents - o.discount_cents) AS c FROM orders o
                    JOIN tracking_links l ON l.id = o.tracking_link_id JOIN campaigns c ON c.id = l.campaign_id
                    WHERE c.promotion_id = ? AND o.status IN $paid AND o.test = 0 AND o.paid_at >= ? GROUP BY 1", [$promo['id'], $since]) as $r) $rev[$r['d']] = (int) $r['c'];
    foreach (rows("SELECT substr(o.paid_at,1,10) AS d, SUM(oi.quantity) AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id
                    WHERE o.event_id = ? AND o.status IN $paid AND o.test = 0 AND o.paid_at >= ? GROUP BY 1", [$event['id'], $since]) as $r) $all[$r['d']] = (int) $r['n'];
    $daily = [];
    for ($i = 29; $i >= 0; $i--) {
        $d = gmdate('Y-m-d', time() - $i * 86400);
        $daily[] = ['day' => $d, 'messages' => $msgs[$d] ?? 0, 'campaignTickets' => $tix[$d] ?? 0, 'campaignRevenueCents' => $rev[$d] ?? 0, 'allTickets' => $all[$d] ?? 0];
    }
    return [
        'totals' => [
            'campaignsSent' => count($sent), 'emailsSent' => $sum('delivered', 'email'), 'smsSent' => $sum('delivered', 'sms'), 'notDelivered' => $sum('not_delivered'),
            'recipients' => $sum('recipients_count'), 'clicks' => $sum('clicks'), 'orders' => $sum('orders'), 'tickets' => $sum('tickets'), 'revenueCents' => $sum('revenue_cents'),
            'testOrders' => $sum('test_orders'), 'opens' => null,
        ],
        'opensTracked' => false,
        'campaigns' => $camps,
        'daily' => $daily,
    ];
}

// ============================================================== admin
function promo_admin_row(array $p): array
{
    $p = promo_view($p);
    $p['payment_provider'] = val("SELECT provider FROM promotion_payments WHERE promotion_id = ? AND status IN ('confirmed','refunded') ORDER BY confirmed_at DESC LIMIT 1", [$p['id']]);
    return $p;
}
function promo_revenue(): array
{
    return [
        'liveCents' => -ledger_balance('revenue:promotions'),
        'testCents' => -ledger_balance('test:revenue:promotions'),
        'live' => (int) val("SELECT count(*) FROM event_promotions WHERE test = 0 AND status IN ('active','ended')"),
        'test' => (int) val("SELECT count(*) FROM event_promotions WHERE test = 1 AND status IN ('active','ended')"),
        'active' => (int) val("SELECT count(*) FROM event_promotions WHERE status = 'active'"),
        'socialQueue' => (int) val("SELECT count(*) FROM event_promotions WHERE status = 'active' AND social_status IN ('requested','scheduled')"),
    ];
}
