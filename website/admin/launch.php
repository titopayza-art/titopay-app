<?php
declare(strict_types=1);
require __DIR__ . '/../api/backend.php';
require __DIR__ . '/../api/launch-mail.php';
titopay_start_admin_session();
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header("Content-Security-Policy: default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
if (empty($_SESSION['titopay_admin'])) { header('Location: index.php'); exit; }
if (strtolower((string)($_SESSION['titopay_admin_user']['role'] ?? '')) !== 'ceo') {
    http_response_code(403); exit('Only the CEO administrator can manage the launch announcement.');
}
function lh(string $s): string { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }
$notice = (string)($_SESSION['launch_notice'] ?? ''); unset($_SESSION['launch_notice']);
$error = ''; $db = titopay_launch_db();
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if (!titopay_csrf_valid()) throw new RuntimeException('Your form expired. Please reload and try again.');
        $action = (string)($_POST['action'] ?? '');
        if ($action === 'import') {
            $count = titopay_launch_import($db);
            $notice = $count . ' new unique waitlist addresses added. Existing delivery and unsubscribe records were preserved.';
        } elseif ($action === 'test') {
            $email = trim((string)($_POST['test_email'] ?? ''));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Enter a valid test email address.');
            if (!titopay_send_mail($email, '[TEST] ' . titopay_launch_subject(), titopay_launch_body(''), titopay_launch_html())) {
                throw new RuntimeException('The server did not accept the test message. Check your hosting mail configuration.');
            }
            $_SESSION['launch_test_at'] = time();
            $notice = 'Test accepted by the server mail system. Check the inbox and spam folder before sending a batch.';
        } elseif ($action === 'send') {
            if (empty($_POST['confirm_audience'])) throw new RuntimeException('Confirm the audience before sending.');
            if (time() - (int)($_SESSION['launch_test_at'] ?? 0) > 3600) throw new RuntimeException('Send a test email first (within the past hour).');
            $result = titopay_launch_batch($db);
            $notice = $result['accepted'] . ' accepted by the server mail system; ' . $result['failed'] . ' failed. Accepted does not mean delivered. Review delivery logs before the next batch.';
        } elseif ($action === 'suppress') {
            $email = strtolower(trim((string)($_POST['suppress_email'] ?? '')));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new RuntimeException('Enter a valid address to suppress.');
            $find = $db->prepare('SELECT email FROM launch_recipients WHERE email = ?'); $find->execute([$email]);
            if (!$find->fetchColumn()) {
                $db->prepare("INSERT INTO launch_recipients (email, token, status, opted_out, updated_at) VALUES (?, ?, 'pending', 1, ?)")->execute([$email, bin2hex(random_bytes(32)), gmdate('c')]);
            } else {
                $db->prepare('UPDATE launch_recipients SET opted_out = 1, updated_at = ? WHERE email = ?')->execute([gmdate('c'), $email]);
            }
            $notice = 'Address suppressed. Future imports will preserve this preference.';
        } else { throw new RuntimeException('Choose a valid action.'); }
        $_SESSION['launch_notice'] = $notice;
        header('Location: launch.php'); exit;
    } catch (Throwable $e) {
        $error = $e instanceof PDOException ? 'The campaign database could not be updated. Check server logs.' : $e->getMessage();
    }
}
$counts = $db->query('SELECT status, opted_out, COUNT(*) AS total FROM launch_recipients GROUP BY status, opted_out')->fetchAll(PDO::FETCH_ASSOC);
$recent = $db->query('SELECT email, status, opted_out, updated_at FROM launch_recipients ORDER BY updated_at DESC LIMIT 100')->fetchAll(PDO::FETCH_ASSOC);
?>
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Launch announcement | TitoPay admin</title><link rel="stylesheet" href="launch-admin.css"></head><body><main><a href="index.php">← Back to dashboard</a><p class="eyebrow">TITOPAY · LAUNCH COMMUNICATIONS</p><h1>Email the waitlist</h1><p>One launch announcement, sent privately to each address. Only the CEO administrator can send.</p>
<?php if ($notice): ?><p class="notice" role="status"><?= lh($notice) ?></p><?php endif; ?>
<?php if ($error): ?><p class="error" role="alert"><?= lh($error) ?></p><?php endif; ?>
<section><h2>1. Prepare the audience</h2><p>Import all existing general wallet waitlist records. Emails are deduplicated. Contact forms, job applicants and event-only registrations are excluded. Imports never reset send history or opt-outs.</p><form method="post"><?= titopay_csrf_field() ?><input type="hidden" name="action" value="import"><button>Import / refresh waitlisters</button></form><ul><?php foreach ($counts as $c): ?><li><?= lh($c['opted_out'] ? 'Suppressed' : ucfirst($c['status'])) ?>: <?= (int)$c['total'] ?></li><?php endforeach; ?></ul></section>
<section><h2>2. Preview and send a test</h2><p><strong>Subject:</strong> <?= lh(titopay_launch_subject()) ?></p><iframe title="Launch email design" sandbox srcdoc="<?= lh(titopay_launch_html()) ?>" style="width:100%;height:850px;border:1px solid #cbd5ed;background:#edf1fb"></iframe><form method="post"><?= titopay_csrf_field() ?><input type="hidden" name="action" value="test"><label>Test email address<input name="test_email" type="email" required maxlength="180"></label><button>Send test email</button></form><p>Check that links work, the message reaches the inbox and your host is configured for authenticated email from titopay.co.za.</p></section>
<section><h2>3. Send the next 20</h2><p>Each click processes up to 20 pending addresses. Refreshing will not send again. Accepted, failed and interrupted messages are excluded from future batches. This tool does not automatically retry or claim inbox delivery.</p><form method="post"><?= titopay_csrf_field() ?><input type="hidden" name="action" value="send"><label class="check"><input type="checkbox" name="confirm_audience" required> I checked the test email and this audience is eligible to receive the launch announcement, including any existing opt-outs.</label><button>Send next batch of up to 20 emails</button></form></section>
<section><h2>Suppress an address</h2><p>Add existing opt-outs before your first batch. Recipients can also use their personal unsubscribe link.</p><form method="post"><?= titopay_csrf_field() ?><input type="hidden" name="action" value="suppress"><label>Email address<input name="suppress_email" type="email" required maxlength="180"></label><button>Suppress address</button></form></section>
<section><h2>Latest 100 recipient records</h2><div class="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Updated (UTC)</th></tr></thead><tbody><?php foreach ($recent as $r): ?><tr><td><?= lh($r['email']) ?></td><td><?= lh($r['opted_out'] ? 'suppressed' : $r['status']) ?></td><td><?= lh($r['updated_at']) ?></td></tr><?php endforeach; ?></tbody></table></div><p>Processing means a send may have been interrupted. Failed means the server rejected the attempt. Review hosting mail logs before any manual retry; the dashboard does not retry these addresses.</p></section></main></body></html>
