<?php
/** Plug-ins: website chat, WhatsApp button, website forms, short links, website monitors. */
declare(strict_types=1);

/** @var Router $r */

$clean = fn(string $k, int $max = 190) => mb_substr(trim((string) input($k)), 0, $max);
$phoneOk = fn(string $p) => $p === '' || preg_match('/^\+?[0-9 ()-]{9,20}$/', $p);

// Public pages ----------------------------------------------------------------

$r->add('GET', '/plugins', fn() => render('site/plugins', ['title' => 'Plug-ins: no-code tools for your website', 'nav' => 'plugins', 'description' => 'Website chat, WhatsApp button, website forms, short links, website monitoring, QR codes and store SMS. Copy, paste, done.']));
$r->add('GET', '/l/{code}', fn($code) => ShortLinks::open((string) $code));
$r->add('GET|POST|OPTIONS', '/f/{token}', fn($token) => WebForms::receive((string) $token));

// Dashboard: overview of all plug-ins -------------------------------------------

$r->add('GET', '/dashboard/plugins', function () {
    $org = require_org();
    $n = fn(string $sql) => (int) DB::value($sql, [$org['id']]);
    render('tools/index', ['title' => 'Plug-ins', 'org' => $org, 'counts' => [
        'forms' => $n('SELECT COUNT(*) FROM web_forms WHERE org_id = ?'), 'links' => $n('SELECT COUNT(*) FROM short_links WHERE org_id = ?'),
        'monitor' => $n('SELECT COUNT(*) FROM monitors WHERE org_id = ?'), 'qr' => $n('SELECT COUNT(*) FROM qr_codes WHERE org_id = ?'),
        'stores' => $n('SELECT COUNT(*) FROM stores WHERE org_id = ?'), 'campaigns' => $n('SELECT COUNT(*) FROM campaigns WHERE org_id = ?'),
    ]], 'app');
});

// Website chat and WhatsApp button ---------------------------------------------

$r->add('GET|POST', '/dashboard/chat', function () use ($clean) {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $s = Plugins::chatSettings($org);
        if (input('action') === 'whatsapp') {
            $num = trim((string) input('wa_number'));
            $wa = $num === '' ? '' : Plugins::waNumber($num);
            if ($num !== '' && $wa === '') { flash('error', 'Enter your WhatsApp number, for example 082 123 4567 or +27 82 123 4567.'); redirect('/dashboard/chat#whatsapp'); }
            $s = ['wa_number' => $wa, 'wa_text' => $clean('wa_text', 200), 'wa_label' => $clean('wa_label', 40) ?: 'Chat on WhatsApp'] + $s;
            $to = '/dashboard/chat#whatsapp';
        } else {
            $color = (string) input('color');
            $s = ['title' => $clean('title', 40) ?: 'Chat with us', 'color' => preg_match('/^#[0-9a-fA-F]{6}$/', $color) ? strtolower($color) : '#5fe3cf', 'greeting' => $clean('greeting', 240)] + $s;
            $to = '/dashboard/chat';
        }
        DB::update('orgs', ['chat_settings' => json_encode($s, JSON_UNESCAPED_UNICODE)], 'id = ?', [$org['id']]);
        flash('ok', 'Saved. Your snippet below is up to date.');
        redirect($to);
    }
    render('tools/chat', ['title' => 'Website chat', 'org' => $org, 's' => Plugins::chatSettings($org),
        'chats' => (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND channel = 'chat' AND created_at > ?", [$org['id'], ts('-30 days')])], 'app');
});

// Website forms ------------------------------------------------------------------

$r->add('GET|POST', '/dashboard/forms', function () use ($clean, $phoneOk) {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $name = $clean('name', 120);
        $email = strtolower($clean('notify_email'));
        $phone = $clean('notify_phone', 30);
        $thanks = $clean('thanks_url', 500);
        if ($name === '') { flash('error', 'Give the form a name, for example "Contact form".'); redirect('/dashboard/forms'); }
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) { flash('error', 'Enter a valid email address for notifications.'); redirect('/dashboard/forms'); }
        if (!$phoneOk($phone)) { flash('error', 'Enter a valid mobile number for SMS alerts, or leave it empty.'); redirect('/dashboard/forms'); }
        if ($thanks !== '' && !preg_match('#^https?://#i', $thanks)) { flash('error', 'The thank-you page must be a full link starting with https://.'); redirect('/dashboard/forms'); }
        if ((int) DB::value('SELECT COUNT(*) FROM web_forms WHERE org_id = ?', [$org['id']]) >= 50) { flash('error', 'You can have up to 50 forms.'); redirect('/dashboard/forms'); }
        $f = WebForms::create($org, $name, $email, $phone, (bool) input('to_desk'), $clean('auto_reply', 2000), $thanks);
        audit('form.created', (int) $org['id'], $f['name']);
        redirect('/dashboard/forms/' . $f['id'] . '?new=1');
    }
    render('tools/forms', ['title' => 'Website forms', 'org' => $org, 'me' => Auth::user(), 'forms' => DB::all('SELECT * FROM web_forms WHERE org_id = ? ORDER BY id DESC', [$org['id']])], 'app');
});

$r->add('GET|POST', '/dashboard/forms/{id}', function ($id) use ($clean, $phoneOk) {
    $org = require_org();
    $f = DB::one('SELECT * FROM web_forms WHERE id = ? AND org_id = ?', [(int) $id, $org['id']]) ?? redirect('/dashboard/forms');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'save') {
            $email = strtolower($clean('notify_email'));
            $phone = $clean('notify_phone', 30);
            $thanks = $clean('thanks_url', 500);
            if (($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) || !$phoneOk($phone) || ($thanks !== '' && !preg_match('#^https?://#i', $thanks))) {
                flash('error', 'Check the email address, mobile number and thank-you link.'); redirect('/dashboard/forms/' . $f['id']);
            }
            DB::update('web_forms', ['name' => $clean('name', 120) ?: $f['name'], 'notify_email' => $email ?: null, 'notify_phone' => $phone ?: null, 'to_desk' => input('to_desk') ? 1 : 0,
                'auto_reply' => $clean('auto_reply', 2000) ?: null, 'thanks_url' => $thanks ?: null], 'id = ?', [$f['id']]);
            flash('ok', 'Form saved.');
        } elseif ($a === 'pause' || $a === 'resume') {
            DB::update('web_forms', ['status' => $a === 'pause' ? 'paused' : 'active'], 'id = ?', [$f['id']]);
            flash('ok', $a === 'pause' ? 'Form paused. New messages are refused until you switch it back on.' : 'Form is accepting messages again.');
        } elseif ($a === 'delete') {
            DB::run('DELETE FROM web_form_entries WHERE form_id = ?', [$f['id']]);
            DB::run('DELETE FROM web_forms WHERE id = ?', [$f['id']]);
            flash('ok', 'Form deleted.');
            redirect('/dashboard/forms');
        }
        redirect('/dashboard/forms/' . $f['id']);
    }
    if (input('export') === 'csv') {
        $rows = DB::all('SELECT * FROM web_form_entries WHERE form_id = ? ORDER BY id', [$f['id']]);
        $cols = [];
        foreach ($rows as $row) foreach (array_keys(json_decode($row['data'], true) ?: []) as $k) $cols[$k] = true;
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . preg_replace('/[^a-z0-9]+/i', '-', $f['name']) . '.csv"');
        $out = fopen('php://output', 'w');
        fputcsv($out, array_merge(['Received'], array_keys($cols), ['Page']));
        foreach ($rows as $row) {
            $d = json_decode($row['data'], true) ?: [];
            // Cells starting with = + - @ are prefixed so spreadsheets do not run them as formulas.
            $cells = array_map(fn($k) => preg_match('/^[=+\-@]/', (string) ($d[$k] ?? '')) ? "'" . $d[$k] : (string) ($d[$k] ?? ''), array_keys($cols));
            fputcsv($out, array_merge([$row['created_at']], $cells, [(string) $row['page']]));
        }
        exit;
    }
    render('tools/form', ['title' => $f['name'], 'org' => $org, 'f' => $f, 'new' => (bool) input('new'),
        'entries' => DB::all('SELECT e.*, t.number ticket_no FROM web_form_entries e LEFT JOIN tickets t ON t.id = e.ticket_id WHERE e.form_id = ? ORDER BY e.id DESC LIMIT 100', [$f['id']])], 'app');
});

// Short links ----------------------------------------------------------------------

$r->add('GET|POST', '/dashboard/links', function () use ($clean) {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $url = trim((string) input('url'));
        $code = trim((string) input('code'));
        if ($err = ShortLinks::problem($url, $code)) { flash('error', $err); $_SESSION['old'] = $_POST; redirect('/dashboard/links'); }
        if ((int) DB::value('SELECT COUNT(*) FROM short_links WHERE org_id = ? AND created_at > ?', [$org['id'], ts('-1 day')]) >= 200) { flash('error', 'You have made 200 links today. Try again tomorrow.'); redirect('/dashboard/links'); }
        $l = ShortLinks::create($org, $url, $clean('name', 120), $code);
        audit('link.created', (int) $org['id'], $l['code']);
        $_SESSION['new_link'] = $l['id'];
        redirect('/dashboard/links');
    }
    render('tools/links', ['title' => 'Short links', 'org' => $org, 'links' => DB::all('SELECT * FROM short_links WHERE org_id = ? ORDER BY id DESC LIMIT 300', [$org['id']])], 'app');
});

$r->add('GET|POST', '/dashboard/links/{id}', function ($id) use ($clean) {
    $org = require_org();
    $l = DB::one('SELECT * FROM short_links WHERE id = ? AND org_id = ?', [(int) $id, $org['id']]) ?? redirect('/dashboard/links');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'save') {
            $url = trim((string) input('url'));
            if ($err = ShortLinks::problem($url, '', (int) $l['id'])) { flash('error', $err); redirect('/dashboard/links/' . $l['id']); }
            DB::update('short_links', ['target_url' => $url, 'name' => $clean('name', 120) ?: null], 'id = ?', [$l['id']]);
            flash('ok', 'Saved. The short link now opens the new address.');
        } elseif ($a === 'pause' || $a === 'resume') {
            DB::update('short_links', ['status' => $a === 'pause' ? 'paused' : 'active'], 'id = ?', [$l['id']]);
            flash('ok', $a === 'pause' ? 'Link paused.' : 'Link is working again.');
        } elseif ($a === 'delete') {
            DB::run('DELETE FROM short_link_clicks WHERE link_id = ?', [$l['id']]);
            DB::run('DELETE FROM short_links WHERE id = ?', [$l['id']]);
            flash('ok', 'Link deleted.');
            redirect('/dashboard/links');
        }
        redirect('/dashboard/links/' . $l['id']);
    }
    [$daily, $devices] = ShortLinks::daily((int) $l['id']);
    render('tools/link', ['title' => $l['name'] ?: '/l/' . $l['code'], 'org' => $org, 'l' => $l, 'daily' => $daily, 'devices' => $devices], 'app');
});

// Website monitors ----------------------------------------------------------------

$r->add('GET|POST', '/dashboard/monitors', function () use ($clean, $phoneOk) {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $url = trim((string) input('url'));
        $phone = $clean('alert_phone', 30);
        $email = strtolower($clean('alert_email'));
        $every = (int) input('every_min');
        if ($err = Monitors::problem($url)) { flash('error', $err); $_SESSION['old'] = $_POST; redirect('/dashboard/monitors'); }
        if (!$phoneOk($phone) || ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL))) { flash('error', 'Check the alert email address and mobile number.'); $_SESSION['old'] = $_POST; redirect('/dashboard/monitors'); }
        if ((int) DB::value('SELECT COUNT(*) FROM monitors WHERE org_id = ?', [$org['id']]) >= Monitors::MAX_PER_ACCOUNT) { flash('error', 'You can monitor up to ' . Monitors::MAX_PER_ACCOUNT . ' websites.'); redirect('/dashboard/monitors'); }
        $id = DB::insert('monitors', ['org_id' => $org['id'], 'name' => $clean('name', 120) ?: (string) parse_url($url, PHP_URL_HOST), 'url' => $url,
            'every_min' => isset(Monitors::INTERVALS[$every]) ? $every : 5, 'keyword' => $clean('keyword', 120) ?: null, 'alert_email' => $email ?: null, 'alert_phone' => $phone ?: null,
            'state' => 'pending', 'next_check_at' => now(), 'state_since' => now(), 'created_at' => now()]);
        $res = Monitors::check(DB::one('SELECT * FROM monitors WHERE id = ?', [$id]));
        audit('monitor.created', (int) $org['id'], $url);
        flash($res['ok'] ? 'ok' : 'error', $res['ok'] ? 'Monitoring started. The site answered in ' . $res['ms'] . ' ms.' : 'Monitoring started, but the first check failed: ' . $res['error'] . '. We check again shortly before alerting you.');
        redirect('/dashboard/monitors/' . $id);
    }
    render('tools/monitors', ['title' => 'Website monitor', 'org' => $org, 'me' => Auth::user(), 'monitors' => DB::all('SELECT * FROM monitors WHERE org_id = ? ORDER BY id', [$org['id']])], 'app');
});

$r->add('GET|POST', '/dashboard/monitors/{id}', function ($id) use ($clean, $phoneOk) {
    $org = require_org();
    $m = DB::one('SELECT * FROM monitors WHERE id = ? AND org_id = ?', [(int) $id, $org['id']]) ?? redirect('/dashboard/monitors');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'save') {
            $url = trim((string) input('url'));
            $phone = $clean('alert_phone', 30);
            $email = strtolower($clean('alert_email'));
            $every = (int) input('every_min');
            if ($err = Monitors::problem($url)) { flash('error', $err); redirect('/dashboard/monitors/' . $m['id']); }
            if (!$phoneOk($phone) || ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL))) { flash('error', 'Check the alert email address and mobile number.'); redirect('/dashboard/monitors/' . $m['id']); }
            DB::update('monitors', ['name' => $clean('name', 120) ?: $m['name'], 'url' => $url, 'every_min' => isset(Monitors::INTERVALS[$every]) ? $every : 5, 'keyword' => $clean('keyword', 120) ?: null,
                'alert_email' => $email ?: null, 'alert_phone' => $phone ?: null, 'next_check_at' => now()], 'id = ?', [$m['id']]);
            flash('ok', 'Saved.');
        } elseif ($a === 'check') {
            if (rate_limited('moncheck:' . $m['id'], 6, 300)) { flash('error', 'Give it a minute before checking again.'); redirect('/dashboard/monitors/' . $m['id']); }
            $res = Monitors::check($m);
            flash($res['ok'] ? 'ok' : 'error', $res['ok'] ? 'Up. Answered with ' . $res['code'] . ' in ' . $res['ms'] . ' ms.' : 'Not answering: ' . $res['error'] . '.');
        } elseif ($a === 'pause' || $a === 'resume') {
            DB::update('monitors', ['paused' => $a === 'pause' ? 1 : 0, 'next_check_at' => now()], 'id = ?', [$m['id']]);
            flash('ok', $a === 'pause' ? 'Monitoring paused. No alerts are sent while paused.' : 'Monitoring resumed.');
        } elseif ($a === 'delete') {
            DB::run('DELETE FROM monitor_events WHERE monitor_id = ?', [$m['id']]);
            DB::run('DELETE FROM monitors WHERE id = ?', [$m['id']]);
            flash('ok', 'Monitor deleted.');
            redirect('/dashboard/monitors');
        }
        redirect('/dashboard/monitors/' . $m['id']);
    }
    render('tools/monitor', ['title' => $m['name'], 'org' => $org, 'm' => $m, 'events' => DB::all('SELECT * FROM monitor_events WHERE monitor_id = ? ORDER BY id DESC LIMIT 50', [$m['id']])], 'app');
});
