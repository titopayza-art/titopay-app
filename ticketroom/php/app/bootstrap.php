<?php
// TicketRoom PHP edition — request entry. public_html/index.php includes this.
declare(strict_types=1);

define('TR_APP', __DIR__);
define('TR_VERSION', '1.0.0');
require TR_APP . '/lib/core.php';
require TR_APP . '/lib/site.php';
require TR_APP . '/lib/messaging.php';
require TR_APP . '/lib/domain.php';
require TR_APP . '/lib/qr.php';

// Settings and the database live outside the website folder when the host
// allows it (../ticketroom-data), otherwise in a locked folder (tr-data).
function tr_find_config(string $docroot): ?string
{
    foreach ([dirname($docroot) . '/ticketroom-data', $docroot . '/tr-data'] as $dir) {
        if (is_file("$dir/config.php")) return $dir;
    }
    return null;
}
function tr_load(string $dataDir): void
{
    $GLOBALS['TR_DATA_DIR'] = $dataDir;
    $GLOBALS['TR_CONFIG'] = require "$dataDir/config.php";
    date_default_timezone_set('UTC');
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

// ---------------------------------------------------------------- pages
const PAGE_ROUTES = [
    '#^/($|events/[^/]+$|checkout/[^/]+$|orders/[^/]+$|browse$|signin$|legal/[^/]+$|help$|contact$|unsubscribe$|sell$|privacy$|cookies$|terms$)#' => 'index.html',
    '#^/account(/|$)#' => 'account.html',
    '#^/organisers(/|$)#' => 'organiser.html',
    '#^/scan(/|$)#' => 'scan.html',
    '#^/pos(/|$)#' => 'pos.html',
    '#^/admin(/|$)#' => 'admin.html',
];
function serve_page(string $file, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    readfile(TR_APP . "/pages/$file");
}
// Visitors see this while maintenance mode is on; staff, sign-in, health and
// admin keep working.
const MAINT_EXEMPT = '#^/(api/(health|config|auth/|site(/|$)|admin/)|admin(/|$)|assets/|media/|signin$|sw\.js$|manifest\.webmanifest$|favicon)#';
function maintenance_page(string $message): void
{
    http_response_code(503);
    header('Retry-After: 1800');
    header('Content-Type: text/html; charset=utf-8');
    $m = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><html lang=\"en-ZA\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>TicketRoom — back soon</title><link rel=\"icon\" href=\"/assets/favicon.svg\"><link rel=\"stylesheet\" href=\"/assets/tr.css\"></head>"
        . "<body class=\"maint\"><main class=\"maint-card\"><img src=\"/assets/ticketroom-logo.png\" alt=\"TicketRoom\" width=\"520\" height=\"260\"><h1>We'll be right back</h1><p>$m</p><p class=\"small\">Questions? <a href=\"mailto:hello@ticketroom.co.za\">hello@ticketroom.co.za</a></p></main></body></html>";
}

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
        ['deliver-outbox', 0, fn() => outbox_deliver(25)],
    ];
}
function run_due_jobs(bool $force = false): array
{
    $ran = [];
    $last = [];
    foreach (rows('SELECT name, last_run FROM job_runs') as $r) $last[$r['name']] = (int) $r['last_run'];
    foreach (jobs() as [$name, $every, $fn]) {
        $now = time();
        $every = max($every, 5);
        if (!$force) {
            $dirtyOutbox = $name === 'deliver-outbox' && !empty($GLOBALS['TR_OUTBOX_DIRTY']);
            if (!$dirtyOutbox && ($last[$name] ?? 0) > $now - $every) continue;
            $claimed = tx(function () use ($name, $every, $now) {
                q('INSERT OR IGNORE INTO job_runs (name, last_run) VALUES (?, 0)', [$name]);
                return affected('UPDATE job_runs SET last_run = ? WHERE name = ? AND last_run <= ?', [$now, $name, $now - $every]);
            });
            if (!$claimed && !$dirtyOutbox) continue;
        }
        try { $fn(); $ran[] = $name; } catch (Throwable $e) { error_log("[ticketroom] job $name: " . $e->getMessage()); }
    }
    return $ran;
}

// ---------------------------------------------------------------- main
function tr_handle(string $docroot): void
{
    $path = '/' . ltrim((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
    $path = rawurldecode($path);
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    send_security_headers();

    $dataDir = tr_find_config($docroot);
    if (!$dataDir) {
        require TR_APP . '/setup.php';
        tr_setup($docroot, $path, $method);
        return;
    }
    tr_load($dataDir);

    try {
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
    if (preg_match('#^/organiser(/.*)?$#', $path, $m)) { header('Location: /organisers' . ($m[1] ?? '') . (empty($_SERVER['QUERY_STRING']) ? '' : '?' . $_SERVER['QUERY_STRING']), true, 301); return; }

    $s = settings_all();
    if ($s['maintenance']['enabled'] && !preg_match(MAINT_EXEMPT, $path) && !(user() && user()['platformRoles'])) {
        if (str_starts_with($path, '/api/')) emit(json_out(['error' => ['code' => 'maintenance', 'message' => $s['maintenance']['message']]], 503));
        else maintenance_page($s['maintenance']['message']);
        return;
    }

    if (str_starts_with($path, '/api/')) {
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
    } else {
        $file = null;
        foreach (PAGE_ROUTES as $re => $f) if (preg_match($re, $path)) { $file = $f; break; }
        serve_page($file ?? 'index.html', $file ? 200 : 404);
    }

    // Respond first, then do background work.
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    elseif (function_exists('litespeed_finish_request')) litespeed_finish_request();
    try { run_due_jobs(); } catch (Throwable $e) { error_log('[ticketroom] jobs: ' . $e->getMessage()); }
}
