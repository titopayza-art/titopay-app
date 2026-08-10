<?php
declare(strict_types=1);

require __DIR__ . '/backend.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    titopay_json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
}

titopay_json_response(['ok' => true, 'features' => titopay_public_features()]);
