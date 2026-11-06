<?php
// Event teams from the admin portal (TicketRoom admins add, change and remove
// people with the organiser's own rules, invites and emails), and Team
// activity for the organiser and the admin portal. The rules are in lib/team.php.
declare(strict_types=1);

// The event and its organiser, for TicketRoom staff. Admins manage teams;
// admins and finance see what the team did. Support does neither.
function team_admin_event(string $id, bool $manage): array
{
    $u = $manage ? require_role('admin') : require_role('admin', 'finance');
    $ev = row('SELECT * FROM events WHERE id = ?', [$id]);
    if (!$ev) throw not_found('Event not found.');
    $org = row('SELECT * FROM organisers WHERE id = ?', [$ev['organiser_id']]);
    return ['user' => $u, 'event' => $ev, 'organiser' => $org];
}

route('GET', '/api/admin/events/:id/team', function ($a) {
    ['user' => $u, 'event' => $ev, 'organiser' => $org] = team_admin_event($a['id'], false);
    return ['event' => ['id' => $ev['id'], 'ref' => $ev['ref'], 'title' => $ev['title'], 'slug' => $ev['slug'], 'status' => $ev['status'], 'starts_at' => $ev['starts_at'], 'ends_at' => $ev['ends_at'],
            'venue_name' => $ev['venue_name'], 'city' => $ev['city'], 'organiser_name' => $org['name'] ?? '', 'organiser_status' => $org['status'] ?? ''],
        'staff' => team_list($ev), 'canManage' => has_role($u, 'admin')];
});
route('POST', '/api/admin/events/:id/staff', function ($a) {
    ['user' => $u, 'event' => $ev, 'organiser' => $org] = team_admin_event($a['id'], true);
    limit('staffadd', 30, 3600, $u['id']);
    return json_out(team_set($u, $ev, $org, body()), 201);
});
route('DELETE', '/api/admin/events/:id/staff/:userId', function ($a) {
    ['user' => $u, 'event' => $ev] = team_admin_event($a['id'], true);
    return team_remove($u, $ev, $a['userId']);
});
route('GET', '/api/admin/events/:id/team-activity', function ($a) {
    ['user' => $u, 'event' => $ev] = team_admin_event($a['id'], false);
    return qs('format') === 'csv' ? team_csv($u, $ev) : team_activity($ev);
});
route('GET', '/api/admin/events/:id/team-activity/:userId', function ($a) {
    ['user' => $u, 'event' => $ev] = team_admin_event($a['id'], false);
    if (qs('format') === 'csv') return team_csv($u, $ev, $a['userId']);
    return ['person' => team_person($a['userId'], $ev), 'items' => team_timeline_query($ev, $a['userId'])];
});

// The organiser's owners, managers and finance people.
const TEAM_ORG_VIEW = ['owner', 'manager', 'finance'];
route('GET', '/api/organiser/:orgId/events/:eventId/team-activity', function ($a) {
    $u = require_auth();
    ['event' => $ev] = event_access($u, $a['orgId'], $a['eventId'], TEAM_ORG_VIEW);
    return qs('format') === 'csv' ? team_csv($u, $ev) : team_activity($ev);
});
route('GET', '/api/organiser/:orgId/events/:eventId/team-activity/:userId', function ($a) {
    $u = require_auth();
    ['event' => $ev] = event_access($u, $a['orgId'], $a['eventId'], TEAM_ORG_VIEW);
    if (qs('format') === 'csv') return team_csv($u, $ev, $a['userId']);
    return ['person' => team_person($a['userId'], $ev), 'items' => team_timeline_query($ev, $a['userId'])];
});
