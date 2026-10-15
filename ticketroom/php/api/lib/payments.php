<?php
// Card payments, refunds, organiser payouts and the money ledger.
//
// The rule everything here follows: money is only ever "in" when the payment
// provider says so, through a signed notification (webhook / ITN) or a direct
// status check from this server. The buyer's browser coming back from the
// payment page proves nothing and changes nothing.
//
// Providers (chosen and set up in Admin portal → Integrations):
//   Sandbox TicketRoom's own practice payment page: no provider account,
//           nothing real. Always test mode.
//   Yoco    Checkout API: hosted payment page, signed webhooks, refunds by API.
//   PayFast hosted form + ITN; refunds are done in the PayFast dashboard and
//           recorded here ("manual"), because PayFast's refund API needs a
//           separate approval from PayFast.
//
// Every confirmed payment, completed refund and paid payout is written to an
// append-only double-entry ledger in the same transaction, so the books
// always balance and every rand is accounted for.
//
// Test mode (the sandbox, Yoco test keys, PayFast's sandbox) is a separate
// world: its orders are test orders, their tickets never open a gate, and
// their money is booked to "test:" ledger accounts that never reach an
// organiser's balance, a payout or the sales figures.
declare(strict_types=1);

// ============================================================== settings
function pay_provider(): string
{
    $p = (string) cfg('payments.provider', 'none');
    return in_array($p, ['sandbox', 'yoco', 'payfast'], true) ? $p : 'none';
}
// The sandbox is never live.
function pay_mode(): string { return pay_provider() !== 'sandbox' && cfg('payments.mode', 'test') === 'live' ? 'live' : 'test'; }
function pay_test(): bool { return pay_mode() !== 'live'; }
// Paid tickets can be sold once a provider is fully set up.
function pay_ready(): bool
{
    return match (pay_provider()) {
        'sandbox' => true,
        'yoco' => (string) cfg('payments.yocoSecretKey', '') !== '' && (string) cfg('payments.yocoWebhookSecret', '') !== '',
        'payfast' => (string) cfg('payments.payfastMerchantId', '') !== '' && (string) cfg('payments.payfastMerchantKey', '') !== '',
        default => false,
    };
}
function yoco_base(): string { return rtrim((string) cfg('payments.yocoApiBase', 'https://payments.yoco.com'), '/'); }
function payfast_host(): string
{
    $override = (string) cfg('payments.payfastBase', '');
    if ($override !== '') return rtrim($override, '/');
    return pay_mode() === 'live' ? 'https://www.payfast.co.za' : 'https://sandbox.payfast.co.za';
}
function pay_error(string $code, string $message): AppError { return new AppError(502, $code, $message); }

// ============================================================== Yoco
function yoco_call(string $method, string $path, ?array $json = null, ?string $idem = null): array
{
    $headers = ['Authorization' => 'Bearer ' . cfg('payments.yocoSecretKey'), 'Accept' => 'application/json'];
    if ($json !== null) $headers['Content-Type'] = 'application/json';
    if ($idem) $headers['Idempotency-Key'] = $idem;
    return http_request($method, yoco_base() . $path, $headers, $json === null ? null : json_encode($json, JSON_UNESCAPED_SLASHES));
}
function yoco_checkout(array $payment, array $order, string $returnUrl, string $cancelUrl): array
{
    $r = yoco_call('POST', '/api/checkouts', ['amount' => (int) $payment['amount_cents'], 'currency' => 'ZAR', 'successUrl' => $returnUrl, 'cancelUrl' => $cancelUrl, 'failureUrl' => $returnUrl,
        'metadata' => ['ticketroomPaymentId' => $payment['id'], 'orderReference' => $order['reference']]], $payment['id']);
    if ($r['status'] >= 300 || empty($r['json']['id']) || empty($r['json']['redirectUrl'])) throw pay_error('provider_refused', "Yoco did not open a payment page (HTTP {$r['status']}).");
    return ['reference' => $r['json']['id'], 'redirectUrl' => $r['json']['redirectUrl']];
}
const YOCO_STATUS = ['completed' => 'paid', 'succeeded' => 'paid', 'failed' => 'failed', 'cancelled' => 'cancelled', 'expired' => 'cancelled'];
function yoco_status(string $checkoutId): array
{
    $r = yoco_call('GET', '/api/checkouts/' . rawurlencode($checkoutId));
    if ($r['status'] !== 200) return ['status' => 'unknown'];
    return ['status' => YOCO_STATUS[$r['json']['status'] ?? ''] ?? 'pending', 'amountCents' => (int) ($r['json']['amount'] ?? 0)];
}
// Standard Webhooks signature: base64 HMAC-SHA256 over "id.timestamp.body",
// keyed with the base64 secret after "whsec_". Old or replayed messages fail.
function yoco_verify(string $raw, array $h): array
{
    $id = $h['webhook-id'] ?? ''; $ts = (int) ($h['webhook-timestamp'] ?? 0); $sigs = (string) ($h['webhook-signature'] ?? '');
    if ($id === '' || !$ts || $sigs === '') throw bad('Missing webhook signature.');
    if (abs(time() - $ts) > 300) throw bad('Webhook timestamp too old.');
    $secret = base64_decode(preg_replace('/^whsec_/', '', (string) cfg('payments.yocoWebhookSecret', '')), true);
    if (!$secret) throw bad('Webhook secret not set.');
    $expected = base64_encode(hash_hmac('sha256', "$id.$ts.$raw", $secret, true));
    $ok = false;
    foreach (explode(' ', $sigs) as $part) { $sig = explode(',', $part, 2)[1] ?? ''; if ($sig !== '' && hash_equals($expected, $sig)) $ok = true; }
    if (!$ok) throw bad('Webhook signature does not match.');
    $b = json_decode($raw, true) ?: [];
    $p = $b['payload'] ?? [];
    $type = (string) ($b['type'] ?? '');
    return ['id' => (string) ($b['id'] ?? $id), 'outcome' => $type === 'payment.succeeded' ? 'paid' : ($type === 'payment.failed' ? 'failed' : null),
        'reference' => (string) ($p['metadata']['checkoutId'] ?? ''), 'amountCents' => (int) ($p['amount'] ?? 0)];
}
function yoco_refund(array $payment, int $cents, string $idem): string
{
    $r = yoco_call('POST', '/api/checkouts/' . rawurlencode((string) $payment['provider_reference']) . '/refund', ['amount' => $cents], $idem);
    if ($r['status'] >= 300) throw pay_error('provider_refused', 'Yoco refused the refund: ' . substr((string) ($r['json']['description'] ?? $r['json']['message'] ?? "HTTP {$r['status']}"), 0, 160));
    return (string) ($r['json']['refundId'] ?? $r['json']['id'] ?? $idem);
}
// Registers TicketRoom's notification address with Yoco and returns the signing secret.
function yoco_register_webhook(): string
{
    $r = yoco_call('POST', '/api/webhooks', ['name' => 'TicketRoom ' . pay_mode(), 'url' => base_url() . '/api/webhooks/yoco']);
    if ($r['status'] >= 300 || empty($r['json']['secret'])) throw pay_error('provider_refused', 'Yoco did not accept the notification address' . (in_array($r['status'], [401, 403], true) ? ': the secret key was rejected.' : " (HTTP {$r['status']})."));
    return (string) $r['json']['secret'];
}

// ============================================================== PayFast
// PHP's urlencode is what PayFast signs with (spaces as "+").
function payfast_string(array $fields, bool $withPass = true): string
{
    $parts = [];
    foreach ($fields as $k => $v) if ($k !== 'signature' && $v !== null && trim((string) $v) !== '') $parts[] = $k . '=' . urlencode(trim((string) $v));
    $pass = (string) cfg('payments.payfastPassphrase', '');
    if ($withPass && $pass !== '') $parts[] = 'passphrase=' . urlencode(trim($pass));
    return implode('&', $parts);
}
function payfast_form(array $payment, array $order, ?string $returnPath = null): array
{
    $first = explode(' ', trim($order['buyer_name']))[0];
    $last = trim(substr(trim($order['buyer_name']), strlen($first)));
    $k = $returnPath === null ? rawurlencode(order_key($order['id'])) : '';
    $f = [
        'merchant_id' => cfg('payments.payfastMerchantId'), 'merchant_key' => cfg('payments.payfastMerchantKey'),
        'return_url' => base_url() . ($returnPath ?? "/orders/{$order['reference']}?k=$k"), 'cancel_url' => base_url() . ($returnPath ?? "/orders/{$order['reference']}?k=$k&cancelled=1"),
        'notify_url' => base_url() . '/api/webhooks/payfast',
        'name_first' => $first, 'name_last' => $last, 'email_address' => $order['buyer_email'],
        'm_payment_id' => $payment['id'], 'amount' => number_format($payment['amount_cents'] / 100, 2, '.', ''), 'item_name' => substr($order['item_name'] ?? "TicketRoom order {$order['reference']}", 0, 100),
    ];
    $f = array_filter($f, fn($v) => $v !== null && trim((string) $v) !== '');
    $f['signature'] = md5(payfast_string($f));
    return ['action' => payfast_host() . '/eng/process', 'fields' => $f];
}
// ITN: signature, merchant, then PayFast confirms server-to-server that it sent it.
function payfast_verify(string $raw): array
{
    parse_str($raw, $f);
    if (empty($f['signature']) || empty($f['m_payment_id'])) throw bad('Missing ITN fields.');
    $ordered = [];
    foreach (explode('&', $raw) as $pair) { [$k] = explode('=', $pair, 2); $k = urldecode($k); if ($k !== '' && $k !== 'signature' && array_key_exists($k, $f)) $ordered[$k] = $f[$k]; }
    if (!hash_equals(md5(payfast_string($ordered)), (string) $f['signature'])) throw bad('ITN signature does not match.');
    if ((string) $f['merchant_id'] !== (string) cfg('payments.payfastMerchantId')) throw bad('ITN for another merchant.');
    $v = http_request('POST', payfast_host() . '/eng/query/validate', ['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => 'text/plain'], payfast_string($ordered, false));
    if (trim($v['text']) !== 'VALID') throw bad('PayFast did not confirm this notification.');
    $st = (string) ($f['payment_status'] ?? '');
    return ['id' => ($f['pf_payment_id'] ?? '') . ':' . $st, 'outcome' => $st === 'COMPLETE' ? 'paid' : ($st === 'CANCELLED' ? 'cancelled' : ($st === 'FAILED' ? 'failed' : null)),
        'reference' => (string) $f['m_payment_id'], 'amountCents' => (int) round(((float) ($f['amount_gross'] ?? 0)) * 100), 'pfPaymentId' => (string) ($f['pf_payment_id'] ?? '')];
}

// ============================================================== payments
// Opens the provider's payment page for an unpaid order. A new attempt
// replaces an earlier unfinished one (the provider's own copy simply lapses).
function payment_start(array $order): array
{
    if (!pay_ready()) throw new AppError(503, 'payments_not_configured', 'Card payments are not switched on yet. Free tickets are available; paid tickets go on sale soon.');
    $now = now_iso();
    q("UPDATE payments SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status IN ('initiated','pending')", [$now, $order['id']]);
    $p = insert('payments', ['id' => uuid(), 'order_id' => $order['id'], 'provider' => pay_provider(), 'environment' => pay_mode(), 'amount_cents' => (int) $order['total_cents'],
        'status' => 'initiated', 'created_at' => $now, 'updated_at' => $now]);
    // A test-mode payment makes this a test order, start to finish.
    q('UPDATE orders SET test = ?, updated_at = ? WHERE id = ?', [pay_test() ? 1 : 0, $now, $order['id']]);
    $k = rawurlencode(order_key($order['id']));
    try {
        if ($p['provider'] === 'yoco') {
            $c = yoco_checkout($p, $order, base_url() . "/orders/{$order['reference']}?k=$k", base_url() . "/orders/{$order['reference']}?k=$k&cancelled=1");
            q("UPDATE payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ?", [$c['reference'], now_iso(), $p['id']]);
            return ['id' => $p['id'], 'provider' => 'yoco', 'redirectUrl' => $c['redirectUrl']];
        }
        // PayFast and the sandbox: TicketRoom's own /pay page takes the buyer on.
        q("UPDATE payments SET provider_reference = ?, status = 'pending', updated_at = ? WHERE id = ?", [$p['id'], now_iso(), $p['id']]);
        return ['id' => $p['id'], 'provider' => $p['provider'], 'redirectUrl' => '/pay?p=' . $p['id'] . ($p['provider'] === 'sandbox' ? '&m=sandbox' : '') . '&k=' . rawurlencode(sign_link(['p' => $p['id']], 3600))];
    } catch (Throwable $e) {
        q("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr('checkout: ' . $e->getMessage(), 0, 240), now_iso(), $p['id']]);
        error_log('[payments] checkout failed: ' . $e->getMessage());
        throw pay_error('provider_unavailable', 'We could not reach the payment provider. Nothing was charged. Please try again in a moment.');
    }
}

// Applies a provider outcome. Safe to call twice: a second "paid" does nothing.
// Returns confirmed | duplicate | mismatch | failed | cancelled | ignored.
function payment_apply(string $provider, string $reference, string $outcome, int $amountCents): string
{
    return tx(function () use ($provider, $reference, $outcome, $amountCents) {
        $p = row('SELECT * FROM payments WHERE provider = ? AND provider_reference = ?', [$provider, $reference]);
        if (!$p) {
            // A Promote purchase (lib/promote.php): same providers, its own records.
            $pp = row('SELECT * FROM promotion_payments WHERE provider = ? AND provider_reference = ?', [$provider, $reference]);
            if ($pp) return promo_payment_apply($pp, $outcome, $amountCents);
            throw not_found('Unknown payment reference.');
        }
        if ($outcome === 'paid') {
            if (in_array($p['status'], ['confirmed', 'refunded', 'partially_refunded'], true)) return 'duplicate';
            if ($amountCents !== (int) $p['amount_cents']) {
                q("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", ["amount mismatch: provider $amountCents, expected {$p['amount_cents']}", now_iso(), $p['id']]);
            if (($p['purpose'] ?? 'order') === 'topup') topup_closed($p, 'failed');
                audit('payment.amount_mismatch', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['providerAmount' => $amountCents, 'expected' => (int) $p['amount_cents']]]);
                return 'mismatch';
            }
            $now = now_iso();
            q("UPDATE payments SET status = 'confirmed', confirmed_at = ?, failure_reason = NULL, updated_at = ? WHERE id = ?", [$now, $now, $p['id']]);
            // A cashless top-up: the money goes on the attendee's event balance.
            if (($p['purpose'] ?? 'order') === 'topup') {
                topup_confirm($p);
                audit('payment.confirmed', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['purpose' => 'topup', 'amount' => (int) $p['amount_cents']]]);
                return 'confirmed';
            }
            if ($p['environment'] !== 'live') q('UPDATE orders SET test = 1 WHERE id = ?', [$p['order_id']]);
            $order = row('SELECT * FROM orders WHERE id = ?', [$p['order_id']]);
            ledger_payment($order, $p);
            payment_fulfil($order, $p);
            if ((int) $order['test'] === 1) q('UPDATE tickets SET test = 1 WHERE order_id = ?', [$order['id']]);
            audit('payment.confirmed', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['order' => $order['reference'], 'amount' => (int) $p['amount_cents']]]);
            return 'confirmed';
        }
        if ($outcome === 'failed' || $outcome === 'cancelled') {
            if (in_array($p['status'], ['confirmed', 'refunded', 'partially_refunded'], true)) return 'ignored';
            q('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?', [$outcome, now_iso(), $p['id']]);
            if (($p['purpose'] ?? 'order') === 'topup') topup_closed($p, $outcome);
            return $outcome;
        }
        return 'ignored';
    });
}

// Issues the tickets for a paid order. If the payment came in after the
// reservation lapsed, the tickets are taken again if they're still there;
// if they've sold out, the order is marked "paid, not fulfilled" and a full
// refund goes out straight away.
function payment_fulfil(array $order, array $payment): void
{
    if ($order['status'] === 'pending_payment') { fulfil_order($order['id']); return; }
    if (!in_array($order['status'], ['expired', 'cancelled'], true)) return;
    $items = rows('SELECT * FROM order_items WHERE order_id = ?', [$order['id']]);
    $got = [];
    foreach ($items as $it) {
        if (affected('UPDATE ticket_types SET quantity_held = quantity_held + ? WHERE id = ? AND quantity_sold + quantity_held + ? <= quantity_total', [$it['quantity'], $it['ticket_type_id'], $it['quantity']]) === 0) break;
        $got[] = $it;
    }
    if (count($got) === count($items)) {
        q("UPDATE orders SET status = 'pending_payment', updated_at = ? WHERE id = ?", [now_iso(), $order['id']]);
        fulfil_order($order['id']);
        return;
    }
    foreach ($got as $it) q('UPDATE ticket_types SET quantity_held = MAX(quantity_held - ?, 0) WHERE id = ?', [$it['quantity'], $it['ticket_type_id']]);
    q("UPDATE orders SET status = 'paid_unfulfilled', paid_at = ?, updated_at = ? WHERE id = ?", [now_iso(), now_iso(), $order['id']]);
    $order = row('SELECT * FROM orders WHERE id = ?', [$order['id']]);
    $rf = refund_create($order, null, [], true, 'unfulfilled', 'Payment arrived after the reservation expired and the tickets had sold out.', null, 'processing');
    // The refund goes to the provider after this transaction commits.
    $GLOBALS['TR_AFTER_COMMIT'][] = fn() => refund_process_safe($rf['id']);
}

// Asks the provider directly (Yoco). Used by the order page while it waits,
// before a reservation expires, and by the admin "Re-check" button.
function payment_sync(string $paymentId): string
{
    $p = row('SELECT * FROM payments WHERE id = ?', [$paymentId]) ?: row('SELECT * FROM promotion_payments WHERE id = ?', [$paymentId]);
    if (!$p) throw not_found('Payment not found.');
    if ($p['provider'] !== 'yoco' || !$p['provider_reference'] || !in_array($p['status'], ['pending', 'failed', 'cancelled'], true)) return $p['status'];
    $s = yoco_status($p['provider_reference']);
    if ($s['status'] === 'paid') return payment_apply('yoco', $p['provider_reference'], 'paid', $s['amountCents']);
    if (in_array($s['status'], ['failed', 'cancelled'], true) && $p['status'] === 'pending') return payment_apply('yoco', $p['provider_reference'], $s['status'], 0);
    return $p['status'];
}

// Webhook / ITN entry point: verify, record (once), apply.
function payment_webhook(string $provider, string $raw, array $headers): array
{
    try {
        $evt = $provider === 'yoco' ? yoco_verify($raw, $headers) : payfast_verify($raw);
    } catch (Throwable $e) {
        // Kept for finance to see, but not without limit: junk can't fill the database.
        if (limit_ok('webhookreject', 100, 3600)) q('INSERT INTO webhook_events (provider, event_id, status, error, received_at) VALUES (?,?,?,?,?)', [$provider, 'rejected:' . bin2hex(random_bytes(8)), 'rejected', substr($e->getMessage(), 0, 200), now_iso()]);
        throw $e instanceof AppError ? $e : bad('Invalid notification.');
    }
    $existing = row('SELECT * FROM webhook_events WHERE provider = ? AND event_id = ?', [$provider, $evt['id']]);
    if ($existing) {
        q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$existing['id']]);
        if (in_array($existing['status'], ['processed', 'ignored'], true)) return ['duplicate' => true];
        $wid = (int) $existing['id'];
    } else {
        q('INSERT INTO webhook_events (provider, event_id, status, received_at) VALUES (?,?,?,?)', [$provider, $evt['id'], 'received', now_iso()]);
        $wid = (int) db()->lastInsertId();
    }
    try {
        $result = $evt['outcome'] && $evt['reference'] !== '' ? payment_apply($provider, $evt['reference'], $evt['outcome'], (int) $evt['amountCents']) : 'ignored';
        q('UPDATE webhook_events SET status = ?, result = ?, processed_at = ?, error = NULL WHERE id = ?', [$result === 'ignored' ? 'ignored' : 'processed', $result, now_iso(), $wid]);
        if ($provider === 'payfast' && !empty($evt['pfPaymentId']) && $result === 'confirmed') {
            q("UPDATE payments SET failure_reason = NULL, updated_at = ? WHERE provider = 'payfast' AND provider_reference = ?", [now_iso(), $evt['reference']]);
            q("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)", ['payfast_pf:' . $evt['reference'], $evt['pfPaymentId']]);
        }
        return ['result' => $result];
    } catch (Throwable $e) {
        q("UPDATE webhook_events SET status = 'failed', error = ? WHERE id = ?", [substr($e->getMessage(), 0, 300), $wid]);
        throw $e;
    }
}

// ============================================================== refunds
// A refund of some tickets (or the whole order). $includeFees adds the
// booking fee for those tickets. Amounts come from what was actually paid.
function refund_create(array $order, ?array $actor, array $ticketIds, bool $includeFees, string $kind, string $reason, ?string $note = null, string $status = 'requested'): array
{
    $p = row("SELECT * FROM payments WHERE order_id = ? AND status IN ('confirmed','partially_refunded') ORDER BY created_at DESC LIMIT 1", [$order['id']]);
    if (!$p) throw conflict('This order has no card payment to refund.', 'order_not_refundable');
    if ($kind === 'unfulfilled') {
        $amount = (int) $order['total_cents'] - (int) $order['fee_cents']; $fee = (int) $order['fee_cents']; $ids = [];
    } else {
        $open = rows("SELECT id, price_cents, fee_cents FROM tickets WHERE order_id = ? AND status IN ('valid','used')" . ($ticketIds ? ' AND id IN (' . placeholders($ticketIds) . ')' : ''), array_merge([$order['id']], $ticketIds));
        if ($ticketIds && count($open) !== count(array_unique($ticketIds))) throw conflict('Some of those tickets are already refunded or not in this order.', 'ticket_not_refundable');
        if (!$open) throw conflict('Nothing left to refund on this order.', 'order_not_refundable');
        $pending = (int) val("SELECT count(*) FROM refunds WHERE order_id = ? AND status IN ('requested','processing','manual_pending')", [$order['id']]);
        if ($pending) throw conflict('A refund for this order is already in progress.', 'refund_in_progress');
        // Discounts are shared across tickets in proportion to price.
        $gross = (int) $order['subtotal_cents'];
        $share = fn(int $price) => $gross > 0 ? (int) round($price * ((int) $order['subtotal_cents'] - (int) $order['discount_cents']) / $gross) : 0;
        $amount = array_sum(array_map(fn($t) => $share((int) $t['price_cents']), $open));
        $fee = $includeFees ? array_sum(array_map(fn($t) => (int) $t['fee_cents'], $open)) : 0;
        $ids = array_column($open, 'id');
    }
    $left = (int) $order['total_cents'] - (int) $order['refunded_cents'];
    if ($amount + $fee > $left) { $fee = max(0, $left - $amount); $amount = min($amount, $left); }
    if ($amount + $fee <= 0) throw conflict('Nothing left to refund on this order.', 'order_not_refundable');
    $now = now_iso();
    $r = insert('refunds', ['id' => uuid(), 'reference' => reference('RF'), 'order_id' => $order['id'], 'payment_id' => $p['id'], 'amount_cents' => $amount, 'fee_refund_cents' => $fee,
        'kind' => $kind, 'reason' => $reason, 'ticket_ids' => json_encode($ids), 'status' => $status, 'note' => $note, 'requested_by' => $actor['id'] ?? null, 'created_at' => $now, 'updated_at' => $now]);
    audit('refund.requested', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['order' => $order['reference'], 'amount' => $amount + $fee, 'kind' => $kind]]);
    return $r;
}

// Sends an approved refund to the provider. Yoco refunds by API; PayFast
// refunds wait for finance to do them in the PayFast dashboard.
function refund_process(string $refundId, ?array $actor = null): array
{
    $r = row('SELECT * FROM refunds WHERE id = ?', [$refundId]);
    if (!$r || !in_array($r['status'], ['requested', 'processing', 'failed'], true)) throw conflict('This refund cannot be processed now.', 'bad_transition');
    // A vendor sale refund goes back on the attendee's balance: no provider involved.
    if ($r['kind'] === 'pos_sale') {
        return tx(function () use ($r, $actor) {
            q('UPDATE refunds SET decided_by = COALESCE(decided_by, ?), updated_at = ? WHERE id = ?', [$actor['id'] ?? null, now_iso(), $r['id']]);
            return pos_refund_complete($r['id'], $actor);
        });
    }
    $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
    q("UPDATE refunds SET status = 'processing', decided_by = COALESCE(decided_by, ?), failure_reason = NULL, updated_at = ? WHERE id = ?", [$actor['id'] ?? null, now_iso(), $r['id']]);
    // Sandbox money goes back at once: there is nobody to ask.
    if ($p['provider'] === 'sandbox') return tx(fn() => refund_complete($r['id'], 'SANDBOX-' . $r['reference'], $actor));
    if ($p['provider'] !== 'yoco') {
        q("UPDATE refunds SET status = 'manual_pending', updated_at = ? WHERE id = ?", [now_iso(), $r['id']]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    try {
        $ref = yoco_refund($p, (int) $r['amount_cents'] + (int) $r['fee_refund_cents'], $r['id']);
    } catch (Throwable $e) {
        q("UPDATE refunds SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?", [substr($e->getMessage(), 0, 240), now_iso(), $r['id']]);
        audit('refund.failed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['error' => substr($e->getMessage(), 0, 120)]]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    return tx(fn() => refund_complete($r['id'], $ref, $actor));
}
function refund_process_safe(string $refundId): void
{
    try { refund_process($refundId); } catch (Throwable $e) { error_log("[refunds] $refundId: " . $e->getMessage()); }
}

// Money has gone back: tickets stop working, the order and payment record it,
// the ledger moves it, and the buyer gets an email.
function refund_complete(string $refundId, string $providerRef, ?array $actor): array
{
    $r = row('SELECT * FROM refunds WHERE id = ?', [$refundId]);
    if ($r['status'] === 'completed') return $r;
    $now = now_iso();
    $total = (int) $r['amount_cents'] + (int) $r['fee_refund_cents'];
    q("UPDATE refunds SET status = 'completed', provider_reference = ?, completed_at = ?, updated_at = ? WHERE id = ?", [$providerRef, $now, $now, $r['id']]);
    if ($r['kind'] === 'wallet_balance') {
        $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
        $pr = (int) $p['refunded_cents'] + $total;
        q('UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$pr, $pr >= (int) $p['amount_cents'] ? 'refunded' : 'partially_refunded', $now, $p['id']]);
        wallet_refund_completed($r, $p);
        audit('refund.completed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['kind' => 'wallet_balance', 'amount' => $total, 'providerReference' => $providerRef]]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    $ids = json_decode((string) $r['ticket_ids'], true) ?: [];
    if ($ids) q("UPDATE tickets SET status = 'refunded', updated_at = ? WHERE id IN (" . placeholders($ids) . ") AND status IN ('valid','used')", array_merge([$now], $ids));
    $order = row('SELECT * FROM orders WHERE id = ?', [$r['order_id']]);
    $refunded = (int) $order['refunded_cents'] + $total;
    $status = $order['status'] === 'paid_unfulfilled' || $refunded >= (int) $order['total_cents'] ? ($order['status'] === 'paid_unfulfilled' ? 'paid_unfulfilled' : 'refunded') : 'partially_refunded';
    q('UPDATE orders SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$refunded, $status, $now, $order['id']]);
    $p = row('SELECT * FROM payments WHERE id = ?', [$r['payment_id']]);
    $pr = (int) $p['refunded_cents'] + $total;
    q('UPDATE payments SET refunded_cents = ?, status = ?, updated_at = ? WHERE id = ?', [$pr, $pr >= (int) $p['amount_cents'] ? 'refunded' : 'partially_refunded', $now, $p['id']]);
    ledger_refund($order, $p, $r);
    $event = row('SELECT * FROM events WHERE id = ?', [$order['event_id']]);
    outbox_enqueue(['to' => $order['buyer_email'], 'userId' => $order['user_id']] + tpl('refundDone', ['order' => $order, 'event' => $event, 'amountCents' => $total]));
    audit('refund.completed', ['actor' => $actor, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['amount' => $total, 'providerReference' => $providerRef]]);
    return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
}

// ============================================================== ledger
// Accounts:  provider:<name>            money held at the payment provider
//            organiser:<org>:event:<ev> owed to an organiser for an event
//            organiser:<org>:payouts    paid out to the organiser
//            revenue:booking_fees       TicketRoom's booking fees
//            revenue:commission         TicketRoom's commission
//            revenue:promotions         Promote packages (lib/promote.php)
//            organiser:<org>:deductions what an organiser paid TicketRoom from their balance
//            bank:payouts               money sent to organisers by EFT
//            wallet:<user>:<event>      an attendee's cashless balance (lib/cashless.php)
//            vendor:<vendor>:event:<ev> owed for a vendor's cashless sales
//            revenue:cashless_commission TicketRoom's commission on vendor sales
// Debits are positive, credits negative; every journal sums to zero.
function ledger_post(string $kind, string $reference, array $lines, bool $test = false): void
{
    $lines = array_values(array_filter($lines, fn($l) => (int) $l[1] !== 0));
    // Test-mode money lives in its own accounts, never mixed with real money.
    if ($test) $lines = array_map(fn($l) => ['test:' . $l[0], $l[1]], $lines);
    if (!$lines) return;
    if (array_sum(array_map(fn($l) => (int) $l[1], $lines)) !== 0) throw new RuntimeException("ledger: journal $reference does not balance");
    q('INSERT INTO ledger_journals (kind, reference, created_at) VALUES (?,?,?)', [$kind, $reference, now_iso()]);
    $jid = (int) db()->lastInsertId();
    foreach ($lines as [$acct, $cents]) q('INSERT INTO ledger_entries (journal_id, account, amount_cents) VALUES (?,?,?)', [$jid, $acct, (int) $cents]);
}
function ledger_org_account(array $order): string
{
    $org = val('SELECT organiser_id FROM events WHERE id = ?', [$order['event_id']]);
    return "organiser:$org:event:{$order['event_id']}";
}
function ledger_payment(array $order, array $payment): void
{
    $net = (int) $order['subtotal_cents'] - (int) $order['discount_cents'];
    $commission = (int) $order['organiser_fee_cents'];
    ledger_post('payment', $order['reference'], [
        ['provider:' . $payment['provider'], (int) $payment['amount_cents']],
        [ledger_org_account($order), -($net - $commission)],
        ['revenue:commission', -$commission],
        ['revenue:booking_fees', -((int) $payment['amount_cents'] - $net)],
    ], $payment['environment'] !== 'live');
}
function ledger_refund(array $order, array $payment, array $refund): void
{
    $net = (int) $order['subtotal_cents'] - (int) $order['discount_cents'];
    $amount = (int) $refund['amount_cents'];
    $commission = $net > 0 ? (int) round($amount * (int) $order['organiser_fee_cents'] / $net) : 0;
    ledger_post('refund', $refund['reference'], [
        [ledger_org_account($order), $amount - $commission],
        ['revenue:commission', $commission],
        ['revenue:booking_fees', (int) $refund['fee_refund_cents']],
        ['provider:' . $payment['provider'], -($amount + (int) $refund['fee_refund_cents'])],
    ], $payment['environment'] !== 'live');
}
function ledger_balance(string $account): int { return (int) val('SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries WHERE account = ?', [$account]); }
function ledger_check(): array
{
    $bad = rows('SELECT journal_id, SUM(amount_cents) AS s FROM ledger_entries GROUP BY journal_id HAVING SUM(amount_cents) <> 0 LIMIT 20');
    $clearing = [];
    // Real money only: test-mode payments are booked to test: accounts.
    foreach (rows("SELECT DISTINCT provider FROM payments WHERE environment = 'live' UNION SELECT DISTINCT provider FROM promotion_payments WHERE environment = 'live' AND provider <> 'balance'") as $p) {
        $expected = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE provider = ? AND environment = 'live' AND status IN ('confirmed','partially_refunded','refunded')", [$p['provider']])
            - (int) val("SELECT COALESCE(SUM(r.amount_cents + r.fee_refund_cents),0) FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.provider = ? AND p.environment = 'live' AND r.status = 'completed'", [$p['provider']])
            + (int) val("SELECT COALESCE(SUM(amount_cents - refunded_cents),0) FROM promotion_payments WHERE provider = ? AND environment = 'live' AND status IN ('confirmed','refunded')", [$p['provider']]);
        $ledger = ledger_balance("provider:{$p['provider']}");
        $clearing[] = ['account' => "provider:{$p['provider']}", 'ledgerCents' => $ledger, 'expectedCents' => $expected, 'ok' => $ledger === $expected];
    }
    $clearing[] = cashless_ledger_check();
    $ok = !$bad && !array_filter($clearing, fn($c) => !$c['ok']);
    return ['entries' => (int) val("SELECT count(*) FROM ledger_entries WHERE account NOT LIKE 'test:%'"), 'sumCents' => (int) val('SELECT COALESCE(SUM(amount_cents),0) FROM ledger_entries'),
        'testEntries' => (int) val("SELECT count(*) FROM ledger_entries WHERE account LIKE 'test:%'"),
        'balanced' => $ok, 'unbalancedJournals' => array_column($bad, 'journal_id'), 'clearing' => $clearing];
}

// ============================================================== organiser money
// What an organiser is owed, event by event. Money from an event can be paid
// out once the event is over and the hold period has passed, less refunds
// still being processed and payouts already asked for.
function organiser_money(array $org): array
{
    $hold = (int) $org['payout_hold_days'];
    $now = microtime(true);
    $events = [];
    $releasable = 0;
    $total = 0;
    foreach (rows('SELECT id, title, status, ends_at FROM events WHERE organiser_id = ? ORDER BY ends_at', [$org['id']]) as $e) {
        $bal = -ledger_balance("organiser:{$org['id']}:event:{$e['id']}");
        $ok = !in_array($e['status'], ['cancelled', 'suspended'], true) && to_unix($e['ends_at']) + $hold * 86400 < $now;
        $events[] = ['event_id' => $e['id'], 'title' => $e['title'], 'status' => $e['status'], 'ends_at' => $e['ends_at'], 'payout_hold_days' => $hold, 'balance_cents' => $bal, 'releasable' => $ok, 'code' => null];
        $total += $bal;
        if ($ok) $releasable += $bal;
    }
    // Paid out by EFT, plus anything paid to TicketRoom from the balance (Promote).
    $paid = ledger_balance("organiser:{$org['id']}:payouts") + ledger_balance("organiser:{$org['id']}:deductions");
    $inFlight = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE organiser_id = ? AND vendor_id IS NULL AND status IN ('requested','approved')", [$org['id']]);
    $pendingRefunds = (int) val("SELECT COALESCE(SUM(r.amount_cents),0) FROM refunds r JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = o.event_id
                                  WHERE e.organiser_id = ? AND o.test = 0 AND r.status IN ('requested','processing','manual_pending','failed')", [$org['id']]);
    return ['events' => $events, 'totalCents' => $total - $paid, 'availableCents' => max(0, $releasable - $paid - $inFlight - $pendingRefunds),
        'inFlightCents' => $inFlight, 'pendingRefundsCents' => $pendingRefunds, 'promoteFromBalanceCents' => ledger_balance("organiser:{$org['id']}:deductions")];
}

// ============================================================== sandbox
// TicketRoom's own practice payment page (/pay). The buyer chooses what the
// "bank" says; the answer goes through exactly the same path as a real
// provider's notification, so the whole flow can be tried end to end with
// nothing real involved.
function sandbox_payment(string $paymentId, ?string $key): array
{
    $d = verify_link($key);
    if (!$d || ($d['p'] ?? '') !== $paymentId) throw not_found('This payment link has expired. Go back to your order and try again.');
    $p = row("SELECT * FROM payments WHERE id = ? AND provider = 'sandbox'", [$paymentId])
        ?: row("SELECT * FROM promotion_payments WHERE id = ? AND provider = 'sandbox'", [$paymentId]);
    if (!$p) throw not_found('Payment not found.');
    return $p;
}
function sandbox_answer(array $p, string $outcome): array
{
    if ($p['status'] !== 'pending') throw conflict('This payment is no longer open.', 'payment_closed');
    $result = payment_apply('sandbox', $p['provider_reference'], $outcome, $outcome === 'paid' ? (int) $p['amount_cents'] : 0);
    audit('payment.sandbox', ['entityType' => 'payment', 'entityId' => $p['id'], 'details' => ['outcome' => $outcome, 'result' => $result]]);
    return ['result' => $result];
}

// Before going live: test orders are cancelled, their tickets stop working and
// the places they held go back on sale. Test ledger entries stay, as history.
function clear_test_orders(array $actor): array
{
    return tx(function () use ($actor) {
        $now = now_iso();
        $freed = 0;
        foreach (rows("SELECT ticket_type_id, count(*) AS n FROM tickets WHERE test = 1 AND status IN ('valid','used') GROUP BY ticket_type_id") as $r) {
            q('UPDATE ticket_types SET quantity_sold = MAX(quantity_sold - ?, 0) WHERE id = ?', [(int) $r['n'], $r['ticket_type_id']]);
            $freed += (int) $r['n'];
        }
        q("UPDATE tickets SET status = 'revoked', revoked_reason = 'test order cleared', updated_at = ? WHERE test = 1 AND status IN ('valid','used')", [$now]);
        $orders = affected("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE test = 1 AND status <> 'cancelled'", [$now]);
        // Practice cashless money goes too (its test: ledger entries stay, as history).
        $wallets = affected('UPDATE cashless_wallets SET test_balance_cents = 0, updated_at = ? WHERE test_balance_cents > 0', [$now]);
        q("UPDATE wallet_topups SET status = 'cancelled' WHERE test = 1 AND status = 'pending'");
        // TEST Promote purchases stop too: no free promotion carries over into live.
        $promos = affected("UPDATE event_promotions SET status = 'cancelled', updated_at = ? WHERE test = 1 AND status IN ('pending_payment','active')", [$now]);
        audit('payments.test_cleared', ['actor' => $actor, 'details' => ['orders' => $orders, 'tickets' => $freed, 'wallets' => $wallets, 'promotions' => $promos]]);
        return ['orders' => $orders, 'tickets' => $freed, 'wallets' => $wallets, 'promotions' => $promos];
    });
}
