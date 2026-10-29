<?php
// TicketRoom PHP edition: start-up. api/index.php (every /api/ request) and
// the scripts at the site root include this.
declare(strict_types=1);

define('TR_APP', __DIR__);            // public_html/api
define('TR_ROOT', dirname(__DIR__));  // public_html
define('TR_VERSION', '1.1.45-event-edits-footer-v6');
// Errors never reach a visitor's screen. They are written to php-errors.log in
// the private data folder (set in tr_load once that folder is known), never
// to an error_log file inside public_html.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
require TR_APP . '/lib/core.php';
require TR_APP . '/lib/site.php';
require TR_APP . '/lib/places.php';
require TR_APP . '/lib/messaging.php';
require TR_APP . '/lib/domain.php';
require TR_APP . '/lib/qr.php';
require TR_APP . '/lib/wallet.php';
require TR_APP . '/lib/integrations.php';
require TR_APP . '/lib/payments.php';
require TR_APP . '/lib/cashless.php';
require TR_APP . '/lib/cashdesk.php';
require TR_APP . '/lib/boxoffice.php';
require TR_APP . '/lib/verification.php';
require TR_APP . '/lib/promote.php';
require TR_APP . '/lib/exchange.php';
require TR_APP . '/lib/ops.php';

// The API's route files, loaded by name. A file left behind by an older
// upload (one no longer in this list) is never run. A new route file must be
// added here.
const TR_ROUTE_FILES = ['account', 'admin', 'auth', 'cashdesk', 'cashless', 'exchange', 'finance', 'google', 'ops', 'organiser', 'promote', 'public', 'retail', 'site', 'staff', 'support', 'verification'];
function tr_load_routes(): void
{
    foreach (TR_ROUTE_FILES as $f) require_once TR_APP . "/routes/$f.php";
}

// The site stops rather than guess: its data folder or its signing keys are
// missing on a site that was already installed. Visitors see a short notice;
// the reason goes to the error log and to the cron job's output.
final class TrHalt extends RuntimeException {}
function tr_halt(string $why): never
{
    error_log('[ticketroom] STOPPED: ' . $why);
    throw new TrHalt($why);
}

// The data folder holds everything the site creates for itself: the
// database, uploaded posters, the signing keys and your own settings. New
// installs use a directory next to public_html, where the web server cannot
// reach it at all. Existing legacy installs are retained in place so an
// upgrade never silently moves or loses their data; migrate them explicitly.
//
// Once installed, public_html/data/.data-home records where the data lives.
// If that folder later cannot be found (moved, renamed, unreadable), the site
// stops instead of quietly starting a new, empty one.
function tr_home_marker(): string { return TR_ROOT . '/data/.data-home'; }
function tr_installed_in(string $d): bool
{
    clearstatcache();
    return is_file("$d/.installed") || (is_file("$d/ticketroom.sqlite") && (int) @filesize("$d/ticketroom.sqlite") > 0);
}
function tr_data_dir(): string
{
    static $dir = null;
    if ($dir) return $dir;
    $outside = dirname(TR_ROOT) . '/ticketroom-data';
    $inside = TR_ROOT . '/data';
    foreach ([$outside, TR_ROOT . '/tr-data', $inside] as $d) {
        if (is_file("$d/.installed") || (is_file("$d/config.php") && is_file("$d/ticketroom.sqlite"))) return $dir = $d;
    }
    if (is_file(tr_home_marker())) {
        tr_halt('TicketRoom is installed, but its data folder (' . trim((string) @file_get_contents(tr_home_marker())) . ') cannot be found or read. Put the folder back, or fix its permissions (750 or 755). Restore it from a backup if it is lost. Only if the site was deliberately moved, delete public_html/data/.data-home.');
    }
    if ((is_dir($outside) || @mkdir($outside, 0750, true)) && is_writable($outside)) return $dir = $outside;
    throw new RuntimeException('TicketRoom requires ticketroom-data next to public_html. Do not create a new install inside the web root.');
}

function tr_load(bool $install = true): void
{
    date_default_timezone_set('UTC');
    $dir = tr_data_dir();
    $GLOBALS['TR_DATA_DIR'] = $dir;
    if (!is_dir($dir) && !@mkdir($dir, 0750, true)) throw new RuntimeException("Cannot create the private data folder $dir. Set its parent to permission 755.");
    if (is_writable($dir)) ini_set('error_log', "$dir/php-errors.log");
    $installed = tr_installed_in($dir);
    tr_lock_folder($dir);
    $cfg = require TR_APP . '/config.php';
    if (!is_file("$dir/config.php")) tr_write_local_config($dir);
    $mine = require "$dir/config.php";
    if (is_array($mine)) $cfg = array_replace_recursive($cfg, $mine);
    if (empty($cfg['keys']['qr'])) $cfg['keys'] = tr_keys($dir, $installed);
    $GLOBALS['TR_CONFIG'] = $cfg;
    if ($install && !is_file("$dir/.installed")) tr_install($dir);
    if (is_file("$dir/.installed") && !is_file(tr_home_marker()) && is_dir(TR_ROOT . '/data') && is_writable(TR_ROOT . '/data')) @file_put_contents(tr_home_marker(), $dir . "\n");
    if ($install && is_file("$dir/.installed")) tr_upgrade();
}

// Belt and braces: the root .htaccess blocks /data/ too, but this lock is
// recreated even if an upload skipped the hidden files.
function tr_lock_folder(string $dir): void
{
    if (!is_file("$dir/.htaccess")) @file_put_contents("$dir/.htaccess", "# Private: database, keys and uploads. Never served.\nRequire all denied\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
    if (!is_file("$dir/index.html")) @file_put_contents("$dir/index.html", '');
    if (!is_dir("$dir/uploads")) @mkdir("$dir/uploads", 0750);
}

// The keys that sign ticket QR codes and email links. Made once; losing them
// makes every ticket already issued unreadable at the gate. New keys are made
// only for a brand-new site: on an installed site a missing keys.php means a
// lost or half-restored data folder, so the site stops instead.
function tr_keys(string $dir, bool $installed = false): array
{
    $file = "$dir/keys.php";
    if (is_file($file)) return require $file;
    if ($installed) tr_halt('The signing keys file keys.php is missing from the data folder of an installed site. Restore keys.php from your backup of ticketroom-data. New keys were not made, because every ticket and link already issued depends on the old ones.');
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
 * The easy way: sign in to the admin portal → Integrations, and set up
 * email, card payments (Yoco or PayFast) and SMS there. What you save
 * there is stored encrypted and wins over this file.
 *
 * EMAIL (if you prefer this file): tickets, confirmations and password
 * resets go out from hello@ticketroom.co.za. Until a mailbox password is
 * set, the hosting server's built-in mail is used, which often lands in spam.
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
    $hash = (string) cfg('admin.passwordHash', '');
    if (!str_starts_with($hash, '$2y$') && !str_starts_with($hash, '$argon2')) {
        throw new RuntimeException('Initial setup is required. Create a 32+ character bootstrap secret in ticketroom-data/bootstrap-secret, then open /setup.php over HTTPS.');
    }
    tr_install_with_hash($dir, $hash, (string) cfg('admin.email', 'hello@ticketroom.co.za'), (string) cfg('admin.name', 'TicketRoom Admin'));
}

// The public setup page supplies a per-install hash only after proving control
// of a short-lived secret file in the private data directory.
function tr_install_with_hash(string $dir, string $hash, string $email, string $name): void
{
    $lock = fopen("$dir/.install-lock", 'c');
    flock($lock, LOCK_EX);
    try {
        clearstatcache();
        if (is_file("$dir/.installed")) return;
        // An earlier package's database: keep it as it is.
        if (val("SELECT 1 FROM sqlite_master WHERE name = 'meta'")) { file_put_contents("$dir/.installed", now_iso()); return; }
        tx(fn() => tr_install_db($hash, $email, $name));
        file_put_contents("$dir/.installed", now_iso());
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
function tr_install_db(string $hash, ?string $adminEmail = null, ?string $adminName = null): void
{
    db()->exec((string) file_get_contents(TR_APP . '/schema.sql'));
    q('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema_version', (string) SCHEMA_VERSION]);
    q('INSERT INTO meta (key, value) VALUES (?, ?)', ['upgrades_done', implode(',', array_keys(UPGRADES))]);
    $email = strtolower($adminEmail ?? (string) cfg('admin.email', 'hello@ticketroom.co.za'));
    $uid = uuid();
    $now = now_iso();
    insert('users', ['id' => $uid, 'email' => $email, 'email_key' => email_key($email), 'full_name' => $adminName ?? (string) cfg('admin.name', 'TicketRoom Admin'), 'password_hash' => $hash, 'status' => 'active', 'account_type' => 'staff', 'email_verified_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
    q("INSERT INTO meta (key, value) VALUES ('owner_user_id', ?)", [$uid]);
    foreach (['admin', 'finance', 'support'] as $role) insert('platform_roles', ['user_id' => $uid, 'role' => $role, 'granted_at' => $now]);
    kb_ensure_defaults();
    audit('system.installed', ['actor' => ['id' => $uid, 'primaryRole' => 'admin'], 'details' => ['version' => TR_VERSION]]);
}

// Database upgrades for sites installed with an earlier zip. Each step runs
// once; new installs get everything from schema.sql and skip them all.
const SCHEMA_VERSION = 49;
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
    // Event and organiser IDs, target age groups, ticket kinds, gate passes.
    6 => [
        'ALTER TABLE organisers ADD COLUMN ref TEXT',
        'ALTER TABLE events ADD COLUMN ref TEXT',
        'ALTER TABLE events ADD COLUMN age_groups TEXT',
        "ALTER TABLE ticket_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'",
        'ALTER TABLE ticket_types ADD COLUMN admits INTEGER NOT NULL DEFAULT 1 CHECK (admits BETWEEN 1 AND 20)',
        'ALTER TABLE admission_log ADD COLUMN pass_id TEXT',
        'CREATE TABLE IF NOT EXISTS gate_passes ( id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), code TEXT NOT NULL UNIQUE, qr_version INTEGER NOT NULL DEFAULT 1, holder_name TEXT NOT NULL, email TEXT, role TEXT NOT NULL, access_note TEXT, reentry INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT \'active\' CHECK (status IN (\'active\',\'revoked\')), link_token_hash TEXT NOT NULL UNIQUE, scans INTEGER NOT NULL DEFAULT 0, first_scanned_at TEXT, last_scanned_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL )',
        'CREATE INDEX IF NOT EXISTS gate_passes_event_idx ON gate_passes (event_id, updated_at)',
        '@refs',
        'CREATE UNIQUE INDEX IF NOT EXISTS organisers_ref_uq ON organisers (ref)',
        'CREATE UNIQUE INDEX IF NOT EXISTS events_ref_uq ON events (ref)',
    ],
    // Guest checkout, one account per person, payments, refunds, payouts,
    // self-service integrations and queries passed to organisers.
    7 => [
        'ALTER TABLE users ADD COLUMN email_key TEXT',
        'ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0',
        'CREATE INDEX IF NOT EXISTS users_email_key_idx ON users (email_key)',
        'CREATE INDEX IF NOT EXISTS users_phone_idx ON users (phone)',
        '@emailkeys',
        'ALTER TABLE support_cases ADD COLUMN organiser_id TEXT REFERENCES organisers(id)',
        'ALTER TABLE support_cases ADD COLUMN event_id TEXT REFERENCES events(id)',
        "ALTER TABLE support_cases ADD COLUMN handled_by TEXT NOT NULL DEFAULT 'ticketroom'",
        'ALTER TABLE support_cases ADD COLUMN transferred_at TEXT',
        'CREATE TABLE IF NOT EXISTS payments ( id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), provider TEXT NOT NULL, environment TEXT NOT NULL, provider_reference TEXT, amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), status TEXT NOT NULL CHECK (status IN (\'initiated\',\'pending\',\'confirmed\',\'failed\',\'cancelled\',\'refunded\',\'partially_refunded\')), refunded_cents INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT )',
        'CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref_uq ON payments (provider, provider_reference)',
        'CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (order_id)',
        'CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status, created_at)',
        'CREATE TABLE IF NOT EXISTS webhook_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'received\' CHECK (status IN (\'received\',\'processed\',\'ignored\',\'failed\',\'rejected\')), result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 1, received_at TEXT NOT NULL, processed_at TEXT, UNIQUE (provider, event_id) )',
        'CREATE TABLE IF NOT EXISTS refunds ( id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL REFERENCES orders(id), payment_id TEXT REFERENCES payments(id), amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0), fee_refund_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_refund_cents >= 0), kind TEXT NOT NULL CHECK (kind IN (\'customer\',\'event_cancelled\',\'unfulfilled\',\'goodwill\')), reason TEXT NOT NULL, ticket_ids TEXT, status TEXT NOT NULL CHECK (status IN (\'requested\',\'processing\',\'manual_pending\',\'completed\',\'rejected\',\'failed\')), provider_reference TEXT, failure_reason TEXT, note TEXT, requested_by TEXT REFERENCES users(id), decided_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, CHECK (amount_cents + fee_refund_cents > 0) )',
        'CREATE INDEX IF NOT EXISTS refunds_status_idx ON refunds (status, created_at)',
        'CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds (order_id)',
        'CREATE TABLE IF NOT EXISTS payouts ( id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, organiser_id TEXT NOT NULL REFERENCES organisers(id), amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), status TEXT NOT NULL CHECK (status IN (\'requested\',\'approved\',\'paid\',\'rejected\')), bank_name TEXT, bank_account_holder TEXT, bank_account_last4 TEXT, bank_branch_code TEXT, bank_reference TEXT, note TEXT, requested_by TEXT REFERENCES users(id), approved_by TEXT REFERENCES users(id), paid_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, paid_at TEXT )',
        'CREATE INDEX IF NOT EXISTS payouts_org_idx ON payouts (organiser_id, status)',
        'CREATE TABLE IF NOT EXISTS integration_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT REFERENCES users(id), updated_at TEXT NOT NULL )',
        'CREATE TABLE IF NOT EXISTS support_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES support_cases(id), author_id TEXT REFERENCES users(id), author_kind TEXT NOT NULL CHECK (author_kind IN (\'customer\',\'ticketroom\',\'organiser\',\'system\')), body TEXT NOT NULL, emailed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL )',
        'CREATE INDEX IF NOT EXISTS support_messages_case_idx ON support_messages (case_id, id)',
        'CREATE TABLE IF NOT EXISTS ledger_journals ( id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL )',
        'CREATE TABLE IF NOT EXISTS ledger_entries ( id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id INTEGER NOT NULL REFERENCES ledger_journals(id), account TEXT NOT NULL, amount_cents INTEGER NOT NULL )',
        'CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account)',
        'CREATE INDEX IF NOT EXISTS ledger_entries_journal_idx ON ledger_entries (journal_id)',
        'CREATE TRIGGER IF NOT EXISTS ledger_journals_no_update BEFORE UPDATE ON ledger_journals BEGIN SELECT RAISE(ABORT, \'ledger is append-only\'); END',
        'CREATE TRIGGER IF NOT EXISTS ledger_journals_no_delete BEFORE DELETE ON ledger_journals BEGIN SELECT RAISE(ABORT, \'ledger is append-only\'); END',
        'CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, \'ledger is append-only\'); END',
        'CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, \'ledger is append-only\'); END',
        'CREATE TABLE IF NOT EXISTS recon_runs ( id TEXT PRIMARY KEY, provider TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, summary TEXT NOT NULL, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL )',
        'CREATE TABLE IF NOT EXISTS recon_items ( id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES recon_runs(id), provider_reference TEXT NOT NULL, outcome TEXT NOT NULL, provider_amount_cents INTEGER, internal_amount_cents INTEGER, provider_status TEXT, internal_status TEXT, resolved INTEGER NOT NULL DEFAULT 0, resolution_note TEXT, resolved_by TEXT REFERENCES users(id), resolved_at TEXT )',
        'CREATE INDEX IF NOT EXISTS recon_items_run_idx ON recon_items (run_id)',
    ],
    // One account, one portal: every account is a customer, an organiser or
    // TicketRoom staff. Existing accounts are sorted by what they already do.
    8 => [
        "ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'customer'",
        "UPDATE users SET account_type = 'staff' WHERE id IN (SELECT user_id FROM platform_roles)",
        "UPDATE users SET account_type = 'organiser' WHERE account_type = 'customer' AND id IN (SELECT user_id FROM organiser_members)",
        'CREATE INDEX IF NOT EXISTS users_type_idx ON users (account_type, created_at)',
        '@owner',
    ],
    // Sandbox: orders paid in test mode are test orders. Their tickets never
    // open a gate and their money never reaches an organiser's balance.
    9 => [
        'ALTER TABLE orders ADD COLUMN test INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE tickets ADD COLUMN test INTEGER NOT NULL DEFAULT 0',
        "UPDATE orders SET test = 1 WHERE id IN (SELECT order_id FROM payments WHERE environment <> 'live')",
        'UPDATE tickets SET test = 1 WHERE order_id IN (SELECT id FROM orders WHERE test = 1)',
    ],
    // Line-up on the event page (and Trending Artists on the home page).
    10 => [
        'ALTER TABLE events ADD COLUMN lineup TEXT',
    ],
    // (11 belongs to another feature.)
    // Organiser verification (FICA / KYC). Only its own new tables, created
    // if missing, so it works whatever 11 did.
    12 => ['@verification'],
    // Cashless: wristbands and tags, event wallets topped up by card, vendors
    // and their POS tills, spending PINs. Touches only its own tables and
    // columns (see tr_upgrade_cashless), so it works whether or not other
    // upgrades ran before it.
    // (13 belongs to another feature.) Safe in any order: it only adds its
    // own columns when missing and creates its own tables IF NOT EXISTS.
    14 => [
        '@cashless',
    ],
    // Promote: the R1,600 once-off event promotion package, its payments and
    // campaign tracking links. Only its own tables and columns, each added if
    // missing (see tr_promote_tables), so it works whatever ran before it.
    // (13 is never used: some sites may already be past it.)
    15 => ['@promote'],
    // Phone numbers confirmed with a code sent by SMS.
    16 => [
        'ALTER TABLE users ADD COLUMN phone_verified_at TEXT',
        'CREATE TABLE IF NOT EXISTS phone_codes (user_id TEXT PRIMARY KEY REFERENCES users(id), phone TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)',
    ],
    // Cashless in person: top-up desk, cash-up, guest cash-outs (EFT or cash
    // at the venue). Only its own tables, created if missing.
    17 => ['@cashdesk'],
    // Waitlists for sold-out tickets, TicketRoom Exchange (fair resale) and
    // topping up a friend's wallet. Only its own tables and columns, each
    // added if missing (see tr_upgrade_exchange), so it works whatever ran before it.
    18 => ['@exchange'],
    // Reuse unfinished payment attempts. Keep the newest active attempt for
    // each order before enforcing the invariant on existing installations.
    19 => [
        'ALTER TABLE payments ADD COLUMN checkout_url TEXT',
        "UPDATE payments SET status = 'cancelled', updated_at = datetime('now') WHERE status IN ('initiated','pending') AND order_id IS NOT NULL AND EXISTS (SELECT 1 FROM payments newer WHERE newer.order_id = payments.order_id AND newer.status IN ('initiated','pending') AND (newer.created_at > payments.created_at OR (newer.created_at = payments.created_at AND newer.id > payments.id)))",
        "CREATE UNIQUE INDEX IF NOT EXISTS payments_one_active_order_uq ON payments(order_id) WHERE order_id IS NOT NULL AND status IN ('initiated','pending')",
    ],
    // One-use, short-lived email OTP challenges for staff sign-in.
    20 => [
        'CREATE TABLE IF NOT EXISTS staff_login_codes (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, challenge_hash TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)',
        'CREATE UNIQUE INDEX IF NOT EXISTS staff_login_challenge_uq ON staff_login_codes(challenge_hash)',
    ],
    // Existing sessions get no more than one 15-minute grace period when this
    // update first runs; subsequent authenticated activity refreshes the idle
    // deadline, while load_session keeps the original 14-day absolute cap.
    21 => [
        "UPDATE sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes') WHERE revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes')",
    ],
    // Optional email OTP for customer and organiser login, configured by the
    // account holder from Security settings. Existing accounts remain off.
    22 => [
        'ALTER TABLE users ADD COLUMN email_otp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (email_otp_enabled IN (0,1))',
        "CREATE TABLE IF NOT EXISTS user_login_codes (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, challenge_hash TEXT NOT NULL, code_hash TEXT NOT NULL, portal TEXT NOT NULL CHECK (portal IN ('site','customer','organiser')), attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)",
        'CREATE UNIQUE INDEX IF NOT EXISTS user_login_challenge_uq ON user_login_codes (challenge_hash)',
    ],
    // Correct the company registration number only where the old default is
    // still present; never replace a value configured by the site owner.
    23 => [
        "UPDATE site_settings SET value = replace(replace(value, '\"registrationNumber\":\"2026811077\"', '\"registrationNumber\":\"2026/811077/07\"'), '\"registrationNumber\": \"2026811077\"', '\"registrationNumber\": \"2026/811077/07\"') WHERE key = 'legal' AND instr(value, '2026811077') > 0",
    ],
    24 => [
        "CREATE TABLE IF NOT EXISTS job_posts ( id TEXT PRIMARY KEY, title TEXT NOT NULL, department TEXT NOT NULL, location TEXT NOT NULL, employment_type TEXT NOT NULL, summary TEXT NOT NULL, description TEXT NOT NULL, application_url TEXT, closes_at TEXT, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')), created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL )",
        'CREATE INDEX IF NOT EXISTS job_posts_public_idx ON job_posts (status, closes_at, created_at DESC)',
    ],
    25 => [
        "ALTER TABLE events ADD COLUMN service_fee_payer TEXT NOT NULL DEFAULT 'customer' CHECK (service_fee_payer IN ('customer','organiser'))",
        'ALTER TABLE orders ADD COLUMN organiser_service_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (organiser_service_fee_cents >= 0)',
        'ALTER TABLE order_items ADD COLUMN unit_organiser_service_fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (unit_organiser_service_fee_cents >= 0)',
    ],
    26 => [
        'ALTER TABLE orders ADD COLUMN organiser_commission_fixed_cents INTEGER NOT NULL DEFAULT 0 CHECK (organiser_commission_fixed_cents >= 0)',
    ],
    // Replace only the previous standard fee set (5% + R2.50 and R10) with
    // the corrected standard rates. Leave any other admin-configured rates
    // untouched.
    27 => [
        "UPDATE site_settings SET value = json_set(value, '$.ticketFeeFixedCents', 600, '$.ticketFeeBps', 0, '$.organiserCommissionBps', 450, '$.organiserCommissionFixedCents', 250), updated_at = datetime('now') WHERE key = 'fees' AND json_valid(value) AND CAST(json_extract(value, '$.ticketFeeFixedCents') AS INTEGER) = 1000 AND CAST(json_extract(value, '$.ticketFeeBps') AS INTEGER) = 0 AND CAST(json_extract(value, '$.organiserCommissionBps') AS INTEGER) = 500 AND CAST(json_extract(value, '$.organiserCommissionFixedCents') AS INTEGER) = 250",
    ],
    // Add the Promote package to the admin-controlled fee set. Convert only
    // the previous R1,500 standard price; preserve any other chosen price.
    28 => [
        "UPDATE site_settings SET value = json_set(value, '$.promotionPriceCents', 160000), updated_at = datetime('now') WHERE key = 'fees' AND json_valid(value) AND (json_type(value, '$.promotionPriceCents') IS NULL OR CAST(json_extract(value, '$.promotionPriceCents') AS INTEGER) = 150000)",
    ],
    // Give advertising a safe default rate without overwriting a rate already
    // chosen by the administrator.
    29 => [
        "UPDATE site_settings SET value = json_set(value, '$.advertisingDailyPriceCents', 5000), updated_at = datetime('now') WHERE key = 'fees' AND json_valid(value) AND json_type(value, '$.advertisingDailyPriceCents') IS NULL",
    ],
    // Cashless vendor commissions are set by TicketRoom. New vendors inherit
    // this admin-controlled default; existing per-vendor agreements stay put.
    30 => [
        "UPDATE site_settings SET value = json_set(value, '$.cashlessVendorCommissionBps', 0), updated_at = datetime('now') WHERE key = 'fees' AND json_valid(value) AND json_type(value, '$.cashlessVendorCommissionBps') IS NULL",
    ],
    // Optional FIFO presale waiting room. Existing events remain disabled.
    31 => [
        'ALTER TABLE events ADD COLUMN presale_queue_enabled INTEGER NOT NULL DEFAULT 0',
        "CREATE TABLE IF NOT EXISTS presale_queue_entries (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), email TEXT NOT NULL, email_key TEXT NOT NULL, full_name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','admitted','used','expired')), joined_at TEXT NOT NULL, admitted_until TEXT, order_id TEXT REFERENCES orders(id), UNIQUE(event_id, email_key))",
        'CREATE INDEX IF NOT EXISTS presale_queue_fifo_idx ON presale_queue_entries (event_id, status, joined_at, id)',
    ],
    // Event transport notes and customer-owned recently viewed history.
    32 => [
        'ALTER TABLE events ADD COLUMN park_ride_info TEXT',
        'CREATE TABLE IF NOT EXISTS recently_viewed_events (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE, viewed_at TEXT NOT NULL, PRIMARY KEY (user_id, event_id))',
        'CREATE INDEX IF NOT EXISTS recently_viewed_user_idx ON recently_viewed_events (user_id, viewed_at DESC)',
    ],
    33 => [
        'ALTER TABLE events ADD COLUMN park_ride_url TEXT',
    ],
    // Peach checkout identifiers and a separate payout-attempt ledger.
    // Existing payments and payout records remain unchanged.
    34 => [
        'ALTER TABLE payments ADD COLUMN provider_payment_id TEXT',
        'CREATE INDEX IF NOT EXISTS payments_provider_payment_id_idx ON payments (provider, provider_payment_id)',
        'ALTER TABLE promotion_payments ADD COLUMN provider_payment_id TEXT',
        'ALTER TABLE promotion_payments ADD COLUMN checkout_url TEXT',
        'CREATE TABLE IF NOT EXISTS peach_payout_submissions (id TEXT PRIMARY KEY, payout_id TEXT NOT NULL REFERENCES payouts(id), environment TEXT NOT NULL CHECK (environment IN (\'sandbox\',\'live\')), provider_payout_id TEXT NOT NULL UNIQUE, payout_request_id TEXT, status TEXT NOT NULL CHECK (status IN (\'submitting\',\'pending\',\'processing\',\'successful\',\'failed\')), failure_reason TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT)',
        'CREATE INDEX IF NOT EXISTS peach_payout_submission_payout_idx ON peach_payout_submissions (payout_id, created_at DESC)',
        "CREATE UNIQUE INDEX IF NOT EXISTS peach_payout_one_open_uq ON peach_payout_submissions (payout_id) WHERE status IN ('submitting','pending','processing')",
    ],
    // Cashier permission, shifts, and server-recorded door tenders. Existing
    // orders and financial history are left intact.
    35 => [
        'ALTER TABLE event_staff ADD COLUMN can_sell_tickets INTEGER NOT NULL DEFAULT 0',
        'CREATE TABLE IF NOT EXISTS door_shifts (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), cashier_id TEXT NOT NULL REFERENCES users(id), opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0), counted_cash_cents INTEGER CHECK (counted_cash_cents >= 0), counted_card_cents INTEGER CHECK (counted_card_cents >= 0), cash_variance_cents INTEGER, card_variance_cents INTEGER, status TEXT NOT NULL CHECK (status IN (\'open\',\'closed\')), opened_at TEXT NOT NULL, closed_at TEXT, UNIQUE (id, event_id))',
        'CREATE UNIQUE INDEX IF NOT EXISTS door_shifts_one_open_cashier ON door_shifts (event_id, cashier_id) WHERE status = \'open\'',
        'CREATE INDEX IF NOT EXISTS door_shifts_event_idx ON door_shifts (event_id, opened_at)',
        'CREATE TABLE IF NOT EXISTS door_order_intents (order_id TEXT PRIMARY KEY REFERENCES orders(id), event_id TEXT NOT NULL REFERENCES events(id), shift_id TEXT NOT NULL REFERENCES door_shifts(id), cashier_id TEXT NOT NULL REFERENCES users(id), tender_method TEXT NOT NULL CHECK (tender_method IN (\'cash\',\'external_card\',\'yoco\',\'snapscan\',\'titopay\')), status TEXT NOT NULL CHECK (status IN (\'awaiting_tender\',\'confirmed\',\'cancelled\')), created_at TEXT NOT NULL, confirmed_at TEXT)',
        'CREATE TABLE IF NOT EXISTS door_tenders (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), event_id TEXT NOT NULL REFERENCES events(id), shift_id TEXT NOT NULL REFERENCES door_shifts(id), cashier_id TEXT NOT NULL REFERENCES users(id), payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id), method TEXT NOT NULL CHECK (method IN (\'cash\',\'external_card\',\'yoco\',\'snapscan\',\'titopay\')), amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), cash_received_cents INTEGER CHECK (cash_received_cents >= amount_cents), change_cents INTEGER NOT NULL DEFAULT 0 CHECK (change_cents >= 0), external_reference TEXT, receipt_reference TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, UNIQUE (shift_id, method, external_reference))',
        'CREATE INDEX IF NOT EXISTS door_tenders_shift_idx ON door_tenders (shift_id, created_at)',
    ],
    // Retail sellers are approved accounts and participate in the existing
    // order/tender ledger; existing orders and door shifts remain unchanged.
    36 => [
        'ALTER TABLE orders ADD COLUMN retail_partner_id TEXT REFERENCES retail_partners(id)',
        'ALTER TABLE orders ADD COLUMN retail_commission_share_cents INTEGER NOT NULL DEFAULT 0 CHECK (retail_commission_share_cents >= 0)',
        'ALTER TABLE orders ADD COLUMN retail_service_share_cents INTEGER NOT NULL DEFAULT 0 CHECK (retail_service_share_cents >= 0)',
        'ALTER TABLE door_shifts ADD COLUMN retail_partner_id TEXT REFERENCES retail_partners(id)',
        'ALTER TABLE door_order_intents ADD COLUMN retail_partner_id TEXT REFERENCES retail_partners(id)',
        'CREATE TABLE IF NOT EXISTS retail_partners (id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, owner_user_id TEXT NOT NULL REFERENCES users(id), business_name TEXT NOT NULL, registration_number TEXT, contact_phone TEXT NOT NULL, store_address TEXT NOT NULL, sales_channels TEXT NOT NULL DEFAULT \'[]\', website_url TEXT, status TEXT NOT NULL DEFAULT \'pending\' CHECK (status IN (\'pending\',\'approved\',\'rejected\',\'suspended\')), review_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT REFERENCES users(id))',
        'CREATE INDEX IF NOT EXISTS retail_partners_status_idx ON retail_partners (status, created_at)',
        'CREATE TABLE IF NOT EXISTS retail_partner_members (partner_id TEXT NOT NULL REFERENCES retail_partners(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK (role IN (\'owner\',\'seller\')), created_at TEXT NOT NULL, PRIMARY KEY (partner_id,user_id))',
        'CREATE TABLE IF NOT EXISTS retail_partner_payouts (id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES retail_partners(id), amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), bank_reference TEXT NOT NULL, paid_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE (partner_id, bank_reference))',
    ],
    // Attribute retailer sales efficiently without changing existing orders.
    37 => [
        'CREATE INDEX IF NOT EXISTS orders_retail_partner_idx ON orders (retail_partner_id, created_at)',
    ],
    // Public shop finder pins: coordinates are optional and do not affect
    // retailer applications, sales, orders, or existing account data.
    38 => [
        'ALTER TABLE retail_partners ADD COLUMN location_lat_e6 INTEGER',
        'ALTER TABLE retail_partners ADD COLUMN location_lng_e6 INTEGER',
    ],
    // Customer-approved, expiring QR payments for vendor POS. The cashless
    // block is idempotent and owns this table on both upgrades and new installs.
    39 => ['@cashless'],
    // Preserve payout history while recording Peach's terminal reversals.
    40 => [
        'ALTER TABLE peach_payout_submissions ADD COLUMN provider_status TEXT',
        'ALTER TABLE peach_payout_submissions ADD COLUMN provider_updated_at TEXT',
        'CREATE TABLE IF NOT EXISTS peach_payout_reversals ( id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE REFERENCES peach_payout_submissions(id), payout_id TEXT NOT NULL REFERENCES payouts(id), provider_payout_id TEXT NOT NULL UNIQUE, provider_status TEXT NOT NULL CHECK (provider_status IN (\'cancelled\',\'reversed\')), provider_updated_at TEXT, ledger_reversed INTEGER NOT NULL DEFAULT 0 CHECK (ledger_reversed IN (0,1)), created_at TEXT NOT NULL )',
        'CREATE INDEX IF NOT EXISTS peach_payout_reversal_payout_idx ON peach_payout_reversals (payout_id, created_at DESC)',
    ],
    // Restore the latest owner-approved fee defaults after the earlier
    // standard-rate correction. Only replace the exact previous defaults;
    // custom admin rates, per-organiser agreements and existing orders stay
    // untouched.
    41 => [
        "UPDATE site_settings SET value = json_set(value, '$.ticketFeeFixedCents', 1000, '$.ticketFeeBps', 0, '$.organiserCommissionBps', 500, '$.organiserCommissionFixedCents', 250), updated_at = datetime('now') WHERE key = 'fees' AND json_valid(value) AND CAST(json_extract(value, '$.ticketFeeFixedCents') AS INTEGER) = 600 AND CAST(json_extract(value, '$.ticketFeeBps') AS INTEGER) = 0 AND CAST(json_extract(value, '$.organiserCommissionBps') AS INTEGER) = 450 AND CAST(json_extract(value, '$.organiserCommissionFixedCents') AS INTEGER) = 250",
        "UPDATE kb_articles SET answer = 'Listing a free event costs nothing. The standard commission is 5% of net ticket sales plus R2.50 per paid ticket, and the standard R10 service fee may be covered by the organiser or paid by customers, as shown on the event. Check the organiser portal for any approved rate specific to your account.' WHERE question = 'What does it cost organisers?' AND answer = 'Listing a free event costs nothing. For paid events, the standard organiser commission is 4.5% of net ticket sales plus R2.50 per paid ticket. The R6 service fee may be covered by the organiser or paid by customers, as shown on the event.'",
    ],
    // Promo codes and single-use vouchers share the same discount ledger.
    // Defaults preserve the meaning and behavior of all existing codes.
    42 => [
        "ALTER TABLE promo_codes ADD COLUMN code_type TEXT NOT NULL DEFAULT 'promo' CHECK (code_type IN ('promo','voucher'))",
        'ALTER TABLE promo_codes ADD COLUMN max_uses_per_email INTEGER CHECK (max_uses_per_email IS NULL OR max_uses_per_email > 0)',
        'ALTER TABLE promo_codes ADD COLUMN minimum_subtotal_cents INTEGER NOT NULL DEFAULT 0 CHECK (minimum_subtotal_cents >= 0)',
        'CREATE INDEX IF NOT EXISTS promo_codes_event_active_idx ON promo_codes (event_id, active, valid_from, valid_to)',
    ],
    // Published event changes are proposed by organisers and only applied
    // after an admin review. One open request is allowed per event.
    43 => [
        "CREATE TABLE IF NOT EXISTS event_change_requests (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), organiser_id TEXT NOT NULL REFERENCES organisers(id), requested_by TEXT NOT NULL REFERENCES users(id), request_reason TEXT NOT NULL, changes_json TEXT NOT NULL, before_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')), review_note TEXT, review_checks_json TEXT, reviewed_by TEXT REFERENCES users(id), reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
        "CREATE UNIQUE INDEX IF NOT EXISTS event_change_requests_pending_uq ON event_change_requests (event_id) WHERE status = 'pending'",
        'CREATE INDEX IF NOT EXISTS event_change_requests_status_idx ON event_change_requests (status, created_at)',
        'CREATE INDEX IF NOT EXISTS event_change_requests_organiser_idx ON event_change_requests (organiser_id, created_at)',
    ],
    // Event page details: prohibited items, and ticket groups (e.g. General, VIP, Tables)
    // with their own banner image. Existing events and tickets stay ungrouped.
    44 => [
        'ALTER TABLE events ADD COLUMN prohibited_items TEXT',
        'ALTER TABLE events ADD COLUMN ticket_groups TEXT',
        'ALTER TABLE ticket_types ADD COLUMN group_name TEXT',
    ],
    // Organiser logo, shown on their event pages.
    45 => [
        'ALTER TABLE organisers ADD COLUMN logo_upload_id TEXT',
    ],
    // Ticket phases: a ticket type can go on sale when an earlier one sells out.
    46 => [
        'ALTER TABLE ticket_types ADD COLUMN release_after TEXT',
    ],
    // (47 and 48 belong to other work.) Email retries: a lease on each
    // message being sent and the time of its next try. Only its own columns,
    // each added if missing (see tr_upgrade_ops).
    49 => ['@ops'],
];
// Promote's tables and columns (version 13), each only if missing.
function tr_promote_tables(): void
{
    foreach (['tracking_links' => 'campaign_id', 'campaigns' => 'promotion_id'] as $t => $c) {
        if (!val("SELECT 1 FROM pragma_table_info('$t') WHERE name = ?", [$c])) db()->exec("ALTER TABLE $t ADD COLUMN $c TEXT");
    }
    foreach ([
        'CREATE TABLE IF NOT EXISTS event_promotions (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL REFERENCES events(id), organiser_id TEXT NOT NULL REFERENCES organisers(id), status TEXT NOT NULL CHECK (status IN (\'pending_payment\',\'active\',\'ended\',\'refunded\',\'cancelled\')), price_cents INTEGER NOT NULL CHECK (price_cents > 0), paid_with TEXT CHECK (paid_with IN (\'card\',\'balance\')), test INTEGER NOT NULL DEFAULT 0, social_status TEXT CHECK (social_status IN (\'requested\',\'scheduled\',\'posted\')), social_request TEXT, social_notes TEXT, social_links TEXT, social_updated_at TEXT, refund_status TEXT CHECK (refund_status IN (\'processing\',\'manual_pending\',\'completed\',\'failed\')), refund_reference TEXT, refund_reason TEXT, refund_provider_reference TEXT, refund_failure TEXT, refunded_by TEXT REFERENCES users(id), refunded_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), paid_at TEXT, ends_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
        'CREATE UNIQUE INDEX IF NOT EXISTS event_promotions_open_uq ON event_promotions (event_id) WHERE status IN (\'pending_payment\',\'active\')',
        'CREATE INDEX IF NOT EXISTS event_promotions_status_idx ON event_promotions (status, created_at)',
        'CREATE INDEX IF NOT EXISTS event_promotions_org_idx ON event_promotions (organiser_id, created_at)',
        'CREATE TABLE IF NOT EXISTS promotion_payments (id TEXT PRIMARY KEY, promotion_id TEXT NOT NULL REFERENCES event_promotions(id), provider TEXT NOT NULL, environment TEXT NOT NULL, provider_reference TEXT, amount_cents INTEGER NOT NULL CHECK (amount_cents > 0), status TEXT NOT NULL CHECK (status IN (\'initiated\',\'pending\',\'confirmed\',\'failed\',\'cancelled\',\'refunded\')), refunded_cents INTEGER NOT NULL DEFAULT 0, failure_reason TEXT, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT)',
        'CREATE UNIQUE INDEX IF NOT EXISTS promotion_payments_ref_uq ON promotion_payments (provider, provider_reference)',
        'CREATE INDEX IF NOT EXISTS promotion_payments_promo_idx ON promotion_payments (promotion_id)',
        'CREATE INDEX IF NOT EXISTS campaigns_promotion_idx ON campaigns (promotion_id)',
        'CREATE INDEX IF NOT EXISTS tracking_links_campaign_idx ON tracking_links (campaign_id)',
    ] as $sql) db()->exec($sql);
}
// The verification tables, exactly as written at the end of schema.sql.
function tr_verification_tables(): void
{
    $sql = (string) file_get_contents(TR_APP . '/schema.sql');
    $at = strpos($sql, '-- Organiser verification (FICA / KYC).');
    if ($at === false) throw new RuntimeException('schema.sql has no verification tables');
    db()->exec(substr($sql, $at));
}
// The platform owner is the first administrator. Nobody else can change
// their roles, suspend them or reset their password.
function tr_mark_owner(): void
{
    if (val("SELECT value FROM meta WHERE key = 'owner_user_id'")) return;
    $id = val("SELECT u.id FROM users u JOIN platform_roles r ON r.user_id = u.id AND r.role = 'admin' ORDER BY u.created_at LIMIT 1");
    if ($id) q("INSERT INTO meta (key, value) VALUES ('owner_user_id', ?)", [$id]);
}
// Fills in the duplicate-check key for accounts made before it existed.
function tr_backfill_email_keys(): void
{
    foreach (rows('SELECT id, email FROM users WHERE email_key IS NULL') as $r) q('UPDATE users SET email_key = ? WHERE id = ?', [email_key($r['email']), $r['id']]);
}
// Gives every organiser and event without one its short ID.
function tr_backfill_refs(): void
{
    foreach (rows('SELECT id FROM organisers WHERE ref IS NULL') as $r) q('UPDATE organisers SET ref = ? WHERE id = ?', [new_ref('organisers'), $r['id']]);
    foreach (rows('SELECT id FROM events WHERE ref IS NULL') as $r) q('UPDATE events SET ref = ? WHERE id = ?', [new_ref('events'), $r['id']]);
}
// Upgrades are tracked one by one (meta "upgrades_done"), not just by the
// highest number, so an upgrade that arrives later with a lower number (work
// merged out of order) still runs exactly once. Adding a column that is
// already there is skipped, so every step is safe to repeat.
function tr_upgrade(): void
{
    $want = implode(',', array_keys(UPGRADES));
    $m = [];
    foreach (rows("SELECT key, value FROM meta WHERE key IN ('schema_version', 'upgrades_done')") as $r) $m[$r['key']] = (string) $r['value'];
    if (($m['upgrades_done'] ?? null) === $want) return;
    // One request upgrades while the others wait. A copy of the database is
    // made first (Admin portal, Backups), so a failed upgrade can be undone.
    $lock = fopen(data_dir() . '/.upgrade-lock', 'c');
    flock($lock, LOCK_EX);
    try {
        if ((string) val("SELECT value FROM meta WHERE key = 'upgrades_done'") === $want) return;
        try { backup_take('before-upgrade'); }
        catch (Throwable $e) { error_log('[ticketroom] backup before upgrade failed: ' . $e->getMessage()); }
        tr_upgrade_run($want);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}
function tr_upgrade_run(string $want): void
{
    tx(function () use ($want) {
        $have = (int) (val("SELECT value FROM meta WHERE key = 'schema_version'") ?? 1);
        $doneRaw = val("SELECT value FROM meta WHERE key = 'upgrades_done'");
        // First run with this tracking: everything up to the stored version is done.
        $done = $doneRaw === null ? array_values(array_filter(array_keys(UPGRADES), fn($v) => $v <= $have)) : array_map('intval', array_filter(explode(',', (string) $doneRaw), 'strlen'));
        foreach (UPGRADES as $v => $steps) {
            if (in_array($v, $done, true)) continue;
            foreach ($steps as $sql) {
                try {
                    match ($sql) { '@refs' => tr_backfill_refs(), '@emailkeys' => tr_backfill_email_keys(), '@owner' => tr_mark_owner(), '@verification' => tr_verification_tables(), '@cashless' => tr_upgrade_cashless(), '@promote' => tr_promote_tables(), '@cashdesk' => tr_upgrade_cashdesk(), '@exchange' => tr_upgrade_exchange(), '@ops' => tr_upgrade_ops(), default => db()->exec($sql) };
                } catch (PDOException $e) {
                    if (!str_contains($e->getMessage(), 'duplicate column name')) throw $e;
                }
            }
            $done[] = $v;
            $have = max($have, $v);
        }
        sort($done);
        q("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [(string) max($have, SCHEMA_VERSION)]);
        q("INSERT INTO meta (key, value) VALUES ('upgrades_done', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [$want]);
    });
}

function tr_error_response(Throwable $e): Response
{
    if ($e instanceof TrHalt) return json_out(['error' => ['code' => 'site_stopped', 'message' => 'TicketRoom is paused while we check something on the server. Please try again a little later.']], 503);
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

// While maintenance mode is on, visitors get the maintenance notice: pages
// through index.php (see maintenance_flag_sync) and API calls return 503 except
// site health/config, staff/admin, and the reference-tracked contact routes.
// Preserve the complete staff path so they can sign in with email OTP, inspect
// the admin portal, and turn maintenance off. Customer sign-in still rejects
// non-staff accounts in auth.php; these exemptions do not grant permissions.
// The gate keeps going too: an organiser's scanners, the top-up desk and the
// vendor tills keep working, so an update never stops an event that is on.
const MAINT_EXEMPT = '#^/api/(?:health|config|auth/(?:login|logout|me|password/reset|staff-code/verify)|admin(?:/.*)?|webhooks(?:/.*)?|site/(?:contact|callback)|staff/.+|cashdesk/.+|pos/.+)$#';

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
        // Unused cashless balances go up for refund a couple of days after the event.
        ['cashless-leftover-refunds', 3600, fn() => cashless_auto_refunds()],
        // One email after a cashless event to everyone with money left: cash it out in one tap.
        ['cashout-reminders', 1800, fn() => cashout_reminders()],
        // Waitlist offers that ran out go to the next person; resale listings close at the doors.
        ['exchange', 60, fn() => exchange_housekeeping()],
        ['expire-transfers', 900, fn() => q("UPDATE ticket_transfers SET status = 'expired' WHERE status = 'pending' AND expires_at < ?", [now_iso()])],
        ['retention', 21600, function () {
            q('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?', [iso_in(-30 * 86400), iso_in(-30 * 86400)]);
            q('DELETE FROM password_resets WHERE created_at < ?', [iso_in(-7 * 86400)]);
            q('DELETE FROM rate_limits WHERE reset_at < ?', [time() - 3600]);
            q('DELETE FROM chat_messages WHERE created_at < ?', [iso_in(-90 * 86400)]);
            outbox_redact();
            limit_light_prune();
        }],
        // A copy of the database every day, the newest 14 kept (Admin portal, Backups).
        ['backup', 86400, fn() => backup_take('daily')],
        // Images that ended up on nothing (uploaded but never saved to an event).
        ['upload-cleanup', 21600, fn() => uploads_cleanup()],
        // One email to the owner when email or the background jobs get stuck.
        ['ops-alerts', 900, fn() => ops_alert_check()],
        // Organiser campaigns booked for later go out when their time comes.
        // Verification documents past their keeping time are deleted (POPIA).
        ['verification-retention', 21600, fn() => kyc_retention()],
        // Promote packages end with their event; unpaid ones lapse after a day.
        ['end-promotions', 300, fn() => promo_expire()],
        ['scheduled-campaigns', 60, fn() => function_exists('org_due_scheduled_campaigns') ? org_due_scheduled_campaigns() : 0],
        ['deliver-outbox', 0, function () { $end = microtime(true) + 8; while (microtime(true) < $end && outbox_deliver(25) === 25); }],
    ];
}
function run_due_jobs(bool $force = false, bool $cron = false): array
{
    if ($cron) q("INSERT INTO meta (key, value) VALUES ('cron_last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [(string) time()]);
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
    $requestUri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    if (str_contains($requestUri, "\r") || str_contains($requestUri, "\n")) { http_response_code(400); return; }
    $path = '/' . ltrim((string) parse_url($requestUri, PHP_URL_PATH), '/');
    $path = rawurldecode($path);
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    // api/index.php can be reached directly even when a host ignores the root
    // rewrite file, so enforce HTTPS here too. Use configured canonical URL,
    // never the request Host header.
    if (!is_https()) {
        $defaults = require TR_APP . '/config.php';
        if (($defaults['security']['enforceHttps'] ?? true) === true) {
            $base = rtrim((string) ($defaults['baseUrl'] ?? 'https://ticketroom.co.za'), '/');
            $rawPath = (string) (parse_url($requestUri, PHP_URL_PATH) ?: '/');
            $rawQuery = parse_url($requestUri, PHP_URL_QUERY);
            header('Location: ' . $base . $rawPath . ($rawQuery !== null ? '?' . $rawQuery : ''), true, 308);
            return;
        }
    }
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
    // Keep the web server's switch in step with the setting (after an upload, for example).
    if ($s['maintenance']['enabled'] !== is_file(maintenance_flag_file())) maintenance_flag_sync((bool) $s['maintenance']['enabled']);
    $siteRead = $method === 'GET' && $path === '/api/site';
    if ($s['maintenance']['enabled'] && !$siteRead && !preg_match(MAINT_EXEMPT, $path) && !(user() && user()['platformRoles'])) {
        emit(json_out(['error' => ['code' => 'maintenance', 'message' => $s['maintenance']['message']]], 503));
        return;
    }

    header('Cache-Control: no-store');
    try {
        $raw = '';
        // Image and document uploads are read by their own routes, not here.
        $isUpload = str_ends_with($path, '/uploads') || preg_match(KYC_UPLOAD_RE, $path);
        if (!$isUpload && in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
            $raw = (string) file_get_contents('php://input', false, null, 0, 102401);
            if (strlen($raw) > 102400) throw new AppError(413, 'too_large', 'That request is too large.');
        }
        // Payment providers post their notifications as JSON (Yoco) or a form
        // (PayFast), with no session: they are checked by signature instead.
        $isHook = str_starts_with($path, '/api/webhooks/');
        if (!$isHook) csrf_check($method, $path);
        $body = [];
        if ($raw !== '' && !$isHook) {
            $body = json_decode($raw, true);
            if (!is_array($body)) throw new AppError(400, 'bad_json', 'Malformed JSON.');
        }
        $GLOBALS['TR_REQ'] = ['method' => $method, 'path' => $path, 'body' => $body, 'raw' => $raw];
        tr_load_routes();
        // The customer portal's API is for customer accounts. Organisers and
        // staff have their own portals (liking an event is open to anyone signed in).
        if (str_starts_with($path, '/api/me/') && $path !== '/api/me/likes' && user() && account_type(user()) !== 'customer') {
            throw forbidden('This is for customer accounts. Sign in on your own portal.');
        }
        $res = dispatch($method, $path);
    } catch (Throwable $e) {
        $res = tr_error_response($e);
    }
    // Respond first, then do background work (sending email, expiring holds).
    // PHP-FPM and LiteSpeed can end the response early; elsewhere (mod_php,
    // CGI) the reply is sent whole with its length and the connection closed,
    // so the visitor never waits for email to go out.
    $early = function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request');
    if ($res->file !== null) {
        // A download goes straight out, never through the memory buffer below.
        while (ob_get_level() > 0) ob_end_clean();
        emit($res);
        flush();
        try { run_due_jobs(); } catch (Throwable $e) { error_log('[ticketroom] jobs: ' . $e->getMessage()); }
        return;
    }
    if (!$early) {
        ignore_user_abort(true);
        while (ob_get_level() > 0) ob_end_clean();
        ob_start();
    }
    emit($res);
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    elseif (function_exists('litespeed_finish_request')) litespeed_finish_request();
    elseif (!headers_sent()) {
        if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
        header('Content-Length: ' . ob_get_length());
        header('Connection: close');
        ob_end_flush();
        flush();
    } else {
        ob_end_flush();
        flush();
    }
    try { run_due_jobs(); } catch (Throwable $e) { error_log('[ticketroom] jobs: ' . $e->getMessage()); }
}
