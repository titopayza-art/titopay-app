<?php
// Cashless in person: the top-up desk, the cash-up at the end of a shift,
// and guests cashing out what is left on their wristband.
//
// Money at the desk: a guest pays the organiser's desk in cash or on the
// event's own card machine and the desk adds it to their balance. The
// organiser holds that money, so the ledger books it against them:
//   organiser:<org>:event:<ev>:desk_cash   cash taken at the desk (less cash paid out)
//   organiser:<org>:event:<ev>:desk_card   card machine takings at the desk
// Both count in the organiser's event balance (organiser_money), so desk
// money comes off what TicketRoom pays the organiser at settlement.
//
// Cashing out: card refunds go back only to online card top-ups (refunds
// flow, lib/cashless.php); the rest goes by EFT (finance pays) or as cash at
// the venue's cash-out desk while the organiser has it open. Cash-outs hold
// the money (amount plus any fee) until they are paid.
declare(strict_types=1);

const DESK_UNDO_MINUTES = 10;
const CASHOUT_FEES = 'revenue:cashout_fees';

function tr_upgrade_cashdesk(): void
{
    $sql = (string) file_get_contents(TR_APP . '/schema.sql');
    if (!preg_match('/-- cashdesk:begin\n(.*)-- cashdesk:end/s', $sql, $m)) throw new RuntimeException('schema.sql has no cashdesk block. Upload the complete TicketRoom package.');
    db()->exec($m[1]);
}

// ============================================================== settings
function cashout_fee_cents(): int { return max(0, (int) cfg('cashless.cashoutFeeCents', 0)); }
function cashout_dual_cents(): int { return (int) cfg('cashless.dualApprovalCents', 200000); }
function cashless_event_settings(string $eventId): array
{
    $s = row('SELECT * FROM cashless_event_settings WHERE event_id = ?', [$eventId]);
    return ['cashoutDeskOpen' => (bool) ($s['cashout_desk_open'] ?? false),
        'deskDailyCapCents' => (int) ($s['desk_daily_cap_cents'] ?? 0) ?: (int) cfg('cashless.deskDailyCapCents', 2000000)];
}
function cashless_event_settings_save(array $u, array $ev, array $b): array
{
    $now = now_iso();
    $cur = row('SELECT * FROM cashless_event_settings WHERE event_id = ?', [$ev['id']]);
    $open = array_key_exists('cashoutDeskOpen', $b) && $b['cashoutDeskOpen'] !== null ? (int) $b['cashoutDeskOpen'] : (int) ($cur['cashout_desk_open'] ?? 0);
    $cap = array_key_exists('deskDailyCapCents', $b) ? ($b['deskDailyCapCents'] ?: null) : ($cur['desk_daily_cap_cents'] ?? null);
    q('INSERT INTO cashless_event_settings (event_id, cashout_desk_open, desk_daily_cap_cents, updated_by, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT (event_id) DO UPDATE SET cashout_desk_open = excluded.cashout_desk_open, desk_daily_cap_cents = excluded.desk_daily_cap_cents, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
        [$ev['id'], $open, $cap, $u['id'], $now]);
    audit('cashless.settings', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['cashoutDeskOpen' => (bool) $open, 'deskDailyCapCents' => $cap]]);
    return cashless_event_settings($ev['id']);
}
// Guests can cash out once the event is over, or earlier while the organiser
// has the venue's cash-out desk open (near the end of the event).
function cashout_open(array $ev): bool
{
    return to_unix($ev['ends_at']) <= microtime(true) || $ev['status'] === 'cancelled' || cashless_event_settings($ev['id'])['cashoutDeskOpen'];
}
function desk_account(array $ev, string $method): string { return "organiser:{$ev['organiser_id']}:event:{$ev['id']}:desk_$method"; }
// Practice (TEST) money is never paid out for real once payments are live.
function cashout_test_refused(array $c): void
{
    if ((int) $c['test'] === 1 && !pay_test()) throw conflict('This cash-out is practice (TEST) money from before payments went live. It cannot be paid out.', 'test_money');
}

// ============================================================== who may run a desk
// TicketRoom staff (admin, finance, support), the organiser's owners,
// managers and finance people, and gate staff allowed to manage wristbands
// for that event. Managers (organiser owners and managers, TicketRoom admin
// and finance) may also reverse a desk top-up after the undo window.
function desk_access(array $u, string $eventId): array
{
    $ev = row('SELECT e.*, s.can_manage_tags, m.role AS member_role FROM events e
                 LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = ?
                 LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = ? WHERE e.id = ?', [$u['id'], $u['id'], $eventId]);
    if (!$ev) throw not_found('Event not found.');
    if (account_type($u) === 'staff') {
        if (!has_role($u, 'admin', 'finance', 'support')) throw not_found('Event not found.');
        return ['event' => $ev, 'kind' => 'ticketroom', 'manager' => has_role($u, 'admin', 'finance')];
    }
    if (account_type($u) === 'organiser' && in_array($ev['member_role'], ['owner', 'manager', 'finance'], true)) {
        return ['event' => $ev, 'kind' => 'organiser', 'manager' => in_array($ev['member_role'], ['owner', 'manager'], true)];
    }
    if (!empty($ev['can_manage_tags'])) return ['event' => $ev, 'kind' => 'event_staff', 'manager' => false];
    throw not_found('Event not found.');
}
function desk_events(array $u): array
{
    if (account_type($u) === 'staff') {
        $list = rows("SELECT e.id, e.title, e.starts_at, e.ends_at, e.status, e.organiser_id, o.name AS organiser_name FROM events e JOIN organisers o ON o.id = e.organiser_id
                       WHERE e.cashless_enabled = 1 AND e.status IN ('published','completed') AND e.ends_at > ? ORDER BY e.starts_at LIMIT 100", [iso_in(-30 * 86400)]);
    } else {
        $list = rows("SELECT DISTINCT e.id, e.title, e.starts_at, e.ends_at, e.status, e.organiser_id, o.name AS organiser_name FROM events e JOIN organisers o ON o.id = e.organiser_id
                        LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = ? AND s.can_manage_tags = 1
                        LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = ? AND m.role IN ('owner','manager','finance')
                       WHERE e.cashless_enabled = 1 AND e.status IN ('published','completed') AND e.ends_at > ? AND (s.user_id IS NOT NULL OR m.user_id IS NOT NULL)
                       ORDER BY e.starts_at", [$u['id'], $u['id'], iso_in(-30 * 86400)]);
    }
    foreach ($list as &$e) $e += cashless_event_settings($e['id']) + ['ended' => to_unix($e['ends_at']) <= microtime(true)];
    return $list;
}

// ============================================================== finding the guest
function mask_email(string $e): string
{
    [$l, $d] = array_pad(explode('@', $e, 2), 2, '');
    return mb_substr($l, 0, 1) . str_repeat('•', max(1, min(6, mb_strlen($l) - 1))) . '@' . $d;
}
function desk_guest_view(array $ev, string $userId, ?array $tag = null): array
{
    $u = row('SELECT id, full_name, email, phone, status FROM users WHERE id = ?', [$userId]);
    $tag ??= row("SELECT * FROM tags WHERE user_id = ? AND event_id = ? AND status = 'active'", [$userId, $ev['id']]);
    $w = wallet_get($userId, $ev['id']);
    return ['userId' => $u['id'], 'name' => $u['full_name'], 'email' => mask_email($u['email']), 'phone' => $u['phone'] ? substr($u['phone'], 0, 5) . '•••' . substr($u['phone'], -2) : null,
        'balanceCents' => (int) $w['balance_cents'] + (int) $w['test_balance_cents'], 'testBalanceCents' => (int) $w['test_balance_cents'],
        'band' => $tag ? ['displayCode' => tag_display($tag['display_code']), 'status' => $tag['status']] : null];
}
// A band tapped or typed, or the guest's email or mobile number. Only guests
// with a ticket (or a wallet) for this event are found; nothing else is said.
function desk_find_guest(array $ev, string $input): array
{
    $in = trim($input);
    $userId = null; $tag = null;
    if (str_contains($in, '@')) {
        $f = user_by_email($in);
        $userId = $f['id'] ?? null;
    } elseif (preg_match('/^(?:\+?27|0)([6-8]\d{8})$/', (string) preg_replace('/[\s()-]/', '', $in), $m)) {
        $userId = val("SELECT id FROM users WHERE phone = ? AND status = 'active' ORDER BY guest, created_at LIMIT 1", ['+27' . $m[1]]);
    } else {
        $tag = tag_resolve($in);
        if ($tag && $tag['event_id'] === $ev['id'] && $tag['status'] === 'active') $userId = $tag['user_id'];
        elseif ($tag && $tag['event_id'] === $ev['id'] && in_array($tag['status'], ['lost', 'blocked', 'replaced'], true)) throw conflict('This wristband was blocked. Send the guest to the registration desk for a new one; their balance moves with them.', 'tag_blocked');
    }
    desk_guest_check($ev, $userId);
    return desk_guest_view($ev, $userId, $tag && $tag['status'] === 'active' ? $tag : null);
}
function desk_guest_check(array $ev, ?string $userId): void
{
    if (!$userId || !val("SELECT 1 FROM users WHERE id = ? AND status = 'active'", [$userId])
        || (!val("SELECT 1 FROM tickets WHERE owner_user_id = ? AND event_id = ? AND status IN ('valid','used')", [$userId, $ev['id']]) && !val('SELECT 1 FROM cashless_wallets WHERE user_id = ? AND event_id = ?', [$userId, $ev['id']]))) {
        throw not_found('No guest with a ticket for this event matches that. Check the band, email or number.');
    }
}

// ============================================================== desk top-ups
function desk_day_start(): string
{
    return iso_at((float) (new DateTimeImmutable('today', new DateTimeZone('Africa/Johannesburg')))->format('U'));
}
function desk_topup(array $u, array $acc, array $b): array
{
    $ev = $acc['event'];
    $amount = (int) $b['amountCents'];
    $lim = cashless_limits();
    if (!cashless_open_event($ev) || $ev['status'] !== 'published') throw conflict('Cashless payments are not open for this event.', 'cashless_closed');
    if ($amount > $lim['maxTopupCents']) throw conflict('One top-up can be at most ' . rand_short($lim['maxTopupCents']) . '.', 'topup_limits', ['amountCents' => 'Too much for one top-up.']);
    $made = tx(function () use ($u, $acc, $b, $ev, $amount, $lim) {
        $prior = row('SELECT * FROM desk_topups WHERE staff_id = ? AND idempotency_key = ?', [$u['id'], $b['idempotencyKey']]);
        if ($prior) return ['topup' => $prior, 'replay' => true];
        desk_guest_check($ev, $b['userId']);
        if (wallet_total($b['userId'], $ev['id']) + $amount > $lim['maxBalanceCents']) {
            throw conflict('That would take the balance over ' . rand_short($lim['maxBalanceCents']) . '. Choose a smaller amount.', 'balance_cap', ['amountCents' => 'Too much.']);
        }
        $cap = cashless_event_settings($ev['id'])['deskDailyCapCents'];
        $today = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM desk_topups WHERE staff_id = ? AND status = 'confirmed' AND created_at >= ?", [$u['id'], desk_day_start()]);
        if ($today + $amount > $cap) throw conflict('That is over your desk limit for today (' . rand_short($cap) . '). Ask the organiser to raise it.', 'desk_cap');
        $test = pay_test();
        $t = insert('desk_topups', ['id' => uuid(), 'reference' => reference('DT'), 'event_id' => $ev['id'], 'organiser_id' => $ev['organiser_id'], 'user_id' => $b['userId'],
            'tag_id' => val("SELECT id FROM tags WHERE user_id = ? AND event_id = ? AND status = 'active'", [$b['userId'], $ev['id']]) ?: null,
            'method' => $b['method'], 'amount_cents' => $amount, 'status' => 'confirmed', 'staff_id' => $u['id'], 'staff_kind' => $acc['kind'],
            'idempotency_key' => $b['idempotencyKey'], 'test' => $test ? 1 : 0, 'created_at' => now_iso()]);
        wallet_credit($b['userId'], $ev['id'], $amount, $test);
        ledger_post('desk_topup', $t['reference'], [[desk_account($ev, $b['method']), $amount], [wallet_account($b['userId'], $ev['id']), -$amount]], $test);
        audit('wallet.desk_topup', ['actor' => $u, 'entityType' => 'desk_topup', 'entityId' => $t['id'], 'organiserId' => $ev['organiser_id'],
            'details' => ['reference' => $t['reference'], 'amount' => $amount, 'method' => $b['method'], 'guest' => $b['userId'], 'test' => $test]]);
        if (!empty($b['receipt'])) desk_receipt($t, $ev);
        return ['topup' => $t];
    });
    $t = $made['topup'];
    return ['topup' => desk_topup_view($t), 'replay' => !empty($made['replay']), 'guest' => desk_guest_view($ev, $t['user_id'])];
}
function desk_topup_view(array $t): array
{
    return ['reference' => $t['reference'], 'amountCents' => (int) $t['amount_cents'], 'method' => $t['method'], 'status' => $t['status'], 'test' => (int) $t['test'] === 1,
        'createdAt' => $t['created_at'], 'undoUntil' => iso_at(to_unix($t['created_at']) + DESK_UNDO_MINUTES * 60)];
}
// A receipt by email, and by SMS too when the guest has a mobile number and SMS is set up.
function desk_receipt(array $t, array $ev): void
{
    $g = row('SELECT email, full_name, phone FROM users WHERE id = ?', [$t['user_id']]);
    $bal = wallet_total($t['user_id'], $ev['id']);
    $a = ['name' => $g['full_name'], 'event' => $ev, 'amountCents' => (int) $t['amount_cents'], 'balanceCents' => $bal, 'reference' => $t['reference'], 'method' => $t['method'], 'test' => (int) $t['test'] === 1];
    outbox_enqueue(['to' => $g['email'], 'userId' => $t['user_id']] + tpl('deskTopup', $a));
    if ($g['phone'] && sms_ready()) {
        outbox_enqueue(['channel' => 'sms', 'to' => $g['phone'], 'userId' => $t['user_id'],
            'body' => ((int) $t['test'] === 1 ? 'TEST ' : '') . "TicketRoom: R" . number_format($t['amount_cents'] / 100, 2, '.', ' ') . " added to your {$ev['title']} wristband. Balance R" . number_format($bal / 100, 2, '.', ' ') . ". Ref {$t['reference']}"]);
    }
}
// Undo a mistake at the desk: the same person, within DESK_UNDO_MINUTES,
// and only if the money is still on the band. After that a manager can
// reverse it, with a reason; never below what the guest has left.
function desk_undo(array $u, array $acc, string $ref, ?string $reason, bool $asManager): array
{
    $ev = $acc['event'];
    return tx(function () use ($u, $acc, $ref, $reason, $asManager, $ev) {
        $t = row('SELECT * FROM desk_topups WHERE reference = ? AND event_id = ?', [strtoupper($ref), $ev['id']]);
        if (!$t) throw not_found('Top-up not found.');
        if ($t['status'] !== 'confirmed') throw conflict('This top-up was already undone.', 'bad_transition');
        if ($asManager) {
            if (!$acc['manager']) throw forbidden('Only the organiser or TicketRoom can reverse a top-up after ' . DESK_UNDO_MINUTES . ' minutes.');
            if (!$reason) throw bad('Say why, for the record.', ['reason' => 'Required.']);
        } else {
            if ($t['staff_id'] !== $u['id']) throw forbidden('Only the person who made this top-up can undo it. Ask a manager to reverse it.');
            if (to_unix($t['created_at']) < microtime(true) - DESK_UNDO_MINUTES * 60) throw conflict('The ' . DESK_UNDO_MINUTES . ' minutes to undo have passed. Ask a manager to reverse it.', 'undo_window_passed');
        }
        $test = (int) $t['test'] === 1;
        if (!wallet_debit($t['user_id'], $ev['id'], (int) $t['amount_cents'], $test)) throw conflict('The guest has already spent some of this money, so it cannot be taken back.', 'already_spent');
        $status = $asManager ? 'reversed' : 'undone';
        q('UPDATE desk_topups SET status = ?, undone_at = ?, undone_by = ?, undo_reason = ? WHERE id = ?', [$status, now_iso(), $u['id'], $reason, $t['id']]);
        ledger_post('desk_topup_' . $status, $t['reference'], [[wallet_account($t['user_id'], $ev['id']), (int) $t['amount_cents']], [desk_account($ev, $t['method']), -(int) $t['amount_cents']]], $test);
        audit("wallet.desk_topup_$status", ['actor' => $u, 'entityType' => 'desk_topup', 'entityId' => $t['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['reference' => $t['reference'], 'amount' => (int) $t['amount_cents'], 'reason' => $reason]]);
        return ['topup' => desk_topup_view(row('SELECT * FROM desk_topups WHERE id = ?', [$t['id']])), 'guest' => desk_guest_view($ev, $t['user_id'])];
    });
}

// ============================================================== cash-up
// One desk's shift: what came in by cash and by card, what was undone, and
// cash paid out to guests. "Cash in the drawer" is cash taken less cash paid out.
function desk_cashup_for(string $eventId, string $staffId, ?string $since = null): array
{
    $since ??= '0000';
    $t = row("SELECT COALESCE(SUM(CASE WHEN method = 'cash' AND status = 'confirmed' THEN amount_cents ELSE 0 END),0) AS cash_cents,
                     COALESCE(SUM(CASE WHEN method = 'cash' AND status = 'confirmed' THEN 1 ELSE 0 END),0) AS cash_count,
                     COALESCE(SUM(CASE WHEN method = 'card' AND status = 'confirmed' THEN amount_cents ELSE 0 END),0) AS card_cents,
                     COALESCE(SUM(CASE WHEN method = 'card' AND status = 'confirmed' THEN 1 ELSE 0 END),0) AS card_count,
                     COALESCE(SUM(CASE WHEN status <> 'confirmed' THEN 1 ELSE 0 END),0) AS undone_count,
                     COALESCE(SUM(CASE WHEN status <> 'confirmed' THEN amount_cents ELSE 0 END),0) AS undone_cents,
                     COALESCE(SUM(CASE WHEN test = 1 AND status = 'confirmed' THEN amount_cents ELSE 0 END),0) AS test_cents
                FROM desk_topups WHERE event_id = ? AND staff_id = ? AND created_at >= ?", [$eventId, $staffId, $since]);
    $t = array_map('intval', $t);
    $out = row("SELECT COALESCE(SUM(amount_cents),0) AS c, COUNT(*) AS n FROM wallet_cashouts WHERE event_id = ? AND paid_by = ? AND method = 'cash' AND status = 'paid' AND paid_at >= ?", [$eventId, $staffId, $since]);
    $t['cash_paid_out_cents'] = (int) $out['c'];
    $t['cash_paid_out_count'] = (int) $out['n'];
    $t['drawer_cents'] = $t['cash_cents'] - $t['cash_paid_out_cents'];
    $t['total_cents'] = $t['cash_cents'] + $t['card_cents'];
    return $t;
}
function desk_cashup(array $u, array $acc): array
{
    $ev = $acc['event'];
    $mine = desk_cashup_for($ev['id'], $u['id']) + ['name' => $u['fullName']];
    $items = array_map(fn($t) => desk_topup_view($t) + ['guest' => $t['full_name']], rows('SELECT d.*, u.full_name FROM desk_topups d JOIN users u ON u.id = d.user_id WHERE d.event_id = ? AND d.staff_id = ? ORDER BY d.created_at DESC LIMIT 300', [$ev['id'], $u['id']]));
    $out = ['event' => ['id' => $ev['id'], 'title' => $ev['title']], 'mine' => $mine, 'items' => $items, 'generatedAt' => now_iso(), 'manager' => $acc['manager'] || $acc['kind'] !== 'event_staff'];
    // The organiser (and TicketRoom) see every desk at the event.
    if ($acc['kind'] !== 'event_staff') {
        $desks = [];
        foreach (rows('SELECT DISTINCT staff_id FROM desk_topups WHERE event_id = ? UNION SELECT DISTINCT paid_by FROM wallet_cashouts WHERE event_id = ? AND method = \'cash\' AND paid_by IS NOT NULL', [$ev['id'], $ev['id']]) as $r) {
            $who = row('SELECT full_name, email FROM users WHERE id = ?', [$r['staff_id']]);
            $desks[] = desk_cashup_for($ev['id'], $r['staff_id']) + ['staffId' => $r['staff_id'], 'name' => $who['full_name'], 'email' => $who['email']];
        }
        $out['desks'] = $desks;
        $out['totals'] = array_reduce($desks, function ($c, $d) { foreach (['cash_cents', 'card_cents', 'cash_count', 'card_count', 'cash_paid_out_cents', 'drawer_cents', 'total_cents'] as $k) $c[$k] = ($c[$k] ?? 0) + $d[$k]; return $c; }, []);
    }
    return $out;
}

// ============================================================== guest cash-out
// What the account's wallet page offers.
function cashout_options(array $u, array $ev): array
{
    $w = wallet_get($u['id'], $ev['id']);
    $total = (int) $w['balance_cents'] + (int) $w['test_balance_cents'];
    $card = min((int) $w['balance_cents'], wallet_card_refundable($u['id'], $ev['id'], false)) + min((int) $w['test_balance_cents'], wallet_card_refundable($u['id'], $ev['id'], true));
    $pending = array_map('cashout_view', rows("SELECT * FROM wallet_cashouts WHERE user_id = ? AND event_id = ? AND status IN ('requested','approved_once','approved') ORDER BY created_at DESC", [$u['id'], $ev['id']]));
    return ['open' => cashout_open($ev), 'balanceCents' => $total, 'feeCents' => cashout_fee_cents(),
        'card' => ['maxCents' => $card], 'eft' => ['maxCents' => max(0, $total - cashout_fee_cents())],
        'cash' => ['open' => cashless_event_settings($ev['id'])['cashoutDeskOpen'], 'maxCents' => max(0, $total - cashout_fee_cents())],
        'pending' => $pending, 'refundPolicy' => $ev['refund_policy'] ?? null];
}
function cashout_view(array $c): array
{
    $v = ['reference' => $c['reference'], 'method' => $c['method'], 'amountCents' => (int) $c['amount_cents'], 'feeCents' => (int) $c['fee_cents'], 'status' => $c['status'],
        'createdAt' => $c['created_at'], 'paidAt' => $c['paid_at'], 'test' => (int) $c['test'] === 1, 'bank' => $c['bank_account_last4'] ? "{$c['bank_name']} ••••{$c['bank_account_last4']}" : null];
    if ($c['method'] === 'cash' && in_array($c['status'], ['requested'], true) && $c['code_enc']) {
        $code = decrypt_str($c['code_enc']);
        $v['code'] = substr($code, 0, 4) . '-' . substr($code, 4);
        $v['qrPayload'] = "TRC1.$code";
    }
    return $v;
}
function cashout_code_hash(string $code): string { return hash_hmac('sha256', 'cashout|' . strtoupper(str_replace('-', '', $code)), hex2bin(key_hex('data'))); }
// EFT to the guest's bank account, or cash at the venue's cash-out desk. The
// whole balance goes (less any fee); real and practice money go separately.
function cashout_request(array $u, string $eventId, string $method, ?array $bank): array
{
    return tx(function () use ($u, $eventId, $method, $bank) {
        $ev = row('SELECT * FROM events WHERE id = ?', [$eventId]);
        if (!$ev) throw not_found('Event not found.');
        if (!cashout_open($ev)) throw conflict('Cash-outs open when the event is over, or when the organiser opens the cash-out desk.', 'cashout_closed');
        if ($method === 'cash' && !cashless_event_settings($ev['id'])['cashoutDeskOpen']) throw conflict('The cash-out desk at the venue is closed. Choose your card or EFT instead.', 'cashout_desk_closed');
        if (val("SELECT 1 FROM wallet_cashouts WHERE user_id = ? AND event_id = ? AND status IN ('requested','approved_once','approved')", [$u['id'], $eventId])) {
            throw conflict('You already have a cash-out on its way for this event.', 'cashout_in_progress');
        }
        $w = wallet_get($u['id'], $eventId);
        $fee = cashout_fee_cents();
        $made = [];
        foreach ([false, true] as $test) {
            $portion = (int) ($test ? $w['test_balance_cents'] : $w['balance_cents']);
            if ($portion <= 0) continue;
            $f = $made ? 0 : $fee; // one fee per cash-out
            if ($portion <= $f) throw conflict('Your balance is smaller than the ' . rand_short($fee) . ' cash-out fee.', 'balance_below_fee');
            if (!wallet_debit($u['id'], $eventId, $portion, $test)) throw conflict('Your balance just changed. Please try again.', 'balance_changed');
            $now = now_iso();
            $row = ['id' => uuid(), 'reference' => reference('CO'), 'event_id' => $eventId, 'user_id' => $u['id'], 'method' => $method, 'amount_cents' => $portion - $f, 'fee_cents' => $f,
                'test' => $test ? 1 : 0, 'status' => 'requested', 'created_at' => $now, 'updated_at' => $now];
            if ($method === 'eft') {
                $digits = (string) preg_replace('/\D/', '', $bank['accountNumber']);
                $row += ['bank_account_holder' => $bank['accountHolder'], 'bank_name' => $bank['bankName'], 'bank_branch_code' => $bank['branchCode'],
                    'bank_account_enc' => encrypt_str($digits), 'bank_account_last4' => substr($digits, -4)];
            } else {
                do { $code = random_code(8); } while (val('SELECT 1 FROM wallet_cashouts WHERE code_hash = ?', [cashout_code_hash($code)]));
                $row += ['code_hash' => cashout_code_hash($code), 'code_enc' => encrypt_str($code)];
            }
            $made[] = insert('wallet_cashouts', $row);
        }
        if (!$made) throw conflict('There is no balance to cash out.', 'nothing_to_refund');
        audit('wallet.cashout_requested', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $made[0]['id'], 'organiserId' => $ev['organiser_id'],
            'details' => ['method' => $method, 'amount' => array_sum(array_column($made, 'amount_cents')), 'fee' => array_sum(array_column($made, 'fee_cents'))]]);
        return array_map('cashout_view', $made);
    });
}
// Money that has not been paid out goes back on the balance.
function cashout_restore(array $c): void
{
    wallet_credit($c['user_id'], $c['event_id'], (int) $c['amount_cents'] + (int) $c['fee_cents'], (int) $c['test'] === 1);
}
function cashout_cancel(array $u, string $ref): array
{
    return tx(function () use ($u, $ref) {
        $c = row("SELECT * FROM wallet_cashouts WHERE reference = ? AND user_id = ? AND status IN ('requested','approved_once')", [strtoupper($ref), $u['id']]);
        if (!$c) throw conflict('This cash-out can no longer be cancelled.', 'bad_transition');
        q("UPDATE wallet_cashouts SET status = 'cancelled', updated_at = ? WHERE id = ?", [now_iso(), $c['id']]);
        cashout_restore($c);
        audit('wallet.cashout_cancelled', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id']]);
        return cashout_view(row('SELECT * FROM wallet_cashouts WHERE id = ?', [$c['id']]));
    });
}
// Inside a transaction: the money left TicketRoom's hands (EFT) or the organiser's desk (cash).
function cashout_book_paid(array $c, string $from): void
{
    $amount = (int) $c['amount_cents'];
    $fee = (int) $c['fee_cents'];
    ledger_post('wallet_cashout', $c['reference'], [[wallet_account($c['user_id'], $c['event_id']), $amount + $fee], [$from, -$amount], [CASHOUT_FEES, -$fee]], (int) $c['test'] === 1);
}
// The venue's cash-out desk: the guest shows their code, the desk pays cash.
function cashout_desk_find(array $acc, string $code): array
{
    $clean = strtoupper((string) preg_replace('/^TRC1\./i', '', trim($code)));
    $c = row('SELECT c.*, u.full_name FROM wallet_cashouts c JOIN users u ON u.id = c.user_id WHERE c.code_hash = ? AND c.event_id = ?', [cashout_code_hash($clean), $acc['event']['id']]);
    if (!$c) throw not_found('That cash-out code is not for this event. Ask the guest to open their wallet and show the code again.');
    return $c;
}
function cashout_desk_pay(array $u, array $acc, string $code): array
{
    $ev = $acc['event'];
    if (!cashless_event_settings($ev['id'])['cashoutDeskOpen']) throw conflict('The cash-out desk is closed. The organiser opens it under Vendors & POS.', 'cashout_desk_closed');
    return tx(function () use ($u, $acc, $code, $ev) {
        $c = cashout_desk_find($acc, $code);
        if ($c['status'] === 'paid') throw conflict('This cash-out was already paid at ' . time_str($c['paid_at']) . '.', 'already_paid');
        if ($c['status'] !== 'requested' || $c['method'] !== 'cash') throw conflict('This cash-out cannot be paid at the desk.', 'bad_transition');
        cashout_test_refused($c);
        $amount = (int) $c['amount_cents'];
        // Large amounts need two people, which a desk cannot give: they go by EFT.
        if ($amount >= cashout_dual_cents()) throw conflict('This cash-out is ' . rand_short($amount) . ', more than a desk pays in cash. Ask the guest to cancel it in their wallet and choose EFT: two people in finance approve it.', 'cashout_too_large');
        // Each desk pays out at most its daily limit in cash.
        $cap = cashless_event_settings($ev['id'])['deskDailyCapCents'];
        $paid = (int) val("SELECT COALESCE(SUM(amount_cents),0) FROM wallet_cashouts WHERE paid_by = ? AND event_id = ? AND method = 'cash' AND status = 'paid' AND paid_at >= ?", [$u['id'], $ev['id'], desk_day_start()]);
        if ($paid + $amount > $cap) throw conflict('That is over your cash-out limit for today (' . rand_short($cap) . '). Ask another desk to pay it, or the guest can choose EFT.', 'desk_cashout_cap');
        $now = now_iso();
        if (affected("UPDATE wallet_cashouts SET status = 'paid', paid_by = ?, paid_at = ?, updated_at = ? WHERE id = ? AND status = 'requested'", [$u['id'], $now, $now, $c['id']]) !== 1) throw conflict('This cash-out cannot be paid at the desk.', 'bad_transition');
        cashout_book_paid($c, desk_account($ev, 'cash'));
        audit('wallet.cashout_paid', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['method' => 'cash', 'amount' => (int) $c['amount_cents']]]);
        return cashout_view(row('SELECT * FROM wallet_cashouts WHERE id = ?', [$c['id']])) + ['name' => $c['full_name']];
    });
}
// Finance approves EFT cash-outs; large ones need two different people.
function cashout_decide(array $u, string $id, bool $approve, ?string $note): array
{
    return tx(function () use ($u, $id, $approve, $note) {
        $c = row("SELECT * FROM wallet_cashouts WHERE id = ? AND method = 'eft'", [$id]);
        if (!$c) throw not_found('Cash-out not found.');
        if (!in_array($c['status'], ['requested', 'approved_once'], true)) throw conflict('This cash-out has already been decided.', 'bad_transition');
        if ($approve) cashout_test_refused($c);
        $now = now_iso();
        if (!$approve) {
            q("UPDATE wallet_cashouts SET status = 'rejected', note = ?, approved_by = ?, updated_at = ? WHERE id = ?", [$note, $u['id'], $now, $c['id']]);
            cashout_restore($c);
            $g = row('SELECT email, full_name FROM users WHERE id = ?', [$c['user_id']]);
            outbox_enqueue(['to' => $g['email'], 'userId' => $c['user_id']] + tpl('cashoutRejected', ['name' => $g['full_name'], 'reference' => $c['reference'], 'amountCents' => (int) $c['amount_cents'], 'note' => (string) $note]));
            audit('wallet.cashout_rejected', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id'], 'details' => ['note' => $note]]);
        } elseif ((int) $c['amount_cents'] >= cashout_dual_cents() && $c['status'] === 'requested') {
            q("UPDATE wallet_cashouts SET status = 'approved_once', first_approved_by = ?, updated_at = ? WHERE id = ?", [$u['id'], $now, $c['id']]);
            audit('wallet.cashout_approved_once', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id']]);
        } else {
            if ($c['status'] === 'approved_once' && $c['first_approved_by'] === $u['id']) throw forbidden('A second person in finance must approve a cash-out this large.');
            q("UPDATE wallet_cashouts SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?", [$u['id'], $now, $c['id']]);
            audit('wallet.cashout_approved', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id']]);
        }
        return row('SELECT * FROM wallet_cashouts WHERE id = ?', [$c['id']]);
    });
}
function cashout_mark_paid(array $u, string $id, string $bankRef): array
{
    return tx(function () use ($u, $id, $bankRef) {
        $c = row("SELECT * FROM wallet_cashouts WHERE id = ? AND method = 'eft' AND status = 'approved'", [$id]);
        if (!$c) throw conflict('Only approved EFT cash-outs can be recorded as paid.', 'bad_transition');
        cashout_test_refused($c);
        $now = now_iso();
        q("UPDATE wallet_cashouts SET status = 'paid', bank_reference = ?, paid_by = ?, paid_at = ?, updated_at = ? WHERE id = ?", [$bankRef, $u['id'], $now, $now, $c['id']]);
        cashout_book_paid($c, 'bank:payouts');
        $g = row('SELECT email, full_name FROM users WHERE id = ?', [$c['user_id']]);
        $ev = row('SELECT title FROM events WHERE id = ?', [$c['event_id']]);
        outbox_enqueue(['to' => $g['email'], 'userId' => $c['user_id']] + tpl('cashoutPaid', ['name' => $g['full_name'], 'reference' => $c['reference'], 'amountCents' => (int) $c['amount_cents'],
            'event' => $ev, 'bank' => "{$c['bank_name']} ••••{$c['bank_account_last4']}"]));
        audit('wallet.cashout_paid', ['actor' => $u, 'entityType' => 'wallet_cashout', 'entityId' => $c['id'], 'details' => ['method' => 'eft', 'amount' => (int) $c['amount_cents'], 'bankReference' => $bankRef]]);
        return row('SELECT * FROM wallet_cashouts WHERE id = ?', [$c['id']]);
    });
}
function cashout_rows(string $where, array $p): array
{
    return array_map(function ($c) {
        unset($c['bank_account_enc'], $c['code_hash'], $c['code_enc']);
        foreach (['amount_cents', 'fee_cents', 'test'] as $k) $c[$k] = (int) $c[$k];
        $c['needs_second'] = $c['status'] === 'approved_once';
        $c['dual'] = $c['amount_cents'] >= cashout_dual_cents();
        return $c;
    }, rows("SELECT c.*, u.full_name AS guest_name, u.email AS guest_email, e.title AS event_title, f.full_name AS first_approved_by_name
               FROM wallet_cashouts c JOIN users u ON u.id = c.user_id JOIN events e ON e.id = c.event_id LEFT JOIN users f ON f.id = c.first_approved_by
              WHERE $where ORDER BY c.created_at DESC LIMIT 300", $p));
}

// ============================================================== reminders
// When a cashless event is over, everyone with money left gets one email with
// a one-tap link to cash out (background job).
function cashout_reminders(): int
{
    $n = 0;
    foreach (rows("SELECT w.user_id, w.event_id, w.balance_cents + w.test_balance_cents AS bal, u.email, u.full_name, e.title, e.refund_policy FROM cashless_wallets w
                     JOIN events e ON e.id = w.event_id JOIN users u ON u.id = w.user_id
                    WHERE (w.balance_cents > 0 OR w.test_balance_cents > 0) AND e.ends_at < ? AND e.ends_at > ? AND u.status = 'active' LIMIT 300", [now_iso(), iso_in(-30 * 86400)]) as $w) {
        if (notify_once("cashout-reminder:{$w['user_id']}:{$w['event_id']}", ['to' => $w['email'], 'userId' => $w['user_id']] + tpl('cashoutReminder', ['name' => $w['full_name'], 'event' => ['title' => $w['title']],
            'balanceCents' => (int) $w['bal'], 'url' => base_url() . "/account#/wallet/{$w['event_id']}", 'policy' => $w['refund_policy'], 'days' => (int) cfg('cashless.autoRefundAfterDays', 14)]))) $n++;
    }
    return $n;
}
