<?php
// Event teams: the people an organiser (or a TicketRoom admin, from the admin
// portal) adds to one event to scan tickets, run the wristband desk and
// sell at the door. One set of rules, invites and emails for both portals.
//
// Team activity: what each person did at the event, built from the records
// the gate, the desks and the box office already keep (admission_log,
// tag_events, desk_topups, wallet_cashouts, door_tenders, door_shifts), so the
// money always matches the desk cash-up and the box office shift reports.
declare(strict_types=1);

// Who added someone: the organiser's own team, or TicketRoom.
function team_actor_kind(array $u): string { return account_type($u) === 'staff' ? 'ticketroom' : 'organiser'; }

function team_list(array $event): array
{
    return rows("SELECT u.id, u.full_name, u.email, s.can_scan, s.can_manage_tags, s.can_sell_tickets, s.created_at,
                        CASE WHEN ab.account_type = 'staff' THEN 1 ELSE 0 END AS added_by_ticketroom,
                        (SELECT count(*) FROM admission_log a WHERE a.scanned_by = u.id AND a.event_id = s.event_id AND a.outcome = 'admitted') AS admitted
                   FROM event_staff s JOIN users u ON u.id = s.user_id LEFT JOIN users ab ON ab.id = s.added_by
                  WHERE s.event_id = ? ORDER BY s.created_at", [$event['id']]);
}

// Still allowed to scan at this event: on its gate team, or the organiser's owner or manager.
function team_can_scan(string $userId, string $eventId): bool
{
    return (bool) val("SELECT 1 FROM events e JOIN users u ON u.id = ? AND u.status = 'active' AND u.account_type <> 'staff'
                         LEFT JOIN event_staff s ON s.event_id = e.id AND s.user_id = u.id AND s.can_scan = 1
                         LEFT JOIN organiser_members m ON m.organiser_id = e.organiser_id AND m.user_id = u.id AND m.role IN ('owner','manager')
                        WHERE e.id = ? AND (s.user_id IS NOT NULL OR m.user_id IS NOT NULL)", [$userId, $eventId]);
}

// Add someone, or change what they may do. Someone without an account is
// created and emailed an invite to set their password (link valid 7 days);
// someone with an account is told they were added.
function team_set(array $u, array $event, array $org, array $body): array
{
    $by = team_actor_kind($u);
    if (($org['status'] ?? '') !== 'approved') {
        if ($by === 'organiser') org_require_approved($org);
        throw conflict('This organiser is not approved yet, so people cannot be added to its events.', 'organiser_not_approved');
    }
    $b = check($body, ['email' => R::email(), 'fullName' => R::str(['optional' => true, 'min' => 2, 'max' => 120]),
        'canScan' => org_bool(['optional' => true, 'fallback' => true]), 'canManageTags' => R::bool(), 'canSellTickets' => R::bool(['optional' => true, 'fallback' => false])]);
    $found = user_by_email($b['email']);
    if ($found && $found['status'] !== 'active') throw conflict('That account is suspended or closed, so it cannot scan tickets.', 'account_inactive');
    if ($found && account_type($found) === 'staff') throw conflict('That email belongs to a TicketRoom staff account. Scanners need their own email.', 'staff_account', ['email' => 'Use a different email.']);
    $uid = $found['id'] ?? null;
    $invited = false;
    $before = $uid ? row('SELECT can_scan, can_manage_tags, can_sell_tickets FROM event_staff WHERE event_id = ? AND user_id = ?', [$event['id'], $uid]) : null;
    // Someone new, or someone who has only bought tickets as a guest, gets an email to set a password.
    if (!$uid || (int) $found['guest'] === 1) {
        $token = random_token(32);
        $name = $b['fullName'] ?? ($found['full_name'] ?? explode('@', $b['email'])[0]);
        $uid = tx(function () use ($u, $b, $token, $name, $event, $org, $uid, $by) {
            $now = now_iso();
            if (!$uid) $uid = insert('users', ['id' => uuid(), 'email' => $b['email'], 'email_key' => email_key($b['email']), 'full_name' => $name, 'password_hash' => hash_secret(random_token(24)), 'status' => 'active', 'account_type' => 'customer', 'created_at' => $now, 'updated_at' => $now])['id'];
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $uid, 'expires_at' => iso_in(7 * 86400), 'created_at' => $now]);
            outbox_enqueue(['to' => $b['email'], 'userId' => $uid] + tpl('staffInvite', ['name' => $name, 'organiser' => $org['name'], 'event' => $event['title'], 'url' => base_url() . "/scan#/reset/$token",
                'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags'], 'canSellTickets' => $b['canSellTickets']]));
            audit('staff.invited', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $event['organiser_id'], 'details' => ['eventId' => $event['id'], 'by' => $by]]);
            return $uid;
        });
        $invited = true;
    }
    q('INSERT INTO event_staff (event_id, user_id, can_scan, can_manage_tags, can_sell_tickets, added_by, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (event_id, user_id) DO UPDATE SET can_scan = excluded.can_scan, can_manage_tags = excluded.can_manage_tags, can_sell_tickets = excluded.can_sell_tickets',
        [$event['id'], $uid, $b['canScan'], $b['canManageTags'], $b['canSellTickets'], $u['id'], now_iso()]);
    $details = ['eventId' => $event['id'], 'by' => $by, 'change' => $before ? 'updated' : 'added', 'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags'], 'canSellTickets' => $b['canSellTickets']];
    if ($before) $details['before'] = ['canScan' => (bool) $before['can_scan'], 'canManageTags' => (bool) $before['can_manage_tags'], 'canSellTickets' => (bool) $before['can_sell_tickets']];
    audit('event.staff_set', ['actor' => $u, 'entityType' => 'user', 'entityId' => $uid, 'organiserId' => $event['organiser_id'], 'details' => $details]);
    // Someone who already has an account is told they were added, and how to
    // be taken off the team if they did not expect it.
    if (!$invited && !$before) {
        outbox_enqueue(['to' => $found['email'], 'userId' => $uid] + tpl('staffAdded', ['name' => $found['full_name'], 'organiser' => $org['name'], 'event' => $event['title'],
            'canScan' => $b['canScan'], 'canManageTags' => $b['canManageTags'], 'canSellTickets' => $b['canSellTickets']]));
    }
    return ['ok' => true, 'invited' => $invited, 'updated' => (bool) $before, 'userId' => $uid];
}

function team_remove(array $u, array $event, string $userId): array
{
    $before = row('SELECT can_scan, can_manage_tags, can_sell_tickets FROM event_staff WHERE event_id = ? AND user_id = ?', [$event['id'], $userId]);
    q('DELETE FROM event_staff WHERE event_id = ? AND user_id = ?', [$event['id'], $userId]);
    $details = ['eventId' => $event['id'], 'by' => team_actor_kind($u), 'removed' => (bool) $before];
    if ($before) $details['before'] = ['canScan' => (bool) $before['can_scan'], 'canManageTags' => (bool) $before['can_manage_tags'], 'canSellTickets' => (bool) $before['can_sell_tickets']];
    audit('event.staff_removed', ['actor' => $u, 'entityType' => 'user', 'entityId' => $userId, 'organiserId' => $event['organiser_id'], 'details' => $details]);
    return ['ok' => true];
}

// ============================================================== activity
// Every staff action at one event, newest first, as one list:
// kind (scan, wristband, topup, cashout, box_office), action, when, who,
// gate, amount, payment method, reference, detail and the offline flag.
const TEAM_KINDS = ['scan', 'wristband', 'topup', 'cashout', 'box_office'];
const TEAM_TAG_ACTIONS = "(g.action IN ('replaced','status:blocked','status:active','status:revoked') OR (g.action = 'linked' AND json_extract(g.details, '$.via') = 'desk'))";
function team_actions_sql(): string
{
    $door = 'JOIN door_shifts s ON s.id = t.shift_id AND s.retail_partner_id IS NULL';
    return "SELECT 'scan' AS kind, COALESCE(a.reason, a.outcome) AS action, a.occurred_at AS at, a.scanned_by AS uid, a.gate AS place, NULL AS amount_cents, NULL AS method, NULL AS ref,
                   COALESCE(tk.holder_name, gp.holder_name) AS detail, a.offline AS offline, a.synced_at AS synced_at
              FROM admission_log a LEFT JOIN tickets tk ON tk.id = a.ticket_id LEFT JOIN gate_passes gp ON gp.id = a.pass_id WHERE a.event_id = :ev
            UNION ALL
            SELECT 'wristband', CASE g.action WHEN 'linked' THEN 'linked' WHEN 'replaced' THEN 'replaced' WHEN 'status:blocked' THEN 'blocked' WHEN 'status:active' THEN 'unblocked' ELSE 'cancelled' END,
                   g.occurred_at, g.actor_id, NULL, NULL, NULL, tg.display_code, json_extract(g.details, '$.reason'), 0, NULL
              FROM tag_events g JOIN tags tg ON tg.id = g.tag_id WHERE tg.event_id = :ev AND g.actor_id IS NOT NULL AND " . TEAM_TAG_ACTIONS . "
            UNION ALL
            SELECT 'topup', 'topup', d.created_at, d.staff_id, NULL, d.amount_cents, d.method, d.reference, d.status, 0, NULL FROM desk_topups d WHERE d.event_id = :ev
            UNION ALL
            SELECT 'topup', 'topup_' || d.status, d.undone_at, d.undone_by, NULL, d.amount_cents, d.method, d.reference, d.undo_reason, 0, NULL FROM desk_topups d WHERE d.event_id = :ev AND d.undone_by IS NOT NULL
            UNION ALL
            SELECT 'cashout', 'cashout_paid', c.paid_at, c.paid_by, NULL, c.amount_cents, 'cash', c.reference, NULL, 0, NULL
              FROM wallet_cashouts c WHERE c.event_id = :ev AND c.method = 'cash' AND c.status = 'paid' AND c.paid_by IS NOT NULL
            UNION ALL
            SELECT 'box_office', 'sale', t.created_at, t.cashier_id, NULL, t.amount_cents, t.method, t.receipt_reference,
                   (SELECT SUM(quantity) FROM order_items i WHERE i.order_id = t.order_id), 0, NULL FROM door_tenders t $door WHERE t.event_id = :ev
            UNION ALL
            SELECT 'box_office', 'sale_refunded', COALESCE(r.completed_at, r.updated_at), t.cashier_id, NULL, r.amount_cents + r.fee_refund_cents, t.method, t.receipt_reference, r.reference, 0, NULL
              FROM refunds r JOIN door_tenders t ON t.payment_id = r.payment_id $door WHERE t.event_id = :ev AND r.status = 'completed'
            UNION ALL
            SELECT 'box_office', 'sale_cancelled', i.created_at, i.cashier_id, NULL, o.total_cents, i.tender_method, o.reference, NULL, 0, NULL
              FROM door_order_intents i JOIN orders o ON o.id = i.order_id
             WHERE i.event_id = :ev AND i.retail_partner_id IS NULL AND (i.status = 'cancelled' OR (i.status = 'awaiting_tender' AND o.status <> 'pending_payment'))
            UNION ALL
            SELECT 'box_office', 'shift_opened', s.opened_at, s.cashier_id, NULL, s.opening_float_cents, NULL, NULL, NULL, 0, NULL FROM door_shifts s WHERE s.event_id = :ev AND s.retail_partner_id IS NULL
            UNION ALL
            SELECT 'box_office', 'shift_closed', s.closed_at, s.cashier_id, NULL, s.counted_cash_cents, NULL, NULL, s.cash_variance_cents, 0, NULL
              FROM door_shifts s WHERE s.event_id = :ev AND s.retail_partner_id IS NULL AND s.status = 'closed'";
}

// Refused scans, grouped the way the gate explained them.
const TEAM_REFUSED = ['already_used' => 'Already scanned', 'not_valid' => 'Not valid', 'replaced' => 'Replaced code', 'refund_pending' => 'Refund in progress',
    'wrong_event' => 'Wrong event', 'not_open' => 'Event not open'];
function team_refused_key(string $reason): string
{
    return match ($reason) {
        'already_used' => 'already_used', 'replaced' => 'replaced', 'refund_pending' => 'refund_pending', 'wrong_event' => 'wrong_event', 'event_not_live' => 'not_open',
        default => 'not_valid', // invalid, not found, test ticket, resold, listed for resale, cancelled, refunded
    };
}

function team_blank(): array
{
    return ['scans' => ['admitted' => 0, 'refused' => array_fill_keys(array_keys(TEAM_REFUSED), 0), 'refusedTotal' => 0, 'offline' => 0],
        'wristbands' => ['linked' => 0, 'replaced' => 0, 'blocked' => 0, 'unblocked' => 0, 'cancelled' => 0, 'total' => 0],
        'topups' => ['count' => 0, 'cashCount' => 0, 'cardCount' => 0, 'cashCents' => 0, 'cardCents' => 0, 'totalCents' => 0, 'undoneCount' => 0, 'undoneCents' => 0, 'reversedByThem' => 0],
        'cashouts' => ['count' => 0, 'cents' => 0],
        'boxOffice' => ['count' => 0, 'tickets' => 0, 'cashCents' => 0, 'cardCents' => 0, 'totalCents' => 0, 'refundedCount' => 0, 'refundedCents' => 0, 'cancelledCount' => 0],
        'cash' => ['takenCents' => 0, 'paidOutCents' => 0, 'netCents' => 0],
        'firstAt' => null, 'lastAt' => null, 'actions' => 0];
}

function team_activity(array $event): array
{
    $ev = $event['id'];
    $P = [];
    $at = function (string $uid) use (&$P) { if (!isset($P[$uid])) $P[$uid] = team_blank(); };
    foreach (rows('SELECT user_id FROM event_staff WHERE event_id = ?', [$ev]) as $r) $at($r['user_id']);
    // Scans: every line in the gate log, by the person who scanned.
    foreach (rows('SELECT scanned_by AS uid, outcome, COALESCE(reason, outcome) AS reason, offline, count(*) AS n FROM admission_log WHERE event_id = ? GROUP BY 1, 2, 3, 4', [$ev]) as $r) {
        $at($r['uid']); $s = &$P[$r['uid']]['scans']; $n = (int) $r['n'];
        if ($r['outcome'] === 'admitted') $s['admitted'] += $n;
        else { $s['refused'][team_refused_key($r['reason'])] += $n; $s['refusedTotal'] += $n; }
        if ((int) $r['offline'] === 1) $s['offline'] += $n;
        unset($s);
    }
    // Wristbands linked, replaced, blocked, unblocked or cancelled at the desk.
    $tagKey = ['linked' => 'linked', 'replaced' => 'replaced', 'status:blocked' => 'blocked', 'status:active' => 'unblocked', 'status:revoked' => 'cancelled'];
    foreach (rows('SELECT g.actor_id AS uid, g.action, count(*) AS n FROM tag_events g JOIN tags tg ON tg.id = g.tag_id WHERE tg.event_id = ? AND g.actor_id IS NOT NULL AND ' . TEAM_TAG_ACTIONS . ' GROUP BY 1, 2', [$ev]) as $r) {
        $at($r['uid']); $P[$r['uid']]['wristbands'][$tagKey[$r['action']]] += (int) $r['n']; $P[$r['uid']]['wristbands']['total'] += (int) $r['n'];
    }
    // Top-ups and cash paid out: the desk cash-up's own numbers, per desk.
    foreach (rows("SELECT DISTINCT staff_id AS uid FROM desk_topups WHERE event_id = ? UNION SELECT DISTINCT paid_by FROM wallet_cashouts WHERE event_id = ? AND method = 'cash' AND status = 'paid' AND paid_by IS NOT NULL", [$ev, $ev]) as $r) {
        $at($r['uid']); $c = desk_cashup_for($ev, $r['uid']);
        $P[$r['uid']]['topups'] = ['count' => $c['cash_count'] + $c['card_count'], 'cashCount' => $c['cash_count'], 'cardCount' => $c['card_count'], 'cashCents' => $c['cash_cents'], 'cardCents' => $c['card_cents'],
            'totalCents' => $c['total_cents'], 'undoneCount' => $c['undone_count'], 'undoneCents' => $c['undone_cents'], 'reversedByThem' => 0];
        $P[$r['uid']]['cashouts'] = ['count' => $c['cash_paid_out_count'], 'cents' => $c['cash_paid_out_cents']];
    }
    foreach (rows('SELECT undone_by AS uid, count(*) AS n FROM desk_topups WHERE event_id = ? AND undone_by IS NOT NULL GROUP BY 1', [$ev]) as $r) { $at($r['uid']); $P[$r['uid']]['topups']['reversedByThem'] = (int) $r['n']; }
    // Box office: tenders taken (organiser door sales, not retail partners).
    $door = 'JOIN door_shifts s ON s.id = t.shift_id AND s.retail_partner_id IS NULL';
    foreach (rows("SELECT t.cashier_id AS uid, count(*) AS n, SUM(t.amount_cents) AS total, SUM(CASE WHEN t.method = 'cash' THEN t.amount_cents ELSE 0 END) AS cash,
                          SUM(CASE WHEN t.method <> 'cash' THEN t.amount_cents ELSE 0 END) AS card, SUM((SELECT COALESCE(SUM(quantity),0) FROM order_items i WHERE i.order_id = t.order_id)) AS tickets
                     FROM door_tenders t $door WHERE t.event_id = ? GROUP BY 1", [$ev]) as $r) {
        $at($r['uid']); $b = &$P[$r['uid']]['boxOffice'];
        $b['count'] = (int) $r['n']; $b['tickets'] = (int) $r['tickets']; $b['cashCents'] = (int) $r['cash']; $b['cardCents'] = (int) $r['card']; $b['totalCents'] = (int) $r['total'];
        unset($b);
    }
    foreach (rows("SELECT t.cashier_id AS uid, count(*) AS n, SUM(r.amount_cents + r.fee_refund_cents) AS c FROM refunds r JOIN door_tenders t ON t.payment_id = r.payment_id $door
                    WHERE t.event_id = ? AND r.status = 'completed' GROUP BY 1", [$ev]) as $r) {
        $at($r['uid']); $P[$r['uid']]['boxOffice']['refundedCount'] = (int) $r['n']; $P[$r['uid']]['boxOffice']['refundedCents'] = (int) $r['c'];
    }
    foreach (rows("SELECT i.cashier_id AS uid, count(*) AS n FROM door_order_intents i JOIN orders o ON o.id = i.order_id
                    WHERE i.event_id = ? AND i.retail_partner_id IS NULL AND (i.status = 'cancelled' OR (i.status = 'awaiting_tender' AND o.status <> 'pending_payment')) GROUP BY 1", [$ev]) as $r) {
        $at($r['uid']); $P[$r['uid']]['boxOffice']['cancelledCount'] = (int) $r['n'];
    }
    // First and last action, and how many there were.
    $st = q_named('SELECT uid, MIN(at) AS first_at, MAX(at) AS last_at, count(*) AS n FROM (' . team_actions_sql() . ') x WHERE uid IS NOT NULL GROUP BY uid', [':ev' => $ev]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) { $at($r['uid']); $P[$r['uid']]['firstAt'] = $r['first_at']; $P[$r['uid']]['lastAt'] = $r['last_at']; $P[$r['uid']]['actions'] = (int) $r['n']; }

    $people = [];
    foreach ($P as $uid => $p) {
        $p['cash'] = ['takenCents' => $p['topups']['cashCents'] + $p['boxOffice']['cashCents'], 'paidOutCents' => $p['cashouts']['cents']];
        $p['cash']['netCents'] = $p['cash']['takenCents'] - $p['cash']['paidOutCents'];
        $people[] = team_person($uid, $event) + $p;
    }
    usort($people, fn($a, $b) => [$b['actions'], $a['name']] <=> [$a['actions'], $b['name']]);
    // The same totals from the existing reports, to show they match.
    $desk = desk_cashup_totals($ev);
    $shifts = array_map(fn($s) => door_shift_view($s['id']), rows('SELECT id FROM door_shifts WHERE event_id = ? AND retail_partner_id IS NULL', [$ev]));
    $reports = ['deskCashCents' => $desk['cash_cents'], 'deskCardCents' => $desk['card_cents'], 'cashPaidOutCents' => $desk['cash_paid_out_cents'],
        'boxOfficeCashCents' => array_sum(array_column($shifts, 'cashSalesCents')), 'boxOfficeCardCents' => array_sum(array_column($shifts, 'cardSalesCents'))];
    $totals = ['admitted' => 0, 'refused' => 0, 'offline' => 0, 'wristbands' => 0, 'topups' => 0, 'topupCashCents' => 0, 'topupCardCents' => 0, 'boxOfficeSales' => 0, 'boxOfficeTickets' => 0,
        'boxOfficeCashCents' => 0, 'boxOfficeCardCents' => 0, 'cashTakenCents' => 0, 'cashPaidOutCents' => 0];
    foreach ($people as $p) {
        $totals['admitted'] += $p['scans']['admitted']; $totals['refused'] += $p['scans']['refusedTotal']; $totals['offline'] += $p['scans']['offline'];
        $totals['wristbands'] += $p['wristbands']['total']; $totals['topups'] += $p['topups']['count'];
        $totals['topupCashCents'] += $p['topups']['cashCents']; $totals['topupCardCents'] += $p['topups']['cardCents'];
        $totals['boxOfficeSales'] += $p['boxOffice']['count']; $totals['boxOfficeTickets'] += $p['boxOffice']['tickets'];
        $totals['boxOfficeCashCents'] += $p['boxOffice']['cashCents']; $totals['boxOfficeCardCents'] += $p['boxOffice']['cardCents'];
        $totals['cashTakenCents'] += $p['cash']['takenCents']; $totals['cashPaidOutCents'] += $p['cash']['paidOutCents'];
    }
    $matches = $totals['topupCashCents'] === $reports['deskCashCents'] && $totals['topupCardCents'] === $reports['deskCardCents'] && $totals['cashPaidOutCents'] === $reports['cashPaidOutCents']
        && $totals['boxOfficeCashCents'] === $reports['boxOfficeCashCents'] && $totals['boxOfficeCardCents'] === $reports['boxOfficeCardCents'];
    return ['event' => ['id' => $event['id'], 'title' => $event['title'], 'startsAt' => $event['starts_at']], 'people' => $people, 'totals' => $totals, 'reports' => $reports, 'reconciled' => $matches,
        'refusedLabels' => TEAM_REFUSED, 'generatedAt' => now_iso()];
}
// Every desk at the event, the way the organiser's cash-up adds them up.
function desk_cashup_totals(string $eventId): array
{
    $t = ['cash_cents' => 0, 'card_cents' => 0, 'cash_paid_out_cents' => 0];
    foreach (rows("SELECT DISTINCT staff_id FROM desk_topups WHERE event_id = ? UNION SELECT DISTINCT paid_by FROM wallet_cashouts WHERE event_id = ? AND method = 'cash' AND paid_by IS NOT NULL", [$eventId, $eventId]) as $r) {
        $d = desk_cashup_for($eventId, $r['staff_id']);
        foreach ($t as $k => $_) $t[$k] += $d[$k];
    }
    return $t;
}
function team_person(string $uid, array $event): array
{
    $u = row("SELECT u.id, u.full_name, u.email, u.account_type, s.can_scan, s.can_manage_tags, s.can_sell_tickets, ab.account_type AS added_by_type, m.role AS member_role
                FROM users u LEFT JOIN event_staff s ON s.user_id = u.id AND s.event_id = ? LEFT JOIN users ab ON ab.id = s.added_by
                LEFT JOIN organiser_members m ON m.user_id = u.id AND m.organiser_id = ? WHERE u.id = ?", [$event['id'], $event['organiser_id'], $uid]) ?: ['id' => $uid, 'full_name' => 'Unknown', 'email' => '', 'account_type' => 'customer'];
    $role = $u['account_type'] === 'staff' ? 'TicketRoom' : (!empty($u['member_role']) ? 'Organiser (' . $u['member_role'] . ')' : (isset($u['can_scan']) ? 'Event team' : 'No longer on the team'));
    return ['userId' => $uid, 'name' => $u['full_name'], 'email' => $u['email'], 'role' => $role, 'onTeam' => isset($u['can_scan']),
        'addedByTicketroom' => ($u['added_by_type'] ?? '') === 'staff',
        'permissions' => isset($u['can_scan']) ? ['canScan' => (bool) $u['can_scan'], 'canManageTags' => (bool) $u['can_manage_tags'], 'canSellTickets' => (bool) $u['can_sell_tickets']] : null];
}

// One person's actions (or everyone's), filtered by kind and time.
function team_timeline(array $event, ?string $uid, ?string $kind, ?string $from, ?string $to, int $limit = 2000): array
{
    $st = q_named('SELECT * FROM ('  . team_actions_sql() . ') x WHERE at IS NOT NULL AND (:uid IS NULL OR uid = :uid) AND (:kind IS NULL OR kind = :kind)
                          AND (:from IS NULL OR at >= :from) AND (:to IS NULL OR at <= :to) ORDER BY at DESC LIMIT ' . max(1, min(5000, $limit)),
        [':ev' => $event['id'], ':uid' => $uid, ':kind' => $kind, ':from' => $from, ':to' => $to]);
    return array_map(fn($r) => ['kind' => $r['kind'], 'action' => $r['action'], 'at' => $r['at'], 'userId' => $r['uid'], 'place' => $r['place'],
        'amountCents' => $r['amount_cents'] === null ? null : (int) $r['amount_cents'], 'method' => $r['method'], 'reference' => $r['ref'],
        'detail' => $r['detail'] === null ? null : (string) $r['detail'], 'offline' => (int) $r['offline'] === 1, 'syncedAt' => $r['synced_at']], $st->fetchAll(PDO::FETCH_ASSOC));
}
function team_timeline_query(array $event, ?string $uid): array
{
    $kind = qs('kind');
    if ($kind !== null && !in_array($kind, TEAM_KINDS, true)) $kind = null;
    return team_timeline($event, $uid, $kind, parse_iso(qs('from')), parse_iso(qs('to')));
}

// CSV of the team table, or of one person's actions. Every export is audited.
function team_rand(int $c): string { return number_format($c / 100, 2, '.', ''); }
function team_csv(array $u, array $event, ?string $uid = null): Response
{
    if ($uid) {
        $items = team_timeline_query($event, $uid);
        $out = "time,type,action,gate,amount,method,reference,detail,offline\n";
        foreach ($items as $i) $out .= implode(',', array_map('org_csv_esc', [$i['at'], $i['kind'], $i['action'], $i['place'] ?? '', $i['amountCents'] === null ? '' : team_rand($i['amountCents']), $i['method'] ?? '', $i['reference'] ?? '', $i['detail'] ?? '', $i['offline'] ? 'yes' : ''])) . "\n";
        $n = count($items);
    } else {
        $a = team_activity($event);
        $cols = ['name', 'email', 'role', 'added_by_ticketroom', 'scans_admitted'];
        foreach (array_keys(TEAM_REFUSED) as $k) $cols[] = "refused_$k";
        array_push($cols, 'offline_scans', 'wristbands', 'topups', 'topups_cash', 'topups_card', 'topups_total', 'topups_undone', 'cashouts_paid', 'cashouts_paid_total',
            'box_office_sales', 'box_office_tickets', 'box_office_cash', 'box_office_card', 'box_office_total', 'box_office_refunded', 'cash_taken', 'cash_paid_out', 'cash_in_hand', 'first_action', 'last_action');
        $out = implode(',', $cols) . "\n";
        foreach ($a['people'] as $p) {
            $row = [$p['name'], $p['email'], $p['role'], $p['addedByTicketroom'] ? 'yes' : '', $p['scans']['admitted']];
            foreach (array_keys(TEAM_REFUSED) as $k) $row[] = $p['scans']['refused'][$k];
            array_push($row, $p['scans']['offline'], $p['wristbands']['total'], $p['topups']['count'], team_rand($p['topups']['cashCents']), team_rand($p['topups']['cardCents']), team_rand($p['topups']['totalCents']),
                $p['topups']['undoneCount'], $p['cashouts']['count'], team_rand($p['cashouts']['cents']), $p['boxOffice']['count'], $p['boxOffice']['tickets'], team_rand($p['boxOffice']['cashCents']),
                team_rand($p['boxOffice']['cardCents']), team_rand($p['boxOffice']['totalCents']), team_rand($p['boxOffice']['refundedCents']), team_rand($p['cash']['takenCents']),
                team_rand($p['cash']['paidOutCents']), team_rand($p['cash']['netCents']), $p['firstAt'] ?? '', $p['lastAt'] ?? '');
            $out .= implode(',', array_map('org_csv_esc', $row)) . "\n";
        }
        $n = count($a['people']);
    }
    audit('team_activity.exported', ['actor' => $u, 'entityType' => 'event', 'entityId' => $event['id'], 'organiserId' => $event['organiser_id'], 'details' => ['rows' => $n, 'person' => $uid, 'by' => team_actor_kind($u)]]);
    $slug = preg_replace('/[^a-z0-9-]/', '', (string) ($event['slug'] ?? 'event'));
    return raw_out($out, 'text/csv; charset=utf-8', 200, ['Content-Disposition' => 'attachment; filename="team-activity-' . $slug . ($uid ? '-person' : '') . '.csv"']);
}
