<?php
// Customer questions as conversations. Customer care answers them, or passes
// one to the organiser it belongs to; the organiser replies from their
// portal (the reply is emailed to the customer by TicketRoom) or hands it
// back. Every step is kept on the case, so nobody is left guessing.
declare(strict_types=1);

function sup_case(string $id): array
{
    $c = row('SELECT s.*, o.name AS organiser_name, o.ref AS organiser_ref, e.title AS event_title FROM support_cases s
               LEFT JOIN organisers o ON o.id = s.organiser_id LEFT JOIN events e ON e.id = s.event_id WHERE s.id = ?', [$id]);
    if (!$c) throw not_found('Case not found.');
    return $c;
}
function sup_messages(string $caseId, bool $customerView = false): array
{
    return rows('SELECT m.id, m.author_kind, m.body, m.emailed, m.created_at, u.full_name AS author_name FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
                  WHERE m.case_id = ?' . ($customerView ? " AND m.emailed = 1" : '') . ' ORDER BY m.id', [$caseId]);
}
function sup_note(string $caseId, ?string $authorId, string $kind, string $body, bool $emailed = false): void
{
    q('INSERT INTO support_messages (case_id, author_id, author_kind, body, emailed, created_at) VALUES (?,?,?,?,?,?)', [$caseId, $authorId, $kind, $body, $emailed ? 1 : 0, now_iso()]);
}
// The customer's events, so customer care can pick the right organiser in one click.
function sup_suggestions(array $c): array
{
    return rows("SELECT DISTINCT e.organiser_id, org.name AS organiser_name, org.ref AS organiser_ref, e.id AS event_id, e.title AS event_title, e.starts_at
                   FROM orders o JOIN events e ON e.id = o.event_id JOIN organisers org ON org.id = e.organiser_id
                  WHERE (o.user_id = ? OR lower(o.buyer_email) = lower(?)) AND o.status IN ('paid','partially_refunded','refunded','paid_unfulfilled')
                  ORDER BY e.starts_at DESC LIMIT 10", [$c['user_id'] ?? '', $c['email']]);
}

// ============================================================== customer care
route('GET', '/api/admin/support/:id', function ($a) {
    adm_any();
    $c = sup_case($a['id']);
    return ['case' => $c, 'messages' => sup_messages($c['id']), 'suggestions' => sup_suggestions($c)];
});
route('POST', '/api/admin/support/:id/reply', function ($a) {
    $u = adm_admin_or_support();
    limit('supreply', 120, 3600, $u['id']);
    $b = check(body(), ['message' => R::text(['min' => 2, 'max' => 5000]), 'resolve' => R::bool()]);
    $c = sup_case($a['id']);
    tx(function () use ($u, $b, $c) {
        sup_note($c['id'], $u['id'], 'ticketroom', $b['message'], true);
        outbox_enqueue(['to' => $c['email'], 'userId' => $c['user_id']] + tpl('supportReply', ['name' => $c['full_name'], 'subject' => $c['subject'], 'reference' => $c['reference'], 'message' => $b['message'],
            'from' => explode(' ', $u['fullName'])[0] . ', TicketRoom customer care']));
        q('UPDATE support_cases SET status = ?, assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ?', [$b['resolve'] ? 'resolved' : 'in_progress', $u['id'], now_iso(), $c['id']]);
        audit('support.replied', ['actor' => $u, 'entityType' => 'support_case', 'entityId' => $c['id']]);
    });
    return ['ok' => true];
});
// Pass a question to the organiser it belongs to.
route('POST', '/api/admin/support/:id/transfer', function ($a) {
    $u = adm_admin_or_support();
    limit('suptransfer', 60, 3600, $u['id']);
    $b = check(body(), ['organiserId' => R::uuid(), 'eventId' => R::uuid(['optional' => true]), 'note' => R::text(['optional' => true, 'max' => 1000]), 'tellCustomer' => org_bool(['optional' => true, 'fallback' => true])]);
    $c = sup_case($a['id']);
    $org = row("SELECT * FROM organisers WHERE id = ? AND status = 'approved'", [$b['organiserId']]);
    if (!$org) throw not_found('Organiser not found, or not approved.');
    if (!empty($b['eventId']) && !val('SELECT 1 FROM events WHERE id = ? AND organiser_id = ?', [$b['eventId'], $org['id']])) throw bad('That event belongs to another organiser.');
    tx(function () use ($u, $b, $c, $org) {
        $now = now_iso();
        q("UPDATE support_cases SET organiser_id = ?, event_id = ?, handled_by = 'organiser', transferred_at = ?, status = 'in_progress', assigned_to = COALESCE(assigned_to, ?), updated_at = ? WHERE id = ?",
            [$org['id'], $b['eventId'] ?? null, $now, $u['id'], $now, $c['id']]);
        sup_note($c['id'], $u['id'], 'system', "Passed to {$org['name']}" . (!empty($b['note']) ? ": {$b['note']}" : '.'));
        $event = !empty($b['eventId']) ? val('SELECT title FROM events WHERE id = ?', [$b['eventId']]) : null;
        outbox_enqueue(['to' => $org['contact_email']] + tpl('queryForOrganiser', ['organiser' => $org['name'], 'reference' => $c['reference'], 'customer' => $c['full_name'] ?: $c['email'],
            'event' => $event, 'subject' => $c['subject'], 'body' => $c['body'], 'note' => $b['note'] ?? null]));
        if ($b['tellCustomer']) {
            outbox_enqueue(['to' => $c['email'], 'userId' => $c['user_id']] + tpl('queryPassedOn', ['name' => $c['full_name'], 'organiser' => $org['name'], 'reference' => $c['reference']]));
            sup_note($c['id'], $u['id'], 'ticketroom', "We've passed your question to {$org['name']}. They'll reply to you by email.", true);
        }
        audit('support.transferred', ['actor' => $u, 'entityType' => 'support_case', 'entityId' => $c['id'], 'organiserId' => $org['id']]);
    });
    return ['case' => sup_case($c['id'])];
});
route('POST', '/api/admin/support/:id/take-back', function ($a) {
    $u = adm_admin_or_support();
    $c = sup_case($a['id']);
    // Taken back: the organiser no longer sees the case or anything said after.
    q("UPDATE support_cases SET handled_by = 'ticketroom', organiser_id = NULL, event_id = NULL, status = 'in_progress', updated_at = ? WHERE id = ?", [now_iso(), $c['id']]);
    sup_note($c['id'], $u['id'], 'system', "Taken back by TicketRoom customer care from {$c['organiser_name']}.");
    audit('support.taken_back', ['actor' => $u, 'entityType' => 'support_case', 'entityId' => $c['id']]);
    return ['case' => sup_case($c['id'])];
});
// Organisers to pass a question to: approved ones, by name or ID.
route('GET', '/api/admin/support-organisers', function () {
    adm_any();
    $q = trim(mb_substr((string) qs('q', ''), 0, 60));
    $like = '%' . like_escape(mb_strtolower($q)) . '%';
    return ['organisers' => rows("SELECT id, name, ref, contact_email FROM organisers WHERE status = 'approved' AND (? = '' OR ref = upper(?) OR lower(name) LIKE ? ESCAPE '\\\\') ORDER BY name LIMIT 20", [$q, $q, $like])];
});

// ============================================================== organisers
function sup_org_case(string $orgId, string $id): array
{
    $c = sup_case($id);
    if ($c['organiser_id'] !== $orgId) throw not_found('Query not found.');
    return $c;
}
route('GET', '/api/organiser/:orgId/queries', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ['owner', 'manager']);
    $list = rows("SELECT s.id, s.reference, s.subject, s.full_name, s.email, s.status, s.handled_by, s.transferred_at, s.updated_at, e.title AS event_title
                    FROM support_cases s LEFT JOIN events e ON e.id = s.event_id WHERE s.organiser_id = ?
                   ORDER BY (s.handled_by = 'organiser' AND s.status IN ('open','in_progress')) DESC, s.updated_at DESC LIMIT 200", [$a['orgId']]);
    $open = count(array_filter($list, fn($c) => $c['handled_by'] === 'organiser' && in_array($c['status'], ['open', 'in_progress'], true)));
    return ['queries' => $list, 'open' => $open];
});
route('GET', '/api/organiser/:orgId/queries/:id', function ($a) {
    organiser_access(require_auth(), $a['orgId'], ['owner', 'manager']);
    $c = sup_org_case($a['orgId'], $a['id']);
    $view = array_intersect_key($c, array_flip(['id', 'reference', 'subject', 'body', 'full_name', 'email', 'phone', 'status', 'handled_by', 'transferred_at', 'created_at', 'event_title', 'category']));
    return ['query' => $view, 'messages' => array_values(array_filter(sup_messages($c['id']), fn($m) => $m['author_kind'] !== 'system' || str_starts_with($m['body'], 'Passed to')))];
});
route('POST', '/api/organiser/:orgId/queries/:id/reply', function ($a) {
    $u = require_auth();
    limit('orgreply', 120, 3600, $u['id']);
    ['organiser' => $org] = organiser_access($u, $a['orgId'], ['owner', 'manager']);
    $b = check(body(), ['message' => R::text(['min' => 2, 'max' => 5000]), 'resolve' => R::bool()]);
    $c = sup_org_case($org['id'], $a['id']);
    if ($c['handled_by'] !== 'organiser') throw conflict('TicketRoom has taken this query back.', 'not_yours');
    tx(function () use ($u, $b, $c, $org) {
        sup_note($c['id'], $u['id'], 'organiser', $b['message'], true);
        outbox_enqueue(['to' => $c['email'], 'userId' => $c['user_id']] + tpl('supportReply', ['name' => $c['full_name'], 'subject' => $c['subject'], 'reference' => $c['reference'], 'message' => $b['message'],
            'from' => explode(' ', $u['fullName'])[0] . ", {$org['name']}"]));
        q('UPDATE support_cases SET status = ?, updated_at = ? WHERE id = ?', [$b['resolve'] ? 'resolved' : 'in_progress', now_iso(), $c['id']]);
        audit('support.organiser_replied', ['actor' => $u, 'entityType' => 'support_case', 'entityId' => $c['id'], 'organiserId' => $org['id']]);
    });
    return ['ok' => true];
});
route('POST', '/api/organiser/:orgId/queries/:id/return', function ($a) {
    $u = require_auth();
    ['organiser' => $org] = organiser_access($u, $a['orgId'], ['owner', 'manager']);
    $b = check(body(), ['note' => R::text(['min' => 3, 'max' => 1000])]);
    $c = sup_org_case($org['id'], $a['id']);
    q("UPDATE support_cases SET handled_by = 'ticketroom', organiser_id = NULL, event_id = NULL, status = 'open', updated_at = ? WHERE id = ?", [now_iso(), $c['id']]);
    sup_note($c['id'], $u['id'], 'system', "Sent back by {$org['name']}: {$b['note']}");
    audit('support.returned', ['actor' => $u, 'entityType' => 'support_case', 'entityId' => $c['id'], 'organiserId' => $org['id']]);
    return ['ok' => true];
});

// ============================================================== customers
route('GET', '/api/me/support/:ref', function ($a) {
    $u = require_auth();
    $c = row('SELECT id, reference, subject, body, status, created_at FROM support_cases WHERE reference = ? AND user_id = ?', [$a['ref'], $u['id']]);
    if (!$c) throw not_found('Case not found.');
    return ['case' => $c, 'messages' => array_map(fn($m) => ['from' => $m['author_kind'] === 'organiser' ? 'organiser' : 'ticketroom', 'body' => $m['body'], 'created_at' => $m['created_at']], sup_messages($c['id'], true))];
});
