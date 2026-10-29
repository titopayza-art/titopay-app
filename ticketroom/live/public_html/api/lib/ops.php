<?php
// Operations: database backups, health and alerts, light rate limits,
// upload space and clean-up, and safe names in emails to other people.
declare(strict_types=1);

// ============================================================== upgrade 49
// Email retries: a lease on each message being sent and the time of its
// next try. Each column and index is added only if missing.
function tr_upgrade_ops(): void
{
    foreach (['claimed_until', 'next_attempt_at'] as $c) {
        if (!val("SELECT 1 FROM pragma_table_info('message_outbox') WHERE name = ?", [$c])) db()->exec("ALTER TABLE message_outbox ADD COLUMN $c TEXT");
    }
    db()->exec('CREATE INDEX IF NOT EXISTS message_outbox_due_idx ON message_outbox (status, next_attempt_at)');
}

// ============================================================== backups
// A consistent copy of the whole database (VACUUM INTO), made while the site
// keeps running: once a day, before every database upgrade and when an admin
// presses "Back up now". They live in ticketroom-data/backups, outside the
// website, and only admins can download them (Admin portal, Backups). The
// newest 14 daily or on-demand copies are kept, and the newest 5 made before
// upgrades.
const BACKUP_KEEP = 14;
const BACKUP_KEEP_UPGRADE = 5;
const BACKUP_NAME_RE = '/^ticketroom-\d{8}-\d{6}-(daily|manual|before-upgrade)(-[a-z0-9]{4})?\.sqlite$/';
function backup_dir(): string
{
    $d = data_dir() . '/backups';
    if (!is_dir($d)) @mkdir($d, 0750, true);
    if (is_dir($d) && !is_file("$d/.htaccess")) @file_put_contents("$d/.htaccess", "Require all denied\n");
    return $d;
}
function backup_take(string $reason = 'manual'): array
{
    $dir = backup_dir();
    if (!is_dir($dir) || !is_writable($dir)) throw new RuntimeException('The backups folder in ticketroom-data cannot be written to. Set ticketroom-data to permission 750 or 755.');
    $name = 'ticketroom-' . gmdate('Ymd-His') . "-$reason.sqlite";
    if (file_exists("$dir/$name")) $name = 'ticketroom-' . gmdate('Ymd-His') . "-$reason-" . strtolower(random_code(4)) . '.sqlite';
    $path = "$dir/$name";
    try {
        db()->exec('VACUUM INTO ' . db()->quote($path));
    } catch (PDOException $e) {
        @unlink($path);
        throw new RuntimeException('The backup could not be made (it needs SQLite 3.27 or newer): ' . $e->getMessage());
    }
    @chmod($path, 0600);
    backup_prune();
    return backup_info($path);
}
function backup_info(string $path): array
{
    preg_match(BACKUP_NAME_RE, basename($path), $m);
    // The id (the name without .sqlite) is what download addresses use: web
    // servers refuse addresses ending in .sqlite.
    return ['id' => basename($path, '.sqlite'), 'name' => basename($path), 'reason' => $m[1] ?? 'manual', 'sizeBytes' => (int) @filesize($path), 'createdAt' => iso_at((float) @filemtime($path))];
}
function backup_list(): array
{
    $out = [];
    foreach (glob(backup_dir() . '/ticketroom-*.sqlite') ?: [] as $f) if (preg_match(BACKUP_NAME_RE, basename($f))) $out[] = backup_info($f);
    // Names start with the time, so the newest comes first.
    usort($out, fn($a, $b) => strcmp($b['name'], $a['name']));
    return $out;
}
function backup_prune(): void
{
    $kept = ['regular' => 0, 'upgrade' => 0];
    foreach (backup_list() as $b) {
        $k = $b['reason'] === 'before-upgrade' ? 'upgrade' : 'regular';
        if (++$kept[$k] > ($k === 'upgrade' ? BACKUP_KEEP_UPGRADE : BACKUP_KEEP)) @unlink(backup_dir() . '/' . $b['name']);
    }
}
function backup_path(string $id): string
{
    $name = str_ends_with($id, '.sqlite') ? $id : "$id.sqlite";
    $path = backup_dir() . '/' . $name;
    if (!preg_match(BACKUP_NAME_RE, $name) || !is_file($path)) throw not_found('That backup is not there any more.');
    return $path;
}

// ============================================================== health and alerts
// What /api/health and the alert email know about the background work. Never
// anything private: job names, counts and times.
const OPS_BACKLOG_MESSAGES = 25;     // this many messages waiting...
const OPS_BACKLOG_MINUTES = 30;      // ...the oldest for this long
const OPS_FAILED_PER_DAY = 20;
const OPS_BACKUP_MAX_HOURS = 36;
const OPS_CRON_MAX_MINUTES = 30;
const OPS_ALERT_EVERY = 21600;       // at most one alert email every 6 hours
function ops_job_allowance(int $every): int { $every = max($every, 60); return (int) max($every * 1.5, $every + 7200); }
function ops_status(): array
{
    $now = time();
    $last = [];
    foreach (rows('SELECT name, last_run FROM job_runs') as $r) $last[$r['name']] = (int) $r['last_run'];
    $stale = [];
    $newest = 0;
    $since = (int) (to_unix((string) val("SELECT occurred_at FROM audit_log WHERE action = 'system.installed' ORDER BY id LIMIT 1")) ?? 0);
    foreach (jobs() as [$name, $every]) {
        $newest = max($newest, $last[$name] ?? 0);
        // A brand-new site has not had time to run its slow jobs yet.
        $ran = $last[$name] ?? $since;
        if ($ran < $now - ops_job_allowance((int) $every)) $stale[] = $name;
    }
    $cron = (int) val("SELECT value FROM meta WHERE key = 'cron_last_run'");
    $nowIso = now_iso();
    $o = row("SELECT COALESCE(SUM(CASE WHEN next_attempt_at IS NULL OR next_attempt_at <= ? THEN 1 ELSE 0 END),0) AS due,
                     COALESCE(SUM(CASE WHEN next_attempt_at > ? THEN 1 ELSE 0 END),0) AS waiting, MIN(created_at) AS oldest
                FROM message_outbox WHERE status = 'queued'", [$nowIso, $nowIso]);
    $failed = (int) val("SELECT count(*) FROM message_outbox WHERE status = 'failed' AND created_at > ?", [iso_in(-86400)]);
    $backups = backup_list();
    return [
        'jobs' => ['fresh' => !$stale, 'stale' => $stale, 'lastRunAt' => $newest ? iso_at($newest) : null,
            'cron' => ['lastRunAt' => $cron ? iso_at($cron) : null, 'fresh' => $cron > $now - OPS_CRON_MAX_MINUTES * 60]],
        'outbox' => ['queued' => (int) $o['due'] + (int) $o['waiting'], 'due' => (int) $o['due'], 'retrying' => (int) $o['waiting'],
            'oldestMinutes' => $o['oldest'] ? (int) floor(($now - (to_unix($o['oldest']) ?? $now)) / 60) : 0, 'failed24h' => $failed, 'paused' => mail_paused()],
        'backups' => ['lastAt' => $backups[0]['createdAt'] ?? null, 'count' => count($backups)],
    ];
}
// The problems worth telling someone about, in plain words.
function ops_problems(?array $s = null): array
{
    $s ??= ops_status();
    $out = [];
    if ($s['outbox']['queued'] >= OPS_BACKLOG_MESSAGES && $s['outbox']['oldestMinutes'] >= OPS_BACKLOG_MINUTES) {
        $out[] = "{$s['outbox']['queued']} messages are waiting to go out, the oldest for {$s['outbox']['oldestMinutes']} minutes.";
    }
    if ($s['outbox']['failed24h'] >= OPS_FAILED_PER_DAY) $out[] = "{$s['outbox']['failed24h']} messages could not be sent in the last day. Admin portal, Messages, shows why.";
    if ($s['jobs']['stale']) $out[] = 'Background jobs have not run on time: ' . implode(', ', $s['jobs']['stale']) . '. Check the cron job in cPanel.';
    $installed = (int) (to_unix((string) val("SELECT occurred_at FROM audit_log WHERE action = 'system.installed' ORDER BY id LIMIT 1")) ?? 0);
    $lastBackup = (int) (to_unix($s['backups']['lastAt']) ?? 0);
    if ((!$lastBackup && $installed && $installed < time() - 2 * 86400) || ($lastBackup && $lastBackup < time() - OPS_BACKUP_MAX_HOURS * 3600)) {
        $out[] = 'No database backup has been made in the last ' . OPS_BACKUP_MAX_HOURS . ' hours. Admin portal, Backups.';
    }
    return $out;
}
// One email to the platform owner when something is stuck, at most every 6
// hours. It goes straight out, not through the queue (which may be the problem).
function ops_alert_check(): int
{
    $problems = ops_problems();
    if (!$problems) return 0;
    if ((int) val("SELECT value FROM meta WHERE key = 'ops_alert_at'") > time() - OPS_ALERT_EVERY) return 0;
    q("INSERT INTO meta (key, value) VALUES ('ops_alert_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [(string) time()]);
    $to = val("SELECT u.email FROM meta m JOIN users u ON u.id = m.value WHERE m.key = 'owner_user_id' AND u.status = 'active'");
    if (!$to) return 0;
    $t = tpl('opsAlert', ['problems' => $problems]);
    send_now((string) $to, $t['subject'], $t['body']);
    return 1;
}

// ============================================================== light rate limits
// For busy read-only pages (browsing events): counted in small files in the
// data folder, or in APCu where the host has it, never in the database, so a
// rush of visitors adds no database writes. Counts are per minute window.
function limit_light(string $bucket, int $max, int $windowSeconds, ?string $key = null): void
{
    if (cfg('rateLimitDisabled', false)) return;
    $k = $bucket . ':' . ($key ?? client_ip());
    $slot = intdiv(time(), max(1, $windowSeconds));
    if (function_exists('apcu_inc') && filter_var(ini_get('apc.enabled'), FILTER_VALIDATE_BOOLEAN) && (PHP_SAPI !== 'cli' || filter_var(ini_get('apc.enable_cli'), FILTER_VALIDATE_BOOLEAN))) {
        $n = apcu_inc("tr:$k:$slot", 1, $okInc, $windowSeconds + 5);
        if ($n !== false) { if ($n > $max) throw too_many(); return; }
    }
    $dir = data_dir() . '/limits';
    if (!is_dir($dir)) @mkdir($dir, 0750);
    $file = $dir . '/' . substr(sha256($k), 0, 32);
    $fp = @fopen($file, 'c+');
    if (!$fp) return; // never block a visitor because a counter file could not be made
    try {
        flock($fp, LOCK_EX);
        [$was, $n] = array_map('intval', array_pad(explode(' ', (string) stream_get_contents($fp)), 2, 0)) + [0, 0];
        $n = $was === $slot ? $n + 1 : 1;
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, "$slot $n");
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
    if ($n > $max) throw too_many();
}
// Counter files from earlier windows (run with the retention job).
function limit_light_prune(): void
{
    foreach (glob(data_dir() . '/limits/*') ?: [] as $f) if (@filemtime($f) < time() - 3600) @unlink($f);
}

// ============================================================== uploads
// Each organiser has room for 200 MB of images (change it in
// ticketroom-data/config.php: 'quotas' => ['imagesMb' => 200]). Images that
// ended up on nothing are removed after 30 days.
function upload_quota_check(?string $orgId, int $bytes): void
{
    if (!$orgId) return;
    $mb = (int) cfg('quotas.imagesMb', 200);
    $used = (int) val('SELECT COALESCE(SUM(size_bytes),0) FROM uploads WHERE organiser_id = ?', [$orgId]);
    if ($used + $bytes > $mb * 1048576) {
        throw new AppError(413, 'quota_full', "Your organisation has used its $mb MB of space for images. Images you no longer use are cleared after 30 days. Write to hello@ticketroom.co.za if you need more room.");
    }
}
function uploads_cleanup(): int
{
    $list = rows("SELECT u.id FROM uploads u WHERE u.created_at < ?
                     AND NOT EXISTS (SELECT 1 FROM events e WHERE e.image_upload_id = u.id OR instr(COALESCE(e.ticket_groups, ''), u.id) > 0 OR instr(COALESCE(e.lineup, ''), u.id) > 0)
                     AND NOT EXISTS (SELECT 1 FROM organisers o WHERE o.logo_upload_id = u.id)
                     AND NOT EXISTS (SELECT 1 FROM ad_posters p WHERE p.image_upload_id = u.id)
                     AND NOT EXISTS (SELECT 1 FROM event_promotions ep WHERE instr(COALESCE(ep.social_request, ''), u.id) > 0)
                     AND NOT EXISTS (SELECT 1 FROM event_change_requests cr WHERE instr(cr.changes_json, u.id) > 0 OR instr(cr.before_json, u.id) > 0)
                   LIMIT 500", [iso_in(-30 * 86400)]);
    $n = 0;
    foreach ($list as $r) {
        try { q('DELETE FROM uploads WHERE id = ?', [$r['id']]); }
        catch (PDOException) { continue; } // still used somewhere
        @unlink(data_dir() . '/uploads/' . $r['id']);
        $n++;
    }
    return $n;
}

// ============================================================== names in emails
// A name someone typed goes into emails sent to other people ("Sipho sent you
// a ticket"). It must never carry a link, a web address or hidden characters
// that could make the email look like something it is not.
function email_safe_name($s, int $max = 60): string
{
    $s = (string) $s;
    $s = (string) preg_replace('/[\x00-\x1F\x7F]|[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}\x{FEFF}]/u', ' ', $s);
    $s = (string) preg_replace('#\b(?:https?|ftp)\s*:\s*/\S*|\bwww\s*\.\S*#iu', ' ', $s);
    // Anything shaped like a web address (word.word), whatever its ending.
    $s = (string) preg_replace('/\S*[\p{L}\p{N}-]\.[\p{L}]{2,}\S*/u', ' ', $s);
    $s = str_replace(['<', '>', '@', '[', ']', '{', '}', '|', '\\'], ' ', $s);
    $s = trim((string) preg_replace('/\s+/u', ' ', $s));
    return mb_substr($s, 0, $max);
}
const EMAIL_NAME_KEYS = ['name' => '', 'fromName' => 'Someone', 'friendName' => 'your friend', 'customer' => 'a customer', 'by' => 'Someone', 'organiser' => 'An organiser', 'vendor' => 'a vendor'];
function tpl_clean_names(array $a): array
{
    foreach (EMAIL_NAME_KEYS as $k => $fallback) {
        if (!isset($a[$k]) || !is_string($a[$k])) continue;
        $clean = email_safe_name($a[$k], $k === 'organiser' || $k === 'vendor' ? 120 : 60);
        $a[$k] = $clean !== '' ? $clean : $fallback;
    }
    if (isset($a['order']['buyer_name']) && is_string($a['order']['buyer_name'])) $a['order']['buyer_name'] = email_safe_name($a['order']['buyer_name']);
    return $a;
}
