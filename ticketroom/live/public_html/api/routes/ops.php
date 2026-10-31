<?php
// /api/admin/backups and /api/admin/outbox/retry: keeping a copy of the
// database and the email moving. Admins only; every action is in the audit log.
declare(strict_types=1);

route('GET', '/api/admin/backups', function () {
    adm_admin();
    $s = ops_status();
    return ['backups' => backup_list(), 'keep' => BACKUP_KEEP, 'keepBeforeUpgrade' => BACKUP_KEEP_UPGRADE, 'jobs' => $s['jobs'], 'problems' => ops_problems($s)];
});
route('POST', '/api/admin/backups', function () {
    $u = adm_admin();
    limit('backupnow', 10, 3600, $u['id']);
    try { $b = backup_take('manual'); }
    catch (RuntimeException $e) { throw conflict($e->getMessage(), 'backup_failed'); }
    audit('backup.created', ['actor' => $u, 'entityType' => 'backup', 'entityId' => $b['name'], 'ip' => client_ip(), 'details' => ['bytes' => $b['sizeBytes']]]);
    return json_out(['backup' => $b], 201);
});
// The file itself, sent from outside the website folder.
route('GET', '/api/admin/backups/:id', function ($a) {
    $u = adm_admin();
    $path = backup_path($a['id']);
    audit('backup.downloaded', ['actor' => $u, 'entityType' => 'backup', 'entityId' => basename($path), 'ip' => client_ip()]);
    return file_out($path, str_ends_with($path, '.sql.gz') ? 'application/gzip' : 'application/vnd.sqlite3', basename($path));
});

// Failed messages back in the queue: one, or all of them.
route('POST', '/api/admin/outbox/retry', function () {
    $u = adm_admin_or_support();
    $b = check(body(), ['id' => R::uuid(['optional' => true])]);
    $n = outbox_retry($b['id'] ?? null);
    audit('outbox.retried', ['actor' => $u, 'entityType' => 'message', 'entityId' => $b['id'] ?? 'all', 'details' => ['count' => $n]]);
    return ['retried' => $n];
});
