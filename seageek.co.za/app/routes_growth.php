<?php
/**
 * Staff, QR codes, store SMS, contacts, campaigns and newsletters.
 * Included from routes.php; $r is the router. Customer pages live under /dashboard,
 * SeaGeek's own marketing (the house account) under /admin/marketing with the same screens.
 */
declare(strict_types=1);

/** @var Router $r */

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

$r->add('GET|POST', '/admin/staff', function () {
    $me = Auth::requireAdmin('staff');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        $roles = Staff::roles();
        $role = isset($roles[(string) input('role')]) ? (string) input('role') : 'support';
        $perms = array_values(array_intersect((array) ($_POST['perms'] ?? []), array_keys(Staff::PERMISSIONS)));
        $isOwner = ($me['admin_role'] ?: 'owner') === 'owner';
        if ($role === 'owner' && !$isOwner) { flash('error', 'Only an owner can make someone an owner.'); redirect('/admin/staff'); }
        if ($a === 'invite') {
            $email = strtolower(trim((string) input('email')));
            $name = mb_substr(trim((string) input('name')), 0, 120);
            if (!filter_var($email, FILTER_VALIDATE_EMAIL) || $name === '') { flash('error', 'Enter a name and a valid email address.'); redirect('/admin/staff'); }
            if (DB::one('SELECT id FROM users WHERE email = ?', [$email])) { flash('error', 'That email address already has a SeaGeek login.'); redirect('/admin/staff'); }
            $id = DB::insert('users', ['org_id' => Desk::house()['id'], 'name' => $name, 'email' => $email, 'password_hash' => password_hash(Crypto::token(24), PASSWORD_DEFAULT),
                'role' => 'agent', 'is_admin' => 1, 'admin_role' => $role, 'permissions' => $role === 'custom' ? json_encode($perms) : null, 'created_at' => now()]);
            Mail::queue($email, 'You have been added to the SeaGeek team', 'staff_invite', ['name' => $name, 'by' => $me, 'role' => Staff::roleLabel($role), 'link' => app_url('/reset/' . Auth::issueToken($id, 'reset', '+3 days'))]);
            Mail::deliver(5);
            audit('staff.invited', null, $email . ' as ' . $role);
            flash('ok', 'Invitation sent to ' . $email . '. The link works for 3 days.');
        } else {
            $u = DB::one('SELECT * FROM users WHERE id = ? AND is_admin = 1', [(int) input('user')]);
            if (!$u) redirect('/admin/staff');
            $wasOwner = ($u['admin_role'] ?: 'owner') === 'owner' && !$u['disabled_at'];
            if ($wasOwner && !$isOwner) { flash('error', 'Only an owner can change another owner.'); redirect('/admin/staff'); }
            if ($a === 'save') {
                if ($wasOwner && $role !== 'owner' && Staff::owners() <= 1) { flash('error', 'Keep at least one owner.'); redirect('/admin/staff'); }
                DB::update('users', ['admin_role' => $role, 'permissions' => $role === 'custom' ? json_encode($perms) : null], 'id = ?', [$u['id']]);
                audit('staff.changed', null, $u['email'] . ' to ' . $role);
                flash('ok', $u['name'] . ' is now ' . Staff::roleLabel($role) . '.');
            } elseif ($a === 'disable') {
                if ((int) $u['id'] === (int) $me['id']) { flash('error', 'You cannot switch off your own login.'); redirect('/admin/staff'); }
                if ($wasOwner && Staff::owners() <= 1) { flash('error', 'Keep at least one owner.'); redirect('/admin/staff'); }
                DB::update('users', ['disabled_at' => now()], 'id = ?', [$u['id']]);
                DB::run('DELETE FROM sessions WHERE data LIKE ?', ['%"uid";i:' . (int) $u['id'] . ';%']);
                audit('staff.disabled', null, $u['email']);
                flash('ok', $u['name'] . ' can no longer sign in.');
            } elseif ($a === 'enable') {
                DB::update('users', ['disabled_at' => null], 'id = ?', [$u['id']]);
                audit('staff.enabled', null, $u['email']);
                flash('ok', $u['name'] . ' can sign in again.');
            } elseif ($a === 'resend') {
                Mail::queue($u['email'], 'Your SeaGeek team login', 'staff_invite', ['name' => $u['name'], 'by' => $me, 'role' => Staff::roleLabel($u['admin_role']), 'link' => app_url('/reset/' . Auth::issueToken((int) $u['id'], 'reset', '+3 days'))]);
                Mail::deliver(5);
                flash('ok', 'A new sign-in link was emailed to ' . $u['email'] . '.');
            }
        }
        redirect('/admin/staff');
    }
    render('admin/staff', ['title' => 'Staff', 'me' => $me, 'staff' => DB::all('SELECT * FROM users WHERE is_admin = 1 ORDER BY disabled_at IS NOT NULL, id')], 'app');
});

// ---------------------------------------------------------------------------
// Shared screens for customers (/dashboard) and SeaGeek marketing (/admin/marketing)
// ---------------------------------------------------------------------------

/** Pick the account: the customer's own, or SeaGeek's house account for staff with the Marketing permission. */
function growth_org(string $base): array
{
    if (str_starts_with($base, '/admin')) {
        Auth::requireAdmin('marketing');
        return DB::one('SELECT * FROM orgs WHERE is_house = 1');
    }
    return require_org();
}

function growth_routes(Router $r, string $base, string $qrBase): void
{
    // QR codes ---------------------------------------------------------------
    $r->add('GET|POST', $qrBase, function () use ($base, $qrBase) {
        $org = growth_org($base);
        if (is_post()) {
            csrf_check();
            $url = trim((string) input('url'));
            if (!preg_match('#^https?://#i', $url) && $url !== '') $url = 'https://' . $url;
            $color = (string) (input('color') ?: '#0b1f27');
            if ($p = Qr::problem($url, $color)) { flash('error', $p); redirect($qrBase); }
            if (empty($org['is_house']) && Services::status((int) $org['id'], 'qr') !== 'active') Services::activate((int) $org['id'], 'qr');
            try {
                $qr = Qr::create($org, 'live', $url, (string) input('name'), input('type') !== 'static', $color);
            } catch (InsufficientFunds) {
                flash('error', 'A QR code costs ' . zar(Billing::price($org, 'qr_code')['price']) . ' and your balance is ' . zar($org['balance']) . '. Add credit first.');
                redirect($qrBase);
            }
            audit('qr.created', (int) $org['id'], $qr['public_id']);
            flash('ok', 'Your QR code is ready.' . ((float) $qr['amount'] > 0 ? ' ' . zar($qr['amount']) . ' was charged from your credit.' : ''));
            redirect($qrBase . '/' . $qr['public_id']);
        }
        $codes = DB::all('SELECT * FROM qr_codes WHERE org_id = ? ORDER BY id DESC LIMIT 200', [$org['id']]);
        $all = !empty($org['is_house']) ? DB::all("SELECT q.*, o.name org, o.customer_no FROM qr_codes q JOIN orgs o ON o.id = q.org_id WHERE o.is_house = 0 ORDER BY q.id DESC LIMIT 100") : [];
        render('growth/qr_list', ['title' => 'QR codes', 'org' => $org, 'base' => $base, 'qrBase' => $qrBase, 'codes' => $codes, 'all' => $all,
            'price' => Billing::price($org, 'qr_code')['price']], 'app');
    });
    $r->add('GET|POST', $qrBase . '/{id}', function ($id) use ($base, $qrBase) {
        $org = growth_org($base);
        if (preg_match('/^(qr_\w+)\.(png|svg)$/', $id, $m)) {
            $qr = DB::one('SELECT * FROM qr_codes WHERE public_id = ? AND org_id = ?', [$m[1], $org['id']]) ?? redirect($qrBase);
            $file = preg_replace('/[^a-z0-9]+/', '-', strtolower($qr['name'])) ?: 'qr-code';
            header('Content-Type: ' . ($m[2] === 'png' ? 'image/png' : 'image/svg+xml'));
            header('Content-Disposition: attachment; filename="' . trim($file, '-') . '.' . $m[2] . '"');
            echo $m[2] === 'png' ? Qr::png($qr, 24) : Qr::svg($qr);
            exit;
        }
        $qr = DB::one('SELECT * FROM qr_codes WHERE public_id = ? AND org_id = ?', [$id, $org['id']]) ?? redirect($qrBase);
        if (is_post()) {
            csrf_check();
            try {
                $in = ['name' => input('name')];
                if (input('url') !== null) $in['url'] = trim((string) input('url'));
                if (input('status') !== null) $in['status'] = (string) input('status');
                Qr::update($qr, $in);
                flash('ok', 'Saved.');
            } catch (ApiError $e) {
                flash('error', $e->getMessage());
            }
            redirect($qrBase . '/' . $qr['public_id']);
        }
        render('growth/qr', ['title' => $qr['name'], 'org' => $org, 'base' => $base, 'qrBase' => $qrBase, 'qr' => $qr, 'stats' => Qr::daily((int) $qr['id'])], 'app');
    });

    // Contacts -----------------------------------------------------------------
    $r->add('GET', $base . '/contacts/template.csv', function () use ($base) {
        growth_org($base);
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="seageek-contacts-template.csv"');
        echo Contacts::csvTemplate();
        exit;
    });
    $r->add('GET|POST', $base . '/contacts', function () use ($base) {
        $org = growth_org($base);
        if (is_post()) {
            csrf_check();
            $name = mb_substr(trim((string) input('name')), 0, 120);
            if ($name === '') { flash('error', 'Give the list a name.'); redirect($base . '/contacts'); }
            $id = DB::insert('contact_lists', ['org_id' => $org['id'], 'name' => $name, 'kind' => 'static', 'created_at' => now()]);
            redirect($base . '/contacts/' . $id);
        }
        render('growth/contacts', ['title' => 'Contacts', 'org' => $org, 'base' => $base, 'lists' => Contacts::lists((int) $org['id']),
            'optouts' => (int) DB::value('SELECT COUNT(*) FROM opt_outs WHERE org_id = ?', [$org['id']])], 'app');
    });
    $r->add('GET|POST', $base . '/contacts/{id}', function ($id) use ($base) {
        $org = growth_org($base);
        $list = DB::one('SELECT * FROM contact_lists WHERE id = ? AND org_id = ?', [(int) $id, $org['id']]) ?? redirect($base . '/contacts');
        if (is_post()) {
            csrf_check();
            $a = (string) input('action');
            if ($a === 'import') {
                $csv = (string) input('csv');
                if (!empty($_FILES['file']['tmp_name']) && is_uploaded_file($_FILES['file']['tmp_name']) && $_FILES['file']['size'] < 10_000_000) $csv = (string) file_get_contents($_FILES['file']['tmp_name']);
                $res = Contacts::import((int) $org['id'], (int) $list['id'], $csv);
                flash('ok', number_format($res['added']) . ' added, ' . number_format($res['updated']) . ' updated' . ($res['invalid'] ? ', ' . number_format($res['invalid']) . ' skipped (no valid phone or email)' : '') . '.');
            } elseif ($a === 'add') {
                $res = Contacts::add((int) $org['id'], (int) $list['id'], (string) input('name'), (string) input('phone') ?: null, (string) input('email') ?: null);
                $res === 'invalid' ? flash('error', 'Enter a valid South African phone number or email address.') : flash('ok', 'Contact ' . $res . '.');
            } elseif ($a === 'delete') {
                DB::run('DELETE FROM contacts WHERE id = ? AND list_id = ?', [(int) input('contact'), $list['id']]);
                flash('ok', 'Contact removed.');
            } elseif ($a === 'rename') {
                DB::update('contact_lists', ['name' => mb_substr(trim((string) input('name')), 0, 120) ?: $list['name']], 'id = ?', [$list['id']]);
            } elseif ($a === 'delete_list') {
                DB::run('DELETE FROM contacts WHERE list_id = ?', [$list['id']]);
                DB::run('DELETE FROM contact_lists WHERE id = ?', [$list['id']]);
                flash('ok', 'List deleted.');
                redirect($base . '/contacts');
            }
            redirect($base . '/contacts/' . $list['id']);
        }
        $q = trim((string) ($_GET['q'] ?? ''));
        $where = 'list_id = ?' . ($q !== '' ? ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)' : '');
        $args = $q !== '' ? [$list['id'], "%$q%", "%$q%", "%$q%"] : [$list['id']];
        render('growth/contact_list', ['title' => $list['name'], 'org' => $org, 'base' => $base, 'list' => $list, 'q' => $q,
            'total' => (int) DB::value("SELECT COUNT(*) FROM contacts WHERE $where", $args),
            'contacts' => DB::all("SELECT * FROM contacts WHERE $where ORDER BY id DESC LIMIT 200", $args)], 'app');
    });

    // Campaigns ----------------------------------------------------------------
    $r->add('GET', $base . ($base === '/dashboard' ? '/campaigns' : ''), function () use ($base) {
        $org = growth_org($base);
        $cBase = $base === '/dashboard' ? '/dashboard/campaigns' : $base;
        render('growth/campaigns', ['title' => $base === '/dashboard' ? 'Campaigns' : 'Marketing', 'org' => $org, 'base' => $base, 'cBase' => $cBase,
            'campaigns' => DB::all('SELECT * FROM campaigns WHERE org_id = ? ORDER BY id DESC LIMIT 100', [$org['id']]),
            'lists' => Contacts::lists((int) $org['id'])], 'app');
    });
    $cBase = $base === '/dashboard' ? '/dashboard/campaigns' : $base . '/campaigns';
    $listBase = $base === '/dashboard' ? '/dashboard/campaigns' : $base;
    $r->add('GET|POST', $cBase . '/new', function () use ($base, $cBase, $listBase) {
        $org = growth_org($base);
        if (is_post()) {
            csrf_check();
            $c = Campaigns::create($org, $_POST, (int) Auth::id());
            if (input('save_template')) DB::insert('message_templates', ['org_id' => $org['id'], 'channel' => $c['channel'], 'name' => mb_substr($c['name'], 0, 120), 'subject' => $c['subject'], 'body' => $c['body'], 'created_at' => now()]);
            redirect($cBase . '/' . $c['public_id']);
        }
        $lib = Campaigns::library();
        $tpl = null;
        if (isset($_GET['t']) && isset($lib[(int) $_GET['t']])) $tpl = $lib[(int) $_GET['t']];
        if (isset($_GET['mine']) && ($m = DB::one('SELECT * FROM message_templates WHERE id = ? AND org_id = ?', [(int) $_GET['mine'], $org['id']]))) $tpl = [$m['channel'], 'Saved', $m['name'], $m['subject'], $m['body']];
        render('growth/campaign_new', ['title' => 'New campaign', 'org' => $org, 'base' => $base, 'cBase' => $cBase, 'listBase' => $listBase,
            'channel' => ($tpl[0] ?? ($_GET['channel'] ?? 'sms')) === 'email' ? 'email' : 'sms', 'tpl' => $tpl, 'library' => $lib,
            'mine' => DB::all('SELECT * FROM message_templates WHERE org_id = ? ORDER BY id DESC', [$org['id']]),
            'audiences' => Campaigns::audiences($org)], 'app');
    });
    $r->add('GET|POST', $cBase . '/{id}', function ($id) use ($base, $cBase, $listBase) {
        $org = growth_org($base);
        $c = DB::one('SELECT * FROM campaigns WHERE public_id = ? AND org_id = ?', [$id, $org['id']]) ?? redirect($listBase);
        if (is_post()) {
            csrf_check();
            $a = (string) input('action');
            if ($a === 'save' && $c['status'] === 'draft') {
                DB::update('campaigns', ['name' => mb_substr(trim((string) input('name')), 0, 160) ?: $c['name'], 'audience' => (string) input('audience'),
                    'subject' => $c['channel'] === 'email' ? mb_substr(trim((string) input('subject')), 0, 255) : null, 'body' => mb_substr((string) input('body'), 0, $c['channel'] === 'sms' ? 1530 : 20000),
                    'button_label' => mb_substr(trim((string) input('button_label')), 0, 60) ?: null, 'button_url' => filter_var(input('button_url'), FILTER_VALIDATE_URL) ? (string) input('button_url') : null], 'id = ?', [$c['id']]);
                flash('ok', 'Saved.');
            } elseif ($a === 'test') {
                $to = trim((string) input('to'));
                $one = ['name' => Auth::user()['name'], 'address' => $c['channel'] === 'sms' ? Gateway::phone($to) : (filter_var($to, FILTER_VALIDATE_EMAIL) ? strtolower($to) : null)];
                if (!$one['address']) { flash('error', 'Enter a valid ' . ($c['channel'] === 'sms' ? 'phone number' : 'email address') . ' for the test.'); redirect($cBase . '/' . $c['public_id']); }
                if ($c['channel'] === 'sms') {
                    [$code, $res] = Gateway::run($org, $org['live_enabled'] ? 'live' : 'test', 'POST', 'sms/messages', ['to' => [$one['address']], 'body' => '[Test] ' . Campaigns::render((string) $c['body'], ['name' => $one['name']]), 'reference' => $c['public_id'] . '-test']);
                } else {
                    $html = Campaigns::emailHtml($org, $c, $one['name'], $one['address']);
                    DB::insert('email_outbox', ['to_addr' => $one['address'], 'subject' => '[Test] ' . Campaigns::render((string) $c['subject'], ['name' => $one['name']]), 'html' => $html, 'text_body' => Mail::text($html), 'status' => 'queued', 'attempts' => 0, 'created_at' => now()]);
                    Mail::deliver(3);
                    $code = 200;
                }
                $code < 300 ? flash('ok', 'Test sent to ' . $one['address'] . '.') : flash('error', $res['error']['message'] ?? 'The test could not be sent.');
            } elseif ($a === 'launch') {
                $at = null;
                if (input('when') === 'later') {
                    $t = strtotime((string) input('at') . ' Africa/Johannesburg');
                    if (!$t || $t < time() + 60) { flash('error', 'Pick a time in the future.'); redirect($cBase . '/' . $c['public_id']); }
                    $at = gmdate('Y-m-d H:i:s', $t);
                }
                $err = Campaigns::launch($org, $c, $at);
                if ($err) { flash('error', $err); redirect($cBase . '/' . $c['public_id']); }
                audit('campaign.launched', (int) $org['id'], $c['public_id']);
                if (!$at) Campaigns::process(200);
                flash('ok', $at ? 'Scheduled for ' . date('j M Y H:i', $t) . ' (SAST).' : 'Sending. Results update below as messages go out.');
            } elseif ($a === 'cancel' && in_array($c['status'], ['scheduled', 'sending'], true)) {
                DB::run("UPDATE campaign_recipients SET status = 'cancelled' WHERE campaign_id = ? AND status = 'pending'", [$c['id']]);
                DB::update('campaigns', ['status' => 'cancelled', 'finished_at' => now()], 'id = ?', [$c['id']]);
                flash('ok', 'Campaign stopped. Messages already sent are not affected.');
            } elseif ($a === 'duplicate') {
                $n = Campaigns::create($org, ['name' => $c['name'] . ' (copy)', 'channel' => $c['channel'], 'audience' => $c['audience'], 'subject' => $c['subject'], 'body' => $c['body'], 'button_label' => $c['button_label'], 'button_url' => $c['button_url']], (int) Auth::id());
                redirect($cBase . '/' . $n['public_id']);
            } elseif ($a === 'delete' && $c['status'] === 'draft') {
                DB::run('DELETE FROM campaigns WHERE id = ?', [$c['id']]);
                flash('ok', 'Draft deleted.');
                redirect($listBase);
            }
            redirect($cBase . '/' . $c['public_id']);
        }
        if (in_array($c['status'], ['sending', 'sent'], true)) { Campaigns::refresh((int) $c['id']); $c = DB::one('SELECT * FROM campaigns WHERE id = ?', [$c['id']]); }
        $preview = $c['status'] === 'draft' ? Campaigns::recipients($org, (string) $c['audience'], $c['channel']) : null;
        render('growth/campaign', ['title' => $c['name'], 'org' => $org, 'base' => $base, 'cBase' => $cBase, 'listBase' => $listBase, 'c' => $c,
            'audiences' => Campaigns::audiences($org), 'preview' => $preview,
            'estimate' => Campaigns::estimate($org, $c['channel'], (string) $c['body'], $preview ? count($preview['list']) : (int) $c['total']),
            'delivery' => Campaigns::delivery($c),
            'recipients' => DB::all('SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY id LIMIT 100', [$c['id']])], 'app');
    });
}

growth_routes($r, '/dashboard', '/dashboard/qr');
growth_routes($r, '/admin/marketing', '/admin/marketing/qr');

// ---------------------------------------------------------------------------
// Store SMS (customers)
// ---------------------------------------------------------------------------

$r->add('GET|POST', '/dashboard/stores', function () {
    $org = require_org();
    if (is_post()) {
        csrf_check();
        $store = Stores::connect($org, (string) input('platform'), (string) input('name'), (string) input('domain'));
        audit('store.connected', (int) $org['id'], $store['public_id']);
        redirect('/dashboard/stores/' . $store['public_id'] . '?new=1');
    }
    render('growth/stores', ['title' => 'Store SMS', 'org' => $org, 'stores' => DB::all('SELECT * FROM stores WHERE org_id = ? ORDER BY id', [$org['id']]),
        'price' => Billing::price($org, 'store_sms')['price']], 'app');
});

$r->add('GET|POST', '/dashboard/stores/{id}', function ($id) {
    $org = require_org();
    $store = DB::one('SELECT * FROM stores WHERE public_id = ? AND org_id = ?', [$id, $org['id']]) ?? redirect('/dashboard/stores');
    if (is_post()) {
        csrf_check();
        $a = (string) input('action');
        if ($a === 'messages') {
            $s = Stores::settings($store);
            foreach (Stores::events() as $k => $def) {
                $text = trim((string) ($_POST['text'][$k] ?? ''));
                $s['events'][$k] = ['on' => !empty($_POST['on'][$k]), 'text' => $text !== '' ? mb_substr($text, 0, 480) : $def[1]];
            }
            $s['abandoned_delay_hours'] = max(1, min(48, (int) input('delay')));
            DB::update('stores', ['settings' => json_encode($s)], 'id = ?', [$store['id']]);
            flash('ok', 'Messages saved.');
        } elseif ($a === 'secret') {
            $sec = trim((string) input('secret'));
            if (strlen($sec) < 16) { flash('error', 'That does not look like a signing secret. Copy the full value from your store settings.'); }
            else { DB::update('stores', ['secret_enc' => Crypto::encrypt($sec)], 'id = ?', [$store['id']]); flash('ok', 'Signing secret saved. Orders will now send SMS.'); }
        } elseif ($a === 'details') {
            DB::update('stores', ['name' => mb_substr(trim((string) input('name')), 0, 120) ?: $store['name'], 'domain' => mb_substr(preg_replace('#^https?://#', '', trim((string) input('domain'))), 0, 190) ?: null], 'id = ?', [$store['id']]);
            flash('ok', 'Saved.');
        } elseif ($a === 'pause' || $a === 'resume') {
            DB::update('stores', ['status' => $a === 'pause' ? 'paused' : 'active'], 'id = ?', [$store['id']]);
            flash('ok', $a === 'pause' ? 'Paused. Orders will not send SMS until you resume.' : 'Store SMS is on again.');
        } elseif ($a === 'test') {
            $phone = Gateway::phone((string) (input('phone') ?: $org['phone'])) ?? '+27821234567';
            $res = Stores::simulate($store, (string) input('event') ?: 'order_created', $phone);
            flash('ok', $res['status'] === 'simulated' ? 'Test order processed. The SMS your customer would get: "' . ($res['body'] ?? '') . '"' : 'Test order processed: ' . ($res['note'] ?? $res['status']) . '.');
        } elseif ($a === 'delete') {
            DB::run('DELETE FROM stores WHERE id = ?', [$store['id']]);
            audit('store.removed', (int) $org['id'], $store['public_id']);
            flash('ok', 'Store disconnected. Remove the SeaGeek webhook from your store settings too.');
            redirect('/dashboard/stores');
        }
        redirect('/dashboard/stores/' . $store['public_id']);
    }
    render('growth/store', ['title' => $store['name'], 'org' => $org, 'store' => $store, 'settings' => Stores::settings($store), 'secret' => Stores::secret($store),
        'storeEvents' => DB::all('SELECT * FROM store_events WHERE store_id = ? ORDER BY id DESC LIMIT 50', [$store['id']]),
        'list' => $store['list_id'] ? DB::one('SELECT l.*, (SELECT COUNT(*) FROM contacts c WHERE c.list_id = l.id) total FROM contact_lists l WHERE l.id = ?', [$store['list_id']]) : null,
        'price' => Billing::price($org, 'store_sms')['price']], 'app');
});

// ---------------------------------------------------------------------------
// Public: QR redirects and images, unsubscribe, newsletter
// ---------------------------------------------------------------------------

$r->add('GET', '/q/{code}', fn($code) => Qr::scan((string) $code));

$r->add('GET', '/qr/i/{file}', function ($file) {
    if (!preg_match('/^([A-Za-z0-9]{6})\.(png|svg)$/', $file, $m) || !hash_equals(Qr::sig($m[1]), (string) ($_GET['s'] ?? ''))) { http_response_code(404); exit; }
    $qr = DB::one('SELECT * FROM qr_codes WHERE code = ?', [$m[1]]);
    if (!$qr) { http_response_code(404); exit; }
    header('Content-Type: ' . ($m[2] === 'png' ? 'image/png' : 'image/svg+xml'));
    header('Cache-Control: public, max-age=86400');
    echo $m[2] === 'png' ? Qr::png($qr, (int) min(32, max(4, (int) ($_GET['scale'] ?? 16)))) : Qr::svg($qr);
    exit;
});

$r->add('GET|POST', '/u/{token}', function ($token) {
    $d = Campaigns::readUnsubscribe((string) $token);
    if (!$d) { http_response_code(404); render('site/unsubscribe', ['title' => 'Link not valid', 'state' => 'invalid'], 'auth'); }
    $org = DB::one('SELECT name, is_house FROM orgs WHERE id = ?', [$d['org_id']]);
    if (is_post()) {
        // One-click unsubscribe (RFC 8058) posts without a CSRF token; the signed link is the proof.
        Contacts::optOut($d['org_id'], $d['channel'], $d['address'], 'Unsubscribe link');
        render('site/unsubscribe', ['title' => 'Unsubscribed', 'state' => 'done', 'from' => $org['is_house'] ? 'SeaGeek' : $org['name'], 'address' => $d['address']], 'auth');
    }
    render('site/unsubscribe', ['title' => 'Unsubscribe', 'state' => 'ask', 'from' => $org['is_house'] ? 'SeaGeek' : $org['name'], 'address' => $d['address'], 'token' => $token], 'auth');
});

$r->add('POST', '/newsletter', function () {
    csrf_check();
    $email = strtolower(trim((string) input('email')));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || !input('consent') || rate_limited('nl:' . client_ip(), 5, 3600)) {
        flash('error', 'Enter your email address and tick the box to agree.');
        redirect(($_SERVER['HTTP_REFERER'] ?? '/') . '#newsletter');
    }
    $house = DB::one('SELECT * FROM orgs WHERE is_house = 1');
    $list = DB::one("SELECT * FROM contact_lists WHERE org_id = ? AND name = 'Website newsletter'", [$house['id']]);
    $listId = $list ? (int) $list['id'] : DB::insert('contact_lists', ['org_id' => $house['id'], 'name' => 'Website newsletter', 'kind' => 'static', 'created_at' => now()]);
    DB::run('DELETE FROM opt_outs WHERE org_id = ? AND channel = ? AND address = ?', [$house['id'], 'email', $email]);
    if (Contacts::add((int) $house['id'], $listId, '', null, $email, 'website') === 'added') {
        $c = ['org_id' => $house['id'], 'channel' => 'email'];
        Mail::queue($email, 'You are subscribed to SeaGeek news', 'subscribed', ['unsubscribe' => Campaigns::unsubscribeUrl($c, $email)]);
    }
    flash('ok', 'Thanks. You are on the list. We send at most one email a month.');
    redirect(($_SERVER['HTTP_REFERER'] ?? '/') . '#newsletter');
});
