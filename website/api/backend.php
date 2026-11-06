<?php
declare(strict_types=1);

function titopay_config(): array
{
    $config = require __DIR__ . '/config.php';
    $local = __DIR__ . '/config.local.php';
    if (file_exists($local)) {
        $config = array_replace_recursive($config, require $local);
    }
    return $config;
}

function titopay_private_path(string $child = ''): string
{
    $base = __DIR__ . '/private';
    if (!is_dir($base)) {
        mkdir($base, 0750, true);
    }
    return $child === '' ? $base : $base . '/' . ltrim($child, '/');
}

function titopay_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $config = titopay_config();
    $database = $config['database'] ?? [];
    $driver = strtolower((string)($database['driver'] ?? 'sqlite'));
    if ($driver === 'mysql') {
        $mysql = $database['mysql'] ?? [];
        $charset = (string)($mysql['charset'] ?? 'utf8mb4');
        $dsn = sprintf(
            'mysql:host=%s;dbname=%s;charset=%s',
            (string)($mysql['host'] ?? 'localhost'),
            (string)($mysql['database'] ?? ''),
            $charset
        );
        $pdo = new PDO($dsn, (string)($mysql['username'] ?? ''), (string)($mysql['password'] ?? ''));
    } else {
        $pdo = new PDO('sqlite:' . titopay_private_path('titopay.sqlite'));
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    if (titopay_is_sqlite($pdo)) {
        $pdo->exec('PRAGMA foreign_keys = ON');
        $pdo->exec('CREATE TABLE IF NOT EXISTS public_submissions (
        id TEXT PRIMARY KEY,
        form_type TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        interest TEXT,
        request_type TEXT,
        message TEXT,
        route TEXT,
        destination TEXT,
        context TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS career_applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        job_title TEXT NOT NULL,
        stage TEXT NOT NULL,
        notes TEXT,
        status TEXT NOT NULL,
        source TEXT,
        phone TEXT,
        qualification TEXT,
        portfolio TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(email, job_title)
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS application_attachments (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES career_applications(id) ON DELETE CASCADE,
        field TEXT,
        label TEXT,
        original_name TEXT NOT NULL,
        mime_type TEXT,
        size INTEGER,
        storage_name TEXT NOT NULL,
        created_at TEXT NOT NULL
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_tickets (
        id TEXT PRIMARY KEY,
        ticket_number TEXT NOT NULL UNIQUE,
        submission_id TEXT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        request_type TEXT,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        source TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_ticket_updates (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL,
        notify_sender INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS career_application_updates (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL REFERENCES career_applications(id) ON DELETE CASCADE,
        author_name TEXT NOT NULL,
        author_role TEXT NOT NULL,
        communication_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        notify_sender INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_chat_sessions (
        id TEXT PRIMARY KEY,
        chat_number TEXT NOT NULL UNIQUE,
        ticket_id TEXT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        topic TEXT,
        status TEXT NOT NULL,
        callback_requested INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
    )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_chat_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES support_chat_sessions(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
    )');
    } else {
        $pdo->exec('CREATE TABLE IF NOT EXISTS public_submissions (
        id VARCHAR(80) PRIMARY KEY,
        form_type VARCHAR(30) NOT NULL,
        name VARCHAR(180) NOT NULL,
        email VARCHAR(180) NOT NULL,
        interest VARCHAR(180) NULL,
        request_type VARCHAR(180) NULL,
        message TEXT NULL,
        route VARCHAR(255) NULL,
        destination VARCHAR(255) NULL,
        context VARCHAR(120) NULL,
        ip_address VARCHAR(80) NULL,
        user_agent VARCHAR(255) NULL,
        created_at VARCHAR(40) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS career_applications (
        id VARCHAR(80) PRIMARY KEY,
        name VARCHAR(180) NOT NULL,
        email VARCHAR(180) NOT NULL,
        job_title VARCHAR(180) NOT NULL,
        stage VARCHAR(80) NOT NULL,
        notes TEXT NULL,
        status VARCHAR(80) NOT NULL,
        source VARCHAR(120) NULL,
        phone VARCHAR(80) NULL,
        qualification VARCHAR(255) NULL,
        portfolio VARCHAR(255) NULL,
        ip_address VARCHAR(80) NULL,
        user_agent VARCHAR(255) NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        UNIQUE KEY uniq_candidate_role (email, job_title)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS application_attachments (
        id VARCHAR(80) PRIMARY KEY,
        application_id VARCHAR(80) NOT NULL,
        field VARCHAR(120) NULL,
        label VARCHAR(180) NULL,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(180) NULL,
        size INT NULL,
        storage_name VARCHAR(180) NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        INDEX idx_application_id (application_id),
        CONSTRAINT fk_application_attachments_application
            FOREIGN KEY (application_id) REFERENCES career_applications(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_tickets (
        id VARCHAR(80) PRIMARY KEY,
        ticket_number VARCHAR(40) NOT NULL UNIQUE,
        submission_id VARCHAR(80) NULL,
        name VARCHAR(180) NOT NULL,
        email VARCHAR(180) NOT NULL,
        request_type VARCHAR(180) NULL,
        subject VARCHAR(220) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(40) NOT NULL,
        priority VARCHAR(40) NOT NULL,
        source VARCHAR(120) NULL,
        created_by VARCHAR(180) NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        closed_at VARCHAR(40) NULL,
        INDEX idx_ticket_status (status),
        INDEX idx_ticket_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_ticket_updates (
        id VARCHAR(80) PRIMARY KEY,
        ticket_id VARCHAR(80) NOT NULL,
        author_name VARCHAR(180) NOT NULL,
        author_role VARCHAR(80) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(40) NOT NULL,
        notify_sender TINYINT(1) NOT NULL DEFAULT 1,
        created_at VARCHAR(40) NOT NULL,
        INDEX idx_ticket_id (ticket_id),
        CONSTRAINT fk_support_ticket_updates_ticket
            FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS career_application_updates (
        id VARCHAR(80) PRIMARY KEY,
        application_id VARCHAR(80) NOT NULL,
        author_name VARCHAR(180) NOT NULL,
        author_role VARCHAR(80) NOT NULL,
        communication_type VARCHAR(80) NOT NULL,
        stage VARCHAR(80) NOT NULL,
        status VARCHAR(80) NOT NULL,
        message TEXT NOT NULL,
        notify_sender TINYINT(1) NOT NULL DEFAULT 1,
        created_at VARCHAR(40) NOT NULL,
        INDEX idx_application_id (application_id),
        CONSTRAINT fk_career_application_updates_application
            FOREIGN KEY (application_id) REFERENCES career_applications(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_chat_sessions (
        id VARCHAR(80) PRIMARY KEY,
        chat_number VARCHAR(40) NOT NULL UNIQUE,
        ticket_id VARCHAR(80) NULL,
        name VARCHAR(180) NOT NULL,
        email VARCHAR(180) NOT NULL,
        phone VARCHAR(80) NULL,
        topic VARCHAR(180) NULL,
        status VARCHAR(40) NOT NULL,
        callback_requested TINYINT(1) NOT NULL DEFAULT 0,
        assigned_to VARCHAR(180) NULL,
        ip_address VARCHAR(80) NULL,
        user_agent VARCHAR(255) NULL,
        created_at VARCHAR(40) NOT NULL,
        updated_at VARCHAR(40) NOT NULL,
        closed_at VARCHAR(40) NULL,
        INDEX idx_chat_status (status),
        INDEX idx_chat_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        $pdo->exec('CREATE TABLE IF NOT EXISTS support_chat_messages (
        id VARCHAR(80) PRIMARY KEY,
        chat_id VARCHAR(80) NOT NULL,
        sender_type VARCHAR(40) NOT NULL,
        sender_name VARCHAR(180) NOT NULL,
        message TEXT NOT NULL,
        created_at VARCHAR(40) NOT NULL,
        INDEX idx_chat_id (chat_id),
        CONSTRAINT fk_support_chat_messages_chat
            FOREIGN KEY (chat_id) REFERENCES support_chat_sessions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    }
    titopay_ensure_schema($pdo);
    return $pdo;
}

function titopay_is_sqlite(PDO $pdo): bool
{
    return $pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
}

/**
 * Public feature flags. Only the keys listed here are ever published, so a
 * configuration mistake cannot leak unrelated settings to the browser.
 */
function titopay_public_features(): array
{
    $known = [
        'events_public_page' => true,
        'events_waitlist' => true,
        'event_wallets' => false,
        'event_payments' => false,
        'event_rfid' => false,
        'event_vendor_settlements' => false,
    ];
    $configured = titopay_config()['features'] ?? [];
    $features = [];
    foreach ($known as $key => $default) {
        $features[$key] = filter_var($configured[$key] ?? $default, FILTER_VALIDATE_BOOLEAN);
    }
    return $features;
}

function titopay_feature_enabled(string $key): bool
{
    return titopay_public_features()[$key] ?? false;
}

function titopay_column_exists(PDO $pdo, string $table, string $column): bool
{
    $allowed = ['public_submissions', 'career_applications', 'support_tickets', 'support_chat_sessions', 'support_chat_messages'];
    if (!in_array($table, $allowed, true)) {
        throw new InvalidArgumentException('Unsupported table.');
    }
    if (titopay_is_sqlite($pdo)) {
        $rows = $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            if ((string)$row['name'] === $column) {
                return true;
            }
        }
        return false;
    }
    $stmt = $pdo->prepare('SHOW COLUMNS FROM `' . $table . '` LIKE :column');
    $stmt->execute(['column' => $column]);
    return (bool)$stmt->fetch(PDO::FETCH_ASSOC);
}

function titopay_ensure_column(PDO $pdo, string $table, string $column, string $sqliteDefinition, string $mysqlDefinition): void
{
    if (!titopay_column_exists($pdo, $table, $column)) {
        $definition = titopay_is_sqlite($pdo) ? $sqliteDefinition : $mysqlDefinition;
        $pdo->exec('ALTER TABLE ' . $table . ' ADD COLUMN ' . $definition);
    }
}

function titopay_ensure_schema(PDO $pdo): void
{
    titopay_ensure_column($pdo, 'public_submissions', 'phone', 'phone TEXT', 'phone VARCHAR(80) NULL');
    titopay_ensure_column($pdo, 'career_applications', 'application_number', 'application_number TEXT', 'application_number VARCHAR(40) NULL');
    titopay_ensure_column($pdo, 'support_tickets', 'phone', 'phone TEXT', 'phone VARCHAR(80) NULL');
    titopay_ensure_column($pdo, 'support_tickets', 'category', 'category TEXT', 'category VARCHAR(40) NULL');
}

function titopay_json_input(): array
{
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input)) {
        titopay_json_response(['ok' => false, 'error' => 'Invalid JSON'], 400);
    }
    return $input;
}

function titopay_json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store, private');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload);
    exit;
}

function titopay_id(string $prefix): string
{
    return $prefix . '-' . bin2hex(random_bytes(12));
}

function titopay_ticket_number(PDO $pdo): string
{
    return titopay_short_reference($pdo, 'support_tickets', 'ticket_number');
}

function titopay_application_number(PDO $pdo): string
{
    return titopay_short_reference($pdo, 'career_applications', 'application_number');
}

function titopay_chat_number(PDO $pdo): string
{
    return titopay_short_reference($pdo, 'support_chat_sessions', 'chat_number');
}

function titopay_short_reference(PDO $pdo, string $table, string $column): string
{
    $allowed = [
        'support_tickets' => ['ticket_number'],
        'career_applications' => ['application_number'],
        'support_chat_sessions' => ['chat_number'],
    ];
    if (!isset($allowed[$table]) || !in_array($column, $allowed[$table], true)) {
        throw new InvalidArgumentException('Unsupported reference target.');
    }
    do {
        $number = 'TP' . (string)random_int(100000, 999999);
        $stmt = $pdo->prepare('SELECT COUNT(*) FROM ' . $table . ' WHERE ' . $column . ' = :number');
        $stmt->execute(['number' => $number]);
    } while ((int)$stmt->fetchColumn() > 0);
    return $number;
}

function titopay_request_meta(): array
{
    return [
        'ip' => substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 80),
        'ua' => substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
    ];
}

function titopay_send_mail(string $to, string $subject, string $body, ?string $html = null, array $extraHeaders = []): bool
{
    $config = titopay_config();
    if (empty($config['mail_enabled']) || !function_exists('mail') || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
        return false;
    }

    $from = (string)($config['mail_from'] ?? 'support@titopay.co.za');
    $fromName = preg_replace('/[\r\n]+/', ' ', (string)($config['mail_from_name'] ?? 'TitoPay Support'));
    $safeSubject = preg_replace('/[\r\n]+/', ' ', $subject);
    $headers = [
        'From: ' . $fromName . ' <' . $from . '>',
        'Reply-To: ' . $from,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'X-Mailer: TitoPay Website',
    ];
    foreach ($extraHeaders as $name => $value) {
        $name = preg_replace('/[^A-Za-z0-9-]/', '', (string)$name);
        $value = preg_replace('/[\r\n]+/', ' ', (string)$value);
        if ($name !== '' && $value !== '') $headers[] = $name . ': ' . $value;
    }
    if ($html !== null) {
        $boundary = 'titopay_' . bin2hex(random_bytes(16));
        $headers[3] = 'Content-Type: multipart/alternative; boundary="' . $boundary . '"';
        $body = '--' . $boundary . "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
            . chunk_split(base64_encode($body)) . '--' . $boundary . "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"
            . chunk_split(base64_encode($html)) . '--' . $boundary . "--\r\n";
    }
    return @mail($to, $safeSubject, $body, implode("\r\n", $headers));
}

function titopay_ticket_email_body(array $ticket, string $message): string
{
    return "Hi " . $ticket['name'] . ",\n\n"
        . $message . "\n\n"
        . "Ticket number: " . $ticket['ticket_number'] . "\n"
        . "Status: " . ucfirst((string)$ticket['status']) . "\n\n"
        . "Phone on record: " . ((string)($ticket['phone'] ?? '') ?: 'Not provided') . "\n\n"
        . "Please keep this ticket number for reference when contacting TitoPay.\n\n"
        . "TitoPay Support\nsupport@titopay.co.za";
}

function titopay_application_email_body(array $application, string $message): string
{
    return "Hi " . $application['name'] . ",\n\n"
        . $message . "\n\n"
        . "Application number: " . $application['application_number'] . "\n"
        . "Position: " . $application['job_title'] . "\n"
        . "Stage: " . ucfirst((string)$application['stage']) . "\n"
        . "Status: " . ucfirst((string)$application['status']) . "\n\n"
        . "Please keep this application number for reference when contacting TitoPay HR.\n\n"
        . "TitoPay HR\ncareers@titopay.co.za";
}

function titopay_add_ticket_update(string $ticketId, string $message, array $adminUser, string $status = 'open', bool $notifySender = true): array
{
    $pdo = titopay_db();
    $stmt = $pdo->prepare('SELECT * FROM support_tickets WHERE id = :id');
    $stmt->execute(['id' => $ticketId]);
    $ticket = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$ticket) {
        throw new RuntimeException('Ticket not found.');
    }

    $message = trim($message);
    $allowedStatuses = ['open', 'pending', 'closed'];
    if (!in_array($status, $allowedStatuses, true)) {
        $status = (string)$ticket['status'];
    }
    if ($message === '' && $status === (string)$ticket['status']) {
        throw new RuntimeException('Add an update or change the status.');
    }

    $now = gmdate('c');
    $update = [
        'id' => titopay_id('ticket-update'),
        'ticket_id' => $ticketId,
        'author_name' => (string)($adminUser['name'] ?? 'TitoPay Admin'),
        'author_role' => (string)($adminUser['role'] ?? 'Admin'),
        'message' => $message !== '' ? $message : ('Ticket marked ' . $status . '.'),
        'status' => $status,
        'notify_sender' => $notifySender ? 1 : 0,
        'created_at' => $now,
    ];
    $pdo->prepare('INSERT INTO support_ticket_updates
        (id, ticket_id, author_name, author_role, message, status, notify_sender, created_at)
        VALUES (:id, :ticket_id, :author_name, :author_role, :message, :status, :notify_sender, :created_at)')
        ->execute($update);

    $pdo->prepare('UPDATE support_tickets SET status = :status, updated_at = :updated_at, closed_at = :closed_at WHERE id = :id')
        ->execute([
            'status' => $status,
            'updated_at' => $now,
            'closed_at' => $status === 'closed' ? $now : null,
            'id' => $ticketId,
        ]);

    $ticket['status'] = $status;
    $ticket['updated_at'] = $now;
    if ($notifySender) {
        titopay_send_mail(
            (string)$ticket['email'],
            'TitoPay ticket update: ' . $ticket['ticket_number'],
            titopay_ticket_email_body($ticket, "TitoPay has added an update to your support ticket:\n\n" . $update['message'])
        );
    }

    return $update;
}

function titopay_create_ticket(array $input, array $adminUser = [], string $source = 'admin'): array
{
    $pdo = titopay_db();
    $name = trim((string)($input['name'] ?? ''));
    $email = strtolower(trim((string)($input['email'] ?? '')));
    $requestType = trim((string)($input['requestType'] ?? $input['request_type'] ?? 'General support'));
    $message = trim((string)($input['message'] ?? ''));
    $subject = trim((string)($input['subject'] ?? $requestType));
    $phone = trim((string)($input['phone'] ?? ''));
    $category = strtolower(trim((string)($input['category'] ?? 'support')));
    if (!in_array($category, ['support', 'waitlist', 'hr'], true)) {
        $category = 'support';
    }
    $priority = strtolower(trim((string)($input['priority'] ?? 'normal')));
    if (!in_array($priority, ['low', 'normal', 'high', 'urgent'], true)) {
        $priority = 'normal';
    }
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || $message === '') {
        throw new RuntimeException('Valid name, email, and ticket message are required.');
    }
    if ($subject === '') {
        $subject = 'TitoPay support request';
    }

    $now = gmdate('c');
    $record = [
        'id' => titopay_id('ticket'),
        'ticket_number' => titopay_ticket_number($pdo),
        'submission_id' => trim((string)($input['submission_id'] ?? '')),
        'name' => $name,
        'email' => $email,
        'phone' => $phone,
        'category' => $category,
        'request_type' => $requestType,
        'subject' => $subject,
        'message' => $message,
        'status' => 'open',
        'priority' => $priority,
        'source' => $source,
        'created_by' => (string)($adminUser['name'] ?? 'Marketing website'),
        'created_at' => $now,
        'updated_at' => $now,
        'closed_at' => null,
    ];

    $pdo->prepare('INSERT INTO support_tickets
        (id, ticket_number, submission_id, name, email, phone, category, request_type, subject, message, status, priority, source, created_by, created_at, updated_at, closed_at)
        VALUES (:id, :ticket_number, :submission_id, :name, :email, :phone, :category, :request_type, :subject, :message, :status, :priority, :source, :created_by, :created_at, :updated_at, :closed_at)')
        ->execute($record);

    $pdo->prepare('INSERT INTO support_ticket_updates
        (id, ticket_id, author_name, author_role, message, status, notify_sender, created_at)
        VALUES (:id, :ticket_id, :author_name, :author_role, :message, :status, :notify_sender, :created_at)')
        ->execute([
            'id' => titopay_id('ticket-update'),
            'ticket_id' => $record['id'],
            'author_name' => (string)($adminUser['name'] ?? 'Marketing website'),
            'author_role' => (string)($adminUser['role'] ?? 'Website'),
            'message' => 'Ticket opened: ' . $message,
            'status' => 'open',
            'notify_sender' => 0,
            'created_at' => $now,
        ]);

    titopay_send_mail(
        $email,
        'TitoPay support ticket ' . $record['ticket_number'],
        titopay_ticket_email_body($record, 'Your TitoPay support ticket has been opened. We have received your request and will respond as soon as possible.')
    );

    return $record;
}

function titopay_fetch_chat_payload(string $chatId): array
{
    $pdo = titopay_db();
    $stmt = $pdo->prepare('SELECT * FROM support_chat_sessions WHERE id = :id');
    $stmt->execute(['id' => trim($chatId)]);
    $chat = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$chat) {
        throw new RuntimeException('Chat session not found.');
    }

    $messages = $pdo->prepare('SELECT * FROM support_chat_messages WHERE chat_id = :chat_id ORDER BY created_at ASC');
    $messages->execute(['chat_id' => $chat['id']]);
    return [
        'chat' => $chat,
        'messages' => $messages->fetchAll(PDO::FETCH_ASSOC),
    ];
}

function titopay_insert_chat_message(PDO $pdo, string $chatId, string $senderType, string $senderName, string $message): array
{
    $senderType = strtolower(trim($senderType));
    if (!in_array($senderType, ['customer', 'agent', 'system'], true)) {
        $senderType = 'system';
    }
    $message = trim($message);
    if ($message === '') {
        throw new RuntimeException('Type a message before sending.');
    }
    $now = gmdate('c');
    $record = [
        'id' => titopay_id('chat-message'),
        'chat_id' => $chatId,
        'sender_type' => $senderType,
        'sender_name' => trim($senderName) ?: 'TitoPay',
        'message' => $message,
        'created_at' => $now,
    ];
    $pdo->prepare('INSERT INTO support_chat_messages
        (id, chat_id, sender_type, sender_name, message, created_at)
        VALUES (:id, :chat_id, :sender_type, :sender_name, :message, :created_at)')
        ->execute($record);
    $pdo->prepare('UPDATE support_chat_sessions SET updated_at = :updated_at WHERE id = :id')
        ->execute(['updated_at' => $now, 'id' => $chatId]);
    return $record;
}

function titopay_create_chat_session(array $input): array
{
    if (trim((string)($input['website'] ?? '')) !== '') {
        return ['chat' => null, 'messages' => []];
    }

    $pdo = titopay_db();
    $name = trim((string)($input['name'] ?? ''));
    $email = strtolower(trim((string)($input['email'] ?? '')));
    $phone = trim((string)($input['phone'] ?? ''));
    $topic = trim((string)($input['topic'] ?? 'General support'));
    $message = trim((string)($input['message'] ?? ''));
    $callbackRequested = !empty($input['callbackRequested']);

    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || $message === '') {
        throw new RuntimeException('Valid name, email, and message are required.');
    }
    if ($callbackRequested && $phone === '') {
        throw new RuntimeException('Please add a contact number for a callback.');
    }
    if ($topic === '') {
        $topic = $callbackRequested ? 'Callback request' : 'Live support';
    }

    $meta = titopay_request_meta();
    $ticket = titopay_create_ticket([
        'name' => $name,
        'email' => $email,
        'phone' => $phone,
        'category' => 'support',
        'requestType' => $callbackRequested ? 'Callback request' : 'Live chat',
        'subject' => ($callbackRequested ? 'Callback request: ' : 'Live chat: ') . $topic,
        'message' => $message,
        'priority' => $callbackRequested ? 'high' : 'normal',
    ], [], $callbackRequested ? 'website callback chat' : 'website live chat');

    $now = gmdate('c');
    $chat = [
        'id' => titopay_id('chat'),
        'chat_number' => titopay_chat_number($pdo),
        'ticket_id' => $ticket['id'],
        'name' => $name,
        'email' => $email,
        'phone' => $phone,
        'topic' => $topic,
        'status' => 'open',
        'callback_requested' => $callbackRequested ? 1 : 0,
        'assigned_to' => '',
        'ip_address' => $meta['ip'],
        'user_agent' => $meta['ua'],
        'created_at' => $now,
        'updated_at' => $now,
        'closed_at' => null,
    ];
    $pdo->prepare('INSERT INTO support_chat_sessions
        (id, chat_number, ticket_id, name, email, phone, topic, status, callback_requested, assigned_to, ip_address, user_agent, created_at, updated_at, closed_at)
        VALUES (:id, :chat_number, :ticket_id, :name, :email, :phone, :topic, :status, :callback_requested, :assigned_to, :ip_address, :user_agent, :created_at, :updated_at, :closed_at)')
        ->execute($chat);

    titopay_insert_chat_message($pdo, $chat['id'], 'customer', $name, $message);
    titopay_insert_chat_message(
        $pdo,
        $chat['id'],
        'system',
        'TitoPay Support',
        'Your TitoPay support chat is open. Chat number: ' . $chat['chat_number'] . '. Ticket number: ' . $ticket['ticket_number'] . '.'
    );

    titopay_send_mail(
        $email,
        'TitoPay support chat ' . $chat['chat_number'],
        "Hi " . $name . ",\n\n"
        . "Your TitoPay support chat has been opened.\n\n"
        . "Chat number: " . $chat['chat_number'] . "\n"
        . "Ticket number: " . $ticket['ticket_number'] . "\n"
        . "Callback requested: " . ($callbackRequested ? 'Yes' : 'No') . "\n\n"
        . "TitoPay Support\nsupport@titopay.co.za"
    );

    return titopay_fetch_chat_payload($chat['id']);
}

function titopay_add_customer_chat_message(string $chatId, string $message): array
{
    $payload = titopay_fetch_chat_payload($chatId);
    $chat = $payload['chat'];
    if ((string)$chat['status'] === 'closed') {
        throw new RuntimeException('This chat has been closed. Please open a new chat if you still need help.');
    }
    titopay_insert_chat_message(titopay_db(), (string)$chat['id'], 'customer', (string)$chat['name'], $message);
    return titopay_fetch_chat_payload((string)$chat['id']);
}

function titopay_agent_reply_chat(string $chatId, string $message, array $adminUser, string $status = 'open'): array
{
    $payload = titopay_fetch_chat_payload($chatId);
    $chat = $payload['chat'];
    $allowedStatuses = ['open', 'pending', 'closed'];
    if (!in_array($status, $allowedStatuses, true)) {
        $status = (string)$chat['status'];
    }
    $pdo = titopay_db();
    $now = gmdate('c');
    if (trim($message) !== '') {
        titopay_insert_chat_message($pdo, (string)$chat['id'], 'agent', (string)($adminUser['name'] ?? 'TitoPay Support'), $message);
        titopay_send_mail(
            (string)$chat['email'],
            'TitoPay chat update: ' . $chat['chat_number'],
            "Hi " . $chat['name'] . ",\n\n"
            . "TitoPay Support replied to your chat " . $chat['chat_number'] . ":\n\n"
            . trim($message) . "\n\n"
            . "TitoPay Support\nsupport@titopay.co.za"
        );
    }
    $pdo->prepare('UPDATE support_chat_sessions SET status = :status, assigned_to = :assigned_to, updated_at = :updated_at, closed_at = :closed_at WHERE id = :id')
        ->execute([
            'status' => $status,
            'assigned_to' => (string)($adminUser['name'] ?? 'TitoPay Support'),
            'updated_at' => $now,
            'closed_at' => $status === 'closed' ? $now : null,
            'id' => $chat['id'],
        ]);

    if (!empty($chat['ticket_id'])) {
        titopay_add_ticket_update(
            (string)$chat['ticket_id'],
            trim($message) !== '' ? 'Live chat update: ' . trim($message) : 'Live chat status changed to ' . $status . '.',
            $adminUser,
            $status,
            false
        );
    }

    return titopay_fetch_chat_payload((string)$chat['id']);
}

function titopay_application_template_message(string $type, array $application): string
{
    $name = (string)$application['name'];
    $role = (string)$application['job_title'];
    if ($type === 'declined_current_stage') {
        return "Thank you for applying for the " . $role . " role at TitoPay. After reviewing your application at this stage, we will not be progressing your application further. We appreciate the time you invested and wish you well in your career search.";
    }
    if ($type === 'first_round') {
        return "Thank you for applying for the " . $role . " role at TitoPay. We are pleased to let you know that your application has progressed to the first round of interviews. TitoPay HR will contact you with the next steps.";
    }
    if ($type === 'information_request') {
        return "Thank you for your application for the " . $role . " role at TitoPay. TitoPay HR requires additional information before we can continue reviewing your application. Please reply with the requested information.";
    }
    if ($type === 'received') {
        return "Thank you for applying for the " . $role . " role at TitoPay. We have received your application and TitoPay HR will review it. Only shortlisted candidates will be contacted for next steps.";
    }
    return "TitoPay HR has an update regarding your application for the " . $role . " role.";
}

function titopay_add_application_update(string $applicationId, string $message, array $adminUser, string $communicationType = 'general_update', string $stage = 'screening', string $status = 'active', bool $notifySender = true): array
{
    $pdo = titopay_db();
    $stmt = $pdo->prepare('SELECT * FROM career_applications WHERE id = :id');
    $stmt->execute(['id' => $applicationId]);
    $application = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$application) {
        throw new RuntimeException('Application not found.');
    }

    $allowedStages = ['screening', 'first_round', 'interview', 'offer', 'closed'];
    $allowedStatuses = ['active', 'pending', 'declined', 'successful', 'closed'];
    if (!in_array($stage, $allowedStages, true)) {
        $stage = (string)$application['stage'];
    }
    if (!in_array($status, $allowedStatuses, true)) {
        $status = (string)$application['status'];
    }
    $message = trim($message);
    if ($message === '') {
        $message = titopay_application_template_message($communicationType, $application);
    }

    $now = gmdate('c');
    $update = [
        'id' => titopay_id('application-update'),
        'application_id' => $applicationId,
        'author_name' => (string)($adminUser['name'] ?? 'TitoPay HR'),
        'author_role' => (string)($adminUser['role'] ?? 'HR'),
        'communication_type' => $communicationType,
        'stage' => $stage,
        'status' => $status,
        'message' => $message,
        'notify_sender' => $notifySender ? 1 : 0,
        'created_at' => $now,
    ];
    $pdo->prepare('INSERT INTO career_application_updates
        (id, application_id, author_name, author_role, communication_type, stage, status, message, notify_sender, created_at)
        VALUES (:id, :application_id, :author_name, :author_role, :communication_type, :stage, :status, :message, :notify_sender, :created_at)')
        ->execute($update);
    $pdo->prepare('UPDATE career_applications SET stage = :stage, status = :status, updated_at = :updated_at WHERE id = :id')
        ->execute([
            'stage' => $stage,
            'status' => $status,
            'updated_at' => $now,
            'id' => $applicationId,
        ]);

    $application['stage'] = $stage;
    $application['status'] = $status;
    $application['updated_at'] = $now;
    if ($notifySender) {
        titopay_send_mail(
            (string)$application['email'],
            'TitoPay application update: ' . $application['application_number'],
            titopay_application_email_body($application, $message)
        );
    }

    return $update;
}

function titopay_staff_db(): PDO
{
    $pdo = titopay_db();
    $pdo->exec('CREATE TABLE IF NOT EXISTS website_staff (username VARCHAR(120) PRIMARY KEY, name VARCHAR(160) NOT NULL, role VARCHAR(20) NOT NULL, password_hash VARCHAR(255) NOT NULL, created_at VARCHAR(40) NOT NULL)');
    return $pdo;
}

function titopay_create_website_staff(array $actor, array $input): void
{
    if (strtolower((string)($actor['role'] ?? '')) !== 'ceo') {
        throw new RuntimeException('Only the CEO can add website staff.');
    }
    $username = strtolower(trim((string)($input['username'] ?? '')));
    $name = trim((string)($input['name'] ?? ''));
    $role = (string)($input['role'] ?? '');
    $password = (string)($input['password'] ?? '');
    if (!filter_var($username, FILTER_VALIDATE_EMAIL) || strlen($username) > 120 || $name === '' || strlen($name) > 160) {
        throw new RuntimeException('Enter a name and valid staff email address.');
    }
    if (!in_array($role, ['support', 'hr'], true)) {
        throw new RuntimeException('Choose Support or HR access.');
    }
    if (strlen($password) < 12 || strlen($password) > 72) {
        throw new RuntimeException('Use a password between 12 and 72 characters.');
    }
    foreach ((titopay_config()['admin_users'] ?? []) as $user) {
        if (strtolower((string)($user['username'] ?? '')) === $username) {
            throw new RuntimeException('That staff email is already in use.');
        }
    }
    $pdo = titopay_staff_db();
    $check = $pdo->prepare('SELECT username FROM website_staff WHERE username = :username');
    $check->execute(['username' => $username]);
    if ($check->fetchColumn()) throw new RuntimeException('That staff email is already in use.');
    $stmt = $pdo->prepare('INSERT INTO website_staff (username, name, role, password_hash, created_at) VALUES (:username, :name, :role, :password_hash, :created_at)');
    $stmt->execute(['username' => $username, 'name' => $name, 'role' => $role, 'password_hash' => password_hash($password, PASSWORD_DEFAULT), 'created_at' => gmdate('c')]);
}

function titopay_verify_admin_credentials(string $username, string $password): ?array
{
    $config = titopay_config();
    $iterations = (int)($config['admin_pbkdf2_iterations'] ?? 200000);
    $username = strtolower(trim($username));
    if ($username === '' || $password === '') {
        return null;
    }

    foreach (($config['admin_users'] ?? []) as $user) {
        if (!is_array($user) || strtolower((string)($user['username'] ?? '')) !== $username) {
            continue;
        }
        $salt = (string)($user['salt'] ?? '');
        $hash = (string)($user['hash'] ?? '');
        if ($salt === '' || $hash === '') {
            return null;
        }
        $computed = hash_pbkdf2('sha256', $password, $salt, $iterations, 64);
        if (hash_equals($hash, $computed)) {
            return [
                'username' => (string)$user['username'],
                'name' => (string)($user['name'] ?? $user['username']),
                'role' => (string)($user['role'] ?? 'Admin'),
            ];
        }
    }

    $stmt = titopay_staff_db()->prepare('SELECT username, name, role, password_hash FROM website_staff WHERE username = :username');
    $stmt->execute(['username' => $username]);
    $staff = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($staff) {
        if (!password_verify($password, (string)$staff['password_hash'])) return null;
        return ['username' => $staff['username'], 'name' => $staff['name'], 'role' => $staff['role']];
    }

    $salt = (string)($config['admin_password_salt'] ?? '');
    $hash = (string)($config['admin_password_hash'] ?? '');
    if ($salt !== '' && $hash !== '') {
        $computed = hash_pbkdf2('sha256', $password, $salt, $iterations, 64);
        if (hash_equals($hash, $computed)) {
            return ['username' => $username, 'name' => 'TitoPay Admin', 'role' => 'Admin'];
        }
    }

    return null;
}

function titopay_verify_admin_password(string $password): bool
{
    return titopay_verify_admin_credentials('admin', $password) !== null;
}

function titopay_admin_configured(): bool
{
    $config = titopay_config();
    foreach (($config['admin_users'] ?? []) as $user) {
        if (is_array($user) && (string)($user['username'] ?? '') !== '' && (string)($user['salt'] ?? '') !== '' && (string)($user['hash'] ?? '') !== '') {
            return true;
        }
    }
    return (string)($config['admin_password_salt'] ?? '') !== '' && (string)($config['admin_password_hash'] ?? '') !== '';
}

function titopay_ip_in_cidr(string $address, string $network): bool
{
    $parts = explode('/', $network, 2);
    if (count($parts) !== 2 || !ctype_digit($parts[1])) return false;
    $ip = @inet_pton($address);
    $base = @inet_pton($parts[0]);
    if ($ip === false || $base === false || strlen($ip) !== strlen($base)) return false;
    $bits = (int)$parts[1];
    if ($bits < 0 || $bits > strlen($ip) * 8) return false;
    $bytes = intdiv($bits, 8);
    if (substr($ip, 0, $bytes) !== substr($base, 0, $bytes)) return false;
    $rest = $bits % 8;
    return $rest === 0 || ((ord($ip[$bytes]) ^ ord($base[$bytes])) & (0xff << (8 - $rest))) === 0;
}

function titopay_request_uses_trusted_proxy(bool $cloudflareOnly = false): bool
{
    // Only configured infrastructure may supply forwarded security headers.
    // Cloudflare ranges verified against its published IPv4/IPv6 lists.
    $ranges = ['173.245.48.0/20','103.21.244.0/22','103.22.200.0/22','103.31.4.0/22','141.101.64.0/18','108.162.192.0/18','190.93.240.0/20','188.114.96.0/20','197.234.240.0/22','198.41.128.0/17','162.158.0.0/15','104.16.0.0/13','104.24.0.0/14','172.64.0.0/13','131.0.72.0/22','2400:cb00::/32','2606:4700::/32','2803:f800::/32','2405:b500::/32','2405:8100::/32','2a06:98c0::/29','2c0f:f248::/32'];
    $config = titopay_config();
    if (!$cloudflareOnly) {
        $ranges = array_merge($ranges, (array)($config['trusted_proxy_cidrs'] ?? []));
    }
    $peer = (string)($_SERVER['CONN_REMOTE_ADDR'] ?? $_SERVER['REMOTE_ADDR'] ?? '');
    foreach ($ranges as $range) {
        if (is_string($range) && titopay_ip_in_cidr($peer, $range)) return true;
    }
    return false;
}

function titopay_request_is_https(): bool
{
    if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if ((string)($_SERVER['SERVER_PORT'] ?? '') === '443') {
        return true;
    }
    return titopay_request_uses_trusted_proxy() && strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

function titopay_start_admin_session(): void
{
    $config = titopay_config();
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.use_trans_sid', '0');
    session_name((string)($config['session_name'] ?? 'titopay_admin_session'));
    // The admin cookie is never readable by page scripts, never sent over plain
    // HTTP, and never sent on cross-site requests other than top-level links.
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => titopay_request_is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();

    // Sign an idle admin out after the configured quiet period.
    $idleLimit = max(60, (int)($config['admin_idle_timeout_seconds'] ?? 1800));
    $absoluteLimit = max(60, (int)($config['admin_absolute_timeout_seconds'] ?? 28800));
    $now = time();
    if (!empty($_SESSION['titopay_admin'])) {
        $lastSeen = (int)($_SESSION['titopay_admin_last_seen'] ?? $now);
        $signedInAt = (int)($_SESSION['titopay_admin_signed_in_at'] ?? $now);
        if ($now - $lastSeen > $idleLimit || $now - $signedInAt > $absoluteLimit) {
            $_SESSION = [];
            session_regenerate_id(true);
            $_SESSION['titopay_admin_notice'] = 'You were signed out after a period of inactivity.';
        } else {
            $_SESSION['titopay_admin_last_seen'] = $now;
            $_SESSION['titopay_admin_signed_in_at'] = $signedInAt;
        }
    }
}

/** Marks the session signed in under a fresh session id (no session fixation). */
function titopay_admin_sign_in(array $adminUser): void
{
    session_regenerate_id(true);
    $_SESSION['titopay_admin'] = true;
    $_SESSION['titopay_admin_user'] = $adminUser;
    $_SESSION['titopay_admin_last_seen'] = time();
    $_SESSION['titopay_admin_signed_in_at'] = time();
    unset($_SESSION['titopay_csrf']);
}

function titopay_csrf_token(): string
{
    if (empty($_SESSION['titopay_csrf']) || !is_string($_SESSION['titopay_csrf'])) {
        $_SESSION['titopay_csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['titopay_csrf'];
}

function titopay_csrf_field(): string
{
    return '<input type="hidden" name="csrf_token" value="' . htmlspecialchars(titopay_csrf_token(), ENT_QUOTES, 'UTF-8') . '">';
}

function titopay_csrf_valid(): bool
{
    $sent = (string)($_POST['csrf_token'] ?? '');
    $expected = (string)($_SESSION['titopay_csrf'] ?? '');
    return $sent !== '' && $expected !== '' && hash_equals($expected, $sent);
}

function titopay_client_ip(): string
{
    $direct = (string)($_SERVER['REMOTE_ADDR'] ?? '');
    if (titopay_request_uses_trusted_proxy(true)) {
        $forwarded = (string)($_SERVER['HTTP_CF_CONNECTING_IP'] ?? '');
        if (filter_var($forwarded, FILTER_VALIDATE_IP)) return $forwarded;
    }
    return filter_var($direct, FILTER_VALIDATE_IP) ? $direct : 'unknown';
}

function titopay_rate_limit_db(): PDO
{
    static $ready = false;
    $pdo = titopay_db();
    if (!$ready) {
        if (titopay_is_sqlite($pdo)) {
            $pdo->exec('CREATE TABLE IF NOT EXISTS security_rate_limits (
            bucket TEXT PRIMARY KEY,
            hits INTEGER NOT NULL,
            window_start INTEGER NOT NULL
        )');
        } else {
            $pdo->exec('CREATE TABLE IF NOT EXISTS security_rate_limits (
            bucket CHAR(64) PRIMARY KEY,
            hits INT NOT NULL,
            window_start BIGINT NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        }
        $ready = true;
    }
    return $pdo;
}

/** Buckets are stored as hashes, so the table never holds IP addresses or usernames. */
function titopay_rate_limit_key(string $name, string $subject): string
{
    return hash('sha256', $name . '|' . strtolower($subject));
}

function titopay_rate_limit_hits(string $name, string $subject, int $windowSeconds): int
{
    $stmt = titopay_rate_limit_db()->prepare('SELECT hits, window_start FROM security_rate_limits WHERE bucket = :bucket');
    $stmt->execute(['bucket' => titopay_rate_limit_key($name, $subject)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || time() - (int)$row['window_start'] >= $windowSeconds) {
        return 0;
    }
    return (int)$row['hits'];
}

function titopay_rate_limit_record(string $name, string $subject, int $windowSeconds): void
{
    $pdo = titopay_rate_limit_db();
    $bucket = titopay_rate_limit_key($name, $subject);
    $now = time();
    $stmt = $pdo->prepare('SELECT window_start FROM security_rate_limits WHERE bucket = :bucket');
    $stmt->execute(['bucket' => $bucket]);
    $start = $stmt->fetchColumn();
    if ($start === false) {
        $pdo->prepare('INSERT INTO security_rate_limits (bucket, hits, window_start) VALUES (:bucket, 1, :now)')
            ->execute(['bucket' => $bucket, 'now' => $now]);
    } elseif ($now - (int)$start >= $windowSeconds) {
        $pdo->prepare('UPDATE security_rate_limits SET hits = 1, window_start = :now WHERE bucket = :bucket')
            ->execute(['bucket' => $bucket, 'now' => $now]);
    } else {
        $pdo->prepare('UPDATE security_rate_limits SET hits = hits + 1 WHERE bucket = :bucket')
            ->execute(['bucket' => $bucket]);
    }
    if (random_int(1, 50) === 1) {
        $pdo->prepare('DELETE FROM security_rate_limits WHERE window_start < :cutoff')
            ->execute(['cutoff' => $now - 86400]);
    }
}

function titopay_rate_limit_clear(string $name, string $subject): void
{
    titopay_rate_limit_db()->prepare('DELETE FROM security_rate_limits WHERE bucket = :bucket')
        ->execute(['bucket' => titopay_rate_limit_key($name, $subject)]);
}

/**
 * Counts one request from this visitor and answers 429 once they pass the limit.
 * If the limiter itself fails, the request is let through: a broken limiter must
 * never take the public forms down.
 */
function titopay_enforce_public_rate_limit(string $name, int $max, int $windowSeconds): void
{
    try {
        $ip = titopay_client_ip();
        if (titopay_rate_limit_hits($name, $ip, $windowSeconds) >= $max) {
            titopay_json_response(['ok' => false, 'error' => 'Too many requests from this connection. Please wait a few minutes and try again.'], 429);
        }
        titopay_rate_limit_record($name, $ip, $windowSeconds);
    } catch (PDOException $error) {
        // Fail open for public forms.
    }
}

/** Failed sign-ins allowed per window before the account or connection is paused. */
const TITOPAY_LOGIN_WINDOW = 900;
const TITOPAY_LOGIN_MAX_PER_USER = 5;
const TITOPAY_LOGIN_MAX_PER_IP = 20;

function titopay_admin_login_locked(string $username): bool
{
    return titopay_rate_limit_hits('login-user', $username, TITOPAY_LOGIN_WINDOW) >= TITOPAY_LOGIN_MAX_PER_USER
        || titopay_rate_limit_hits('login-ip', titopay_client_ip(), TITOPAY_LOGIN_WINDOW) >= TITOPAY_LOGIN_MAX_PER_IP;
}

function titopay_admin_login_failed(string $username): void
{
    titopay_rate_limit_record('login-user', $username, TITOPAY_LOGIN_WINDOW);
    titopay_rate_limit_record('login-ip', titopay_client_ip(), TITOPAY_LOGIN_WINDOW);
}

function titopay_admin_login_succeeded(string $username): void
{
    titopay_rate_limit_clear('login-user', $username);
}

function titopay_store_public_submission(array $input): array
{
    if (trim((string)($input['website'] ?? '')) !== '') {
        return ['ok' => true];
    }

    $formType = strtolower(trim((string)($input['formType'] ?? '')));
    if ($formType === 'waitlist') {
        titopay_json_response(['ok' => false, 'error' => 'The app is available. Create your wallet at https://app.titopay.co.za'], 410);
    }
    if (!in_array($formType, ['waitlist', 'contact'], true)) {
        titopay_json_response(['ok' => false, 'error' => 'Invalid form type'], 422);
    }

    // TitoPay Events registrations share the existing waitlist and ticket
    // pipeline. They are only accepted while the Events waitlist flag is on.
    $submissionContext = strtolower(trim((string)($input['context'] ?? '')));
    if (strncmp($submissionContext, 'events', 6) === 0 && !titopay_feature_enabled('events_waitlist')) {
        titopay_json_response(['ok' => false, 'error' => 'TitoPay Events registration is not open yet.'], 503);
    }

    $name = trim((string)($input['name'] ?? ''));
    $email = strtolower(trim((string)($input['email'] ?? '')));
    if ($name === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        titopay_json_response(['ok' => false, 'error' => 'Valid name and email are required'], 422);
    }

    if ($formType === 'waitlist' && trim((string)($input['interest'] ?? '')) === '') {
        titopay_json_response(['ok' => false, 'error' => 'Interest is required'], 422);
    }

    if ($formType === 'contact' && (
        trim((string)($input['requestType'] ?? '')) === '' ||
        strlen(trim((string)($input['message'] ?? ''))) < 8
    )) {
        titopay_json_response(['ok' => false, 'error' => 'Request type and message are required'], 422);
    }

    $meta = titopay_request_meta();
    $record = [
        'id' => titopay_id('website'),
        'form_type' => $formType,
        'name' => $name,
        'email' => $email,
        'phone' => trim((string)($input['phone'] ?? '')),
        'interest' => trim((string)($input['interest'] ?? '')),
        'request_type' => trim((string)($input['requestType'] ?? '')),
        'message' => trim((string)($input['message'] ?? '')),
        'route' => trim((string)($input['route'] ?? '')),
        'destination' => trim((string)($input['destination'] ?? '')),
        'context' => trim((string)($input['context'] ?? 'website')),
        'ip_address' => $meta['ip'],
        'user_agent' => $meta['ua'],
        'created_at' => gmdate('c'),
    ];

    $sql = 'INSERT INTO public_submissions
        (id, form_type, name, email, phone, interest, request_type, message, route, destination, context, ip_address, user_agent, created_at)
        VALUES (:id, :form_type, :name, :email, :phone, :interest, :request_type, :message, :route, :destination, :context, :ip_address, :user_agent, :created_at)';
    titopay_db()->prepare($sql)->execute($record);
    if ($formType === 'contact' || $formType === 'waitlist') {
        try {
            $category = $formType === 'waitlist' ? 'waitlist' : ($record['route'] === 'careers' ? 'hr' : 'support');
            $isEventsRequest = strncmp($record['context'], 'events', 6) === 0;
            $waitlistSubject = $isEventsRequest ? 'TitoPay Events waitlist request' : 'TitoPay waitlist request';
            $subject = $formType === 'waitlist' ? $waitlistSubject : ($record['request_type'] ?: 'TitoPay support request');
            $message = $formType === 'waitlist'
                ? 'Waitlist interest: ' . $record['interest']
                : $record['message'];
            $ticket = titopay_create_ticket([
                'submission_id' => $record['id'],
                'name' => $record['name'],
                'email' => $record['email'],
                'phone' => $record['phone'],
                'category' => $category,
                'requestType' => $record['request_type'],
                'subject' => $subject,
                'message' => $message,
                'priority' => 'normal',
            ], [], $formType === 'waitlist' ? 'waitlist form' : 'contact form');
            $record['ticket_number'] = $ticket['ticket_number'];
            $record['ticket_id'] = $ticket['id'];
        } catch (Throwable $error) {
            $record['ticket_error'] = 'Ticket could not be created.';
        }
    }
    return $record;
}

function titopay_decode_data_url(string $dataUrl): ?string
{
    if (!preg_match('/^data:[^;]+;base64,(.+)$/', $dataUrl, $matches)) {
        return null;
    }
    $decoded = base64_decode($matches[1], true);
    return $decoded === false ? null : $decoded;
}

function titopay_safe_extension(string $name, string $mime): string
{
    $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
    $allowed = ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png'];
    if (in_array($ext, $allowed, true)) {
        return $ext;
    }
    if ($mime === 'application/pdf') {
        return 'pdf';
    }
    if ($mime === 'image/jpeg') {
        return 'jpg';
    }
    if ($mime === 'image/png') {
        return 'png';
    }
    return 'bin';
}

function titopay_validate_application_attachments(array $attachments): array
{
    if (count($attachments) > 8) throw new RuntimeException('Please upload no more than 8 documents.');
    $maxBytes = (int)(titopay_config()['max_upload_bytes'] ?? 4194304);
    $total = 0;
    $validated = [];
    foreach ($attachments as $attachment) {
        if (!is_array($attachment)) throw new RuntimeException('Invalid document. Please select the file again.');
        $name = basename(str_replace('\\', '/', (string)($attachment['name'] ?? '')));
        $url = (string)($attachment['dataUrl'] ?? '');
        if ($name === '' || strlen($url) > (int)ceil($maxBytes * 4 / 3) + 256) throw new RuntimeException('A document is missing or exceeds the file-size limit.');
        $data = titopay_decode_data_url($url);
        if ($data === null || strlen($data) === 0 || strlen($data) > $maxBytes) throw new RuntimeException('A document could not be read or exceeds the file-size limit.');
        $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        $mime = '';
        if ($extension === 'pdf' && substr($data, 0, 5) === '%PDF-') $mime = 'application/pdf';
        elseif ($extension === 'png' && substr($data, 0, 8) === "\x89PNG\r\n\x1a\n") $mime = 'image/png';
        elseif (in_array($extension, ['jpg','jpeg'], true) && substr($data, 0, 3) === "\xff\xd8\xff") $mime = 'image/jpeg';
        elseif ($extension === 'doc' && substr($data, 0, 8) === "\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") $mime = 'application/msword';
        elseif ($extension === 'docx' && substr($data, 0, 4) === "PK\x03\x04") $mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if ($mime === '') throw new RuntimeException('Upload a PDF, Word document, PNG or JPEG with a matching file extension.');
        $total += strlen($data);
        if ($total > $maxBytes * 8) throw new RuntimeException('The combined documents exceed the upload limit.');
        $attachment['name'] = $name;
        $attachment['type'] = $mime;
        $attachment['size'] = strlen($data);
        $validated[] = $attachment;
    }
    return $validated;
}

function titopay_store_career_application(array $input): array
{
    $required = ['name', 'email', 'jobTitle', 'phone'];
    foreach ($required as $field) {
        if (trim((string)($input[$field] ?? '')) === '') {
            titopay_json_response(['ok' => false, 'error' => 'Missing required field'], 422);
        }
    }
    if (!filter_var((string)$input['email'], FILTER_VALIDATE_EMAIL)) {
        titopay_json_response(['ok' => false, 'error' => 'Invalid email'], 422);
    }

    $input['attachments'] = titopay_validate_application_attachments((array)($input['attachments'] ?? []));
    $pdo = titopay_db();
    $meta = titopay_request_meta();
    $now = gmdate('c');
    $email = strtolower(trim((string)$input['email']));
    $role = trim((string)$input['jobTitle']);
    $existing = $pdo->prepare('SELECT id, created_at, application_number, stage, status FROM career_applications WHERE email = :email AND job_title = :job_title');
    $existing->execute(['email' => $email, 'job_title' => $role]);
    $existingRecord = $existing->fetch(PDO::FETCH_ASSOC) ?: null;
    $id = $existingRecord['id'] ?? titopay_id('candidate');
    $createdAt = $existingRecord['created_at'] ?? $now;
    $applicationNumber = (string)($existingRecord['application_number'] ?? '');
    if ($applicationNumber === '') {
        $applicationNumber = titopay_application_number($pdo);
    }

    $record = [
        'id' => $id,
        'application_number' => $applicationNumber,
        'name' => trim((string)$input['name']),
        'email' => $email,
        'job_title' => $role,
        'stage' => $existingRecord['stage'] ?? 'screening',
        'notes' => trim((string)($input['notes'] ?? '')),
        'status' => $existingRecord['status'] ?? 'active',
        'source' => 'Marketing website',
        'phone' => trim((string)($input['phone'] ?? '')),
        'qualification' => trim((string)($input['qualification'] ?? '')),
        'portfolio' => trim((string)($input['portfolio'] ?? '')),
        'ip_address' => $meta['ip'],
        'user_agent' => $meta['ua'],
        'created_at' => $createdAt,
        'updated_at' => $now,
    ];

    if (titopay_is_sqlite($pdo)) {
        $upsertSql = 'INSERT INTO career_applications
        (id, application_number, name, email, job_title, stage, notes, status, source, phone, qualification, portfolio, ip_address, user_agent, created_at, updated_at)
        VALUES (:id, :application_number, :name, :email, :job_title, :stage, :notes, :status, :source, :phone, :qualification, :portfolio, :ip_address, :user_agent, :created_at, :updated_at)
        ON CONFLICT(email, job_title) DO UPDATE SET
        application_number = COALESCE(career_applications.application_number, excluded.application_number),
        name = excluded.name, stage = excluded.stage, notes = excluded.notes, status = excluded.status, source = excluded.source,
        phone = excluded.phone, qualification = excluded.qualification, portfolio = excluded.portfolio, ip_address = excluded.ip_address,
        user_agent = excluded.user_agent, updated_at = excluded.updated_at';
    } else {
        $upsertSql = 'INSERT INTO career_applications
        (id, application_number, name, email, job_title, stage, notes, status, source, phone, qualification, portfolio, ip_address, user_agent, created_at, updated_at)
        VALUES (:id, :application_number, :name, :email, :job_title, :stage, :notes, :status, :source, :phone, :qualification, :portfolio, :ip_address, :user_agent, :created_at, :updated_at)
        ON DUPLICATE KEY UPDATE
        application_number = IFNULL(career_applications.application_number, VALUES(application_number)),
        name = VALUES(name), stage = VALUES(stage), notes = VALUES(notes), status = VALUES(status), source = VALUES(source),
        phone = VALUES(phone), qualification = VALUES(qualification), portfolio = VALUES(portfolio), ip_address = VALUES(ip_address),
        user_agent = VALUES(user_agent), updated_at = VALUES(updated_at)';
    }
    $pdo->beginTransaction();
    try {
    $pdo->prepare($upsertSql)->execute($record);

    // Reapplications append documents; previous attachments and their audit history remain available.
    $uploadDir = titopay_private_path('uploads');
    if (!is_dir($uploadDir)) {
        mkdir($uploadDir, 0750, true);
    }

    foreach (($input['attachments'] ?? []) as $attachment) {
        if (!is_array($attachment)) {
            continue;
        }
        $name = trim((string)($attachment['name'] ?? ''));
        $mime = trim((string)($attachment['type'] ?? 'application/octet-stream'));
        $data = titopay_decode_data_url((string)($attachment['dataUrl'] ?? ''));
        $size = (int)($attachment['size'] ?? 0);
        $maxBytes = (int)(titopay_config()['max_upload_bytes'] ?? 4194304);
        if ($name === '' || $data === null || strlen($data) > $maxBytes || $size > $maxBytes) {
            continue;
        }
        $attachmentId = titopay_id('attachment');
        $storageName = $attachmentId . '.' . titopay_safe_extension($name, $mime);
        $written = file_put_contents($uploadDir . '/' . $storageName, $data, LOCK_EX);
        if ($written !== strlen($data)) {
            throw new RuntimeException('A document could not be saved. Please try again.');
        }
        $pdo->prepare('INSERT INTO application_attachments
            (id, application_id, field, label, original_name, mime_type, size, storage_name, created_at)
            VALUES (:id, :application_id, :field, :label, :original_name, :mime_type, :size, :storage_name, :created_at)')
            ->execute([
                'id' => $attachmentId,
                'application_id' => $id,
                'field' => trim((string)($attachment['field'] ?? '')),
                'label' => trim((string)($attachment['label'] ?? 'Attachment')),
                'original_name' => $name,
                'mime_type' => $mime,
                'size' => strlen($data),
                'storage_name' => $storageName,
                'created_at' => $now,
            ]);
    }

    $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw new RuntimeException('Your application could not be saved. Please try again.', 0, $error);
    }

    titopay_send_mail(
        $record['email'],
        'TitoPay application received: ' . $record['application_number'],
        titopay_application_email_body($record, titopay_application_template_message('received', $record))
    );

    return $record;
}
