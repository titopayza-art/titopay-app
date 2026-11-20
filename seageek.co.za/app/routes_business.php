<?php
/** WhatsApp templates, data protection settings, once-off build services, and the public data protection page. */
declare(strict_types=1);

/** @var Router $r */

$r->add('GET|POST', '/dashboard/wa-templates', function () {
    $org = require_org();
    $u = Auth::user();
    if (is_post()) {
        csrf_check();
        $act = (string) input('action');
        if ($act === 'save') {
            $raw = [
                'name' => input('name'), 'category' => input('category'), 'language' => input('language'), 'body' => input('body'),
                'header_type' => input('header_type'), 'header_text' => input('header_text'), 'footer' => input('footer'),
                'samples' => (array) ($_POST['samples'] ?? []),
                'buttons' => array_map(fn($i) => ['type' => $_POST['btn_type'][$i] ?? '', 'text' => $_POST['btn_text'][$i] ?? '', 'url' => $_POST['btn_url'][$i] ?? '', 'phone' => $_POST['btn_phone'][$i] ?? ''], array_keys((array) ($_POST['btn_type'] ?? []))),
            ];
            [$t, $err] = WaTemplates::validate($raw);
            if ($err) { $_SESSION['wa_old'] = $_POST; flash('error', $err); redirect('/dashboard/wa-templates#builder'); }
            $existing = WaTemplates::row((int) $org['id'], $t['name'], $t['language']);
            $row = ['org_id' => $org['id'], 'name' => $t['name'], 'category' => $t['category'], 'language' => $t['language'], 'header_type' => $t['header_type'], 'header_text' => $t['header_text'],
                'body' => $t['body'], 'footer' => $t['footer'], 'buttons' => json_encode($t['buttons'], JSON_UNESCAPED_UNICODE), 'samples' => json_encode($t['samples'], JSON_UNESCAPED_UNICODE),
                'status' => $existing && $existing['status'] === 'approved' ? 'approved' : 'draft', 'updated_at' => now()];
            if ($existing && $existing['status'] !== 'approved') DB::update('wa_templates', $row, 'id = ?', [$existing['id']]);
            elseif (!$existing) DB::insert('wa_templates', $row + ['created_at' => now()]);
            else { flash('error', 'Approved templates cannot be edited. Create a new version with a new name.'); redirect('/dashboard/wa-templates'); }
            audit('wa_template.saved', (int) $org['id'], $t['name']);
            flash('ok', 'Template saved. Submit it for WhatsApp approval when you are ready.');
            redirect('/dashboard/wa-templates');
        }
        if ($act === 'submit') {
            $tpl = DB::one('SELECT * FROM wa_templates WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
            if (!$tpl || $tpl['status'] !== 'draft') redirect('/dashboard/wa-templates');
            DB::update('wa_templates', ['status' => 'pending', 'updated_at' => now()], 'id = ?', [$tpl['id']]);
            audit('wa_template.submitted', (int) $org['id'], $tpl['name']);
            flash('ok', 'Submitted. WhatsApp reviews each template, usually within a day. You will see the result here.');
            redirect('/dashboard/wa-templates');
        }
        if ($act === 'delete') {
            $tpl = DB::one('SELECT * FROM wa_templates WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
            if ($tpl && $tpl['status'] !== 'approved') { DB::run('DELETE FROM wa_templates WHERE id = ?', [$tpl['id']]); audit('wa_template.deleted', (int) $org['id'], $tpl['name']); flash('ok', 'Template deleted.'); }
            else flash('error', 'Approved templates stay on record. Create a new one instead.');
            redirect('/dashboard/wa-templates');
        }
        if ($act === 'send') {
            $tpl = DB::one('SELECT * FROM wa_templates WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
            $to = preg_replace('/[^\d+]/', '', (string) input('to'));
            if (!$tpl) redirect('/dashboard/wa-templates');
            $values = array_map('strval', (array) ($_POST['values'] ?? []));
            if (count($values) !== count(WaTemplates::placeholders($tpl['body'])) || in_array('', array_map('trim', $values), true)) { flash('error', 'Fill in every value in the message.'); redirect('/dashboard/wa-templates#test'); }
            $mode = $org['live_enabled'] && $org['status'] === 'active' ? 'live' : 'test';
            $tpl['buttons'] = json_decode((string) $tpl['buttons'], true) ?: [];
            [$ok, $msg] = WaTemplates::send($org, $tpl, $to, $values, $mode, (string) input('button_value'));
            audit('wa_template.sent', (int) $org['id'], $tpl['name'] . ' to ' . $to);
            flash($ok ? 'ok' : 'error', $ok ? ($mode === 'test' ? 'Test sent in the sandbox. Nothing was delivered to a phone and nothing was charged.' : 'Sent to ' . $to . '.') : $msg);
            redirect('/dashboard/wa-templates#test');
        }
        redirect('/dashboard/wa-templates');
    }
    $tpls = DB::all('SELECT * FROM wa_templates WHERE org_id = ? ORDER BY updated_at DESC', [$org['id']]);
    render('dash/wa_templates', ['title' => 'WhatsApp templates', 'org' => $org, 'me' => $u, 'tpls' => $tpls, 'old' => $_SESSION['wa_old'] ?? [], 'wa' => DB::one("SELECT * FROM wa_numbers WHERE org_id = ? AND status = 'active'", [$org['id']])], 'app');
    unset($_SESSION['wa_old']);
});

$r->add('GET|POST', '/dashboard/privacy', function () {
    $org = require_org();
    $u = Auth::user();
    if (is_post()) {
        csrf_check();
        $act = (string) input('action');
        if ($act === 'save') {
            $days = (int) input('retention_days');
            $days = in_array($days, [0, 30, 90, 180, 365, 730], true) ? $days : 365;
            DB::update('orgs', ['ai_data_allowed' => input('ai_data_allowed') ? 1 : 0, 'retention_days' => $days], 'id = ?', [$org['id']]);
            audit('privacy.settings_saved', (int) $org['id'], 'AI ' . (input('ai_data_allowed') ? 'on' : 'off') . ', keep ' . ($days ?: 'forever') . ' days');
            flash('ok', 'Privacy settings saved.');
        }
        if ($act === 'purge') {
            $n = Privacy::purge($org);
            audit('privacy.purged', (int) $org['id'], json_encode($n));
            flash('ok', 'Removed ' . $n['tickets'] . ' old support conversations, ' . $n['chats'] . ' assistant chats and ' . $n['files'] . ' files.');
        }
        redirect('/dashboard/privacy');
    }
    render('dash/privacy', ['title' => 'Privacy and your data', 'org' => $org, 'me' => $u, 'counts' => [
        'tickets' => (int) DB::value('SELECT COUNT(*) FROM tickets WHERE org_id = ?', [$org['id']]),
        'chats' => (int) DB::value('SELECT COUNT(*) FROM assistant_chats c JOIN assistants a ON a.id = c.assistant_id WHERE a.org_id = ?', [$org['id']]),
        'docs' => (int) DB::value('SELECT COUNT(*) FROM assistant_docs d JOIN assistants a ON a.id = d.assistant_id WHERE a.org_id = ?', [$org['id']]),
    ]], 'app');
});

$r->add('GET', '/dashboard/privacy/export', function () {
    $org = require_org();
    $u = Auth::user();
    if (($u['role'] ?? '') !== 'owner') { http_response_code(403); render('dash/denied', ['title' => 'Not allowed', 'area' => 'Export', 'need' => 'edit', 'org' => $org], 'app'); }
    $data = Privacy::export($org);
    audit('privacy.exported', (int) $org['id'], 'full export');
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Disposition: attachment; filename="' . preg_replace('/[^a-z0-9-]+/i', '-', $org['slug']) . '-data-' . gmdate('Ymd') . '.json"');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
});

// Once-off build services: the chooser, the offers, and a request that lands in the support inbox.
$r->add('GET', '/build', function () {
    $answers = ['need' => (string) ($_GET['need'] ?? ''), 'size' => (string) ($_GET['size'] ?? ''), 'extra' => (string) ($_GET['extra'] ?? '')];
    $rec = $answers['need'] !== '' ? Build::recommend($answers['need'], $answers['size'], $answers['extra']) : null;
    render('site/build', ['title' => 'Build services: websites, shops, apps and chatbots', 'nav' => 'build', 'offers' => Build::offers(), 'hosting' => Build::HOSTING_FROM, 'answers' => $answers, 'rec' => $rec,
        'description' => 'Once-off websites from R1,500, shops, apps, AI chatbots and your own system. Prices exclude VAT and hosting. Go live within a week for most websites and chatbots.'], 'site');
});

$r->add('POST', '/build/request', function () {
    csrf_check();
    if (rate_limited('build:' . client_ip(), 5, 3600)) { flash('error', 'Too many requests from your connection. Try again later.'); redirect('/build#request'); }
    $key = (string) input('offer');
    $email = strtolower(trim((string) input('email')));
    $brief = mb_substr(trim((string) input('brief')), 0, 4000);
    if (!isset(Build::offers()[$key]) || !filter_var($email, FILTER_VALIDATE_EMAIL) || trim((string) input('name')) === '' || $brief === '') {
        flash('error', 'Choose an option and add your name, email and a few words about what you need.'); redirect('/build#request');
    }
    Shield::guardPublicForm('/build#request');
    $no = Build::request($key, ['name' => mb_substr(trim((string) input('name')), 0, 120), 'email' => $email, 'phone' => mb_substr(trim((string) input('phone')), 0, 40)], $brief);
    audit('build.requested', null, Build::offers()[$key][0] . ' #' . $no);
    flash('ok', "Thank you. Request #$no is with our team. We reply within one working day to book a short call.");
    redirect('/build#request');
});

$r->add('GET', '/data-protection', fn() => render('site/data-protection', ['title' => 'Data protection and privacy', 'nav' => 'privacy', 'description' => 'How SeaGeek protects company data: AI privacy, deletion, access and team accountability.']));
