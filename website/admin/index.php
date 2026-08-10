<?php
declare(strict_types=1);

require __DIR__ . '/../api/backend.php';

titopay_start_admin_session();

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

function admin_csv_download(string $filename, array $rows, array $columns): void
{
    header('Content-Type: text/csv; charset=UTF-8');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    $out = fopen('php://output', 'wb');
    fputcsv($out, array_values($columns));
    foreach ($rows as $row) {
        $line = [];
        foreach ($columns as $field => $label) {
            $line[] = (string)($row[$field] ?? '');
        }
        fputcsv($out, $line);
    }
    fclose($out);
    exit;
}

function admin_ticket_allowed(PDO $pdo, string $ticketId, string $roleKey): bool
{
    if ($roleKey === 'ceo') {
        return true;
    }
    $stmt = $pdo->prepare('SELECT category FROM support_tickets WHERE id = :id');
    $stmt->execute(['id' => $ticketId]);
    $category = (string)$stmt->fetchColumn();
    if ($roleKey === 'support') {
        return in_array($category ?: 'support', ['support', 'waitlist'], true);
    }
    if ($roleKey === 'hr') {
        return $category === 'hr';
    }
    return false;
}

if (isset($_GET['logout'])) {
    $_SESSION = [];
    session_destroy();
    header('Location: index.php');
    exit;
}

$loginError = '';
$adminNotice = '';
$adminError = '';
$signedIn = !empty($_SESSION['titopay_admin']);
$currentAdminUser = is_array($_SESSION['titopay_admin_user'] ?? null) ? $_SESSION['titopay_admin_user'] : [];
$roleKey = strtolower((string)($currentAdminUser['role'] ?? ''));
$canSeeAll = $roleKey === 'ceo';
$canSeeHr = $canSeeAll || $roleKey === 'hr';
$canSeeSupport = $canSeeAll || $roleKey === 'support';
$canSeeTicketDesk = $canSeeAll || $roleKey === 'support' || $roleKey === 'hr';

if ($_SERVER['REQUEST_METHOD'] === 'POST' && !$signedIn) {
    $adminUser = titopay_verify_admin_credentials((string)($_POST['username'] ?? ''), (string)($_POST['password'] ?? ''));
    if ($adminUser !== null) {
        $_SESSION['titopay_admin'] = true;
        $_SESSION['titopay_admin_user'] = $adminUser;
        header('Location: index.php');
        exit;
    }
    $loginError = 'Access denied.';
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $signedIn) {
    $action = (string)($_POST['action'] ?? '');
    $adminUser = is_array($_SESSION['titopay_admin_user'] ?? null) ? $_SESSION['titopay_admin_user'] : [];
    try {
        if ($action === 'create_ticket') {
            if (!$canSeeSupport) {
                throw new RuntimeException('You do not have permission to create support tickets.');
            }
            $ticket = titopay_create_ticket([
                'name' => (string)($_POST['name'] ?? ''),
                'email' => (string)($_POST['email'] ?? ''),
                'phone' => (string)($_POST['phone'] ?? ''),
                'category' => 'support',
                'requestType' => (string)($_POST['request_type'] ?? 'General support'),
                'subject' => (string)($_POST['subject'] ?? ''),
                'message' => (string)($_POST['message'] ?? ''),
                'priority' => (string)($_POST['priority'] ?? 'normal'),
            ], $adminUser, 'admin portal');
            $adminNotice = 'Ticket ' . $ticket['ticket_number'] . ' created and sent to the sender.';
        } elseif ($action === 'update_ticket') {
            $ticketId = (string)($_POST['ticket_id'] ?? '');
            if (!$canSeeTicketDesk || !admin_ticket_allowed(titopay_db(), $ticketId, $roleKey)) {
                throw new RuntimeException('You do not have permission to update this ticket.');
            }
            $notify = isset($_POST['notify_sender']);
            titopay_add_ticket_update(
                $ticketId,
                (string)($_POST['message'] ?? ''),
                $adminUser,
                (string)($_POST['status'] ?? 'open'),
                $notify
            );
            $adminNotice = 'Ticket updated.';
        } elseif ($action === 'reply_chat') {
            if (!$canSeeSupport) {
                throw new RuntimeException('You do not have permission to update support chats.');
            }
            $chat = titopay_agent_reply_chat(
                (string)($_POST['chat_id'] ?? ''),
                (string)($_POST['message'] ?? ''),
                $adminUser,
                (string)($_POST['status'] ?? 'open')
            );
            $adminNotice = 'Chat ' . $chat['chat']['chat_number'] . ' updated.';
        } elseif ($action === 'update_application') {
            if (!$canSeeHr) {
                throw new RuntimeException('You do not have permission to update applications.');
            }
            $notify = isset($_POST['notify_sender']);
            titopay_add_application_update(
                (string)($_POST['application_id'] ?? ''),
                (string)($_POST['message'] ?? ''),
                $adminUser,
                (string)($_POST['communication_type'] ?? 'general_update'),
                (string)($_POST['stage'] ?? 'screening'),
                (string)($_POST['status'] ?? 'active'),
                $notify
            );
            $adminNotice = 'Application communication saved.';
        }
    } catch (Throwable $error) {
        $adminError = $error->getMessage();
    }
}

if ($signedIn && isset($_GET['download'])) {
    $pdo = titopay_db();
    $stmt = $pdo->prepare('SELECT * FROM application_attachments WHERE id = :id');
    $stmt->execute(['id' => (string)$_GET['download']]);
    $file = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$file) {
        http_response_code(404);
        exit('File not found.');
    }
    $path = titopay_private_path('uploads/' . $file['storage_name']);
    if (!is_file($path)) {
        http_response_code(404);
        exit('File not found.');
    }
    header('Content-Type: ' . ($file['mime_type'] ?: 'application/octet-stream'));
    header('Content-Length: ' . filesize($path));
    $downloadName = preg_replace('/[^A-Za-z0-9._ -]/', '_', basename((string)$file['original_name']));
    header('Content-Disposition: attachment; filename="' . $downloadName . '"');
    readfile($path);
    exit;
}

if ($signedIn && isset($_GET['export'])) {
    $pdo = titopay_db();
    $export = (string)$_GET['export'];
    if ($export === 'applications') {
        if (!$canSeeHr) {
            http_response_code(403);
            exit('Not allowed.');
        }
        $rows = $pdo->query('SELECT application_number, name, email, phone, job_title, qualification, portfolio, stage, status, source, created_at, updated_at FROM career_applications ORDER BY updated_at DESC')->fetchAll(PDO::FETCH_ASSOC);
        admin_csv_download('titopay-career-applications.csv', $rows, [
            'application_number' => 'Application number',
            'name' => 'Name',
            'email' => 'Email',
            'phone' => 'Phone',
            'job_title' => 'Position',
            'qualification' => 'Qualification',
            'portfolio' => 'LinkedIn / portfolio',
            'stage' => 'Stage',
            'status' => 'Status',
            'source' => 'Source',
            'created_at' => 'Created',
            'updated_at' => 'Updated',
        ]);
    }
    if ($export === 'tickets') {
        if (!$canSeeTicketDesk) {
            http_response_code(403);
            exit('Not allowed.');
        }
        if ($canSeeAll) {
            $rows = $pdo->query('SELECT ticket_number, name, email, phone, category, request_type, subject, message, status, priority, source, created_by, created_at, updated_at, closed_at FROM support_tickets ORDER BY updated_at DESC')->fetchAll(PDO::FETCH_ASSOC);
        } elseif ($roleKey === 'support') {
            $rows = $pdo->query("SELECT ticket_number, name, email, phone, category, request_type, subject, message, status, priority, source, created_by, created_at, updated_at, closed_at FROM support_tickets WHERE COALESCE(category,'support') IN ('support','waitlist') ORDER BY updated_at DESC")->fetchAll(PDO::FETCH_ASSOC);
        } else {
            $rows = $pdo->query("SELECT ticket_number, name, email, phone, category, request_type, subject, message, status, priority, source, created_by, created_at, updated_at, closed_at FROM support_tickets WHERE category = 'hr' ORDER BY updated_at DESC")->fetchAll(PDO::FETCH_ASSOC);
        }
        admin_csv_download('titopay-support-tickets.csv', $rows, [
            'ticket_number' => 'Ticket number',
            'name' => 'Name',
            'email' => 'Email',
            'phone' => 'Phone',
            'category' => 'Category',
            'request_type' => 'Request type',
            'subject' => 'Subject',
            'message' => 'Message',
            'status' => 'Status',
            'priority' => 'Priority',
            'source' => 'Source',
            'created_by' => 'Created by',
            'created_at' => 'Created',
            'updated_at' => 'Updated',
            'closed_at' => 'Closed',
        ]);
    }
    if ($export === 'chats') {
        if (!$canSeeSupport) {
            http_response_code(403);
            exit('Not allowed.');
        }
        $rows = $pdo->query('SELECT chat_number, name, email, phone, topic, status, callback_requested, assigned_to, created_at, updated_at, closed_at FROM support_chat_sessions ORDER BY updated_at DESC')->fetchAll(PDO::FETCH_ASSOC);
        admin_csv_download('titopay-support-chats.csv', $rows, [
            'chat_number' => 'Chat number',
            'name' => 'Name',
            'email' => 'Email',
            'phone' => 'Phone',
            'topic' => 'Topic',
            'status' => 'Status',
            'callback_requested' => 'Callback requested',
            'assigned_to' => 'Assigned to',
            'created_at' => 'Created',
            'updated_at' => 'Updated',
            'closed_at' => 'Closed',
        ]);
    }
    if ($export === 'submissions') {
        if ($canSeeAll) {
            $rows = $pdo->query('SELECT form_type, name, email, phone, interest, request_type, message, route, destination, context, created_at FROM public_submissions ORDER BY created_at DESC')->fetchAll(PDO::FETCH_ASSOC);
        } elseif ($roleKey === 'support') {
            $rows = $pdo->query("SELECT form_type, name, email, phone, interest, request_type, message, route, destination, context, created_at FROM public_submissions WHERE form_type IN ('waitlist','contact') AND COALESCE(route,'') <> 'careers' ORDER BY created_at DESC")->fetchAll(PDO::FETCH_ASSOC);
        } elseif ($roleKey === 'hr') {
            $rows = $pdo->query("SELECT form_type, name, email, phone, interest, request_type, message, route, destination, context, created_at FROM public_submissions WHERE COALESCE(route,'') = 'careers' ORDER BY created_at DESC")->fetchAll(PDO::FETCH_ASSOC);
        } else {
            $rows = [];
        }
        admin_csv_download('titopay-website-submissions.csv', $rows, [
            'form_type' => 'Form type',
            'name' => 'Name',
            'email' => 'Email',
            'phone' => 'Phone',
            'interest' => 'Interest',
            'request_type' => 'Request type',
            'message' => 'Message',
            'route' => 'Route',
            'destination' => 'Destination',
            'context' => 'Context',
            'created_at' => 'Created',
        ]);
    }
    http_response_code(404);
    exit('Export not found.');
}

$publicSubmissions = [];
$applications = [];
$attachmentsByApplication = [];
$applicationUpdatesByApplication = [];
$tickets = [];
$ticketUpdatesByTicket = [];
$ticketsById = [];
$activeTickets = [];
$archivedTickets = [];
$chatSessions = [];
$chatMessagesBySession = [];
$activeChatSessions = [];
$archivedChatSessions = [];
$stats = ['waitlist' => 0, 'events' => 0, 'contact' => 0, 'applications' => 0, 'tickets_open' => 0, 'tickets_closed' => 0, 'chats_open' => 0];

if ($signedIn) {
    $pdo = titopay_db();
    if ($canSeeAll) {
        $publicSubmissions = $pdo->query('SELECT * FROM public_submissions ORDER BY created_at DESC LIMIT 500')->fetchAll(PDO::FETCH_ASSOC);
    } elseif ($roleKey === 'support') {
        $publicSubmissions = $pdo->query("SELECT * FROM public_submissions WHERE form_type IN ('waitlist','contact') AND COALESCE(route,'') <> 'careers' ORDER BY created_at DESC LIMIT 500")->fetchAll(PDO::FETCH_ASSOC);
    } elseif ($roleKey === 'hr') {
        $publicSubmissions = $pdo->query("SELECT * FROM public_submissions WHERE COALESCE(route,'') = 'careers' ORDER BY created_at DESC LIMIT 500")->fetchAll(PDO::FETCH_ASSOC);
    }

    if ($canSeeHr) {
        $applications = $pdo->query('SELECT * FROM career_applications ORDER BY updated_at DESC LIMIT 500')->fetchAll(PDO::FETCH_ASSOC);
        $attachments = $pdo->query('SELECT * FROM application_attachments ORDER BY created_at DESC')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($attachments as $attachment) {
            $attachmentsByApplication[$attachment['application_id']][] = $attachment;
        }
        $applicationUpdates = $pdo->query('SELECT * FROM career_application_updates ORDER BY created_at ASC')->fetchAll(PDO::FETCH_ASSOC);
        foreach ($applicationUpdates as $applicationUpdate) {
            $applicationUpdatesByApplication[$applicationUpdate['application_id']][] = $applicationUpdate;
        }
        $stats['applications'] = (int)$pdo->query('SELECT COUNT(*) FROM career_applications')->fetchColumn();
    }

    if ($canSeeTicketDesk) {
        if ($canSeeAll) {
            $tickets = $pdo->query('SELECT * FROM support_tickets ORDER BY updated_at DESC LIMIT 300')->fetchAll(PDO::FETCH_ASSOC);
        } elseif ($roleKey === 'support') {
            $tickets = $pdo->query("SELECT * FROM support_tickets WHERE COALESCE(category,'support') IN ('support','waitlist') ORDER BY updated_at DESC LIMIT 300")->fetchAll(PDO::FETCH_ASSOC);
        } else {
            $tickets = $pdo->query("SELECT * FROM support_tickets WHERE category = 'hr' ORDER BY updated_at DESC LIMIT 300")->fetchAll(PDO::FETCH_ASSOC);
        }
        $ticketIds = array_map(static fn(array $ticket): string => (string)$ticket['id'], $tickets);
        if ($ticketIds) {
            $quoted = implode(',', array_map([$pdo, 'quote'], $ticketIds));
            $ticketUpdates = $pdo->query('SELECT * FROM support_ticket_updates WHERE ticket_id IN (' . $quoted . ') ORDER BY created_at ASC')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($ticketUpdates as $ticketUpdate) {
                $ticketUpdatesByTicket[$ticketUpdate['ticket_id']][] = $ticketUpdate;
            }
        }
        foreach ($tickets as $ticket) {
            $ticketsById[$ticket['id']] = $ticket;
            if ((string)$ticket['status'] === 'closed') {
                $archivedTickets[] = $ticket;
            } else {
                $activeTickets[] = $ticket;
            }
        }
        $stats['tickets_open'] = count(array_filter($tickets, static fn(array $ticket): bool => (string)$ticket['status'] !== 'closed'));
        $stats['tickets_closed'] = count(array_filter($tickets, static fn(array $ticket): bool => (string)$ticket['status'] === 'closed'));
    }
    if ($canSeeSupport) {
        $chatSessions = $pdo->query('SELECT * FROM support_chat_sessions ORDER BY updated_at DESC LIMIT 200')->fetchAll(PDO::FETCH_ASSOC);
        $chatIds = array_map(static fn(array $chat): string => (string)$chat['id'], $chatSessions);
        if ($chatIds) {
            $quoted = implode(',', array_map([$pdo, 'quote'], $chatIds));
            $chatMessages = $pdo->query('SELECT * FROM support_chat_messages WHERE chat_id IN (' . $quoted . ') ORDER BY created_at ASC')->fetchAll(PDO::FETCH_ASSOC);
            foreach ($chatMessages as $chatMessage) {
                $chatMessagesBySession[$chatMessage['chat_id']][] = $chatMessage;
            }
        }
        foreach ($chatSessions as $chatSession) {
            if ((string)$chatSession['status'] === 'closed') {
                $archivedChatSessions[] = $chatSession;
            } else {
                $activeChatSessions[] = $chatSession;
            }
        }
        $stats['chats_open'] = count(array_filter($chatSessions, static fn(array $chat): bool => (string)$chat['status'] !== 'closed'));
    }
    $stats['waitlist'] = count(array_filter($publicSubmissions, static fn(array $row): bool => (string)$row['form_type'] === 'waitlist'));
    $stats['events'] = count(array_filter($publicSubmissions, static fn(array $row): bool => strncmp((string)($row['context'] ?? ''), 'events', 6) === 0));
    $stats['contact'] = count(array_filter($publicSubmissions, static fn(array $row): bool => (string)$row['form_type'] === 'contact'));
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>TitoPay Admin</title>
  <link rel="icon" href="../assets/titopay-official-logo.png?v=20260716-only-logo" type="image/png">
  <link rel="apple-touch-icon" href="../assets/titopay-official-logo.png?v=20260716-only-logo">
  <style>
    :root { --navy:#010a3f; --blue:#0b6fff; --line:#dbe5f1; --muted:#64748b; --bg:#f5f9ff; --card:#fff; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--navy); background:linear-gradient(180deg,#f7fbff,#edf6ff); }
    main { width:min(1380px,calc(100% - 32px)); margin:0 auto; padding:24px 0 42px; }
    header { position:sticky; top:0; z-index:20; display:flex; justify-content:space-between; align-items:center; gap:16px; margin:0 -16px 22px; padding:14px 16px; border:1px solid rgba(203,220,240,.9); border-radius:20px; background:rgba(255,255,255,.92); box-shadow:0 16px 48px rgba(6,43,120,.08); backdrop-filter:blur(16px); }
    h1,h2,h3,p { margin:0; }
    h1 { font-size:34px; line-height:1.08; }
    h2 { font-size:22px; }
    p { color:#52667f; line-height:1.55; }
    a { color:inherit; }
    .admin-brand { width:220px; max-width:100%; height:62px; display:flex; align-items:center; justify-content:center; margin-bottom:16px; padding:8px 18px; border:1px solid rgba(203,220,240,.95); border-radius:16px; background:#fff; box-shadow:0 10px 24px rgba(6,43,120,.07); }
    .admin-brand img { width:180px; max-width:100%; height:42px; object-fit:contain; display:block; }
    header .admin-brand { margin:0; width:190px; height:56px; }
    header .admin-brand img { width:154px; height:36px; }
    .admin-title { display:flex; align-items:center; gap:16px; }
    .label { color:var(--blue); font-size:12px; font-weight:900; letter-spacing:.7px; text-transform:uppercase; }
    .panel,.card { border:1px solid rgba(203,220,240,.95); border-radius:18px; background:var(--card); box-shadow:0 12px 32px rgba(6,43,120,.08); }
    .panel { padding:20px; margin-bottom:16px; }
    .login { max-width:460px; margin:9vh auto; display:grid; gap:14px; }
    label { display:grid; gap:8px; color:#40556f; font-size:12px; font-weight:900; letter-spacing:.4px; text-transform:uppercase; }
    input,select,textarea { width:100%; border:1px solid #d6e2ee; border-radius:12px; padding:12px 13px; color:var(--navy); background:#fff; font:inherit; }
    textarea { min-height:96px; resize:vertical; }
    button,.button { min-height:42px; display:inline-flex; align-items:center; justify-content:center; border:0; border-radius:10px; padding:0 14px; background:var(--blue); color:#fff; font:inherit; font-weight:850; cursor:pointer; text-decoration:none; }
    .secondary { border:1px solid var(--line); background:#fff; color:var(--navy); }
    .stats { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; margin-bottom:18px; }
    .stat { padding:18px; border:1px solid var(--line); border-radius:16px; background:#fff; }
    .stat span { display:block; color:var(--muted); font-size:12px; font-weight:900; text-transform:uppercase; }
    .stat strong { display:block; margin-top:6px; font-size:30px; }
    .grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
    .queue-grid { display:grid; grid-template-columns:1.15fr .85fr; gap:16px; align-items:start; margin-bottom:18px; }
    .queue-stack { display:grid; gap:10px; }
    .card { padding:18px; display:grid; gap:10px; }
    .page-actions { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:10px; }
    .dashboard-nav { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:18px; }
    .dashboard-nav a { min-height:36px; display:inline-flex; align-items:center; border:1px solid var(--line); border-radius:999px; padding:0 12px; background:#fff; color:#28415f; font-size:13px; font-weight:900; text-decoration:none; }
    .section-toolbar { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:12px; }
    .section-toolbar p { max-width:780px; }
    .export-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:14px; }
    .export-card { min-height:86px; display:grid; gap:4px; align-content:center; border:1px solid var(--line); border-radius:14px; padding:13px; background:#f8fbff; color:var(--navy); text-decoration:none; }
    .export-card strong { font-size:15px; }
    .export-card span { color:var(--muted); font-size:12px; font-weight:800; }
    .work-item { border:1px solid rgba(203,220,240,.95); border-radius:16px; background:#fff; box-shadow:0 10px 28px rgba(6,43,120,.06); overflow:hidden; }
    .work-item[open] { box-shadow:0 18px 46px rgba(6,43,120,.1); }
    .work-item summary { list-style:none; cursor:pointer; padding:14px 16px; }
    .work-item summary::-webkit-details-marker { display:none; }
    .summary-row { display:grid; grid-template-columns:1fr auto; gap:12px; align-items:center; }
    .summary-main { display:grid; gap:5px; min-width:0; }
    .summary-main h3 { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:17px; }
    .summary-main p { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
    .summary-meta { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:7px; }
    .work-body { display:grid; gap:12px; padding:0 16px 16px; border-top:1px solid #eef3f8; }
    .work-body .notes { max-height:180px; overflow:auto; padding:10px; border:1px solid var(--line); border-radius:12px; background:#f8fbff; }
    .archive-panel { margin-top:18px; border-style:dashed; background:linear-gradient(180deg,#fff,#f8fbff); }
    .compact-form { margin-top:0; }
    .small-muted { color:var(--muted); font-size:12px; font-weight:800; }
    .meta { display:flex; flex-wrap:wrap; gap:8px; }
    .pill { min-height:28px; display:inline-flex; align-items:center; padding:0 10px; border-radius:999px; background:#eaf4ff; color:var(--blue); font-size:12px; font-weight:850; }
    .notes { white-space:pre-wrap; color:#52667f; font-size:14px; line-height:1.55; }
    .attachment-list { display:grid; gap:7px; }
    .attachment-list a { min-height:34px; display:flex; align-items:center; padding:0 10px; border:1px solid var(--line); border-radius:10px; background:#f7fbff; color:var(--navy); font-size:13px; font-weight:800; text-decoration:none; }
    .form-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:12px; margin-top:14px; }
    .form-grid .full { grid-column:1 / -1; }
    .notice { padding:12px 14px; border:1px solid #b7ebc6; border-radius:12px; background:#ecfdf3; color:#05603a; font-weight:800; margin-bottom:14px; }
    .error-box { padding:12px 14px; border:1px solid #fda29b; border-radius:12px; background:#fff1f0; color:#b42318; font-weight:800; margin-bottom:14px; }
    .ticket-card { border-left:4px solid var(--blue); }
    .ticket-card.is-closed { border-left-color:#94a3b8; opacity:.92; }
    .ticket-heading { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .ticket-heading strong { font-size:18px; }
    .chat-card { border-left:4px solid #0ea5e9; }
    .chat-card.is-closed { border-left-color:#94a3b8; opacity:.9; }
    .chat-thread { max-height:310px; overflow:auto; display:grid; gap:8px; padding:10px; border:1px solid var(--line); border-radius:14px; background:#f8fbff; }
    .chat-message { max-width:92%; padding:9px 10px; border-radius:12px; background:#fff; border:1px solid #e0e8f3; }
    .chat-message.is-customer { justify-self:start; }
    .chat-message.is-agent { justify-self:end; background:#eaf4ff; border-color:#cce2ff; }
    .chat-message.is-system { justify-self:center; max-width:100%; background:#fff7ed; border-color:#fed7aa; }
    .chat-message small { display:block; color:var(--muted); font-size:11px; margin-bottom:3px; }
    .update-list { display:grid; gap:8px; margin-top:8px; }
    .update { padding:10px; border:1px solid var(--line); border-radius:12px; background:#f8fbff; }
    .update small { display:block; color:var(--muted); font-size:12px; margin-bottom:4px; }
    .inline-check { display:flex; align-items:center; gap:8px; color:#40556f; font-size:13px; font-weight:800; text-transform:none; letter-spacing:0; }
    .inline-check input { width:auto; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:820px; }
    th,td { padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:14px; }
    th { color:#40556f; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
    .error { color:#b42318; font-weight:800; }
    @media (max-width:980px) { .queue-grid,.export-grid { grid-template-columns:1fr; } }
    @media (max-width:860px) { header,.stats,.grid,.form-grid { grid-template-columns:1fr; display:grid; } .form-grid .full { grid-column:auto; } .summary-row { grid-template-columns:1fr; } .summary-meta { justify-content:flex-start; } }
  </style>
</head>
<body>
<main>
<?php if (!$signedIn): ?>
  <section class="panel login">
    <div class="admin-brand"><img src="../assets/titopay-official-logo.png" alt="TitoPay"></div>
    <span class="label">Restricted Admin</span>
    <h1>TitoPay submissions</h1>
    <?php if (!titopay_admin_configured()): ?>
      <p class="error">Admin login is not configured. Set admin users in <code>api/config.local.php</code>.</p>
    <?php endif; ?>
    <p>Sign in to view waitlist requests, contact enquiries, career applications, and uploaded documents.</p>
    <form method="post">
      <label>Email address<input name="username" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Open dashboard</button>
    </form>
    <?php if ($loginError): ?><p class="error"><?= h($loginError) ?></p><?php endif; ?>
  </section>
<?php else: ?>
  <header>
    <div class="admin-title">
      <div class="admin-brand"><img src="../assets/titopay-official-logo.png" alt="TitoPay"></div>
      <div>
        <span class="label">TitoPay Admin</span>
        <h1>Operations dashboard</h1>
        <p><?= h((string)($_SESSION['titopay_admin_user']['name'] ?? 'TitoPay Admin')) ?> · <?= h((string)($_SESSION['titopay_admin_user']['role'] ?? 'Admin')) ?></p>
      </div>
    </div>
    <div class="page-actions">
      <a class="button secondary" href="index.php">Refresh dashboard</a>
      <a class="button secondary" href="#exports">Download data</a>
      <a class="button secondary" href="?logout=1">Sign out</a>
    </div>
  </header>

  <?php if ($adminNotice): ?><div class="notice"><?= h($adminNotice) ?></div><?php endif; ?>
  <?php if ($adminError): ?><div class="error-box"><?= h($adminError) ?></div><?php endif; ?>

  <section class="stats" aria-label="Submission summary">
    <article class="stat"><span>Waitlist</span><strong><?= $stats['waitlist'] ?></strong></article>
    <article class="stat"><span>TitoPay Events</span><strong><?= $stats['events'] ?></strong></article>
    <article class="stat"><span>Contact requests</span><strong><?= $stats['contact'] ?></strong></article>
    <article class="stat"><span>Career applications</span><strong><?= $stats['applications'] ?></strong></article>
    <article class="stat"><span>Open chats</span><strong><?= $stats['chats_open'] ?></strong></article>
    <article class="stat"><span>Open tickets</span><strong><?= $stats['tickets_open'] ?></strong></article>
    <article class="stat"><span>Closed tickets</span><strong><?= $stats['tickets_closed'] ?></strong></article>
  </section>

  <nav class="dashboard-nav" aria-label="Dashboard sections">
    <?php if ($canSeeSupport): ?><a href="#support-chat">Live chat</a><?php endif; ?>
    <?php if ($canSeeTicketDesk): ?><a href="#ticket-desk">Active tickets</a><a href="#ticket-archive">Archived tickets</a><?php endif; ?>
    <?php if ($canSeeHr): ?><a href="#careers">Careers</a><?php endif; ?>
    <a href="#website-submissions">Website submissions</a>
    <a href="#exports">Downloads</a>
  </nav>

  <section class="panel" id="exports">
    <div class="section-toolbar">
      <div>
        <span class="label">Download Center</span>
        <h2>Export admin data</h2>
        <p>Download role-approved CSV files for reporting, backup, HR review, support reviews, and CEO oversight. Exports do not remove or change stored data.</p>
      </div>
    </div>
    <div class="export-grid">
      <a class="export-card" href="?export=submissions"><strong>Website submissions</strong><span>Waitlist, contact, legal, careers enquiries</span></a>
      <?php if ($canSeeTicketDesk): ?><a class="export-card" href="?export=tickets"><strong>Support tickets</strong><span>Active and archived ticket records</span></a><?php endif; ?>
      <?php if ($canSeeSupport): ?><a class="export-card" href="?export=chats"><strong>Live chat sessions</strong><span>Chat metadata and callback requests</span></a><?php endif; ?>
      <?php if ($canSeeHr): ?><a class="export-card" href="?export=applications"><strong>Career applications</strong><span>Applicants, stages, status, contact details</span></a><?php endif; ?>
    </div>
  </section>

  <?php if ($canSeeSupport): ?>
  <section class="panel" id="support-chat">
    <div class="section-toolbar">
      <div>
        <span class="label">Live Support Chat</span>
        <h2>Active customer conversations</h2>
        <p>Handle website chat, callback, and agent requests. Closed chats stay preserved in the data export.</p>
      </div>
      <a class="button secondary" href="?export=chats">Download chats</a>
    </div>
    <div class="queue-stack">
      <?php if (!$activeChatSessions): ?>
        <article class="card"><p>No active chat conversations.</p></article>
      <?php endif; ?>
      <?php foreach ($activeChatSessions as $chat): ?>
        <?php $linkedTicket = !empty($chat['ticket_id']) && !empty($ticketsById[$chat['ticket_id']]) ? $ticketsById[$chat['ticket_id']] : null; ?>
        <details class="work-item">
          <summary>
            <div class="summary-row">
              <div class="summary-main">
                <span class="label"><?= h($chat['chat_number']) ?></span>
                <h3><?= h($chat['topic'] ?: 'Live support') ?></h3>
                <p><?= h($chat['name']) ?> · <?= h($chat['email']) ?><?= !empty($chat['phone']) ? ' · ' . h((string)$chat['phone']) : '' ?></p>
              </div>
              <div class="summary-meta">
                <?php if ((int)$chat['callback_requested'] === 1): ?><span class="pill">Callback</span><?php endif; ?>
                <?php if ($linkedTicket): ?><span class="pill"><?= h($linkedTicket['ticket_number']) ?></span><?php endif; ?>
                <span class="pill"><?= h($chat['status']) ?></span>
              </div>
            </div>
          </summary>
          <div class="work-body">
            <div class="chat-thread" aria-label="Chat messages for <?= h($chat['chat_number']) ?>">
              <?php foreach (($chatMessagesBySession[$chat['id']] ?? []) as $message): ?>
                <div class="chat-message is-<?= h((string)$message['sender_type']) ?>">
                  <small><?= h($message['created_at']) ?> · <?= h($message['sender_name']) ?></small>
                  <p class="notes"><?= h($message['message']) ?></p>
                </div>
              <?php endforeach; ?>
            </div>
            <form method="post" class="form-grid compact-form">
              <input type="hidden" name="action" value="reply_chat">
              <input type="hidden" name="chat_id" value="<?= h($chat['id']) ?>">
              <label>Status<select name="status">
                <option value="open" <?= $chat['status'] === 'open' ? 'selected' : '' ?>>open</option>
                <option value="pending" <?= $chat['status'] === 'pending' ? 'selected' : '' ?>>pending</option>
                <option value="closed">closed / archive</option>
              </select></label>
              <label class="full">Agent reply<textarea name="message" placeholder="Type a reply for the customer. Select closed to archive when resolved."></textarea></label>
              <div class="full"><button type="submit">Send chat reply</button></div>
            </form>
          </div>
        </details>
      <?php endforeach; ?>
    </div>
  </section>

  <details class="panel">
    <summary><span class="label">Support Tickets</span><h2>Create a ticket</h2><p>Open manually only when a request did not come through a website form or chat.</p></summary>
    <form method="post" class="form-grid">
      <input type="hidden" name="action" value="create_ticket">
      <label>Name<input name="name" autocomplete="name" required></label>
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Contact number<input name="phone" autocomplete="tel" placeholder="+27"></label>
      <label>Request type<input name="request_type" placeholder="Support, refund, privacy, merchant enquiry"></label>
      <label>Priority<select name="priority"><option>normal</option><option>low</option><option>high</option><option>urgent</option></select></label>
      <label class="full">Subject<input name="subject" placeholder="Short ticket subject" required></label>
      <label class="full">Message<textarea name="message" placeholder="Describe the issue or request." required></textarea></label>
      <div class="full"><button type="submit">Create and send ticket</button></div>
    </form>
  </details>
  <?php endif; ?>

  <?php if ($canSeeTicketDesk): ?>
  <section class="panel" id="ticket-desk">
    <div class="section-toolbar">
      <div>
        <span class="label">Ticket Desk</span>
        <h2>Active tickets</h2>
        <p>Contact forms, waitlist requests, careers enquiries, and live chat requests create tracked tickets. Close a ticket to archive it.</p>
      </div>
      <a class="button secondary" href="?export=tickets">Download tickets</a>
    </div>
    <div class="queue-stack">
    <?php if (!$activeTickets): ?>
      <article class="card"><p>No active tickets. Closed tickets are stored in the archive below.</p></article>
    <?php endif; ?>
    <?php foreach ($activeTickets as $ticket): ?>
      <details class="work-item">
        <summary>
          <div class="summary-row">
            <div class="summary-main">
              <span class="label"><?= h($ticket['ticket_number']) ?></span>
              <h3><?= h($ticket['subject']) ?></h3>
              <p><?= h($ticket['name']) ?> · <?= h($ticket['email']) ?><?= !empty($ticket['phone']) ? ' · ' . h((string)$ticket['phone']) : '' ?></p>
            </div>
            <div class="summary-meta">
              <span class="pill"><?= h($ticket['status']) ?></span>
              <span class="pill"><?= h($ticket['priority']) ?></span>
              <span class="pill"><?= h((string)($ticket['category'] ?: 'support')) ?></span>
            </div>
          </div>
        </summary>
        <div class="work-body">
          <div class="meta"><span class="pill"><?= h($ticket['request_type'] ?: 'General') ?></span><span class="pill"><?= h($ticket['source'] ?: 'admin') ?></span><span class="pill">Updated <?= h($ticket['updated_at']) ?></span></div>
          <p class="notes"><?= h($ticket['message']) ?></p>
          <?php if (!empty($ticketUpdatesByTicket[$ticket['id']])): ?>
            <div class="update-list">
              <?php foreach ($ticketUpdatesByTicket[$ticket['id']] as $update): ?>
                <div class="update">
                  <small><?= h($update['created_at']) ?> · <?= h($update['author_name']) ?> · <?= h($update['status']) ?></small>
                  <p class="notes"><?= h($update['message']) ?></p>
                </div>
              <?php endforeach; ?>
            </div>
          <?php endif; ?>
          <form method="post" class="form-grid compact-form">
            <input type="hidden" name="action" value="update_ticket">
            <input type="hidden" name="ticket_id" value="<?= h($ticket['id']) ?>">
            <label>Status<select name="status">
              <option value="open" <?= $ticket['status'] === 'open' ? 'selected' : '' ?>>open</option>
              <option value="pending" <?= $ticket['status'] === 'pending' ? 'selected' : '' ?>>pending</option>
              <option value="closed">closed / archive</option>
            </select></label>
            <label class="inline-check"><input name="notify_sender" type="checkbox" checked> Email sender</label>
            <label class="full">Update<textarea name="message" placeholder="Type an update. Select closed to move it to archive."></textarea></label>
            <div class="full"><button type="submit">Save ticket update</button></div>
          </form>
        </div>
      </details>
    <?php endforeach; ?>
    </div>
  </section>

  <section class="panel archive-panel" id="ticket-archive">
    <div class="section-toolbar">
      <div>
        <span class="label">Archived Tickets</span>
        <h2>Closed ticket archive</h2>
        <p>Closed tickets are preserved here. Use reopen to return a ticket to the active queue without deleting history.</p>
      </div>
      <span class="pill"><?= count($archivedTickets) ?> archived</span>
    </div>
    <div class="queue-stack">
      <?php if (!$archivedTickets): ?>
        <article class="card"><p>No archived tickets yet.</p></article>
      <?php endif; ?>
      <?php foreach ($archivedTickets as $ticket): ?>
        <details class="work-item">
          <summary>
            <div class="summary-row">
              <div class="summary-main">
                <span class="label"><?= h($ticket['ticket_number']) ?></span>
                <h3><?= h($ticket['subject']) ?></h3>
                <p><?= h($ticket['name']) ?> · closed <?= h((string)($ticket['closed_at'] ?: $ticket['updated_at'])) ?></p>
              </div>
              <div class="summary-meta"><span class="pill">archived</span><span class="pill"><?= h((string)($ticket['category'] ?: 'support')) ?></span></div>
            </div>
          </summary>
          <div class="work-body">
            <p class="notes"><?= h($ticket['message']) ?></p>
            <?php if (!empty($ticketUpdatesByTicket[$ticket['id']])): ?>
              <div class="update-list">
                <?php foreach ($ticketUpdatesByTicket[$ticket['id']] as $update): ?>
                  <div class="update"><small><?= h($update['created_at']) ?> · <?= h($update['author_name']) ?> · <?= h($update['status']) ?></small><p class="notes"><?= h($update['message']) ?></p></div>
                <?php endforeach; ?>
              </div>
            <?php endif; ?>
            <form method="post" class="form-grid compact-form">
              <input type="hidden" name="action" value="update_ticket">
              <input type="hidden" name="ticket_id" value="<?= h($ticket['id']) ?>">
              <input type="hidden" name="status" value="open">
              <input type="hidden" name="message" value="Ticket reopened from archive.">
              <label class="inline-check"><input name="notify_sender" type="checkbox"> Email sender</label>
              <div><button type="submit">Reopen ticket</button></div>
            </form>
          </div>
        </details>
      <?php endforeach; ?>
    </div>
  </section>
  <?php endif; ?>

  <?php if ($canSeeHr): ?>
  <section class="panel" id="careers">
    <div class="section-toolbar">
      <div>
        <span class="label">Careers</span>
        <h2>Career applications</h2>
        <p>Review applicants, download attachments, send HR communication, and export the applicant register.</p>
      </div>
      <a class="button secondary" href="?export=applications">Download applications</a>
    </div>
  </section>
  <section class="queue-stack">
    <?php if (!$applications): ?>
      <article class="card"><p>No career applications yet.</p></article>
    <?php endif; ?>
    <?php foreach ($applications as $app): ?>
      <details class="work-item">
        <summary>
          <div class="summary-row">
            <div class="summary-main">
              <span class="label"><?= h((string)($app['application_number'] ?? 'Application')) ?></span>
              <h3><?= h($app['name']) ?> · <?= h($app['job_title']) ?></h3>
              <p><?= h($app['email']) ?> · <?= h($app['phone'] ?? '') ?></p>
            </div>
            <div class="summary-meta"><span class="pill"><?= h($app['stage']) ?></span><span class="pill"><?= h($app['status']) ?></span></div>
          </div>
        </summary>
        <div class="work-body">
          <div class="meta"><span class="pill"><?= h($app['qualification'] ?? 'Qualification not listed') ?></span><span class="pill">Updated <?= h($app['updated_at']) ?></span></div>
          <?php if (!empty($app['portfolio'])): ?><p><a href="<?= h($app['portfolio']) ?>" target="_blank" rel="noopener"><?= h($app['portfolio']) ?></a></p><?php endif; ?>
          <p class="notes"><?= h($app['notes'] ?? '') ?></p>
          <?php if (!empty($attachmentsByApplication[$app['id']])): ?>
            <div class="attachment-list">
              <?php foreach ($attachmentsByApplication[$app['id']] as $file): ?>
                <a href="?download=<?= h($file['id']) ?>"><?= h(($file['label'] ?: 'Attachment') . ': ' . $file['original_name']) ?></a>
              <?php endforeach; ?>
            </div>
          <?php endif; ?>
          <?php if (!empty($applicationUpdatesByApplication[$app['id']])): ?>
            <div class="update-list">
              <?php foreach ($applicationUpdatesByApplication[$app['id']] as $update): ?>
                <div class="update">
                  <small><?= h($update['created_at']) ?> · <?= h($update['author_name']) ?> · <?= h($update['communication_type']) ?> · <?= h($update['status']) ?></small>
                  <p class="notes"><?= h($update['message']) ?></p>
                </div>
              <?php endforeach; ?>
            </div>
          <?php endif; ?>
          <form method="post" class="form-grid compact-form">
          <input type="hidden" name="action" value="update_application">
          <input type="hidden" name="application_id" value="<?= h($app['id']) ?>">
          <label>Communication<select name="communication_type">
            <option value="general_update">General update</option>
            <option value="declined_current_stage">Declined at current stage</option>
            <option value="first_round">Successful to first round</option>
            <option value="information_request">Request more information</option>
          </select></label>
          <label>Stage<select name="stage">
            <option value="screening" <?= $app['stage'] === 'screening' ? 'selected' : '' ?>>screening</option>
            <option value="first_round" <?= $app['stage'] === 'first_round' ? 'selected' : '' ?>>first round</option>
            <option value="interview" <?= $app['stage'] === 'interview' ? 'selected' : '' ?>>interview</option>
            <option value="offer" <?= $app['stage'] === 'offer' ? 'selected' : '' ?>>offer</option>
            <option value="closed" <?= $app['stage'] === 'closed' ? 'selected' : '' ?>>closed</option>
          </select></label>
          <label>Status<select name="status">
            <option value="active" <?= $app['status'] === 'active' ? 'selected' : '' ?>>active</option>
            <option value="pending" <?= $app['status'] === 'pending' ? 'selected' : '' ?>>pending</option>
            <option value="declined" <?= $app['status'] === 'declined' ? 'selected' : '' ?>>declined</option>
            <option value="successful" <?= $app['status'] === 'successful' ? 'selected' : '' ?>>successful</option>
            <option value="closed" <?= $app['status'] === 'closed' ? 'selected' : '' ?>>closed</option>
          </select></label>
          <label class="inline-check"><input name="notify_sender" type="checkbox" checked> Email applicant</label>
          <label class="full">Message<textarea name="message" placeholder="Leave blank to use the selected TitoPay HR template, or type a custom update."></textarea></label>
          <div class="full"><button type="submit">Send application update</button></div>
          </form>
        </div>
      </details>
    <?php endforeach; ?>
  </section>
  <?php endif; ?>

  <section class="panel" style="margin-top:18px">
    <span class="label">Website</span>
    <h2>Waitlist and contact requests</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Source</th><th>Name</th><th>Email</th><th>Phone</th><th>Interest / Request</th><th>Message</th></tr></thead>
        <tbody>
        <?php if (!$publicSubmissions): ?>
          <tr><td colspan="8">No website submissions yet.</td></tr>
        <?php endif; ?>
        <?php foreach ($publicSubmissions as $row): ?>
          <tr>
            <td><?= h($row['created_at']) ?></td>
            <td><?= h($row['form_type']) ?></td>
            <td><?= h((string)($row['context'] ?? '')) ?></td>
            <td><?= h($row['name']) ?></td>
            <td><?= h($row['email']) ?></td>
            <td><?= h((string)($row['phone'] ?? '')) ?></td>
            <td><?= h($row['interest'] ?: $row['request_type']) ?></td>
            <td><?= h($row['message'] ?? '') ?></td>
          </tr>
        <?php endforeach; ?>
        </tbody>
      </table>
    </div>
  </section>
<?php endif; ?>
</main>
</body>
</html>
