<?php
/**
 * Reset an admin or staff password on the live site.
 *
 * Locked three ways, so knowing the address is never enough:
 *  1. It only opens while a file called unlock-reset exists in public_html/data
 *     (cPanel → File Manager → + File), and only for 30 minutes after that
 *     file was made.
 *  2. Inside the file you type a secret word of your own (8+ characters). The
 *     page asks for it. One wrong word deletes the file, so it cannot be guessed.
 *  3. It only resets TicketRoom staff accounts (admin, finance, support).
 * The unlock file is removed as soon as a password has been set.
 */
declare(strict_types=1);

$unlock = __DIR__ . '/data/unlock-reset';
clearstatcache();
if (is_file($unlock) && filemtime($unlock) < time() - 1800) @unlink($unlock); // older than 30 minutes: locked again
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
$email = strtolower(trim((string) ($_POST['email'] ?? '')));
$secret = trim((string) file_get_contents($unlock));
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    // Only a form posted from this site counts.
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== parse_url('//' . ($_SERVER['HTTP_HOST'] ?? ''), PHP_URL_HOST)) { http_response_code(403); exit; }
    $pw = (string) ($_POST['password'] ?? '');
    $word = trim((string) ($_POST['unlock'] ?? ''));
    $u = row("SELECT u.id FROM users u WHERE lower(u.email) = ? AND u.status = 'active' AND EXISTS (SELECT 1 FROM platform_roles r WHERE r.user_id = u.id)", [$email]);
    if (mb_strlen($secret) < 8) $error = 'Open the file unlock-reset in File Manager, type a secret word of at least 8 characters into it, save, then try again.';
    elseif (!hash_equals($secret, $word)) {
        @unlink($unlock);
        audit('security.reset_page_wrong_word', ['ip' => client_ip()]);
        $error = 'That word does not match the one in the unlock file, so the page has locked itself. Create the unlock file again to retry.';
    }
    elseif (!$u) $error = 'That email is not a TicketRoom staff account. Customers and organisers reset their password with "Forgot password?" on the sign-in screen.';
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
<h1>Reset an admin or staff password</h1>
<?php if ($done): ?>
  <p class="callout good" role="status"><?= $e($done) ?></p>
  <a class="btn btn-primary" href="/signin">Sign in</a>
<?php else: ?>
  <p class="muted mb-0">For TicketRoom staff accounts. Everyone signed in with the account is signed out. This page locks itself 30 minutes after the unlock file was made.</p>
  <?php if ($error): ?><p class="callout bad" role="alert"><?= $e($error) ?></p><?php endif; ?>
  <form method="post" class="stack" autocomplete="off">
    <div class="field"><label for="uw">Secret word from the unlock file</label><input id="uw" name="unlock" type="password" required autocomplete="off"><span class="hint">The word you typed into public_html/data/unlock-reset.</span></div>
    <div class="field"><label for="em">Account email</label><input id="em" name="email" type="email" required value="<?= $e($email) ?>"></div>
    <div class="field"><label for="pw">New password</label><input id="pw" name="password" type="password" minlength="10" required autocomplete="new-password"><span class="hint">At least 10 characters.</span></div>
    <div class="field"><label for="pw2">New password again</label><input id="pw2" name="confirm" type="password" minlength="10" required autocomplete="new-password"></div>
    <button class="btn btn-primary btn-block">Set password</button>
  </form>
<?php endif; ?>
</div></main></body></html>
