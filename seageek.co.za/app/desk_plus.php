<?php
/**
 * Desk, part two: email in and out (threaded), mailbox import, WhatsApp replies, attachments,
 * automatic rules, merging, collision warnings, auto-close, reports and customer context.
 */
declare(strict_types=1);

/** Per-account Desk settings, stored as JSON on the organisation. */
final class DeskSettings
{
    public static function get(array $org): array
    {
        $s = json_decode((string) ($org['desk_settings'] ?? ''), true) ?: [];
        $s += ['autoclose_days' => 3, 'mail' => []];
        $s['mail'] += ['mode' => 'none', 'host' => '', 'port' => 995, 'ssl' => 1, 'user' => '', 'pass_enc' => '', 'address' => '', 'last_check' => '', 'last_error' => '', 'imported' => 0];
        return $s;
    }

    public static function save(int $orgId, array $s): void
    {
        DB::update('orgs', ['desk_settings' => json_encode($s, JSON_UNESCAPED_UNICODE)], 'id = ?', [$orgId]);
    }

    /** Where customers' email replies should go: the imported mailbox, else the account's own support address. */
    public static function replyTo(array $org): string
    {
        $m = self::get($org)['mail'];
        if ($m['mode'] === 'pop3' && filter_var($m['address'], FILTER_VALIDATE_EMAIL)) return $m['address'];
        if ($org['is_house']) return Settings::get('support_email');
        $owner = DB::value("SELECT email FROM users WHERE org_id = ? AND role = 'owner' ORDER BY id LIMIT 1", [$org['id']]);
        return (string) ($owner ?: Settings::get('support_email'));
    }

    /** Signed address an email service (SES, Postmark, Mailgun, SendGrid, Cloudflare) can forward mail to. */
    public static function forwardUrl(array $org): string
    {
        return app_url('/webhooks/inbound-email/' . $org['slug'] . '/' . substr(hash_hmac('sha256', 'mail' . $org['id'], (string) config('app_key')), 0, 32));
    }
}

/** Sending replies out on the channel the customer used, and keeping email conversations together. */
final class DeskFlow
{
    public const MARKER = '##- Please type your reply above this line -##';

    public static function domain(): string
    {
        return (string) (parse_url(app_url('/'), PHP_URL_HOST) ?: 'seageek.co.za');
    }

    /** Headers that thread every email about one ticket together in the customer's mail app. */
    public static function threadHeaders(array $t, array $org): array
    {
        $root = '<ticket-' . $t['token'] . '@' . self::domain() . '>';
        return ['Message-ID' => '<t' . $t['id'] . '.' . bin2hex(random_bytes(6)) . '@' . self::domain() . '>', 'In-Reply-To' => $root, 'References' => $root,
            'Reply-To' => DeskSettings::replyTo($org), 'X-From-Name' => $org['is_house'] ? Settings::get('mail_from_name') : $org['name'] . ' Support'];
    }

    /**
     * Send a public reply to the customer on their channel: WhatsApp for WhatsApp tickets, email otherwise.
     * Chat replies are not emailed while the AI is answering live; agent replies are, in case the customer left.
     */
    public static function deliver(array $t, string $body, string $author, array $files = []): void
    {
        if (str_contains((string) $t['tags'], 'sandbox')) return;
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$t['org_id']]);
        if ($t['channel'] === 'whatsapp' && $t['requester_phone']) {
            $text = $body . ($files ? "\n\n" . implode("\n", array_map(fn($f) => $f['name'] . ': ' . DeskFiles::url($f), $files)) : '');
            try {
                [$code, $res] = Gateway::run($org, 'live', 'POST', 'whatsapp/messages', ['to' => $t['requester_phone'], 'type' => 'text', 'text' => mb_substr($text, 0, 4000), 'reference' => 'desk-' . $t['number']]);
                if ($code >= 300) Desk::addMessage((int) $t['id'], 'system', 'Not delivered on WhatsApp: ' . ($res['error']['message'] ?? 'error ' . $code), true);
            } catch (Throwable $e) {
                Desk::addMessage((int) $t['id'], 'system', 'Not delivered on WhatsApp: ' . $e->getMessage(), true);
            }
            return;
        }
        if (!$t['requester_email'] || ($t['channel'] === 'chat' && $author !== 'agent')) return;
        Mail::queue($t['requester_email'], "[#{$t['number']}] " . $t['subject'], 'ticket_reply',
            ['ticket' => $t, 'body' => $body, 'org' => $org, 'files' => $files, 'author' => $author], self::threadHeaders($t, $org));
    }

    // Email in -----------------------------------------------------------------

    /** Remove the quoted earlier conversation from an email reply. */
    public static function stripQuoted(string $text): string
    {
        $text = str_replace(["\r\n", "\r"], "\n", $text);
        if (($p = strpos($text, '##- Please type your reply above this line -##')) !== false) $text = substr($text, 0, $p);
        $cut = [
            '/^\s*On\s.{5,200}\bwrote:\s*$/mi',                 // Gmail, Apple Mail
            '/^\s*On\s.{5,200}\n.{0,120}\bwrote:\s*$/mi',        // the same, wrapped onto two lines
            '/^\s*-{2,}\s*Original Message\s*-{2,}/mi',         // Outlook
            '/^\s*_{10,}\s*$/m',                                 // Outlook web divider
            '/^\s*From:\s.+\n\s*(Sent|Date):\s/mi',              // Outlook header block
            '/^\s*Op\s.{5,200}\bschreef\b.*$/mi', '/^\s*Le\s.{5,200}\ba écrit\s*:/mi',
        ];
        foreach ($cut as $re) if (preg_match($re, $text, $m, PREG_OFFSET_CAPTURE)) $text = substr($text, 0, $m[0][1]);
        $lines = array_filter(explode("\n", $text), fn($l) => !str_starts_with(ltrim($l), '>'));
        return trim(preg_replace("/\n{3,}/", "\n\n", implode("\n", $lines)));
    }

    /** Auto-replies, bounces and mailing lists must not open tickets, or two systems answer each other forever. */
    public static function isAutomated(array $mail): bool
    {
        $h = $mail['headers'] ?? [];
        if (isset($h['auto-submitted']) && strtolower(trim($h['auto-submitted'])) !== 'no') return true;
        if (isset($h['precedence']) && preg_match('/bulk|junk|list|auto_reply/i', $h['precedence'])) return true;
        if (isset($h['x-autoreply']) || isset($h['x-autorespond']) || isset($h['list-id'])) return true;
        if (preg_match('/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)@/i', (string) $mail['from'])) return true;
        if (strcasecmp((string) $mail['from'], Settings::get('mail_from_address')) === 0) return true;
        return false;
    }

    /**
     * One email into Desk: a reply joins its ticket (matched by the thread headers, else "[#1234]" and the sender),
     * anything else opens a new ticket. Returns the ticket, or null when the email was ignored.
     */
    public static function ingestEmail(array $org, array $mail): ?array
    {
        $from = strtolower(trim((string) $mail['from']));
        if (!filter_var($from, FILTER_VALIDATE_EMAIL) || self::isAutomated($mail)) return null;
        if (rate_limited('desk-mail:' . $org['id'] . ':' . $from, 30, 3600)) return null;
        $subject = trim(preg_replace('/\s+/', ' ', (string) ($mail['subject'] ?? ''))) ?: '(no subject)';
        $text = (string) ($mail['text'] ?? '');
        if (trim($text) === '' && !empty($mail['html'])) $text = Mail::text((string) $mail['html']);
        $body = self::stripQuoted($text);
        $files = $mail['attachments'] ?? [];
        if ($body === '' && !$files) $body = '(empty email)';
        $t = null;
        $refs = ($mail['in_reply_to'] ?? '') . ' ' . ($mail['references'] ?? '');
        if (preg_match('/ticket-([A-Za-z0-9_-]{16,40})@/', $refs, $m)) $t = DB::one('SELECT * FROM tickets WHERE token = ? AND org_id = ?', [$m[1], $org['id']]);
        if (!$t && preg_match('/\[#(\d+)\]/', $subject, $m)) $t = DB::one('SELECT * FROM tickets WHERE org_id = ? AND number = ? AND requester_email = ?', [$org['id'], (int) $m[1], $from]);
        while ($t && $t['merged_into']) $t = Desk::ticket((int) $t['merged_into']);
        if ($t && $t['status'] !== 'closed') {
            Desk::customerReply($t, $body === '' ? '(attachment)' : $body);
            $msgId = (int) DB::value('SELECT MAX(id) FROM ticket_messages WHERE ticket_id = ? AND author = ?', [$t['id'], 'customer']);
        } else {
            $prev = $t;
            $t = Desk::createTicket((int) $org['id'], $prev ? 'Follow-up to #' . $prev['number'] . ': ' . preg_replace('/^(re|fw|fwd):\s*/i', '', $subject) : preg_replace('/^(re|fw|fwd):\s*/i', '', $subject),
                $body, 'email', ['name' => $mail['from_name'] ?? null, 'email' => $from]);
            $msgId = (int) DB::value('SELECT MIN(id) FROM ticket_messages WHERE ticket_id = ?', [$t['id']]);
        }
        foreach (array_slice($files, 0, 10) as $f) DeskFiles::store((int) $t['id'], $msgId, (string) $f['name'], (string) $f['mime'], (string) $f['data']);
        $t = Desk::ticket((int) $t['id']);
        if ($t['ai_active'] && $t['status'] !== 'solved' && !DB::value("SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = ? AND author = 'ai' AND id > ?", [$t['id'], $msgId])) Desk::aiRespond($t);
        return Desk::ticket((int) $t['id']);
    }

    /** Normalise what email services post to the forwarding address (Postmark, Mailgun, SendGrid, generic JSON or raw MIME). */
    public static function fromWebhook(array $d, string $rawBody, string $contentType): ?array
    {
        if (str_contains($contentType, 'message/rfc822') || (isset($d['raw']) && is_string($d['raw'])) || (isset($d['email']) && is_string($d['email']) && str_contains($d['email'], "\n"))) {
            return DeskMime::parse((string) ($d['raw'] ?? $d['email'] ?? $rawBody));
        }
        $pick = function (array $keys) use ($d) { foreach ($keys as $k) if (isset($d[$k]) && $d[$k] !== '') return is_array($d[$k]) ? $d[$k] : (string) $d[$k]; return ''; };
        $fromRaw = (string) $pick(['from', 'From', 'sender']);
        $fromName = (string) $pick(['from_name', 'FromName']);
        if (is_array($d['FromFull'] ?? null)) { $fromRaw = (string) ($d['FromFull']['Email'] ?? $fromRaw); $fromName = (string) ($d['FromFull']['Name'] ?? $fromName); }
        [$fromAddr, $nameFromHeader] = DeskMime::address($fromRaw);
        $headers = [];
        foreach ((array) ($d['Headers'] ?? []) as $h) if (isset($h['Name'])) $headers[strtolower($h['Name'])] = (string) $h['Value'];
        if (is_string($d['headers'] ?? null)) foreach (explode("\n", $d['headers']) as $line) if (str_contains($line, ':')) { [$k, $v] = explode(':', $line, 2); $headers[strtolower(trim($k))] = trim($v); }
        $atts = [];
        foreach ((array) ($d['Attachments'] ?? $d['attachments'] ?? []) as $a) {
            if (!is_array($a)) continue;
            $data = isset($a['Content']) ? base64_decode((string) $a['Content'], true) : (isset($a['content']) ? base64_decode((string) $a['content'], true) : false);
            if ($data !== false) $atts[] = ['name' => (string) ($a['Name'] ?? $a['filename'] ?? $a['name'] ?? 'file'), 'mime' => (string) ($a['ContentType'] ?? $a['content_type'] ?? $a['type'] ?? 'application/octet-stream'), 'data' => $data];
        }
        foreach ($_FILES as $f) if (is_array($f) && is_string($f['tmp_name'] ?? null) && is_uploaded_file($f['tmp_name'])) $atts[] = ['name' => (string) $f['name'], 'mime' => (string) $f['type'], 'data' => (string) file_get_contents($f['tmp_name'])];
        return ['from' => $fromAddr, 'from_name' => $fromName ?: $nameFromHeader, 'subject' => (string) $pick(['subject', 'Subject']),
            'text' => (string) $pick(['stripped-text', 'TextBody', 'text', 'body-plain', 'plain']), 'html' => (string) $pick(['HtmlBody', 'html', 'body-html']),
            'message_id' => (string) ($pick(['MessageID', 'Message-Id', 'message_id']) ?: ($headers['message-id'] ?? '')),
            'in_reply_to' => (string) ($pick(['In-Reply-To', 'in_reply_to']) ?: ($headers['in-reply-to'] ?? '')),
            'references' => (string) ($pick(['References', 'references']) ?: ($headers['references'] ?? '')), 'headers' => $headers, 'attachments' => $atts];
    }

    // Working together -----------------------------------------------------------

    /** Move every message and file from one ticket into another; the old one closes and points to the new one. */
    public static function merge(array $src, array $dst, int $userId): void
    {
        DB::tx(function () use ($src, $dst, $userId) {
            DB::run('UPDATE ticket_messages SET ticket_id = ? WHERE ticket_id = ?', [$dst['id'], $src['id']]);
            DB::run('UPDATE ticket_attachments SET ticket_id = ? WHERE ticket_id = ?', [$dst['id'], $src['id']]);
            DB::update('tickets', ['status' => 'closed', 'merged_into' => $dst['id'], 'tags' => trim(($src['tags'] ? $src['tags'] . ',' : '') . 'merged', ','), 'updated_at' => now()], 'id = ?', [$src['id']]);
            Desk::addMessage((int) $dst['id'], 'system', "Merged #{$src['number']} ({$src['subject']}) into this ticket. Its messages are above, in time order.", true, $userId);
            Desk::addMessage((int) $src['id'], 'system', "Merged into #{$dst['number']}.", true, $userId);
        });
    }

    /** Record that this agent is looking at (or typing in) a ticket, and return who else is. */
    public static function presence(int $ticketId, int $userId, bool $typing): array
    {
        $row = DB::one('SELECT id FROM desk_presence WHERE ticket_id = ? AND user_id = ?', [$ticketId, $userId]);
        if ($row) DB::update('desk_presence', ['typing' => $typing ? 1 : 0, 'seen_at' => now()], 'id = ?', [$row['id']]);
        else DB::insert('desk_presence', ['ticket_id' => $ticketId, 'user_id' => $userId, 'typing' => $typing ? 1 : 0, 'seen_at' => now()]);
        return DB::all('SELECT u.name, p.typing FROM desk_presence p JOIN users u ON u.id = p.user_id WHERE p.ticket_id = ? AND p.user_id <> ? AND p.seen_at > ?', [$ticketId, $userId, ts('-40 seconds')]);
    }

    /**
     * Scheduled: tickets waiting on the customer are solved after the account's quiet period, and solved tickets close a week later.
     * A reply to a solved ticket reopens it; a reply to a closed one starts a follow-up.
     */
    public static function autoClose(): int
    {
        $n = 0;
        foreach (DB::all("SELECT t.*, o.desk_settings FROM tickets t JOIN orgs o ON o.id = t.org_id WHERE t.status = 'pending'") as $t) {
            $days = (int) DeskSettings::get($t)['autoclose_days'];
            if ($days <= 0 || $t['updated_at'] > ts("-$days days")) continue;
            $msg = "We haven't heard back, so we've marked this as solved. Just reply if you still need help and it will open again.";
            Desk::addMessage((int) $t['id'], 'system', $msg);
            DB::update('tickets', ['status' => 'solved', 'solved_at' => now()], 'id = ?', [$t['id']]);
            self::deliver(Desk::ticket((int) $t['id']), $msg, 'system');
            $n++;
        }
        $n += DB::run("UPDATE tickets SET status = 'closed' WHERE status = 'solved' AND solved_at < ?", [ts('-7 days')])->rowCount();
        DB::run('DELETE FROM desk_presence WHERE seen_at < ?', [ts('-1 day')]);
        return $n;
    }

    /** For SeaGeek's own Desk: the requester's SeaGeek account next to the ticket. */
    public static function context(array $org, array $t): ?array
    {
        if (!$org['is_house'] || !$t['requester_email']) return null;
        $u = DB::one('SELECT * FROM users WHERE email = ? AND org_id IS NOT NULL', [$t['requester_email']]);
        if (!$u) return null;
        $o = DB::one('SELECT * FROM orgs WHERE id = ? AND is_house = 0', [$u['org_id']]);
        if (!$o) return null;
        return ['org' => $o, 'user' => $u,
            'unpaid' => (float) DB::value("SELECT COALESCE(SUM(total),0) FROM invoices WHERE org_id = ? AND status = 'unpaid'", [$o['id']]),
            'last_payment' => DB::one("SELECT amount, created_at FROM payments WHERE org_id = ? AND status = 'complete' ORDER BY id DESC LIMIT 1", [$o['id']]),
            'services' => array_column(DB::all("SELECT service FROM org_services WHERE org_id = ? AND status = 'active'", [$o['id']]), 'service')];
    }

    /** A short summary of a long conversation, written by the AI as an internal note. */
    public static function summarise(array $org, array $t): string
    {
        $agent = Desk::agentFor((int) $org['id']);
        if (!$agent) throw new RuntimeException('Set up an AI agent first.');
        $lines = [];
        foreach (Desk::messages((int) $t['id'], false) as $m) $lines[] = ucfirst($m['author'] === 'ai' ? 'assistant' : $m['author']) . ': ' . $m['body'];
        $msg = [['role' => 'user', 'content' => "Summarise this support conversation for a colleague in at most 4 short lines: what the customer wants, what has been tried, and what is still open.\n\n" . mb_substr(implode("\n\n", $lines), -12000)]];
        $res = !empty($agent['house']) ? Ai::complete($agent['provider'], $agent['model'], 'You write short, factual summaries for support teams.', $msg, 400)
            : Ai::meteredChat($org, 'live', $agent['provider'], $agent['model'], 'You write short, factual summaries for support teams.', $msg, 400);
        return trim($res['text']);
    }
}

/** A small, dependency-free MIME parser for incoming email. */
final class DeskMime
{
    /** "Thandi M <thandi@x.co.za>" → [email, name] */
    public static function address(string $raw): array
    {
        $raw = trim(self::header($raw));
        if (preg_match('/^(.*)<([^>]+)>\s*$/', $raw, $m)) return [strtolower(trim($m[2])), trim(trim($m[1]), "\"' ")];
        return [strtolower($raw), ''];
    }

    public static function header(string $v): string
    {
        $d = @mb_decode_mimeheader($v);
        return is_string($d) ? $d : $v;
    }

    /** @return array{headers:array,from:string,from_name:string,subject:string,text:string,html:string,message_id:string,in_reply_to:string,references:string,attachments:array} */
    public static function parse(string $raw): array
    {
        $out = ['text' => '', 'html' => '', 'attachments' => []];
        [$headers, $body] = self::split($raw);
        self::walk($headers, $body, $out, 0);
        [$from, $name] = self::address((string) ($headers['from'] ?? ''));
        return $out + ['headers' => $headers, 'from' => $from, 'from_name' => $name, 'subject' => self::header((string) ($headers['subject'] ?? '')),
            'message_id' => (string) ($headers['message-id'] ?? ''), 'in_reply_to' => (string) ($headers['in-reply-to'] ?? ''), 'references' => (string) ($headers['references'] ?? '')];
    }

    private static function split(string $raw): array
    {
        $raw = str_replace("\r\n", "\n", $raw);
        $pos = strpos($raw, "\n\n");
        $head = $pos === false ? $raw : substr($raw, 0, $pos);
        $body = $pos === false ? '' : substr($raw, $pos + 2);
        $headers = [];
        $head = preg_replace("/\n[ \t]+/", ' ', $head); // unfold
        foreach (explode("\n", $head) as $line) {
            if (!str_contains($line, ':')) continue;
            [$k, $v] = explode(':', $line, 2);
            $k = strtolower(trim($k));
            if (!isset($headers[$k])) $headers[$k] = trim($v);
        }
        return [$headers, $body];
    }

    private static function param(string $value, string $name): string
    {
        if (preg_match('/' . $name . '\*?=(?:"([^"]*)"|([^;\s]+))/i', $value, $m)) {
            $v = $m[1] !== '' ? $m[1] : $m[2];
            if (preg_match("/^([\w-]+)''(.*)$/", $v, $x)) $v = @mb_convert_encoding(rawurldecode($x[2]), 'UTF-8', $x[1]) ?: rawurldecode($x[2]); // RFC 2231
            return self::header($v);
        }
        return '';
    }

    private static function walk(array $h, string $body, array &$out, int $depth): void
    {
        if ($depth > 8) return;
        $ct = (string) ($h['content-type'] ?? 'text/plain');
        $type = strtolower(trim(explode(';', $ct)[0]));
        if (str_starts_with($type, 'multipart/') && ($b = self::param($ct, 'boundary')) !== '') {
            $parts = explode("\n--" . $b, "\n" . $body);
            array_shift($parts); // preamble
            foreach ($parts as $p) {
                if (str_starts_with($p, '--')) break; // closing boundary
                [$ph, $pb] = self::split(ltrim($p, "\n"));
                self::walk($ph, $pb, $out, $depth + 1);
            }
            return;
        }
        $enc = strtolower(trim((string) ($h['content-transfer-encoding'] ?? '')));
        $data = $enc === 'base64' ? (string) base64_decode(preg_replace('/\s+/', '', $body)) : ($enc === 'quoted-printable' ? quoted_printable_decode($body) : $body);
        $disp = (string) ($h['content-disposition'] ?? '');
        $name = self::param($disp, 'filename') ?: self::param($ct, 'name');
        if ($type === 'message/rfc822') { $name = $name ?: 'forwarded-message.eml'; }
        if ($name !== '' || stripos($disp, 'attachment') === 0) {
            $out['attachments'][] = ['name' => $name ?: 'attachment', 'mime' => $type, 'data' => $data];
            return;
        }
        if ($type === 'text/plain' || $type === 'text/html') {
            $cs = self::param($ct, 'charset') ?: 'UTF-8';
            if (strcasecmp($cs, 'UTF-8') !== 0) $data = @mb_convert_encoding($data, 'UTF-8', $cs) ?: $data;
            $key = $type === 'text/plain' ? 'text' : 'html';
            if ($out[$key] === '') $out[$key] = $data;
        }
    }
}

/** Reads a support mailbox over POP3 (port 995 with SSL) and turns new emails into tickets. */
final class DeskMailbox
{
    private $fp;

    private function __construct(private array $cfg) {}

    public static function runAll(): int
    {
        $n = 0;
        foreach (DB::all("SELECT * FROM orgs WHERE desk_settings LIKE '%\"pop3\"%'") as $org) {
            try { $n += self::run($org); } catch (Throwable $e) { log_line('desk', 'Mailbox for ' . $org['slug'] . ': ' . $e->getMessage()); }
        }
        return $n;
    }

    /** Import new emails for one account. With $baseline, only remember what is already there (first connection). */
    public static function run(array $org, bool $baseline = false, int $limit = 25): int
    {
        $s = DeskSettings::get($org);
        $box = new self($s['mail']);
        $n = 0;
        try {
            $box->open();
            foreach ($box->uidl() as $num => $uid) {
                if (DB::one('SELECT id FROM desk_mail_seen WHERE org_id = ? AND uid = ?', [$org['id'], $uid])) continue;
                DB::insert('desk_mail_seen', ['org_id' => $org['id'], 'uid' => mb_substr($uid, 0, 190), 'created_at' => now()]);
                if ($baseline) continue;
                if ($box->size($num) > 20_000_000) { log_line('desk', "Skipped a message over 20 MB for {$org['slug']}"); continue; }
                $mail = DeskMime::parse($box->retr($num));
                if (DeskFlow::ingestEmail($org, $mail)) $n++;
                if ($n >= $limit) break;
            }
            $box->quit();
            $s['mail']['last_error'] = '';
        } catch (Throwable $e) {
            $s['mail']['last_error'] = mb_substr($e->getMessage(), 0, 200);
            throw $e;
        } finally {
            $s['mail']['last_check'] = now();
            $s['mail']['imported'] = (int) $s['mail']['imported'] + $n;
            DeskSettings::save((int) $org['id'], $s);
        }
        return $n;
    }

    /** Check the login works; returns the number of emails in the mailbox. */
    public static function test(array $mailCfg): int
    {
        $box = new self($mailCfg);
        $box->open();
        $n = count($box->uidl());
        $box->quit();
        return $n;
    }

    private function open(): void
    {
        $host = (string) $this->cfg['host'];
        if ($host === '' || $this->cfg['user'] === '') throw new RuntimeException('Enter the mail server, username and password.');
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'SNI_enabled' => true]]);
        $this->fp = @stream_socket_client(($this->cfg['ssl'] ? 'ssl://' : 'tcp://') . $host . ':' . (int) $this->cfg['port'], $errno, $err, 15, STREAM_CLIENT_CONNECT, $ctx);
        if (!$this->fp) throw new RuntimeException("Could not connect to $host: " . ($err ?: 'no answer'));
        stream_set_timeout($this->fp, 30);
        $this->line();
        $this->cmd('USER ' . $this->cfg['user']);
        try { $this->cmd('PASS ' . Crypto::decrypt((string) $this->cfg['pass_enc'])); }
        catch (RuntimeException) { throw new RuntimeException('The mail server refused the username or password.'); }
    }

    private function line(): string
    {
        $l = fgets($this->fp, 8192);
        if ($l === false) throw new RuntimeException('The mail server stopped answering.');
        if (str_starts_with($l, '-ERR')) throw new RuntimeException('Mail server: ' . trim(substr($l, 4)));
        return rtrim($l, "\r\n");
    }

    private function cmd(string $c): string
    {
        fwrite($this->fp, $c . "\r\n");
        return $this->line();
    }

    private function multi(): array
    {
        $lines = [];
        while (($l = fgets($this->fp, 65536)) !== false) {
            $l = rtrim($l, "\r\n");
            if ($l === '.') break;
            $lines[] = str_starts_with($l, '..') ? substr($l, 1) : $l;
        }
        return $lines;
    }

    private array $sizes = [];

    private function uidl(): array
    {
        $this->cmd('LIST');
        foreach ($this->multi() as $l) { [$n, $sz] = array_pad(explode(' ', $l, 2), 2, 0); $this->sizes[(int) $n] = (int) $sz; }
        $this->cmd('UIDL');
        $out = [];
        foreach ($this->multi() as $l) { [$n, $uid] = array_pad(explode(' ', $l, 2), 2, ''); if ($uid !== '') $out[(int) $n] = trim($uid); }
        return $out;
    }

    private function size(int $n): int { return $this->sizes[$n] ?? 0; }

    private function retr(int $n): string
    {
        $this->cmd('RETR ' . $n);
        return implode("\r\n", $this->multi());
    }

    private function quit(): void
    {
        try { $this->cmd('QUIT'); } catch (Throwable) {}
        @fclose($this->fp);
    }
}

/** Files on tickets: stored outside the website, served only through an unguessable link. */
final class DeskFiles
{
    public const MAX = 10_000_000;
    private const TYPES = ['jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp', 'heic' => 'image/heic',
        'pdf' => 'application/pdf', 'txt' => 'text/plain', 'csv' => 'text/csv', 'doc' => 'application/msword', 'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls' => 'application/vnd.ms-excel', 'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'ppt' => 'application/vnd.ms-powerpoint',
        'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'zip' => 'application/zip', 'mp3' => 'audio/mpeg', 'm4a' => 'audio/mp4',
        'ogg' => 'audio/ogg', 'opus' => 'audio/ogg', 'mp4' => 'video/mp4', 'mov' => 'video/quicktime', 'eml' => 'message/rfc822'];
    /** Shown in the browser; everything else downloads. */
    private const INLINE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];

    public static function allowed(string $name): bool
    {
        return isset(self::TYPES[strtolower(pathinfo($name, PATHINFO_EXTENSION))]);
    }

    public static function store(int $ticketId, ?int $messageId, string $name, string $mime, string $data): ?array
    {
        $name = mb_substr(preg_replace('/[^\pL\pN ._()-]+/u', '_', basename($name)) ?: 'file', 0, 150);
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if (!isset(self::TYPES[$ext]) || strlen($data) === 0 || strlen($data) > self::MAX) return null;
        $dir = STORAGE . '/uploads/desk/' . gmdate('Y-m');
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
        $token = Crypto::token(24);
        $path = $dir . '/' . $token;
        file_put_contents($path, $data);
        @chmod($path, 0600);
        $id = DB::insert('ticket_attachments', ['ticket_id' => $ticketId, 'message_id' => $messageId, 'name' => $name, 'mime' => self::TYPES[$ext], 'size' => strlen($data),
            'path' => substr($path, strlen(STORAGE) + 1), 'token' => $token, 'created_at' => now()]);
        return DB::one('SELECT * FROM ticket_attachments WHERE id = ?', [$id]);
    }

    /** Files from a form's <input type="file" name="files[]" multiple>. Returns [stored, refused names]. */
    public static function fromUpload(int $ticketId, ?int $messageId, string $field = 'files'): array
    {
        $stored = []; $refused = [];
        $f = $_FILES[$field] ?? null;
        if (!$f || !is_array($f['name'])) return [$stored, $refused];
        foreach ($f['name'] as $i => $name) {
            if ($name === '' || ($f['error'][$i] ?? 1) !== UPLOAD_ERR_OK) { if ($name !== '') $refused[] = $name; continue; }
            if (count($stored) >= 5 || !self::allowed($name) || $f['size'][$i] > self::MAX || !is_uploaded_file($f['tmp_name'][$i])) { $refused[] = $name; continue; }
            $a = self::store($ticketId, $messageId, $name, '', (string) file_get_contents($f['tmp_name'][$i]));
            $a ? $stored[] = $a : $refused[] = $name;
        }
        return [$stored, $refused];
    }

    public static function url(array $a): string
    {
        return app_url('/desk/file/' . $a['token'] . '/' . rawurlencode($a['name']));
    }

    public static function forMessages(int $ticketId): array
    {
        $by = [];
        foreach (DB::all('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY id', [$ticketId]) as $a) $by[(int) $a['message_id']][] = $a;
        return $by;
    }

    public static function serve(string $token): never
    {
        $a = DB::one('SELECT * FROM ticket_attachments WHERE token = ?', [$token]);
        $path = $a ? STORAGE . '/' . $a['path'] : '';
        if (!$a || !is_file($path)) { http_response_code(404); exit('Not found'); }
        $inline = in_array($a['mime'], self::INLINE, true);
        header('Content-Type: ' . ($inline ? $a['mime'] : 'application/octet-stream'));
        header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . "; filename*=UTF-8''" . rawurlencode($a['name']));
        header('Content-Length: ' . filesize($path));
        header('X-Content-Type-Options: nosniff');
        header("Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
        header('Cache-Control: private, max-age=3600');
        readfile($path);
        exit;
    }

    public static function human(int $bytes): string
    {
        return $bytes >= 1048576 ? round($bytes / 1048576, 1) . ' MB' : max(1, (int) round($bytes / 1024)) . ' KB';
    }
}

/** "When a ticket arrives (or the customer replies) and it mentions X, do Y." */
final class DeskRules
{
    public static function apply(array $t, string $event, string $text): void
    {
        $rules = DB::all('SELECT * FROM desk_rules WHERE org_id = ? AND active = 1 AND event = ? ORDER BY position, id', [$t['org_id'], $event]);
        if (!$rules) return;
        foreach ($rules as $r) {
            if ($r['channel'] && $r['channel'] !== $t['channel']) continue;
            $hay = match ($r['field']) {
                'subject' => $t['subject'],
                'body' => $text,
                'email' => (string) $t['requester_email'],
                default => $t['subject'] . "\n" . $text,
            };
            $words = array_filter(array_map('trim', explode(',', (string) $r['words'])));
            if ($words && !array_filter($words, fn($w) => mb_stripos($hay, $w) !== false)) continue;
            $t = Desk::ticket((int) $t['id']);
            $upd = [];
            if ($r['set_priority'] && in_array($r['set_priority'], Desk::PRIORITIES, true)) $upd['priority'] = $r['set_priority'];
            if ($r['assign_to']) $upd['assignee_id'] = (int) $r['assign_to'];
            if ($r['add_tag']) $upd['tags'] = mb_substr(implode(',', array_unique(array_filter(array_merge(explode(',', (string) $t['tags']), [$r['add_tag']])))), 0, 255);
            if ($r['set_status'] === 'person') $upd['ai_active'] = 0;
            elseif ($r['set_status'] && in_array($r['set_status'], Desk::STATUSES, true)) $upd['status'] = $r['set_status'];
            if ($upd) DB::update('tickets', $upd, 'id = ?', [$t['id']]);
            if ($r['reply_macro'] && ($m = DB::one('SELECT * FROM macros WHERE id = ? AND org_id = ?', [$r['reply_macro'], $t['org_id']]))) {
                Desk::addMessage((int) $t['id'], 'system', (string) $m['body']);
                DeskFlow::deliver(Desk::ticket((int) $t['id']), (string) $m['body'], 'system');
            }
            Desk::addMessage((int) $t['id'], 'system', 'Rule applied: ' . $r['name'], true);
            DB::run('UPDATE desk_rules SET hits = hits + 1 WHERE id = ?', [$r['id']]);
        }
    }
}

/** Numbers for the Desk reports page. */
final class DeskReports
{
    private static function median(array $v): ?float
    {
        if (!$v) return null;
        sort($v);
        $n = count($v);
        return $n % 2 ? (float) $v[intdiv($n, 2)] : ($v[$n / 2 - 1] + $v[$n / 2]) / 2;
    }

    public static function hours(?float $h): string
    {
        if ($h === null) return 'n/a';
        if ($h < 1) return max(1, (int) round($h * 60)) . ' min';
        if ($h < 48) return rtrim(rtrim(number_format($h, 1), '0'), '.') . ' h';
        return round($h / 24, 1) . ' days';
    }

    public static function build(int $orgId, int $days): array
    {
        $since = ts("-$days days");
        $tickets = DB::all("SELECT t.*, (SELECT COUNT(*) FROM ticket_messages m WHERE m.ticket_id = t.id AND m.author = 'agent' AND m.internal = 0) agent_msgs FROM tickets t WHERE t.org_id = ? AND t.created_at >= ? AND t.merged_into IS NULL AND (t.tags IS NULL OR t.tags NOT LIKE '%sandbox%')", [$orgId, $since]);
        $series = [];
        for ($i = $days - 1; $i >= 0; $i--) $series[gmdate('Y-m-d', strtotime("-$i days"))] = 0;
        $channels = []; $first = []; $resolve = []; $ai = 0; $csat = []; $tags = [];
        foreach ($tickets as $t) {
            $d = substr($t['created_at'], 0, 10);
            if (isset($series[$d])) $series[$d]++;
            $channels[$t['channel']] = ($channels[$t['channel']] ?? 0) + 1;
            if ($t['first_reply_at']) $first[] = (strtotime($t['first_reply_at']) - strtotime($t['created_at'])) / 3600;
            if ($t['solved_at']) $resolve[] = (strtotime($t['solved_at']) - strtotime($t['created_at'])) / 3600;
            if ((int) $t['agent_msgs'] === 0 && $t['ai_active'] && in_array($t['status'], ['solved', 'closed', 'open', 'pending'], true)
                && DB::value("SELECT COUNT(*) FROM ticket_messages WHERE ticket_id = ? AND author = 'ai'", [$t['id']])) $ai++;
            if ($t['csat']) $csat[] = (int) $t['csat'];
            foreach (array_filter(explode(',', (string) $t['tags'])) as $tag) if (!in_array($tag, ['sla-breach', 'merged'], true)) $tags[$tag] = ($tags[$tag] ?? 0) + 1;
        }
        arsort($channels); arsort($tags);
        $agents = DB::all("SELECT u.name, COUNT(m.id) replies, COUNT(DISTINCT m.ticket_id) tickets FROM ticket_messages m JOIN users u ON u.id = m.author_id JOIN tickets t ON t.id = m.ticket_id
            WHERE t.org_id = ? AND m.author = 'agent' AND m.internal = 0 AND m.created_at >= ? GROUP BY u.id, u.name ORDER BY replies DESC", [$orgId, $since]);
        $solvedBy = [];
        foreach (DB::all("SELECT assignee_id, COUNT(*) n FROM tickets WHERE org_id = ? AND solved_at >= ? AND assignee_id IS NOT NULL GROUP BY assignee_id", [$orgId, $since]) as $r) $solvedBy[(int) $r['assignee_id']] = (int) $r['n'];
        $dist = array_fill(1, 5, 0);
        foreach ($csat as $c) $dist[$c]++;
        $total = count($tickets);
        return [
            'total' => $total, 'solved' => count($resolve), 'series' => $series, 'channels' => $channels,
            'first_reply' => self::median($first), 'resolution' => self::median($resolve),
            'ai' => $ai, 'ai_pct' => $total ? round($ai / $total * 100) : 0,
            'csat' => $csat ? round(array_sum($csat) / count($csat), 1) : null, 'csat_n' => count($csat), 'csat_dist' => $dist,
            'within_target' => $first ? round(count(array_filter($tickets, fn($t) => $t['first_reply_at'] && $t['first_reply_at'] <= $t['sla_due_at'])) / count($first) * 100) : null,
            'agents' => $agents, 'tags' => array_slice($tags, 0, 8, true),
            'open_now' => (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND status IN ('new','open')", [$orgId]),
        ];
    }
}
