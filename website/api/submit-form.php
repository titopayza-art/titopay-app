<?php
declare(strict_types=1);

require __DIR__ . '/backend.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    titopay_json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
}

titopay_enforce_public_rate_limit('public-form', 10, 600);
try {
    $record = titopay_store_public_submission(titopay_json_input());
} catch (PDOException $error) {
    titopay_json_response(['ok' => false, 'error' => 'We could not save your request. Please try again.'], 503);
}
titopay_json_response(['ok' => true, 'submission' => $record]);
