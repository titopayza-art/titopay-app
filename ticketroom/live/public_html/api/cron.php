<?php
// Background jobs on a schedule: email, reminders, expiring holds, the daily
// backup and alerts. Required for a live site. cPanel → Cron Jobs, every 5
// minutes, with the full path to PHP that cPanel shows for your domain:
//   /usr/local/bin/php /home/YOURUSER/public_html/api/cron.php >/dev/null 2>&1
// It prints nothing when all is well (so cron sends no email). A problem goes
// to the error output (and to php-errors.log in ticketroom-data) and the exit
// code is 1. --verbose lists the jobs that ran; --all runs every job now.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/bootstrap.php';
try {
    tr_load();
    tr_load_routes(); // jobs use route helpers (campaigns)
    $ran = run_due_jobs(in_array('--all', $argv, true), true);
} catch (Throwable $e) {
    fwrite(STDERR, 'TicketRoom cron: ' . $e->getMessage() . "\n");
    exit(1);
}
if (in_array('--verbose', $argv, true)) echo 'ran: ' . implode(', ', $ran) . "\n";
