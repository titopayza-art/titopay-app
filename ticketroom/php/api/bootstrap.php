<?php
// TicketRoom PHP edition: start-up. api/index.php (every /api/ request) and
// the scripts at the site root include this.
declare(strict_types=1);

define('TR_APP', __DIR__);            // public_html/api
define('TR_ROOT', dirname(__DIR__));  // public_html
define('TR_VERSION', '1.1.0');
require TR_APP . '/lib/core.php';
require TR_APP . '/lib/site.php';
require TR_APP . '/lib/messaging.php';
require TR_APP . '/lib/domain.php';
require TR_APP . '/lib/qr.php';

// The data folder holds everything the site creates for itself: the
// database, uploaded posters, the signing keys and your own settings. It goes
// next to public_html, in "ticketroom-data", where the web server cannot reach
// it at all. Only if the host does not allow a folder there does it use
// public_html/data, which .htaccess locks. A site that already has its data
// in one of these places (or in tr-data from an earlier package) keeps it there.
function tr_data_dir(): string
{
    static $dir = null;
    if ($dir) return $dir;
    $outside = dirname(TR_ROOT) . '/ticketroom-data';
    $inside = TR_ROOT . '/data';
    foreach ([$outside, TR_ROOT . '/tr-data', $inside] as $d) {
        if (is_file("$d/.installed") || (is_file("$d/config.php") && is_file("$d/ticketroom.sqlite"))) return $dir = $d;
    }
    if ((is_dir($outside) || @mkdir($outside, 0750)) && is_writable($outside)) return $dir = $outside;
    return $dir = $inside;
}

function tr_load(): void
{
    date_default_timezone_set('UTC');
    $dir = tr_data_dir();
    $GLOBALS['TR_DATA_DIR'] = $dir;
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) throw new RuntimeException("Cannot create the data folder $dir. Set public_html to permission 755.");
    tr_lock_folder($dir);
    $cfg = require TR_APP . '/config.php';
    if (!is_file("$dir/config.php")) tr_write_local_config($dir);
    $mine = require "$dir/config.php";
    if (is_array($mine)) $cfg = array_replace_recursive($cfg, $mine);
    if (empty($cfg['keys']['qr'])) $cfg['keys'] = tr_keys($dir);
    $GLOBALS['TR_CONFIG'] = $cfg;
    if (!is_file("$dir/.installed")) tr_install($dir);
    tr_upgrade();
}

// Belt and braces: the root .htaccess blocks /data/ too, but this lock is
// recreated even if an upload skipped the hidden files.
function tr_lock_folder(string $dir): void
{
    if (!is_file("$dir/.htaccess")) @file_put_contents("$dir/.htaccess", "# Private: database, keys and uploads. Never served.\nRequire all denied\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
    if (!is_file("$dir/index.html")) @file_put_contents("$dir/index.html", '');
    if (!is_dir("$dir/uploads")) @mkdir("$dir/uploads", 0755);
}

// The keys that sign ticket QR codes and email links. Made once; losing them
// makes every ticket already issued unreadable at the gate.
function tr_keys(string $dir): array
{
    $file = "$dir/keys.php";
    if (is_file($file)) return require $file;
    $keys = ['qr' => bin2hex(random_bytes(32)), 'links' => bin2hex(random_bytes(32)), 'data' => bin2hex(random_bytes(32))];
    $php = "<?php\n// TicketRoom signing keys, made when the site was first opened.\n// Never edit or delete: every ticket QR code depends on them. Back up the data folder.\nreturn " . var_export($keys, true) . ";\n";
    $tmp = "$file." . bin2hex(random_bytes(4));
    file_put_contents($tmp, $php, LOCK_EX);
    // Two first visits at the same moment: whoever renames first wins, and
    // the other uses that file.
    if (!is_file($file)) @rename($tmp, $file); else @unlink($tmp);
    @chmod($file, 0600);
    return require $file;
}

function tr_write_local_config(string $dir): void
{
    $php = <<<'PHP'
<?php
/**
 * Your TicketRoom settings. Uploading a new version of the site never
 * touches this file. Anything here overrides the defaults in api/config.php.
 *
 * EMAIL: tickets, confirmations and password resets go out from
 * hello@ticketroom.co.za. Until a mailbox password is filled in below, the
 * hosting server's built-in mail is used, which often lands in spam.
 *   1. cPanel → Email Accounts: make sure hello@ticketroom.co.za exists.
 *   2. Put its password between the quotes on the smtpPass line and save.
 * For big events (thousands of tickets) use an email relay such as Amazon
 * SES, Mailgun or Brevo instead: put its server, port, username and password
 * in the four smtp lines.
 */
return [
    'mail' => [
        'smtpHost' => 'mail.ticketroom.co.za',
        'smtpPort' => 465,
        'smtpUser' => 'hello@ticketroom.co.za',
        'smtpPass' => '',
    ],

    // Optional: an Anthropic API key lets the website assistant answer in
    // its own words. Without one it answers from the help articles.
    'anthropicApiKey' => '',
];
PHP;
    $file = "$dir/config.php";
    $tmp = "$file." . bin2hex(random_bytes(4));
    file_put_contents($tmp, $php . "\n", LOCK_EX);
    if (!is_file($file)) @rename($tmp, $file); else @unlink($tmp);
    @chmod($file, 0600);
}

// First visit: create the database and the administrator from api/config.php.
// A lock makes sure only one request does it.
function tr_install(string $dir): void
{
    $lock = fopen("$dir/.install-lock", 'c');
    flock($lock, LOCK_EX);
    try {
        clearstatcache();
        if (is_file("$dir/.installed")) return;
        // An earlier package's database: keep it as it is.
        if (val("SELECT 1 FROM sqlite_master WHERE name = 'meta'")) { file_put_contents("$dir/.installed", now_iso()); return; }
        $hash = (string) cfg('admin.passwordHash', '');
        if (!str_starts_with($hash, '$2y$') && !str_starts_with($hash, '$argon2')) throw new RuntimeException('api/config.php has no admin password. Upload the complete TicketRoom package.');
        tx(fn() => tr_install_db($hash));
        file_put_contents("$dir/.installed", now_iso());
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
function tr_install_db(string $hash): void
{
    db()->exec((string) file_get_contents(TR_APP . '/schema.sql'));
    q('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema_version', (string) SCHEMA_VERSION]);
    $email = strtolower((string) cfg('admin.email', 'hello@ticketroom.co.za'));
    $uid = uuid();
    $now = now_iso();
    insert('users', ['id' => $uid, 'email' => $email, 'full_name' => (string) cfg('admin.name', 'TicketRoom Admin'), 'password_hash' => $hash, 'status' => 'active', 'email_verified_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
    foreach (['admin', 'finance', 'support'] as $role) insert('platform_roles', ['user_id' => $uid, 'role' => $role, 'granted_at' => $now]);
    q('INSERT INTO meta (key, value) VALUES (?, ?)', ["temp_password:$uid", $now]);
    kb_ensure_defaults();
    audit('system.installed', ['actor' => ['id' => $uid, 'primaryRole' => 'admin'], 'details' => ['version' => TR_VERSION]]);
}

// Database upgrades for sites installed with an earlier zip. Each step runs
// once; new installs get everything from schema.sql and skip them all.
const SCHEMA_VERSION = 5;
const UPGRADES = [
    2 => [
        'CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id)',
        'CREATE INDEX IF NOT EXISTS orders_event_created_idx ON orders (event_id, created_at)',
        'CREATE INDEX IF NOT EXISTS admission_scanner_idx ON admission_log (event_id, scanned_by)',
        'CREATE INDEX IF NOT EXISTS support_cases_status_idx ON support_cases (status, due_at)',
        'CREATE INDEX IF NOT EXISTS message_outbox_user_idx ON message_outbox (user_id)',
        'CREATE INDEX IF NOT EXISTS ticket_transfers_to_idx ON ticket_transfers (to_email, status)',
        'CREATE INDEX IF NOT EXISTS tickets_event_updated_idx ON tickets (event_id, updated_at)',
    ],
    // The company registration number has no K prefix.
    3 => [
        "UPDATE site_settings SET value = replace(value, '\"K2026811077\"', '\"2026811077\"') WHERE key = 'legal'",
    ],
    // Subscribe to TicketRoom updates.
    4 => [
        'CREATE TABLE IF NOT EXISTS newsletter_subscribers ( id TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN (\'pending\',\'subscribed\',\'unsubscribed\')), source TEXT NOT NULL DEFAULT \'web\', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT, unsubscribed_at TEXT )',
        'CREATE UNIQUE INDEX IF NOT EXISTS newsletter_email_uq ON newsletter_subscribers (lower(email))',
        'CREATE INDEX IF NOT EXISTS newsletter_status_idx ON newsletter_subscribers (status)',
        'CREATE TABLE IF NOT EXISTS newsletter_issues ( id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, recipients INTEGER NOT NULL, sent_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL )',
    ],
    // Liked events.
    5 => [
        'CREATE TABLE IF NOT EXISTS event_likes ( user_id TEXT NOT NULL REFERENCES users(id), event_id TEXT NOT NULL REFERENCES events(id), created_at TEXT NOT NULL, PRIMARY KEY (user_id, event_id) )',
        'CREATE INDEX IF NOT EXISTS event_likes_event_idx ON event_likes (event_id)',
    ],
];
function tr_upgrade(): void
{
    $have = (int) (val("SELECT value FROM meta WHERE key = 'schema_version'") ?? 1);
    if ($have >= SCHEMA_VERSION) return;
    tx(function () {
        $have = (int) (val("SELECT value FROM meta WHERE key = 'schema_version'") ?? 1);
        foreach (UPGRADES as $v => $steps) {
            if ($v <= $have) continue;
            foreach ($steps as $sql) db()->exec($sql);
            q("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [(string) $v]);
        }
    });
}

function tr_error_response(Throwable $e): Response
{
    if ($e instanceof AppError) return json_out(['error' => ['code' => $e->errCode, 'message' => $e->getMessage(), 'details' => $e->details]], $e->status);
    if ($e instanceof PDOException) {
        $m = $e->getMessage();
        if (str_contains($m, 'UNIQUE')) return json_out(['error' => ['code' => 'duplicate', 'message' => 'That already exists.']], 409);
        if (str_contains($m, 'free event must cost R0')) return json_out(['error' => ['code' => 'free_event', 'message' => 'This is a free event, so every ticket type costs R0.']], 409);
        if (str_contains($m, 'CHECK') || str_contains($m, 'FOREIGN KEY') || str_contains($m, 'append-only')) return json_out(['error' => ['code' => 'constraint', 'message' => 'That change is not allowed in the current state.']], 409);
        if (str_contains($m, 'database is locked')) return json_out(['error' => ['code' => 'busy', 'message' => 'The server is busy. Please try again.']], 503);
    }
    $rid = bin2hex(random_bytes(6));
    error_log("[ticketroom] $rid " . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    return json_out(['error' => ['code' => 'server_error', 'message' => 'Something went wrong on our side.', 'requestId' => $rid]], 500);
}

// While maintenance mode is on, visitors' API calls get a 503 and the pages
// show the maintenance message (core.js). Sign-in, settings and the back
// office keep working so staff can turn it off again.
const MAINT_EXEMPT = '#^/api/(health|config|auth/|site(/|$)|admin/)#';

// ---------------------------------------------------------------- jobs
// Shared hosting has no always-on worker: due jobs run right after a response
// has been sent (and from cron.php if a cron job is set up). A row lock in
// job_runs makes sure each job runs once per interval across all workers.
function jobs(): array
{
    return [
        ['expire-orders', 60, fn() => expire_due_orders()],
        ['event-reminders', 600, fn() => send_reminders()],
        ['abandoned-checkouts', 900, fn() => send_abandoned()],
        ['complete-events', 900, fn() => q("UPDATE events SET status = 'completed', updated_at = ? WHERE status = 'published' AND ends_at < ?", [now_iso(), iso_in(-2 * 86400)])],
        ['expire-transfers', 900, fn() => q("UPDATE ticket_transfers SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", [now_iso()])],
        ['retention', 21600, function () {
            q('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?', [iso_in(-30 * 86400), iso_in(-30 * 86400)]);
            q('DELETE FROM password_resets WHERE created_at < ?', [iso_in(-7 * 86400)]);
            q('DELETE FROM rate_limits WHERE reset_at < ?', [time() - 3600]);
            q('DELETE FROM chat_messages WHERE created_at < ?', [iso_in(-90 * 86400)]);
            q("UPDATE message_outbox SET body = '[redacted]', to_address = '[redacted]' WHERE created_at < ? AND body <> '[redacted]'", [iso_in(-180 * 86400)]);
        }],
        ['deliver-outbox', 0, function () { $end = microtime(true) + 8; while (microtime(true) < $end && outbox_deliver(25) === 25); }],
    ];
}
function run_due_jobs(bool $force = false): array
{
    $ran = [];
    $last = [];
    foreach (rows('SELECT name, last_run FROM job_runs') as $r) $last[$r['name']] = (int) $r['last_run'];
    foreach (jobs() as [$name, $every, $fn]) {
        $now = time();
        // Email goes out within ~2 seconds of being queued, but only one worker
        // at a time sends it, so a booking rush is not slowed down by email.
        $every = $name === 'deliver-outbox' ? (empty($GLOBALS['TR_OUTBOX_DIRTY']) ? 30 : 2) : max($every, 5);
        if (!$force) {
            if (($last[$name] ?? 0) > $now - $every) continue;
            $claimed = tx(function () use ($name, $every, $now) {
                q('INSERT OR IGNORE INTO job_runs (name, last_run) VALUES (?, 0)', [$name]);
                return affected('UPDATE job_runs SET last_run = ? WHERE name = ? AND last_run <= ?', [$now, $name, $now - $every]);
            });
            if (!$claimed) continue;
        }
        try { $fn(); $ran[] = $name; } catch (Throwable $e) { error_log("[ticketroom] job $name: " . $e->getMessage()); }
    }
    return $ran;
}

// ---------------------------------------------------------------- main
function tr_handle(): void
{
    $path = '/' . ltrim((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
    $path = rawurldecode($path);
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    send_security_headers();

    try {
        tr_load();
        load_session();
    } catch (Throwable $e) {
        emit(tr_error_response($e));
        return;
    }

    // Uploaded images.
    if (preg_match('#^/media/([0-9a-f-]{36})$#', $path, $m)) {
        $up = row('SELECT mime_type FROM uploads WHERE id = ?', [$m[1]]);
        $file = data_dir() . '/uploads/' . $m[1];
        if (!$up || !is_file($file)) { http_response_code(404); return; }
        header('Content-Type: ' . $up['mime_type']);
        header('Cache-Control: public, max-age=86400');
        header("Content-Security-Policy: default-src 'none'");
        readfile($file);
        return;
    }
    if (!str_starts_with($path, '/api/')) { emit(json_out(['error' => ['code' => 'not_found', 'message' => 'Not found.']], 404)); return; }

    $s = settings_all();
    if ($s['maintenance']['enabled'] && !preg_match(MAINT_EXEMPT, $path) && !(user() && user()['platformRoles'])) {
        emit(json_out(['error' => ['code' => 'maintenance', 'message' => $s['maintenance']['message']]], 503));
        return;
    }

    header('Cache-Control: no-store');
    try {
        $raw = '';
        $isUpload = str_ends_with($path, '/uploads');
        if (!$isUpload && in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            $raw = (string) file_get_contents('php://input', false, null, 0, 102401);
            if (strlen($raw) > 102400) throw new AppError(413, 'too_large', 'That request is too large.');
        }
        csrf_check($method, $path);
        $body = [];
        if ($raw !== '') {
            $body = json_decode($raw, true);
            if (!is_array($body)) throw new AppError(400, 'bad_json', 'Malformed JSON.');
        }
        $GLOBALS['TR_REQ'] = ['method' => $method, 'path' => $path, 'body' => $body];
        foreach (glob(TR_APP . '/routes/*.php') as $f) require_once $f;
        $res = dispatch($method, $path);
    } catch (Throwable $e) {
        $res = tr_error_response($e);
    }
    emit($res);

    // Respond first, then do background work.
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    elseif (function_exists('litespeed_finish_request')) litespeed_finish_request();
    try { run_due_jobs(); } catch (Throwable $e) { error_log('[ticketroom] jobs: ' . $e->getMessage()); }
}
