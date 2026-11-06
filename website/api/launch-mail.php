<?php
declare(strict_types=1);

// Separate from wallet services: one fixed announcement, one recipient per email.
function titopay_launch_db(): PDO
{
    $db = titopay_db();
    $db->exec("CREATE TABLE IF NOT EXISTS launch_recipients (
        email VARCHAR(180) PRIMARY KEY,
        token VARCHAR(64) NOT NULL UNIQUE,
        status VARCHAR(24) NOT NULL DEFAULT 'pending',
        opted_out INTEGER NOT NULL DEFAULT 0,
        updated_at VARCHAR(40) NOT NULL
    )");
    return $db;
}

function titopay_launch_import(PDO $db): int
{
    // No contacts, applicants or event-only registrations are included.
    $rows = $db->query("SELECT DISTINCT LOWER(TRIM(email)) AS email FROM public_submissions
        WHERE form_type = 'waitlist' AND LOWER(COALESCE(context,'')) NOT LIKE 'events%'")->fetchAll(PDO::FETCH_ASSOC);
    $find = $db->prepare('SELECT email FROM launch_recipients WHERE email = ?');
    $insert = $db->prepare("INSERT INTO launch_recipients (email, token, status, opted_out, updated_at) VALUES (?, ?, 'pending', 0, ?)");
    $count = 0;
    foreach ($rows as $row) {
        $email = (string)$row['email'];
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 180) continue;
        $find->execute([$email]);
        if ($find->fetchColumn()) continue;
        try {
            $insert->execute([$email, bin2hex(random_bytes(32)), gmdate('c')]);
            $count++;
        } catch (PDOException $e) {
            // A concurrent import may already have added it. Other errors must surface.
            $find->execute([$email]);
            if (!$find->fetchColumn()) throw $e;
        }
    }
    return $count;
}

function titopay_launch_subject(): string
{
    return 'TitoPay is now available';
}

function titopay_launch_body(string $unsubscribe): string
{
    return "Hi there,\n\nYou asked to hear when TitoPay was ready. The app is now available.\n\n"
        . "TitoPay is a digital wallet for personal and business payments in South Africa.\n\n"
        . "Zero signup fees.\nZero monthly wallet fees.\nNo fee for transfers between TitoPay wallets.\n\n"
        . "Create your wallet today:\nhttps://app.titopay.co.za\n\n"
        . "Choose Create Account for a personal wallet, or select Business to create a business account. Follow the setup steps in the app. Joining the waitlist did not create a wallet for you.\n\n"
        . "Keep TitoPay one tap away. Open the app in Safari on iPhone or Chrome on Android and add it to your home screen. No app store needed.\nPhone setup guide: https://titopay.co.za/install\n\n"
        . "Other service fees may apply. Review them in the app before confirming. Wallet services require an internet connection.\n\n"
        . "Need a hand? https://titopay.co.za/contact\nNever share your PIN, password or verification code.\n\n"
        . "The TitoPay team\nTitoPay (Pty) Ltd\n\n"
        . "You received this one-time launch announcement because you joined the TitoPay waitlist.\n";
}

function titopay_launch_html(): string
{
    return (string)file_get_contents(__DIR__ . '/launch-email.html');
}

function titopay_launch_batch(PDO $db): array
{
    if (empty(titopay_config()['mail_enabled']) || !function_exists('mail')) {
        throw new RuntimeException('Server email is disabled or unavailable. No recipients were processed.');
    }
    $rows = $db->query("SELECT email, token FROM launch_recipients WHERE status = 'pending' AND opted_out = 0 ORDER BY email LIMIT 20")->fetchAll(PDO::FETCH_ASSOC);
    // Reserve each address atomically BEFORE sending. Interrupted/ambiguous sends
    // stay 'processing' for manual delivery-log review; never auto-retry them.
    $claim = $db->prepare("UPDATE launch_recipients SET status = 'processing', updated_at = ? WHERE email = ? AND status = 'pending' AND opted_out = 0");
    $finish = $db->prepare("UPDATE launch_recipients SET status = ?, updated_at = ? WHERE email = ?");
    $sent = 0; $failed = 0;
    foreach ($rows as $row) {
        $claim->execute([gmdate('c'), $row['email']]);
        if ($claim->rowCount() !== 1) continue;
        $url = 'https://titopay.co.za/unsubscribe.php?token=' . rawurlencode($row['token']);
        $ok = titopay_send_mail($row['email'], titopay_launch_subject(), titopay_launch_body($url), titopay_launch_html(), [
            // Not shown in the email body: mail apps (Gmail, Outlook, Apple Mail)
            // render their own "Unsubscribe" control from this header, and Gmail and
            // Yahoo expect it on bulk mail. The link opens the existing opt-out page.
            'List-Unsubscribe' => '<' . $url . '>, <mailto:' . (string)(titopay_config()['mail_from'] ?? 'support@titopay.co.za') . '?subject=unsubscribe>',
        ]);
        $finish->execute([$ok ? 'accepted' : 'failed', gmdate('c'), $row['email']]);
        if ($ok) $sent++; else $failed++;
    }
    return ['accepted' => $sent, 'failed' => $failed];
}
