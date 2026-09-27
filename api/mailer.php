<?php
/**
 * Ligcabho Le'Africa Residences — outgoing email.
 *
 * There are two ways out of this server:
 *
 *   php   — hand the message to the host's own mail server with mail().
 *           Nothing to configure, but many hosts refuse it, and the mail
 *           that does get out is often filed as spam.
 *   smtp  — talk to a real mailbox (the domain's own, or Gmail) over SMTP,
 *           signing in with its password. Slower by a second, and it works
 *           everywhere, which is why 'auto' prefers it when a host is set.
 *
 * No library: PHP's own sockets speak SMTP well enough, and a zip that
 * depends on Composer is a zip that stops working the day it is unzipped
 * somewhere else.
 */
declare(strict_types=1);

/* ------------------------------------------------------------------ *
 * Settings
 *
 * The mail block in config.php holds the defaults. Anything saved from
 * the admin portal (Messages → Setup) lives in the settings table and
 * wins, so the office can move to SMTP without editing PHP over FTP.
 * ------------------------------------------------------------------ */

function mail_settings(bool $reload = false): array {
    static $over = null;
    if ($over === null || $reload) {
        $over = [];
        try {
            $raw = db()->query("SELECT v FROM settings WHERE k = 'mail'")->fetchColumn();
            if (is_string($raw) && $raw !== '') $over = json_decode($raw, true) ?: [];
        } catch (Throwable $e) {
            $over = [];   // the table is not there yet: config.php alone, then.
        }
    }
    return $over;
}

/** One mail setting, the saved one if there is one, else config.php's. */
function mcfg(string $key) {
    $node = mail_settings();
    $found = true;
    foreach (explode('.', $key) as $part) {
        if (!is_array($node) || !array_key_exists($part, $node)) { $found = false; break; }
        $node = $node[$part];
    }
    if ($found && $node !== '' && $node !== null) return $node;
    return cfg('mail.' . $key);
}

/** Which way out this server is using, with 'auto' resolved. */
function mail_transport(): string {
    $t = (string) (mcfg('transport') ?: 'auto');
    if ($t === 'auto') return trim((string) mcfg('smtp.host')) !== '' ? 'smtp' : 'php';
    return $t === 'smtp' ? 'smtp' : 'php';
}

/* ------------------------------------------------------------------ *
 * Building the message
 * ------------------------------------------------------------------ */

/** RFC 2047 for a header that may hold anything but ASCII. */
function mime_header(string $text): string {
    return preg_match('/[^\x20-\x7E]/', $text)
        ? '=?UTF-8?B?' . base64_encode($text) . '?='
        : $text;
}

/** "Name <address>", with the name encoded if it needs it. */
function mime_address(string $email, string $name = ''): string {
    $name = trim($name);
    return $name === '' ? $email : mime_header($name) . ' <' . $email . '>';
}

/**
 * The HTML half of the message.
 *
 * Email clients are twenty years behind browsers, so: tables, inline
 * styles, no stylesheet. Plain text stays the source of truth; this is
 * the same words, laid out so a phone can read them.
 */
function mail_html(string $text, string $subject): string {
    $brand = '#f5951d';
    $ink   = '#221c18';

    $blocks = preg_split('/\n{2,}/', trim($text));
    $html   = '';
    foreach ($blocks as $block) {
        $lines = explode("\n", $block);
        $isList = true;
        foreach ($lines as $l) {
            if (trim($l) === '') continue;
            if (!preg_match('/^(\s*[-•*]\s+|\s{2,}\S|\s*\d+[.)]\s+)/', $l)) { $isList = false; break; }
        }
        if ($isList && count($lines) > 1) {
            /* A list, or the indented key: value blocks the letters use. */
            $html .= '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
                   . 'style="margin:0 0 18px;font-size:15px;line-height:1.65;color:' . $ink . '">';
            foreach ($lines as $l) {
                $clean = preg_replace('/^\s*[-•*]\s+/', '', trim($l));
                $html .= '<tr><td style="padding:2px 0">' . mail_linkify($clean) . '</td></tr>';
            }
            $html .= '</table>';
        } else {
            $html .= '<p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:' . $ink . '">'
                   . mail_linkify(implode("\n", $lines)) . '</p>';
        }
    }

    return '<!DOCTYPE html><html><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>' . htmlspecialchars($subject, ENT_QUOTES) . '</title></head>'
        . '<body style="margin:0;padding:0;background:#f7f4ef;">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        . 'style="background:#f7f4ef;padding:24px 12px;">'
        . '<tr><td align="center">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
        . 'style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;'
        . 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Arial,sans-serif;">'
        . '<tr><td style="background:' . $ink . ';padding:18px 26px;">'
        . '<span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.2px;">Ligcabho '
        . '<span style="color:' . $brand . '">Le\'Africa</span> Residences</span></td></tr>'
        . '<tr><td style="padding:26px;">' . $html . '</td></tr>'
        . '<tr><td style="padding:18px 26px;background:#faf7f3;border-top:1px solid #eee4d9;'
        . 'font-size:12px;line-height:1.7;color:#7b6f67;">'
        . htmlspecialchars((string) cfg('site.name'), ENT_QUOTES) . '<br>'
        . htmlspecialchars((string) cfg('site.phone'), ENT_QUOTES) . ' · '
        . '<a href="' . htmlspecialchars((string) cfg('site.url'), ENT_QUOTES) . '" '
        . 'style="color:#d97a08;text-decoration:none;">'
        . htmlspecialchars(preg_replace('#^https?://#', '', (string) cfg('site.url')), ENT_QUOTES) . '</a>'
        . '</td></tr></table></td></tr></table></body></html>';
}

/** Escape, keep the line breaks, and make links and addresses clickable. */
function mail_linkify(string $text): string {
    $out = htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
    $out = preg_replace('#(https?://[^\s<>"]+)#', '<a href="$1" style="color:#d97a08">$1</a>', $out);
    $out = preg_replace('#(?<![\w.@-])([\w.+-]+@[\w-]+\.[\w.-]+)#',
        '<a href="mailto:$1" style="color:#d97a08">$1</a>', $out);
    return nl2br($out, false);
}

/**
 * The headers and body of one message.
 *
 * Returns [headers array, body string]. With no attachment the message is
 * multipart/alternative (text and HTML); with one it is multipart/mixed
 * wrapped around that.
 */
function mail_compose(array $m): array {
    $subject  = (string) $m['subject'];
    $text     = rtrim((string) $m['text']) . "\n";
    $html     = $m['html'] ?? mail_html($text, $subject);
    $files    = $m['files'] ?? [];
    $domain   = preg_replace('/^.*@/', '', (string) mcfg('from')) ?: 'ligcabhoresidences.co.za';

    $alt  = 'alt-' . bin2hex(random_bytes(8));
    $mix  = 'mix-' . bin2hex(random_bytes(8));

    $altBody = "--$alt\r\n"
        . "Content-Type: text/plain; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($text), 76, "\r\n")
        . "--$alt\r\n"
        . "Content-Type: text/html; charset=UTF-8\r\n"
        . "Content-Transfer-Encoding: base64\r\n\r\n"
        . chunk_split(base64_encode($html), 76, "\r\n")
        . "--$alt--\r\n";

    if ($files) {
        $body = "--$mix\r\n"
              . "Content-Type: multipart/alternative; boundary=\"$alt\"\r\n\r\n"
              . $altBody;
        foreach ($files as $f) {
            $body .= "--$mix\r\n"
                . 'Content-Type: ' . ($f['type'] ?? 'application/octet-stream')
                . '; name="' . str_replace('"', '', $f['name']) . "\"\r\n"
                . "Content-Transfer-Encoding: base64\r\n"
                . 'Content-Disposition: attachment; filename="' . str_replace('"', '', $f['name']) . "\"\r\n\r\n"
                . chunk_split(base64_encode($f['data']), 76, "\r\n");
        }
        $body .= "--$mix--\r\n";
        $type = "multipart/mixed; boundary=\"$mix\"";
    } else {
        $body = $altBody;
        $type = "multipart/alternative; boundary=\"$alt\"";
    }

    $headers = [
        'Date'         => date('r'),
        'From'         => mime_address((string) mcfg('from'), (string) mcfg('from_name')),
        'Reply-To'     => (string) ($m['reply_to'] ?: mcfg('reply_to')),
        'Message-ID'   => '<' . bin2hex(random_bytes(12)) . '@' . $domain . '>',
        'MIME-Version' => '1.0',
        'Content-Type' => $type,
        'X-Mailer'     => 'Ligcabho',
        'Auto-Submitted' => 'auto-generated',
    ];
    return [$headers, $body];
}

/* ------------------------------------------------------------------ *
 * SMTP
 * ------------------------------------------------------------------ */

/** Read one reply, following the 250-continuation lines. */
function smtp_read($fp): string {
    $out = '';
    while (($line = fgets($fp, 1024)) !== false) {
        $out .= $line;
        if (strlen($line) < 4 || $line[3] !== '-') break;
    }
    return trim($out);
}

/** Send a command and check the reply starts with $expect. */
function smtp_cmd($fp, string $cmd, string $expect, string $label, ?string &$err): bool {
    if ($cmd !== '') fwrite($fp, $cmd . "\r\n");
    $reply = smtp_read($fp);
    if (strncmp($reply, $expect, strlen($expect)) !== 0) {
        $err = $label . ': ' . ($reply !== '' ? $reply : 'the server said nothing');
        return false;
    }
    return true;
}

/**
 * Deliver one message over SMTP.
 *
 * Returns true, or false with the server's own words in $err — those
 * words are what tells the office whether it is the password, the
 * sender address or the port.
 */
function smtp_deliver(string $toEmail, string $toName, array $headers, string $body, ?string &$err): bool {
    $host = trim((string) mcfg('smtp.host'));
    $port = (int) (mcfg('smtp.port') ?: 587);
    $sec  = strtolower((string) (mcfg('smtp.security') ?: 'tls'));   // tls | ssl | none
    $user = (string) mcfg('smtp.username');
    $pass = (string) mcfg('smtp.password');
    $wait = (int) (mcfg('smtp.timeout') ?: 20);

    if ($host === '') { $err = 'No SMTP server is set up.'; return false; }

    $target = ($sec === 'ssl' ? 'ssl://' : '') . $host . ':' . $port;
    /* Some cPanel boxes present a certificate for the server's own
       hostname rather than the domain. Turning the check off is the
       documented fix there, so it is a setting rather than a rebuild. */
    $verify = mcfg('smtp.verify');
    $verify = $verify === null ? true : (bool) $verify;
    $ctx = stream_context_create(['ssl' => [
        'SNI_enabled'       => true,
        'verify_peer'       => $verify,
        'verify_peer_name'  => $verify,
        'allow_self_signed' => !$verify,
    ]]);
    $fp = @stream_socket_client($target, $errNo, $errStr, $wait, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) {
        $err = "Could not reach $host on port $port" . ($errStr ? ": $errStr" : '')
             . '. Hosts often block outgoing mail ports — ask them to open it, or try port 465 with SSL.';
        return false;
    }
    stream_set_timeout($fp, $wait);

    $me = (string) (mcfg('smtp.helo') ?: (preg_replace('/^.*@/', '', (string) mcfg('from')) ?: 'localhost'));
    $ok = smtp_cmd($fp, '', '220', 'The server did not greet us', $err)
       && smtp_cmd($fp, 'EHLO ' . $me, '250', 'EHLO was refused', $err);

    if ($ok && $sec === 'tls') {
        $ok = smtp_cmd($fp, 'STARTTLS', '220', 'STARTTLS was refused', $err);
        if ($ok) {
            $crypto = @stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
            if (!$crypto) {
                $err = 'The encrypted connection could not be set up'
                     . ($verify ? ', usually because the server\'s certificate is for another name. '
                                . 'Untick "Check the certificate" and try again.' : '.');
                $ok = false;
            }
        }
        if ($ok) $ok = smtp_cmd($fp, 'EHLO ' . $me, '250', 'EHLO after STARTTLS was refused', $err);
    }

    if ($ok && $user !== '') {
        $ok = smtp_cmd($fp, 'AUTH LOGIN', '334', 'The server would not start a sign-in', $err)
           && smtp_cmd($fp, base64_encode($user), '334', 'The username was refused', $err)
           && smtp_cmd($fp, base64_encode($pass), '235', 'The password was refused', $err);
        if (!$ok && $err !== null && strpos($err, 'password was refused') !== false) {
            $err .= '. With Gmail this means an app password is needed, not the account password.';
        }
    }

    if ($ok) {
        $ok = smtp_cmd($fp, 'MAIL FROM:<' . mcfg('from') . '>', '250',
                'The sender address was refused (' . mcfg('from') . ')', $err)
           && smtp_cmd($fp, 'RCPT TO:<' . $toEmail . '>', '250', 'The recipient was refused', $err)
           && smtp_cmd($fp, 'DATA', '354', 'The server would not take the message', $err);
    }

    if ($ok) {
        $head = 'To: ' . mime_address($toEmail, $toName) . "\r\n"
              . 'Subject: ' . mime_header((string) $headers['__subject']) . "\r\n";
        foreach ($headers as $k => $v) {
            if ($k === '__subject') continue;
            $head .= $k . ': ' . $v . "\r\n";
        }
        /* A line of its own full stop would end the message early. */
        $data = preg_replace('/^\./m', '..', $head . "\r\n" . $body);
        fwrite($fp, $data . "\r\n.\r\n");
        $ok = smtp_cmd($fp, '', '250', 'The server did not accept the message', $err);
    }

    @fwrite($fp, "QUIT\r\n");
    @fclose($fp);
    return $ok;
}

/** Deliver one message through the host's own mail server. */
function php_mail_deliver(string $toEmail, string $toName, array $headers, string $body, ?string &$err): bool {
    if (!function_exists('mail')) { $err = 'This host has switched PHP\'s mail() off.'; return false; }
    $subject = mime_header((string) $headers['__subject']);
    $lines = [];
    foreach ($headers as $k => $v) {
        if ($k === '__subject') continue;
        $lines[] = $k . ': ' . $v;
    }
    $sent = @mail(mime_address($toEmail, $toName), $subject, $body, implode("\r\n", $lines),
        '-f' . mcfg('from'));
    if (!$sent) {
        $err = 'The host refused the message. This is nearly always the sender address: '
             . mcfg('from') . ' must be a real mailbox on this domain. '
             . 'Setting up SMTP under Messages → Setup fixes it for good.';
        return false;
    }
    return true;
}
