<?php
// One-time setup, shown until TicketRoom is configured. Protected by the setup
// code in tr-app/setup-code.txt. Creates the data folder (outside the website
// folder when possible), the keys, the SQLite database and the admin account.
declare(strict_types=1);

function setup_requirements(string $docroot): array
{
    $checks = [
        ['PHP 8.1 or newer', version_compare(PHP_VERSION, '8.1.0', '>='), 'cPanel → Select PHP Version (or MultiPHP Manager) → choose PHP 8.1, 8.2 or 8.3.'],
        ['SQLite database support (pdo_sqlite)', extension_loaded('pdo_sqlite'), 'cPanel → Select PHP Version → Extensions → tick pdo_sqlite (and sqlite3).'],
        ['OpenSSL', extension_loaded('openssl'), 'cPanel → Select PHP Version → Extensions → tick openssl.'],
        ['Multibyte strings (mbstring)', extension_loaded('mbstring'), 'cPanel → Select PHP Version → Extensions → tick mbstring.'],
        ['Write access for the data folder', is_writable(dirname($docroot)) || is_writable($docroot), 'In File Manager, give your home folder or public_html write permission for your own user (755).'],
    ];
    return $checks;
}
function setup_page(string $docroot, array $errors = [], array $old = []): void
{
    $e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
    $checks = setup_requirements($docroot);
    $ok = !in_array(false, array_column($checks, 1), true);
    $host = $_SERVER['HTTP_HOST'] ?? 'ticketroom.co.za';
    $url = $old['baseUrl'] ?? ((is_https() ? 'https://' : 'http://') . $host);
    $field = function (string $name, string $label, string $type = 'text', string $hint = '', string $value = '', string $extra = '') use ($e, $errors, $old) {
        $v = $old[$name] ?? $value;
        $err = isset($errors[$name]) ? '<div class="err">' . $e($errors[$name]) . '</div>' : '';
        return "<div class=\"field\"><label for=\"f-$name\">$label</label><input id=\"f-$name\" name=\"$name\" type=\"$type\" value=\"" . ($type === 'password' ? '' : $e($v)) . "\" $extra" . ($err ? ' aria-invalid="true"' : '') . '>' . ($hint ? "<span class=\"hint\">$hint</span>" : '') . "$err</div>";
    };
    http_response_code($errors ? 422 : 200);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    echo '<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up TicketRoom</title>'
        . '<link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/assets/tr.css"></head><body>'
        . '<header class="site-header"><div class="wrap"><a class="brand" href="/"><img src="/assets/logo-mark.svg" alt="" width="40" height="30"><span><span class="wordmark">TICKET<b>ROOM</b></span><span class="brand-sub">Your event. Your ticket.</span></span></a><span class="portal-tag">Setup</span></div></header>'
        . '<main id="main" class="wrap section"><div class="card pad-lg stack setup-card"><h1>Set up TicketRoom</h1>'
        . '<p class="lead mb-0">Fill this in once and your site is live. You won\'t see this page again after that.</p>';
    echo '<h2>1. Hosting check</h2><ul class="stack check-list">';
    foreach ($checks as [$label, $pass, $fix]) {
        echo '<li>' . ($pass ? '<span class="badge good">OK</span> ' : '<span class="badge bad">Needs attention</span> ') . $e($label) . ($pass ? '' : '<div class="small muted">' . $e($fix) . '</div>') . '</li>';
    }
    echo '</ul>';
    if (!$ok) { echo '<p class="callout warn">Fix the items above, then reload this page.</p></div></main></body></html>'; return; }
    if (isset($errors['_'])) echo '<p class="callout bad" role="alert">' . $e($errors['_']) . '</p>';
    echo '<form method="post" action="/" class="stack" autocomplete="off"><h2>2. Your admin account</h2>'
        . $field('setupCode', 'Setup code', 'text', 'From the message that came with the zip, or the file public_html/tr-app/setup-code.txt in File Manager.', '', 'required autocomplete="off"')
        . $field('fullName', 'Your name', 'text', '', 'TicketRoom Admin', 'required maxlength="120"')
        . $field('email', 'Admin email', 'email', 'You sign in with this.', 'hello@ticketroom.co.za', 'required')
        . $field('password', 'Admin password', 'password', 'At least 10 characters.', '', 'required minlength="10" autocomplete="new-password"')
        . $field('password2', 'Confirm password', 'password', '', '', 'required minlength="10" autocomplete="new-password"')
        . $field('baseUrl', 'Website address', 'url', 'Use https:// once SSL is active (cPanel → SSL/TLS Status → Run AutoSSL).', $url, 'required')
        . '<h2>3. Email (optional, recommended)</h2><p class="small muted mb-0">Tickets, confirmations and password resets are emailed from hello@ticketroom.co.za. Leave the password empty to use the server\'s built-in mail; adding the mailbox password gives better delivery. You can change this later in the data folder\'s config.php.</p>'
        . $field('smtpHost', 'Mail server', 'text', '', 'mail.' . preg_replace('/^www\./', '', explode(':', $host)[0]))
        . $field('smtpUser', 'Mailbox', 'email', '', 'hello@ticketroom.co.za')
        . $field('smtpPass', 'Mailbox password', 'password', 'Optional.', '', 'autocomplete="new-password"')
        . '<button class="btn btn-primary btn-block">Finish setup and open the back office</button></form></div></main></body></html>';
}
function setup_write_config(string $dir, array $config): void
{
    $php = "<?php\n// TicketRoom settings. Keep this file private: it holds the signing keys.\n// Losing the keys invalidates every ticket QR code — back up this folder.\nreturn " . var_export($config, true) . ";\n";
    file_put_contents("$dir/config.php", $php, LOCK_EX);
    @chmod("$dir/config.php", 0600);
}
function tr_setup(string $docroot, string $path, string $method): void
{
    if (str_starts_with($path, '/api/')) {
        emit(json_out(['error' => ['code' => 'setup_required', 'message' => 'TicketRoom is not set up yet. Open the website to finish setup.']], 503));
        return;
    }
    if ($method !== 'POST') { setup_page($docroot); return; }

    $in = array_map(fn($v) => is_string($v) ? trim($v) : '', $_POST);
    $codeFile = TR_APP . '/setup-code.txt';
    $code = is_file($codeFile) ? trim((string) file_get_contents($codeFile)) : '';
    $errors = [];
    if ($code === '' || !hash_equals($code, strtoupper(str_replace([' ', '-'], '', $in['setupCode'] ?? '')))) $errors['setupCode'] = 'That setup code is not right.';
    if (mb_strlen($in['fullName'] ?? '') < 2) $errors['fullName'] = 'Enter your name.';
    $email = strtolower($in['email'] ?? '');
    if (!preg_match('/^[^\s@<>()"\',;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/', $email)) $errors['email'] = 'Enter a valid email address.';
    $pw = $_POST['password'] ?? '';
    if (!is_string($pw) || mb_strlen($pw) < 10) $errors['password'] = 'Use at least 10 characters.';
    elseif ($pw !== ($_POST['password2'] ?? '')) $errors['password2'] = 'The passwords do not match.';
    $baseUrl = rtrim($in['baseUrl'] ?? '', '/');
    if (!preg_match('#^https?://[a-z0-9.-]+(:\d+)?$#i', $baseUrl)) $errors['baseUrl'] = 'Enter the address like https://ticketroom.co.za';
    if ($errors) { sleep(1); setup_page($docroot, $errors, $in); return; }

    // Data folder: outside public_html when allowed, else a locked tr-data.
    $outside = dirname($docroot) . '/ticketroom-data';
    $dir = null;
    if ((is_dir($outside) || @mkdir($outside, 0750)) && is_writable($outside)) $dir = $outside;
    else {
        $dir = $docroot . '/tr-data';
        if (!is_dir($dir) && !@mkdir($dir, 0750)) { setup_page($docroot, ['_' => 'Could not create the data folder. Check folder permissions in File Manager.'], $in); return; }
        file_put_contents("$dir/.htaccess", "Require all denied\n<IfModule !mod_authz_core.c>\n  Order allow,deny\n  Deny from all\n</IfModule>\n");
        file_put_contents("$dir/index.html", '');
    }
    @mkdir("$dir/uploads", 0750);
    if (is_file("$dir/config.php")) { header('Location: /admin', true, 303); return; }

    $smtpPass = (string) ($_POST['smtpPass'] ?? '');
    $config = [
        'baseUrl' => $baseUrl,
        'cookieSecure' => true,
        'keys' => ['qr' => bin2hex(random_bytes(32)), 'links' => bin2hex(random_bytes(32)), 'data' => bin2hex(random_bytes(32))],
        'fees' => ['ticketFeeFixedCents' => 1000, 'ticketFeeBps' => 0, 'organiserCommissionBps' => 500],
        'mail' => $smtpPass !== ''
            ? ['mode' => 'smtp', 'smtpHost' => $in['smtpHost'] ?: 'mail.ticketroom.co.za', 'smtpPort' => 465, 'smtpUser' => $in['smtpUser'] ?: $email, 'smtpPass' => $smtpPass, 'fromEmail' => 'hello@ticketroom.co.za', 'fromName' => 'TicketRoom']
            : ['mode' => 'mail', 'fromEmail' => 'hello@ticketroom.co.za', 'fromName' => 'TicketRoom'],
        'anthropicApiKey' => '',
        'chatbotModel' => 'claude-opus-5-5',
        'chatbotDailyLimit' => 300,
        'installedAt' => gmdate('c'),
    ];
    // Build everything in a temp database, then move config into place last,
    // so a half-finished setup can simply be retried.
    $GLOBALS['TR_DATA_DIR'] = $dir;
    $GLOBALS['TR_CONFIG'] = $config;
    @unlink("$dir/ticketroom.sqlite");
    db()->exec((string) file_get_contents(TR_APP . '/schema.sql'));
    q('INSERT INTO meta (key, value) VALUES (?, ?)', ['schema_version', '1']);
    $uid = uuid();
    $now = now_iso();
    insert('users', ['id' => $uid, 'email' => $email, 'full_name' => $in['fullName'], 'password_hash' => hash_secret($pw), 'status' => 'active', 'email_verified_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
    foreach (['admin', 'finance', 'support'] as $role) insert('platform_roles', ['user_id' => $uid, 'role' => $role, 'granted_at' => $now]);
    kb_ensure_defaults();
    audit('system.installed', ['actor' => ['id' => $uid, 'primaryRole' => 'admin'], 'details' => ['version' => TR_VERSION, 'dataFolder' => $dir === $outside ? 'outside website folder' : 'tr-data (locked)']]);
    setup_write_config($dir, $config);
    @unlink($codeFile);
    create_session($uid);
    header('Location: /admin#/site', true, 303);
}
