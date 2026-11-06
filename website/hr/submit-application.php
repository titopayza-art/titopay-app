<?php
declare(strict_types=1);

require __DIR__ . '/../api/backend.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    titopay_json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
}

titopay_enforce_public_rate_limit('career-application', 8, 3600);
try {
    $candidate = titopay_store_career_application(titopay_json_input());
} catch (PDOException $error) {
    titopay_json_response(['ok' => false, 'error' => 'We could not save your application. Please try again.'], 503);
} catch (RuntimeException $error) {
    titopay_json_response(['ok' => false, 'error' => $error->getMessage()], 422);
}
titopay_json_response(['ok' => true, 'candidate' => $candidate]);
