<?php
declare(strict_types=1);

require __DIR__ . '/backend.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    titopay_json_response(['ok' => false, 'error' => 'Method not allowed'], 405);
}

try {
    $input = titopay_json_input();
    $action = strtolower(trim((string)($input['action'] ?? 'start')));

    if ($action === 'start') {
        $payload = titopay_create_chat_session($input);
    } elseif ($action === 'send') {
        $payload = titopay_add_customer_chat_message((string)($input['chatId'] ?? ''), (string)($input['message'] ?? ''));
    } elseif ($action === 'poll') {
        $payload = titopay_fetch_chat_payload((string)($input['chatId'] ?? ''));
    } else {
        titopay_json_response(['ok' => false, 'error' => 'Invalid chat action'], 422);
    }

    titopay_json_response(['ok' => true] + $payload);
} catch (Throwable $error) {
    titopay_json_response(['ok' => false, 'error' => $error->getMessage()], 422);
}
