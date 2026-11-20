<?php
/**
 * One-time first-owner setup. This page is inactive once .installed exists.
 * Activation requires a high-entropy secret created by the hosting operator
 * in ticketroom-data/bootstrap-secret (outside public_html) less than 15
 * minutes before use. Delete the secret after setup; success also removes it.
 */
declare(strict_types=1);

require __DIR__ . '/api/bootstrap.php';
if (!is_https()) { http_response_code(404); exit; }
tr_load(false);
$dir = data_dir();
$unlock = $dir . '/bootstrap-secret';
clearstatcache();
if (is_file($unlock) && filemtime($unlock) < time() - 900) @unlink($unlock);
if (is_file($dir . '/.installed') || !is_file($unlock)) { http_response_code(404); exit; }

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Strict-Transport-Security: max-age=31536000');

$e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
$error = '';
$done = '';
$email = strtolower(trim((string) ($_POST['email'] ?? cfg('admin.email', 'hello@ticketroom.co.za'))));
$name = trim((string) ($_POST['name'] ?? cfg('admin.name', 'TicketRoom Admin')));
$secret = trim((string) @file_get_contents($unlock));
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    $originParts = $origin !== '' ? parse_url($origin) : false;
    $siteParts = parse_url(base_url());
    $originPort = is_array($originParts) ? (int) ($originParts['port'] ?? 443) : 0;
    $sitePort = is_array($siteParts) ? (int) ($siteParts['port'] ?? 443) : 0;
    if (!is_array($originParts) || !is_array($siteParts)
        || strtolower((string) ($originParts['scheme'] ?? '')) !== 'https'
        || strtolower((string) ($siteParts['scheme'] ?? '')) !== 'https'
        || strtolower((string) ($originParts['host'] ?? '')) !== strtolower((string) ($siteParts['host'] ?? ''))
        || $originPort !== $sitePort || isset($originParts['user']) || isset($originParts['pass'])
        || isset($originParts['path']) || isset($originParts['query']) || isset($originParts['fragment'])) {
        http_response_code(403); exit;
    }
    $word = trim((string) ($_POST['secret'] ?? ''));
    $pw = (string) ($_POST['password'] ?? '');
    if (mb_strlen($secret) < 32) $error = 'The bootstrap secret must contain at least 32 characters.';
    elseif (!hash_equals($secret, $word)) { audit('security.setup_wrong_secret', ['ip' => client_ip()]); $error = 'The bootstrap secret did not match. The unlock file remains in place until it expires.'; }
    elseif (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 254) $error = 'Enter a valid owner email address.';
    elseif (mb_strlen($name) < 2 || mb_strlen($name) > 120) $error = 'Enter an owner name between 2 and 120 characters.';
    elseif (mb_strlen($pw) < 14 || mb_strlen($pw) > 200) $error = 'Use a password between 14 and 200 characters.';
    elseif ($pw !== (string) ($_POST['confirm'] ?? '')) $error = 'The passwords do not match.';
    else {
        tr_install_with_hash($dir, hash_secret($pw), $email, $name);
        @unlink($unlock);
        $done = 'Owner account created. The bootstrap secret has been removed. Sign in now and enrol MFA before adding staff.';
    }
}
?><!doctype html>
<html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Secure first setup | TicketRoom</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/assets/tr.css"></head>
<body><main class="wrap section"><div class="card pad-lg stack setup-card">
<h1>Secure first setup</h1>
<?php if ($done): ?>
  <p class="callout good" role="status"><?= $e($done) ?></p><a class="btn btn-primary" href="/signin">Sign in</a>
<?php else: ?>
  <p class="muted">This page is available for 15 minutes only after a hosting operator creates a 32+ character secret in the private <code>ticketroom-data/bootstrap-secret</code> file.</p>
  <?php if ($error): ?><p class="callout bad" role="alert"><?= $e($error) ?></p><?php endif; ?>
  <form method="post" class="stack" autocomplete="off">
    <div class="field"><label for="secret">Bootstrap secret</label><input id="secret" name="secret" type="password" required autocomplete="off"></div>
    <div class="field"><label for="name">Owner name</label><input id="name" name="name" required minlength="2" maxlength="120" value="<?= $e($name) ?>"></div>
    <div class="field"><label for="email">Owner work email</label><input id="email" name="email" type="email" required value="<?= $e($email) ?>"></div>
    <div class="field"><label for="pw">New password</label><input id="pw" name="password" type="password" minlength="14" required autocomplete="new-password"></div>
    <div class="field"><label for="pw2">Confirm new password</label><input id="pw2" name="confirm" type="password" minlength="14" required autocomplete="new-password"></div>
    <button class="btn btn-primary btn-block">Create owner account</button>
  </form>
<?php endif; ?>
</div></main></body></html>
