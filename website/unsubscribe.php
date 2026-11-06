<?php
declare(strict_types=1);
require __DIR__ . '/api/backend.php';
require __DIR__ . '/api/launch-mail.php';
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');
header("Content-Security-Policy: default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
$token = (string)($_POST['token'] ?? $_GET['token'] ?? '');
$valid = false; $done = false; $unavailable = false;
if (preg_match('/^[a-f0-9]{64}$/D', $token)) {
    try {
        $db = titopay_launch_db();
        $find = $db->prepare('SELECT opted_out FROM launch_recipients WHERE token = ?');
        $find->execute([$token]); $row = $find->fetch(PDO::FETCH_ASSOC);
        $valid = is_array($row);
        $done = $valid && (int)$row['opted_out'] === 1;
        if ($valid && $_SERVER['REQUEST_METHOD'] === 'POST') {
            // Token authorizes this one preference. GET does not change state,
            // so email security scanners cannot silently unsubscribe a user.
            $db->prepare('UPDATE launch_recipients SET opted_out = 1, updated_at = ? WHERE token = ?')->execute([gmdate('c'), $token]);
            $done = true;
        }
    } catch (Throwable $e) { $unavailable = true; http_response_code(503); }
}
if (!$valid && !$unavailable) http_response_code(400);
?>
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Launch email preferences | TitoPay</title><link rel="stylesheet" href="admin/launch-admin.css"></head><body><main><a href="/">TitoPay</a><section><?php if ($unavailable): ?><h1>Please try again shortly.</h1><p>We could not save your preference. Please retry or contact support@titopay.co.za.</p><?php elseif ($done): ?><h1>You’re unsubscribed.</h1><p>You will not receive further TitoPay launch announcements. This does not change your wallet or essential account messages.</p><?php elseif ($valid): ?><h1>Your email.<br>Your choice.</h1><p>Stop receiving TitoPay launch announcements.</p><form method="post"><input type="hidden" name="token" value="<?= htmlspecialchars($token, ENT_QUOTES, 'UTF-8') ?>"><button>Unsubscribe from launch emails</button></form><?php else: ?><h1>Check your email link.</h1><p>This link is invalid. Use the full unsubscribe link in your TitoPay email, or contact support@titopay.co.za.</p><?php endif; ?></section></main></body></html>
