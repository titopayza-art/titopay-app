<?php
/**
 * Ligcabho Le'Africa Residences, JSON API.
 *
 * Routing: /api/<resource>[/<id-or-token>[/<action>]]
 * Public routes take the website forms; everything else needs a signed-in
 * staff session. See ../README.md for the full endpoint list.
 */
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
date_default_timezone_set('Africa/Johannesburg');

require __DIR__ . '/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') json_out(['ok' => true]);

/* Resolve the route. */
$route = trim((string) ($_GET['route'] ?? ''), '/');
if ($route === '') {
    $uri = parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH) ?: '';
    $at  = strpos($uri, '/api/');
    $route = $at === false ? '' : trim(substr($uri, $at + 5), '/');
}
$seg    = $route === '' ? [] : explode('/', $route);
$first  = $seg[0] ?? '';
$second = $seg[1] ?? '';
$third  = $seg[2] ?? '';

const APP_STATUSES  = ['new', 'reviewing', 'accepted', 'waitlist', 'placed', 'rejected'];
const ENQ_STATUSES  = ['new', 'in_progress', 'answered', 'closed'];
const ORD_STATUSES  = ['new', 'paid', 'ready', 'collected', 'cancelled'];
const JOB_STATUSES  = ['new', 'reviewing', 'shortlisted', 'appointed', 'declined'];
const MNT_STATUSES  = ['logged', 'assigned', 'in_progress', 'resolved', 'closed'];
const REV_STATUSES  = ['new', 'published', 'replied', 'hidden'];
const CXL_STATUSES  = ['new', 'acknowledged', 'inspection', 'settled', 'declined'];
const REF_STATUSES  = ['new', 'checking', 'approved', 'paid', 'declined'];
const STF_STATUSES  = ['new', 'acknowledged', 'approved', 'declined', 'closed'];
const SUP_STATUSES  = ['new', 'ordered', 'delivered', 'cancelled'];
const INV_STATUSES  = ['draft', 'sent', 'paid', 'cancelled'];
const RET_STATUSES  = ['new', 'reviewing', 'confirmed', 'room_allocated', 'waitlisted', 'declined'];

/** Update status / admin notes on any of the record tables. */
function patch_record(string $table, int $id, array $statuses) {
    $u = require_admin();
    $b = body();
    $set = [];
    $args = [];
    if (isset($b['status'])) {
        if (!in_array($b['status'], $statuses, true)) fail('That status is not valid.', 422);
        $set[] = 'status = ?';
        $args[] = $b['status'];
    }
    if (isset($b['admin_notes'])) {
        $set[] = 'admin_notes = ?';
        $args[] = s($b['admin_notes'], 4000);
    }
    if (!$set) fail('Nothing to update.', 422);
    $set[] = 'updated_at = ?';
    $args[] = now();
    $args[] = $id;

    $st = db()->prepare("UPDATE $table SET " . implode(', ', $set) . ' WHERE id = ?');
    $st->execute($args);
    if ($st->rowCount() === 0) fail('That record no longer exists.', 404);
    audit('update', "$table#$id by {$u['email']}");
    json_out(['ok' => true]);
}

function delete_record(string $table, int $id) {
    $u = require_role(['owner']);
    $st = db()->prepare("DELETE FROM $table WHERE id = ?");
    $st->execute([$id]);
    if ($st->rowCount() === 0) fail('That record no longer exists.', 404);
    audit('delete', "$table#$id by {$u['email']}");
    json_out(['ok' => true]);
}

/** Search + status filtered listing. */
function list_records(string $table, array $searchCols, array $statuses) {
    require_admin();
    $where = [];
    $args  = [];
    $status = s($_GET['status'] ?? '');
    if ($status !== '' && in_array($status, $statuses, true)) {
        $where[] = 'status = ?';
        $args[]  = $status;
    }
    $q = s($_GET['q'] ?? '', 120);
    if ($q !== '') {
        $parts = [];
        foreach ($searchCols as $c) {
            $parts[] = "COALESCE($c,'') LIKE ?";
            $args[]  = '%' . $q . '%';
        }
        $where[] = '(' . implode(' OR ', $parts) . ')';
    }
    $sql = "SELECT * FROM $table" . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT 2000';
    $st = db()->prepare($sql);
    $st->execute($args);
    json_out(['ok' => true, 'items' => $st->fetchAll()]);
}

try {
    switch ($first) {

        /* ============================ AUTH ============================ */
        case 'auth':
            if ($second === 'login' && $method === 'POST') {
                $b  = body();
                $ip = client_ip();
                $window = time() - (int) cfg('security.login_window');
                db()->prepare('DELETE FROM login_attempts WHERE at < ?')->execute([$window]);
                $tries = (int) db()->query("SELECT COUNT(*) c FROM login_attempts WHERE ok = 0 AND ip = "
                    . db()->quote($ip))->fetch()['c'];
                if ($tries >= (int) cfg('security.max_login_attempts')) {
                    fail('Too many attempts. Please wait 15 minutes and try again.', 429);
                }

                $email = strtolower(s($b['email'] ?? '', 190));
                $pass  = (string) ($b['password'] ?? '');
                $st = db()->prepare('SELECT * FROM users WHERE email = ? AND active = 1');
                $st->execute([$email]);
                $u = $st->fetch();

                if (!$u || !password_verify($pass, $u['password_hash'])) {
                    db()->prepare('INSERT INTO login_attempts (ip,at,ok) VALUES (?,?,0)')->execute([$ip, time()]);
                    audit('login_failed', $email);
                    fail('That email address and password do not match.', 401);
                }

                start_session();
                session_regenerate_id(true);
                $_SESSION['uid'] = (int) $u['id'];
                db()->prepare('UPDATE users SET last_login_at = ? WHERE id = ?')->execute([now(), $u['id']]);
                db()->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([$ip]);
                audit('login', $email);

                json_out(['ok' => true, 'user' => [
                    'id' => (int) $u['id'], 'email' => $u['email'], 'name' => $u['name'],
                    'role' => $u['role'], 'must_change_password' => (int) $u['must_change_password'],
                ]]);
            }

            if ($second === 'me' && $method === 'GET') {
                $u = current_user();
                if (!$u) fail('Not signed in.', 401);
                json_out(['ok' => true, 'user' => $u]);
            }

            if ($second === 'logout' && $method === 'POST') {
                audit('logout');
                start_session();
                $_SESSION = [];
                session_destroy();
                json_out(['ok' => true]);
            }

            if ($second === 'password' && $method === 'POST') {
                $u = current_user();
                if (!$u) fail('Not signed in.', 401);
                $b   = body();
                $cur = (string) ($b['current_password'] ?? '');
                $new = (string) ($b['new_password'] ?? '');

                $st = db()->prepare('SELECT password_hash FROM users WHERE id = ?');
                $st->execute([$u['id']]);
                if (!password_verify($cur, (string) $st->fetch()['password_hash'])) {
                    fail('Your current password is not correct.', 422);
                }
                if (mb_strlen($new) < 10) fail('Use at least 10 characters.', 422);
                if ($new === cfg('staff.temporary_password')) fail('Choose a password of your own, not the shared temporary one.', 422);

                db()->prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
                    ->execute([password_hash($new, PASSWORD_DEFAULT), $u['id']]);
                audit('password_changed', $u['email']);
                json_out(['ok' => true]);
            }
            fail('Unknown auth route.', 404);

        /* ======================== APPLICATIONS ======================== */
        case 'applications':
            if ($method === 'POST' && $second === '') {
                $b = body();
                if (empty($b['consent'])) fail('Please confirm the declaration before submitting.', 422);
                $f = need($b, ['first_name', 'last_name', 'id_number', 'phone', 'email']);
                $id = preg_replace('/\D+/', '', $f['id_number']) ?? '';
                if (!valid_sa_id($id)) fail('That does not look like a valid South African ID number.', 422);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);

                $pop = store_upload('proof_of_payment');
                $ref = make_ref();

                db()->prepare('INSERT INTO applications
                    (ref,first_name,last_name,id_number,student_number,gender,phone,email,level_of_study,
                     institution,funder,year_applying,residence,room_type,notes,pop_name,pop_stored,pop_size,
                     source,status,ip,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'new\',?,?,?)')
                    ->execute([
                        $ref, $f['first_name'], $f['last_name'], $id, s($b['student_number'] ?? '', 64),
                        s($b['gender'] ?? '', 16), $f['phone'], strtolower($f['email']),
                        s($b['level_of_study'] ?? '', 64), s($b['institution'] ?? '', 190),
                        s($b['funder'] ?? '', 64), s($b['year_applying'] ?? '', 8),
                        s($b['residence'] ?? '', 190), s($b['room_type'] ?? '', 40),
                        s($b['notes'] ?? '', 4000), $pop['name'], $pop['stored'], $pop['size'],
                        s($b['source'] ?? 'form', 24), client_ip(), now(), now(),
                    ]);

                send_mail(
                    'New application: ' . $f['first_name'] . ' ' . $f['last_name'] . ' (' . $ref . ')',
                    "A new accommodation application has come in.\n\n"
                    . "Reference: $ref\n"
                    . "Name: {$f['first_name']} {$f['last_name']}\n"
                    . "ID number: $id\n"
                    . "Phone: {$f['phone']}\nEmail: {$f['email']}\n"
                    . 'Institution: ' . s($b['institution'] ?? '-') . "\n"
                    . 'Funder: ' . s($b['funder'] ?? '-') . "\n"
                    . 'Residence: ' . s($b['residence'] ?? 'No preference') . "\n"
                    . 'Room type: ' . s($b['room_type'] ?? 'No preference') . "\n\n"
                    . 'Open it in the admin portal: ' . cfg('site.url') . "/admin/#/applications\n",
                    $f['email'], null, ['kind' => 'application_office']
                );

                if (mcfg('send_applicant_confirmation')) {
                    send_mail(
                        'We have your Ligcabho application (' . $ref . ')',
                        "Hi {$f['first_name']},\n\n"
                        . "Thank you for applying to Ligcabho Le'Africa Residences. Your reference is $ref.\n\n"
                        . "What happens next:\n"
                        . "1. We check your application and your funding.\n"
                        . "2. We confirm a room at a residence that suits your institution.\n"
                        . "3. We send your lease agreement to sign online.\n\n"
                        . "Still to send us a proof of payment or a funding letter? Reply to this email with "
                        . "it attached, or open the assistant on our website and it will take you through it.\n\n"
                        . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                        null, [$f['email']],
                        ['kind' => 'application_confirmation',
                         'to_name' => $f['first_name'] . ' ' . $f['last_name']]
                    );
                }

                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Application received. Check your email for the confirmation — the team will confirm your placement from there.']);
            }

            if ($method === 'GET' && $second === '') {
                list_records('applications',
                    ['ref', 'first_name', 'last_name', 'email', 'phone', 'student_number', 'id_number', 'residence', 'institution'],
                    APP_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('applications', (int) $second, APP_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('applications', (int) $second);
            fail('Unknown applications route.', 404);

        /* ========================== ENQUIRIES ========================= */
        case 'enquiries':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['name', 'email', 'message']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);

                db()->prepare('INSERT INTO enquiries (kind,name,phone,email,topic,residence,message,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,\'new\',?,?)')
                    ->execute([s($b['kind'] ?? 'contact', 32), $f['name'], s($b['phone'] ?? '', 40),
                               strtolower($f['email']), s($b['topic'] ?? '', 120), s($b['residence'] ?? '', 190),
                               s($f['message'], 4000), now(), now()]);

                send_mail('Website enquiry from ' . $f['name'],
                    "Name: {$f['name']}\nEmail: {$f['email']}\nPhone: " . s($b['phone'] ?? '-') . "\n"
                    . 'Residence: ' . s($b['residence'] ?? '-') . "\nTopic: " . s($b['topic'] ?? '-') . "\n\n"
                    . "Message:\n" . s($f['message'], 4000) . "\n",
                    $f['email']);

                json_out(['ok' => true, 'message' => 'Thank you — your message is with the team and we will get back to you.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('enquiries', ['name', 'email', 'phone', 'residence', 'topic', 'message'], ENQ_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('enquiries', (int) $second, ENQ_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('enquiries', (int) $second);
            fail('Unknown enquiries route.', 404);

        /* ======================== LVL UP ORDERS ======================= */
        case 'orders':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['pack', 'name', 'email', 'phone']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $ref = make_ref('PACK');
                db()->prepare('INSERT INTO orders (ref,pack,name,email,phone,residence,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,\'new\',?,?)')
                    ->execute([$ref, $f['pack'], $f['name'], strtolower($f['email']), $f['phone'],
                               s($b['residence'] ?? '', 190), now(), now()]);
                send_mail('LVL UP order: ' . $f['pack'] . ' (' . $ref . ')',
                    "Pack: {$f['pack']}\nName: {$f['name']}\nEmail: {$f['email']}\nPhone: {$f['phone']}\n"
                    . "Reference: $ref\n", $f['email']);
                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Order received. We will confirm payment and collection with you.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('orders', ['ref', 'pack', 'name', 'email', 'phone'], ORD_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('orders', (int) $second, ORD_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('orders', (int) $second);
            fail('Unknown orders route.', 404);

        /* ========================= MAINTENANCE ======================== */
        case 'maintenance':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['residence', 'name', 'phone', 'description']);
                $ref = make_ref('MNT');
                $urgency = in_array($b['urgency'] ?? '', ['emergency', 'urgent', 'standard'], true)
                    ? $b['urgency'] : 'standard';
                db()->prepare('INSERT INTO maintenance (ref,residence,room,name,phone,email,category,urgency,description,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,\'logged\',?,?)')
                    ->execute([$ref, $f['residence'], s($b['room'] ?? '', 64), $f['name'], $f['phone'],
                               strtolower(s($b['email'] ?? '', 190)), s($b['category'] ?? '', 64), $urgency,
                               s($f['description'], 4000), now(), now()]);
                send_mail('Maintenance logged: ' . $f['residence'] . ' (' . $ref . ')',
                    "Reference: $ref\nResidence: {$f['residence']}\nRoom: " . s($b['room'] ?? '-') . "\n"
                    . "Reported by: {$f['name']} ({$f['phone']})\nCategory: " . s($b['category'] ?? '-') . "\n"
                    . "Urgency: $urgency\n\n" . s($f['description'], 4000) . "\n",
                    strtolower(s($b['email'] ?? '', 190)) ?: null, null, ['kind' => 'maintenance_office']);

                /* The ticket number, in writing, to whoever reported it. */
                $who = strtolower(s($b['email'] ?? '', 190));
                if (filter_var($who, FILTER_VALIDATE_EMAIL)) {
                    send_mail('Maintenance ticket ' . $ref . ' is logged',
                        "Hi {$f['name']},\n\n"
                        . "Your ticket number is $ref. Quote it whenever you ask about this fault.\n\n"
                        . "  Residence: {$f['residence']}\n"
                        . '  Room: ' . s($b['room'] ?? '-') . "\n"
                        . "  Reported: " . now() . "\n"
                        . "  Urgency: $urgency\n\n"
                        . "What you told us:\n" . s($f['description'], 4000) . "\n\n"
                        . ($urgency === 'emergency'
                            ? "You marked this an emergency. Phone the 24 hour line on 071 640 1574 as well, so "
                              . "somebody comes out tonight.\n\n"
                            : "The house manager has it on the daily report, and you will hear from us once it is "
                              . "assigned.\n\n")
                        . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                        null, [$who], ['kind' => 'maintenance_ticket', 'to_name' => $f['name']]);
                }

                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Logged. Your reference is ' . $ref . ' — the house warden has it on the daily report.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('maintenance', ['ref', 'residence', 'room', 'name', 'phone', 'category', 'description'], MNT_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('maintenance', (int) $second, MNT_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('maintenance', (int) $second);
            fail('Unknown maintenance route.', 404);

        /* ========================== SUBSCRIBERS ======================= */
        case 'subscribers':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $email = strtolower(s($b['email'] ?? '', 190));
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                db()->prepare('INSERT INTO subscribers (name,email,created_at) VALUES (?,?,?)
                               ON CONFLICT(email) DO NOTHING')
                    ->execute([s($b['name'] ?? '', 190), $email, now()]);
                json_out(['ok' => true, 'message' => 'You are on the list. Welcome to Ligcabho.']);
            }
            if ($method === 'GET' && $second === '') list_records('subscribers', ['name', 'email'], []);
            if (ctype_digit($second) && $method === 'DELETE') delete_record('subscribers', (int) $second);
            fail('Unknown subscribers route.', 404);

        /* ========================== RESIDENCES ======================== */
        case 'residences':
            if ($method === 'GET' && $second === '') {
                $rows = db()->query('SELECT * FROM residences ORDER BY name')->fetchAll();
                json_out(['ok' => true, 'items' => $rows]);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                require_role(['owner']);
                $b = body();
                $set = [];
                $args = [];
                foreach (['capacity', 'single_rooms', 'sharing_rooms'] as $c) {
                    if (isset($b[$c])) { $set[] = "$c = ?"; $args[] = max(0, (int) $b[$c]); }
                }
                /* The rate card: what a room costs at this residence. The lease
                   form fills itself from these, and they can be overridden per lease. */
                foreach (['single_rate', 'sharing_rate', 'deposit', 'admin_fee'] as $c) {
                    if (isset($b[$c])) {
                        $money = preg_replace('/[^0-9.]/', '', (string) $b[$c]) ?? '';
                        $set[] = "$c = ?";
                        $args[] = s($money, 32);
                    }
                }
                if (isset($b['status'])) {
                    if (!in_array($b['status'], ['open', 'full', 'closed'], true)) fail('That status is not valid.', 422);
                    $set[] = 'status = ?';
                    $args[] = $b['status'];
                }
                if (!$set) fail('Nothing to update.', 422);
                $args[] = (int) $second;
                db()->prepare('UPDATE residences SET ' . implode(', ', $set) . ' WHERE id = ?')->execute($args);
                audit('residence_updated', 'residence#' . $second);
                json_out(['ok' => true]);
            }
            fail('Unknown residences route.', 404);

        /* ========================== VACANCIES ========================= */
        case 'vacancies':
            if ($method === 'GET' && $second === '') {
                $all = current_user() !== null && (s($_GET['all'] ?? '') === '1');
                $sql = 'SELECT * FROM vacancies' . ($all ? '' : " WHERE status = 'open'") . ' ORDER BY id DESC';
                json_out(['ok' => true, 'items' => db()->query($sql)->fetchAll()]);
            }
            if ($method === 'POST' && $second === '') {
                $u = require_role(['owner']);
                $b = body();
                $f = need($b, ['title']);
                db()->prepare('INSERT INTO vacancies (title,department,location,employment_type,summary,description,requirements,closing_date,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                    ->execute([$f['title'], s($b['department'] ?? '', 120), s($b['location'] ?? '', 190),
                               s($b['employment_type'] ?? '', 64), s($b['summary'] ?? '', 1000),
                               s($b['description'] ?? '', 6000), s($b['requirements'] ?? '', 4000),
                               s($b['closing_date'] ?? '', 32),
                               in_array($b['status'] ?? 'open', ['open', 'closed'], true) ? $b['status'] : 'open',
                               now(), now()]);
                audit('vacancy_created', $f['title'] . ' by ' . $u['email']);
                json_out(['ok' => true]);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                require_role(['owner']);
                $b = body();
                $set = [];
                $args = [];
                foreach (['title', 'department', 'location', 'employment_type', 'summary', 'description',
                          'requirements', 'closing_date'] as $c) {
                    if (isset($b[$c])) { $set[] = "$c = ?"; $args[] = s($b[$c], 6000); }
                }
                if (isset($b['status'])) {
                    if (!in_array($b['status'], ['open', 'closed'], true)) fail('That status is not valid.', 422);
                    $set[] = 'status = ?';
                    $args[] = $b['status'];
                }
                if (!$set) fail('Nothing to update.', 422);
                $set[] = 'updated_at = ?';
                $args[] = now();
                $args[] = (int) $second;
                db()->prepare('UPDATE vacancies SET ' . implode(', ', $set) . ' WHERE id = ?')->execute($args);
                audit('vacancy_updated', 'vacancy#' . $second);
                json_out(['ok' => true]);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('vacancies', (int) $second);
            fail('Unknown vacancies route.', 404);

        /* ====================== JOB APPLICATIONS ====================== */
        case 'job-applications':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['name', 'email', 'vacancy_title']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $cv = store_upload('cv');
                db()->prepare('INSERT INTO job_applications (vacancy_id,vacancy_title,name,email,phone,cover_note,cv_name,cv_stored,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,\'new\',?,?)')
                    ->execute([(int) ($b['vacancy_id'] ?? 0) ?: null, $f['vacancy_title'], $f['name'],
                               strtolower($f['email']), s($b['phone'] ?? '', 40), s($b['cover_note'] ?? '', 4000),
                               $cv['name'], $cv['stored'], now(), now()]);
                send_mail('Job application: ' . $f['vacancy_title'],
                    "Name: {$f['name']}\nEmail: {$f['email']}\nPhone: " . s($b['phone'] ?? '-') . "\n"
                    . "Position: {$f['vacancy_title']}\nCV attached in the portal: "
                    . ($cv['stored'] ? 'yes' : 'no') . "\n", $f['email']);
                json_out(['ok' => true, 'message' => 'Application received. We contact shortlisted candidates directly.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('job_applications', ['name', 'email', 'phone', 'vacancy_title'], JOB_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('job_applications', (int) $second, JOB_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('job_applications', (int) $second);
            fail('Unknown job-applications route.', 404);

        /* ============================ CHAT ============================ */
        case 'chat':
            if ($method === 'POST' && $second === 'log') {
                $b   = body();
                $key = s($b['session_key'] ?? '', 64);
                if ($key === '' || !preg_match('/^[A-Za-z0-9_-]{8,64}$/', $key)) fail('Bad session key.', 422);

                $st = db()->prepare('SELECT id FROM chat_sessions WHERE session_key = ?');
                $st->execute([$key]);
                if (!$st->fetch()) {
                    db()->prepare('INSERT INTO chat_sessions (session_key,outcome,started_at,updated_at) VALUES (?,\'open\',?,?)')
                        ->execute([$key, now(), now()]);
                }
                $ins = db()->prepare('INSERT INTO chat_messages (session_key,role,text,created_at) VALUES (?,?,?,?)');
                foreach ((array) ($b['messages'] ?? []) as $m) {
                    $role = ($m['role'] ?? 'user') === 'bot' ? 'bot' : 'user';
                    $text = s($m['text'] ?? '', 2000);
                    if ($text !== '') $ins->execute([$key, $role, $text, now()]);
                }
                if (isset($b['outcome']) && in_array($b['outcome'], ['open', 'applied', 'handoff', 'abandoned'], true)) {
                    db()->prepare('UPDATE chat_sessions SET outcome = ?, updated_at = ? WHERE session_key = ?')
                        ->execute([$b['outcome'], now(), $key]);
                }
                json_out(['ok' => true]);
            }
            if ($method === 'GET' && $second === '') {
                require_admin();
                $rows = db()->query('SELECT s.*, (SELECT COUNT(*) FROM chat_messages m WHERE m.session_key = s.session_key) AS messages
                                     FROM chat_sessions s ORDER BY s.id DESC LIMIT 500')->fetchAll();
                json_out(['ok' => true, 'items' => $rows]);
            }
            if ($method === 'GET' && $second !== '') {
                require_admin();
                $st = db()->prepare('SELECT role,text,created_at FROM chat_messages WHERE session_key = ? ORDER BY id');
                $st->execute([$second]);
                json_out(['ok' => true, 'items' => $st->fetchAll()]);
            }
            fail('Unknown chat route.', 404);

        /* =========================== LEASES =========================== */
        /* Public: a tenant opens and signs by unguessable token. */
        case 'lease':
            $token = $second;
            if ($token === '') fail('No lease token.', 404);
            $st = db()->prepare('SELECT * FROM leases WHERE token = ?');
            $st->execute([$token]);
            $lease = $st->fetch();
            if (!$lease) fail('That lease link is not valid. Please ask Ligcabho to resend it.', 404);

            if ($method === 'GET' && $third === '') {
                if ($lease['status'] === 'draft') fail('That lease has not been sent yet.', 403);
                if ($lease['status'] === 'cancelled') fail('That lease has been cancelled.', 410);
                unset($lease['tenant_sign_ip'], $lease['tenant_sign_agent']);
                /* The clauses come from the same function that writes the PDF,
                   so the screen and the signed document cannot drift apart. */
                require_once __DIR__ . '/docs.php';
                json_out(['ok' => true, 'lease' => $lease, 'terms' => lease_landlord($lease, cfg('lease')),
                          'site' => cfg('site'), 'clauses' => lease_terms($lease, cfg('lease'))]);
            }

            if ($third === 'pdf' && $method === 'GET') {
                if ($lease['status'] === 'draft') fail('That lease has not been sent yet.', 403);
                require_once __DIR__ . '/docs.php';
                $pdf = lease_pdf($lease, cfg('lease'), cfg('site'));
                header('Content-Type: application/pdf');
                header('Content-Disposition: inline; filename="ligcabho-lease-'
                    . preg_replace('/[^A-Za-z0-9]+/', '-', $lease['tenant_surname']) . '.pdf"');
                header('Content-Length: ' . strlen($pdf));
                echo $pdf;
                exit;
            }

            if ($third === 'sign' && $method === 'POST') {
                if (in_array($lease['status'], ['signed', 'countersigned'], true)) {
                    fail('This lease has already been signed.', 409);
                }
                if ($lease['status'] !== 'sent') fail('This lease is not open for signing.', 403);
                $b = body();
                $f = need($b, ['signed_name', 'home_address', 'kin_name', 'kin_contact']);
                $sig = (string) ($b['signature'] ?? '');
                if (!preg_match('~^data:image/png;base64,[A-Za-z0-9+/=]{100,}$~', $sig)) {
                    fail('Please draw or type your signature before submitting.', 422);
                }
                if (strlen($sig) > 400000) fail('That signature image is too large.', 422);
                if (empty($b['agree'])) fail('Please tick the box to confirm you accept the agreement.', 422);

                $expect = mb_strtolower(trim($lease['tenant_name'] . ' ' . $lease['tenant_surname']));
                if (mb_strtolower(trim($f['signed_name'])) !== $expect) {
                    fail('Please type your full name exactly as it appears on the lease: '
                         . $lease['tenant_name'] . ' ' . $lease['tenant_surname'], 422);
                }

                /* Keep the exact words that were agreed to. A lease that has been
                   signed must always print what the tenant read, even if the
                   wording of the agreement is changed for later leases. */
                require_once __DIR__ . '/docs.php';
                $signedLease = array_merge($lease, [
                    'home_address' => $f['home_address'],
                    'kin_name'     => $f['kin_name'],
                    'kin_contact'  => $f['kin_contact'],
                ]);
                $snapshot = json_encode([
                    'agreed_at' => now(),
                    'terms'     => cfg('lease'),
                    'clauses'   => lease_clauses($signedLease, cfg('lease')),
                ], JSON_UNESCAPED_UNICODE);

                db()->prepare("UPDATE leases SET status = 'signed', tenant_signature = ?, tenant_signed_name = ?,
                               tenant_signed_at = ?, tenant_sign_ip = ?, tenant_sign_agent = ?,
                               home_address = ?, kin_name = ?, kin_contact = ?, signed_at_place = ?,
                               tenant_witness_1 = ?, tenant_witness_2 = ?, terms_snapshot = ?, updated_at = ?
                               WHERE id = ?")
                    ->execute([$sig, $f['signed_name'], now(), client_ip(),
                               s($_SERVER['HTTP_USER_AGENT'] ?? '', 255),
                               $f['home_address'], $f['kin_name'], $f['kin_contact'],
                               s($b['signed_at_place'] ?? '', 120) ?: 'Mbombela',
                               s($b['witness_1'] ?? '', 190), s($b['witness_2'] ?? '', 190),
                               $snapshot, now(), $lease['id']]);

                send_mail('Lease signed: ' . $lease['tenant_name'] . ' ' . $lease['tenant_surname'],
                    "A tenant has signed their lease.\n\n"
                    . "Tenant: {$lease['tenant_name']} {$lease['tenant_surname']}\n"
                    . "ID number: {$lease['tenant_id_number']}\n"
                    . "Residence: {$lease['residence']}\nRoom: {$lease['room_number']}\n"
                    . "Rent: R{$lease['monthly_rent']} per month\n"
                    . 'Signed: ' . now() . ' from ' . client_ip() . "\n\n"
                    . 'Counter-sign it in the admin portal: ' . cfg('site.url') . "/admin/#/leases\n",
                    $lease['tenant_email']);

                send_mail('Your Ligcabho lease is signed',
                    "Hi {$lease['tenant_name']},\n\n"
                    . "Thank you. We have your signed lease for {$lease['residence']}.\n\n"
                    . "Room: {$lease['room_number']}\nStarts: {$lease['commencement_date']}\n"
                    . "Rent: R{$lease['monthly_rent']} per month\n\n"
                    . "You can reopen, print or download your copy at any time:\n"
                    . cfg('site.url') . "/lease.html?t={$lease['token']}\n"
                    . "A PDF of the signed lease: " . cfg('site.url') . "/api/lease/{$lease['token']}/pdf\n"
                    . "Your signed lease and the house rules are attached.\n\n"
                    . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                    null, [$lease['tenant_email']],
                    ['kind' => 'lease_signed', 'to_name' => $lease['tenant_name'] . ' ' . $lease['tenant_surname'],
                     'attach' => [['gen' => 'lease', 'id' => (int) $lease['id']], ['gen' => 'house_rules']]]);

                json_out(['ok' => true]);
            }
            fail('Unknown lease route.', 404);

        case 'leases':
            if ($method === 'GET' && $second === '') {
                require_admin();
                $st = db()->prepare('SELECT id,token,tenant_name,tenant_surname,tenant_email,residence,room_number,
                                     monthly_rent,commencement_date,end_date,status,sent_at,tenant_signed_at,
                                     landlord_signed_at,created_at FROM leases ORDER BY id DESC LIMIT 1000');
                $st->execute();
                json_out(['ok' => true, 'items' => $st->fetchAll()]);
            }

            if ($method === 'POST' && $second === '') {
                $u = require_role(['owner']);
                $b = body();
                $f = need($b, ['tenant_name', 'tenant_surname', 'tenant_email']);
                if (!filter_var($f['tenant_email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $token = bin2hex(random_bytes(16));
                $cols  = ['tenant_id_number', 'tenant_phone', 'student_number', 'institution', 'course',
                          'year_of_study', 'residence', 'room_number', 'room_type', 'commencement_date',
                          'end_date', 'monthly_rent', 'admin_fee', 'deposit', 'funder', 'max_occupants',
                          'special_conditions'];
                $vals  = [];
                foreach ($cols as $c) $vals[] = s($b[$c] ?? '', 2000);

                db()->prepare('INSERT INTO leases (token,application_id,tenant_name,tenant_surname,tenant_email,'
                    . implode(',', $cols) . ',status,created_at,updated_at) VALUES (?,?,?,?,?,'
                    . rtrim(str_repeat('?,', count($cols)), ',') . ",'draft',?,?)")
                    ->execute([$token, (int) ($b['application_id'] ?? 0) ?: null, $f['tenant_name'],
                               $f['tenant_surname'], strtolower($f['tenant_email']), ...$vals, now(), now()]);

                audit('lease_created', $f['tenant_name'] . ' ' . $f['tenant_surname'] . ' by ' . $u['email']);
                json_out(['ok' => true, 'token' => $token,
                          'link' => cfg('site.url') . '/lease.html?t=' . $token]);
            }

            if (ctype_digit($second)) {
                $u = require_admin();
                $id = (int) $second;
                $st = db()->prepare('SELECT * FROM leases WHERE id = ?');
                $st->execute([$id]);
                $lease = $st->fetch();
                if (!$lease) fail('That lease no longer exists.', 404);

                if ($method === 'GET' && $third === '') json_out(['ok' => true, 'lease' => $lease, 'terms' => cfg('lease')]);

                if ($third === 'pdf' && $method === 'GET') {
                    require_once __DIR__ . '/docs.php';
                    $pdf = lease_pdf($lease, cfg('lease'), cfg('site'));
                    header('Content-Type: application/pdf');
                    header('Content-Disposition: inline; filename="ligcabho-lease-'
                        . preg_replace('/[^A-Za-z0-9]+/', '-', $lease['tenant_surname']) . '.pdf"');
                    header('Content-Length: ' . strlen($pdf));
                    echo $pdf;
                    exit;
                }

                if ($third === 'send' && $method === 'POST') {
                    require_role(['owner']);
                    if (!in_array($lease['status'], ['draft', 'sent'], true)) fail('That lease has moved past sending.', 409);
                    db()->prepare("UPDATE leases SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?")
                        ->execute([now(), now(), $id]);
                    $link = cfg('site.url') . '/lease.html?t=' . $lease['token'];
                    send_mail('Your Ligcabho lease agreement is ready to sign',
                        "Hi {$lease['tenant_name']},\n\n"
                        . "Your lease for {$lease['residence']}"
                        . ($lease['room_number'] ? ", room {$lease['room_number']}" : '')
                        . " is ready.\n\nOpen it, read it and sign it here:\n$link\n\n"
                        . "The link is personal to you — please do not forward it.\n\n"
                        . "A copy is attached so you can read it before you sign.\n\n"
                        . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                        null, [$lease['tenant_email']],
                        ['kind' => 'lease_sent', 'to_name' => $lease['tenant_name'] . ' ' . $lease['tenant_surname'],
                         'attach' => [['gen' => 'lease', 'id' => $id]]]);
                    audit('lease_sent', 'lease#' . $id . ' by ' . $u['email']);
                    json_out(['ok' => true, 'link' => $link]);
                }

                if ($third === 'countersign' && $method === 'POST') {
                    require_role(['owner']);
                    if ($lease['status'] !== 'signed') fail('Counter-sign once the tenant has signed.', 409);
                    $b = body();
                    $sig = (string) ($b['signature'] ?? '');
                    if (!preg_match('~^data:image/png;base64,[A-Za-z0-9+/=]{100,}$~', $sig)) {
                        fail('Please draw or type the landlord signature.', 422);
                    }
                    db()->prepare("UPDATE leases SET status = 'countersigned', landlord_signature = ?,
                                   landlord_signed_name = ?, landlord_signed_at = ?,
                                   landlord_witness_1 = ?, landlord_witness_2 = ?, updated_at = ? WHERE id = ?")
                        ->execute([$sig, s($b['signed_name'] ?? $u['name'], 190), now(),
                                   s($b['witness_1'] ?? '', 190), s($b['witness_2'] ?? '', 190), now(), $id]);
                    send_mail('Your Ligcabho lease is fully signed',
                        "Hi {$lease['tenant_name']},\n\nYour lease is now signed by both parties. "
                        . "Keep your copy:\n" . cfg('site.url') . "/lease.html?t={$lease['token']}\n"
                        . "PDF: " . cfg('site.url') . "/api/lease/{$lease['token']}/pdf\n"
                        . "Both documents are attached.\n\n"
                        . cfg('site.name') . "\n", null, [$lease['tenant_email']],
                        ['kind' => 'lease_countersigned',
                         'to_name' => $lease['tenant_name'] . ' ' . $lease['tenant_surname'],
                         'attach' => [['gen' => 'lease', 'id' => $id], ['gen' => 'house_rules']]]);
                    audit('lease_countersigned', 'lease#' . $id . ' by ' . $u['email']);
                    json_out(['ok' => true]);
                }

                if ($third === 'cancel' && $method === 'POST') {
                    require_role(['owner']);
                    db()->prepare("UPDATE leases SET status = 'cancelled', updated_at = ? WHERE id = ?")
                        ->execute([now(), $id]);
                    audit('lease_cancelled', 'lease#' . $id . ' by ' . $u['email']);
                    json_out(['ok' => true]);
                }

                if ($method === 'DELETE') delete_record('leases', $id);
            }
            fail('Unknown leases route.', 404);


        /* =========================== REVIEWS ========================== */
        case 'reviews':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['name', 'residence', 'body']);
                $rating = (int) ($b['rating'] ?? 0);
                if ($rating < 1 || $rating > 5) fail('Please give a rating from 1 to 5.', 422);
                $ref = make_ref('REV');
                db()->prepare('INSERT INTO reviews (ref,name,email,residence,rating,title,body,status,published,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,\'new\',0,?,?)')
                    ->execute([$ref, $f['name'], strtolower(s($b['email'] ?? '', 190)), $f['residence'], $rating,
                               s($b['title'] ?? '', 190), s($f['body'], 4000), now(), now()]);
                send_mail('New review (' . $rating . '/5) for ' . $f['residence'],
                    "Reference: $ref\nFrom: {$f['name']}\nResidence: {$f['residence']}\nRating: $rating/5\n\n"
                    . s($f['body'], 4000) . "\n\nPublish or reply in the portal: " . cfg('site.url') . "/admin/#/reviews\n",
                    s($b['email'] ?? '') ?: null);
                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Thank you. Your review is with the team and appears on the site once it is checked.']);
            }
            /* Published reviews are public, so the website can show them. */
            if ($method === 'GET' && $second === 'published') {
                $st = db()->prepare('SELECT ref,name,residence,rating,title,body,reply,created_at FROM reviews
                                     WHERE published = 1 ORDER BY id DESC LIMIT 60');
                $st->execute();
                json_out(['ok' => true, 'items' => $st->fetchAll()]);
            }
            if ($method === 'GET' && $second === '') {
                list_records('reviews', ['ref', 'name', 'email', 'residence', 'title', 'body'], REV_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                $u = require_admin();
                $b = body();
                $set = [];
                $args = [];
                if (isset($b['status'])) {
                    if (!in_array($b['status'], REV_STATUSES, true)) fail('That status is not valid.', 422);
                    $set[] = 'status = ?';
                    $args[] = $b['status'];
                    /* Publishing and hiding follow the status, so one control does the job. */
                    $set[] = 'published = ?';
                    $args[] = in_array($b['status'], ['published', 'replied'], true) ? 1 : 0;
                }
                if (isset($b['published'])) { $set[] = 'published = ?'; $args[] = ((int) $b['published']) === 1 ? 1 : 0; }
                if (isset($b['reply']))      { $set[] = 'reply = ?';      $args[] = s($b['reply'], 2000); }
                if (isset($b['admin_notes'])) { $set[] = 'admin_notes = ?'; $args[] = s($b['admin_notes'], 4000); }
                if (!$set) fail('Nothing to update.', 422);
                $set[] = 'updated_at = ?';
                $args[] = now();
                $args[] = (int) $second;
                db()->prepare('UPDATE reviews SET ' . implode(', ', $set) . ' WHERE id = ?')->execute($args);
                audit('review_updated', 'review#' . $second . ' by ' . $u['email']);
                json_out(['ok' => true]);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('reviews', (int) $second);
            fail('Unknown reviews route.', 404);

        /* ======================== CANCELLATIONS ======================= */
        case 'cancellations':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['name', 'email', 'phone', 'residence', 'vacate_date', 'reason']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                if (empty($b['acknowledged'])) {
                    fail('Please confirm you understand the notice period and the vacate process.', 422);
                }
                $ref = make_ref('CXL');
                db()->prepare('INSERT INTO cancellations (ref,lease_id,name,email,phone,id_number,student_number,
                               residence,room,vacate_date,reason,detail,forwarding_address,refund_account,
                               acknowledged,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,\'new\',?,?)')
                    ->execute([$ref, (int) ($b['lease_id'] ?? 0) ?: null, $f['name'], strtolower($f['email']),
                               $f['phone'], s($b['id_number'] ?? '', 32), s($b['student_number'] ?? '', 64),
                               $f['residence'], s($b['room'] ?? '', 64), $f['vacate_date'], $f['reason'],
                               s($b['detail'] ?? '', 4000), s($b['forwarding_address'] ?? '', 1000),
                               s($b['refund_account'] ?? '', 1000), now(), now()]);

                send_mail('Notice to vacate: ' . $f['name'] . ' (' . $ref . ')',
                    "Reference: $ref\nStudent: {$f['name']}\nEmail: {$f['email']}\nPhone: {$f['phone']}\n"
                    . "Residence: {$f['residence']}\nRoom: " . s($b['room'] ?? '-') . "\n"
                    . "Vacate date: {$f['vacate_date']}\nReason: {$f['reason']}\n\n"
                    . s($b['detail'] ?? '', 4000) . "\n\nWork it in the portal: " . cfg('site.url') . "/admin/#/cancellations\n",
                    $f['email']);

                send_mail('We have your notice to vacate (' . $ref . ')',
                    "Hi {$f['name']},\n\nWe have received your notice to vacate {$f['residence']} on {$f['vacate_date']}. "
                    . "Your reference is $ref.\n\nWhat happens next:\n"
                    . "1. The office confirms your notice period and your account balance.\n"
                    . "2. Your room is inspected and any damages are charged.\n"
                    . "3. A vacate note is issued once your account is paid in full.\n"
                    . "4. Any refund is paid after deductions.\n\n"
                    . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                    null, [$f['email']]);

                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Notice received. The office will confirm your notice period and vacate inspection.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('cancellations', ['ref', 'name', 'email', 'phone', 'residence', 'room', 'reason'], CXL_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('cancellations', (int) $second, CXL_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('cancellations', (int) $second);
            fail('Unknown cancellations route.', 404);

        /* ============================ TODAY =========================== */
        /* One inbox of everything waiting on the office. */
        case 'today':
            require_admin();
            $pdo = db();
            $items = [];

            foreach ($pdo->query("SELECT id,ref,first_name,last_name,institution,pop_stored,created_at
                                  FROM applications WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'application', 'id' => (int) $r['id'], 'route' => 'applications',
                    'title' => $r['ref'] . ': ' . $r['first_name'] . ' ' . $r['last_name'],
                    'detail' => ($r['institution'] ?: 'Institution not stated') . ', '
                              . ($r['pop_stored'] ? 'proof of payment attached' : 'NO proof of payment'),
                    'action' => 'Decide', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,name,topic,residence,created_at FROM enquiries
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'enquiry', 'id' => (int) $r['id'], 'route' => 'enquiries',
                    'title' => $r['name'] . ' sent an enquiry',
                    'detail' => $r['topic'] ?: ($r['residence'] ?: 'General'),
                    'action' => 'Read', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,ref,residence,room,urgency,created_at FROM maintenance
                                  WHERE status IN ('logged','assigned') ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'maintenance', 'id' => (int) $r['id'], 'route' => 'maintenance',
                    'title' => $r['ref'] . ': ' . $r['residence'] . ($r['room'] ? ', room ' . $r['room'] : ''),
                    'detail' => ucfirst($r['urgency']) . ' maintenance request',
                    'action' => 'Assign', 'at' => $r['created_at'], 'urgent' => $r['urgency'] !== 'standard'];
            }
            foreach ($pdo->query("SELECT id,ref,name,residence,vacate_date,created_at FROM cancellations
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'cancellation', 'id' => (int) $r['id'], 'route' => 'cancellations',
                    'title' => $r['name'] . ' gave notice to vacate',
                    'detail' => $r['residence'] . ', leaving ' . $r['vacate_date'],
                    'action' => 'Acknowledge', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,ref,first_name,last_name,current_residence,coming_back,created_at
                                  FROM retentions WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $back = $r['coming_back'] === 'yes' ? 'is coming back'
                      : ($r['coming_back'] === 'no' ? 'is leaving' : 'is undecided');
                $items[] = ['kind' => 'retention', 'id' => (int) $r['id'], 'route' => 'retentions',
                    'title' => $r['first_name'] . ' ' . $r['last_name'] . ' ' . $back,
                    'detail' => $r['current_residence'] . ' · ' . $r['ref'],
                    'action' => 'Place', 'at' => $r['created_at'], 'urgent' => $r['coming_back'] === 'no'];
            }
            foreach ($pdo->query("SELECT id,name,residence,rating,created_at FROM reviews
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'review', 'id' => (int) $r['id'], 'route' => 'reviews',
                    'title' => $r['name'] . ' left a ' . $r['rating'] . '-star review',
                    'detail' => $r['residence'], 'action' => 'Publish', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,tenant_name,tenant_surname,residence,created_at FROM leases
                                  WHERE status = 'signed' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'lease', 'id' => (int) $r['id'], 'route' => 'leases',
                    'title' => $r['tenant_name'] . ' ' . $r['tenant_surname'] . ' signed their lease',
                    'detail' => ($r['residence'] ?: 'Lease') . ' — counter-signature needed',
                    'action' => 'Counter-sign', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,name,vacancy_title,created_at FROM job_applications
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'careers', 'id' => (int) $r['id'], 'route' => 'careers',
                    'title' => $r['name'] . ' applied for a job',
                    'detail' => $r['vacancy_title'], 'action' => 'Read', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,ref,name,total,due_on,created_at FROM invoices
                                  WHERE kind = 'invoice' AND status = 'sent' AND COALESCE(due_on,'') <> ''
                                  AND due_on < '" . date('Y-m-d') . "' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'invoice', 'id' => (int) $r['id'], 'route' => 'finance',
                    'title' => $r['ref'] . ': ' . $r['name'] . ' owes R' . $r['total'],
                    'detail' => 'Invoice overdue since ' . $r['due_on'],
                    'action' => 'Chase', 'at' => $r['created_at'], 'urgent' => true];
            }
            foreach ($pdo->query("SELECT id,ref,name,amount,reason,created_at FROM refunds
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'refund', 'id' => (int) $r['id'], 'route' => 'refunds',
                    'title' => $r['ref'] . ': ' . $r['name'] . ' claims R' . $r['amount'],
                    'detail' => $r['reason'], 'action' => 'Check', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,ref,kind,name,created_at FROM staff_requests
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'staff', 'id' => (int) $r['id'], 'route' => 'staff',
                    'title' => $r['name'] . ' sent ' . (strpos('aeiou', strtolower($r['kind'][0] ?? 'x')) !== false
                                ? 'an ' : 'a ') . $r['kind'] . ' request',
                    'detail' => 'Staff portal · ' . $r['ref'], 'action' => 'Read', 'at' => $r['created_at']];
            }
            foreach ($pdo->query("SELECT id,ref,residence,urgency,created_at FROM supply_orders
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'supplies', 'id' => (int) $r['id'], 'route' => 'supplies',
                    'title' => $r['ref'] . ': supplies for ' . $r['residence'],
                    'detail' => ucfirst($r['urgency']) . ' requisition', 'action' => 'Order',
                    'at' => $r['created_at'], 'urgent' => $r['urgency'] !== 'standard'];
            }
            foreach ($pdo->query("SELECT id,ref,pack,name,created_at FROM orders
                                  WHERE status = 'new' ORDER BY id DESC LIMIT 25") as $r) {
                $items[] = ['kind' => 'order', 'id' => (int) $r['id'], 'route' => 'orders',
                    'title' => $r['name'] . ' ordered a LVL UP pack',
                    'detail' => $r['pack'], 'action' => 'Read', 'at' => $r['created_at']];
            }

            usort($items, function ($a, $b) { return strcmp($b['at'], $a['at']); });

            $count = function (string $sql) use ($pdo): int { return (int) $pdo->query($sql)->fetch()['c']; };
            json_out(['ok' => true, 'items' => array_slice($items, 0, 40), 'tiles' => [
                'awaiting_review'     => $count("SELECT COUNT(*) c FROM applications WHERE status = 'new'"),
                'open_maintenance'    => $count("SELECT COUNT(*) c FROM maintenance WHERE status IN ('logged','assigned','in_progress')"),
                'maintenance_urgent'  => $count("SELECT COUNT(*) c FROM maintenance WHERE urgency <> 'standard'
                                                 AND status IN ('logged','assigned','in_progress')"),
                'cancellations_open'  => $count("SELECT COUNT(*) c FROM cancellations WHERE status IN ('new','acknowledged','inspection')"),
                'leases_countersign'  => $count("SELECT COUNT(*) c FROM leases WHERE status = 'signed'"),
                'reviews_new'         => $count("SELECT COUNT(*) c FROM reviews WHERE status = 'new'"),
                'retentions_new'      => $count("SELECT COUNT(*) c FROM retentions WHERE status = 'new'"),
                'refunds_open'        => $count("SELECT COUNT(*) c FROM refunds WHERE status IN ('new','checking','approved')"),
                'staff_requests_new'  => $count("SELECT COUNT(*) c FROM staff_requests WHERE status = 'new'")
                                         + $count("SELECT COUNT(*) c FROM supply_orders WHERE status = 'new'"),
                'invoices_overdue'    => $count("SELECT COUNT(*) c FROM invoices WHERE kind = 'invoice'
                                                 AND status = 'sent' AND COALESCE(due_on,'') <> ''
                                                 AND due_on < '" . date('Y-m-d') . "'"),
            ]]);


        /* =========================== REFUNDS ========================== */
        case 'refunds':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['name', 'email', 'reason', 'amount']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $amount = preg_replace('/[^0-9.]/', '', $f['amount']) ?? '';
                if ($amount === '') fail('Please give the amount you are claiming, in rands.', 422);

                $pop = store_upload('proof_of_payment');
                $ref = make_ref('REF');
                db()->prepare('INSERT INTO refunds (ref,claimant,name,id_number,email,phone,residence,room,
                               application_ref,reason,amount,paid_on,detail,bank_name,account_name,account_number,
                               branch_code,pop_name,pop_stored,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'new\',?,?)')
                    ->execute([$ref, ($b['claimant'] ?? '') === 'staff' ? 'staff' : 'student', $f['name'],
                               s($b['id_number'] ?? '', 32), strtolower($f['email']), s($b['phone'] ?? '', 40),
                               s($b['residence'] ?? '', 190), s($b['room'] ?? '', 64),
                               s($b['application_ref'] ?? '', 24), $f['reason'], $amount,
                               s($b['paid_on'] ?? '', 32), s($b['detail'] ?? '', 4000),
                               s($b['bank_name'] ?? '', 120), s($b['account_name'] ?? '', 190),
                               s($b['account_number'] ?? '', 64), s($b['branch_code'] ?? '', 32),
                               $pop['name'], $pop['stored'], now(), now()]);

                send_mail('Refund claim: ' . $f['name'] . ' (' . $ref . ')',
                    "Reference: $ref\nClaimant: {$f['name']} (" . s($b['claimant'] ?? 'student') . ")\n"
                    . "Email: {$f['email']}\nPhone: " . s($b['phone'] ?? '-') . "\n"
                    . 'Residence: ' . s($b['residence'] ?? '-') . "\nReason: {$f['reason']}\nAmount: R$amount\n"
                    . 'Proof of payment attached: ' . ($pop['stored'] ? 'yes' : 'no') . "\n\n"
                    . s($b['detail'] ?? '', 4000) . "\n\nWork it in the portal: " . cfg('site.url') . "/admin/#/refunds\n",
                    $f['email']);

                send_mail('We have your refund claim (' . $ref . ')',
                    "Hi {$f['name']},\n\nWe have your claim for R$amount. Your reference is $ref.\n\n"
                    . "Finance checks the payment against our records, confirms the amount, and pays into the "
                    . "account you gave us. Claims are worked in the order they arrive.\n\n"
                    . "If we need anything else, we will email you on this address.\n\n"
                    . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                    null, [$f['email']]);

                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Claim received. Finance will check it against our records and come back to you.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('refunds', ['ref', 'name', 'email', 'phone', 'residence', 'reason', 'application_ref'], REF_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('refunds', (int) $second, REF_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('refunds', (int) $second);
            fail('Unknown refunds route.', 404);

        /* ======================== STAFF REQUESTS ====================== */
        case 'staff-requests':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['kind', 'name', 'email', 'detail']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $doc = store_upload('document');
                $ref = make_ref('STF');
                db()->prepare('INSERT INTO staff_requests (ref,kind,name,email,phone,role,residence,start_date,
                               end_date,days,amount,detail,document_name,document_stored,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'new\',?,?)')
                    ->execute([$ref, s($f['kind'], 40), $f['name'], strtolower($f['email']),
                               s($b['phone'] ?? '', 40), s($b['role'] ?? '', 120), s($b['residence'] ?? '', 190),
                               s($b['start_date'] ?? '', 32), s($b['end_date'] ?? '', 32), s($b['days'] ?? '', 16),
                               preg_replace('/[^0-9.]/', '', s($b['amount'] ?? '', 32)),
                               s($f['detail'], 4000), $doc['name'], $doc['stored'], now(), now()]);

                send_mail('Staff request: ' . $f['kind'] . ' from ' . $f['name'] . ' (' . $ref . ')',
                    "Reference: $ref\nType: {$f['kind']}\nStaff member: {$f['name']}\nRole: "
                    . s($b['role'] ?? '-') . "\nResidence: " . s($b['residence'] ?? '-') . "\n"
                    . 'Dates: ' . s($b['start_date'] ?? '-') . ' to ' . s($b['end_date'] ?? '-') . "\n\n"
                    . s($f['detail'], 4000) . "\n", $f['email']);

                send_mail('We have your request (' . $ref . ')',
                    "Hi {$f['name']},\n\nYour {$f['kind']} request is with the office. Reference $ref.\n"
                    . "You will hear back once it has been looked at.\n\n" . cfg('site.name') . "\n",
                    null, [$f['email']]);

                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Request received. Your reference is ' . $ref . '.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('staff_requests', ['ref', 'name', 'email', 'kind', 'role', 'residence', 'detail'], STF_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('staff_requests', (int) $second, STF_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('staff_requests', (int) $second);
            fail('Unknown staff-requests route.', 404);

        /* ========================== SUPPLIES ========================== */
        case 'supplies':
            if ($method === 'POST' && $second === '') {
                $b = body();
                $f = need($b, ['residence', 'name', 'items']);
                $ref = make_ref('SUP');
                $urgency = in_array($b['urgency'] ?? '', ['urgent', 'standard'], true) ? $b['urgency'] : 'standard';
                db()->prepare('INSERT INTO supply_orders (ref,residence,name,email,phone,needed_by,urgency,items,
                               notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,\'new\',?,?)')
                    ->execute([$ref, $f['residence'], $f['name'], strtolower(s($b['email'] ?? '', 190)),
                               s($b['phone'] ?? '', 40), s($b['needed_by'] ?? '', 32), $urgency,
                               s($f['items'], 4000), s($b['notes'] ?? '', 2000), now(), now()]);
                send_mail('Supplies requisition: ' . $f['residence'] . ' (' . $ref . ')',
                    "Reference: $ref\nResidence: {$f['residence']}\nRequested by: {$f['name']}\n"
                    . "Needed by: " . s($b['needed_by'] ?? '-') . "\nUrgency: $urgency\n\nItems:\n"
                    . s($f['items'], 4000) . "\n");
                json_out(['ok' => true, 'ref' => $ref,
                    'message' => 'Requisition sent to the maintenance office. Reference ' . $ref . '.']);
            }
            if ($method === 'GET' && $second === '') {
                list_records('supply_orders', ['ref', 'residence', 'name', 'items'], SUP_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('supply_orders', (int) $second, SUP_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('supply_orders', (int) $second);
            fail('Unknown supplies route.', 404);

        /* ============================ DOCS ============================ */
        /* House rules as a PDF, for anyone. */
        case 'docs':
            if ($second === 'house-rules.pdf') {
                require_once __DIR__ . '/docs.php';
                $pdf = house_rules_pdf(cfg('site'));
                header('Content-Type: application/pdf');
                header('Content-Disposition: inline; filename="ligcabho-house-rules.pdf"');
                header('Content-Length: ' . strlen($pdf));
                echo $pdf;
                exit;
            }
            fail('Unknown document.', 404);



        /* ========================== RETENTIONS ======================== */
        /* A student already in residence telling us whether they are coming back. */
        case 'retentions':
            if ($method === 'POST' && $second === '') {
                $b = body();
                if (empty($b['consent'])) fail('Please confirm the declaration before submitting.', 422);
                $f = need($b, ['first_name', 'last_name', 'phone', 'email', 'current_residence', 'coming_back']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);

                $id = preg_replace('/\D+/', '', s($b['id_number'] ?? '', 20)) ?? '';
                if ($id !== '' && !valid_sa_id($id)) {
                    fail('That does not look like a valid South African ID number.', 422);
                }
                $returning = in_array($f['coming_back'], ['yes', 'no', 'undecided'], true) ? $f['coming_back'] : 'undecided';
                $rating = (int) ($b['rating'] ?? 0);
                if ($rating < 0 || $rating > 5) $rating = 0;

                /* A student who is leaving does not need to choose next year's room. */
                if ($returning === 'yes' && s($b['year_applying'] ?? '') === '') {
                    fail('Please tell us which year you are coming back for.', 422);
                }

                $ref = make_ref('RET');
                db()->prepare('INSERT INTO retentions (ref,first_name,last_name,id_number,student_number,phone,email,
                               gender,current_residence,current_room,months_in_residence,lease_end,account_up_to_date,
                               coming_back,year_applying,institution,level_of_study,funder,funding_confirmed,same_room,
                               preferred_residence,room_type,roommate,move_in_date,rating,recommend,what_worked,
                               what_to_improve,outstanding_maintenance,leaving_reason,notes,signed_name,status,ip,
                               created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'new\',?,?,?)')
                    ->execute([
                        $ref, $f['first_name'], $f['last_name'], $id, s($b['student_number'] ?? '', 64),
                        $f['phone'], strtolower($f['email']), s($b['gender'] ?? '', 16),
                        $f['current_residence'], s($b['current_room'] ?? '', 64),
                        s($b['months_in_residence'] ?? '', 16), s($b['lease_end'] ?? '', 32),
                        s($b['account_up_to_date'] ?? '', 16), $returning,
                        s($b['year_applying'] ?? '', 8), s($b['institution'] ?? '', 190),
                        s($b['level_of_study'] ?? '', 64), s($b['funder'] ?? '', 64),
                        s($b['funding_confirmed'] ?? '', 16), s($b['same_room'] ?? '', 16),
                        s($b['preferred_residence'] ?? '', 190), s($b['room_type'] ?? '', 40),
                        s($b['roommate'] ?? '', 190), s($b['move_in_date'] ?? '', 32),
                        $rating, s($b['recommend'] ?? '', 16), s($b['what_worked'] ?? '', 4000),
                        s($b['what_to_improve'] ?? '', 4000), s($b['outstanding_maintenance'] ?? '', 4000),
                        s($b['leaving_reason'] ?? '', 190), s($b['notes'] ?? '', 4000),
                        s($b['signed_name'] ?? '', 190), client_ip(), now(), now(),
                    ]);

                $word = ['yes' => 'is coming back', 'no' => 'is NOT coming back', 'undecided' => 'is undecided'][$returning];
                send_mail('Retention: ' . $f['first_name'] . ' ' . $f['last_name'] . ' ' . $word . ' (' . $ref . ')',
                    "Reference: $ref\nStudent: {$f['first_name']} {$f['last_name']}\n"
                    . "Currently at: {$f['current_residence']}" . (s($b['current_room'] ?? '') ? ', room ' . s($b['current_room']) : '') . "\n"
                    . "Phone: {$f['phone']}\nEmail: {$f['email']}\n\n"
                    . "Returning: $returning\n"
                    . ($returning === 'yes'
                        ? 'Year: ' . s($b['year_applying'] ?? '-') . "\n"
                          . 'Wants: ' . (s($b['same_room'] ?? '') === 'yes' ? 'the same room' : s($b['room_type'] ?? 'no preference')) . "\n"
                          . 'At: ' . s($b['preferred_residence'] ?? 'no preference') . "\n"
                          . 'Funder: ' . s($b['funder'] ?? '-') . ' (confirmed: ' . s($b['funding_confirmed'] ?? '-') . ")\n"
                        : 'Reason for leaving: ' . s($b['leaving_reason'] ?? '-') . "\n")
                    . "\nRating of their stay: " . ($rating ?: 'not given') . "/5\n"
                    . 'Would recommend: ' . s($b['recommend'] ?? '-') . "\n\n"
                    . "What worked:\n" . s($b['what_worked'] ?? '-', 4000) . "\n\n"
                    . "What to improve:\n" . s($b['what_to_improve'] ?? '-', 4000) . "\n\n"
                    . "Outstanding maintenance:\n" . s($b['outstanding_maintenance'] ?? '-', 4000) . "\n\n"
                    . 'Work it in the portal: ' . cfg('site.url') . "/admin/#/retentions\n",
                    $f['email']);

                if (mcfg('send_applicant_confirmation')) {
                    send_mail($returning === 'yes'
                        ? 'We have your place-back request (' . $ref . ')'
                        : 'We have your form (' . $ref . ')',
                        "Hi {$f['first_name']},\n\n"
                        . ($returning === 'yes'
                            ? "Thank you for staying with Ligcabho. Your reference is $ref.\n\n"
                              . "Returning students are placed before new applications, so your room is held while we "
                              . "check your account and your funding. We will confirm your room in writing.\n\n"
                              . "If anything changes — your funder, your institution, your dates — reply to this email.\n"
                            : "Thank you for letting us know, and for the year you spent with us. Your reference is $ref.\n\n"
                              . "The office will be in touch about your vacate date, the room inspection and your "
                              . "deposit refund. If you change your mind before rooms are allocated, tell us and we "
                              . "will hold one for you.\n")
                        . "\n" . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                        null, [$f['email']]);
                }

                json_out(['ok' => true, 'ref' => $ref, 'message' => $returning === 'yes'
                    ? 'Thank you. Returning students are placed first — we will confirm your room in writing.'
                    : 'Thank you for telling us. The office will be in touch about your vacate and your deposit.']);
            }

            if ($method === 'GET' && $second === '') {
                list_records('retentions',
                    ['ref', 'first_name', 'last_name', 'email', 'phone', 'student_number', 'current_residence', 'preferred_residence'],
                    RET_STATUSES);
            }
            if (ctype_digit($second) && ($method === 'PATCH' || $method === 'POST')) {
                patch_record('retentions', (int) $second, RET_STATUSES);
            }
            if (ctype_digit($second) && $method === 'DELETE') delete_record('retentions', (int) $second);
            fail('Unknown retentions route.', 404);

        /* ====================== INVOICES AND QUOTES =================== */
        case 'invoices':
            if ($method === 'GET' && $second === '') {
                list_records('invoices', ['ref', 'name', 'email', 'residence', 'room'], INV_STATUSES);
            }

            if ($method === 'POST' && $second === '') {
                $u = require_role(['owner']);
                $b = body();
                $f = need($b, ['name', 'email']);
                if (!filter_var($f['email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $kind = ($b['kind'] ?? 'invoice') === 'quote' ? 'quote' : 'invoice';

                /* Line items arrive as [{description, qty, amount}, ...]. */
                $lines = [];
                $total = 0.0;
                foreach ((array) ($b['items'] ?? []) as $row) {
                    $desc = s($row['description'] ?? '', 190);
                    if ($desc === '') continue;
                    $qty  = max(1, (int) ($row['qty'] ?? 1));
                    $amt  = (float) preg_replace('/[^0-9.]/', '', (string) ($row['amount'] ?? '0'));
                    $lines[] = ['description' => $desc, 'qty' => $qty, 'amount' => round($amt, 2)];
                    $total += $qty * $amt;
                }
                if (!$lines) fail('Add at least one line with a description and an amount.', 422);

                $ref = make_ref($kind === 'quote' ? 'QTE' : 'INV');
                db()->prepare('INSERT INTO invoices (ref,kind,lease_id,application_id,name,email,phone,residence,room,
                               items,total,issued_on,due_on,note,status,created_at,updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'draft\',?,?)')
                    ->execute([$ref, $kind, (int) ($b['lease_id'] ?? 0) ?: null,
                               (int) ($b['application_id'] ?? 0) ?: null, $f['name'], strtolower($f['email']),
                               s($b['phone'] ?? '', 40), s($b['residence'] ?? '', 190), s($b['room'] ?? '', 64),
                               json_encode($lines), number_format($total, 2, '.', ''),
                               s($b['issued_on'] ?? date('Y-m-d'), 32), s($b['due_on'] ?? '', 32),
                               s($b['note'] ?? '', 2000), now(), now()]);

                audit($kind . '_created', $ref . ' by ' . $u['email']);
                json_out(['ok' => true, 'ref' => $ref, 'total' => number_format($total, 2, '.', '')]);
            }

            if (ctype_digit($second)) {
                $id = (int) $second;
                $st = db()->prepare('SELECT * FROM invoices WHERE id = ?');
                $st->execute([$id]);
                $inv = $st->fetch();
                if (!$inv) fail('That document no longer exists.', 404);

                if ($third === 'pdf' && $method === 'GET') {
                    require_admin();
                    require_once __DIR__ . '/docs.php';
                    $pdf = invoice_pdf($inv, cfg('lease'), cfg('site'));
                    header('Content-Type: application/pdf');
                    header('Content-Disposition: inline; filename="ligcabho-' . $inv['ref'] . '.pdf"');
                    header('Content-Length: ' . strlen($pdf));
                    echo $pdf;
                    exit;
                }

                if ($third === 'send' && $method === 'POST') {
                    $u = require_role(['owner']);
                    $bank = cfg('lease.bank');
                    $lines = '';
                    foreach ((array) json_decode($inv['items'], true) as $l) {
                        $lines .= sprintf("  %-40s %2d x R%s\n", $l['description'], $l['qty'],
                            number_format((float) $l['amount'], 2));
                    }
                    $word = $inv['kind'] === 'quote' ? 'quote' : 'invoice';
                    send_mail('Your Ligcabho ' . $word . ' ' . $inv['ref'],
                        "Hi {$inv['name']},\n\nHere is your $word {$inv['ref']}.\n\n$lines\n"
                        . 'Total: R' . number_format((float) $inv['total'], 2) . "\n"
                        . ($inv['due_on'] ? "Due by: {$inv['due_on']}\n" : '')
                        . "\nPayment details:\n"
                        . "  Bank: {$bank['bank_name']}\n  Account name: {$bank['account_name']}\n"
                        . "  Account number: {$bank['account_number']}\n  Account type: {$bank['account_type']}\n"
                        . "  Reference: {$inv['ref']}\n\n"
                        . "Please use the reference exactly as it appears, so we can match your payment.\n\n"
                        . "The $word is attached as a PDF.\n\n"
                        . cfg('site.name') . "\n" . cfg('site.phone') . "\n",
                        null, [$inv['email']],
                        ['kind' => $word . '_sent', 'to_name' => (string) $inv['name'],
                         'attach' => [['gen' => 'invoice', 'id' => $id]]]);

                    db()->prepare("UPDATE invoices SET status = 'sent', updated_at = ? WHERE id = ?")
                        ->execute([now(), $id]);
                    audit($inv['kind'] . '_sent', $inv['ref'] . ' by ' . $u['email']);
                    json_out(['ok' => true]);
                }

                if ($third === 'paid' && $method === 'POST') {
                    require_role(['owner']);
                    $b = body();
                    db()->prepare("UPDATE invoices SET status = 'paid', paid_on = ?, updated_at = ? WHERE id = ?")
                        ->execute([s($b['paid_on'] ?? date('Y-m-d'), 32), now(), $id]);
                    audit('invoice_paid', $inv['ref']);
                    json_out(['ok' => true]);
                }

                if ($method === 'PATCH' || $method === 'POST') patch_record('invoices', $id, INV_STATUSES);
                if ($method === 'DELETE') delete_record('invoices', $id);
            }
            fail('Unknown invoices route.', 404);

        /* =========================== FINANCE ========================== */
        case 'finance':
            require_admin();
            $pdo   = db();
            $today = date('Y-m-d');

            $sum = function (string $sql) use ($pdo): float {
                return (float) ($pdo->query($sql)->fetch()['t'] ?? 0);
            };
            $count = function (string $sql) use ($pdo): int {
                return (int) $pdo->query($sql)->fetch()['c'];
            };

            $outstanding = $sum("SELECT COALESCE(SUM(CAST(total AS REAL)),0) t FROM invoices
                                 WHERE kind = 'invoice' AND status = 'sent'");
            $overdue     = $sum("SELECT COALESCE(SUM(CAST(total AS REAL)),0) t FROM invoices
                                 WHERE kind = 'invoice' AND status = 'sent'
                                 AND COALESCE(due_on,'') <> '' AND due_on < '$today'");
            $refundsDue  = $sum("SELECT COALESCE(SUM(CAST(amount AS REAL)),0) t FROM refunds
                                 WHERE status IN ('new','checking','approved')");

            json_out(['ok' => true, 'finance' => [
                'outstanding'        => round($outstanding, 2),
                'outstanding_count'  => $count("SELECT COUNT(*) c FROM invoices WHERE kind = 'invoice' AND status = 'sent'"),
                'overdue'            => round($overdue, 2),
                'overdue_count'      => $count("SELECT COUNT(*) c FROM invoices WHERE kind = 'invoice' AND status = 'sent'
                                                AND COALESCE(due_on,'') <> '' AND due_on < '$today'"),
                'invoices'           => $count("SELECT COUNT(*) c FROM invoices WHERE kind = 'invoice'"),
                'quotes'             => $count("SELECT COUNT(*) c FROM invoices WHERE kind = 'quote'"),
                'paid_total'         => round($sum("SELECT COALESCE(SUM(CAST(total AS REAL)),0) t FROM invoices
                                                    WHERE kind = 'invoice' AND status = 'paid'"), 2),
                'refunds_due'        => round($refundsDue, 2),
                'refunds_open'       => $count("SELECT COUNT(*) c FROM refunds WHERE status IN ('new','checking','approved')"),
                'today'              => $today,
            ]]);


        /* ========================== MESSAGES ========================== */
        /* Email a student from the portal, and keep a record of it. */
        case 'messages':
            if ($method === 'GET' && $second === '') {
                require_admin();
                $where = [];
                $args = [];
                $q = s($_GET['q'] ?? '', 120);
                if ($q !== '') {
                    $where[] = "(COALESCE(to_email,'') LIKE ? OR COALESCE(to_name,'') LIKE ?
                                 OR COALESCE(subject,'') LIKE ? OR COALESCE(related_ref,'') LIKE ?)";
                    array_push($args, "%$q%", "%$q%", "%$q%", "%$q%");
                }
                $kind = s($_GET['related_kind'] ?? '', 32);
                $rid  = (int) ($_GET['related_id'] ?? 0);
                if ($kind !== '' && $rid > 0) {
                    $where[] = 'related_kind = ? AND related_id = ?';
                    array_push($args, $kind, $rid);
                }
                $sql = 'SELECT * FROM messages' . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
                     . ' ORDER BY id DESC LIMIT 500';
                $st = db()->prepare($sql);
                $st->execute($args);
                json_out(['ok' => true, 'items' => $st->fetchAll()]);
            }

            if ($method === 'POST' && $second === '') {
                $u = require_admin();
                $b = body();
                $f = need($b, ['to_email', 'subject', 'body']);
                if (!filter_var($f['to_email'], FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);

                $ref  = make_ref('MSG');
                $body = s($f['body'], 20000) . "\n\n--\n" . cfg('site.name') . "\n" . cfg('site.phone') . "\n"
                      . cfg('site.url') . "\n";
                $sent = send_mail(s($f['subject'], 200), $body, null, [strtolower($f['to_email'])],
                    ['kind' => 'portal_letter', 'to_name' => s($b['to_name'] ?? '', 190)]);
                $err  = $sent ? '' : mail_error();

                db()->prepare('INSERT INTO messages (ref,to_email,to_name,subject,body,related_kind,related_id,
                               related_ref,template,sent_by,status,error,created_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
                    ->execute([$ref, strtolower($f['to_email']), s($b['to_name'] ?? '', 190), s($f['subject'], 200),
                               s($f['body'], 20000), s($b['related_kind'] ?? '', 32),
                               (int) ($b['related_id'] ?? 0) ?: null, s($b['related_ref'] ?? '', 24),
                               s($b['template'] ?? '', 64), $u['email'], $sent ? 'sent' : 'failed',
                               s($err, 255), now()]);

                audit('message_sent', $ref . ' to ' . $f['to_email'] . ($sent ? '' : ' (FAILED)'));

                if (!$sent) {
                    json_out(['ok' => true, 'ref' => $ref, 'sent' => false, 'error' => $err,
                        'message' => 'Saved, but the server would not send it: ' . $err], 200);
                }
                json_out(['ok' => true, 'ref' => $ref, 'sent' => true, 'message' => 'Sent to ' . $f['to_email'] . '.']);
            }

            /* The same message to a list of people, one at a time. */
            if ($method === 'POST' && $second === 'bulk') {
                $u = require_role(['owner']);
                $b = body();
                $f = need($b, ['subject', 'body']);
                $people = (array) ($b['recipients'] ?? []);
                if (!$people) fail('Nobody to send to.', 422);
                if (count($people) > 500) fail('That is more than 500 recipients. Split it up.', 422);

                $ins = db()->prepare('INSERT INTO messages (ref,to_email,to_name,subject,body,related_kind,
                                      template,sent_by,status,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
                $sent = 0;
                $failed = 0;
                $lastErr = '';
                foreach ($people as $p) {
                    $email = strtolower(s(is_array($p) ? ($p['email'] ?? '') : $p, 190));
                    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) continue;
                    $name = s(is_array($p) ? ($p['name'] ?? '') : '', 190);

                    /* {first_name} in the body becomes their name. */
                    $body = str_replace(['{first_name}', '{name}'],
                        [explode(' ', trim($name))[0] ?: 'there', $name ?: 'there'], s($f['body'], 20000));
                    $body .= "\n\n--\n" . cfg('site.name') . "\n" . cfg('site.phone') . "\n" . cfg('site.url') . "\n";

                    $ok = send_mail(s($f['subject'], 200), $body, null, [$email],
                        ['kind' => 'portal_group', 'to_name' => $name]);
                    if ($ok) $sent++; else { $failed++; $lastErr = mail_error(); }

                    $ins->execute([make_ref('MSG'), $email, $name, s($f['subject'], 200), s($f['body'], 20000),
                                   s($b['related_kind'] ?? 'bulk', 32), s($b['template'] ?? '', 64), $u['email'],
                                   $ok ? 'sent' : 'failed', $ok ? '' : s(mail_error(), 255), now()]);
                }
                audit('bulk_message', $sent . ' sent, ' . $failed . ' failed, by ' . $u['email']);
                json_out(['ok' => true, 'sent' => $sent, 'failed' => $failed, 'error' => $lastErr,
                    'message' => $failed
                        ? $sent . ' sent, ' . $failed . ' failed. ' . $lastErr
                        : $sent . ' sent.']);
            }

            if (ctype_digit($second) && $method === 'DELETE') delete_record('messages', (int) $second);
            fail('Unknown messages route.', 404);

        /* ====================== EMAIL: TEST & LOG ===================== */
        /* Proves whether this server can actually deliver email. */
        case 'mail-test':
            $u = require_admin();
            if ($method === 'POST') {
                $b = body();
                $to = strtolower(s($b['to'] ?? $u['email'], 190));
                if (!filter_var($to, FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                $ok = deliver_mail([
                    'to' => $to, 'to_name' => $u['name'], 'kind' => 'test',
                    'subject' => 'Ligcabho mail test',
                    'text' => "This is a test from the Ligcabho admin portal.\n\n"
                        . "If you are reading it, the website can send email: application confirmations, "
                        . "leases, invoices and the letters you write from the portal will all reach people.\n\n"
                        . 'Sent ' . now() . " by {$u['email']}, over "
                        . (mail_transport() === 'smtp' ? 'SMTP (' . mcfg('smtp.host') . ')' : "the host's own mail server")
                        . ".\n",
                ]);
                audit('mail_test', $to . ($ok ? ' ok' : ' FAILED'));
                json_out(['ok' => true, 'sent' => $ok, 'error' => $ok ? '' : mail_error(),
                    'message' => $ok
                        ? 'Sent. Check ' . $to . ', including the spam folder.'
                        : 'It would not send. ' . mail_error()]);
            }
            json_out(['ok' => true, 'config' => [
                'enabled'      => (bool) mcfg('enabled'),
                'transport'    => mail_transport(),
                'smtp_host'    => (string) mcfg('smtp.host'),
                'from'         => mcfg('from'),
                'from_name'    => mcfg('from_name'),
                'office_to'    => (array) mcfg('to'),
                'confirmations' => (bool) mcfg('send_applicant_confirmation'),
                'php_mail'     => function_exists('mail'),
                'sendmail_path' => (string) ini_get('sendmail_path'),
            ]]);

        /* Everything ever emailed to one person, in one list.
         *
         * Letters written in the portal live in `messages`; the automatic ones
         * (application confirmations, lease links, invoices, maintenance
         * tickets) live in `mail_log`. A record's correspondence is both, in
         * date order, so opening an application shows what that applicant has
         * actually been told and when. */
        case 'correspondence':
            require_admin();
            $email = strtolower(s($_GET['email'] ?? '', 190));
            $kind  = s($_GET['related_kind'] ?? '', 32);
            $rid   = (int) ($_GET['related_id'] ?? 0);
            if ($email === '' && !($kind !== '' && $rid > 0)) {
                json_out(['ok' => true, 'items' => []]);
            }

            $items = [];

            /* Letters somebody in the office wrote. */
            $where = [];
            $args  = [];
            if ($email !== '') { $where[] = 'LOWER(to_email) = ?'; $args[] = $email; }
            if ($kind !== '' && $rid > 0) {
                $where[] = '(related_kind = ? AND related_id = ?)';
                array_push($args, $kind, $rid);
            }
            $st = db()->prepare('SELECT id,ref,to_email,to_name,subject,body,template,sent_by,status,error,
                                 related_ref,created_at FROM messages WHERE ' . implode(' OR ', $where)
                               . ' ORDER BY id DESC LIMIT 100');
            $st->execute($args);
            foreach ($st->fetchAll() as $r) {
                $items[] = [
                    'source' => 'letter', 'id' => (int) $r['id'], 'ref' => $r['ref'],
                    'to_email' => $r['to_email'], 'to_name' => $r['to_name'],
                    'subject' => $r['subject'], 'body' => $r['body'],
                    'kind' => $r['template'] ?: 'written by hand',
                    'by' => $r['sent_by'], 'status' => $r['status'], 'error' => $r['error'],
                    'created_at' => $r['created_at'],
                ];
            }

            /* And everything the site sent by itself. */
            if ($email !== '') {
                /* A letter written in the portal is written down twice: once as
                   the letter, once as the delivery. Show it once. */
                $st = db()->prepare("SELECT id,ref,kind,to_email,to_name,subject,body,status,error,attempts,
                                     transport,created_at,sent_at FROM mail_log
                                     WHERE LOWER(to_email) = ?
                                       AND COALESCE(kind,'') NOT IN ('portal_letter','portal_group')
                                     ORDER BY id DESC LIMIT 100");
                $st->execute([$email]);
                foreach ($st->fetchAll() as $r) {
                    $items[] = [
                        'source' => 'automatic', 'id' => (int) $r['id'], 'ref' => $r['ref'],
                        'to_email' => $r['to_email'], 'to_name' => $r['to_name'],
                        'subject' => $r['subject'], 'body' => $r['body'],
                        'kind' => str_replace('_', ' ', (string) $r['kind']) ?: 'the website',
                        'by' => 'the website', 'status' => $r['status'], 'error' => $r['error'],
                        'created_at' => $r['created_at'],
                    ];
                }
            }

            usort($items, function ($a, $b) { return strcmp($b['created_at'], $a['created_at']); });
            $sent = 0;
            $failed = 0;
            foreach ($items as $i) {
                if ($i['status'] === 'sent') $sent++; else $failed++;
            }
            json_out(['ok' => true, 'items' => array_slice($items, 0, 60),
                      'counts' => ['sent' => $sent, 'failed' => $failed]]);

        /* Every email the site has tried to send, and a way to try again. */
        case 'mail-log':
            require_admin();
            if ($method === 'GET' && $second === '') {
                $where = [];
                $args  = [];
                $st = s($_GET['status'] ?? '', 16);
                if ($st !== '') { $where[] = 'status = ?'; $args[] = $st; }
                $q = s($_GET['q'] ?? '', 120);
                if ($q !== '') {
                    $where[] = "(COALESCE(to_email,'') LIKE ? OR COALESCE(to_name,'') LIKE ?
                                 OR COALESCE(subject,'') LIKE ? OR COALESCE(kind,'') LIKE ?)";
                    array_push($args, "%$q%", "%$q%", "%$q%", "%$q%");
                }
                $sql = "SELECT id,ref,kind,to_email,to_name,subject,transport,status,error,attempts,
                               created_at,sent_at FROM mail_log"
                     . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
                     . ' ORDER BY id DESC LIMIT 400';
                $list = db()->prepare($sql);
                $list->execute($args);

                $counts = ['sent' => 0, 'failed' => 0];
                foreach (db()->query('SELECT status, COUNT(*) c FROM mail_log GROUP BY status') as $r) {
                    $counts[$r['status']] = (int) $r['c'];
                }
                json_out(['ok' => true, 'items' => $list->fetchAll(), 'counts' => $counts]);
            }

            if ($method === 'POST' && $second === 'retry-failed') {
                $u = require_role(['owner']);
                $ids = db()->prepare('SELECT id FROM mail_log WHERE status = ? ORDER BY id LIMIT 200');
                $ids->execute(['failed']);
                $sent = 0;
                $still = 0;
                foreach ($ids->fetchAll(PDO::FETCH_COLUMN) as $id) {
                    if (mail_retry((int) $id)) $sent++; else $still++;
                }
                audit('mail_retry_all', $sent . ' sent, ' . $still . ' still failing, by ' . $u['email']);
                json_out(['ok' => true, 'sent' => $sent, 'failed' => $still,
                    'message' => $still ? $sent . ' went out, ' . $still . ' still will not send. ' . mail_error()
                                        : ($sent ? $sent . ' went out.' : 'Nothing was waiting.')]);
            }

            if (ctype_digit($second) && $third === 'retry' && $method === 'POST') {
                $u = require_admin();
                $ok = mail_retry((int) $second);
                audit('mail_retry', 'mail_log#' . $second . ($ok ? ' ok' : ' FAILED') . ' by ' . $u['email']);
                json_out(['ok' => true, 'sent' => $ok, 'error' => $ok ? '' : mail_error(),
                    'message' => $ok ? 'Sent.' : 'It would not send. ' . mail_error()]);
            }

            if (ctype_digit($second) && $method === 'DELETE') delete_record('mail_log', (int) $second);
            fail('Unknown mail-log route.', 404);

        /* The SMTP details, so the office can set email up themselves. */
        case 'mail-settings':
            $u = require_role(['owner']);
            if ($method === 'POST') {
                $b = body();
                $from = strtolower(s($b['from'] ?? '', 190));
                if (!filter_var($from, FILTER_VALIDATE_EMAIL)) fail('The "from" address is not a valid email address.', 422);

                $office = [];
                foreach (preg_split('/[\s,;]+/', (string) ($b['office_to'] ?? '')) as $addr) {
                    $addr = strtolower(trim($addr));
                    if (filter_var($addr, FILTER_VALIDATE_EMAIL)) $office[] = $addr;
                }
                if (!$office) fail('Give at least one office address to copy submissions to.', 422);

                $transport = in_array($b['transport'] ?? '', ['auto', 'smtp', 'php'], true) ? $b['transport'] : 'auto';
                $security  = in_array($b['security'] ?? '', ['tls', 'ssl', 'none'], true) ? $b['security'] : 'tls';

                /* An empty password field means "leave the saved one alone",
                   so the page never has to send it back to the browser. */
                $pass = (string) ($b['password'] ?? '');
                if ($pass === '') $pass = (string) mcfg('smtp.password');

                $saved = [
                    'enabled'   => !empty($b['enabled']),
                    'transport' => $transport,
                    'to'        => $office,
                    'from'      => $from,
                    'from_name' => s($b['from_name'] ?? '', 120) ?: cfg('mail.from_name'),
                    'reply_to'  => filter_var($b['reply_to'] ?? '', FILTER_VALIDATE_EMAIL) ? strtolower($b['reply_to']) : $from,
                    'send_applicant_confirmation' => !empty($b['confirmations']),
                    'smtp' => [
                        'host'     => s($b['host'] ?? '', 190),
                        'port'     => (int) ($b['port'] ?? 587) ?: 587,
                        'security' => $security,
                        'username' => s($b['username'] ?? '', 190),
                        'password' => $pass,
                        'verify'   => !empty($b['verify']),
                        'timeout'  => 20,
                        'helo'     => '',
                    ],
                ];

                $json = json_encode($saved);
                $exists = db()->query("SELECT COUNT(*) FROM settings WHERE k = 'mail'")->fetchColumn();
                if ($exists) {
                    db()->prepare("UPDATE settings SET v = ?, updated_by = ?, updated_at = ? WHERE k = 'mail'")
                        ->execute([$json, $u['email'], now()]);
                } else {
                    db()->prepare("INSERT INTO settings (k,v,updated_by,updated_at) VALUES ('mail',?,?,?)")
                        ->execute([$json, $u['email'], now()]);
                }
                mail_settings(true);
                audit('mail_settings', 'updated by ' . $u['email']);
                json_out(['ok' => true, 'message' => 'Saved. Send a test to make sure it works.']);
            }

            /* The password is never sent back, only whether one is set. */
            json_out(['ok' => true, 'settings' => [
                'enabled'      => (bool) mcfg('enabled'),
                'transport'    => (string) (mcfg('transport') ?: 'auto'),
                'resolved'     => mail_transport(),
                'from'         => (string) mcfg('from'),
                'from_name'    => (string) mcfg('from_name'),
                'reply_to'     => (string) mcfg('reply_to'),
                'office_to'    => implode(', ', (array) mcfg('to')),
                'confirmations' => (bool) mcfg('send_applicant_confirmation'),
                'host'         => (string) mcfg('smtp.host'),
                'port'         => (int) (mcfg('smtp.port') ?: 587),
                'security'     => (string) (mcfg('smtp.security') ?: 'tls'),
                'username'     => (string) mcfg('smtp.username'),
                'has_password' => ((string) mcfg('smtp.password')) !== '',
                'verify'       => mcfg('smtp.verify') === null ? true : (bool) mcfg('smtp.verify'),
                'php_mail'     => function_exists('mail'),
            ]]);

        /* =========================== FILES ============================ */
        case 'files':
            require_admin();
            $name = basename($second);
            $path = rtrim((string) cfg('uploads.dir'), '/') . '/' . $name;
            if ($name === '' || !is_file($path)) fail('That file is no longer on the server.', 404);
            $types = ['pdf' => 'application/pdf', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
                      'png' => 'image/png', 'webp' => 'image/webp', 'doc' => 'application/msword',
                      'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
            $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
            header('Content-Disposition: inline; filename="' . $name . '"');
            header('Content-Length: ' . filesize($path));
            header('X-Content-Type-Options: nosniff');
            readfile($path);
            exit;

        /* ============================ USERS =========================== */
        case 'users':
            if ($method === 'GET' && $second === '') {
                require_role(['owner']);
                json_out(['ok' => true, 'items' => db()->query('SELECT id,email,name,role,active,
                    must_change_password,last_login_at,created_at FROM users ORDER BY id')->fetchAll()]);
            }
            if ($method === 'POST' && $second === '') {
                $me = require_role(['owner']);
                $b  = body();
                $f  = need($b, ['name', 'email', 'role']);
                $email = strtolower($f['email']);
                if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('That email address is not valid.', 422);
                if (!in_array($f['role'], ['owner', 'manager', 'staff'], true)) fail('Choose a valid role.', 422);
                try {
                    db()->prepare('INSERT INTO users (email,name,password_hash,role,active,must_change_password,created_at)
                                   VALUES (?,?,?,?,1,1,?)')
                        ->execute([$email, $f['name'],
                                   password_hash(cfg('staff.temporary_password'), PASSWORD_DEFAULT), $f['role'], now()]);
                } catch (Throwable $e) {
                    fail('That email address already has an account.', 409);
                }
                audit('user_created', $email . ' by ' . $me['email']);
                json_out(['ok' => true, 'message' => 'Added on the shared temporary password. They must change it at first sign-in.']);
            }
            if (ctype_digit($second)) {
                $me = require_role(['owner']);
                $id = (int) $second;

                if ($third === 'reset' && $method === 'POST') {
                    db()->prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
                        ->execute([password_hash(cfg('staff.temporary_password'), PASSWORD_DEFAULT), $id]);
                    audit('user_password_reset', 'user#' . $id . ' by ' . $me['email']);
                    json_out(['ok' => true]);
                }
                if ($method === 'PATCH' || $method === 'POST') {
                    $b = body();
                    $set = [];
                    $args = [];
                    if (isset($b['role'])) {
                        if (!in_array($b['role'], ['owner', 'manager', 'staff'], true)) fail('Choose a valid role.', 422);
                        if ($id === (int) $me['id']) fail('You cannot change your own role.', 422);
                        $set[] = 'role = ?';
                        $args[] = $b['role'];
                    }
                    if (isset($b['active'])) {
                        if ($id === (int) $me['id']) fail('You cannot deactivate your own account.', 422);
                        $set[] = 'active = ?';
                        $args[] = ((int) $b['active']) === 1 ? 1 : 0;
                    }
                    if (isset($b['name'])) { $set[] = 'name = ?'; $args[] = s($b['name'], 190); }
                    if (!$set) fail('Nothing to update.', 422);
                    $args[] = $id;
                    db()->prepare('UPDATE users SET ' . implode(', ', $set) . ' WHERE id = ?')->execute($args);
                    audit('user_updated', 'user#' . $id . ' by ' . $me['email']);
                    json_out(['ok' => true]);
                }
                if ($method === 'DELETE') {
                    if ($id === (int) $me['id']) fail('You cannot delete your own account.', 422);
                    db()->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
                    audit('user_deleted', 'user#' . $id . ' by ' . $me['email']);
                    json_out(['ok' => true]);
                }
            }
            fail('Unknown users route.', 404);

        /* ============================ AUDIT =========================== */
        case 'audit':
            require_role(['owner']);
            json_out(['ok' => true, 'items' => db()->query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500')->fetchAll()]);

        /* =========================== STATS ============================ */
        case 'stats':
            require_admin();
            $pdo = db();
            $one = function (string $sql) use ($pdo): int {
                return (int) $pdo->query($sql)->fetch()['c'];
            };
            $week = "'" . gmdate('Y-m-d\TH:i:s\Z', time() - 7 * 86400) . "'";

            $byStatus = [];
            foreach ($pdo->query('SELECT status, COUNT(*) c FROM applications GROUP BY status') as $r) {
                $byStatus[$r['status']] = (int) $r['c'];
            }

            /* Occupancy: placed applications against each residence's capacity. */
            $placed = [];
            foreach ($pdo->query("SELECT residence, COUNT(*) c FROM applications
                                  WHERE status IN ('accepted','placed') AND COALESCE(residence,'') <> ''
                                  GROUP BY residence") as $r) {
                $placed[$r['residence']] = (int) $r['c'];
            }
            $occupancy = [];
            foreach ($pdo->query('SELECT name, capacity, status FROM residences ORDER BY name') as $r) {
                $occupancy[] = [
                    'residence' => $r['name'],
                    'capacity'  => (int) $r['capacity'],
                    'placed'    => $placed[$r['name']] ?? 0,
                    'status'    => $r['status'],
                ];
            }

            json_out(['ok' => true, 'stats' => [
                'applications'       => $one('SELECT COUNT(*) c FROM applications'),
                'applications_new'   => $one("SELECT COUNT(*) c FROM applications WHERE status = 'new'"),
                'applications_week'  => $one("SELECT COUNT(*) c FROM applications WHERE created_at >= $week"),
                'applications_chat'  => $one("SELECT COUNT(*) c FROM applications WHERE source = 'chat'"),
                'enquiries_open'     => $one("SELECT COUNT(*) c FROM enquiries WHERE status IN ('new','in_progress')"),
                'maintenance_open'   => $one("SELECT COUNT(*) c FROM maintenance WHERE status IN ('logged','assigned','in_progress')"),
                'leases_awaiting'    => $one("SELECT COUNT(*) c FROM leases WHERE status = 'sent'"),
                'leases_signed'      => $one("SELECT COUNT(*) c FROM leases WHERE status IN ('signed','countersigned')"),
                'orders'             => $one('SELECT COUNT(*) c FROM orders'),
                'job_applications'   => $one("SELECT COUNT(*) c FROM job_applications WHERE status = 'new'"),
                'subscribers'        => $one('SELECT COUNT(*) c FROM subscribers'),
                'chats'              => $one('SELECT COUNT(*) c FROM chat_sessions'),
                'returning'          => $one("SELECT COUNT(*) c FROM retentions WHERE coming_back = 'yes'"),
                'leaving'            => $one("SELECT COUNT(*) c FROM retentions WHERE coming_back = 'no'"),
                'beds'               => $one('SELECT COALESCE(SUM(capacity),0) c FROM residences'),
                'by_status'          => $byStatus,
                'occupancy'          => $occupancy,
                'by_funder'          => $pdo->query("SELECT COALESCE(NULLIF(funder,''),'Not stated') AS funder,
                                                     COUNT(*) c FROM applications GROUP BY funder ORDER BY c DESC")->fetchAll(),
                'recent'             => $pdo->query('SELECT ref,first_name,last_name,residence,status,source,created_at
                                                     FROM applications ORDER BY id DESC LIMIT 8')->fetchAll(),
            ]]);

        /* =========================== HEALTH =========================== */
        case 'health':
            json_out(['ok' => true, 'php' => PHP_VERSION, 'db' => cfg('db.driver'), 'time' => now()]);
    }

    fail('Unknown endpoint.', 404);
} catch (Throwable $e) {
    error_log('[ligcabho-api] ' . $e->getMessage());
    fail('Something went wrong on the server. Please try again.', 500);
}
