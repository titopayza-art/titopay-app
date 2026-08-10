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
    header('Content-Type: application/json');
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

function titopay_send_mail(string $to, string $subject, string $body): bool
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
    $stmt = $pdo->prepare('SELECT * FROM support_chat_sessions WHERE id = :id OR chat_number = :id');
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

function titopay_start_admin_session(): void
{
    $config = titopay_config();
    session_name((string)($config['session_name'] ?? 'titopay_admin_session'));
    session_start();
}

function titopay_store_public_submission(array $input): array
{
    if (trim((string)($input['website'] ?? '')) !== '') {
        return ['ok' => true];
    }

    $formType = strtolower(trim((string)($input['formType'] ?? '')));
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

    $pdo = titopay_db();
    $meta = titopay_request_meta();
    $now = gmdate('c');
    $email = strtolower(trim((string)$input['email']));
    $role = trim((string)$input['jobTitle']);
    $existing = $pdo->prepare('SELECT id, created_at, application_number FROM career_applications WHERE email = :email AND job_title = :job_title');
    $existing->execute(['email' => $email, 'job_title' => $role]);
    $existingRecord = $existing->fetch(PDO::FETCH_ASSOC) ?: null;
    $id = $existingRecord['id'] ?? (string)($input['id'] ?? titopay_id('candidate'));
    $createdAt = $existingRecord['created_at'] ?? (string)($input['createdAt'] ?? $now);
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
        'stage' => 'screening',
        'notes' => trim((string)($input['notes'] ?? '')),
        'status' => 'active',
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
    $pdo->prepare($upsertSql)->execute($record);

    $pdo->prepare('DELETE FROM application_attachments WHERE application_id = :id')->execute(['id' => $id]);
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
        file_put_contents($uploadDir . '/' . $storageName, $data, LOCK_EX);
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

    titopay_send_mail(
        $record['email'],
        'TitoPay application received: ' . $record['application_number'],
        titopay_application_email_body($record, titopay_application_template_message('received', $record))
    );

    return $record;
}
