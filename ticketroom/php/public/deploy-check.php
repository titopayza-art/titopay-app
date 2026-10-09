<?php
/**
 * Deploy check: reports what actually reached the server and whether it works.
 *
 * Locked: it only opens while an empty file called unlock-check exists in the
 * data folder (cPanel → File Manager → public_html/data → + File). Delete that
 * file when you are done.
 */
declare(strict_types=1);

$root = __DIR__;
if (!is_file("$root/data/unlock-check")) {
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Robots-Tag: noindex');
    echo '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>';
    exit;
}
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

$rows = [];
$add = function (string $section, string $label, ?bool $ok, string $detail = '') use (&$rows) { $rows[] = [$section, $label, $ok, $detail]; };

// ---- The upload
$build = is_file("$root/version.txt") ? trim((string) file_get_contents("$root/version.txt")) : '';
$add('Upload', 'Build', $build !== '', $build ?: 'version.txt is missing: the upload is incomplete. Extract ticketroom.zip again.');
$docroot = rtrim((string) realpath((string) ($_SERVER['DOCUMENT_ROOT'] ?? '')), '/');
$add('Upload', 'Files are in the folder the domain shows', $docroot === $root, $docroot === $root ? $root
    : "These files are in $root but the domain shows $docroot. Move them there (cPanel → Domains shows each domain's Document Root).");
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
        require "$root/api/bootstrap.php";
        tr_load();
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
    $add('Data', 'Data folder', is_writable($data), $data . (is_writable($data) ? '' : ': not writable. File Manager → right-click → Change Permissions → 755.'));
    $add('Data', 'Database', is_file("$data/ticketroom.sqlite"), is_file("$data/ticketroom.sqlite") ? number_format(filesize("$data/ticketroom.sqlite") / 1048576, 1) . ' MB · ' . $state['users'] . ($state['users'] === 1 ? ' account · ' : ' accounts · ') . $state['events'] . ($state['events'] === 1 ? ' event' : ' events') : '');
    $add('Data', 'Ticket signing keys', is_file("$data/keys.php") || !empty(cfg('keys.qr')), 'Back up the data folder: every ticket QR code depends on these keys.');
    $add('Data', 'Administrator', $state['admin'] ? ($state['temp'] ? null : true) : false, $state['admin'] ? $state['admin']['email'] . ($state['temp'] ? ' · still on the temporary password: change it under Admin portal → My password' : '') : 'No administrator found.');
    if ($data !== "$root/data") $add('Data', 'Data kept from the earlier package', null, "$data is still in use. That is fine; nothing needs moving.");
}

// ---- Through the web, as a visitor sees it
$base = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
$fetch = function (string $path) use ($base): array {
    $ctx = stream_context_create(['http' => ['method' => 'GET', 'timeout' => 6, 'ignore_errors' => true, 'follow_location' => 0], 'ssl' => ['verify_peer' => false, 'verify_peer_name' => false]]);
    $body = @file_get_contents($base . $path, false, $ctx);
    $code = 0;
    foreach ($http_response_header ?? [] as $h) if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) $code = (int) $m[1];
    return [$code, (string) $body];
};
[$c, $b] = $fetch('/api/health');
$add('Web', 'The API answers (/api/health)', $c === 200 && str_contains($b, '"ok":true'), $c === 200 ? '' : "Got HTTP $c. The hidden .htaccess files may be missing.");
[$c] = $fetch('/sell');
$add('Web', 'Clean addresses (/sell)', $c === 200, $c === 200 ? '' : "Got HTTP $c. The root .htaccess is missing or the host has rewriting switched off.");
[$c] = $fetch('/data/ticketroom.sqlite');
$add('Web', 'The database cannot be downloaded', $c === 403 || $c === 404, $c === 403 || $c === 404 ? '' : "Got HTTP $c: the data folder is open to the web. Make sure .htaccess uploaded.");
[$c, $b] = $fetch('/api/config.php');
$add('Web', 'Settings file cannot be read', !str_contains($b, 'passwordHash'), str_contains($b, 'passwordHash') ? 'api/config.php is readable from the web. Make sure api/.htaccess uploaded.' : '');
$add('Web', 'https', str_starts_with($base, 'https'), str_starts_with($base, 'https') ? '' : 'You opened this page over http. Run AutoSSL (cPanel → SSL/TLS Status), then switch on Force HTTPS Redirect (cPanel → Domains).');

// ---- Email
if ($data) {
    $mode = mail_mode();
    $add('Email', 'How email is sent', $mode === 'smtp' ? true : null, $mode === 'smtp' ? 'Through the mailbox ' . cfg('mail.smtpUser') . ' at ' . cfg('mail.smtpHost')
        : "The hosting server's built-in mail. It works, but often lands in spam. Put the hello@ mailbox password in data/config.php.");
    if ($mode === 'smtp') { $h = smtp_health(); $add('Email', 'Mail server reachable', $h['ok'], $h['detail']); }
    else $add('Email', 'PHP mail() available', function_exists('mail') && !in_array('mail', array_map('trim', explode(',', (string) ini_get('disable_functions'))), true), '');
}

// ---- Leftovers from earlier uploads
$left = [];
foreach (['tr-app', 'ticketroom-app', 'holding', 'ticketroom.zip', 'stayhope.zip'] as $f) if (file_exists("$root/$f")) $left[] = $f;
if (is_dir("$root/tr-data") && $data !== "$root/tr-data") $left[] = 'tr-data';
$add('Tidy up', 'Files from earlier uploads', !$left, $left ? 'Delete these from public_html: ' . implode(', ', $left) . '.' : 'None.');
$add('Tidy up', 'This page', null, 'When everything above is green, delete data/unlock-check so this page locks again.');

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
