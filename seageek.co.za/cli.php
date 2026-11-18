<?php
/**
 * Command line tools.
 *   php cli.php migrate            apply database migrations
 *   php cli.php cron               run scheduled jobs once (schedule every minute)
 *   php cli.php worker             keep sending queued messages, email and webhooks (run under systemd/supervisor)
 *   php cli.php create-admin EMAIL NAME
 *   php cli.php backup FILE.json   export every table to JSON (for moving servers)
 *   php cli.php restore FILE.json  import a backup into an empty, migrated database
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') exit("CLI only\n");
require __DIR__ . '/app/bootstrap.php';
if (!installed()) exit("Not installed. Open the site in a browser or set SG_* environment variables first.\n");

$cmd = $argv[1] ?? 'help';
switch ($cmd) {
    case 'migrate':
        $done = Schema::migrate();
        Schema::seed();
        echo $done ? 'Applied migrations: ' . implode(', ', $done) . "\n" : "Database is up to date.\n";
        break;
    case 'cron':
        echo json_encode(Cron::run(), JSON_PRETTY_PRINT) . "\n";
        break;
    case 'worker':
        echo "Worker started. Ctrl+C to stop.\n";
        $last = 0;
        while (true) {
            $n = Gateway::processQueue(200) + Webhooks::deliver(100) + Mail::deliver(50) + Gateway::advanceSimulated();
            if (time() - $last >= 60) { Cron::run(); $last = time(); }
            if ($n === 0) sleep(2);
        }
    case 'create-admin':
        [$email, $name] = [strtolower($argv[2] ?? ''), $argv[3] ?? 'Admin'];
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) exit("Usage: php cli.php create-admin EMAIL NAME\n");
        $pw = Crypto::token(12);
        $house = Desk::house();
        DB::insert('users', ['org_id' => $house['id'], 'name' => $name, 'email' => $email, 'password_hash' => password_hash($pw, PASSWORD_DEFAULT), 'role' => 'owner', 'is_admin' => 1, 'email_verified_at' => now(), 'created_at' => now()]);
        echo "Admin created. Email: $email  Temporary password: $pw\n";
        break;
    case 'backup':
        $file = $argv[2] ?? ('backup-' . gmdate('Ymd-His') . '.json');
        $tables = ['settings', 'orgs', 'users', 'api_keys', 'plans', 'rates', 'partners', 'messages', 'ledger', 'invoices', 'payments', 'otp_codes', 'webhook_deliveries', 'email_outbox', 'wa_numbers', 'ai_agents', 'tickets', 'ticket_messages', 'macros', 'articles', 'audit_log', 'jobs', 'idempotency', 'schema_migrations'];
        $out = [];
        foreach ($tables as $t) $out[$t] = DB::all("SELECT * FROM $t");
        file_put_contents($file, json_encode($out));
        echo "Wrote $file. Keep app_key from app/config.php with it: stored secrets can't be read without it.\n";
        break;
    case 'restore':
        $data = json_decode((string) file_get_contents($argv[2] ?? ''), true);
        if (!is_array($data)) exit("Usage: php cli.php restore FILE.json\n");
        DB::tx(function () use ($data) {
            foreach ($data as $table => $rows) {
                DB::run("DELETE FROM $table");
                foreach ($rows as $row) DB::insert($table, $row);
            }
        });
        echo "Restored " . count($data) . " tables.\n";
        break;
    default:
        echo file_get_contents(__FILE__, false, null, 0, 700);
}
