<?php
declare(strict_types=1);

require __DIR__ . '/../api/backend.php';

titopay_start_admin_session();
if (empty($_SESSION['titopay_admin'])) {
    titopay_json_response(['ok' => false, 'error' => 'Admin session required'], 403);
}

$rows = titopay_db()->query('SELECT * FROM career_applications ORDER BY updated_at DESC')->fetchAll(PDO::FETCH_ASSOC);
titopay_json_response(['ok' => true, 'applications' => $rows]);
