<?php
// Optional: run background jobs on a schedule (cPanel → Cron Jobs, every 5 minutes):
//   php /home/YOURUSER/public_html/tr-app/cron.php
// Without it, jobs run after visitors' requests, which is fine for most sites.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/bootstrap.php';
$docroot = dirname(__DIR__);
$dir = tr_find_config($docroot);
if (!$dir) { fwrite(STDERR, "TicketRoom is not set up yet.\n"); exit(1); }
tr_load($dir);
$ran = run_due_jobs(in_array('--all', $argv, true));
echo 'ran: ' . implode(', ', $ran) . "\n";
