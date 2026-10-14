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
    if (!in_array($prov, ['yoco', 'payfast'], true)) throw not_found('Unknown provider.');
    $h = [];
    foreach ($_SERVER as $k => $v) if (str_starts_with($k, 'HTTP_')) $h[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
    $r = payment_webhook($prov, (string) $GLOBALS['TR_REQ']['raw'], $h);
    // PayFast only wants a 200; Yoco is happy with JSON.
    return $prov === 'payfast' ? raw_out('OK', 'text/plain') : $r;
});

// ============================================================== admin: payments
route('GET', '/api/admin/payments', function () {
    adm_any();
    $q = trim((string) qs('q', ''));
    $list = rows("SELECT p.*, o.reference AS order_reference, u.email, 'order' AS purpose FROM payments p JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.user_id
                   WHERE ? = '' OR o.reference = upper(?) OR p.provider_reference = ? ORDER BY p.created_at DESC LIMIT 200", [$q, $q, $q]);
    return ['payments' => $list];
});
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
    $list = rows("SELECT r.*, o.reference AS order_reference, e.title AS event_title, e.id AS event_id, e.organiser_id, rq.full_name AS requested_by_name, dc.full_name AS decided_by_name, o.buyer_email
                    FROM refunds r JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = o.event_id
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
        q("UPDATE refunds SET status = 'rejected', note = ?, decided_by = ?, updated_at = ? WHERE id = ?", [$note, $u['id'], now_iso(), $r['id']]);
        audit('refund.rejected', ['actor' => $u, 'entityType' => 'refund', 'entityId' => $r['id'], 'details' => ['note' => $note]]);
        return row('SELECT * FROM refunds WHERE id = ?', [$r['id']]);
    }
    q('UPDATE refunds SET decided_by = ?, updated_at = ? WHERE id = ?', [$u['id'], now_iso(), $r['id']]);
    audit('refund.approved', ['actor' => $u, 'entityType' => 'refund', 'entityId' => $r['id']]);
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
    $list = rows("SELECT po.*, o.name AS organiser_name, rq.full_name AS requested_by_name, ap.full_name AS approved_by_name
                    FROM payouts po JOIN organisers o ON o.id = po.organiser_id LEFT JOIN users rq ON rq.id = po.requested_by LEFT JOIN users ap ON ap.id = po.approved_by
                   WHERE $where ORDER BY po.created_at DESC LIMIT 300", $p);
    foreach ($list as &$r) { $r['mine'] = $r['requested_by'] === $me; $r['vendor_name'] = null; }
    return $list;
}
function fin_payout_mail(array $po, string $tpl, array $extra = []): void
{
    $org = row('SELECT name, contact_email FROM organisers WHERE id = ?', [$po['organiser_id']]);
    outbox_enqueue(['to' => $org['contact_email']] + tpl($tpl, ['name' => $org['name'], 'reference' => $po['reference'], 'amountCents' => (int) $po['amount_cents'], 'organiser' => $org['name'],
        'bank' => trim(($po['bank_name'] ?? '') . ' ••••' . ($po['bank_account_last4'] ?? ''))] + $extra));
}
route('GET', '/api/admin/payouts', function () { adm_any(); return ['payouts' => fin_payout_rows('1 = 1', [])]; });
route('POST', '/api/admin/payouts/:id/decide', function ($a) {
    $u = adm_finance();
    $b = check(body(), ['approve' => R::bool(), 'note' => R::str(['optional' => true, 'max' => 400])]);
    $po = row("SELECT * FROM payouts WHERE id = ? AND status = 'requested'", [$a['id']]);
    if (!$po) throw conflict('This payout has already been decided.', 'bad_transition');
    if (!$b['approve'] && empty($b['note'])) throw bad('Tell the organiser why.', ['note' => 'Required when rejecting.']);
    q('UPDATE payouts SET status = ?, note = ?, approved_by = ?, updated_at = ? WHERE id = ?', [$b['approve'] ? 'approved' : 'rejected', $b['note'] ?? null, $u['id'], now_iso(), $po['id']]);
    if (!$b['approve']) fin_payout_mail($po, 'payoutRejected', ['note' => $b['note']]);
    audit($b['approve'] ? 'payout.approved' : 'payout.rejected', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id']]);
    return ['payout' => row('SELECT * FROM payouts WHERE id = ?', [$po['id']])];
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
        $now = now_iso();
        q("UPDATE payouts SET status = 'paid', bank_reference = ?, paid_by = ?, paid_at = ?, updated_at = ? WHERE id = ?", [$b['bankReference'], $u['id'], $now, $now, $po['id']]);
        ledger_post('payout', $po['reference'], [["organiser:{$po['organiser_id']}:payouts", (int) $po['amount_cents']], ['bank:payouts', -(int) $po['amount_cents']]]);
        fin_payout_mail($po, 'payoutPaid', ['bankReference' => $b['bankReference']]);
        audit('payout.paid', ['actor' => $u, 'entityType' => 'payout', 'entityId' => $po['id'], 'organiserId' => $po['organiser_id'], 'details' => ['amount' => (int) $po['amount_cents']]]);
        return ['payout' => row('SELECT * FROM payouts WHERE id = ?', [$po['id']])];
    });
});

// ============================================================== reconciliation & ledger
// Finance pastes the provider's payment report; every line is matched to a
// TicketRoom payment. Differences stay open until someone explains them.
route('GET', '/api/admin/reconciliation', function () {
    adm_any();
    $runs = rows('SELECT r.*, u.full_name AS created_by_name FROM recon_runs r LEFT JOIN users u ON u.id = r.created_by ORDER BY r.created_at DESC LIMIT 50');
    foreach ($runs as &$r) { $r['summary'] = json_decode($r['summary'], true); $r['source'] = 'report'; }
    $providers = array_values(array_unique(array_merge(array_column(rows('SELECT DISTINCT provider FROM payments'), 'provider'), pay_provider() === 'none' ? [] : [pay_provider()])));
    return ['runs' => $runs, 'ledger' => ledger_check(), 'providers' => $providers];
});
route('POST', '/api/admin/reconciliation', function () {
    $u = adm_finance();
    $b = check(body(), ['provider' => R::oneOf(['yoco', 'payfast']), 'from' => R::date(), 'to' => R::date(), 'csv' => R::text(['optional' => true, 'max' => 2000000])]);
    if (empty($b['csv'])) throw bad("Paste the provider's payment report (CSV) to compare.", ['csv' => 'Required.']);
    $theirs = [];
    foreach (preg_split('/\r?\n/', trim($b['csv'])) as $i => $line) {
        $c = str_getcsv($line);
        if (count($c) < 2 || ($i === 0 && !preg_match('/\d/', (string) ($c[1] ?? '')))) continue;
        $theirs[trim($c[0])] = ['amount' => (int) round((float) $c[1]), 'status' => strtolower(trim($c[2] ?? ''))];
    }
    $ours = [];
    foreach (rows('SELECT provider_reference, amount_cents, status FROM payments WHERE provider = ? AND created_at >= ? AND created_at < ? AND provider_reference IS NOT NULL', [$b['provider'], $b['from'], $b['to']]) as $p) $ours[$p['provider_reference']] = $p;
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
    $kind = fn($a) => match (true) { str_starts_with($a, 'provider:'), str_starts_with($a, 'bank:') => 'asset', str_starts_with($a, 'organiser:') => 'liability', default => 'revenue' };
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
route('POST', '/api/organiser/:orgId/refunds/:refundId/decide', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ['owner', 'manager']);
    throw conflict('Ticket refunds are approved by TicketRoom finance.', 'not_yours_to_decide');
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
        rows("SELECT r.*, e.title FROM refunds r JOIN orders o ON o.id = r.order_id JOIN events e ON e.id = o.event_id WHERE o.user_id = ? AND r.status <> 'rejected' ORDER BY r.created_at DESC", [$u['id']]))];
});

// ============================================================== integrations
const INTEGRATION_NAMES = ['mail' => 'Email', 'payments' => 'Card payments', 'sms' => 'SMS'];
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
            'status' => pay_ready() ? 'active' : 'not set up', 'endpoint' => $p === 'yoco' ? yoco_base() : ($p === 'payfast' ? payfast_host() : '—'),
            'notifyUrl' => $p === 'none' ? null : base_url() . "/api/webhooks/$p", 'credentials' => $creds ?: (object) [], 'fields' => $form];
    }
    $p = sms_provider();
    return ['key' => 'sms', 'group' => 'sms', 'label' => 'SMS', 'provider' => $p, 'environment' => $p === 'none' ? 'not set up' : 'live', 'status' => sms_ready() ? 'active' : 'not set up',
        'endpoint' => $p === 'bulksms' ? 'api.bulksms.com' : ($p === 'clickatell' ? 'platform.clickatell.com' : '—'), 'credentials' => $creds ?: (object) [], 'fields' => $form];
}
route('GET', '/api/admin/integrations', function () {
    adm_any();
    return [
        'defaults' => ['bookingFeeCents' => (int) cfg('fees.ticketFeeFixedCents', 1000), 'bookingFeeBps' => (int) cfg('fees.ticketFeeBps', 0), 'organiserCommissionBps' => (int) cfg('fees.organiserCommissionBps', 500)],
        'integrations' => [fin_integration('payments'), fin_integration('mail'), fin_integration('sms')],
    ];
});
// Saving needs the admin's own password: these settings move money and send mail as TicketRoom.
route('PUT', '/api/admin/integrations/:key', function ($a) {
    $u = adm_admin();
    limit('integsave', 20, 3600, $u['id']);
    $group = ['email' => 'mail', 'payments' => 'payments', 'sms' => 'sms'][$a['key']] ?? null;
    if (!$group) throw not_found('Unknown integration.');
    $b = check(body(), ['currentPassword' => R::str(['max' => 200]), 'values' => R::obj([], ['optional' => true]), 'clear' => R::arr(R::str(['max' => 60]), ['optional' => true, 'max' => 20])]);
    if (!verify_secret($b['currentPassword'], (string) val('SELECT password_hash FROM users WHERE id = ?', [$u['id']]))) throw new AppError(401, 'bad_credentials', 'Your password is incorrect.', ['currentPassword' => 'Incorrect.']);
    $values = is_array(body()['values'] ?? null) ? body()['values'] : [];
    $changed = tx(fn() => integration_save($group, $values, $b['clear'] ?? [], $u['id']));
    // New mail settings: try them straight away rather than after a pause.
    if ($group === 'mail') q("DELETE FROM meta WHERE key = 'mail_paused_until'");
    $warning = null;
    // Yoco: register TicketRoom's notification address and keep the signing secret.
    if ($group === 'payments' && pay_provider() === 'yoco' && (string) cfg('payments.yocoSecretKey', '') !== ''
        && (in_array('yocoSecretKey', $changed, true) || in_array('mode', $changed, true) || (string) cfg('payments.yocoWebhookSecret', '') === '')) {
        try {
            $secret = yoco_register_webhook();
            tx(fn() => integration_save('payments', ['yocoWebhookSecret' => $secret], [], $u['id']));
            $changed[] = 'yocoWebhookSecret';
        } catch (Throwable $e) { $warning = 'Saved, but Yoco could not be reached to register the notification address: ' . $e->getMessage() . ' Try "Check connection", or paste the webhook secret from the Yoco portal.'; }
    }
    audit('integration.updated', ['actor' => $u, 'entityType' => 'integration', 'entityId' => $group, 'ip' => client_ip(), 'details' => ['fields' => $changed]]);
    return ['integration' => fin_integration($group), 'changed' => $changed, 'warning' => $warning];
});
route('POST', '/api/admin/integrations/:key/health', function ($a) {
    $u = adm_admin();
    limit('integhealth', 30, 600, $u['id']);
    $key = $a['key'];
    if ($key === 'email') $result = smtp_health();
    elseif ($key === 'sms') $result = sms_health();
    elseif ($key === 'payments') $result = fin_payments_health();
    else throw not_found('Unknown integration.');
    audit('integration.health_checked', ['actor' => $u, 'entityType' => 'integration', 'entityId' => $key, 'details' => ['ok' => $result['ok']]]);
    return $result;
});
function fin_payments_health(): array
{
    $p = pay_provider();
    if ($p === 'none') return ['ok' => false, 'detail' => 'Choose Yoco or PayFast and enter its keys.'];
    if ($p === 'payfast') {
        if (!pay_ready()) return ['ok' => false, 'detail' => 'Enter the PayFast merchant ID and key.'];
        try { $r = http_request('GET', payfast_host() . '/eng/process', [], null, 10); } catch (Throwable $e) { return ['ok' => false, 'detail' => $e->getMessage()]; }
        return ['ok' => true, 'detail' => 'PayFast (' . pay_mode() . ') is reachable. Keys are checked on the first payment. Refunds are paid in the PayFast dashboard and recorded in Refunds.'];
    }
    $k = (string) cfg('payments.yocoSecretKey', '');
    if ($k === '') return ['ok' => false, 'detail' => 'Enter the Yoco secret key.'];
    if (pay_mode() === 'live' && !str_starts_with($k, 'sk_live_')) return ['ok' => false, 'detail' => 'Mode is Live but the key is a test key (sk_test_…).'];
    if (pay_mode() === 'test' && !str_starts_with($k, 'sk_test_')) return ['ok' => false, 'detail' => 'Mode is Test but the key is a live key (sk_live_…).'];
    try { $r = yoco_call('GET', '/api/checkouts/ch_ticketroom_healthcheck'); } catch (Throwable $e) { return ['ok' => false, 'detail' => $e->getMessage()]; }
    if (in_array($r['status'], [401, 403], true)) return ['ok' => false, 'detail' => 'Yoco rejected the secret key.'];
    if ((string) cfg('payments.yocoWebhookSecret', '') === '') return ['ok' => false, 'detail' => 'Key accepted, but the notification address is not registered yet. Save the settings again.'];
    return ['ok' => true, 'detail' => 'Yoco accepted the key and payment notifications are set up (' . pay_mode() . ').'];
}
// Sends a test email or SMS to the admin, straight away.
route('POST', '/api/admin/integrations/:key/test', function ($a) {
    $u = adm_admin();
    limit('integtest', 10, 600, $u['id']);
    if ($a['key'] === 'email') {
        $id = outbox_enqueue(['to' => $u['email'], 'userId' => $u['id'], 'subject' => 'TicketRoom test email', 'body' => "Hi,\n\nThis is a test from Admin portal → Integrations. If you can read it, TicketRoom email works.\n\n-- \nTicketRoom"]);
        outbox_deliver(5);
        $m = row('SELECT status, last_error FROM message_outbox WHERE id = ?', [$id]);
        return ['ok' => ($m['status'] ?? '') === 'sent', 'detail' => ($m['status'] ?? '') === 'sent' ? "Sent to {$u['email']}." : 'Not sent: ' . ($m['last_error'] ?? 'unknown error')];
    }
    if ($a['key'] === 'sms') {
        $b = check(body(), ['phone' => R::phone()]);
        try { sms_send($b['phone'], 'TicketRoom test SMS. If you can read this, SMS works.'); return ['ok' => true, 'detail' => "Sent to {$b['phone']}."]; }
        catch (Throwable $e) { return ['ok' => false, 'detail' => $e->getMessage()]; }
    }
    throw not_found('Nothing to test here.');
});
