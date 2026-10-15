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
function adm_ledger(): array { return ledger_check(); }
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
                    FROM orders WHERE test = 0 AND status IN ('paid','partially_refunded','refunded','paid_unfulfilled')", [$since, $since]);
    $ops = [
        'refunds_pending' => (int) val("SELECT count(*) FROM refunds WHERE status IN ('requested','manual_pending')"),
        'refunds_failed' => (int) val("SELECT count(*) FROM refunds WHERE status = 'failed'"),
        'payouts_open' => (int) val("SELECT count(*) FROM payouts WHERE status IN ('requested','approved')"),
        'webhook_problems' => (int) val("SELECT count(*) FROM webhook_events WHERE status IN ('failed','rejected') AND received_at > ?", [iso_in(-7 * 86400)]),
        'recon_exceptions' => (int) val('SELECT count(*) FROM recon_items WHERE resolved = 0'),
        'support_open' => (int) val("SELECT count(*) FROM support_cases WHERE status IN ('open','in_progress')"),
        'unfulfilled' => (int) val("SELECT count(*) FROM orders WHERE status = 'paid_unfulfilled'"),
        'messages_failed' => (int) val("SELECT count(*) FROM message_outbox WHERE status = 'failed'"),
        'stale_payments' => (int) val("SELECT count(*) FROM payments WHERE status = 'pending' AND created_at < ?", [iso_in(-3600)]),
        'payments_test' => pay_ready() && pay_test() ? 1 : 0,
        'test_orders' => (int) val("SELECT count(*) FROM orders WHERE test = 1 AND status <> 'cancelled'"),
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
        // Every paid order gets a full refund, booking fee included, for finance to approve.
        $raised = 0;
        foreach (rows("SELECT * FROM orders WHERE event_id = ? AND status IN ('paid','partially_refunded') AND total_cents > refunded_cents", [$ev['id']]) as $o) {
            try { refund_create($o, $u, [], true, 'event_cancelled', 'Event cancelled: ' . $b['reason']); $raised++; } catch (AppError $e) { /* nothing left to refund */ }
        }
        $holders = rows("SELECT DISTINCT u.id, u.email, u.full_name, MAX(t.price_cents) AS paid FROM tickets t JOIN users u ON u.id = t.owner_user_id
                          WHERE t.event_id = ? AND t.status IN ('valid','refunded') GROUP BY u.id", [$ev['id']]);
        foreach ($holders as $h) {
            outbox_enqueue(['to' => $h['email'], 'userId' => $h['id']] + tpl('eventCancelled', ['name' => $h['full_name'], 'event' => $ev, 'reason' => $b['reason'], 'paid' => (int) $h['paid'] > 0]));
        }
        q("UPDATE tickets SET status = 'revoked', revoked_reason = 'event cancelled', updated_at = ? WHERE event_id = ? AND status = 'valid' AND price_cents = 0", [$now, $ev['id']]);
        audit('event.cancelled', ['actor' => $u, 'entityType' => 'event', 'entityId' => $ev['id'], 'organiserId' => $ev['organiser_id'], 'details' => ['reason' => $b['reason'], 'refundsRaised' => $raised]]);
        return ['refundsRaised' => $raised];
    });
});

// ---- users -----------------------------------------------------------------------
// The platform owner: the first administrator. Only they act on their own account.
function adm_owner_id(): string { return (string) val("SELECT value FROM meta WHERE key = 'owner_user_id'"); }
function adm_guard_owner(array $actor, string $targetId): void
{
    if ($targetId === adm_owner_id() && $actor['id'] !== $targetId) throw forbidden('That is the platform owner. Only the owner can change their own account.');
}
// Customers and organisers. TicketRoom staff are managed under Staff & roles.
route('GET', '/api/admin/users', function () {
    adm_admin_or_support();
    $s = adm_search('q');
    $type = (string) qs('type', '');
    if (!in_array($type, ['', 'customer', 'organiser'], true)) $type = '';
    $like = "%$s%";
    $list = rows("SELECT u.id, u.email, u.full_name, u.phone, u.status, u.account_type, u.guest, u.created_at, u.email_verified_at,
                         (SELECT group_concat(o.name, ', ') FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = u.id) AS organisations
                    FROM users u
                   WHERE u.account_type <> 'staff' AND (? = '' OR u.account_type = ?)
                     AND (? = '' OR lower(u.email) LIKE lower(?) OR lower(u.full_name) LIKE lower(?) OR lower(COALESCE(u.phone,'')) LIKE lower(?))
                   ORDER BY u.created_at DESC LIMIT 100", [$type, $type, $s, $like, $like, $like]);
    $counts = [];
    foreach (rows("SELECT account_type, count(*) AS n FROM users WHERE account_type <> 'staff' GROUP BY account_type") as $r) $counts[$r['account_type']] = (int) $r['n'];
    return ['users' => $list, 'counts' => $counts];
});

route('GET', '/api/admin/users/:id', function ($a) {
    adm_admin_or_support();
    $user = row("SELECT id, email, full_name, phone, status, account_type, guest, created_at, email_verified_at FROM users WHERE id = ? AND account_type <> 'staff'", [$a['id']]);
    if (!$user) throw not_found('User not found.');
    $user['has_pin'] = (bool) val('SELECT spending_pin_hash IS NOT NULL FROM users WHERE id = ?', [$a['id']]);
    return [
        'user' => $user,
        'organisations' => rows('SELECT o.id, o.name, o.ref, o.status, m.role FROM organiser_members m JOIN organisers o ON o.id = m.organiser_id WHERE m.user_id = ? ORDER BY o.name', [$a['id']]),
        'orders' => rows('SELECT o.id, o.reference, o.status, o.total_cents, o.created_at, e.title FROM orders o JOIN events e ON e.id = o.event_id WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50', [$a['id']]),
        'tickets' => rows('SELECT t.id, t.code, t.status, e.title, t.admitted_at FROM tickets t JOIN events e ON e.id = t.event_id WHERE t.owner_user_id = ? ORDER BY t.created_at DESC LIMIT 100', [$a['id']]),
        'tags' => array_map(fn($t) => ['display_code' => tag_display($t['display_code'])] + $t,
            rows('SELECT t.id, t.display_code, t.tag_type, t.status, e.title FROM tags t LEFT JOIN events e ON e.id = t.event_id WHERE t.user_id = ?', [$a['id']])),
    ];
});

route('POST', '/api/admin/users/:id/status', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['status' => R::oneOf(['active', 'suspended']), 'reason' => R::str(['min' => 3, 'max' => 400])]);
    if ($a['id'] === $u['id']) throw bad('You cannot change your own status.');
    adm_guard_owner($u, $a['id']);
    tx(function () use ($a, $b) {
        $now = now_iso();
        // Staff accounts are switched on and off under Staff & roles only.
        if (!affected("UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status <> 'deleted' AND account_type <> 'staff'", [$b['status'], $now, $a['id']])) throw not_found('User not found.');
        if ($b['status'] === 'suspended') q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [$now, $a['id']]);
    });
    audit("user.{$b['status']}", ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['reason' => $b['reason']]]);
    return ['ok' => true];
});

// ---- TicketRoom staff (admin portal team) --------------------------------------------
// Staff accounts are made here and nowhere else. A customer's or organiser's
// account can never become staff: staff use their own work email.
const STAFF_ROLE_NAMES = ['admin' => 'Admin', 'finance' => 'Finance', 'support' => 'Support'];
function adm_staff_target(array $actor, string $id): array
{
    $t = row("SELECT * FROM users WHERE id = ? AND account_type = 'staff'", [$id]);
    if (!$t) throw not_found('Staff member not found.');
    adm_guard_owner($actor, $id);
    return $t;
}
function adm_staff_reset_link(string $userId, int $days = 7): string
{
    $token = random_token(32);
    insert('password_resets', ['token_hash' => sha256($token), 'user_id' => $userId, 'expires_at' => iso_in($days * 86400), 'created_at' => now_iso()]);
    return base_url() . "/admin#/reset/$token";
}
route('GET', '/api/admin/staff', function () {
    adm_any();
    $list = rows("SELECT u.id, u.full_name, u.email, u.status, u.created_at, group_concat(r.role) AS roles
                    FROM users u LEFT JOIN platform_roles r ON r.user_id = u.id WHERE u.account_type = 'staff' GROUP BY u.id ORDER BY u.full_name");
    $owner = adm_owner_id();
    foreach ($list as &$x) { $x['roles'] = array_values(array_filter(explode(',', (string) $x['roles']))); $x['owner'] = $x['id'] === $owner; }
    return ['staff' => $list];
});
// Add someone to the team: a new staff account and an email to set a password.
route('POST', '/api/admin/staff', function () {
    $u = adm_admin();
    limit('staffteam', 30, 3600, $u['id']);
    $b = check(body(), ['email' => R::email(), 'fullName' => R::str(['min' => 2, 'max' => 120]), 'roles' => R::arr(R::oneOf(array_keys(STAFF_ROLE_NAMES)), ['min' => 1, 'max' => 3])]);
    $roles = array_values(array_unique($b['roles']));
    return tx(function () use ($u, $b, $roles) {
        $now = now_iso();
        $existing = user_by_email($b['email']);
        if ($existing && account_type($existing) !== 'staff') {
            throw conflict('That email already belongs to a customer or organiser account. Staff need their own work email, for example name@ticketroom.co.za.', 'not_staff_account', ['email' => 'Use a work email.']);
        }
        if ($existing) {
            adm_guard_owner($u, $existing['id']);
            $id = $existing['id'];
            q("UPDATE users SET status = 'active', updated_at = ? WHERE id = ?", [$now, $id]);
        } else {
            $id = uuid();
            insert('users', ['id' => $id, 'email' => $b['email'], 'email_key' => email_key($b['email']), 'full_name' => $b['fullName'], 'password_hash' => hash_secret(random_token(24)),
                'status' => 'active', 'account_type' => 'staff', 'email_verified_at' => null, 'created_at' => $now, 'updated_at' => $now]);
        }
        $url = $existing ? null : adm_staff_reset_link($id);
        foreach ($roles as $r) q('INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', [$id, $r, $u['id'], $now]);
        $names = implode(' and ', array_map(fn($r) => STAFF_ROLE_NAMES[$r], $roles));
        outbox_enqueue(['to' => $b['email'], 'userId' => $id] + tpl('teamInvite', ['name' => $existing ? $existing['full_name'] : $b['fullName'], 'by' => $u['fullName'], 'roles' => $names, 'url' => $url]));
        audit('staff.added', ['actor' => $u, 'entityType' => 'user', 'entityId' => $id, 'details' => ['roles' => $roles, 'newAccount' => !$existing]]);
        return json_out(['ok' => true, 'invited' => !$existing], 201);
    });
});
// Set exactly these roles. An empty list takes the person off the team: their
// staff account is switched off until someone adds them again.
route('PUT', '/api/admin/staff/:id', function ($a) {
    $u = adm_admin();
    $b = check(body(), ['roles' => R::arr(R::oneOf(array_keys(STAFF_ROLE_NAMES)), ['max' => 3])]);
    if ($a['id'] === $u['id']) throw forbidden('You cannot change your own roles. Ask another admin.');
    adm_staff_target($u, $a['id']);
    $want = array_values(array_unique($b['roles']));
    tx(function () use ($u, $a, $want) {
        $now = now_iso();
        $have = array_column(rows('SELECT role FROM platform_roles WHERE user_id = ?', [$a['id']]), 'role');
        foreach (array_diff($have, $want) as $r) { q('DELETE FROM platform_roles WHERE user_id = ? AND role = ?', [$a['id'], $r]); audit('role.revoked', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['role' => $r]]); }
        foreach (array_diff($want, $have) as $r) { q('INSERT INTO platform_roles (user_id, role, granted_by, granted_at) VALUES (?,?,?,?)', [$a['id'], $r, $u['id'], $now]); audit('role.granted', ['actor' => $u, 'entityType' => 'user', 'entityId' => $a['id'], 'details' => ['role' => $r]]); }
        if (!$want) {
            q("UPDATE users SET status = 'suspended', updated_at = ? WHERE id = ?", [$now, $a['id']]);
            q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [$now, $a['id']]);
        }
        if (!val("SELECT 1 FROM platform_roles r JOIN users x ON x.id = r.user_id WHERE r.role = 'admin' AND x.status = 'active' AND x.account_type = 'staff'")) throw conflict('TicketRoom needs at least one active admin.', 'last_admin');
    });
    return ['ok' => true];
});
// The owner or an admin sends a staff member a link to choose a new password.
// Staff cannot reset their own password from the sign-in box.
route('POST', '/api/admin/staff/:id/reset', function ($a) {
    $u = adm_admin();
    limit('staffreset', 20, 3600, $u['id']);
    $t = adm_staff_target($u, $a['id']);
    if ($t['status'] !== 'active') throw conflict('That staff account is switched off. Add them to the team again first.', 'account_inactive');
    tx(function () use ($u, $t) {
        q('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [now_iso(), $t['id']]);
        $url = adm_staff_reset_link($t['id'], 1);
        outbox_enqueue(['to' => $t['email'], 'userId' => $t['id']] + tpl('staffPasswordReset', ['name' => $t['full_name'], 'by' => $u['fullName'], 'url' => $url]));
        audit('staff.password_reset_sent', ['actor' => $u, 'entityType' => 'user', 'entityId' => $t['id']]);
    });
    return ['ok' => true, 'message' => "A link to choose a new password is on its way to {$t['email']}. It works for 24 hours."];
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
    foreach ($list as &$o) $o['payments'] = array_map(fn($p) => ['provider' => $p['provider'], 'ref' => $p['provider_reference'], 'status' => $p['status']], rows('SELECT provider, provider_reference, status FROM payments WHERE order_id = ? ORDER BY created_at', [$o['id']]));
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

// Payments, webhooks, refunds, payouts, reconciliation and the ledger: routes/finance.php.

// Tags, terminals and cashless settlement figures: routes/cashless.php.

// Integrations (email, card payments, SMS): routes/finance.php.

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
    limit('emailtest', 100, 3600, $u['id']);
    $b = check(body(), ['to' => R::email(['optional' => true])]);
    $to = $b['to'] ?? $u['email'];
    $m = adm_catalog_item($a['key'])['sample']();
    $r = send_now($to, "[TEST] {$m['subject']}", $m['body'], null);
    return $r + ['to' => $to];
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
    $cases = rows("SELECT s.*, u.full_name AS assignee, (s.due_at < ? AND s.status IN ('open','in_progress')) AS overdue, org.name AS organiser_name
                     FROM support_cases s LEFT JOIN users u ON u.id = s.assigned_to LEFT JOIN organisers org ON org.id = s.organiser_id
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
