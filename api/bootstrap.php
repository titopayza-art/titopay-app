<?php
/**
 * Ligcabho Le'Africa Residences, database, schema, session and shared helpers.
 */
declare(strict_types=1);

const APP_REF_PREFIX = 'LIG';

require_once __DIR__ . '/mailer.php';

function cfg(?string $key = null) {
    static $cfg = null;
    if ($cfg === null) $cfg = require __DIR__ . '/config.php';
    if ($key === null) return $cfg;
    $node = $cfg;
    foreach (explode('.', $key) as $part) {
        if (!is_array($node) || !array_key_exists($part, $node)) return null;
        $node = $node[$part];
    }
    return $node;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;

    try {
        if (cfg('db.driver') === 'mysql') {
            $m = cfg('db.mysql');
            $pdo = new PDO("mysql:host={$m['host']};dbname={$m['name']};charset={$m['charset']}",
                           $m['user'], $m['pass']);
        } else {
            if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
                fail('This server has no SQLite support in PHP. In cPanel open "Select PHP Version", '
                   . 'tick pdo_sqlite and save — or switch api/config.php to MySQL.', 500);
            }
            $path = cfg('db.sqlite.path');
            $dir  = dirname($path);
            if (!is_dir($dir)) @mkdir($dir, 0775, true);
            if (!is_writable($dir)) {
                fail('The data folder is not writable. Set ' . basename($dir) . '/ to permission 755 '
                   . '(or 775) in the file manager.', 500);
            }
            $pdo = new PDO('sqlite:' . $path);
            $pdo->exec('PRAGMA journal_mode = WAL');
            $pdo->exec('PRAGMA foreign_keys = ON');
        }
    } catch (PDOException $e) {
        fail(cfg('db.driver') === 'mysql'
            ? 'The website cannot reach the MySQL database. Check the database name, user and password '
              . 'in api/config.php against what cPanel shows under MySQL Databases.'
            : 'The website cannot open its database file. Check that the data folder exists and is writable.', 500);
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    migrate($pdo);
    return $pdo;
}

/** The seventeen residences, so the portal can report occupancy per house. */
function residence_seed(): array {
    return [
        ['8 Jan Frederik', '8 Jan Frederik Street, Nelspruit', 'Nelspruit CBD', 'Tshwane University of Technology', 16, 4, 6],
        ['10 Jan Frederik', '10 Jan Frederik Street, Nelspruit', 'Nelspruit CBD', 'Tshwane University of Technology', 22, 4, 9],
        ['14 Jan Frederik', '14 Jan Frederik Street, Nelspruit', 'Nelspruit CBD', 'Tshwane University of Technology', 31, 5, 13],
        ['53 Boslorie', '53 Boslorie Street, Stonehenge Ext 1', 'Stonehenge', 'Tshwane University of Technology', 36, 2, 17],
        ['1 Silver Oak', '1 Silver Oak Street, West Acres, Mbombela', 'West Acres', 'University of Mpumalanga', 46, 16, 15],
        ['16 Sperwer Street', '16 Sperwer Street, Stonehenge', 'Stonehenge', 'Tshwane University of Technology', 35, 0, 0],
        ['20 & 22 Drysdale', 'Drysdale Street, Nelspruit', 'Nelspruit CBD', 'Private colleges', 23, 0, 0],
        ['21 Van Rooyen', '21 Van Rooyen Street, Stonehenge', 'Stonehenge', 'Tshwane University of Technology', 30, 0, 15],
        ['23 Dolomiet', '23 Dolomiet Street, West Acres', 'West Acres', 'Tshwane University of Technology', 23, 0, 0],
        ['48 Mataffin Hill', '48 Mataffin Hill (opposite Halls), Mbombela', 'Mataffin', 'TUT & University of Mpumalanga', 120, 8, 56],
        ['49 Mostert', '49 Mostert Street, Mbombela', 'Nelspruit CBD', 'Private colleges', 18, 0, 0],
        ['72 Percy Fitzpatrick', '72 Percy Fitzpatrick Drive, Stonehenge', 'Stonehenge', 'Tshwane University of Technology', 16, 0, 0],
        ['74a Percy Fitzpatrick Drive', '74a Percy Fitzpatrick Drive, Stonehenge', 'Stonehenge', 'Tshwane University of Technology', 32, 0, 0],
        ['9 Sarel Cilliers Street', '9 Sarel Cilliers Street, Sonpark, Nelspruit', 'Sonpark', 'University of Mpumalanga', 23, 0, 0],
        ['01 Penny Street', '1 Penny Street, Nelspruit', 'Nelspruit CBD', 'University of Mpumalanga', 20, 0, 0],
        ['Plot No. 80, Burger Street', 'Plot No. 80, Katoon Street, White River', 'White River', 'University of Mpumalanga', 25, 23, 1],
        ["Portion 10 Farm, Rocky's Drift", "Portion 10 Farm, Rocky's Drift, White River", 'White River', 'University of Mpumalanga', 18, 18, 0],
    ];
}

function migrate(PDO $pdo): void {
    $mysql = cfg('db.driver') === 'mysql';
    $pk    = $mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    $txt   = 'TEXT';

    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id $pk,
        email VARCHAR(190) UNIQUE NOT NULL,
        name VARCHAR(190) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'staff',
        active INT NOT NULL DEFAULT 1,
        must_change_password INT NOT NULL DEFAULT 1,
        created_at VARCHAR(32) NOT NULL,
        last_login_at VARCHAR(32)
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS residences (
        id $pk,
        name VARCHAR(190) UNIQUE NOT NULL,
        address VARCHAR(255),
        area VARCHAR(120),
        accreditation VARCHAR(190),
        capacity INT NOT NULL DEFAULT 0,
        single_rooms INT NOT NULL DEFAULT 0,
        sharing_rooms INT NOT NULL DEFAULT 0,
        single_rate VARCHAR(32),
        sharing_rate VARCHAR(32),
        deposit VARCHAR(32),
        admin_fee VARCHAR(32),
        status VARCHAR(24) NOT NULL DEFAULT 'open',
        created_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS applications (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        first_name VARCHAR(120) NOT NULL,
        last_name VARCHAR(120) NOT NULL,
        id_number VARCHAR(32) NOT NULL,
        student_number VARCHAR(64),
        gender VARCHAR(16),
        phone VARCHAR(40) NOT NULL,
        email VARCHAR(190) NOT NULL,
        level_of_study VARCHAR(64),
        institution VARCHAR(190),
        funder VARCHAR(64),
        year_applying VARCHAR(8),
        residence VARCHAR(190),
        room_type VARCHAR(40),
        notes $txt,
        pop_name VARCHAR(255),
        pop_stored VARCHAR(255),
        pop_size INT DEFAULT 0,
        source VARCHAR(24) NOT NULL DEFAULT 'form',
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        ip VARCHAR(64),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS enquiries (
        id $pk,
        kind VARCHAR(32) NOT NULL DEFAULT 'contact',
        name VARCHAR(190),
        phone VARCHAR(40),
        email VARCHAR(190),
        topic VARCHAR(120),
        residence VARCHAR(190),
        message $txt,
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS orders (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        pack VARCHAR(120) NOT NULL,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NOT NULL,
        phone VARCHAR(40),
        residence VARCHAR(190),
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS maintenance (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        residence VARCHAR(190),
        room VARCHAR(64),
        name VARCHAR(190),
        phone VARCHAR(40),
        email VARCHAR(190),
        category VARCHAR(64),
        urgency VARCHAR(32) NOT NULL DEFAULT 'standard',
        description $txt,
        status VARCHAR(24) NOT NULL DEFAULT 'logged',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS reviews (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190),
        residence VARCHAR(190),
        rating INT NOT NULL DEFAULT 5,
        title VARCHAR(190),
        body $txt,
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        published INT NOT NULL DEFAULT 0,
        reply $txt,
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS cancellations (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        lease_id INT,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NOT NULL,
        phone VARCHAR(40),
        id_number VARCHAR(32),
        student_number VARCHAR(64),
        residence VARCHAR(190),
        room VARCHAR(64),
        vacate_date VARCHAR(32),
        reason VARCHAR(120),
        detail $txt,
        forwarding_address $txt,
        refund_account $txt,
        acknowledged INT NOT NULL DEFAULT 0,
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS refunds (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        claimant VARCHAR(24) NOT NULL DEFAULT 'student',
        name VARCHAR(190) NOT NULL,
        id_number VARCHAR(32),
        email VARCHAR(190) NOT NULL,
        phone VARCHAR(40),
        residence VARCHAR(190),
        room VARCHAR(64),
        application_ref VARCHAR(24),
        reason VARCHAR(190),
        amount VARCHAR(32),
        paid_on VARCHAR(32),
        detail $txt,
        bank_name VARCHAR(120),
        account_name VARCHAR(190),
        account_number VARCHAR(64),
        branch_code VARCHAR(32),
        pop_name VARCHAR(255),
        pop_stored VARCHAR(255),
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS staff_requests (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        kind VARCHAR(40) NOT NULL DEFAULT 'leave',
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NOT NULL,
        phone VARCHAR(40),
        role VARCHAR(120),
        residence VARCHAR(190),
        start_date VARCHAR(32),
        end_date VARCHAR(32),
        days VARCHAR(16),
        amount VARCHAR(32),
        detail $txt,
        document_name VARCHAR(255),
        document_stored VARCHAR(255),
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS supply_orders (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        residence VARCHAR(190) NOT NULL,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190),
        phone VARCHAR(40),
        needed_by VARCHAR(32),
        urgency VARCHAR(32) NOT NULL DEFAULT 'standard',
        items $txt NOT NULL,
        notes $txt,
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS retentions (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        first_name VARCHAR(120) NOT NULL,
        last_name VARCHAR(120) NOT NULL,
        id_number VARCHAR(32),
        student_number VARCHAR(64),
        phone VARCHAR(40) NOT NULL,
        email VARCHAR(190) NOT NULL,
        gender VARCHAR(16),
        current_residence VARCHAR(190),
        current_room VARCHAR(64),
        months_in_residence VARCHAR(16),
        lease_end VARCHAR(32),
        account_up_to_date VARCHAR(16),
        coming_back VARCHAR(16) NOT NULL DEFAULT 'yes',
        year_applying VARCHAR(8),
        institution VARCHAR(190),
        level_of_study VARCHAR(64),
        funder VARCHAR(64),
        funding_confirmed VARCHAR(16),
        same_room VARCHAR(16),
        preferred_residence VARCHAR(190),
        room_type VARCHAR(40),
        roommate VARCHAR(190),
        move_in_date VARCHAR(32),
        rating INT,
        recommend VARCHAR(16),
        what_worked $txt,
        what_to_improve $txt,
        outstanding_maintenance $txt,
        leaving_reason VARCHAR(190),
        notes $txt,
        signed_name VARCHAR(190),
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        ip VARCHAR(64),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS messages (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        to_email VARCHAR(190) NOT NULL,
        to_name VARCHAR(190),
        subject VARCHAR(255) NOT NULL,
        body $txt NOT NULL,
        related_kind VARCHAR(32),
        related_id INT,
        related_ref VARCHAR(24),
        template VARCHAR(64),
        sent_by VARCHAR(190),
        status VARCHAR(16) NOT NULL DEFAULT 'sent',
        error VARCHAR(255),
        created_at VARCHAR(32) NOT NULL
    )");

    /* Every email this site tries to send, whether or not it got out. */
    $pdo->exec("CREATE TABLE IF NOT EXISTS mail_log (
        id $pk,
        ref VARCHAR(24) NOT NULL,
        kind VARCHAR(40),
        to_email VARCHAR(190) NOT NULL,
        to_name VARCHAR(190),
        subject VARCHAR(255) NOT NULL,
        body $txt NOT NULL,
        reply_to VARCHAR(190),
        attach $txt,
        transport VARCHAR(12),
        status VARCHAR(16) NOT NULL DEFAULT 'queued',
        error $txt,
        attempts INT NOT NULL DEFAULT 0,
        created_at VARCHAR(32) NOT NULL,
        sent_at VARCHAR(32)
    )");

    /* Settings the office can change from the portal, so they survive a
       re-upload of the code. One row per block; 'mail' is the only one
       so far, holding the SMTP details. */
    $pdo->exec("CREATE TABLE IF NOT EXISTS settings (
        k VARCHAR(40) PRIMARY KEY,
        v $txt NOT NULL,
        updated_by VARCHAR(190),
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS invoices (
        id $pk,
        ref VARCHAR(24) UNIQUE NOT NULL,
        kind VARCHAR(16) NOT NULL DEFAULT 'invoice',
        lease_id INT,
        application_id INT,
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NOT NULL,
        phone VARCHAR(40),
        residence VARCHAR(190),
        room VARCHAR(64),
        items $txt NOT NULL,
        total VARCHAR(32) NOT NULL DEFAULT '0',
        issued_on VARCHAR(32),
        due_on VARCHAR(32),
        paid_on VARCHAR(32),
        note $txt,
        status VARCHAR(24) NOT NULL DEFAULT 'draft',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS vacancies (
        id $pk,
        title VARCHAR(190) NOT NULL,
        department VARCHAR(120),
        location VARCHAR(190),
        employment_type VARCHAR(64),
        summary $txt,
        description $txt,
        requirements $txt,
        closing_date VARCHAR(32),
        status VARCHAR(24) NOT NULL DEFAULT 'open',
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS job_applications (
        id $pk,
        vacancy_id INT,
        vacancy_title VARCHAR(190),
        name VARCHAR(190) NOT NULL,
        email VARCHAR(190) NOT NULL,
        phone VARCHAR(40),
        cover_note $txt,
        cv_name VARCHAR(255),
        cv_stored VARCHAR(255),
        status VARCHAR(24) NOT NULL DEFAULT 'new',
        admin_notes $txt,
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS leases (
        id $pk,
        token VARCHAR(64) UNIQUE NOT NULL,
        application_id INT,
        tenant_name VARCHAR(120) NOT NULL,
        tenant_surname VARCHAR(120) NOT NULL,
        tenant_id_number VARCHAR(32),
        tenant_phone VARCHAR(40),
        tenant_email VARCHAR(190) NOT NULL,
        student_number VARCHAR(64),
        institution VARCHAR(190),
        course VARCHAR(190),
        year_of_study VARCHAR(40),
        residence VARCHAR(190),
        room_number VARCHAR(40),
        room_type VARCHAR(40),
        commencement_date VARCHAR(32),
        end_date VARCHAR(32),
        monthly_rent VARCHAR(32),
        admin_fee VARCHAR(32),
        deposit VARCHAR(32),
        funder VARCHAR(64),
        max_occupants INT,
        signed_at_place VARCHAR(120),
        terms_snapshot $txt,
        tenant_witness_1 VARCHAR(190),
        tenant_witness_2 VARCHAR(190),
        landlord_witness_1 VARCHAR(190),
        landlord_witness_2 VARCHAR(190),
        special_conditions $txt,
        home_address $txt,
        kin_name VARCHAR(190),
        kin_contact VARCHAR(64),
        status VARCHAR(24) NOT NULL DEFAULT 'draft',
        tenant_signature $txt,
        tenant_signed_name VARCHAR(190),
        tenant_signed_at VARCHAR(32),
        tenant_sign_ip VARCHAR(64),
        tenant_sign_agent VARCHAR(255),
        landlord_signature $txt,
        landlord_signed_name VARCHAR(190),
        landlord_signed_at VARCHAR(32),
        sent_at VARCHAR(32),
        created_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS chat_sessions (
        id $pk,
        session_key VARCHAR(64) UNIQUE NOT NULL,
        outcome VARCHAR(32) NOT NULL DEFAULT 'open',
        application_id INT,
        started_at VARCHAR(32) NOT NULL,
        updated_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS chat_messages (
        id $pk,
        session_key VARCHAR(64) NOT NULL,
        role VARCHAR(16) NOT NULL,
        text $txt NOT NULL,
        created_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS subscribers (
        id $pk,
        name VARCHAR(190),
        email VARCHAR(190) UNIQUE NOT NULL,
        created_at VARCHAR(32) NOT NULL
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
        id $pk,
        ip VARCHAR(64) NOT NULL,
        at INT NOT NULL,
        ok INT NOT NULL DEFAULT 0
    )");

    $pdo->exec("CREATE TABLE IF NOT EXISTS audit_log (
        id $pk,
        user_email VARCHAR(190),
        action VARCHAR(64),
        detail VARCHAR(255),
        at VARCHAR(32) NOT NULL
    )");

    /* Seed the staff accounts named in config.php. */
    $find = $pdo->prepare('SELECT id FROM users WHERE email = ?');
    $add  = $pdo->prepare('INSERT INTO users (email,name,password_hash,role,active,must_change_password,created_at)
                           VALUES (?,?,?,?,1,1,?)');
    foreach ((array) cfg('staff.accounts') as $a) {
        $email = strtolower($a['email']);
        $find->execute([$email]);
        if (!$find->fetch()) {
            $add->execute([$email, $a['name'],
                password_hash(cfg('staff.temporary_password'), PASSWORD_DEFAULT), $a['role'], now()]);
        }
    }

    /* Seed the residences so occupancy reporting works on a fresh install. */
    if ((int) $pdo->query('SELECT COUNT(*) c FROM residences')->fetch()['c'] === 0) {
        $st = $pdo->prepare('INSERT INTO residences (name,address,area,accreditation,capacity,single_rooms,sharing_rooms,
                             single_rate,sharing_rate,deposit,admin_fee,status,created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,\'open\',?)');
        foreach (residence_seed() as $r) {
            /* Rates start blank: the office sets them in the portal, and the
               lease form then fills itself from the rate card. */
            $st->execute([...$r, '', '', '', '', now()]);
        }
    }

    /* Seed the vacancy that is live on the site today. */
    if ((int) $pdo->query('SELECT COUNT(*) c FROM vacancies')->fetch()['c'] === 0) {
        $pdo->prepare('INSERT INTO vacancies (title,department,location,employment_type,summary,description,requirements,status,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,\'open\',?,?)')
            ->execute([
                'Administration Clerk, General', 'Property',
                "20 Van Rensburg Street, Liza's Court, Nelspruit", 'Full time',
                'General administration for the residence portfolio, based at head office.',
                "You will keep the office running day to day: student files and lease paperwork, receipting and "
                . "reconciling payments against student accounts, answering walk-in and telephone enquiries, and "
                . "supporting the residence managers with reporting.\n\nThe role suits someone organised and "
                . "unflappable who is comfortable with students, funders and paperwork in equal measure.",
                "Matric, with a relevant certificate or diploma an advantage\n"
                . "Previous administration experience, ideally in property or student housing\n"
                . "Confident with email, spreadsheets and filing systems\n"
                . "Good communication in English and at least one other local language",
                now(), now(),
            ]);
    }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function now(): string { return gmdate('Y-m-d\TH:i:s\Z'); }

function json_out($data, int $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $code = 400, array $extra = []) {
    json_out(['ok' => false, 'error' => $message] + $extra, $code);
}

function body(): array {
    $raw = file_get_contents('php://input');
    if ($raw !== '' && $raw !== false) {
        $j = json_decode($raw, true);
        if (is_array($j)) return $j;
    }
    return $_POST ?: [];
}

function s($v, int $max = 500): string {
    $v = is_scalar($v) ? (string) $v : '';
    $v = trim(preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F]/u', '', $v) ?? '');
    return mb_substr($v, 0, $max);
}

function need(array $src, array $fields): array {
    $out = [];
    $missing = [];
    foreach ($fields as $f) {
        $val = s($src[$f] ?? '');
        if ($val === '') $missing[] = $f;
        $out[$f] = $val;
    }
    if ($missing) fail('Missing required fields: ' . implode(', ', $missing), 422, ['fields' => $missing]);
    return $out;
}

function start_session(): void {
    if (session_status() === PHP_SESSION_ACTIVE) return;
    session_name(cfg('security.session_name'));
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
          || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_set_cookie_params([
        'lifetime' => cfg('security.session_lifetime'),
        'path'     => '/',
        'httponly' => true,
        'secure'   => $https,
        'samesite' => 'Lax',
    ]);
    session_start();
}

function current_user(): ?array {
    start_session();
    if (empty($_SESSION['uid'])) return null;
    $st = db()->prepare('SELECT id,email,name,role,active,must_change_password FROM users WHERE id = ?');
    $st->execute([$_SESSION['uid']]);
    $u = $st->fetch();
    if (!$u || (int) $u['active'] !== 1) return null;
    return $u;
}

/** Signed in, and past the forced password change. */
function require_admin(): array {
    $u = current_user();
    if (!$u) fail('Not signed in.', 401);
    if ((int) $u['must_change_password'] === 1) fail('Set a new password before continuing.', 403);
    return $u;
}

function require_role(array $roles): array {
    $u = require_admin();
    if (!in_array($u['role'], $roles, true)) fail('Your role does not allow that action.', 403);
    return $u;
}

function client_ip(): string {
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'cli'), 0, 64);
}

function make_ref(string $prefix = APP_REF_PREFIX): string {
    return $prefix . date('y') . strtoupper(substr(bin2hex(random_bytes(4)), 0, 6));
}

function audit(string $action, string $detail = ''): void {
    $u = current_user();
    db()->prepare('INSERT INTO audit_log (user_email,action,detail,at) VALUES (?,?,?,?)')
        ->execute([$u['email'] ?? 'public', $action, s($detail, 255), now()]);
}

/** Store an uploaded file under data/uploads with a non-guessable name. */
function store_upload(string $field, bool $required = false): array {
    if (!isset($_FILES[$field]) || ($_FILES[$field]['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        if ($required) fail("A file is required for $field.", 422);
        return ['name' => null, 'stored' => null, 'size' => 0];
    }
    $f = $_FILES[$field];
    if ($f['error'] !== UPLOAD_ERR_OK) fail('Upload failed (code ' . $f['error'] . ').', 422);
    if ($f['size'] > cfg('uploads.max_bytes')) fail('That file is too large.', 422);

    $ext = strtolower(pathinfo((string) $f['name'], PATHINFO_EXTENSION));
    if (!in_array($ext, cfg('uploads.allowed'), true)) {
        fail('That file type is not accepted. Use PDF, JPG, PNG, DOC or DOCX.', 422);
    }
    $dir = cfg('uploads.dir');
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $stored = date('Ymd') . '-' . bin2hex(random_bytes(8)) . '.' . $ext;
    $dest   = rtrim($dir, '/') . '/' . $stored;
    $moved  = is_uploaded_file($f['tmp_name'])
        ? move_uploaded_file($f['tmp_name'], $dest)
        : rename($f['tmp_name'], $dest);      // allows tests to post synthetic files
    if (!$moved) fail('Could not save the uploaded file.', 500);
    return ['name' => s($f['name'], 255), 'stored' => $stored, 'size' => (int) $f['size']];
}

/**
 * Best-effort notification. Never blocks a submission.
 *
 * The last failure is kept in mail_error() so the portal can report what
 * actually happened instead of claiming a message was delivered.
 */
function mail_error(?string $set = null): string {
    static $last = '';
    if ($set !== null) $last = $set;
    return $last;
}

/**
 * Turn an attachment note into the actual file.
 *
 * The log keeps the note ("the PDF of lease 12"), not the bytes, so a
 * message can be sent again months later and still carry the document as
 * it stands today.
 */
function mail_files(array $specs): array {
    $out = [];
    foreach ($specs as $spec) {
        $gen = (string) ($spec['gen'] ?? '');
        $id  = (int) ($spec['id'] ?? 0);
        if ($gen === '') continue;
        require_once __DIR__ . '/docs.php';

        if ($gen === 'lease' && $id) {
            $st = db()->prepare('SELECT * FROM leases WHERE id = ?');
            $st->execute([$id]);
            $l = $st->fetch();
            if ($l) {
                $who = preg_replace('/[^A-Za-z0-9]+/', '-',
                    trim($l['tenant_name'] . ' ' . $l['tenant_surname'])) ?: 'agreement';
                $out[] = ['name' => 'Ligcabho-lease-' . trim($who, '-') . '.pdf', 'type' => 'application/pdf',
                          'data' => lease_pdf($l, cfg('lease'), cfg('site'))];
            }
        } elseif ($gen === 'invoice' && $id) {
            $st = db()->prepare('SELECT * FROM invoices WHERE id = ?');
            $st->execute([$id]);
            $inv = $st->fetch();
            if ($inv) $out[] = ['name' => strtoupper($inv['kind']) . '-' . $inv['ref'] . '.pdf',
                                'type' => 'application/pdf',
                                'data' => invoice_pdf($inv, cfg('lease'), cfg('site'))];
        } elseif ($gen === 'house_rules') {
            $out[] = ['name' => 'Ligcabho-house-rules.pdf', 'type' => 'application/pdf',
                      'data' => house_rules_pdf(cfg('site'))];
        }
    }
    return $out;
}

/**
 * Send one message to one person, and write down what happened.
 *
 * Every email the site sends comes through here, so Messages → Delivery
 * shows the lot: what went, what did not, and the server's own reason.
 * A failure is never fatal — the submission behind it is already saved.
 */
function deliver_mail(array $m): bool {
    $to = strtolower(trim((string) ($m['to'] ?? '')));
    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) {
        mail_error('No valid recipient address.');
        return false;
    }

    $ref     = (string) ($m['ref'] ?? make_ref('EM'));
    $subject = (string) ($m['subject'] ?? '');
    $text    = (string) ($m['text'] ?? '');
    $specs   = (array) ($m['attach'] ?? []);
    $err     = null;

    if (!mcfg('enabled')) {
        $err = 'Email is switched off. Turn it back on under Messages, Setup.';
        mail_error($err);
        mail_log_write($ref, $m, $to, 'off', 'failed', $err, 0);
        return false;
    }

    try {
        $files = mail_files($specs);
    } catch (Throwable $e) {
        $files = [];   /* rather send the letter without its attachment than not at all */
    }

    [$headers, $body] = mail_compose([
        'subject' => $subject, 'text' => $text,
        'reply_to' => (string) ($m['reply_to'] ?? ''), 'files' => $files,
    ]);
    $headers['__subject'] = $subject;

    $transport = mail_transport();
    $ok = $transport === 'smtp'
        ? smtp_deliver($to, (string) ($m['to_name'] ?? ''), $headers, $body, $err)
        : php_mail_deliver($to, (string) ($m['to_name'] ?? ''), $headers, $body, $err);

    mail_error($ok ? '' : (string) $err);
    mail_log_write($ref, $m, $to, $transport, $ok ? 'sent' : 'failed', (string) $err,
                   (int) ($m['attempts'] ?? 0) + 1, $m['log_id'] ?? null);
    return $ok;
}

/** One row per attempt, or an update to the row being retried. */
function mail_log_write(string $ref, array $m, string $to, string $transport,
                        string $status, string $err, int $attempts, $logId = null): void {
    try {
        if ($logId) {
            db()->prepare('UPDATE mail_log SET transport = ?, status = ?, error = ?, attempts = ?, sent_at = ?
                           WHERE id = ?')
                ->execute([$transport, $status, $err, $attempts, $status === 'sent' ? now() : null, (int) $logId]);
            return;
        }
        db()->prepare('INSERT INTO mail_log (ref,kind,to_email,to_name,subject,body,reply_to,attach,
                       transport,status,error,attempts,created_at,sent_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            ->execute([$ref, s($m['kind'] ?? '', 40), $to, s($m['to_name'] ?? '', 190),
                       s($m['subject'] ?? '', 255), (string) ($m['text'] ?? ''),
                       s($m['reply_to'] ?? '', 190),
                       empty($m['attach']) ? null : json_encode($m['attach']),
                       $transport, $status, $err, $attempts, now(),
                       $status === 'sent' ? now() : null]);
    } catch (Throwable $e) {
        /* The log is a convenience. Never let it swallow the mail itself. */
    }
}

/**
 * Send to one person or several.
 *
 * Kept to the old shape so every call site in this file still reads the
 * same way; $opts carries the extras (what kind of letter it is, who it
 * is named after, which document to attach).
 */
function send_mail(string $subject, string $bodyText, ?string $replyTo = null,
                   ?array $to = null, array $opts = []): bool {
    mail_error('');
    $list = array_filter((array) ($to ?: mcfg('to')));
    if (!$list) {
        mail_error('No valid recipient address.');
        return false;
    }
    $ok = true;
    $any = false;
    foreach ($list as $addr) {
        if (!filter_var((string) $addr, FILTER_VALIDATE_EMAIL)) continue;
        $any = true;
        $sent = deliver_mail([
            'to'       => (string) $addr,
            'to_name'  => (string) ($opts['to_name'] ?? ''),
            'subject'  => $subject,
            'text'     => $bodyText,
            'reply_to' => $replyTo ?: '',
            'kind'     => (string) ($opts['kind'] ?? ''),
            'attach'   => (array) ($opts['attach'] ?? []),
        ]);
        if (!$sent) $ok = false;
    }
    if (!$any) {
        mail_error('No valid recipient address.');
        return false;
    }
    return $ok;
}

/** Send a logged message again, rebuilding any attachment. */
function mail_retry(int $id): bool {
    $st = db()->prepare('SELECT * FROM mail_log WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if (!$row) {
        mail_error('That message is no longer in the log.');
        return false;
    }
    return deliver_mail([
        'ref' => $row['ref'], 'to' => $row['to_email'], 'to_name' => (string) $row['to_name'],
        'subject' => $row['subject'], 'text' => $row['body'], 'reply_to' => (string) $row['reply_to'],
        'kind' => (string) $row['kind'], 'attach' => json_decode((string) $row['attach'], true) ?: [],
        'attempts' => (int) $row['attempts'], 'log_id' => (int) $row['id'],
    ]);
}

/** A South African ID number: 13 digits, with the Luhn check digit. */
function valid_sa_id(string $id): bool {
    if (!preg_match('/^\d{13}$/', $id)) return false;
    $sum = 0;
    for ($i = 0; $i < 13; $i++) {
        $d = (int) $id[$i];
        if (($i % 2) === 1) {
            $d *= 2;
            if ($d > 9) $d -= 9;
        }
        $sum += $d;
    }
    return $sum % 10 === 0;
}
