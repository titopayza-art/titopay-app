<?php
/**
 * Reset a back-office password on the live site.
 *
 * Locked: it only opens while an empty file called unlock-reset exists in the
 * data folder (cPanel → File Manager → public_html/data → + File). Without it
 * this page says "Not found", so knowing the address is not enough. The unlock
 * file is removed as soon as a password has been set.
 */
declare(strict_types=1);

$unlock = __DIR__ . '/data/unlock-reset';
if (!is_file($unlock)) {
    http_response_code(404);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Robots-Tag: noindex');
    echo '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>';
    exit;
}

require __DIR__ . '/api/bootstrap.php';
tr_load();
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

$e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
$error = '';
$done = '';
$email = strtolower(trim((string) ($_POST['email'] ?? cfg('admin.email', 'hello@ticketroom.co.za'))));
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $pw = (string) ($_POST['password'] ?? '');
    $u = row("SELECT id FROM users WHERE lower(email) = ? AND status = 'active'", [$email]);
    if (!$u) $error = 'There is no active account with that email.';
    elseif (mb_strlen($pw) < 10) $error = 'Use at least 10 characters.';
    elseif ($pw !== (string) ($_POST['confirm'] ?? '')) $error = 'The two passwords do not match.';
    else {
        tx(function () use ($u, $pw) {
            $now = now_iso();
            q('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', [hash_secret($pw), $now, $u['id']]);
            q('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [$now, $u['id']]);
            q('DELETE FROM meta WHERE key = ?', ["temp_password:{$u['id']}"]);
            audit('user.password_reset_on_server', ['actor' => ['id' => $u['id']], 'entityType' => 'user', 'entityId' => $u['id'], 'ip' => client_ip()]);
        });
        @unlink($unlock);
        $done = is_file($unlock)
            ? 'Password set. Now delete the file unlock-reset from the data folder: this page stays open while it exists.'
            : 'Password set, and this page is locked again. Sign in with the new password.';
    }
}
?><!doctype html>
<html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reset password | TicketRoom</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/assets/tr.css"></head>
<body><main id="main" class="wrap section"><div class="card pad-lg stack setup-card">
<h1>Reset a back-office password</h1>
<?php if ($done): ?>
  <p class="callout good" role="status"><?= $e($done) ?></p>
  <a class="btn btn-primary" href="/signin">Sign in</a>
<?php else: ?>
  <p class="muted mb-0">Everyone signed in with this account is signed out.</p>
  <?php if ($error): ?><p class="callout bad" role="alert"><?= $e($error) ?></p><?php endif; ?>
  <form method="post" class="stack" autocomplete="off">
    <div class="field"><label for="em">Account email</label><input id="em" name="email" type="email" required value="<?= $e($email) ?>"></div>
    <div class="field"><label for="pw">New password</label><input id="pw" name="password" type="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
    <div class="field"><label for="pw2">New password again</label><input id="pw2" name="confirm" type="password" minlength="10" required autocomplete="new-password"></div>
    <button class="btn btn-primary btn-block">Set password</button>
  </form>
<?php endif; ?>
</div></main></body></html>
