<?php
// Messaging: outbox queue, delivery (SMTP, PHP mail() or log), templates,
// branded HTML rendering, the back-office catalogue and automated emails.
declare(strict_types=1);

// ============================================================== outbox
function outbox_enqueue(array $m): ?string
{
    if (empty($m['to'])) return null;
    $id = uuid();
    q('INSERT OR IGNORE INTO message_outbox (id, channel, kind, to_address, subject, body, campaign_id, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [$id, $m['channel'] ?? 'email', $m['kind'] ?? 'transactional', $m['to'], $m['subject'] ?? null, $m['body'], $m['campaignId'] ?? null, $m['userId'] ?? null, now_iso()]);
    $GLOBALS['TR_OUTBOX_DIRTY'] = true;
    return $id;
}
function mail_mode(): string
{
    // 'auto' (the default): send through the mailbox once its password is set.
    $mode = (string) cfg('mail.mode', 'auto');
    if ($mode !== 'auto' && $mode !== '') return $mode;
    return cfg('mail.smtpHost') && (string) cfg('mail.smtpPass', '') !== '' ? 'smtp' : 'mail';
}
// Sends one batch. Marketing is re-checked against consent at send time.
function outbox_deliver(int $limit = 25): int
{
    $claimed = tx(function () use ($limit) {
        $list = rows("SELECT o.*, c.organiser_id FROM message_outbox o LEFT JOIN campaigns c ON c.id = o.campaign_id
                       WHERE o.status = 'queued' AND o.attempts < 5 ORDER BY o.created_at LIMIT $limit");
        foreach ($list as $m) q('UPDATE message_outbox SET attempts = attempts + 1 WHERE id = ?', [$m['id']]);
        return $list;
    });
    $sent = 0;
    foreach ($claimed as $m) {
        try {
            if ($m['kind'] === 'marketing') {
                $g = val("SELECT granted FROM marketing_consents WHERE user_id = ? AND COALESCE(organiser_id,'') = COALESCE(?,'') AND channel = ?", [$m['user_id'], $m['organiser_id'], $m['channel']]);
                if (!$g) { q("UPDATE message_outbox SET status = 'suppressed', last_error = 'consent withdrawn' WHERE id = ?", [$m['id']]); continue; }
            }
            if ($m['channel'] !== 'email') throw new RuntimeException('SMS is not configured in this edition');
            $mode = mail_mode();
            $msgId = send_email($mode, $m['to_address'], (string) ($m['subject'] ?: 'TicketRoom'), $m['body']);
            q("UPDATE message_outbox SET status = 'sent', provider = ?, provider_message_id = ?, sent_at = ?, last_error = NULL WHERE id = ?", [$mode, $msgId, now_iso(), $m['id']]);
            if ($m['campaign_id']) q('UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = ?', [$m['campaign_id']]);
            $sent++;
        } catch (Throwable $e) {
            $final = $m['attempts'] + 1 >= 5;
            q('UPDATE message_outbox SET status = ?, last_error = ? WHERE id = ?', [$final ? 'failed' : 'queued', substr($e->getMessage(), 0, 300), $m['id']]);
            if ($final && $m['campaign_id']) q('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?', [$m['campaign_id']]);
        }
    }
    return $sent;
}

// ============================================================== delivery
function mail_from(): array { return [(string) cfg('mail.fromEmail', 'hello@ticketroom.co.za'), (string) cfg('mail.fromName', 'TicketRoom')]; }
function mime_header(string $s): string { return preg_match('/[^\x20-\x7e]/', $s) ? '=?UTF-8?B?' . base64_encode($s) . '?=' : $s; }
function build_mime(string $to, string $subject, string $text): array
{
    [$fromEmail, $fromName] = mail_from();
    $boundary = 'tr-' . bin2hex(random_bytes(12));
    $domain = substr(strrchr($fromEmail, '@') ?: '@ticketroom.co.za', 1);
    $msgId = '<' . bin2hex(random_bytes(12)) . '@' . $domain . '>';
    $headers = [
        'From' => mime_header($fromName) . " <$fromEmail>",
        'Reply-To' => $fromEmail,
        'Date' => date(DATE_RFC2822),
        'Message-ID' => $msgId,
        'MIME-Version' => '1.0',
        'Content-Type' => "multipart/alternative; boundary=\"$boundary\"",
    ];
    $html = email_html($subject, $text);
    $body = "--$boundary\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($text))
        . "--$boundary\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" . chunk_split(base64_encode($html))
        . "--$boundary--\r\n";
    return [$headers, $body, $msgId];
}
function send_email(string $mode, string $to, string $subject, string $text): string
{
    if (!preg_match('/^[^\s@<>()"\',;:\r\n]+@[A-Za-z0-9.-]+$/', $to)) throw new RuntimeException('invalid recipient');
    [$headers, $body, $msgId] = build_mime($to, $subject, $text);
    if ($mode === 'log') {
        $line = json_encode(['at' => now_iso(), 'to' => $to, 'subject' => $subject], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        @file_put_contents(data_dir() . '/mail.log', $line . "\n", FILE_APPEND | LOCK_EX);
        return 'log';
    }
    if ($mode === 'mail') {
        $h = '';
        foreach ($headers as $k => $v) $h .= "$k: $v\r\n";
        $ok = mail($to, mime_header($subject), $body, rtrim($h), '-f' . mail_from()[0]);
        if (!$ok) throw new RuntimeException('PHP mail() refused the message');
        return $msgId;
    }
    smtp_send($to, $subject, $headers, $body);
    return $msgId;
}
// Minimal SMTP client: implicit TLS (465) or STARTTLS (587/25), AUTH LOGIN.
// One SMTP connection is kept open for the whole delivery run (a big match
// sends tens of thousands of tickets; logging in for every email is slow and
// mail servers throttle it). It is closed at the end of the request.
function smtp_send(string $to, string $subject, array $headers, string $body): void
{
    static $conn = null;
    if ($conn) {
        try { smtp_message($conn, $to, $subject, $headers, $body); return; }
        catch (RuntimeException $e) { if (!str_starts_with($e->getMessage(), 'SMTP link')) { smtp_reset($conn); throw $e; } @fclose($conn['fp']); $conn = null; }
    }
    $conn = smtp_open();
    register_shutdown_function(function () use (&$conn) { if ($conn) { @fwrite($conn['fp'], "QUIT\r\n"); @fclose($conn['fp']); $conn = null; } });
    try { smtp_message($conn, $to, $subject, $headers, $body); }
    catch (RuntimeException $e) { smtp_reset($conn); throw $e; }
}
function smtp_cmd(array $c, ?string $line, array $ok): string
{
    $fp = $c['fp'];
    if ($line !== null && @fwrite($fp, $line . "\r\n") === false) throw new RuntimeException('SMTP link lost');
    $data = '';
    while (($l = fgets($fp, 1024)) !== false) { $data .= $l; if (strlen($l) < 4 || $l[3] !== '-') break; }
    if ($data === '') throw new RuntimeException('SMTP link lost');
    if (!in_array((int) substr($data, 0, 3), $ok, true)) throw new RuntimeException('SMTP: ' . trim(preg_replace('/\s+/', ' ', $data)));
    return $data;
}
function smtp_open(): array
{
    $host = (string) cfg('mail.smtpHost');
    $port = (int) cfg('mail.smtpPort', 465);
    $user = (string) cfg('mail.smtpUser');
    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true]]);
    $fp = @stream_socket_client(($port === 465 ? 'ssl://' : 'tcp://') . "$host:$port", $errno, $err, 15, STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) throw new RuntimeException("SMTP connect failed: $err");
    stream_set_timeout($fp, 20);
    $c = ['fp' => $fp];
    try {
        smtp_cmd($c, null, [220]);
        $ehlo = 'EHLO ' . (parse_url(base_url(), PHP_URL_HOST) ?: 'localhost');
        $caps = smtp_cmd($c, $ehlo, [250]);
        if ($port !== 465 && stripos($caps, 'STARTTLS') !== false) {
            smtp_cmd($c, 'STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) throw new RuntimeException('SMTP TLS failed');
            smtp_cmd($c, $ehlo, [250]);
        }
        if ($user !== '') {
            smtp_cmd($c, 'AUTH LOGIN', [334]);
            smtp_cmd($c, base64_encode($user), [334]);
            smtp_cmd($c, base64_encode((string) cfg('mail.smtpPass')), [235]);
        }
    } catch (Throwable $e) { @fclose($fp); throw $e; }
    return $c;
}
function smtp_message(array $c, string $to, string $subject, array $headers, string $body): void
{
    smtp_cmd($c, 'MAIL FROM:<' . mail_from()[0] . '>', [250]);
    smtp_cmd($c, "RCPT TO:<$to>", [250, 251]);
    smtp_cmd($c, 'DATA', [354]);
    $h = "To: $to\r\nSubject: " . mime_header($subject) . "\r\n";
    foreach ($headers as $k => $v) $h .= "$k: $v\r\n";
    $data = preg_replace('/^\./m', '..', $h . "\r\n" . $body);
    smtp_cmd($c, $data . "\r\n.", [250]);
}
// After a refused recipient, clear the half-started message so the same
// connection can carry on with the next email.
function smtp_reset(array $c): void
{
    try { smtp_cmd($c, 'RSET', [250]); } catch (Throwable) {}
}
function smtp_health(): array
{
    if (mail_mode() !== 'smtp') return ['ok' => mail_mode() !== 'log', 'detail' => mail_mode() === 'mail' ? 'Using the hosting server\'s built-in mail (PHP mail()). Add the hello@ mailbox SMTP details for better delivery.' : 'Emails are only logged, not sent.'];
    try {
        $fp = @stream_socket_client(((int) cfg('mail.smtpPort', 465) === 465 ? 'ssl://' : 'tcp://') . cfg('mail.smtpHost') . ':' . cfg('mail.smtpPort', 465), $no, $err, 8);
        if (!$fp) return ['ok' => false, 'detail' => "SMTP: $err"];
        fclose($fp);
        return ['ok' => true, 'detail' => 'SMTP server reachable (' . cfg('mail.smtpHost') . ')'];
    } catch (Throwable $e) {
        return ['ok' => false, 'detail' => 'SMTP: ' . $e->getMessage()];
    }
}

// ============================================================== HTML version
// "Label: https://…" alone on a line -> button; "- " lines -> bullets;
// everything after the "-- " line -> footer.
function email_html(string $subject, string $text): string
{
    $esc = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
    $linkify = fn($s) => preg_replace_callback('#https?://[^\s<]+[^\s<.,;:!?)]#', fn($m) => '<a href="' . $m[0] . '" style="color:#1B3770">' . $m[0] . '</a>', $esc($s));
    $parts = preg_split("/\n\n-- \n/u", $text, 2);
    $main = $parts[0];
    $footer = $parts[1] ?? '';
    $blocks = '';
    foreach (preg_split("/\n{2,}/", $main) as $block) {
        $lines = explode("\n", $block);
        if (count($lines) === 1 && preg_match('/^([^:\n]{2,40}): (https?:\/\/\S+)$/u', $lines[0], $m)) {
            $blocks .= '<p style="margin:24px 0"><a href="' . $esc($m[2]) . '" style="background:#F2A93B;color:#0B1D3F;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">' . $esc($m[1]) . '</a></p>';
            continue;
        }
        $bullets = array_values(array_filter($lines, fn($l) => str_starts_with($l, '- ')));
        if ($bullets && count($bullets) >= count($lines) - 1) {
            if (count($lines) > count($bullets)) $blocks .= '<p style="margin:16px 0 6px">' . $linkify($lines[0]) . '</p>';
            $blocks .= '<ul style="margin:0 0 16px;padding-left:20px">' . implode('', array_map(fn($l) => '<li style="margin:4px 0">' . $linkify(substr($l, 2)) . '</li>', $bullets)) . '</ul>';
            continue;
        }
        $blocks .= '<p style="margin:0 0 16px">' . implode('<br>', array_map($linkify, $lines)) . '</p>';
    }
    $foot = implode('<br>', array_map($linkify, explode("\n", $footer)));
    return '<!doctype html><html lang="en-ZA"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' . $esc($subject) . '</title></head>'
        . '<body style="margin:0;padding:0;background:#F5F7FB;font-family:Arial,Helvetica,sans-serif;color:#0E1A30">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FB"><tr><td align="center" style="padding:24px 12px">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">'
        . '<tr><td style="background:#0B1D3F;padding:20px 28px;font-size:22px;font-weight:800;letter-spacing:1px;color:#ffffff">TICKET<span style="color:#F2A93B">ROOM</span><div style="font-size:11px;font-weight:600;letter-spacing:3px;color:#AFC0DD;margin-top:4px">YOUR EVENT. YOUR TICKET.</div></td></tr>'
        . '<tr><td style="padding:28px;font-size:15px;line-height:1.55">' . $blocks . '</td></tr>'
        . '<tr><td style="padding:16px 28px;background:#EEF1F6;font-size:12px;color:#5E6C84;line-height:1.5">' . $foot . '</td></tr>'
        . '</table></td></tr></table></body></html>';
}

// ============================================================== templates
const FOOTER = "\n\n-- \nTicketRoom · ticketroom.co.za · hello@ticketroom.co.za\nTicketRoom (Pty) Ltd · Reg. no. K2026811077";
function sa_time(?string $iso, string $fmt): string
{
    $d = new DateTimeImmutable($iso ?: 'now');
    return $d->setTimezone(new DateTimeZone('Africa/Johannesburg'))->format($fmt);
}
function when_str(?string $iso): string { return sa_time($iso, 'l, j F Y \a\t H:i'); }
function time_str(?string $iso): string { return sa_time($iso, 'H:i'); }
function first_name(?string $n): string { $p = preg_split('/\s+/', trim((string) $n)); return ($p[0] ?? '') !== '' ? $p[0] : 'there'; }
function plural(int $n, string $w): string { return $n . ' ' . $w . ($n === 1 ? '' : 's'); }
function place(array $e): string { return implode(', ', array_filter([$e['venue_name'] ?? null, $e['address'] ?? null, $e['city'] ?? null])); }

// Same wording as src/modules/messaging/templates.js in the Node edition.
function tpl(string $name, array $a): array
{
    $B = base_url();
    $hi = 'Hi ' . first_name($a['name'] ?? ($a['order']['buyer_name'] ?? null)) . ",\n\n";
    switch ($name) {
        case 'orderConfirmed':
            $o = $a['order']; $e = $a['event']; $n = (int) $a['ticketCount']; $free = (int) $o['total_cents'] === 0; $isAre = $n === 1 ? 'is' : 'are';
            return [
                'subject' => $free ? 'Your free ' . ($n === 1 ? 'ticket' : 'tickets') . " for {$e['title']}" : "Your tickets for {$e['title']} ({$o['reference']})",
                'body' => $hi . ($free ? "You're booked for {$e['title']}. Your " . plural($n, 'free ticket') . " $isAre waiting in your TicketRoom account."
                                       : 'Thanks for your order. Your ' . plural($n, 'ticket') . " for {$e['title']} $isAre ready.")
                    . "\n\n" . place($e) . "\n" . when_str($e['starts_at']) . "\nOrder {$o['reference']}" . ($free ? '' : ' · ' . format_zar((int) $o['total_cents']))
                    . "\n\nOpen my tickets: $B/account#/tickets\n\nYour QR code is your way in, so please don't share it. If someone else scans it first, you won't get in."
                    . ($free ? "\n\nIf you can't make it after all, you can pass your ticket to a friend from My tickets." : '') . FOOTER,
            ];
        case 'eventReminder':
            $e = $a['event']; $soon = !empty($a['soon']); $n = (int) $a['ticketCount'];
            $tips = ["- Open your tickets before you leave home. They'll still work if the signal at the venue is bad.", '- Turn your screen brightness up so the QR code scans first time.', '- Each ticket lets one person in, once.'];
            if (!empty($e['age_restriction'])) $tips[] = "- This event is {$e['age_restriction']}, so bring ID.";
            if (!empty($e['transfers_enabled'])) $tips[] = "- Can't go? Send your ticket to a friend before the event starts.";
            return [
                'subject' => $soon ? "{$e['title']} starts at " . time_str($e['starts_at']) : "{$e['title']} is tomorrow",
                'body' => $hi . ($soon ? "{$e['title']} starts at " . time_str($e['starts_at']) . ' today.' : "{$e['title']} is tomorrow.") . ' You have ' . plural($n, 'ticket') . ".\n\n"
                    . when_str($e['starts_at']) . "\n" . place($e) . "\n\nOpen my tickets: $B/account#/tickets\n\nA few things that help at the gate:\n" . implode("\n", $tips) . "\n\nEnjoy it!" . FOOTER,
            ];
        case 'checkoutAbandoned':
            $e = $a['event'];
            return ['subject' => "Still want to go to {$e['title']}?",
                'body' => $hi . "You started booking tickets for {$e['title']} but didn't finish, so we couldn't hold them for you. There are still tickets available.\n\n"
                    . when_str($e['starts_at']) . "\n" . place($e) . "\n\nFinish my booking: {$a['eventUrl']}\n\nIf something went wrong at checkout, ask us to call you back at $B/contact and we'll sort it out.\n\nThis is the only reminder we'll send about it. To stop emails like this, unsubscribe here: {$a['unsubscribeUrl']}" . FOOTER];
        case 'eventCancelled':
            $e = $a['event'];
            return ['subject' => "{$e['title']} has been cancelled",
                'body' => $hi . "We're sorry to tell you that the organiser has cancelled {$e['title']}, which was set for " . when_str($e['starts_at']) . '.'
                    . (!empty($a['reason']) ? "\n\nThe reason they gave: {$a['reason']}" : '') . "\n\n"
                    . (!empty($a['paid']) ? "You don't need to do anything. We've started a full refund, booking fee included, to the card or account you paid with. It usually shows within 3 to 7 working days." : "Your free tickets have been cancelled, so there's nothing you need to do.")
                    . "\n\nSee what else is on: $B/" . FOOTER];
        case 'transferOffer':
            $e = $a['event'];
            return ['subject' => "{$a['fromName']} sent you a ticket for {$e['title']}",
                'body' => "{$a['fromName']} has sent you a ticket for {$e['title']} on " . when_str($e['starts_at']) . ".\n\nAccept the ticket: {$a['claimUrl']}\n\nThe link works for 7 days. You'll need a TicketRoom account to accept it, and signing up is free." . FOOTER];
        case 'transferDone':
            return ['subject' => "Your ticket for {$a['event']['title']} has been accepted",
                'body' => "{$a['toEmail']} has accepted the ticket you sent for {$a['event']['title']}. The QR code on your copy no longer works." . FOOTER];
        case 'verifyEmail':
            return ['subject' => 'Please confirm your email address',
                'body' => $hi . "Thanks for signing up to TicketRoom. Please confirm your email address so your tickets and updates reach you.\n\nConfirm my email: {$a['url']}\n\nIf you didn't create a TicketRoom account, you can ignore this email." . FOOTER];
        case 'passwordReset':
            return ['subject' => 'Reset your TicketRoom password',
                'body' => $hi . "Someone, hopefully you, asked to reset the password on your TicketRoom account. This link works for one hour.\n\nChoose a new password: {$a['url']}\n\nIf it wasn't you, ignore this email and your password will stay the same." . FOOTER];
        case 'callbackReceived':
            return ['subject' => "We've got your callback request ({$a['reference']})",
                'body' => $hi . "Thanks for getting in touch. Your reference is {$a['reference']}, and someone from our team will get back to you within {$a['responseTime']}.\n\nOur office hours: {$a['hoursNote']}\n\nIf there's anything to add, reply to this email or write to {$a['email']} and mention {$a['reference']}." . FOOTER];
        case 'unsubscribeLink':
            return ['subject' => 'Unsubscribe from TicketRoom marketing',
                'body' => $hi . "You asked to stop getting marketing emails from TicketRoom and the organisers you follow. Please confirm below. The link works for 7 days.\n\nConfirm unsubscribe: {$a['url']}\n\nWe'll still email you about tickets you already have. If you didn't ask for this, you can ignore this email." . FOOTER];
        case 'organiserApproved':
            return ['subject' => "{$a['organiser']} is approved on TicketRoom",
                'body' => $hi . "{$a['organiser']} has been approved. You can now send your events to us for review, and email people who asked to hear from you.\n\nGo to the organiser portal: $B/organisers\n\nFor now, free events are listed at no cost. Paid ticket sales are coming soon.\n\nIf you'd like a hand setting up your first event, ask us to call you at $B/contact." . FOOTER];
        case 'organiserRejected':
            return ['subject' => 'About your TicketRoom organiser application',
                'body' => $hi . "Thanks for applying to list events on TicketRoom as {$a['organiser']}. We can't approve the application at this stage."
                    . (!empty($a['reason']) ? "\n\nReason: {$a['reason']}" : '') . "\n\nIf you can send us more information, reply to this email or ask us to call you at $B/contact." . FOOTER];
        case 'eventPublished':
            return ['subject' => "Your event is live: {$a['event']['title']}",
                'body' => $hi . "{$a['event']['title']} has been approved and is now live on TicketRoom.\n\nSee the event page: {$a['eventUrl']}\n\nA few next steps:\n- Share the link on your socials and in your WhatsApp groups.\n- Make a tracking link for each place you share it, so you can see what works.\n- Add your door staff under Staff so they can scan tickets on their phones." . FOOTER];
        case 'eventChangesRequested':
            return ['subject' => "Changes needed before {$a['event']['title']} can go live",
                'body' => $hi . "We've looked at {$a['event']['title']} and need a few changes before we can publish it.\n\n"
                    . (!empty($a['reason']) ? "What to change: {$a['reason']}\n\n" : '') . "Edit my event: $B/organisers#/events/{$a['event']['id']}\n\nOnce you've made the changes, send it to us again and we'll take another look." . FOOTER];
        case 'staffInvite':
            return ['subject' => "{$a['organiser']} added you as a ticket scanner on TicketRoom",
                'body' => $hi . "{$a['organiser']} has added you as a ticket scanner for {$a['event']}. Set a password to get started. The link works for 7 days.\n\nSet my password: {$a['url']}\n\nOn the day, open ticketroom.co.za/scan on your phone, sign in, and point the camera at each ticket." . FOOTER];
    }
    throw new InvalidArgumentException("Unknown template $name");
}

// Every email the PHP edition sends, with sample data for previews.
function email_catalog(): array
{
    $B = base_url();
    $d = new DateTimeImmutable('tomorrow 19:00', new DateTimeZone('Africa/Johannesburg'));
    $ev = ['id' => '00000000-0000-0000-0000-000000000000', 'title' => 'Soweto Sunset Sessions', 'slug' => 'soweto-sunset-sessions', 'starts_at' => iso_at((float) $d->format('U')),
        'venue_name' => 'Orlando Amphitheatre', 'address' => 'Mooki St, Orlando East', 'city' => 'Soweto', 'age_restriction' => '18+', 'transfers_enabled' => true];
    $today = $ev + []; $today['starts_at'] = iso_at((float) (new DateTimeImmutable('today 19:00', new DateTimeZone('Africa/Johannesburg')))->format('U'));
    $o = ['buyer_name' => 'Lerato Mokoena', 'reference' => 'TR-7KQ2M9', 'total_cents' => 0];
    return [
        ['key' => 'orderConfirmedFree', 'name' => 'Free tickets confirmed', 'audience' => 'Attendee', 'trigger' => 'Right after someone gets free tickets', 'sample' => fn() => tpl('orderConfirmed', ['order' => $o, 'event' => $ev, 'ticketCount' => 2])],
        ['key' => 'eventReminderDay', 'name' => 'Event reminder: day before', 'audience' => 'Attendee', 'trigger' => 'Automatic, about 24 hours before the event starts', 'setting' => 'reminderDayBefore', 'sample' => fn() => tpl('eventReminder', ['name' => 'Lerato Mokoena', 'event' => $ev, 'ticketCount' => 2, 'soon' => false])],
        ['key' => 'eventReminderSoon', 'name' => 'Event reminder: starting soon', 'audience' => 'Attendee', 'trigger' => 'Automatic, within 3 hours of the start', 'setting' => 'reminderSoon', 'sample' => fn() => tpl('eventReminder', ['name' => 'Lerato Mokoena', 'event' => $today, 'ticketCount' => 2, 'soon' => true])],
        ['key' => 'checkoutAbandoned', 'name' => 'Abandoned checkout', 'audience' => 'Attendee', 'trigger' => 'Automatic, once, after an unfinished booking (delay set below)', 'setting' => 'abandonedCheckout', 'sample' => fn() => tpl('checkoutAbandoned', ['name' => 'Lerato Mokoena', 'event' => $ev, 'eventUrl' => "$B/events/soweto-sunset-sessions", 'unsubscribeUrl' => "$B/unsubscribe?t=sample"])],
        ['key' => 'eventCancelled', 'name' => 'Event cancelled', 'audience' => 'Attendee', 'trigger' => 'When an event is cancelled', 'sample' => fn() => tpl('eventCancelled', ['name' => 'Lerato Mokoena', 'event' => $ev, 'reason' => 'Severe weather warning for the venue', 'paid' => false])],
        ['key' => 'transferOffer', 'name' => 'Ticket transfer received', 'audience' => 'Attendee', 'trigger' => 'When someone sends a ticket', 'sample' => fn() => tpl('transferOffer', ['fromName' => 'Thabo Nkosi', 'event' => $ev, 'claimUrl' => "$B/account#/claim/sample"])],
        ['key' => 'transferDone', 'name' => 'Ticket transfer accepted', 'audience' => 'Attendee', 'trigger' => 'When the friend accepts', 'sample' => fn() => tpl('transferDone', ['event' => $ev, 'toEmail' => 'friend@example.co.za'])],
        ['key' => 'verifyEmail', 'name' => 'Welcome / confirm email', 'audience' => 'Everyone', 'trigger' => 'On sign-up', 'sample' => fn() => tpl('verifyEmail', ['name' => 'Lerato Mokoena', 'url' => "$B/account#/verify/sample"])],
        ['key' => 'passwordReset', 'name' => 'Password reset', 'audience' => 'Everyone', 'trigger' => 'On "Forgot password"', 'sample' => fn() => tpl('passwordReset', ['name' => 'Lerato Mokoena', 'url' => "$B/account#/reset/sample"])],
        ['key' => 'callbackReceived', 'name' => 'Callback request received', 'audience' => 'Everyone', 'trigger' => 'When the callback form is sent', 'sample' => fn() => tpl('callbackReceived', ['name' => 'Lerato Mokoena', 'reference' => 'CB-4H8D2K', 'responseTime' => '24–48 hours', 'email' => 'hello@ticketroom.co.za', 'hoursNote' => 'Monday to Friday, 9am to 5pm. Closed on weekends and public holidays.'])],
        ['key' => 'unsubscribeLink', 'name' => 'Unsubscribe link', 'audience' => 'Everyone', 'trigger' => 'From the Unsubscribe page', 'sample' => fn() => tpl('unsubscribeLink', ['name' => 'Lerato Mokoena', 'url' => "$B/unsubscribe?t=sample"])],
        ['key' => 'organiserApproved', 'name' => 'Organiser approved', 'audience' => 'Organiser', 'trigger' => 'When admin approves an organiser', 'sample' => fn() => tpl('organiserApproved', ['name' => 'Naledi Dlamini', 'organiser' => 'Soweto Community Arts'])],
        ['key' => 'organiserRejected', 'name' => 'Organiser not approved', 'audience' => 'Organiser', 'trigger' => 'When admin rejects an organiser', 'sample' => fn() => tpl('organiserRejected', ['name' => 'Naledi Dlamini', 'organiser' => 'Soweto Community Arts', 'reason' => "We couldn't verify the contact details."])],
        ['key' => 'eventPublished', 'name' => 'Event published', 'audience' => 'Organiser', 'trigger' => 'When admin approves an event', 'sample' => fn() => tpl('eventPublished', ['name' => 'Naledi Dlamini', 'event' => $ev, 'eventUrl' => "$B/events/soweto-sunset-sessions"])],
        ['key' => 'eventChangesRequested', 'name' => 'Event needs changes', 'audience' => 'Organiser', 'trigger' => 'When admin sends an event back', 'sample' => fn() => tpl('eventChangesRequested', ['name' => 'Naledi Dlamini', 'event' => $ev, 'reason' => 'Please add the full venue address and a poster image.'])],
        ['key' => 'staffInvite', 'name' => 'Scanner staff invite', 'audience' => 'Staff', 'trigger' => 'When an organiser adds a new scanner', 'sample' => fn() => tpl('staffInvite', ['name' => 'Sipho', 'organiser' => 'Soweto Community Arts', 'event' => 'Soweto Sunset Sessions', 'url' => "$B/account#/reset/sample"])],
    ];
}

// ============================================================== automated emails
function notify_once(string $key, array $msg): bool
{
    return tx(function () use ($key, $msg) {
        if (affected('INSERT OR IGNORE INTO notification_log (key, created_at) VALUES (?, ?)', [$key, now_iso()]) === 0) return false;
        outbox_enqueue($msg);
        return true;
    });
}
function send_reminders(): int
{
    $s = setting('emails');
    $sent = 0;
    $windows = [];
    if ($s['reminderDayBefore']) $windows[] = ['day', false, 4 * 3600, 24 * 3600];
    if ($s['reminderSoon']) $windows[] = ['soon', true, 0, 3 * 3600];
    foreach ($windows as [$kind, $soon, $from, $to]) {
        $list = rows("SELECT e.id, e.title, e.starts_at, e.venue_name, e.address, e.city, e.age_restriction, e.transfers_enabled,
                             u.id AS user_id, u.email, u.full_name, count(*) AS tickets
                        FROM tickets t JOIN events e ON e.id = t.event_id JOIN users u ON u.id = t.owner_user_id
                       WHERE t.status = 'valid' AND e.status = 'published' AND u.status = 'active' AND e.starts_at > ? AND e.starts_at <= ?
                         AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.key = 'reminder:' || ? || ':' || e.id || ':' || u.id)
                       GROUP BY e.id, u.id LIMIT 300", [iso_in($from), iso_in($to), $kind]);
        foreach ($list as $x) {
            if (notify_once("reminder:$kind:{$x['id']}:{$x['user_id']}", ['to' => $x['email'], 'userId' => $x['user_id']] + tpl('eventReminder', ['name' => $x['full_name'], 'event' => $x, 'ticketCount' => (int) $x['tickets'], 'soon' => $soon]))) $sent++;
        }
    }
    return $sent;
}
function send_abandoned(): int
{
    $s = setting('emails');
    if (!$s['abandonedCheckout']) return 0;
    $list = rows("SELECT o.user_id, o.event_id, u.email, u.full_name, e.title, e.slug, e.starts_at, e.venue_name, e.address, e.city, max(o.created_at) AS last_at
                    FROM orders o JOIN users u ON u.id = o.user_id JOIN events e ON e.id = o.event_id
                   WHERE o.status IN ('expired','cancelled','failed') AND u.status = 'active' AND o.created_at < ? AND o.created_at > ?
                     AND e.status = 'published' AND e.starts_at > ? AND COALESCE(e.sales_end_at, e.ends_at) > ? AND (e.sales_start_at IS NULL OR e.sales_start_at <= ?)
                     AND EXISTS (SELECT 1 FROM ticket_types tt WHERE tt.event_id = e.id AND tt.status = 'on_sale' AND tt.quantity_sold + tt.quantity_held < tt.quantity_total)
                     AND NOT EXISTS (SELECT 1 FROM orders p WHERE p.user_id = o.user_id AND p.event_id = o.event_id AND p.status IN ('pending_payment','paid','partially_refunded'))
                     AND NOT EXISTS (SELECT 1 FROM marketing_consents mc WHERE mc.user_id = o.user_id AND mc.organiser_id IS NULL AND mc.channel = 'email' AND mc.granted = 0)
                     AND NOT EXISTS (SELECT 1 FROM notification_log n WHERE n.key = 'abandoned:' || o.event_id || ':' || o.user_id)
                   GROUP BY o.user_id, o.event_id LIMIT 300",
        [iso_in(-3600 * (int) $s['abandonedDelayHours']), iso_in(-48 * 3600), iso_in(3 * 3600), now_iso(), now_iso()]);
    $sent = 0;
    foreach ($list as $x) {
        $unsub = base_url() . '/unsubscribe?t=' . sign_link(['u' => $x['user_id'], 'all' => true], 30 * 86400);
        if (notify_once("abandoned:{$x['event_id']}:{$x['user_id']}", ['to' => $x['email'], 'userId' => $x['user_id']]
            + tpl('checkoutAbandoned', ['name' => $x['full_name'], 'event' => $x, 'eventUrl' => base_url() . "/events/{$x['slug']}", 'unsubscribeUrl' => $unsub]))) $sent++;
    }
    return $sent;
}
