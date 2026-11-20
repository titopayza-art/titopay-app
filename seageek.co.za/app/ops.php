<?php
/**
 * Running SeaGeek with one or two people: one list of what needs a person, a morning email,
 * instant alerts when something breaks, and automatic backups.
 */
declare(strict_types=1);

final class Ops
{
    /** Plain-language names for the scheduled jobs. */
    public const JOBS = [
        'queue' => 'Send queued messages and retry failed ones',
        'simulate' => 'Update sandbox delivery reports',
        'renewals' => 'Renew plans and issue invoices',
        'reminders' => 'Remind customers about unpaid invoices, lock and unlock accounts',
        'low_balance' => 'Warn customers when their credit runs low',
        'wa_fees' => 'Bill monthly WhatsApp number fees',
        'desk_sla' => 'Flag support tickets that are waiting too long',
        'desk_mail' => 'Turn new support emails into tickets',
        'desk_autoclose' => 'Solve quiet tickets and close old ones',
        'campaigns' => 'Send scheduled campaigns',
        'store_reminders' => 'Send abandoned-cart reminders for stores',
        'monitors' => 'Check customer websites',
        'xero' => 'Copy invoices and payments to Xero',
        'webhooks' => 'Deliver webhooks to customer systems',
        'email' => 'Send queued email',
        'ops' => 'Team alerts, morning summary and daily backup',
        'cleanup' => 'Tidy old sessions, codes and expired quotes',
    ];

    /**
     * Everything that needs a person, most urgent first.
     * @return list<array{level:string,key:string,title:string,detail:string,href:string,action:string,count:int}>
     */
    public static function todo(): array
    {
        $out = [];
        $add = function (string $level, string $key, int $count, string $title, string $detail, string $href, string $action) use (&$out) {
            if ($count > 0) $out[] = compact('level', 'key', 'title', 'detail', 'href', 'action', 'count');
        };
        $house = (int) Desk::house()['id'];

        // Urgent: the platform itself
        $cron = Settings::get('last_cron_at');
        $add('urgent', 'cron', ($cron === '' || strtotime($cron . ' UTC') < time() - 600) ? 1 : 0, 'Scheduled jobs have stopped',
            $cron === '' ? 'They have never run. Messages, renewals, reminders and email wait until they do.' : 'Last run ' . self::ago($cron) . '. Messages, renewals, reminders and email are waiting.', '/admin/system', 'Fix');
        $failing = DB::all('SELECT name, service FROM partners WHERE active = 1 AND fail_count >= 5');
        $add('urgent', 'partners', count($failing), count($failing) === 1 ? 'A supplier is failing' : count($failing) . ' suppliers are failing',
            implode(', ', array_map(fn($p) => $p['name'] . ' (' . (service_names()[$p['service']] ?? $p['service']) . ')', $failing)) . '. Traffic moves to a backup supplier where one is set up.', '/admin/partners', 'Check');
        $mailFail = (int) DB::value("SELECT COUNT(*) FROM email_outbox WHERE status = 'failed' AND created_at > ?", [ts('-24 hours')]);
        $add('urgent', 'email', $mailFail, $mailFail . ' email' . ($mailFail === 1 ? '' : 's') . ' failed to send today',
            'Customers may be missing invoices, receipts or sign-in links. Check the email settings.', '/admin/settings#email', 'Check');

        // Today: things only a person can do
        $waiting = DB::all("SELECT id, number, subject, created_at, sla_due_at FROM tickets WHERE org_id = ? AND status IN ('new','open') AND ai_active = 0 AND (tags IS NULL OR tags NOT LIKE '%startup%') ORDER BY created_at", [$house]);
        $late = count(array_filter($waiting, fn($t) => $t['sla_due_at'] && $t['sla_due_at'] < now()));
        $add('today', 'desk', count($waiting), count($waiting) . ' customer' . (count($waiting) === 1 ? ' is' : 's are') . ' waiting for a person',
            'The AI handed these over. Oldest: #' . ($waiting[0]['number'] ?? '') . ' ' . mb_strimwidth((string) ($waiting[0]['subject'] ?? ''), 0, 50, '…') . ', ' . self::ago((string) ($waiting[0]['created_at'] ?? now())) . ($late ? ". $late past the reply target." : '.'), '/admin/desk', 'Reply');
        $apps = DB::all("SELECT number, subject FROM tickets WHERE org_id = ? AND status IN ('new','open') AND tags LIKE '%startup%' ORDER BY id", [$house]);
        $add('today', 'startups', count($apps), count($apps) . ' startup application' . (count($apps) === 1 ? '' : 's'),
            'From ' . mb_strimwidth(implode('; ', array_map(fn($a) => str_replace('Startup application: ', '', $a['subject']), $apps)), 0, 90, '…') . '. Read the application, then switch on the startup credit from their customer page.', '/admin/desk?view=open', 'Review');
        $reviews = DB::all("SELECT id, name, 'Business check (KYB)' what FROM orgs WHERE kyb_status = 'pending' UNION ALL SELECT id, name, 'SMS sender name' FROM orgs WHERE sms_sender_status = 'pending' UNION ALL SELECT o.id, o.name, 'WhatsApp number' FROM wa_numbers w JOIN orgs o ON o.id = w.org_id WHERE w.status = 'pending' UNION ALL SELECT id, name, 'Email domain' FROM orgs WHERE mail_domain_status = 'pending'");
        $add('today', 'reviews', count($reviews), count($reviews) . ' customer request' . (count($reviews) === 1 ? '' : 's') . ' to approve',
            implode(', ', array_map(fn($r) => $r['what'] . ' for ' . $r['name'], array_slice($reviews, 0, 3))) . (count($reviews) > 3 ? ' and more' : '') . '.', $reviews ? '/admin/orgs/' . (int) $reviews[0]['id'] : '/admin/orgs', 'Open');
        $eft = DB::one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM bank_lines WHERE status = 'unmatched' AND amount > 0");
        $add('today', 'eft', (int) $eft['n'], (int) $eft['n'] . ' bank payment' . ((int) $eft['n'] === 1 ? '' : 's') . ' could not be matched',
            zar((float) $eft['total']) . ' arrived without a valid customer number. Pick the right customer and it is credited at once.', '/admin/eft', 'Match');
        $mb = DeskSettings::get(Desk::house())['mail'];
        $add('today', 'mailbox', ($mb['mode'] === 'pop3' && $mb['last_error'] !== '') ? 1 : 0, 'Support emails are not being collected',
            'The ' . $mb['address'] . ' mailbox said: ' . $mb['last_error'] . '. New support emails wait in the mailbox until this is fixed.', '/admin/desk-settings#email', 'Fix');
        $xero = (int) DB::value("SELECT COUNT(*) FROM xero_sync WHERE status = 'error' AND attempts >= 5");
        $add('today', 'xero', $xero, $xero . ' item' . ($xero === 1 ? '' : 's') . ' could not be copied to Xero', 'Usually an account code or tax setting. The reason is in the Xero log.', '/admin/xero', 'Fix');

        // This week: routine a person must start
        $lastImport = (string) DB::value('SELECT MAX(created_at) FROM bank_lines');
        $eftOpen = (int) DB::value("SELECT COUNT(*) FROM invoices WHERE status = 'unpaid' AND kind <> 'order' AND created_at < ?", [ts('-1 day')]);
        $add('week', 'import', ($eftOpen > 0 && ($lastImport === '' || $lastImport < ts('-3 days'))) ? 1 : 0, 'Import your bank statement',
            ($lastImport ? 'Last imported ' . self::ago($lastImport) . '. ' : 'Not imported yet. ') . $eftOpen . ' unpaid invoice' . ($eftOpen === 1 ? '' : 's') . ' may have been paid by EFT. Download a CSV from your bank and drop it in.', '/admin/eft', 'Import');
        $backup = self::lastBackup();
        $add('week', 'backup', ($backup === null || $backup < time() - 86400 * 2) ? 1 : 0, 'No recent backup',
            $backup === null ? 'No backup has been made yet. One is made every night once scheduled jobs run, or make one now.' : 'The last backup is from ' . gmdate('j M', $backup) . '.', '/admin/system#backups', 'Back up');
        return $out;
    }

    /** Yesterday in numbers, for the morning email. */
    public static function yesterday(): array
    {
        $from = gmdate('Y-m-d 00:00:00', strtotime('-1 day'));
        $to = gmdate('Y-m-d 00:00:00');
        $house = (int) Desk::house()['id'];
        $v = fn(string $sql, array $p = []) => DB::value($sql, array_merge($p, [$from, $to]));
        return [
            'New customers' => (int) $v('SELECT COUNT(*) FROM orgs WHERE is_house = 0 AND created_at >= ? AND created_at < ?'),
            'Money received' => zar((float) $v("SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'complete' AND gateway <> 'credit' AND created_at >= ? AND created_at < ?")),
            'Usage billed' => zar((float) $v("SELECT COALESCE(SUM(amount),0) FROM messages WHERE env = 'live' AND created_at >= ? AND created_at < ?")),
            'Messages sent' => number_format((int) $v("SELECT COUNT(*) FROM messages WHERE env = 'live' AND created_at >= ? AND created_at < ?")),
            'Support conversations' => (int) $v('SELECT COUNT(*) FROM tickets WHERE org_id = ? AND created_at >= ? AND created_at < ?', [$house]),
            'Answered by AI alone' => (int) $v('SELECT COUNT(*) FROM tickets WHERE org_id = ? AND ai_active = 1 AND created_at >= ? AND created_at < ?', [$house]),
        ];
    }

    /** Who gets team email: the address in settings, else every active owner and administrator. */
    public static function recipients(): array
    {
        $set = array_filter(array_map('trim', explode(',', Settings::get('ops_email'))), fn($e) => filter_var($e, FILTER_VALIDATE_EMAIL));
        if ($set) return array_values($set);
        return array_column(DB::all("SELECT email FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND (admin_role IS NULL OR admin_role IN ('owner','admin'))"), 'email');
    }

    /** Scheduled job: urgent alerts, the morning email and the nightly backup. */
    public static function run(): string
    {
        $done = [];
        $done[] = 'alerts ' . self::alerts();
        $sast = time() + 7200;
        $today = gmdate('Y-m-d', $sast);
        if (Settings::get('ops_digest') !== '0' && (int) gmdate('G', $sast) >= (int) Settings::get('ops_digest_hour') && Settings::get('ops_digest_last') !== $today) {
            Settings::set('ops_digest_last', $today);
            $done[] = 'digest ' . self::sendDigest();
        }
        if ((self::lastBackup() ?? 0) < time() - 86400 + 600 && (int) gmdate('G', $sast) >= 1) $done[] = 'backup ' . basename(self::backup());
        return implode(', ', $done);
    }

    public static function sendDigest(): int
    {
        $todo = self::todo();
        $subject = $todo ? count($todo) . ' thing' . (count($todo) === 1 ? '' : 's') . ' need you today' : 'All clear: SeaGeek ran itself yesterday';
        foreach (self::recipients() as $to) Mail::queue($to, $subject, 'ops_digest', ['todo' => $todo, 'stats' => self::yesterday(), 'link' => app_url('/admin')]);
        return count(self::recipients());
    }

    /**
     * Email (and SMS, if a team phone is set) the moment something urgent starts.
     * Each problem alerts once, then again every 6 hours while it lasts.
     */
    public static function alerts(): int
    {
        $sent = 0;
        $state = json_decode(Settings::get('ops_alert_state'), true) ?: [];
        $urgent = array_filter(self::todo(), fn($t) => $t['level'] === 'urgent');
        $now = time();
        foreach ($urgent as $t) {
            if (($state[$t['key']] ?? 0) > $now - 21600) continue;
            $state[$t['key']] = $now;
            self::notify('Urgent: ' . $t['title'], $t['detail'], $t['href']);
            $sent++;
        }
        foreach (array_keys($state) as $k) if (!in_array($k, array_column($urgent, 'key'), true)) unset($state[$k]); // fixed: forget it
        Settings::set('ops_alert_state', json_encode($state));
        return $sent;
    }

    /** Sent straight away, not through the queue, because the queue may be the thing that is broken. */
    public static function notify(string $title, string $detail, string $href): void
    {
        $html = view('emails/ops_alert', ['subject' => $title, 'title' => $title, 'detail' => $detail, 'link' => app_url($href)], 'email');
        foreach (self::recipients() as $to) {
            [$ok, $err] = Mail::send($to, $title, $html, Mail::text($html));
            if (!$ok) log_line('ops', "Alert email to $to failed: $err");
        }
        $phone = Settings::get('ops_phone');
        if ($phone !== '') {
            try { Plugins::alertSms(Desk::house(), $phone, 'SeaGeek: ' . $title . '. ' . mb_substr($detail, 0, 100), 'ops-alert'); }
            catch (Throwable $e) { log_line('ops', 'Alert SMS failed: ' . $e->getMessage()); }
        }
        log_line('ops', 'Alert: ' . $title);
    }

    /**
     * Called on ordinary web requests (at most every 5 minutes): if the scheduled jobs have stopped,
     * nothing else would notice, so the website itself raises the alarm.
     */
    public static function watchdog(): void
    {
        $flag = STORAGE . '/cache/ops-watchdog';
        if (is_file($flag) && filemtime($flag) > time() - 300) return;
        @touch($flag);
        register_shutdown_function(function () {
            if (function_exists('fastcgi_finish_request')) @fastcgi_finish_request();
            try {
                $cron = Settings::get('last_cron_at');
                $since = (string) DB::value('SELECT MIN(created_at) FROM orgs');
                if ($cron !== '' && strtotime($cron . ' UTC') < time() - 900) self::alerts();
                elseif ($cron === '' && $since !== '' && strtotime($since . ' UTC') < time() - 3600) self::alerts();
            } catch (Throwable) {
            }
        });
    }

    // Backups -----------------------------------------------------------------

    public static function backupDir(): string
    {
        $d = STORAGE . '/backups';
        if (!is_dir($d)) @mkdir($d, 0700, true);
        return $d;
    }

    /** Every table, compressed. Old backups beyond the newest 14 are removed. */
    public static function backup(?string $file = null): string
    {
        $tables = array_values(array_filter(Schema::tables(), fn($t) => !in_array($t, ['sessions', 'rate_limits'], true)));
        $out = ['_meta' => ['made_at' => now(), 'tables' => count($tables)]];
        foreach ($tables as $t) $out[$t] = DB::all("SELECT * FROM $t");
        $file ??= self::backupDir() . '/seageek-' . gmdate('Ymd-His') . '.json.gz';
        file_put_contents($file, gzencode((string) json_encode($out), 6));
        @chmod($file, 0600);
        $all = glob(self::backupDir() . '/seageek-*.json.gz') ?: [];
        rsort($all);
        foreach (array_slice($all, 14) as $old) @unlink($old);
        Settings::set('last_backup_at', now());
        return $file;
    }

    public static function lastBackup(): ?int
    {
        $t = Settings::get('last_backup_at');
        return $t === '' ? null : strtotime($t . ' UTC');
    }

    public static function backups(): array
    {
        $all = glob(self::backupDir() . '/seageek-*.json.gz') ?: [];
        rsort($all);
        return array_map(fn($f) => ['name' => basename($f), 'size' => filesize($f), 'at' => filemtime($f)], $all);
    }

    public static function ago(string $ts): string
    {
        $s = max(0, time() - strtotime($ts . ' UTC'));
        return match (true) {
            $s < 90 => 'just now',
            $s < 5400 => round($s / 60) . ' minutes ago',
            $s < 129600 => round($s / 3600) . ' hours ago',
            default => round($s / 86400) . ' days ago',
        };
    }
}
