<?php
/**
 * Deploy check: reports what actually reached the server and whether it works.
 *
 * Locked: it only opens while a file called unlock-check exists in the
 * private data directory (ticketroom-data next to public_html), and only for
 * 30 minutes after that file was made. Delete it when you are done.
 *
 * It never shows server paths or account email addresses: folders are named
 * as public_html and ticketroom-data, and the administrator is masked.
 */
declare(strict_types=1);

$root = __DIR__;
require "$root/api/bootstrap.php";
if (!is_https()) { http_response_code(404); exit; }
try {
    tr_load();
} catch (TrHalt $e) {
    // The site has stopped itself (data folder or keys.php missing). The
    // reason is in ticketroom-data/php-errors.log and the cron job's output.
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "TicketRoom has stopped itself to protect its data. The reason is in the cron job's output and in php-errors.log. See DEPLOY-AFRIHOST.md, \"If the site stops itself\".\n";
    exit;
}
if (!cfg('security.diagnosticsEnabled', false)) { http_response_code(404); exit; }
$privateData = data_dir();
clearstatcache();
if (is_file("$privateData/unlock-check") && filemtime("$privateData/unlock-check") < time() - 1800) @unlink("$privateData/unlock-check");
if (!is_file("$privateData/unlock-check")) {
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Robots-Tag: noindex');
    echo '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>';
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Strict-Transport-Security: max-age=31536000');

$rows = [];
// Paths become their names, so nothing about the server's layout is shown.
$hide = function (string $s) use ($root): string {
    $pairs = [];
    if (function_exists('data_dir') && isset($GLOBALS['TR_DATA_DIR'])) { $pairs[data_dir()] = 'ticketroom-data'; if (realpath(data_dir())) $pairs[(string) realpath(data_dir())] = 'ticketroom-data'; }
    $pairs[$root] = 'public_html';
    if (realpath($root)) $pairs[(string) realpath($root)] = 'public_html';
    if (dirname($root) !== '/') $pairs[dirname($root)] = 'your home folder';
    uksort($pairs, fn($a, $b) => strlen($b) - strlen($a));
    return strtr($s, $pairs);
};
$add = function (string $section, string $label, ?bool $ok, string $detail = '') use (&$rows, $hide) { $rows[] = [$section, $label, $ok, $hide($detail)]; };
$maskEmail = function (string $email): string { [$who, $dom] = array_pad(explode('@', $email, 2), 2, ''); return mb_substr($who, 0, 1) . '…@' . $dom; };

// ---- The upload
$build = is_file("$root/version.txt") ? trim((string) file_get_contents("$root/version.txt")) : '';
$add('Upload', 'Build', $build !== '', $build ?: 'version.txt is missing: the upload is incomplete. Extract ticketroom.zip again.');
$docroot = rtrim((string) realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? '')), '/');
$add('Upload', 'Files are in the folder the domain shows', $docroot === $root, $docroot === $root ? 'Yes.'
    : "These files are not in the folder the domain shows. Move them there (cPanel → Domains shows each domain's Document Root).");
foreach (['index.html', 'event.html', 'admin.html', 'assets/core.js', 'api/index.php', 'api/config.php', 'api/schema.sql', 'api/lib/core.php'] as $f) {
    if (!is_file("$root/$f")) $add('Upload', "Missing file: $f", false, 'Extract ticketroom.zip again and overwrite everything.');
}
foreach (['.htaccess' => 'Clean addresses and the private folders depend on it.', 'api/.htaccess' => 'Keeps the code in api/ private.'] as $f => $why) {
    $add('Upload', "Hidden file $f", is_file("$root/$f"), is_file("$root/$f") ? '' : "Not uploaded. $why In File Manager turn on Settings → Show Hidden Files, then extract the zip again.");
}

// ---- PHP
$add('PHP', 'PHP 8.1 or newer', version_compare(PHP_VERSION, '8.1.0', '>='), 'This server runs PHP ' . PHP_VERSION . (version_compare(PHP_VERSION, '8.1.0', '>=') ? '' : '. cPanel → Select PHP Version → choose 8.1, 8.2 or 8.3.'));
foreach (['pdo_sqlite' => 'the database', 'openssl' => 'email and ticket signing', 'mbstring' => 'names and text', 'curl' => 'the website assistant, optional'] as $ext => $for) {
    $ok = extension_loaded($ext);
    $add('PHP', "Extension $ext ($for)", $ok ? true : ($ext === 'curl' ? null : false), $ok ? '' : 'cPanel → Select PHP Version → Extensions → tick ' . $ext . '.');
}

// ---- The data folder and database
$data = null;
$state = null;
if (version_compare(PHP_VERSION, '8.1.0', '>=') && extension_loaded('pdo_sqlite') && is_file("$root/api/bootstrap.php")) {
    try {
        $data = data_dir();
        $state = [
            'events' => (int) val('SELECT count(*) FROM events'),
            'users' => (int) val('SELECT count(*) FROM users'),
            'admin' => row("SELECT u.id, u.email FROM users u JOIN platform_roles r ON r.user_id = u.id AND r.role = 'admin' WHERE u.status = 'active' LIMIT 1"),
        ];
        $state['temp'] = $state['admin'] ? (bool) val('SELECT 1 FROM meta WHERE key = ?', ["temp_password:{$state['admin']['id']}"]) : false;
    } catch (Throwable $e) {
        $add('Data', 'Starting TicketRoom', false, $e->getMessage());
    }
}
if ($data) {
    $add('Data', 'Data folder', is_writable($data), 'ticketroom-data' . (is_writable($data) ? '' : ': not writable. File Manager → right-click → Change Permissions → 755.'));
    $add('Data', 'Database', is_file("$data/ticketroom.sqlite"), is_file("$data/ticketroom.sqlite") ? number_format(filesize("$data/ticketroom.sqlite") / 1048576, 1) . ' MB · ' . $state['users'] . ($state['users'] === 1 ? ' account · ' : ' accounts · ') . $state['events'] . ($state['events'] === 1 ? ' event' : ' events') : '');
    $add('Data', 'Ticket signing keys', is_file("$data/keys.php") || !empty(cfg('keys.qr')), 'Back up the data folder: every ticket QR code depends on these keys.');
    $add('Data', 'Administrator', $state['admin'] ? ($state['temp'] ? null : true) : false, $state['admin'] ? $maskEmail((string) $state['admin']['email']) . ($state['temp'] ? ' · still on the temporary password: change it under Admin portal → My password' : '') : 'No administrator found.');
    $sqlite = (string) val('SELECT sqlite_version()');
    $add('Data', 'SQLite ' . $sqlite, version_compare($sqlite, '3.27.0', '>='), version_compare($sqlite, '3.27.0', '>=') ? 'Backups work (they need 3.27 or newer).' : 'Backups need SQLite 3.27 or newer. cPanel → Select PHP Version → choose a newer PHP.');
    $ops = ops_status();
    $cronAt = $ops['jobs']['cron']['lastRunAt'];
    $add('Data', 'Cron job', $ops['jobs']['cron']['fresh'], $cronAt ? 'Last ran ' . $cronAt . ' (UTC).' . ($ops['jobs']['cron']['fresh'] ? '' : ' That is too long ago: check cPanel → Cron Jobs.')
        : 'Not set up. cPanel → Cron Jobs → every 5 minutes: /usr/local/bin/php /home/YOURUSER/public_html/api/cron.php >/dev/null 2>&1 (DEPLOY-AFRIHOST.md, step "Cron").');
    $add('Data', 'Background jobs', $ops['jobs']['fresh'], $ops['jobs']['fresh'] ? 'All ran on time.' : 'Late: ' . implode(', ', $ops['jobs']['stale']) . '. Usually the cron job is missing.');
    $last = $ops['backups']['lastAt'];
    $fresh = $last && (to_unix($last) ?? 0) > time() - OPS_BACKUP_MAX_HOURS * 3600;
    $add('Data', 'Backups', $fresh ? true : ($ops['backups']['count'] ? false : null), $last ? $ops['backups']['count'] . ' kept in ticketroom-data/backups, newest ' . $last . ' (UTC). Download one now and then: Admin portal → Backups.'
        : 'None yet. The first is made within a day, or press "Back up now" under Admin portal → Backups.');
    $add('Email', 'Messages waiting', $ops['outbox']['queued'] < OPS_BACKLOG_MESSAGES ? true : null, $ops['outbox']['queued'] . ' waiting, ' . $ops['outbox']['failed24h'] . ' failed in the last day' . ($ops['outbox']['paused'] ? ', email paused because the mail server is busy or unreachable' : '') . '.');
    $dataReal = realpath($data);
    $rootReal = realpath($root);
    $outsideWeb = $dataReal !== false && $rootReal !== false
        && !str_starts_with($dataReal . DIRECTORY_SEPARATOR, rtrim($rootReal, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR);
    $add('Data', 'Data folder is outside the website folder', $outsideWeb,
        $outsideWeb ? 'The web server cannot reach it through the website.'
            : 'Fix before production: data is inside (or resolves inside) the website folder. Back up first, then follow the private-data migration steps in SECURITY-OPERATIONS.md. .htaccess is only a fallback, not the security boundary.');
    $masterKey = getenv('TICKETROOM_MASTER_KEY');
    $masterKeyReady = is_string($masterKey) && preg_match('/^[0-9a-f]{64}$/i', $masterKey) === 1;
    $add('Data', 'Encryption master key is host-managed', $masterKeyReady ? true : null,
        $masterKeyReady ? 'TICKETROOM_MASTER_KEY is supplied by the host, outside the data-folder backup.'
            : 'Note: encrypted integration/KYC data uses the key in keys.php. Plan a tested key migration before production secrets or sensitive documents are stored; never add the environment key without migrating existing ciphertext.');
}

// ---- Through the web, as a visitor sees it
// Ask our own site, never whatever host the request names: the live address
// from settings, or this same server when testing locally.
$reqHost = strtolower((string) parse_url('//' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST));
$liveHost = strtolower((string) parse_url(function_exists('base_url') ? base_url() : 'https://ticketroom.co.za', PHP_URL_HOST));
$scheme = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http';
$base = in_array($reqHost, ['localhost', '127.0.0.1'], true) ? "$scheme://$reqHost:" . (int) ($_SERVER['SERVER_PORT'] ?? 80)
    : (in_array($reqHost, [$liveHost, "www.$liveHost"], true) ? "$scheme://$liveHost" : (function_exists('base_url') ? base_url() : "https://$liveHost"));
$fetch = function (string $path) use ($base): array {
    $ctx = stream_context_create(['http' => ['method' => 'GET', 'timeout' => 6, 'ignore_errors' => true, 'follow_location' => 0], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'allow_self_signed' => false]]);
    $body = @file_get_contents($base . $path, false, $ctx);
    $code = 0;
    foreach ($http_response_header ?? [] as $h) if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $code = (int) $m[1];
    return [$code, (string) $body];
};
[$c, $b] = $fetch('/api/health');
$add('Web', 'The API answers (/api/health)', $c === 200 && str_contains($b, '"ok":true'), $c === 200 ? '' : "Got HTTP $c. The hidden .htaccess files may be missing.");
[$c] = $fetch('/sell');
$add('Web', 'Clean addresses (/sell)', $c === 200, $c === 200 ? '' : "Got HTTP $c. The root .htaccess is missing or the host has rewriting switched off.");
foreach (['data', 'tr-data', 'ticketroom-data'] as $folder) {
    foreach (['ticketroom.sqlite', 'keys.php', 'config.php', 'ticketroom.sqlite-wal', 'ticketroom.sqlite-shm', 'uploads/'] as $file) {
        [$c] = $fetch('/' . $folder . '/' . $file);
        $blocked = $c === 403 || $c === 404;
        $add('Web', "$folder/$file is not publicly readable", $blocked,
            $blocked ? '' : "Got HTTP $c. Treat this as a security incident: block public access immediately, preserve evidence, rotate exposed secrets if any, and migrate data outside the document root.");
    }
}
[$c, $b] = $fetch('/api/config.php');
$add('Web', 'Settings file cannot be read', !str_contains($b, 'passwordHash'), str_contains($b, 'passwordHash') ? 'api/config.php is readable from the web. Make sure api/.htaccess uploaded.' : '');
$add('Web', 'https', str_starts_with($base, 'https'), str_starts_with($base, 'https') ? '' : 'You opened this page over http. Run AutoSSL (cPanel → SSL/TLS Status), then switch on Force HTTPS Redirect (cPanel → Domains).');

// ---- Email
if ($data) {
    $mode = mail_mode();
    $add('Email', 'How email is sent', $mode === 'smtp' ? true : null, $mode === 'smtp' ? 'Through the mailbox ' . $maskEmail((string) cfg('mail.smtpUser')) . ' at ' . cfg('mail.smtpHost')
        : "The hosting server's built-in mail. It works, but often lands in spam. Put the hello@ mailbox password in ticketroom-data/config.php, or set it under Admin portal → Integrations.");
    if ($mode === 'smtp') { $h = smtp_health(); $add('Email', 'Mail server reachable', $h['ok'], $h['detail']); }
    else $add('Email', 'PHP mail() available', function_exists('mail') && !in_array('mail', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true), '');
}

// ---- Leftovers from earlier uploads
$left = [];
foreach (['tr-app', 'ticketroom-app', 'holding', 'ticketroom.zip', 'stayhope.zip'] as $f) if (file_exists("$root/$f")) $left[] = $f;
foreach (glob("$root/*.zip") ?: [] as $z) if (!in_array(basename($z), $left, true)) $left[] = basename($z);
if (is_dir("$root/tr-data") && $data !== "$root/tr-data") $left[] = 'tr-data';
$add('Tidy up', 'Files from earlier uploads', !$left, $left ? 'Delete these from public_html: ' . implode(', ', $left) . '.' : 'None.');
$add('Tidy up', 'This page', null, 'When everything above is green, delete the private ticketroom-data/unlock-check file and disable diagnostics again.');

$e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
?><!doctype html>
<html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deploy check | TicketRoom</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/assets/tr.css"></head>
<body><main id="main" class="wrap section"><div class="card pad-lg stack">
<h1>Deploy check</h1>
<p class="muted mb-0">What is on the server right now. Fix anything marked "Fix", from the top down.</p>
<?php $section = ''; foreach ($rows as [$s, $label, $ok, $detail]): if ($s !== $section): $section = $s; ?>
  <h2 class="h4 mt"><?= $e($s) ?></h2>
<?php endif; ?>
  <div class="row" style="align-items:flex-start;gap:12px">
    <span class="badge <?= $ok === true ? 'good' : ($ok === false ? 'bad' : 'warn') ?>" style="min-width:4.5em;justify-content:center"><?= $ok === true ? 'OK' : ($ok === false ? 'Fix' : 'Note') ?></span>
    <div><strong><?= $e($label) ?></strong><?php if ($detail !== ''): ?><div class="small muted"><?= $e($detail) ?></div><?php endif; ?></div>
  </div>
<?php endforeach; ?>
</div></main></body></html>
