<?php
declare(strict_types=1);

require __DIR__ . '/backend.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    titopay_json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
}

$record = titopay_store_public_submission(titopay_json_input());
titopay_json_response(['ok' => true, 'submission' => $record]);
