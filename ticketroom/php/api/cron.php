<?php
// Optional: run background jobs on a schedule (cPanel → Cron Jobs, every 5 minutes):
//   php /home/YOURUSER/public_html/api/cron.php
// Without it, jobs run after visitors' requests, which is fine for most sites.
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/bootstrap.php';
tr_load();
foreach (glob(TR_APP . '/routes/*.php') as $f) require_once $f; // jobs use route helpers (campaigns)
$ran = run_due_jobs(in_array('--all', $argv, true));
echo 'ran: ' . implode(', ', $ran) . "\n";
