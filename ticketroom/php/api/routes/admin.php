<?php
// /api/admin/* — TicketRoom back office. Mirrors src/routes/admin.js.
// Roles: admin (platform operations), finance (money approvals), support
// (customer lookups, ticket reissue, support cases). Every route needs one of
// the three platform roles; some need a specific one. Payments, refunds,
// payouts, reconciliation, ledger, tags and terminals are not part of this
// edition: list pages answer empty, actions answer 501 not_available.
declare(strict_types=1);

function adm_any(): array { return require_role('admin', 'finance', 'support'); }
function adm_admin(): array { adm_any(); return require_role('admin'); }
function adm_finance(): array { adm_any(); return require_role('finance'); }
function adm_admin_or_support(): array { adm_any(); return require_role('admin', 'support'); }

// Same as Node's outbox.mask().
function adm_mask(?string $addr): string
{
    $s = (string) $addr;
    if (str_contains($s, '@')) {
        [$u, $d] = array_pad(explode('@', $s), 2, '');
        return mb_substr($u, 0, 1) . "***@$d";
    }
    return mb_strlen($s) > 4 ? mb_substr($s, 0, 3) . '*****' . mb_substr($s, -2) : '***';
}
// R::bool() ignores a caller's 'fallback' (core.php merges its own defaults
// first), so an absent optional boolean comes back as false. Drop it when the
// request did not actually send the field.
function adm_drop_absent_bool(array $b, string $field): array
{
    $src = body();
    if (!array_key_exists($field, $src) || v_empty($src[$field])) unset($b[$field]);
    return $b;
}
// Search text cleaned like Node: no LIKE wildcards or backslashes, at most 80 chars.
function adm_search(string $name): string { return mb_substr(preg_replace('/[%_\\\\]/', '', (string) qs($name, '')), 0, 80); }
// No ledger in this edition: always empty and balanced.
function adm_ledger(): array { return ['entries' => 0, 'sumCents' => 0, 'balanced' => true, 'unbalancedJournals' => [], 'clearing' => []]; }
function adm_int_or_zero($v): int { return (int) ($v ?? 0); }

// ---- dashboard ---------------------------------------------------------------
route('GET', '/api/admin/dashboard', function () {
    adm_any();
    $users = row("SELECT count(*) AS total, COALESCE(SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END),0) AS new7 FROM users WHERE status <> 'deleted'", [iso_in(-7 * 86400)]);
    $orgs = row("SELECT COALESCE(SUM(status = 'pending'),0) AS pending, COALESCE(SUM(status = 'approved'),0) AS approved FROM organisers");
    $events = row("SELECT COALESCE(SUM(status = 'pending_approval'),0) AS pending, COALESCE(SUM(status = 'published'),0) AS live,
                          COALESCE(SUM(cancellation_requested_at IS NOT NULL AND status <> 'cancelled'),0) AS cancel_requests FROM events");
    $since = iso_in(-86400);
    $sales = row("SELECT COALESCE(SUM(CASE WHEN paid_at > ? THEN total_cents ELSE 0 END),0) AS gmv24, COALESCE(SUM(total_cents),0) AS gmv_all,
                         COALESCE(SUM(CASE WHEN paid_at > ? THEN 1 ELSE 0 END),0) AS orders24
                    FROM orders WHERE status IN ('paid','partially_refunded','refunded','paid_unfulfilled')", [$since, $since]);
    $ops = [
        'refunds_pending' => 0,
        'refunds_failed' => 0,
        'payouts_open' => 0,
        'webhook_problems' => 0,
        'recon_exceptions' => 0,
        'support_open' => (int) val("SELECT count(*) FROM support_cases WHERE status IN ('open','in_progress')"),
        'unfulfilled' => (int) val("SELECT count(*) FROM orders WHERE status = 'paid_unfulfilled'"),
        'messages_failed' => (int) val("SELECT count(*) FROM message_outbox WHERE status = 'failed'"),
        'stale_payments' => 0,
    ];
    $ints = fn(array $r) => array_map('intval', $r);
    return ['users' => $ints($users), 'organisers' => $ints($orgs), 'events' => $ints($events), 'sales' => $ints($sales), 'ops' => $ops, 'ledger' => adm_ledger()];
});

// ---- organisers ----------------------------------------------------------------
// ?q= searches by ID (EV-…, ORG-…) or name. Returns the bind values for the
// query's search clause: [q, ref, (ref,) like, like].
function adm_find(bool $events = false): array
{
    $q = trim(mb_substr((string) qs('q', ''), 0, 80));
    if ($q === '') return $events ? [null, null, null, null, null] : [null, null, null, null];
    $ref = strtoupper($q);
    $like = '%' . like_escape(mb_strtolower($q)) . '%';
    return $events ? [$q, $ref, $ref, $like, $like] : [$q, $ref, $like, $like];
}

route('GET', '/api/admin/organisers', function () {
    adm_any();
    $status = qs('status') ?: null;
    $list = rows("SELECT o.id, o.ref, o.name, o.status, o.contact_email, o.contact_phone, o.created_at, o.bank_account_last4,
                         (SELECT count(*) FROM events WHERE organiser_id = o.id) AS events,
                         o.commission_bps,
                         (SELECT u.full_name FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = o.id AND m.role = 'owner' LIMIT 1) AS owner_name
                    FROM organisers o WHERE (? IS NULL OR o.status = ?) AND (? IS NULL OR o.ref = ? OR lower(o.name) LIKE ? ESCAPE '\\' OR lower(o.contact_email) LIKE ? ESCAPE '\\')
                   ORDER BY o.created_at DESC LIMIT 200", array_merge([$status, $status], adm_find()));
    return ['organisers' => $list];
});

route('POST', '/api/admin/organisers/:id/status', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['status' => R::oneOf(['approved', 'rejected', 'suspended']), 'reason' => R::str(['optional' => true, 'max' => 400])]);
    $id = $a['id'];
    $org = tx(function () use ($b, $u, $id) {
        $approved = $b['status'] === 'approved';
        if (!affected('UPDATE organisers SET status = ?, approved_at = CASE WHEN ? THEN ? ELSE approved_at END, approved_by = CASE WHEN ? THEN ? ELSE approved_by END WHERE id = ?',
            [$b['status'], $approved ? 1 : 0, now_iso(), $approved ? 1 : 0, $u['id'], $id])) throw not_found('Organiser not found.');
        if ($b['status'] === 'suspended') {
            q("UPDATE events SET status = 'suspended', status_reason = 'organiser suspended' WHERE organiser_id = ? AND status = 'published'", [$id]);
        }
        if ($approved || $b['status'] === 'rejected') {
            $w = row("SELECT o.name, o.contact_email, u.id AS user_id, u.full_name, u.email FROM organisers o
                        LEFT JOIN organiser_members m ON m.organiser_id = o.id AND m.role = 'owner' LEFT JOIN users u ON u.id = m.user_id
                       WHERE o.id = ? ORDER BY m.created_at LIMIT 1", [$id]);
            if ($w) {
                outbox_enqueue(['to' => $w['email'] ?: $w['contact_email'], 'userId' => $w['user_id']]
                    + ($approved ? tpl('organiserApproved', ['name' => $w['full_name'], 'organiser' => $w['name']])
                                 : tpl('organiserRejected', ['name' => $w['full_name'], 'organiser' => $w['name'], 'reason' => $b['reason'] ?? null])));
            }
        }
        return row('SELECT id, status FROM organisers WHERE id = ?', [$id]);
    });
    audit("organiser.{$b['status']}", ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $id, 'organiserId' => $id, 'details' => ['reason' => $b['reason'] ?? null]]);
    return ['organiser' => $org];
});

// Negotiated commission for one organiser (null = platform default).
route('POST', '/api/admin/organisers/:id/commission', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['commissionBps' => R::int(['optional' => true, 'min' => 0, 'max' => 5000])]);
    $bps = $b['commissionBps'] ?? null;
    if (!affected('UPDATE organisers SET commission_bps = ? WHERE id = ?', [$bps, $a['id']])) throw not_found('Organiser not found.');
    audit('organiser.commission_set', ['actor' => $u, 'entityType' => 'organiser', 'entityId' => $a['id'], 'organiserId' => $a['id'], 'details' => ['commissionBps' => $bps ?? 'default']]);
    return ['organiser' => row('SELECT id, commission_bps FROM organisers WHERE id = ?', [$a['id']])];
});

// ---- events ----------------------------------------------------------------------
route('GET', '/api/admin/events', function () {
    adm_any();
    $status = qs('status') ?: null;
    $list = rows("SELECT e.id, e.ref, e.title, e.slug, e.status, e.starts_at, e.city, e.capacity, e.featured, e.cashless_enabled, e.cancellation_requested_at, e.cancellation_reason, e.status_reason,
                         o.name AS organiser_name, o.id AS organiser_id, o.ref AS organiser_ref,
                         (SELECT COALESCE(SUM(quantity_sold),0) FROM ticket_types WHERE event_id = e.id) AS sold
                    FROM events e JOIN organisers o ON o.id = e.organiser_id
                   WHERE (? IS NULL OR e.status = ? OR (? = 'cancel_requests' AND e.cancellation_requested_at IS NOT NULL AND e.status <> 'cancelled'))
                     AND (? IS NULL OR e.ref = ? OR o.ref = ? OR lower(e.title) LIKE ? ESCAPE '\\' OR lower(o.name) LIKE ? ESCAPE '\\')
                   ORDER BY e.starts_at DESC LIMIT 300", array_merge([$status, $status, $status], adm_find(true)));
    foreach ($list as &$e) $e['sold'] = (int) $e['sold'];
    return ['events' => $list];
});

route('POST', '/api/admin/events/:id/status', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['action' => R::oneOf(['publish', 'reject', 'suspend', 'reinstate', 'feature', 'unfeature']), 'reason' => R::str(['optional' => true, 'max' => 400])]);
    $reason = $b['reason'] ?? null;
    $ev = row('SELECT * FROM events WHERE id = ?', [$a['id']]);
    if (!$ev) throw not_found('Event not found.');
    $t = [
        'publish' => [['pending_approval'], 'published'], 'reject' => [['pending_approval'], 'draft'],
        'suspend' => [['published'], 'suspended'], 'reinstate' => [['suspended'], 'published'],
    ][$b['action']] ?? null;
    if ($t) {
        if (!in_array($ev['status'], $t[0], true)) throw conflict("Cannot {$b['action']} an event that is {$ev['status']}.", 'bad_transition');
        if ($b['action'] !== 'publish' && $b['action'] !== 'reinstate' && !$reason) throw bad('Give a reason.', ['reason' => 'Required.']);
        tx(function () use ($ev, $t, $reason, $b) {
            $now = now_iso();
            q("UPDATE events SET status = ?, status_reason = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?",
                [$t[1], $reason, $t[1], $now, $now, $ev['id']]);
            if ($b['action'] === 'publish' || $b['action'] === 'reject') {
                $who = $ev['created_by'] ? row('SELECT id, full_name, email FROM users WHERE id = ?', [$ev['created_by']]) : null;
                $who ??= row("SELECT u.id, u.full_name, u.email FROM organiser_members m JOIN users u ON u.id = m.user_id WHERE m.organiser_id = ? AND m.role = 'owner' LIMIT 1", [$ev['organiser_id']]);
                if ($who) {
                    outbox_enqueue(['to' => $who['email'], 'userId' => $who['id']]
                        + ($b['action'] === 'publish' ? tpl('eventPublished', ['name' => $who['full_name'], 'event' => $ev, 'eventUrl' => base_url() . "/events/{$ev['slug']}"])
                                                      : tpl('eventChangesRequested', ['name' => $who['full_name'], 'event' => $ev, 'reason' => $reason])));
                }
            }
        });
    } else {
        q('UPDATE events SET featured = ? WHERE id = ?', [$b['action'] === 'feature' ? 1 : 0, $ev['id']]);
    }
    audit("event.{$b['action']}", ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['reason' => $reason]]);
    return ['ok' => true];
});

// Cancelling an event stops sales. Every order in this edition is free, so no
// refunds are raised: holders are emailed and their free tickets revoked.
route('POST', '/api/admin/events/:id/cancel', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['reason' => R::str(['min' => 5, 'max' => 400])]);
    return tx(function () use ($u, $a, $b) {
        $ev = row('SELECT * FROM events WHERE id = ?', [$a['id']]);
        if (!$ev) throw not_found('Event not found.');
        if ($ev['status'] === 'cancelled') throw conflict('Already cancelled.', 'bad_transition');
        $now = now_iso();
        q("UPDATE events SET status = 'cancelled', status_reason = ?, updated_at = ? WHERE id = ?", [$b['reason'], $now, $ev['id']]);
        $raised = 0;
        $holders = rows("SELECT DISTINCT u.id, u.email, u.full_name FROM tickets t JOIN users u ON u.id = t.owner_user_id
                          WHERE t.event_id = ? AND t.status IN ('valid','refunded')", [$ev['id']]);
        foreach ($holders as $h) {
            outbox_enqueue(['to' => $h['email'], 'userId' => $h['id']] + tpl('eventCancelled', ['name' => $h['full_name'], 'event' => $ev, 'reason' => $b['reason'], 'paid' => false]));
        }
        q("UPDATE tickets SET status = 'revoked', revoked_reason = 'event cancelled', updated_at = ? WHERE event_id = ? AND status = 'valid' AND price_cents = 0", [$now, $ev['id']]);
        audit('event.cancelled', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['reason' => $b['reason'], 'refundsRaised' => $raised]]);
        return ['refundsRaised' => $raised];
    });
});

// ---- users -----------------------------------------------------------------------
route('GET', '/api/admin/users', function () {
    adm_admin_or_support();
    $s = adm_search('q');
    $like = "%$s%";
    $list = rows("SELECT u.id, u.email, u.full_name, u.phone, u.status, u.created_at, u.email_verified_at FROM users u
                   WHERE ? = '' OR lower(u.email) LIKE lower(?) OR lower(u.full_name) LIKE lower(?) OR lower(COALESCE(u.phone,'')) LIKE lower(?)
                   ORDER BY u.created_at DESC LIMIT 100", [$s, $like, $like, $like]);
    $roles = [];
    if ($list) {
        $ids = array_column($list, 'id');
        foreach (rows('SELECT user_id, role FROM platform_roles WHERE user_id IN (' . placeholders($ids) . ')', $ids) as $r) $roles[$r['user_id']][] = $r['role'];
    }
    foreach ($list as &$x) $x['roles'] = $roles[$x['id']] ?? [];
    return ['users' => $list];
});

route('GET', '/api/admin/users/:id', function ($a) {
    adm_admin_or_support();
    $user = row('SELECT id, email, full_name, phone, status, created_at, email_verified_at FROM users WHERE id = ?', [$a['id']]);
    if (!$user) throw not_found('User not found.');
    $user['has_pin'] = false; // spending PINs belong to cashless, not in this edition
    return [
        'user' => $user,
        'roles' => rows('SELECT role, granted_at FROM platform_roles WHERE user_id = ?', [$a['id']]),
        'orders' => rows('SELECT o.id, o.reference, o.status, o.total_cents, o.created_at, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50', [$a['id']]),
        'tickets' => rows('SELECT t.id, t.code, t.status, e.title, t.admitted_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.owner_user_id = ? ORDER BY t.created_at DESC LIMIT 100', [$a['id']]),
        'tags' => [],
    ];
});

route('POST', '/api/admin/users/:id/status', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['status' => R::oneOf(['active', 'suspended']), 'reason' => R::str(['min' => 3, 'max' => 400])]);
    if ($a['id'] === $u['id']) throw bad('You cannot change your own status.');
    tx(function () use ($a, $b) {
        $now = now_iso();
        if (!affected("UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted'", [$b['status'], $now, $a['id']])) throw not_found('User not found.');
        if ($b['status'] === 'suspended') q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [$now, $a['id']]);
    });
    audit("user.{$b['status']}", ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['reason' => $b['reason']]]);
    return ['ok' => true];
});

route('POST', '/api/admin/users/:id/roles', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['role' => R::oneOf(['admin', 'finance', 'support']), 'grant' => R::bool()]);
    if ($a['id'] === $u['id']) throw forbidden('You cannot change your own platform roles.');
    if ($b['grant']) q('INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', [$a['id'], $b['role'], $u['id'], now_iso()]);
    else q('DELETE FROM platform_roles WHERE user_id = ? AND role = ?', [$a['id'], $b['role']]);
    audit($b['grant'] ? 'role.granted' : 'role.revoked', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['role' => $b['role']]]);
    return ['ok' => true];
});

// ---- TicketRoom staff (admin portal team) --------------------------------------------
const STAFF_ROLE_NAMES = ['admin' => 'Admin', 'finance' => 'Finance', 'support' => 'Support'];
route('GET', '/api/admin/staff', function () {
    adm_any();
    $list = rows("SELECT u.id, u.full_name, u.email, u.status, u.created_at, group_concat(r.role) AS roles
                    FROM users u JOIN platform_roles r ON r.user_id = u.id GROUP BY u.id ORDER BY u.full_name");
    foreach ($list as &$x) $x['roles'] = array_values(array_filter(explode(',', (string) $x['roles'])));
    return ['staff' => $list];
});
// Add someone to the team. A new address gets an account and an email to set a password.
route('POST', '/api/admin/staff', function () {
    $u = adm_admin();
    limit('staffteam', 30, 3600, $u['id']);
    $b = check(body(), ['email' => R::email(), 'fullName' => R::str(['min' => 2, 'max' => 120]), 'roles' => R::arr(R::oneOf(array_keys(STAFF_ROLE_NAMES)), ['min' => 1, 'max' => 3])]);
    $roles = array_values(array_unique($b['roles']));
    return tx(function () use ($u, $b, $roles) {
        $now = now_iso();
        $existing = row("SELECT id, status FROM users WHERE lower(email) = ?", [$b['email']]);
        if ($existing && $existing['status'] !== 'active') throw conflict('That account is suspended or closed. Restore it under All users first.', 'account_inactive');
        $url = null;
        if ($existing) $id = $existing['id'];
        else {
            $id = uuid();
            insert('users', ['id' => $id, 'email' => $b['email'], 'full_name' => $b['fullName'], 'password_hash' => hash_secret(random_token(24)), 'status' => 'active', 'created_at' => $now, 'updated_at' => $now]);
            $token = random_token(32);
            insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $id, 'expires_at' => iso_in(7 * 86400), 'created_at' => $now]);
            $url = base_url() . "/account#/reset/$token";
        }
        foreach ($roles as $r) q('INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', [$id, $r, $u['id'], $now]);
        $names = implode(' and ', array_map(fn($r) => STAFF_ROLE_NAMES[$r], $roles));
        outbox_enqueue(['to' => $b['email'], 'userId' => $id] + tpl('teamInvite', ['name' => $existing ? null : $b['fullName'], 'by' => $u['fullName'], 'roles' => $names, 'url' => $url]));
        audit('staff.added', ['actor' => $u, 'entityType' => 'user', 'entityId' => $id, 'details' => ['roles' => $roles, 'newAccount' => !$existing]]);
        return json_out(['ok' => true, 'invited' => !$existing], 201);
    });
});
// Set exactly these roles; an empty list removes the person from the team.
route('PUT', '/api/admin/staff/:id', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['roles' => R::arr(R::oneOf(array_keys(STAFF_ROLE_NAMES)), ['max' => 3])]);
    if ($a['id'] === $u['id']) throw forbidden('You cannot change your own roles. Ask another admin.');
    if (!row('SELECT 1 FROM users WHERE id = ?', [$a['id']])) throw not_found('Staff member not found.');
    $want = array_values(array_unique($b['roles']));
    tx(function () use ($u, $a, $want) {
        $have = array_column(rows('SELECT role FROM platform_roles WHERE user_id = ?', [$a['id']]), 'role');
        foreach (array_diff($have, $want) as $r) { q('DELETE FROM platform_roles WHERE user_id = ? AND role = ?', [$a['id'], $r]); audit('role.revoked', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['role' => $r]]); }
        foreach (array_diff($want, $have) as $r) { q('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', [$a['id'], $r, $u['id'], now_iso()]); audit('role.granted', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['role' => $r]]); }
        if (!$want) q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now_iso(), $a['id']]);
    });
    return ['ok' => true];
});

// ---- orders & tickets --------------------------------------------------------------
route('GET', '/api/admin/orders', function () {
    adm_any();
    $s = adm_search('q');
    $like = "%$s%";
    $list = rows("SELECT o.id, o.reference, o.status, o.buyer_name, o.buyer_email, o.total_cents, o.refunded_cents, o.created_at, e.title
                    FROM orders o JOIN events e ON e.id = o.event_id
                   WHERE ? = '' OR lower(o.reference) LIKE lower(?) OR lower(o.buyer_email) LIKE lower(?)
                   ORDER BY o.created_at DESC LIMIT 100", [$s, $like, $like]);
    foreach ($list as &$o) $o['payments'] = null; // no payments in this edition (Node: json_agg of no rows)
    return ['orders' => $list];
});

route('GET', '/api/admin/tickets/:code', function ($a) {
    adm_any();
    $code = strtoupper(preg_replace('/[\s-]/', '', $a['code']));
    $t = row('SELECT t.id, t.code, t.status, t.holder_name, t.admitted_at, t.qr_version, t.revoked_reason, e.title, o.reference, u.email AS owner_email
                FROM tickets t JOIN events e ON e.id = t.event_id JOIN orders o ON o.id = t.order_id JOIN users u ON u.id = t.owner_user_id
               WHERE t.code = ?', [$code]);
    if (!$t) throw not_found('Ticket not found.');
    $log = rows('SELECT outcome, occurred_at, gate FROM admission_log WHERE ticket_id = ? ORDER BY id DESC LIMIT 20', [$t['id']]);
    return ['ticket' => $t, 'admissions' => $log];
});

// Revokes the current QR and issues a fresh one (lost phone, leaked screenshot).
route('POST', '/api/admin/tickets/:id/reissue', function ($a) {
    $u = adm_admin_or_support();
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 300])]);
    return tx(function () use ($u, $a, $b) {
        if (!affected("UPDATE tickets SET qr_version = qr_version + 1, updated_at = ? WHERE id = ? AND status = 'valid'", [now_iso(), $a['id']])) {
            throw conflict('Only valid tickets can be reissued.', 'ticket_not_valid');
        }
        audit('ticket.reissued', ['actor' => $u, 'entityType' => 'ticket', 'entityId' => $a['id'], 'details' => ['reason' => $b['reason']]]);
        return row('SELECT id, qr_version FROM tickets WHERE id = ?', [$a['id']]);
    });
});

route('POST', '/api/admin/tickets/:id/revoke', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['reason' => R::str(['min' => 3, 'max' => 300])]);
    tx(function () use ($u, $a, $b) {
        if (!affected("UPDATE tickets SET status = 'revoked', revoked_reason = ?, updated_at = ? WHERE id = ? AND status = 'valid'", [$b['reason'], now_iso(), $a['id']])) {
            throw conflict('Only valid tickets can be revoked.', 'ticket_not_valid');
        }
        audit('ticket.revoked', ['actor' => $u, 'entityType' => 'ticket', 'entityId' => $a['id'], 'details' => ['reason' => $b['reason']]]);
    });
    return ['ok' => true];
});

// ---- payments, webhooks, refunds, payouts, reconciliation, ledger (not in this edition)
route('GET', '/api/admin/payments', function () { adm_any(); return ['payments' => []]; });
route('POST', '/api/admin/payments/:id/recheck', function () { adm_any(); throw not_available(); });
route('GET', '/api/admin/webhooks', function () { adm_any(); return ['webhooks' => []]; });
route('GET', '/api/admin/refunds', function () { adm_any(); return ['refunds' => []]; });
route('POST', '/api/admin/refunds/bulk-approve', function () { adm_finance(); throw not_available(); });
foreach (['decide', 'complete-manually', 'retry'] as $act) {
    route('POST', "/api/admin/refunds/:id/$act", function () { adm_finance(); throw not_available(); });
}
route('GET', '/api/admin/payouts', function () { adm_any(); return ['payouts' => []]; });
foreach (['decide', 'mark-paid', 'reveal-account'] as $act) {
    route('POST', "/api/admin/payouts/:id/$act", function () { adm_finance(); throw not_available(); });
}
route('GET', '/api/admin/reconciliation', function () { adm_any(); return ['runs' => [], 'ledger' => adm_ledger()]; });
route('POST', '/api/admin/reconciliation', function () { adm_finance(); throw not_available(); });
route('GET', '/api/admin/reconciliation/:id', function () { adm_any(); throw not_found('Run not found.'); });
route('POST', '/api/admin/reconciliation/items/:id/resolve', function () { adm_finance(); throw not_available(); });
route('GET', '/api/admin/ledger/accounts', function () { adm_any(); return ['accounts' => []]; });
route('GET', '/api/admin/ledger/journals', function () { adm_any(); return ['journals' => []]; });

// ---- tags & terminals (not in this edition) ----------------------------------------
route('POST', '/api/admin/tag-batches', function () { adm_admin(); throw not_available(); });
route('GET', '/api/admin/tags', function () { adm_any(); return ['tags' => []]; });
route('GET', '/api/admin/tags/:id/history', function () { adm_any(); return ['history' => []]; });
route('POST', '/api/admin/tags/:id/status', function () { adm_admin_or_support(); throw not_available(); });
route('GET', '/api/admin/terminals', function () { adm_any(); return ['terminals' => []]; });
route('POST', '/api/admin/terminals/:id/status', function () { adm_admin(); throw not_available(); });

// ---- integrations -------------------------------------------------------------------
route('GET', '/api/admin/integrations', function () {
    adm_any();
    $set = fn($v) => $v ? 'set' : 'missing';
    $mode = mail_mode();
    $email = [
        'key' => 'email', 'label' => 'Email', 'provider' => $mode,
        'environment' => $mode === 'log' ? 'mock' : 'live',
        'endpoint' => $mode === 'smtp' ? cfg('mail.smtpHost') . ':' . cfg('mail.smtpPort', 465) : ($mode === 'mail' ? "hosting server's PHP mail()" : 'log only (not sent)'),
        'credentials' => $mode === 'smtp' ? ['smtpHost' => $set(cfg('mail.smtpHost')), 'smtpUser' => $set(cfg('mail.smtpUser')), 'smtpPass' => $set(cfg('mail.smtpPass'))] : (object) [],
    ];
    return [
        'defaults' => ['bookingFeeCents' => (int) cfg('fees.ticketFeeFixedCents', 1000), 'bookingFeeBps' => (int) cfg('fees.ticketFeeBps', 0), 'organiserCommissionBps' => (int) cfg('fees.organiserCommissionBps', 500)],
        'integrations' => [
            ['key' => 'payments', 'label' => 'Card payments', 'provider' => 'none', 'environment' => 'not set up', 'endpoint' => 'not available in this edition yet', 'credentials' => (object) []],
            $email,
            ['key' => 'sms', 'label' => 'SMS', 'provider' => 'none', 'environment' => 'not set up', 'endpoint' => 'not available in this edition yet', 'credentials' => (object) []],
        ],
    ];
});

route('POST', '/api/admin/integrations/:key/health', function ($a) {
    $u = adm_admin();
    $key = $a['key'];
    if ($key === 'email') $result = smtp_health();
    elseif (in_array($key, ['payments', 'sms', 'titopay'], true)) $result = ['ok' => false, 'detail' => 'Not available in this edition yet.'];
    else throw not_found('Unknown integration.');
    audit('integration.health_checked', ['actor' => $u, 'entityType' => 'integration', 'entityId' => $key, 'details' => ['ok' => $result['ok']]]);
    return $result;
});

// ---- site settings ------------------------------------------------------------------
route('GET', '/api/admin/settings', function () {
    adm_any();
    $all = settings_all();
    return ['settings' => $all, 'hoursStatus' => hours_status($all['hours']), 'aiConfigured' => (bool) cfg('anthropicApiKey'), 'assistantModel' => (string) cfg('chatbotModel', 'claude-opus-5-5')];
});
route('PUT', '/api/admin/settings/:key', function ($a) {
    $u = adm_admin();
    return ['value' => setting_set($u, $a['key'], body())];
});

// ---- advertising posters ------------------------------------------------------------
route('POST', '/api/admin/uploads', function () {
    $u = adm_admin();
    return json_out(['uploadId' => store_upload($u['id'], null, raw_body())], 201);
});

const ADM_POSTER_COLS = ['title' => 'title', 'subtitle' => 'subtitle', 'imageUploadId' => 'image_upload_id', 'linkUrl' => 'link_url', 'placement' => 'placement',
    'startsAt' => 'starts_at', 'endsAt' => 'ends_at', 'active' => 'active', 'sortOrder' => 'sort_order'];
function adm_poster_input(bool $optional): array
{
    $b = check(body(), [
        'title' => R::str(['min' => 2, 'max' => 120, 'optional' => $optional]),
        'subtitle' => R::str(['optional' => true, 'max' => 200]),
        'imageUploadId' => R::uuid(['optional' => true]),
        'linkUrl' => R::str(['optional' => true, 'max' => 300, 'pattern' => '#^(/(?![/\\\\])|https?://[^/\\\\\s])#', 'message' => 'Start with / or https://']),
        'placement' => $optional ? R::oneOf(['home', 'events'], ['optional' => true]) : R::oneOf(['home', 'events'], ['optional' => true, 'fallback' => 'home']),
        'startsAt' => R::date(['optional' => true]),
        'endsAt' => R::date(['optional' => true]),
        'active' => R::bool(['optional' => true, 'fallback' => null]),
        'sortOrder' => R::int(['optional' => true, 'min' => 0, 'max' => 1000]),
    ]);
    $b = adm_drop_absent_bool($b, 'active');
    $out = [];
    foreach ($b as $k => $v) {
        if ($v === null) continue;
        $out[ADM_POSTER_COLS[$k]] = is_bool($v) ? ($v ? 1 : 0) : $v;
    }
    return $out;
}
route('GET', '/api/admin/posters', function () {
    adm_any();
    return ['posters' => rows('SELECT * FROM ad_posters ORDER BY active DESC, sort_order, created_at DESC')];
});
route('POST', '/api/admin/posters', function () {
    $u = adm_admin();
    $cols = adm_poster_input(false);
    $id = uuid();
    insert('ad_posters', ['id' => $id, 'created_by' => $u['id'], 'created_at' => now_iso()] + $cols);
    audit('poster.created', ['actor' => $u, 'entityType' => 'ad_poster', 'entityId' => $id]);
    return json_out(['poster' => row('SELECT * FROM ad_posters WHERE id = ?', [$id])], 201);
});
route('PATCH', '/api/admin/posters/:id', function ($a) {
    $u = adm_admin();
    $cols = adm_poster_input(true);
    if (!$cols) throw bad('Nothing to change.');
    $set = implode(', ', array_map(fn($c) => "$c = ?", array_keys($cols)));
    if (!affected("UPDATE ad_posters SET $set WHERE id = ?", [...array_values($cols), $a['id']])) throw not_found('Poster not found.');
    $fields = array_map(fn($c) => array_search($c, ADM_POSTER_COLS, true), array_keys($cols));
    audit('poster.updated', ['actor' => $u, 'entityType' => 'ad_poster', 'entityId' => $a['id'], 'details' => ['fields' => $fields]]);
    return ['poster' => row('SELECT * FROM ad_posters WHERE id = ?', [$a['id']])];
});
route('DELETE', '/api/admin/posters/:id', function ($a) {
    $u = adm_admin();
    q('DELETE FROM ad_posters WHERE id = ?', [$a['id']]);
    audit('poster.deleted', ['actor' => $u, 'entityType' => 'ad_poster', 'entityId' => $a['id']]);
    return ['ok' => true];
});

// ---- assistant knowledge base and conversations ---------------------------------------
function adm_kb_input(bool $optional): array
{
    return adm_drop_absent_bool(check(body(), [
        'question' => R::str(['min' => 5, 'max' => 200, 'optional' => $optional]),
        'answer' => R::text(['max' => 2000, 'optional' => $optional]),
        'keywords' => R::arr(R::str(['max' => 40]), ['optional' => true, 'max' => 30]),
        'linkUrl' => R::str(['optional' => true, 'max' => 200, 'pattern' => '#^/(?![/\\\\])#', 'message' => 'Use a site path like /help']),
        'active' => R::bool(['optional' => true, 'fallback' => null]),
        'sortOrder' => R::int(['optional' => true, 'min' => 0, 'max' => 1000]),
    ]), 'active');
}
function adm_json(array $v): string { return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); }
route('GET', '/api/admin/kb', function () {
    adm_any();
    kb_ensure_defaults();
    return ['articles' => rows('SELECT * FROM kb_articles ORDER BY active DESC, sort_order, question')];
});
route('POST', '/api/admin/kb', function () {
    $u = adm_admin_or_support();
    $b = adm_kb_input(false);
    if ($b['answer'] === '') throw invalid(['answer' => 'This field is required.']);
    $id = uuid();
    insert('kb_articles', ['id' => $id, 'question' => $b['question'], 'answer' => $b['answer'], 'keywords' => adm_json(array_values(array_filter($b['keywords'] ?? [], fn($k) => $k !== null))),
        'link_url' => $b['linkUrl'] ?? null, 'active' => 1, 'sort_order' => $b['sortOrder'] ?? 100, 'updated_by' => $u['id'], 'updated_at' => now_iso()]);
    return json_out(['article' => row('SELECT * FROM kb_articles WHERE id = ?', [$id])], 201);
});
route('PATCH', '/api/admin/kb/:id', function ($a) {
    $u = adm_admin_or_support();
    $b = adm_kb_input(true);
    $kw = isset($b['keywords']) ? adm_json(array_values(array_filter($b['keywords'], fn($k) => $k !== null))) : null;
    $active = isset($b['active']) ? ($b['active'] ? 1 : 0) : null;
    $n = affected('UPDATE kb_articles SET question = COALESCE(?, question), answer = COALESCE(?, answer), keywords = COALESCE(?, keywords), link_url = COALESCE(?, link_url),
                          active = COALESCE(?, active), sort_order = COALESCE(?, sort_order), updated_by = ?, updated_at = ? WHERE id = ?',
        [$b['question'] ?? null, $b['answer'] ?? null, $kw, $b['linkUrl'] ?? null, $active, $b['sortOrder'] ?? null, $u['id'], now_iso(), $a['id']]);
    if (!$n) throw not_found('Article not found.');
    return ['article' => row('SELECT * FROM kb_articles WHERE id = ?', [$a['id']])];
});
route('GET', '/api/admin/chats', function () {
    adm_any();
    $unanswered = qs('filter') === 'unanswered' ? 1 : 0;
    $chats = rows("SELECT c.id, c.question, c.answer, c.source, c.helpful, c.created_at, k.question AS matched
                     FROM chat_messages c LEFT JOIN kb_articles k ON k.id = c.article_id
                    WHERE (? = 0 OR c.source = 'fallback' OR c.helpful = 0) ORDER BY c.id DESC LIMIT 200", [$unanswered]);
    $stats = row("SELECT count(*) AS total, COALESCE(SUM(source = 'ai'),0) AS ai, COALESCE(SUM(source = 'fallback'),0) AS unanswered,
                         COALESCE(SUM(helpful = 1),0) AS helpful, COALESCE(SUM(helpful = 0),0) AS unhelpful
                    FROM chat_messages WHERE created_at > ?", [iso_in(-30 * 86400)]);
    return ['chats' => $chats, 'stats' => array_map('intval', $stats)];
});

// ---- email templates: catalogue, preview, test send ------------------------------------
function adm_catalog_item(string $key): array
{
    foreach (email_catalog() as $x) if ($x['key'] === $key) return $x;
    throw not_found('Unknown email.');
}
route('GET', '/api/admin/emails', function () {
    adm_any();
    $emails = array_map(fn($x) => ['key' => $x['key'], 'name' => $x['name'], 'audience' => $x['audience'], 'trigger' => $x['trigger'], 'setting' => $x['setting'] ?? null] + $x['sample'](), email_catalog());
    return ['emails' => $emails, 'settings' => setting('emails'), 'delivery' => mail_mode()];
});
route('GET', '/api/admin/emails/:key/preview', function ($a) {
    adm_any();
    $m = adm_catalog_item($a['key'])['sample']();
    // Shown inside the back office only; email HTML needs inline styles.
    return raw_out(email_html($m['subject'], $m['body']), 'text/html; charset=utf-8', 200, [
        'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        'X-Frame-Options' => 'SAMEORIGIN',
    ]);
});
route('POST', '/api/admin/emails/:key/test', function ($a) {
    $u = adm_admin();
    limit('emailtest', 20, 3600, $u['id']);
    $m = adm_catalog_item($a['key'])['sample']();
    outbox_enqueue(['to' => $u['email'], 'userId' => $u['id'], 'subject' => "[TEST] {$m['subject']}", 'body' => $m['body']]);
    return ['ok' => true, 'to' => $u['email']];
});

// ---- audit, support, outbox ------------------------------------------------------------
route('GET', '/api/admin/audit', function () {
    adm_any();
    $prefix = mb_substr((string) qs('action', ''), 0, 60);
    $entries = rows("SELECT a.id, a.occurred_at, a.action, a.entity_type, a.entity_id, a.actor_role, a.details, u.full_name AS actor_name
                       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                      WHERE (? = '' OR substr(a.action, 1, length(?)) = ?) ORDER BY a.id DESC LIMIT 300", [$prefix, $prefix, $prefix]);
    foreach ($entries as &$e) if ($e['details'] === []) $e['details'] = (object) [];
    return ['entries' => $entries];
});
route('GET', '/api/admin/audit/verify', function () {
    adm_any();
    $r = audit_verify();
    // Node reports the total number of rows in "checked", also when the chain breaks.
    if (!$r['ok']) $r['checked'] = (int) val('SELECT count(*) FROM audit_log');
    return $r;
});

route('GET', '/api/admin/support', function () {
    adm_any();
    $cases = rows("SELECT s.*, u.full_name AS assignee, (s.due_at < ? AND s.status IN ('open','in_progress')) AS overdue
                     FROM support_cases s LEFT JOIN users u ON u.id = s.assigned_to
                    ORDER BY (s.status IN ('resolved','closed')), s.due_at IS NULL, s.due_at, s.created_at DESC LIMIT 300", [now_iso()]);
    return ['cases' => $cases];
});
route('POST', '/api/admin/support/:id', function ($a) {
    $u = adm_admin_or_support();
    $b = check(body(), ['status' => R::oneOf(['open', 'in_progress', 'resolved', 'closed']), 'resolution' => R::text(['optional' => true, 'max' => 2000])]);
    q('UPDATE support_cases SET status = ?, resolution = COALESCE(?, resolution), assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ?',
        [$b['status'], ($b['resolution'] ?? '') !== '' ? $b['resolution'] : null, $u['id'], now_iso(), $a['id']]);
    return ['ok' => true];
});

route('GET', '/api/admin/outbox', function () {
    adm_any();
    $list = rows('SELECT id, channel, kind, to_address, subject, status, provider, attempts, last_error, created_at, sent_at FROM message_outbox ORDER BY created_at DESC LIMIT 200');
    foreach ($list as &$m) $m['to_address'] = adm_mask($m['to_address']);
    return ['messages' => $list, 'adapters' => ['email' => mail_mode(), 'sms' => 'none']];
});

// ============================================================== subscribers (TicketRoom updates)
route('GET', '/api/admin/subscribers', function () {
    $u = adm_admin_or_support();
    if (qs('format') === 'csv') {
        $st = q("SELECT email, status, source, created_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers ORDER BY created_at");
        $out = "email,status,source,signed_up,confirmed,unsubscribed\n";
        $n = 0;
        while ($r = $st->fetch(PDO::FETCH_NUM)) { $out .= implode(',', array_map('org_csv_esc', $r)) . "\n"; $n++; }
        $st->closeCursor();
        audit('subscribers.exported', ['actor' => $u, 'entityType' => 'newsletter', 'details' => ['rows' => $n]]);
        return raw_out($out, 'text/csv; charset=utf-8', 200, ['Content-Disposition' => 'attachment; filename="ticketroom-subscribers.csv"']);
    }
    $q = str_replace(['%', '_', '\\'], '', mb_substr(trim((string) qs('q', '')), 0, 80));
    $counts = ['subscribed' => 0, 'pending' => 0, 'unsubscribed' => 0];
    foreach (rows('SELECT status, count(*) AS n FROM newsletter_subscribers GROUP BY status') as $r) $counts[$r['status']] = (int) $r['n'];
    return [
        'counts' => $counts,
        'subscribers' => rows("SELECT email, status, source, created_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE (? = '' OR lower(email) LIKE lower(?)) ORDER BY created_at DESC LIMIT 200", [$q, "%$q%"]),
        'issues' => rows('SELECT i.subject, i.recipients, i.created_at, u.full_name AS sent_by FROM newsletter_issues i JOIN users u ON u.id = i.sent_by ORDER BY i.created_at DESC LIMIT 20'),
    ];
});

// Send an update to every confirmed subscriber, or a test to yourself first.
route('POST', '/api/admin/subscribers/send', function () {
    $u = adm_admin();
    $b = check(body(), ['subject' => R::str(['min' => 3, 'max' => 150]), 'message' => R::text(['min' => 10, 'max' => 10000]), 'test' => R::bool()]);
    $B = base_url();
    if ($b['test']) {
        limit('newstest', 20, 3600, $u['id']);
        outbox_enqueue(['to' => $u['email'], 'userId' => $u['id'], 'kind' => 'marketing'] + tpl('newsletterUpdate', ['subject' => '[Test] ' . $b['subject'], 'message' => $b['message'], 'unsubscribeUrl' => "$B/unsubscribe"]));
        return ['ok' => true, 'test' => true, 'to' => $u['email']];
    }
    limit('newssend', 5, 86400, $u['id']);
    $n = tx(function () use ($u, $b, $B) {
        $id = uuid();
        $n = 0;
        foreach (rows("SELECT id, email FROM newsletter_subscribers WHERE status = 'subscribed'") as $s) {
            outbox_enqueue(['to' => $s['email'], 'kind' => 'marketing'] + tpl('newsletterUpdate', ['subject' => $b['subject'], 'message' => $b['message'],
                'unsubscribeUrl' => "$B/unsubscribe?t=" . sign_link(['n' => $s['id']], 365 * 86400)]));
            $n++;
        }
        if (!$n) throw conflict('There are no confirmed subscribers yet.', 'no_subscribers');
        insert('newsletter_issues', ['id' => $id, 'subject' => $b['subject'], 'body' => $b['message'], 'recipients' => $n, 'sent_by' => $u['id'], 'created_at' => now_iso()]);
        audit('newsletter.sent', ['actor' => $u, 'entityType' => 'newsletter', 'entityId' => $id, 'details' => ['recipients' => $n, 'subject' => $b['subject']]]);
        return $n;
    });
    return ['ok' => true, 'recipients' => $n];
});

// ============================================================== QR code maker
route('POST', '/api/admin/qr', function () {
    $u = adm_any();
    limit('adminqr', 120, 60, $u['id']);
    $b = check(body(), ['text' => R::text(['max' => 1200]), 'dark' => R::str(['optional' => true, 'max' => 7]),
        'light' => R::str(['optional' => true, 'max' => 7]), 'ecc' => R::oneOf(['M', 'Q', 'H'], ['optional' => true, 'fallback' => 'M'])]);
    return ['svg' => qr_for_people($b['text'], $b)];
});
