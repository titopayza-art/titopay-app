<?php
declare(strict_types=1);

require __DIR__ . '/../api/backend.php';

titopay_start_admin_session();
$role = strtolower((string)($_SESSION['titopay_admin_user']['role'] ?? ''));
if (empty($_SESSION['titopay_admin']) || !in_array($role, ['ceo', 'hr'], true)) {
    titopay_json_response(['ok' => false, 'error' => 'Admin session required'], 403);
}

try {
    $rows = titopay_db()->query('SELECT * FROM career_applications ORDER BY updated_at DESC')->fetchAll(PDO::FETCH_ASSOC);
} catch (PDOException $error) {
    titopay_json_response(['ok' => false, 'error' => 'Applications are currently unavailable.'], 503);
}
titopay_json_response(['ok' => true, 'applications' => $rows]);
