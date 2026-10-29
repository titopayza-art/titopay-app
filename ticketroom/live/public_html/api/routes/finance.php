<?php
// Money and connections: payment provider notifications, payments, refunds,
// organiser payouts, reconciliation, the ledger, and the Integrations page
// where TicketRoom sets up email, card payments and SMS itself.
declare(strict_types=1);

// ============================================================== provider notifications
// Yoco webhooks and PayFast ITNs. No session: each is checked by signature
// (and PayFast's server-to-server confirmation) before anything changes.
route('POST', '/api/webhooks/:provider', function ($a) {
    limit('webhook', 600, 60);
    $prov = $a['provider'];
    if ($prov === 'peach-payouts') return finance_peach_payout_webhook();
    if ($prov === 'verifynow') return kyc_vn_webhook();
    if ($prov === 'peach') {
        $payload = json_decode((string) $GLOBALS['TR_REQ']['raw'], true);
        if (!is_array($payload)) throw bad('Invalid Peach checkout notification.');
        $object = $payload['data']['object'] ?? $payload['data'] ?? $payload['payment'] ?? $payload;
        $externalId = (string) ($object['id'] ?? $object['payment_id'] ?? $payload['payment_id'] ?? '');
        // Peach may notify the same payment more than once as its state moves
        // from created to succeeded/failed. When it does not supply a unique
        // delivery ID, hash the raw body so retries dedupe without collapsing
        // distinct state-change notifications for the same payment.
        $eventId = (string) ($_SERVER['HTTP_WEBHOOK_ID'] ?? $payload['event_id'] ?? '');
        if ($eventId === '') $eventId = hash('sha256', (string) $GLOBALS['TR_REQ']['raw']);
        if ($externalId === '' || $eventId === '') throw bad('Missing Peach notification identifiers.');
        $payment = row("SELECT id,environment FROM payments WHERE provider = 'peach' AND provider_payment_id = ? UNION ALL SELECT id,environment FROM promotion_payments WHERE provider = 'peach' AND provider_payment_id = ? LIMIT 1", [$externalId, $externalId]);
        if (!$payment) throw not_found('Peach payment not found.');
        $secretName = $payment['environment'] === 'live' ? 'peachLiveWebhookSecret' : 'peachTestWebhookSecret';
        $secret = (string) cfg("payments.{$secretName}", '');
        $provided = (string) ($_SERVER['HTTP_X_TICKETROOM_PEACH_SECRET'] ?? '');
        if ($secret === '' || $provided === '' || !hash_equals($secret, $provided)) throw forbidden('Invalid Peach checkout notification.');
        $seen = row("SELECT id,status FROM webhook_events WHERE provider = 'peach' AND event_id = ?", [$eventId]);
        if ($seen && in_array($seen['status'], ['processed', 'ignored'], true)) { q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$seen['id']]); return ['duplicate' => true]; }
        if (!$seen) { q("INSERT INTO webhook_events (provider,event_id,status,received_at) VALUES ('peach',?,'received',?)", [$eventId, now_iso()]); $wid = (int) db()->lastInsertId(); }
        else { $wid = (int) $seen['id']; q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$wid]); }
        try {
            $result = payment_sync($payment['id']);
            q("UPDATE webhook_events SET status = 'processed',result = ?,processed_at = ?,error = NULL WHERE id = ?", [$result, now_iso(), $wid]);
            return ['result' => $result];
        } catch (Throwable $e) { q("UPDATE webhook_events SET status = 'failed',error = ? WHERE id = ?", [substr($e->getMessage(), 0, 300), $wid]); throw $e; }
    }
    if (!in_array($prov, ['yoco', 'payfast'], true)) throw not_found('Unknown provider.');
    $h = [];
    foreach ($_SERVER as $k => $v) if (str_starts_with($k, 'HTTP_')) $h[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
    $r = payment_webhook($prov, (string) $GLOBALS['TR_REQ']['raw'], $h);
    // PayFast only wants a 200; Yoco is happy with JSON.
    return $prov === 'payfast' ? raw_out('OK', 'text/plain') : $r;
});

function finance_peach_payout_webhook(): Response|array
{
    limit('webhook', 600, 60);
    $headers = [];
    foreach ($_SERVER as $k => $v) if (str_starts_with($k, 'HTTP_')) $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
    try {
        $env = null; $evt = null; $verifyError = null;
        foreach (['sandbox' => 'peachPayoutTestWebhookSecret', 'live' => 'peachPayoutLiveWebhookSecret'] as $candidate => $field) {
            $secret = (string) cfg("payouts.{$field}", '');
            if ($secret === '') continue;
            try { $evt = peach_payout_verify_webhook((string) $GLOBALS['TR_REQ']['raw'], $headers, $secret); $env = $candidate; break; }
            catch (Throwable $e) { $verifyError = $e; }
        }
        if (!$evt || !$env) throw $verifyError ?? bad('Peach payout webhook secret is not configured.');
    }
    catch (Throwable $e) {
        if (limit_ok('webhookreject', 100, 3600)) q("INSERT INTO webhook_events (provider,event_id,status,error,received_at) VALUES ('peach-payouts',?,'rejected',?,?)", ['rejected:' . bin2hex(random_bytes(8)), substr($e->getMessage(), 0, 200), now_iso()]);
        throw $e instanceof AppError ? $e : bad('Invalid Peach payout notification.');
    }
    $seen = row("SELECT * FROM webhook_events WHERE provider = 'peach-payouts' AND event_id = ?", [$evt['id']]);
    if ($seen && in_array($seen['status'], ['processed', 'ignored'], true)) { q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$seen['id']]); return raw_out('OK', 'text/plain'); }
    if (!$seen) { q("INSERT INTO webhook_events (provider,event_id,status,received_at) VALUES ('peach-payouts',?,'received',?)", [$evt['id'], now_iso()]); $wid = (int) db()->lastInsertId(); }
    else { $wid = (int) $seen['id']; q('UPDATE webhook_events SET attempts = attempts + 1 WHERE id = ?', [$wid]); }
    try {
        $body = $evt['payload'];
        $payoutId = (string) ($body['payoutId'] ?? '');
        $status = strtolower((string) ($body['status'] ?? ''));
        $updatedAt = trim((string) ($body['lastUpdated'] ?? ''));
        if ($payoutId === '' || !in_array($status, ['pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed'], true)) throw bad('Peach payout notification has an unsupported status.');
        if ($updatedAt === '' || strtotime($updatedAt) === false) throw bad('Peach payout notification is missing a valid last-updated time.');
        $submission = row('SELECT id,environment FROM peach_payout_submissions WHERE provider_payout_id = ?', [$payoutId]);
        if (!$submission) throw not_found('Peach payout attempt not found.');
        if ($submission['environment'] !== $env) throw forbidden('Peach payout notification used the wrong environment secret.');
        $failure = in_array($status, ['failed', 'cancelled', 'reversed'], true)
            ? (string) ($body['error']['message'] ?? $body['resultCode'] ?? ('Peach reported a payout ' . $status . '.')) : null;
        fin_peach_payout_apply($payoutId, $status, $failure, $updatedAt);
        q("UPDATE webhook_events SET status = 'processed',result = ?,processed_at = ?,error = NULL WHERE id = ?", [$status, now_iso(), $wid]);
        return raw_out('OK', 'text/plain');
    } catch (Throwable $e) { q("UPDATE webhook_events SET status = 'failed',error = ? WHERE id = ?", [substr($e->getMessage(), 0, 300), $wid]); throw $e; }
}
route('POST', '/api/webhooks/peach-payouts', fn() => finance_peach_payout_webhook());

// ============================================================== admin: payments
route('GET', '/api/admin/payments', function () {
    adm_any();
    $q = trim((string) qs('q', ''));
    // Ticket orders and cashless top-ups.
    $list = rows("SELECT p.*, COALESCE(o.reference, t.reference) AS order_reference, u.email FROM payments p
                    LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN wallet_topups t ON t.id = p.topup_id JOIN users u ON u.id = COALESCE(o.user_id, t.user_id)
                   WHERE ? = '' OR o.reference = upper(?) OR t.reference = upper(?) OR p.provider_reference = ? ORDER BY p.created_at DESC LIMIT 200", [$q, $q, $q, $q]);
    // Promote purchases by card (paid-from-balance ones move no provider money).
    $promo = rows("SELECT p.*, e.reference AS order_reference, u.email, 'promotion' AS purpose FROM promotion_payments p JOIN event_promotions e ON e.id = p.promotion_id
                    LEFT JOIN users u ON u.id = p.created_by WHERE p.provider <> 'balance' AND (? = '' OR e.reference = upper(?) OR p.provider_reference = ?) ORDER BY p.created_at DESC LIMIT 200", [$q, $q, $q]);
    $list = array_merge($list, $promo);
    usort($list, fn($x, $y) => strcmp($y['created_at'], $x['created_at']));
    return ['payments' => array_slice($list, 0, 200), 'stale' => fin_stale_payments()];
});
// Payments still waiting for the provider after 30 minutes, with what to do.
// Yoco and Peach can be asked again (Re-check). PayFast has no way to ask, so
// a lost notification (ITN) is looked up in the PayFast dashboard.
function fin_stale_payments(): array
{
    $old = iso_in(-1800);
    $list = array_merge(
        rows("SELECT p.id, p.provider, p.environment, p.amount_cents, p.created_at, COALESCE(o.reference, t.reference) AS order_reference FROM payments p
               LEFT JOIN orders o ON o.id = p.order_id LEFT JOIN wallet_topups t ON t.id = p.topup_id WHERE p.status = 'pending' AND p.created_at < ? ORDER BY p.created_at LIMIT 100", [$old]),
        rows("SELECT p.id, p.provider, p.environment, p.amount_cents, p.created_at, e.reference AS order_reference FROM promotion_payments p JOIN event_promotions e ON e.id = p.promotion_id
               WHERE p.status = 'pending' AND p.provider <> 'balance' AND p.created_at < ? ORDER BY p.created_at LIMIT 100", [$old]));
    return array_map(fn($p) => ['id' => $p['id'], 'provider' => $p['provider'], 'environment' => $p['environment'], 'amount_cents' => (int) $p['amount_cents'], 'created_at' => $p['created_at'],
        'order_reference' => $p['order_reference'], 'what_to_do' => match ($p['provider']) {
            'yoco', 'peach' => 'Press Re-check: TicketRoom asks the provider for the answer.',
            'payfast' => "PayFast has not sent its notification. Look up payment {$p['id']} (m_payment_id) in the PayFast dashboard. If it was paid, ask PayFast to send the notification again; if not, nothing is owed.",
            default => 'Nobody finished this practice payment. Nothing is owed.',
        }], $list);
}
route('POST', '/api/admin/payments/:id/recheck', function ($a) {
    $u = adm_finance();
    limit('recheck', 30, 600, $u['id']);
    $result = payment_sync($a['id']);
    audit('payment.rechecked', ['actor' => $u, 'entityType' => 'payment', 'entityId' => $a['id'], 'details' => ['result' => $result]]);
    return ['result' => $result];
});
route('GET', '/api/admin/webhooks', function () {
    adm_any();
    return ['webhooks' => rows("SELECT id, provider, event_id AS provider_event_id, status <> 'rejected' AS signature_valid, attempts, status, result, error, received_at, processed_at
                                  FROM webhook_events ORDER BY id DESC LIMIT 100")];
});

// ============================================================== refunds
function fin_refund_rows(string $where, array $p): array
{
    $me = user()['id'] ?? '';
    // Ticket refunds have an order; cashless wallet and vendor sale refunds have an event and a person.
    $list = rows("SELECT r.*, o.reference AS order_reference, e.title AS event_title, e.id AS event_id, e.organiser_id, rq.full_name AS requested_by_name, dc.full_name AS decided_by_name,
                         COALESCE(o.buyer_email, ru.email) AS buyer_email, v.name AS vendor_name
                    FROM refunds r LEFT JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = COALESCE(o.event_id, r.event_id)
                    LEFT JOIN users ru ON ru.id = r.user_id LEFT JOIN pos_sales s ON s.id = r.pos_sale_id LEFT JOIN vendors v ON v.id = s.vendor_id
                    LEFT JOIN users rq ON rq.id = r.requested_by LEFT JOIN users dc ON dc.id = r.decided_by
                   WHERE $where ORDER BY r.created_at DESC LIMIT 300", $p);
    // "mine" tells the page to ask for a second person: only when there is one.
    $others = (int) val("SELECT count(*) FROM platform_roles pr JOIN users x ON x.id = pr.user_id WHERE pr.role = 'finance' AND x.status = 'active' AND x.id <> ?", [$me]);
    foreach ($list as &$r) $r['mine'] = $r['requested_by'] === $me && $others > 0;
    return $list;
}
// Two people for every refund: whoever asked for it can't also approve it,
// unless they are the only person on the finance team.
function fin_can_decide(array $r, array $u): void
{
    if ($r['requested_by'] !== $u['id']) return;
    // A vendor sale refund asked for by an organiser: someone else on their team decides.
    if ($r['kind'] === 'pos_sale' && !has_role($u, 'finance')) throw forbidden('You asked for this refund, so someone else must approve it.');
    $others = (int) val("SELECT count(*) FROM platform_roles pr JOIN users x ON x.id = pr.user_id WHERE pr.role = 'finance' AND x.status = 'active' AND x.id <> ?", [$u['id']]);
    if ($others > 0) throw forbidden('You asked for this refund, so someone else in finance must approve it.');
}
function fin_decide_refund(array $u, string $id, bool $approve, ?string $note): array
{
    $r = row('SELECT * FROM refunds WHERE id = ?', [$id]);
    if (!$r) throw not_found('Refund not found.');
    if ($r['status'] !== 'requested') throw conflict('This refund has already been decided.', 'bad_transition');
    fin_can_decide($r, $u);
    if (!$approve) {
        return tx(function () use ($u, $r, $note) {
            if (affected("UPDATE refunds SET status = 'rejected', note = ?, decided_by = ?, updated_at = ? WHERE id = ? AND status = 'requested'", [$note, $u['id'], now_iso(), $r['id']]) !== 1) throw conflict('This refund has already been decided.', 'bad_transition');
            // Unused cashless balance that was waiting to be refunded goes back on the balance.
            if ($r['kind'] === 'wallet_balance') wallet_refund_rejected($r);
            audit('refund.rejected', ['actor' => $u, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['note' => $note]]);
            // A cancelled event: the whole order is now raised for refund.
            if ($r['order_id'] && $r['kind'] !== 'event_cancelled') refund_cancelled_event_rest($r['order_id'], $u);
            return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
        });
    }
    // Taken in one step: a rejection (or a second approval) at the same moment finds it already decided.
    tx(function () use ($u, $r) {
        if (affected("UPDATE refunds SET status = 'processing', decided_by = ?, updated_at = ? WHERE id = ? AND status = 'requested'", [$u['id'], now_iso(), $r['id']]) !== 1) throw conflict('This refund has already been decided.', 'bad_transition');
        audit('refund.approved', ['actor' => $u, 'entityType' => 'refund', 'entityId' => $r['id']]);
    });
    return refund_process($r['id'], $u);
}

route('GET', '/api/admin/refunds', function () {
    adm_any();
    $st = qs('status');
    return ['refunds' => $st ? fin_refund_rows('r.status = ?', [$st]) : fin_refund_rows('1 = 1', [])];
});
// Customer care or finance raises a refund for an order (all or some tickets).
route('POST', '/api/admin/orders/:ref/refund', function ($a) {
    $u = adm_any();
    limit('refundreq', 60, 3600, $u['id']);
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 400]), 'ticketIds' => R::arr(R::uuid(), ['optional' => true, 'max' => 50]), 'includeFees' => R::bool()]);
    $o = row('SELECT * FROM orders WHERE reference = ?', [strtoupper($a['ref'])]);
    if (!$o) throw not_found('Order not found.');
    if (!in_array($o['status'], ['paid', 'partially_refunded'], true)) throw conflict('Only paid orders can be refunded.', 'order_not_refundable');
    $r = tx(fn() => refund_create($o, $u, $b['ticketIds'] ?? [], $b['includeFees'], 'customer', $b['reason']));
    return json_out(['refund' => ['id' => $r['id'], 'reference' => $r['reference'], 'amountCents' => (int) $r['amount_cents'] + (int) $r['fee_refund_cents']]], 201);
});
route('POST', '/api/admin/refunds/:id/decide', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['approve' => R::bool(), 'note' => R::str(['optional' => true, 'max' => 400])]);
    if (!$b['approve'] && empty($b['note'])) throw bad('Say why, so the requester knows.', ['note' => 'Required when rejecting.']);
    return ['refund' => fin_decide_refund($u, $a['id'], $b['approve'], $b['note'] ?? null)];
});
route('POST', '/api/admin/refunds/bulk-approve', function () {
    $u = adm_finance();
    $b = check(body(), ['refundIds' => R::arr(R::uuid(), ['min' => 1, 'max' => 200])]);
    $out = [];
    foreach ($b['refundIds'] as $id) {
        try { $r = fin_decide_refund($u, $id, true, null); $out[] = ['id' => $id, 'status' => $r['status']]; }
        catch (Throwable $e) { $out[] = ['id' => $id, 'error' => $e->getMessage()]; }
    }
    return ['results' => $out];
});
route('POST', '/api/admin/refunds/:id/retry', function ($a) {
    $u = adm_finance();
    $r = row("SELECT * FROM refunds WHERE id = ? AND status = 'failed'", [$a['id']]);
    if (!$r) throw conflict('Only failed refunds can be retried.', 'bad_transition');
    return ['refund' => refund_process($r['id'], $u)];
});
// PayFast refunds (and any refund paid by EFT): finance pays it outside
// TicketRoom, then records the reference here.
route('POST', '/api/admin/refunds/:id/complete-manually', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['providerReference' => R::str(['min' => 3, 'max' => 120])]);
    $r = row("SELECT * FROM refunds WHERE id = ? AND status IN ('manual_pending','failed')", [$a['id']]);
    if (!$r) throw conflict('This refund is not waiting to be paid manually.', 'bad_transition');
    return ['refund' => tx(fn() => refund_complete($r['id'], $b['providerReference'], $u))];
});

// ============================================================== payouts
function fin_payout_rows(string $where, array $p): array
{
    $me = user()['id'] ?? '';
    $list = rows("SELECT po.*, o.name AS organiser_name, rq.full_name AS requested_by_name, ap.full_name AS approved_by_name, v.name AS vendor_name,
                         (SELECT COALESCE(ps.provider_status, ps.status) FROM peach_payout_submissions ps WHERE ps.payout_id = po.id ORDER BY ps.created_at DESC LIMIT 1) AS peach_status,
                         (SELECT ps.failure_reason FROM peach_payout_submissions ps WHERE ps.payout_id = po.id ORDER BY ps.created_at DESC LIMIT 1) AS peach_failure_reason,
                         (SELECT ps.provider_payout_id FROM peach_payout_submissions ps WHERE ps.payout_id = po.id ORDER BY ps.created_at DESC LIMIT 1) AS peach_payout_id
                    FROM payouts po JOIN organisers o ON o.id = po.organiser_id LEFT JOIN users rq ON rq.id = po.requested_by LEFT JOIN users ap ON ap.id = po.approved_by
                    LEFT JOIN vendors v ON v.id = po.vendor_id
                   WHERE $where ORDER BY po.created_at DESC LIMIT 300", $p);
    foreach ($list as &$r) $r['mine'] = $r['requested_by'] === $me;
    return $list;
}
function fin_peach_payout_apply(string $attemptId, string $status, ?string $failure = null, ?string $updatedAt = null): array
{
    $providerStatus = strtolower(trim($status));
    if (!in_array($providerStatus, ['pending', 'processing', 'successful', 'failed', 'cancelled', 'reversed'], true)) throw bad('Unknown Peach payout state.');
    $status = in_array($providerStatus, ['cancelled', 'reversed'], true) ? 'failed' : $providerStatus;
    $providerUpdatedAt = null;
    if ($updatedAt !== null && trim($updatedAt) !== '') {
        try { $providerUpdatedAt = (new DateTimeImmutable($updatedAt))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d\\TH:i:s.u\\Z'); }
        catch (Throwable) { throw bad('Peach payout update time is invalid.'); }
    }
    if ($failure === null && in_array($providerStatus, ['failed', 'cancelled', 'reversed'], true)) $failure = 'Peach reported a payout ' . $providerStatus . '.';
    return tx(function () use ($attemptId, $status, $providerStatus, $providerUpdatedAt, $failure) {
        $sub = row('SELECT * FROM peach_payout_submissions WHERE provider_payout_id = ?', [$attemptId]);
        if (!$sub) throw not_found('Peach payout attempt not found.');
        // Peach may retry or deliver status notifications out of order. Keep
        // the last provider timestamp so an old success cannot undo a reversal.
        if ($providerUpdatedAt !== null && !empty($sub['provider_updated_at']) && strcmp($providerUpdatedAt, $sub['provider_updated_at']) <= 0) {
            return $sub;
        }
        $now = now_iso();
        q('UPDATE peach_payout_submissions SET status = ?, provider_status = ?, provider_updated_at = COALESCE(?, provider_updated_at), failure_reason = ?, updated_at = ?, completed_at = ? WHERE id = ?',
            [$status, $providerStatus, $providerUpdatedAt, $failure ? substr($failure, 0, 240) : null, $now, in_array($status, ['successful', 'failed'], true) ? $now : null, $sub['id']]);

        if (in_array($providerStatus, ['cancelled', 'reversed'], true)) {
            $ledgerReversed = 0;
            if (!row('SELECT id FROM peach_payout_reversals WHERE submission_id = ?', [$sub['id']])) {
                $po = row('SELECT * FROM payouts WHERE id = ?', [$sub['payout_id']]);
                if ($sub['environment'] === 'live' && $po && $po['status'] === 'paid' && $po['bank_reference'] === 'Peach ' . $attemptId) {
                    $changed = affected("UPDATE payouts SET status = 'approved', bank_reference = NULL, paid_at = NULL, updated_at = ? WHERE id = ? AND status = 'paid' AND bank_reference = ?", [$now, $po['id'], 'Peach ' . $attemptId]);
                    if ($changed === 1) {
                        $from = $po['vendor_id'] ? vendor_account(row('SELECT id,event_id FROM vendors WHERE id = ?', [$po['vendor_id']])) : "organiser:{$po['organiser_id']}:payouts";
                        ledger_post('payout_reversal', $po['reference'] . ':' . $attemptId, [['bank:payouts', (int) $po['amount_cents']], [$from, -(int) $po['amount_cents']]]);
                        $ledgerReversed = 1;
                        audit('payout.peach_reversed', ['entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id'], 'details' => ['attempt' => $attemptId, 'amount' => (int) $po['amount_cents'], 'providerStatus' => $providerStatus]]);
                    }
                } elseif ($sub['environment'] === 'live' && $po && $po['status'] === 'paid') {
                    // Do not reverse a different EFT or another Peach attempt.
                    audit('payout.peach_reversal_review_required', ['entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id'], 'details' => ['attempt' => $attemptId, 'providerStatus' => $providerStatus, 'bankReference' => $po['bank_reference']]]);
                }
                insert('peach_payout_reversals', ['id' => uuid(), 'submission_id' => $sub['id'], 'payout_id' => $sub['payout_id'], 'provider_payout_id' => $attemptId,
                    'provider_status' => $providerStatus, 'provider_updated_at' => $providerUpdatedAt, 'ledger_reversed' => $ledgerReversed, 'created_at' => $now]);
            }
            if ($sub['environment'] !== 'live') audit('payout.peach_sandbox_terminal_status', ['entityType' => 'payout', 'entityId' => $sub['payout_id'], 'details' => ['attempt' => $attemptId, 'environment' => 'sandbox', 'status' => $providerStatus]]);
            return row('SELECT * FROM peach_payout_submissions WHERE id = ?', [$sub['id']]);
        }
        if ($status !== 'successful') return row('SELECT * FROM peach_payout_submissions WHERE id = ?', [$sub['id']]);
        if ($sub['environment'] !== 'live') {
            audit('payout.peach_sandbox_test_completed', ['entityType' => 'payout', 'entityId' => $sub['payout_id'], 'details' => ['attempt' => $attemptId, 'environment' => 'sandbox']]);
            return row('SELECT * FROM peach_payout_submissions WHERE id = ?', [$sub['id']]);
        }
        $po = row("SELECT * FROM payouts WHERE id = ? AND status = 'approved'", [$sub['payout_id']]);
        if (!$po) return row('SELECT * FROM peach_payout_submissions WHERE id = ?', [$sub['id']]);
        q("UPDATE payouts SET status = 'paid', bank_reference = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'", ['Peach ' . $attemptId, $now, $now, $po['id']]);
        $from = $po['vendor_id'] ? vendor_account(row('SELECT id,event_id FROM vendors WHERE id = ?', [$po['vendor_id']])) : "organiser:{$po['organiser_id']}:payouts";
        ledger_post('payout', $po['reference'], [[$from, (int) $po['amount_cents']], ['bank:payouts', -(int) $po['amount_cents']]]);
        fin_payout_mail(row('SELECT * FROM payouts WHERE id = ?', [$po['id']]), 'payoutPaid', ['bankReference' => 'Peach ' . $attemptId]);
        audit('payout.paid', ['entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id'], 'details' => ['provider' => 'peach', 'amount' => (int) $po['amount_cents']] ]);
        return row('SELECT * FROM peach_payout_submissions WHERE id = ?', [$sub['id']]);
    });
}
function fin_payout_mail(array $po, string $tpl, array $extra = []): void
{
    $org = row('SELECT name, contact_email FROM organisers WHERE id = ?', [$po['organiser_id']]);
    outbox_enqueue(['to' => $org['contact_email']] + tpl($tpl, ['name' => $org['name'], 'reference' => $po['reference'], 'amountCents' => (int) $po['amount_cents'], 'organiser' => $org['name'],
        'bank' => trim(($po['bank_name'] ?? '') . ' ••••' . ($po['bank_account_last4'] ?? ''))] + $extra));
}
route('GET', '/api/admin/payouts', function () {
    adm_any();
    return ['payouts' => fin_payout_rows('1 = 1', []), 'peach' => ['enabled' => cfg('payouts.payoutProvider', 'manual') === 'peach', 'environment' => peach_payout_environment()]];
});
// The money for this payout is still there: the organiser's available
// balance (leaving this payout itself out), or what is still owed for the
// vendor. Checked when it is approved and again when it is paid.
function fin_payout_funds(array $po): void
{
    if ($po['vendor_id']) {
        $v = row('SELECT id, event_id FROM vendors WHERE id = ?', [$po['vendor_id']]);
        $owed = -ledger_balance(vendor_account($v)) - (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM payouts WHERE vendor_id = ? AND status IN ('requested','approved') AND id <> ?", [$v['id'], $po['id']]);
        if ((int) $po['amount_cents'] > $owed) throw conflict('Only ' . format_zar(max(0, $owed)) . ' is still owed for this vendor. Reject this settlement and ask the organiser to request it again.', 'insufficient_balance');
        return;
    }
    $m = organiser_money(row('SELECT * FROM organisers WHERE id = ?', [$po['organiser_id']]), $po['id']);
    if ((int) $po['amount_cents'] > $m['availableCents']) throw conflict("The organiser's available balance is now " . format_zar($m['availableCents']) . ', less than this payout. Reject it and ask them to request a new one.', 'insufficient_balance');
}
route('POST', '/api/admin/payouts/:id/decide', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['approve' => R::bool(), 'note' => R::str(['optional' => true, 'max' => 400])]);
    if (!$b['approve'] && empty($b['note'])) throw bad('Tell the organiser why.', ['note' => 'Required when rejecting.']);
    return tx(function () use ($u, $a, $b) {
        $po = row("SELECT * FROM payouts WHERE id = ? AND status = 'requested'", [$a['id']]);
        if (!$po) throw conflict('This payout has already been decided.', 'bad_transition');
        if ($b['approve']) { kyc_require_for_payout($po['organiser_id']); fin_payout_funds($po); }
        if (affected('UPDATE payouts SET status = ?, note = ?, approved_by = ?, updated_at = ? WHERE id = ? AND status = ?', [$b['approve'] ? 'approved' : 'rejected', $b['note'] ?? null, $u['id'], now_iso(), $po['id'], 'requested']) !== 1) {
            throw conflict('This payout has already been decided.', 'bad_transition');
        }
        if (!$b['approve']) fin_payout_mail($po, 'payoutRejected', ['note' => $b['note']]);
        audit($b['approve'] ? 'payout.approved' : 'payout.rejected', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id']]);
        return ['payout' => row('SELECT * FROM payouts WHERE id = ?', [$po['id']])];
    });
});
// The full account number, for making the EFT. Every view is in the audit log.
route('POST', '/api/admin/payouts/:id/reveal-account', function ($a) {
    $u = adm_finance();
    limit('reveal', 30, 3600, $u['id']);
    $po = row("SELECT * FROM payouts WHERE id = ? AND status = 'approved'", [$a['id']]);
    if (!$po) throw conflict('Approve the payout first.', 'bad_transition');
    $enc = val('SELECT bank_account_enc FROM organisers WHERE id = ?', [$po['organiser_id']]);
    if (!$enc) throw conflict('The organiser has no bank account on file.', 'no_bank_details');
    audit('payout.account_revealed', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id']]);
    return ['accountNumber' => decrypt_str((string) $enc)];
});
route('POST', '/api/admin/payouts/:id/mark-paid', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['bankReference' => R::str(['min' => 3, 'max' => 120])]);
    return tx(function () use ($u, $a, $b) {
        $po = row("SELECT * FROM payouts WHERE id = ? AND status = 'approved'", [$a['id']]);
        if (!$po) throw conflict('Only approved payouts can be recorded as paid.', 'bad_transition');
        kyc_require_for_payout($po['organiser_id']);
        fin_payout_funds($po);
        $now = now_iso();
        if (affected("UPDATE payouts SET status = 'paid', bank_reference = ?, paid_by = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'", [$b['bankReference'], $u['id'], $now, $now, $po['id']]) !== 1) {
            throw conflict('Only approved payouts can be recorded as paid.', 'bad_transition');
        }
        // A vendor settlement pays out what was owed for that vendor's cashless sales.
        $from = $po['vendor_id'] ? vendor_account(row('SELECT id, event_id FROM vendors WHERE id = ?', [$po['vendor_id']])) : "organiser:{$po['organiser_id']}:payouts";
        ledger_post('payout', $po['reference'], [[$from, (int) $po['amount_cents']], ['bank:payouts', -(int) $po['amount_cents']]]);
        fin_payout_mail($po, 'payoutPaid', ['bankReference' => $b['bankReference']]);
        audit('payout.paid', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id'], 'details' => ['amount' => (int) $po['amount_cents']]]);
        return ['payout' => row('SELECT * FROM payouts WHERE id = ?', [$po['id']])];
    });
});
route('POST', '/api/admin/payouts/:id/send-peach', function ($a) {
    $u = adm_finance();
    limit('peach-payout-send', 20, 3600, $u['id']);
    $b = check(body(), ['confirm' => R::bool()]);
    if (!$b['confirm']) throw bad('Confirm the Peach payout before continuing.');
    if ((string) cfg('payouts.payoutProvider', 'manual') !== 'peach') throw conflict('Peach is not the selected payout provider.', 'provider_not_selected');
    $env = peach_payout_environment();
    $po = row("SELECT * FROM payouts WHERE id = ? AND status = 'approved'", [$a['id']]);
    if (!$po) throw conflict('Only approved payouts can be sent.', 'bad_transition');
    kyc_require_for_payout($po['organiser_id']);
    if ($env === 'live') fin_payout_funds($po);
    $prior = row("SELECT * FROM peach_payout_submissions WHERE payout_id = ? AND status IN ('submitting','pending','processing') ORDER BY created_at DESC LIMIT 1", [$po['id']]);
    if ($prior) throw conflict('A Peach transfer is already open. Re-check its status instead of sending again.', 'peach_payout_in_progress', ['status' => $prior['status']]);
    $enc = val('SELECT bank_account_enc FROM organisers WHERE id = ?', [$po['organiser_id']]);
    if (!$enc) throw conflict('The organiser has no bank account on file.', 'no_bank_details');
    $account = decrypt_str((string) $enc);
    if (!preg_match('/^\d{6,16}$/', $account)) throw conflict('The stored bank account number is invalid. Update the organiser bank details.', 'bad_bank_details');
    $attempt = uuid(); $now = now_iso();
    tx(function () use ($po, $u, $attempt, $now, $env) {
        if (row("SELECT id FROM peach_payout_submissions WHERE payout_id = ? AND status IN ('submitting','pending','processing')", [$po['id']])) throw conflict('A Peach transfer is already open. Re-check its status instead of sending again.', 'peach_payout_in_progress');
        insert('peach_payout_submissions', ['id' => uuid(), 'payout_id' => $po['id'], 'environment' => $env, 'provider_payout_id' => $attempt, 'status' => 'submitting', 'created_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now]);
    });
    audit($env === 'sandbox' ? 'payout.peach_sandbox_test_started' : 'payout.peach_submission_started', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id'], 'details' => ['environment' => $env, 'amount' => (int) $po['amount_cents']]]);
    try {
        $result = peach_payout_create($po, $account, $attempt, $env);
        $state = in_array($result['status'], ['pending', 'successful', 'failed', 'processing', 'cancelled', 'reversed'], true) ? $result['status'] : 'pending';
        q('UPDATE peach_payout_submissions SET payout_request_id = ?, updated_at = ? WHERE provider_payout_id = ?', [$result['requestId'] ?: null, now_iso(), $attempt]);
        fin_peach_payout_apply($attempt, $state, in_array($state, ['failed', 'cancelled', 'reversed'], true) ? 'Peach reported a payout ' . $state . '.' : null, $result['lastUpdated'] ?? null);
        return ['payout' => fin_payout_rows('po.id = ?', [$po['id']])[0], 'peach' => row('SELECT status, provider_payout_id FROM peach_payout_submissions WHERE provider_payout_id = ?', [$attempt])];
    } catch (Throwable $e) {
        q('UPDATE peach_payout_submissions SET failure_reason = ?, updated_at = ? WHERE provider_payout_id = ?', [substr($e->getMessage(), 0, 240), now_iso(), $attempt]);
        error_log('[peach-payout] submit error ' . $attempt . ': ' . $e->getMessage());
        throw new AppError(502, 'peach_payout_uncertain', 'Peach did not return a clear result. The payout is locked against duplicate sending; re-check its Peach status before taking any further action.');
    }
});
route('POST', '/api/admin/payouts/:id/peach-recheck', function ($a) {
    $u = adm_finance(); limit('peach-payout-recheck', 30, 600, $u['id']);
    $sub = row("SELECT * FROM peach_payout_submissions WHERE payout_id = ? AND status IN ('submitting','pending','processing') ORDER BY created_at DESC LIMIT 1", [$a['id']]);
    if (!$sub) throw conflict('There is no Peach payout waiting for a status check.', 'no_peach_payout');
    $r = peach_payout_status_by_id($sub['provider_payout_id'], $sub['environment']);
    if (!$r['found']) {
        q("UPDATE peach_payout_submissions SET status = 'failed', failure_reason = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'submitting'", ['Peach status lookup confirmed this payout ID was not received. It is safe to review and submit a new attempt.', now_iso(), now_iso(), $sub['id']]);
        return ['payout' => fin_payout_rows('po.id = ?', [$a['id']])[0], 'message' => 'Peach has no record of this payout ID. Review the details before trying a new attempt.'];
    }
    $status = strtolower((string) ($r['status'] ?? 'pending'));
    $status = in_array($status, ['pending','successful','failed','processing','cancelled','reversed'], true) ? $status : 'pending';
    q('UPDATE peach_payout_submissions SET payout_request_id = COALESCE(?,payout_request_id) WHERE id = ?', [$r['requestId'] ?? null, $sub['id']]);
    fin_peach_payout_apply($sub['provider_payout_id'], $status, in_array($status, ['failed', 'cancelled', 'reversed'], true) ? 'Peach reported a payout ' . $status . '.' : null, $r['lastUpdated'] ?? null);
    return ['payout' => fin_payout_rows('po.id = ?', [$a['id']])[0]];
});

// ============================================================== reconciliation & ledger
// Finance pastes the provider's payment report; every line is matched to a
// TicketRoom payment. Differences stay open until someone explains them.
route('GET', '/api/admin/reconciliation', function () {
    adm_any();
    $runs = rows('SELECT r.*, u.full_name AS created_by_name FROM recon_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 50');
    foreach ($runs as &$r) { $r['summary'] = json_decode($r['summary'], true); $r['source'] = 'report'; }
    $providers = array_values(array_unique(array_merge(array_column(rows("SELECT DISTINCT provider FROM payments WHERE provider NOT LIKE 'door_%'"), 'provider'), in_array(pay_provider(), ['none', 'sandbox'], true) ? [] : [pay_provider()])));
    $providers = array_values(array_diff($providers, ['sandbox']));
    return ['runs' => $runs, 'ledger' => ledger_check(), 'providers' => $providers];
});
route('POST', '/api/admin/reconciliation', function () {
    $u = adm_finance();
    $b = check(body(), ['provider' => R::oneOf(['yoco', 'payfast']), 'from' => R::date(), 'to' => R::date(), 'csv' => R::text(['optional' => true, 'max' => 2000000])]);
    if (empty($b['csv'])) throw bad("Paste the provider's payment report (CSV) to compare.", ['csv' => 'Required.']);
    $theirs = [];
    $csvLines = preg_split('/\r?\n/', trim($b['csv']));
    $header = null;
    $referenceNames = ['reference', 'provider_reference', 'payment_reference', 'transaction_id', 'merchant_transaction_id', 'merchant_reference', 'id'];
    $amountNames = ['amount_cents', 'amount', 'gross_amount', 'amount_gross'];
    $statusNames = ['status', 'payment_status', 'transaction_status'];
    foreach ($csvLines as $i => $line) {
        if (trim($line) === '') continue;
        $c = str_getcsv($line);
        $normalized = array_map(fn($x) => strtolower(trim(preg_replace('/^\xEF\xBB\xBF/', '', (string) $x))), $c);
        if ($i === 0 && array_intersect($normalized, $referenceNames) && array_intersect($normalized, $amountNames)) {
            $header = ['reference' => array_search(current(array_intersect($normalized, $referenceNames)), $normalized, true),
                'amount' => array_search(current(array_intersect($normalized, $amountNames)), $normalized, true),
                'status' => false, 'cents' => in_array('amount_cents', $normalized, true)];
            $statusName = current(array_intersect($normalized, $statusNames));
            if ($statusName !== false) $header['status'] = array_search($statusName, $normalized, true);
            continue;
        }
        if ($header) {
            $ref = trim((string) ($c[$header['reference']] ?? ''));
            $rawAmount = trim((string) ($c[$header['amount']] ?? ''));
            $rawStatus = $header['status'] === false ? '' : strtolower(trim((string) ($c[$header['status']] ?? '')));
            $asCents = $header['cents'];
        } else {
            // Keep the documented legacy layout (reference, amount_cents,
            // status); a decimal value is unambiguously a Rand amount.
            if (count($c) < 2) continue;
            $ref = trim((string) $c[0]); $rawAmount = trim((string) $c[1]);
            $rawStatus = strtolower(trim((string) ($c[2] ?? '')));
            $asCents = preg_match('/^\d+$/', $rawAmount) === 1;
        }
        $numericAmount = str_replace([',', ' ', 'R', 'r'], '', $rawAmount);
        if ($ref === '' || !preg_match($asCents ? '/^\d+$/' : '/^\d+(?:\.\d{1,2})?$/', $numericAmount)) {
            throw bad('The provider CSV has an invalid reference or amount. Use integer amount_cents, or an amount column in Rand.');
        }
        $amountCents = $asCents ? (int) $numericAmount : (int) round((float) $numericAmount * 100, 0, PHP_ROUND_HALF_UP);
        if (isset($theirs[$ref])) throw bad('The provider CSV contains the same payment reference more than once: ' . $ref . '. Remove duplicates before reconciling.');
        $theirs[$ref] = ['amount' => $amountCents, 'status' => $rawStatus];
    }
    if (!$theirs) throw bad('No payment rows were found in the CSV. Include reference and amount_cents columns, or reference and amount columns in Rand.');
    $ours = [];
    foreach (rows('SELECT provider_reference, amount_cents, status FROM payments WHERE provider = ? AND created_at >= ? AND created_at < ? AND provider_reference IS NOT NULL
                   UNION ALL SELECT provider_reference, amount_cents, status FROM promotion_payments WHERE provider = ? AND created_at >= ? AND created_at < ? AND provider_reference IS NOT NULL',
        [$b['provider'], $b['from'], $b['to'], $b['provider'], $b['from'], $b['to']]) as $p) $ours[$p['provider_reference']] = $p;
    $paidish = ['confirmed', 'partially_refunded', 'refunded'];
    return tx(function () use ($u, $b, $theirs, $ours, $paidish) {
        $id = uuid();
        $items = [];
        foreach ($theirs as $ref => $t) {
            $o = $ours[$ref] ?? null;
            $outcome = !$o ? 'missing_internal' : ((int) $o['amount_cents'] !== $t['amount'] ? 'amount_mismatch'
                : (in_array($t['status'], ['', 'succeeded', 'complete', 'completed', 'paid'], true) !== in_array($o['status'], $paidish, true) ? 'status_mismatch' : 'matched'));
            $items[] = [$ref, $outcome, $t['amount'], $o ? (int) $o['amount_cents'] : null, $t['status'] ?: null, $o['status'] ?? null];
        }
        foreach ($ours as $ref => $o) if (!isset($theirs[$ref]) && in_array($o['status'], $paidish, true)) $items[] = [$ref, 'missing_provider', null, (int) $o['amount_cents'], null, $o['status']];
        $matched = count(array_filter($items, fn($x) => $x[1] === 'matched'));
        $summary = ['matched' => $matched, 'exceptions' => count($items) - $matched, 'providerTotalCents' => array_sum(array_column($theirs, 'amount')),
            'internalTotalCents' => array_sum(array_map(fn($o) => in_array($o['status'], $paidish, true) ? (int) $o['amount_cents'] : 0, $ours))];
        insert('recon_runs', ['id' => $id, 'provider' => $b['provider'], 'period_start' => $b['from'], 'period_end' => $b['to'], 'summary' => json_encode($summary), 'created_by' => $u['id'], 'created_at' => now_iso()]);
        foreach ($items as [$ref, $out, $pa, $ia, $ps, $is]) {
            q('INSERT INTO recon_items (run_id, provider_reference, outcome, provider_amount_cents, internal_amount_cents, provider_status, internal_status, resolved) VALUES (?,?,?,?,?,?,?,?)',
                [$id, $ref, $out, $pa, $ia, $ps, $is, $out === 'matched' ? 1 : 0]);
        }
        audit('reconciliation.run', ['actor' => $u, 'entityType' => 'recon_run', 'entityId' => $id, 'details' => $summary]);
        return json_out(['run' => ['id' => $id, 'summary' => $summary]], 201);
    });
});
route('GET', '/api/admin/reconciliation/:id', function ($a) {
    adm_any();
    return ['items' => rows('SELECT * FROM recon_items WHERE run_id = ? ORDER BY resolved, id', [$a['id']])];
});
route('POST', '/api/admin/reconciliation/items/:id/resolve', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['note' => R::str(['min' => 5, 'max' => 400])]);
    if (affected('UPDATE recon_items SET resolved = 1, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND resolved = 0', [$b['note'], $u['id'], now_iso(), (int) $a['id']]) === 0) throw conflict('Already resolved.', 'bad_transition');
    audit('reconciliation.resolved', ['actor' => $u, 'entityType' => 'recon_item', 'entityId' => $a['id'], 'details' => ['note' => $b['note']]]);
    return ['ok' => true];
});
route('GET', '/api/admin/ledger/accounts', function () {
    adm_any();
    $kind = fn($a) => match (true) { str_starts_with($a, 'provider:'), str_starts_with($a, 'bank:') => 'asset', str_starts_with($a, 'organiser:'), str_starts_with($a, 'wallet:'), str_starts_with($a, 'vendor:') => 'liability', default => 'revenue' };
    return ['accounts' => array_map(fn($r) => ['code' => $r['account'], 'kind' => $kind($r['account']), 'balance_cents' => (int) $r['b'], 'entries' => (int) $r['n']],
        rows('SELECT account, SUM(amount_cents) AS b, count(*) AS n FROM ledger_entries GROUP BY account ORDER BY account'))];
});
route('GET', '/api/admin/ledger/journals', function () {
    adm_any();
    $js = rows('SELECT * FROM ledger_journals ORDER BY id DESC LIMIT 100');
    foreach ($js as &$j) { $j['reverses_journal_id'] = null; $j['lines'] = array_map(fn($l) => ['account' => $l['account'], 'amount' => (int) $l['amount_cents']], rows('SELECT account, amount_cents FROM ledger_entries WHERE journal_id = ? ORDER BY id', [$j['id']])); }
    return ['journals' => $js];
});

// ============================================================== organiser: money
route('GET', '/api/organiser/:orgId/finance', function ($a) {
    ['organiser' => $org] = organiser_access(require_auth(), $a['orgId'], ['owner', 'finance', 'manager']);
    return organiser_money($org) + ['payouts' => fin_payout_rows('po.organiser_id = ?', [$org['id']])];
});
route('POST', '/api/organiser/:orgId/payouts', function ($a) {
    $u = require_auth();
    limit('payoutreq', 10, 3600, $u['id']);
    ['organiser' => $org] = organiser_access($u, $a['orgId'], ORG_MONEY);
    $b = check(body(), ['amountCents' => R::int(['min' => 10000, 'max' => 100000000])]);
    if ($org['status'] !== 'approved') throw conflict('Your organiser account must be approved first.', 'organiser_not_approved');
    if (!$org['bank_account_last4']) throw conflict('Add your bank details in Settings first.', 'no_bank_details');
    // FICA: no money leaves until the bank account (and the rest) is verified.
    kyc_require_for_payout($org['id']);
    return tx(function () use ($u, $org, $b) {
        $m = organiser_money(row('SELECT * FROM organisers WHERE id = ?', [$org['id']]));
        if ($b['amountCents'] > $m['availableCents']) throw conflict('That is more than your available balance of ' . format_zar($m['availableCents']) . '.', 'insufficient_balance');
        $now = now_iso();
        $po = insert('payouts', ['id' => uuid(), 'reference' => reference('PO'), 'organiser_id' => $org['id'], 'amount_cents' => $b['amountCents'], 'status' => 'requested',
            'bank_name' => $org['bank_name'], 'bank_account_holder' => $org['bank_account_holder'], 'bank_account_last4' => $org['bank_account_last4'], 'bank_branch_code' => $org['bank_branch_code'],
            'requested_by' => $u['id'], 'created_at' => $now, 'updated_at' => $now]);
        fin_payout_mail($po, 'payoutRequested');
        audit('payout.requested', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $org['id'], 'details' => ['amount' => $b['amountCents']]]);
        return json_out(['payout' => $po], 201);
    });
});
route('GET', '/api/organiser/:orgId/refunds', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ['owner', 'manager', 'finance']);
    return ['refunds' => fin_refund_rows('e.organiser_id = ?', [$a['orgId']])];
});
// Organisers decide refunds of vendor (POS) sales at their own events. Ticket
// and wallet refunds are approved by TicketRoom finance.
route('POST', '/api/organiser/:orgId/refunds/:refundId/decide', function ($a) {
    $u = require_auth();
    organiser_access($u, $a['orgId'], ['owner', 'manager']);
    $b = check(body(), ['approve' => R::bool(), 'note' => R::str(['optional' => true, 'max' => 400])]);
    $r = row('SELECT r.* FROM refunds r JOIN events e ON e.id = r.event_id WHERE r.id = ? AND e.organiser_id = ?', [$a['refundId'], $a['orgId']]);
    if (!$r) throw not_found('Refund not found.');
    if ($r['kind'] !== 'pos_sale') throw conflict('Ticket refunds are approved by TicketRoom finance.', 'not_yours_to_decide');
    if (!$b['approve'] && empty($b['note'])) throw bad('Say why, so the vendor knows.', ['note' => 'Required when rejecting.']);
    return ['refund' => fin_decide_refund($u, $r['id'], $b['approve'], $b['note'] ?? null)];
});
// An organiser asks for a refund on one of their orders; TicketRoom finance approves it.
route('POST', '/api/organiser/:orgId/events/:eventId/orders/:orderId/refund', function ($a) {
    $u = require_auth();
    limit('refundreq', 60, 3600, $u['id']);
    ['event' => $event] = event_access($u, $a['orgId'], $a['eventId'], ['owner', 'finance']);
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 400]), 'ticketIds' => R::arr(R::uuid(), ['optional' => true, 'max' => 50]), 'includeFees' => R::bool()]);
    $o = row('SELECT * FROM orders WHERE id = ? AND event_id = ?', [$a['orderId'], $event['id']]);
    if (!$o) throw not_found('Order not found.');
    if (!in_array($o['status'], ['paid', 'partially_refunded'], true)) throw conflict('Only paid orders can be refunded.', 'order_not_refundable');
    if ((int) $o['total_cents'] === 0) throw conflict('Free orders have nothing to refund.', 'order_not_refundable');
    $r = tx(fn() => refund_create($o, $u, $b['ticketIds'] ?? [], $b['includeFees'], 'customer', $b['reason']));
    return json_out(['refund' => ['id' => $r['id'], 'reference' => $r['reference'], 'amountCents' => (int) $r['amount_cents'] + (int) $r['fee_refund_cents']]], 201);
});

// ============================================================== customer
route('GET', '/api/me/refunds', function () {
    $u = require_auth();
    return ['refunds' => array_map(fn($r) => ['reference' => $r['reference'], 'title' => $r['title'], 'kind' => $r['kind'], 'status' => $r['status'], 'created_at' => $r['created_at'],
        'amount_cents' => (int) $r['amount_cents'] + (int) $r['fee_refund_cents']],
        rows("SELECT r.*, e.title FROM refunds r LEFT JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = COALESCE(o.event_id, r.event_id)
               WHERE COALESCE(o.user_id, r.user_id) = ? AND r.status <> 'rejected' ORDER BY r.created_at DESC", [$u['id']]))];
});

// ============================================================== integrations
const INTEGRATION_NAMES = ['mail' => 'Email', 'payments' => 'Card payments', 'payouts' => 'Payouts', 'sms' => 'SMS', 'kyc' => 'Identity verification', 'verifynow' => 'VerifyNow', 'google' => 'Sign in with Google'];
function fin_integration(string $group): array
{
    $form = integration_form($group);
    $creds = [];
    foreach ($form as $f) if ($f['secret']) $creds[$f['name']] = $f['set'] ? 'set' : 'missing';
    if ($group === 'mail') {
        $mode = mail_mode();
        return ['key' => 'email', 'group' => 'mail', 'label' => 'Email', 'provider' => $mode, 'environment' => $mode === 'log' ? 'not sending' : 'live',
            'status' => $mode === 'smtp' || $mode === 'mail' ? 'active' : 'not set up', 'endpoint' => $mode === 'smtp' ? cfg('mail.smtpHost') . ':' . cfg('mail.smtpPort', 465) : ($mode === 'mail' ? "hosting server's PHP mail()" : 'log only (not sent)'),
            'credentials' => $creds ?: (object) [], 'fields' => $form];
    }
    if ($group === 'payments') {
        $p = pay_provider();
        return ['key' => 'payments', 'group' => 'payments', 'label' => 'Card payments', 'provider' => $p, 'environment' => $p === 'none' ? 'not set up' : pay_mode(),
            'status' => pay_ready() ? 'active' : 'not set up',
            'endpoint' => $p === 'yoco' ? yoco_base() : ($p === 'payfast' ? payfast_host() : ($p === 'sandbox' ? 'TicketRoom practice payment page' : '–')),
            'notifyUrl' => in_array($p, ['none', 'sandbox'], true) ? null : base_url() . "/api/webhooks/$p", 'credentials' => $creds ?: (object) [], 'fields' => $form,
            'testOrders' => (int) val("SELECT count(*) FROM orders WHERE test = 1 AND status <> 'cancelled'")];
    }
    if ($group === 'payouts') {
        $provider = (string) cfg('payouts.payoutProvider', 'manual');
        if (!in_array($provider, ['manual', 'peach'], true)) $provider = 'manual';
        $environment = peach_payout_environment();
        return ['key' => 'payouts', 'group' => 'payouts', 'label' => 'Organiser payouts', 'provider' => $provider, 'environment' => $environment,
            'status' => $provider === 'manual' || peach_payout_ready($environment) ? 'active' : 'not set up',
            'endpoint' => $provider === 'manual' ? 'TicketRoom manual EFT' : peach_payout_api_base($environment),
            'notifyUrl' => $provider === 'peach' ? base_url() . '/api/webhooks/peach-payouts' : null,
            'credentials' => $creds ?: (object) [], 'fields' => $form];
    }
    if ($group === 'kyc') {
        $p = kyc_provider();
        return ['key' => 'identity', 'group' => 'kyc', 'label' => 'Identity verification', 'provider' => $p, 'environment' => $p === 'sandbox' ? 'sandbox' : ($p === 'manual' ? 'staff review' : 'live'),
            'status' => $p === 'http' && !kyc_http_url_ok((string) cfg('kyc.httpUrl', '')) ? 'not set up' : 'active',
            'endpoint' => $p === 'sandbox' ? 'Simulated in TicketRoom (no provider)' : ($p === 'manual' ? 'TicketRoom staff review' : 'your provider'),
            'sandboxRule' => $p === 'sandbox' ? KYC_SANDBOX_RULE : null, 'credentials' => $creds ?: (object) [], 'fields' => $form,
            'pending' => (int) val("SELECT count(*) FROM verification_documents WHERE status = 'submitted'")];
    }
    if ($group === 'verifynow') {
        $mode = kyc_vn_mode();
        $credits = json_decode((string) val("SELECT value FROM meta WHERE key = 'verifynow_credits'"), true);
        $problem = json_decode((string) val("SELECT value FROM meta WHERE key = 'verifynow_problem'"), true);
        return ['key' => 'verifynow', 'group' => 'verifynow', 'label' => 'VerifyNow', 'provider' => kyc_vn_on() ? 'verifynow' : 'none',
            'environment' => $mode === 'sandbox' ? 'TEST (sandbox)' : 'live', 'test' => $mode === 'sandbox',
            'status' => kyc_vn_on() ? 'active' : 'not set up', 'endpoint' => kyc_vn_base(), 'notifyUrl' => kyc_vn_webhook_url(),
            'credits' => $credits, 'problem' => $problem['text'] ?? null, 'credentials' => $creds ?: (object) [], 'fields' => $form,
            'waiting' => (int) val("SELECT count(*) FROM kyc_checks WHERE status IN ('review','failed','error') AND override IS NULL"),
            'running' => (int) val("SELECT count(*) FROM kyc_checks WHERE status IN ('queued','running','waiting')")];
    }
    if ($group === 'google') {
        $on = google_ready();
        return ['key' => 'google', 'group' => 'google', 'label' => 'Sign in with Google', 'provider' => cfg('google.enabled') === 'on' ? 'google' : 'none', 'environment' => $on ? 'live' : 'not set up',
            'status' => $on ? 'active' : 'not set up', 'endpoint' => 'accounts.google.com', 'redirectUrl' => google_redirect_uri(), 'credentials' => $creds ?: (object) [], 'fields' => $form];
    }
    $p = sms_provider();
    return ['key' => 'sms', 'group' => 'sms', 'label' => 'SMS', 'provider' => $p, 'environment' => $p === 'none' ? 'not set up' : 'live', 'status' => sms_ready() ? 'active' : 'not set up',
        'endpoint' => $p === 'bulksms' ? 'api.bulksms.com' : ($p === 'clickatell' ? 'platform.clickatell.com' : '–'), 'credentials' => $creds ?: (object) [], 'fields' => $form];
}
route('GET', '/api/admin/integrations', function () {
    adm_admin(); // provider settings are for admins only
    return [
        'defaults' => ['bookingFeeCents' => (int) (settings_all()['fees']['ticketFeeFixedCents'] ?? 1000), 'bookingFeeBps' => (int) (settings_all()['fees']['ticketFeeBps'] ?? 0), 'organiserCommissionBps' => (int) (settings_all()['fees']['organiserCommissionBps'] ?? 500), 'organiserCommissionFixedCents' => (int) (settings_all()['fees']['organiserCommissionFixedCents'] ?? 250)],
        'integrations' => [fin_integration('payments'), fin_integration('payouts'), fin_integration('mail'), fin_integration('sms'), fin_integration('google'), fin_integration('kyc'), fin_integration('verifynow')],
    ];
});
// Saving needs the admin's own password: these settings move money and send mail as TicketRoom.
route('PUT', '/api/admin/integrations/:key', function ($a) {
    $u = adm_admin();
    limit('integsave', 20, 3600, $u['id']);
    $group = ['email' => 'mail', 'payments' => 'payments', 'payouts' => 'payouts', 'sms' => 'sms', 'identity' => 'kyc', 'verifynow' => 'verifynow', 'google' => 'google'][$a['key']] ?? null;
    if (!$group) throw not_found('Unknown integration.');
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'values' => R::obj([], ['optional' => true]), 'clear' => R::arr(R::str(['max' => 60]), ['optional' => true, 'max' => 20])]);
    if (!verify_secret($b['currentPassword'], (string) val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.', ['currentPassword' => 'Incorrect.']);
    $values = is_array(body()['values'] ?? null) ? body()['values'] : [];
    // The sandbox is practice only: it can never be put in live mode.
    if ($group === 'payments' && ($values['provider'] ?? pay_provider()) === 'sandbox') $values['mode'] = 'test';
    if ($group === 'verifynow') {
        // Production only with a live key; the signing secret is TicketRoom's own, never typed in.
        unset($values['webhookSecret']);
        $key = trim((string) ($values['apiKey'] ?? '')) ?: (in_array('apiKey', $b['clear'] ?? [], true) ? '' : (string) cfg('verifynow.apiKey', ''));
        if (($values['mode'] ?? kyc_vn_mode()) === 'production' && $key !== '' && !kyc_vn_live_key_ok($key)) throw invalid(['apiKey' => 'Production needs a live key, starting with vn_live_. Copy it again from the VerifyNow portal.']);
        if (($values['mode'] ?? kyc_vn_mode()) === 'production' && ($values['enabled'] ?? cfg('verifynow.enabled')) === 'on' && $key === '') throw invalid(['apiKey' => 'Enter the live API key.']);
        if (strlen((string) cfg('verifynow.webhookSecret', '')) < 32) $values['webhookSecret'] = kyc_vn_new_webhook_secret();
    }
    $wasLive = $group === 'payments' && pay_provider() !== 'none' && pay_mode() === 'live';
    $changed = tx(fn() => integration_save($group, $values, $b['clear'] ?? [], $u['id']));
    // Going live: test orders and practice money are cleared first, so nothing
    // from testing keeps a value once real money is on.
    $wentLive = null;
    if ($group === 'payments' && !$wasLive && pay_provider() !== 'none' && pay_mode() === 'live') {
        $wentLive = clear_test_orders($u);
        audit('payments.went_live', ['actor' => $u, 'entityType' => 'integration', 'entityId' => 'payments', 'ip' => client_ip(), 'details' => $wentLive]);
    }
    if ($group === 'verifynow' && in_array('apiKey', $changed, true)) { q("DELETE FROM meta WHERE key IN ('verifynow_problem','verifynow_credits')"); }
    // New mail settings: try them straight away rather than after a pause.
    if ($group === 'mail') q("DELETE FROM meta WHERE key = 'mail_paused_until'");
    $warning = null;
    // Yoco: each mode (test, live) gets its own notification address and signing secret,
    // registered here whenever that mode's key is new or its secret is missing.
    if ($group === 'payments' && pay_provider() === 'yoco') {
        $notes = [];
        foreach (['test', 'live'] as $mode) {
            $field = 'yoco' . ucfirst($mode) . 'SecretKey'; $hook = 'yoco' . ucfirst($mode) . 'WebhookSecret';
            if (yoco_key($mode) === '') continue;
            $newKey = in_array($field, $changed, true);
            if (!$newKey && yoco_webhook_secret($mode) !== '') continue;
            try {
                $secret = yoco_register_webhook($mode);
                tx(fn() => integration_save('payments', [$hook => $secret], [], $u['id']));
                $changed[] = $hook;
            } catch (Throwable $e) {
                // A new key must not keep the old key's secret: notifications would fail silently.
                if ($newKey) tx(fn() => integration_save('payments', [], [$hook], $u['id']));
                $notes[] = ucfirst($mode) . ': Yoco could not register the notification address: ' . integration_scrub($e->getMessage());
            }
        }
        if (!yoco_mode_ready(pay_mode())) $notes[] = 'Mode is ' . ucfirst(pay_mode()) . ' but the ' . pay_mode() . ' Yoco keys are not saved and connected yet, so paid tickets stay off until they are.';
        if ($notes) $warning = 'Saved. ' . implode(' ', $notes);
    }
    audit('integration.updated', ['actor' => $u, 'entityType' => 'integration', 'entityId' => $group, 'ip' => client_ip(), 'details' => ['fields' => $changed]]);
    $notice = null;
    if ($wentLive) {
        $notice = 'Live payments are on. Test orders were cleared first: ' . plural($wentLive['orders'], 'test order') . ' cancelled and practice wristband money removed.';
        foreach ($wentLive['deskTopups'] as $d) $notice .= " At {$d['event']}, " . format_zar($d['cents']) . ' was topped up at the desk in test mode: if real cash or card money was taken, the organiser must give it back to those guests.';
    }
    return ['integration' => fin_integration($group), 'changed' => $changed, 'warning' => $warning, 'wentLive' => $wentLive, 'notice' => $notice];
});
// Proves, from this server, that Yoco opens a payment page with one mode's key: a
// R5 checkout that belongs to no order, so nothing is sold. Live charges real money
// if someone pays, so the page warns before opening it.
route('POST', '/api/admin/integrations/payments/yoco-test-page', function () {
    $u = adm_admin();
    limit('yocotestpage', 10, 600, $u['id']);
    $b = check(body(), ['mode' => R::oneOf(['test', 'live'])]);
    $mode = $b['mode'];
    if (yoco_key($mode) === '') return ['ok' => false, 'detail' => 'Save the Yoco ' . strtoupper($mode) . ' secret key first.'];
    $back = base_url() . '/admin#/integrations';
    try { $r = yoco_call('POST', '/api/checkouts', ['amount' => 500, 'currency' => 'ZAR', 'successUrl' => $back, 'cancelUrl' => $back, 'failureUrl' => $back, 'metadata' => ['purpose' => 'TicketRoom connection test']], null, $mode); }
    catch (Throwable $e) { return ['ok' => false, 'detail' => 'This server could not reach Yoco: ' . integration_scrub($e->getMessage()) . ' Ask your host to allow outgoing HTTPS to payments.yoco.com.']; }
    if (in_array($r['status'], [401, 403], true)) return ['ok' => false, 'detail' => 'Yoco rejected the ' . strtoupper($mode) . ' secret key. Copy it again from the Yoco portal and save.'];
    $url = (string) ($r['json']['redirectUrl'] ?? '');
    if ($r['status'] >= 300 || !preg_match('#^https://([a-z0-9-]+\.)*yoco\.com/#i', $url)) return ['ok' => false, 'detail' => 'Yoco did not open a payment page (' . yoco_problem($r) . ').'];
    $answered = (string) ($r['json']['processingMode'] ?? $mode);
    audit('integration.yoco_test_page', ['actor' => $u, 'entityType' => 'integration', 'entityId' => 'payments', 'details' => ['mode' => $mode]]);
    return ['ok' => true, 'url' => $url, 'mode' => $answered, 'detail' => $answered !== $mode
        ? 'Warning: Yoco opened a ' . $answered . ' page with the ' . $mode . ' key. Check the keys.'
        : 'Yoco opened a R5.00 ' . $mode . ' payment page from this server.' . ($mode === 'live' ? ' Do not pay: it is a real charge.' : ' Pay with the test card shown on it; nothing is charged.')];
});
route('POST', '/api/admin/integrations/:key/health', function ($a) {
    $u = adm_admin();
    limit('integhealth', 30, 600, $u['id']);
    $key = $a['key'];
    if ($key === 'email') $result = smtp_health();
    elseif ($key === 'sms') $result = sms_health();
    elseif ($key === 'payments') $result = fin_payments_health();
    elseif ($key === 'payouts') $result = fin_payouts_health();
    elseif ($key === 'identity') $result = fin_identity_health();
    elseif ($key === 'verifynow') $result = kyc_vn_health();
    elseif ($key === 'google') $result = !google_ready() ? ['ok' => false, 'detail' => 'Switch it on and enter the client ID and secret.']
        : (preg_match('/^[\w-]+\.apps\.googleusercontent\.com$/', (string) cfg('google.clientId')) ? ['ok' => true, 'detail' => 'Ready. Make sure ' . google_redirect_uri() . ' is listed under Authorised redirect URIs in Google Cloud.']
        : ['ok' => false, 'detail' => 'That does not look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).']);
    if (isset($result['detail'])) $result['detail'] = integration_scrub((string) $result['detail']);
    else throw not_found('Unknown integration.');
    audit('integration.health_checked', ['actor' => $u, 'entityType' => 'integration', 'entityId' => $key, 'details' => ['ok' => $result['ok']]]);
    return $result;
});
function fin_identity_health(): array
{
    return match (kyc_provider()) {
        'manual' => ['ok' => true, 'detail' => 'TicketRoom staff review every document under Verification. Nothing is sent to an outside provider.'],
        'sandbox' => ['ok' => true, 'detail' => 'The identity sandbox is on. ' . KYC_SANDBOX_RULE . ' Switch to staff review or your provider before going live.'],
        default => kyc_http_url_ok((string) cfg('kyc.httpUrl', ''))
            ? ['ok' => true, 'detail' => 'The address looks right. Use "Try a check" with a test ID number to see what your provider answers.']
            : ['ok' => false, 'detail' => 'The check-identity address must start with https:// and be on the public internet.'],
    };
}
function fin_payments_health(): array
{
    $p = pay_provider();
    if ($p === 'none') return ['ok' => false, 'detail' => 'Choose Yoco or PayFast and enter its keys.'];
    if ($p === 'sandbox') return ['ok' => true, 'detail' => 'The sandbox is ready. Buyers see a practice payment page and choose the outcome. No money moves and every ticket is marked TEST, which the gate refuses.'];
    if ($p === 'payfast') {
        if (!pay_ready()) return ['ok' => false, 'detail' => 'Enter the PayFast merchant ID and key.'];
        try { $r = http_request('GET', payfast_host() . '/eng/process', [], null, 10); } catch (Throwable $e) { return ['ok' => false, 'detail' => $e->getMessage()]; }
        return ['ok' => true, 'detail' => 'PayFast (' . pay_mode() . ') is reachable. Keys are checked on the first payment. Refunds are paid in the PayFast dashboard and recorded in Refunds.'];
    }
    if ($p === 'peach') {
        $env = pay_mode();
        if (!peach_checkout_ready($env)) return ['ok' => false, 'detail' => 'Enter the Peach ' . ($env === 'live' ? 'production' : 'sandbox') . ' profile ID and API key.'];
        $prefix = $env === 'live' ? 'peachLive' : 'peachTest';
        // A deliberately nonexistent payment ID exercises the real read
        // endpoint. Its 404 is expected and creates no customer transaction.
        try { $r = http_request('GET', peach_api_base($env) . '/payments/00000000-0000-4000-8000-000000000000', ['api-key' => (string) cfg("payments.{$prefix}ApiKey"), 'Accept' => 'application/json'], null, 10); }
        catch (Throwable $e) { return ['ok' => false, 'detail' => 'Peach endpoint is unreachable: ' . $e->getMessage()]; }
        if (in_array($r['status'], [401, 403], true)) return ['ok' => false, 'detail' => 'Peach rejected the API key. Check that the key and profile are from the selected environment.'];
        if ($r['status'] >= 500) return ['ok' => false, 'detail' => 'Peach is temporarily unavailable (HTTP ' . $r['status'] . ').'];
        if (!in_array($r['status'], [200, 404], true)) return ['ok' => false, 'detail' => 'Peach returned an unexpected response (HTTP ' . $r['status'] . '). Check the API key and profile for the selected environment.'];
        return ['ok' => true, 'detail' => 'Peach Orchestration (' . $env . ') is reachable and the key was accepted. Finish a real sandbox checkout before switching this provider to Live.'];
    }
    // Yoco: check both key sets with Yoco itself, without charging anything.
    $lines = []; $ok = true;
    foreach (['test', 'live'] as $mode) {
        $label = ucfirst($mode) . ($mode === pay_mode() ? ' (buyers pay with this)' : '');
        if (yoco_key($mode) === '') { $lines[] = "$label: no key saved."; if ($mode === pay_mode()) $ok = false; continue; }
        try { $r = yoco_call('GET', '/api/webhooks', null, null, $mode); } catch (Throwable $e) { $lines[] = "$label: Yoco could not be reached (" . $e->getMessage() . ').'; if ($mode === pay_mode()) $ok = false; continue; }
        if (in_array($r['status'], [401, 403], true)) { $lines[] = "$label: Yoco rejected the secret key."; if ($mode === pay_mode()) $ok = false; continue; }
        if ($r['status'] >= 300) { $lines[] = "$label: Yoco answered " . yoco_problem($r) . '.'; if ($mode === pay_mode()) $ok = false; continue; }
        if (yoco_webhook_secret($mode) === '') { $lines[] = "$label: key accepted, but payment notifications are not connected. Save the settings again."; if ($mode === pay_mode()) $ok = false; continue; }
        $lines[] = "$label: key accepted and payment notifications connected.";
    }
    return ['ok' => $ok, 'detail' => implode(' ', $lines)];
}
function fin_payouts_health(): array
{
    if ((string) cfg('payouts.payoutProvider', 'manual') !== 'peach') return ['ok' => true, 'detail' => 'Manual EFT is selected. Finance must approve, make the bank transfer and record its reference.'];
    $env = peach_payout_environment();
    if (!peach_payout_ready($env)) return ['ok' => false, 'detail' => 'Enter the Peach Payouts credentials for the selected ' . $env . ' environment.'];
    try { peach_payout_token($env); }
    catch (Throwable $e) { return ['ok' => false, 'detail' => integration_scrub($e->getMessage())]; }
    return ['ok' => true, 'detail' => $env === 'sandbox'
        ? 'Peach Payouts sandbox authentication works. Approved requests can be sent to the Peach sandbox for end-to-end testing; sandbox results never settle or reduce real organiser balances.'
        : 'Peach Payouts production authentication works. Actual transfers remain a separate finance action after approval and require sufficient Peach payout float.' ];
}
// Test mode in one click. "ticketroom": TicketRoom's own sandbox, works
// anywhere with no provider account. "payfast": PayFast's shared sandbox
// account (published by PayFast for testing). Needs the admin's password.
const PAYFAST_SANDBOX = ['payfastMerchantId' => '10000100', 'payfastMerchantKey' => '46f0cd694581a', 'payfastPassphrase' => 'jt7NOE43FZPn'];
route('POST', '/api/admin/integrations/payments/sandbox', function () {
    $u = adm_admin();
    limit('integsave', 20, 3600, $u['id']);
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'kind' => R::oneOf(['ticketroom', 'payfast'], ['optional' => true])]);
    if (!verify_secret($b['currentPassword'], (string) val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.', ['currentPassword' => 'Incorrect.']);
    if (pay_provider() !== 'none' && pay_mode() === 'live') throw conflict('Live payments are switched on. Switch Mode to Test first if you really want a test setup.', 'live_mode');
    $kind = $b['kind'] ?? 'ticketroom';
    $values = $kind === 'payfast' ? ['provider' => 'payfast', 'mode' => 'test'] + PAYFAST_SANDBOX : ['provider' => 'sandbox', 'mode' => 'test'];
    $changed = tx(fn() => integration_save('payments', $values, [], $u['id']));
    audit('integration.updated', ['actor' => $u, 'entityType' => 'integration', 'entityId' => 'payments', 'ip' => client_ip(), 'details' => ['fields' => $changed, 'sandbox' => $kind]]);
    return ['ok' => true, 'integration' => fin_integration('payments'), 'message' => $kind === 'payfast'
        ? 'Test payments are ready: PayFast test mode with PayFast\'s shared test account. Buy a ticket to try it; no real money moves.'
        : 'The TicketRoom sandbox is on. Buy a ticket to try it: you choose whether the practice payment goes through. No real money moves.'];
});
// Removes every test order: tickets revoked, seats freed, test ledger kept for the record.
route('POST', '/api/admin/payments/clear-test', function () {
    $u = adm_admin();
    $b = check(body(), ['currentPassword' => R::str(['max' => 200])]);
    if (!verify_secret($b['currentPassword'], (string) val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.', ['currentPassword' => 'Incorrect.']);
    $n = clear_test_orders($u);
    return ['ok' => true, 'cleared' => $n, 'integration' => fin_integration('payments')];
});
// Sends a test email or SMS straight away.
route('POST', '/api/admin/integrations/:key/test', function ($a) {
    $u = adm_admin();
    limit('integtest', 10, 600, $u['id']);
    if ($a['key'] === 'email') {
        // To any address the admin types (their own by default), sent straight away.
        $b = check(body(), ['to' => R::email(['optional' => true])]);
        $to = $b['to'] ?? $u['email'];
        $r = send_now($to, 'TicketRoom test email', "Hi,\n\nThis is a test from Admin portal → Integrations, sent by {$u['fullName']}. If you can read it, TicketRoom email works.\n\n-- \nTicketRoom", null);
        audit('integration.test_email', ['actor' => $u, 'entityType' => 'integration', 'entityId' => 'mail', 'details' => ['ok' => $r['ok']]]);
        return $r;
    }
    if ($a['key'] === 'sms') {
        $b = check(body(), ['phone' => R::phone()]);
        try { sms_send($b['phone'], 'TicketRoom test SMS. If you can read this, SMS works.'); return ['ok' => true, 'detail' => "Sent to {$b['phone']}."]; }
        catch (Throwable $e) { return ['ok' => false, 'detail' => integration_scrub($e->getMessage())]; }
    }
    if ($a['key'] === 'identity') {
        // A trial check with a number the admin types. Nothing is stored.
        $b = check(body(), ['number' => R::str(['min' => 6, 'max' => 20]), 'fullName' => R::str(['optional' => true, 'max' => 120])]);
        $isId = (bool) preg_match('/^\d{13}$/', (string) preg_replace('/\s+/', '', $b['number']));
        $c = $isId ? sa_id_check($b['number']) : passport_check($b['number']);
        if (!$c['ok']) return ['ok' => false, 'detail' => $c['error']];
        $r = kyc_identity_check(['reference' => 'TEST-' . random_code(6), 'type' => $isId ? 'sa_id' : 'passport', 'number' => $c['id'], 'name' => $b['fullName'] ?? 'Test Person', 'dob' => $c['dob'] ?? null]);
        audit('integration.identity_test', ['actor' => $u, 'entityType' => 'integration', 'entityId' => 'kyc', 'details' => ['provider' => $r['provider'], 'outcome' => $r['status']]]);
        $local = $isId ? "Valid SA ID number: born {$c['dob']}, {$c['citizenship']}." : 'Passport number format is fine.';
        return ['ok' => $r['status'] !== 'error', 'outcome' => $r['status'], 'provider' => $r['provider'], 'simulated' => $r['provider'] === 'sandbox',
            'detail' => "$local " . ($r['status'] === 'manual' ? 'Staff review is on, so nothing is sent anywhere.' : 'Outcome: ' . $r['status'] . ($r['message'] ? " ({$r['message']})" : '') . '.')];
    }
    throw not_found('Nothing to test here.');
});
