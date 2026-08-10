<?php
declare(strict_types=1);

require __DIR__ . '/../api/backend.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    titopay_json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
}

$candidate = titopay_store_career_application(titopay_json_input());
titopay_json_response(['ok' => true, 'candidate' => $candidate]);
