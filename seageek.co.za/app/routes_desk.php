<?php
/** Desk settings (channels, auto-close, rules), reports, file downloads and "who is viewing" checks. */
declare(strict_types=1);

/** @var Router $r */

function desk_settings(array $org, string $base): never
{
    $s = DeskSettings::get($org);
    $self = $base . '/desk-settings';
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'mail' || $a === 'mail_test') {
            $m = ['mode' => input('mode') === 'pop3' ? 'pop3' : 'none', 'host' => mb_substr(trim((string) input('host')), 0, 120), 'port' => max(1, min(65535, (int) input('port') ?: 995)),
                'ssl' => input('ssl') === '0' ? 0 : 1, 'user' => mb_substr(trim((string) input('user')), 0, 190), 'address' => strtolower(trim((string) input('address')))] + $s['mail'];
            if ((string) input('pass') !== '') $m['pass_enc'] = Crypto::encrypt((string) input('pass'));
            if ($m['mode'] === 'pop3' && !filter_var($m['address'], FILTER_VALIDATE_EMAIL)) { flash('error', 'Enter the support email address this mailbox receives, for example help@yourbusiness.co.za.'); redirect($self . '#email'); }
            if ($m['mode'] === 'pop3' && preg_match('/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/', $m['host']) && Settings::get('monitor_allow_private') !== '1') { flash('error', 'Enter your mail provider\'s server name, such as mail.yourbusiness.co.za.'); redirect($self . '#email'); }
            $s['mail'] = $m;
            DeskSettings::save((int) $org['id'], $s);
            if ($m['mode'] === 'pop3') {
                try {
                    $n = DeskMailbox::test($m);
                    // First successful connection: remember what is already there, so years of old mail are not imported.
                    if (!DB::value('SELECT COUNT(*) FROM desk_mail_seen WHERE org_id = ?', [$org['id']])) DeskMailbox::run(DB::one('SELECT * FROM orgs WHERE id = ?', [$org['id']]), true);
                    flash('ok', "Connected. The mailbox has $n email" . ($n === 1 ? '' : 's') . '. New emails become tickets within a minute; older ones are left alone.');
                } catch (Throwable $e) {
                    flash('error', 'Saved, but the connection failed: ' . $e->getMessage());
                }
            } else {
                flash('ok', 'Saved. Email import is off.');
            }
            audit('desk.mail_settings', (int) $org['id']);
            redirect($self . '#email');
        }
        if ($a === 'autoclose') {
            $s['autoclose_days'] = max(0, min(30, (int) input('autoclose_days')));
            DeskSettings::save((int) $org['id'], $s);
            flash('ok', 'Saved.');
            redirect($self . '#autoclose');
        }
        if ($a === 'rule_add') {
            $name = mb_substr(trim((string) input('name')), 0, 120);
            $words = mb_substr(trim((string) input('words')), 0, 500);
            $hasAction = input('set_priority') || input('set_status') || input('assign_to') || trim((string) input('add_tag')) !== '' || input('reply_macro');
            if ($name === '' || !$hasAction) { flash('error', 'Give the rule a name and choose at least one thing for it to do.'); redirect($self . '#rules'); }
            $assign = (int) input('assign_to');
            if ($assign && !DB::one('SELECT id FROM users WHERE id = ? AND (org_id = ? OR (is_admin = 1 AND ? = 1))', [$assign, $org['id'], (int) $org['is_house']])) $assign = 0;
            DB::insert('desk_rules', ['org_id' => $org['id'], 'name' => $name, 'event' => input('event') === 'replied' ? 'replied' : 'created',
                'field' => in_array(input('field'), ['any', 'subject', 'body', 'email'], true) ? input('field') : 'any', 'words' => $words ?: null,
                'channel' => in_array(input('channel'), ['chat', 'email', 'whatsapp', 'web', 'api'], true) ? input('channel') : null,
                'set_priority' => in_array(input('set_priority'), Desk::PRIORITIES, true) ? input('set_priority') : null,
                'set_status' => in_array(input('set_status'), ['pending', 'solved', 'person'], true) ? input('set_status') : null,
                'assign_to' => $assign ?: null, 'add_tag' => mb_substr(preg_replace('/[^a-z0-9-]+/', '-', strtolower(trim((string) input('add_tag')))), 0, 60) ?: null,
                'reply_macro' => (int) input('reply_macro') ?: null, 'position' => (int) DB::value('SELECT COUNT(*) FROM desk_rules WHERE org_id = ?', [$org['id']]), 'created_at' => now()]);
            flash('ok', 'Rule added. It runs on the next ticket.');
            redirect($self . '#rules');
        }
        if ($a === 'rule_toggle' || $a === 'rule_delete') {
            $rule = DB::one('SELECT * FROM desk_rules WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
            if ($rule) $a === 'rule_delete' ? DB::run('DELETE FROM desk_rules WHERE id = ?', [$rule['id']]) : DB::update('desk_rules', ['active' => $rule['active'] ? 0 : 1], 'id = ?', [$rule['id']]);
            redirect($self . '#rules');
        }
        redirect($self);
    }
    render('dash/desk_settings', ['title' => 'Desk settings', 'org' => $org, 'base' => $base, 's' => $s,
        'rules' => DB::all('SELECT * FROM desk_rules WHERE org_id = ? ORDER BY position, id', [$org['id']]),
        'macros' => DB::all('SELECT id, title FROM macros WHERE org_id = ?', [$org['id']]),
        'agents' => DB::all("SELECT id, name FROM users WHERE (org_id = ? OR (is_admin = 1 AND ? = 1)) AND disabled_at IS NULL", [$org['id'], (int) $org['is_house']]),
        'wa' => DB::all('SELECT phone, status FROM wa_numbers WHERE org_id = ?', [$org['id']]),
        'forward' => DeskSettings::forwardUrl($org), 'replyTo' => DeskSettings::replyTo($org)], 'app');
}

function desk_reports(array $org, string $base): never
{
    $days = in_array((int) ($_GET['days'] ?? 30), [7, 30, 90], true) ? (int) ($_GET['days'] ?? 30) : 30;
    render('dash/desk_reports', ['title' => 'Desk reports', 'org' => $org, 'base' => $base, 'days' => $days, 'r' => DeskReports::build((int) $org['id'], $days)], 'app');
}

$r->add('GET', '/desk/file/{token}/{name}', fn($token, $name) => DeskFiles::serve((string) $token));

// Agents' pages ask every 15 seconds who else has this ticket open.
$r->add('POST', '/desk/presence', function () {
    $u = Auth::user();
    if (!$u) json_out(['error' => 'Sign in'], 401);
    csrf_check();
    $t = Desk::ticket((int) input('ticket'));
    $ok = $t && ((int) $t['org_id'] === (int) $u['org_id'] || ($u['is_admin'] && (int) $t['org_id'] === (int) Desk::house()['id'] && Staff::can($u, 'desk')));
    if (!$ok) json_out(['error' => 'Not found'], 404);
    $others = DeskFlow::presence((int) $t['id'], (int) $u['id'], (bool) input('typing'));
    $last = (int) DB::value('SELECT MAX(id) FROM ticket_messages WHERE ticket_id = ? AND internal = 0', [$t['id']]);
    json_out(['others' => array_map(fn($o) => ['name' => $o['name'], 'typing' => (bool) $o['typing']], $others), 'last' => $last]);
});
