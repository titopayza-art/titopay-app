<?php
/** Assistants: list, create, workspace (chat), settings and knowledge, projects and tasks, shared link. */
declare(strict_types=1);

/** @var Router $r */

function assistant_for(string $pid): array
{
    $org = require_org();
    $u = Auth::user();
    $a = DB::one("SELECT * FROM assistants WHERE public_id = ? AND org_id = ? AND status <> 'deleted'", [$pid, $org['id']]);
    if (!$a || !Assistants::canUse($a, $u)) { flash('error', 'That assistant was not found.'); redirect('/dashboard/assistants'); }
    return [$a, $org, $u];
}

function assistant_approvals(array $ids): array
{
    if (!$ids) return [];
    $rows = DB::all('SELECT * FROM assistant_actions WHERE id IN (' . implode(',', array_map('intval', $ids)) . ')');
    return array_map(fn($x) => ['id' => (int) $x['id'], 'kind' => $x['kind'], 'status' => $x['status'], 'result' => $x['result']] + json_decode($x['payload'], true), $rows);
}

$r->add('GET|POST', '/dashboard/assistants', function () {
    $org = require_org();
    $u = Auth::user();
    if (is_post()) {
        csrf_check();
        if ((int) DB::value("SELECT COUNT(*) FROM assistants WHERE org_id = ? AND status <> 'deleted'", [$org['id']]) >= 25) { flash('error', 'You can have up to 25 assistants.'); redirect('/dashboard/assistants'); }
        $a = Assistants::create($org, (int) $u['id'], (string) input('template'), ['name' => trim((string) input('name'))]);
        audit('assistant.created', (int) $org['id'], $a['name']);
        redirect('/dashboard/assistants/' . $a['public_id'] . '?new=1');
    }
    $list = array_values(array_filter(DB::all("SELECT a.*, (SELECT COUNT(*) FROM assistant_chats c WHERE c.assistant_id = a.id) chats, (SELECT MAX(c.updated_at) FROM assistant_chats c WHERE c.assistant_id = a.id) last_at FROM assistants a WHERE a.org_id = ? AND a.status <> 'deleted' ORDER BY a.id", [$org['id']]), fn($a) => Assistants::canUse($a, $u)));
    render('assistants/index', ['title' => 'Assistants', 'org' => $org, 'list' => $list, 'aiReady' => Ai::configured('anthropic') || Ai::configured('openai')], 'app');
});

$r->add('GET', '/dashboard/assistants/{pid}', function ($pid) {
    [$a, $org, $u] = assistant_for((string) $pid);
    $chats = DB::all('SELECT * FROM assistant_chats WHERE assistant_id = ? AND (user_id = ? OR (user_id IS NULL AND guest IS NULL)) ORDER BY updated_at DESC LIMIT 40', [$a['id'], $u['id']]);
    $chat = isset($_GET['chat']) ? DB::one('SELECT * FROM assistant_chats WHERE public_id = ? AND assistant_id = ? AND user_id = ?', [(string) $_GET['chat'], $a['id'], $u['id']]) : ($chats[0] ?? null);
    $msgs = $chat ? DB::all('SELECT * FROM assistant_messages WHERE chat_id = ? ORDER BY id', [$chat['id']]) : [];
    $ids = [];
    foreach ($msgs as $m) if ($m['actions']) $ids = array_merge($ids, json_decode($m['actions'], true)['approvals'] ?? []);
    $groups = Assistants::groups($a);
    render('assistants/workspace', ['title' => $a['name'], 'org' => $org, 'a' => $a, 'chats' => $chats, 'chat' => $chat, 'msgs' => $msgs, 'approvals' => array_column(assistant_approvals($ids), null, 'id'), 'new' => (bool) input('new'),
        'tasks' => in_array('tasks', $groups, true) ? DB::all("SELECT t.*, p.name project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.org_id = ? AND t.status <> 'done' ORDER BY CASE WHEN t.due_on IS NULL THEN 1 ELSE 0 END, t.due_on, t.id LIMIT 12", [$org['id']]) : null,
        'memory' => in_array('memory', $groups, true) ? DB::all('SELECT * FROM assistant_memory WHERE assistant_id = ? ORDER BY id DESC LIMIT 12', [$a['id']]) : null,
        'reminders' => in_array('reminders', $groups, true) ? DB::all('SELECT * FROM reminders WHERE user_id = ? AND sent_at IS NULL ORDER BY due_at LIMIT 6', [$u['id']]) : null,
        'docs' => (int) DB::value('SELECT COUNT(*) FROM assistant_docs WHERE assistant_id = ?', [$a['id']]),
        'pending' => DB::all("SELECT * FROM assistant_actions WHERE assistant_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 5", [$a['id']])], 'app');
});

$r->add('POST', '/dashboard/assistants/{pid}/send', function ($pid) {
    [$a, $org, $u] = assistant_for((string) $pid);
    csrf_check();
    $text = trim((string) input('message'));
    if ($text === '' || mb_strlen($text) > 8000) json_out(['error' => 'Write a message of up to 8,000 characters.'], 422);
    if (rate_limited('asst:' . $u['id'], 30, 300)) json_out(['error' => 'You are sending messages very quickly. Wait a moment.'], 429);
    $chat = input('chat') ? DB::one('SELECT * FROM assistant_chats WHERE public_id = ? AND assistant_id = ? AND user_id = ?', [(string) input('chat'), $a['id'], $u['id']]) : null;
    $chat ??= Assistants::newChat($a, (int) $u['id']);
    @set_time_limit(180);
    $res = Assistants::reply($a, $chat, $text, $u);
    json_out(['chat' => $chat['public_id'], 'title' => DB::value('SELECT title FROM assistant_chats WHERE id = ?', [$chat['id']]), 'html' => md_lite($res['text']), 'text' => $res['text'],
        'actions' => $res['actions'], 'approvals' => assistant_approvals($res['approvals']), 'amount' => round($res['amount'], 4)]);
});

$r->add('POST', '/dashboard/assistants/{pid}/decide', function ($pid) {
    [$a, $org, $u] = assistant_for((string) $pid);
    csrf_check();
    $msg = Assistants::decide($a, (int) input('id'), input('decision') === 'send', $u);
    if (str_contains((string) ($_SERVER['HTTP_ACCEPT'] ?? ''), 'json')) json_out(['message' => $msg, 'approval' => assistant_approvals([(int) input('id')])[0] ?? null]);
    flash(str_starts_with($msg, 'Not sent') || str_starts_with($msg, 'SMS needs') ? 'error' : 'ok', $msg);
    redirect('/dashboard/assistants/' . $a['public_id'] . (input('chat') ? '?chat=' . rawurlencode((string) input('chat')) : ''));
});

$r->add('POST', '/dashboard/assistants/{pid}/task', function ($pid) {
    [$a, $org] = assistant_for((string) $pid);
    csrf_check();
    $t = DB::one('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
    if ($t) DB::update('tasks', ['status' => input('done') ? 'done' : 'todo', 'done_at' => input('done') ? now() : null], 'id = ?', [$t['id']]);
    json_out(['ok' => (bool) $t]);
});

$r->add('GET|POST', '/dashboard/assistants/{pid}/settings', function ($pid) {
    [$a, $org, $u] = assistant_for((string) $pid);
    $self = '/dashboard/assistants/' . $a['public_id'] . '/settings';
    if (is_post()) {
        csrf_check();
        $act = (string) input('action');
        if ($act === 'save') {
            $prov = (string) input('provider') === 'openai' ? 'openai' : 'anthropic';
            $model = (string) input('model');
            if (!Catalog::aiModel($prov, $model)) { flash('error', 'Pick a model from the list.'); redirect($self); }
            $tools = array_values(array_intersect(array_keys(Assistants::GROUPS), (array) ($_POST['tools'] ?? [])));
            $color = (string) input('color');
            $hour = input('brief') === '' ? null : max(5, min(10, (int) input('brief')));
            DB::update('assistants', ['name' => mb_substr(trim((string) input('name')), 0, 80) ?: $a['name'], 'instructions' => mb_substr((string) input('instructions'), 0, 12000),
                'provider' => $prov, 'model' => $model, 'effort' => array_key_exists((string) input('effort'), Assistants::EFFORT) ? input('effort') : 'medium', 'tools' => implode(',', $tools),
                'color' => preg_match('/^#[0-9a-fA-F]{6}$/', $color) ? strtolower($color) : $a['color'], 'shared' => input('shared') ? 1 : 0, 'brief_hour' => $hour, 'updated_at' => now()], 'id = ?', [$a['id']]);
            flash('ok', 'Saved.');
        } elseif ($act === 'doc_text') {
            $title = mb_substr(trim((string) input('title')), 0, 200);
            $body = trim((string) input('content'));
            if ($title === '' || $body === '') { flash('error', 'Give the document a title and some text.'); redirect($self . '#knowledge'); }
            DB::insert('assistant_docs', ['assistant_id' => $a['id'], 'title' => $title, 'source' => 'text', 'content' => mb_substr($body, 0, 200000), 'chars' => mb_strlen(mb_substr($body, 0, 200000)), 'created_at' => now()]);
            flash('ok', 'Added "' . $title . '".');
        } elseif ($act === 'doc_file') {
            $f = $_FILES['file'] ?? null;
            if (!$f || ($f['error'] ?? 1) !== UPLOAD_ERR_OK || $f['size'] > 10_000_000 || !is_uploaded_file($f['tmp_name'])) { flash('error', 'Choose a file up to 10 MB.'); redirect($self . '#knowledge'); }
            $text = Assistants::extract((string) $f['name'], (string) file_get_contents($f['tmp_name']));
            if ($text === null || trim($text) === '') { flash('error', 'That file type is not supported yet. Use Word (.docx), text, Markdown, CSV or HTML. For a PDF, copy the text in, or save it as Word.'); redirect($self . '#knowledge'); }
            $text = mb_substr($text, 0, 200000);
            DB::insert('assistant_docs', ['assistant_id' => $a['id'], 'title' => mb_substr((string) $f['name'], 0, 200), 'source' => 'file', 'content' => $text, 'chars' => mb_strlen($text), 'created_at' => now()]);
            flash('ok', 'Added ' . $f['name'] . ' (' . number_format(mb_strlen($text)) . ' characters).');
        } elseif ($act === 'doc_url') {
            try {
                [$title, $text] = Assistants::fetchPage(trim((string) input('url')));
                if (trim($text) === '') throw new RuntimeException('That page has no readable text.');
                DB::insert('assistant_docs', ['assistant_id' => $a['id'], 'title' => $title, 'source' => 'url', 'content' => $text, 'chars' => mb_strlen($text), 'created_at' => now()]);
                flash('ok', 'Added "' . $title . '".');
            } catch (Throwable $e) { flash('error', $e->getMessage()); }
        } elseif ($act === 'doc_delete') {
            DB::run('DELETE FROM assistant_docs WHERE id = ? AND assistant_id = ?', [(int) input('id'), $a['id']]);
            flash('ok', 'Removed.');
        } elseif ($act === 'memory_delete') {
            DB::run('DELETE FROM assistant_memory WHERE id = ? AND assistant_id = ?', [(int) input('id'), $a['id']]);
            flash('ok', 'Forgotten.');
        } elseif ($act === 'share_on') {
            DB::update('assistants', ['share_token' => Crypto::token(18)], 'id = ?', [$a['id']]);
            flash('ok', 'Shared link created. Anyone with the link can ask questions about its knowledge; it cannot see your tasks, memory or tickets.');
        } elseif ($act === 'share_off') {
            DB::update('assistants', ['share_token' => null], 'id = ?', [$a['id']]);
            flash('ok', 'Shared link switched off. The old link no longer works.');
        } elseif ($act === 'delete') {
            DB::update('assistants', ['status' => 'deleted', 'share_token' => null], 'id = ?', [$a['id']]);
            audit('assistant.deleted', (int) $org['id'], $a['name']);
            flash('ok', $a['name'] . ' was deleted. Tasks and projects it created stay.');
            redirect('/dashboard/assistants');
        }
        redirect($self . ($act === 'save' ? '' : (str_starts_with($act, 'doc') ? '#knowledge' : (str_starts_with($act, 'share') ? '#share' : ''))));
    }
    render('assistants/settings', ['title' => $a['name'] . ' settings', 'org' => $org, 'a' => $a,
        'docs' => DB::all('SELECT id, title, source, chars, created_at FROM assistant_docs WHERE assistant_id = ? ORDER BY id', [$a['id']]),
        'memory' => DB::all('SELECT * FROM assistant_memory WHERE assistant_id = ? ORDER BY id', [$a['id']]),
        'usage' => (float) DB::value("SELECT COALESCE(SUM(amount),0) FROM messages WHERE org_id = ? AND reference = ? AND created_at >= ?", [$org['id'], 'assistant:' . $a['public_id'], gmdate('Y-m-01 00:00:00')])], 'app');
});

// Projects and tasks -------------------------------------------------------------------

$r->add('GET|POST', '/dashboard/work', function () {
    $org = require_org();
    $u = Auth::user();
    if (is_post()) {
        csrf_check();
        $act = (string) input('action');
        if ($act === 'task') {
            $title = mb_substr(trim((string) input('title')), 0, 200);
            if ($title !== '') DB::insert('tasks', ['org_id' => $org['id'], 'project_id' => (int) input('project') ?: null, 'title' => $title, 'due_on' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) input('due_on')) ? input('due_on') : null,
                'priority' => in_array(input('priority'), ['low', 'normal', 'high', 'urgent'], true) ? input('priority') : 'normal', 'assignee_id' => (int) input('assignee') ?: $u['id'], 'created_by' => mb_substr($u['name'], 0, 60), 'created_at' => now()]);
        } elseif ($act === 'project') {
            $name = mb_substr(trim((string) input('name')), 0, 120);
            if ($name !== '') DB::insert('projects', ['org_id' => $org['id'], 'name' => $name, 'due_on' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) input('due_on')) ? input('due_on') : null, 'created_at' => now()]);
        } elseif ($act === 'move') {
            $st = in_array(input('status'), ['todo', 'doing', 'done'], true) ? input('status') : 'todo';
            DB::run('UPDATE tasks SET status = ?, done_at = ? WHERE id = ? AND org_id = ?', [$st, $st === 'done' ? now() : null, (int) input('id'), $org['id']]);
        } elseif ($act === 'delete') {
            DB::run('DELETE FROM tasks WHERE id = ? AND org_id = ?', [(int) input('id'), $org['id']]);
        } elseif ($act === 'archive') {
            DB::run("UPDATE projects SET status = 'archived' WHERE id = ? AND org_id = ?", [(int) input('id'), $org['id']]);
        }
        redirect('/dashboard/work' . (input('p') ? '?p=' . (int) input('p') : ''));
    }
    $p = (int) ($_GET['p'] ?? 0);
    $projects = DB::all("SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') open_n FROM projects p WHERE p.org_id = ? AND p.status <> 'archived' ORDER BY p.id", [$org['id']]);
    $sql = 'SELECT t.*, p.name project, u.name assignee FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ?' . ($p ? ' AND t.project_id = ' . $p : '') . " AND (t.status <> 'done' OR t.done_at > ?) ORDER BY CASE WHEN t.due_on IS NULL THEN 1 ELSE 0 END, t.due_on, t.id";
    render('assistants/work', ['title' => 'Projects and tasks', 'org' => $org, 'projects' => $projects, 'p' => $p, 'tasks' => DB::all($sql, [$org['id'], ts('-14 days')]),
        'team' => DB::all('SELECT id, name FROM users WHERE org_id = ? AND disabled_at IS NULL', [$org['id']])], 'app');
});

// Shared link: anyone with it can ask the assistant about its knowledge -----------------

$r->add('GET|POST', '/a/{token}', function ($token) {
    $a = DB::one("SELECT * FROM assistants WHERE share_token = ? AND status = 'active'", [(string) $token]);
    if (!$a) { http_response_code(404); render('site/404', ['title' => 'Not found']); }
    $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$a['org_id']]);
    if (is_post()) {
        csrf_check();
        $text = trim((string) input('message'));
        if ($text === '' || mb_strlen($text) > 4000) json_out(['error' => 'Write a message of up to 4,000 characters.'], 422);
        if (rate_limited('asst-guest:' . client_ip(), 15, 600) || rate_limited('asst-guest-a:' . $a['id'], 300, 86400)) json_out(['error' => 'This assistant is busy. Try again a little later.'], 429);
        $chatId = (string) ($_SESSION['guest_chat'][$a['id']] ?? '');
        $chat = $chatId !== '' ? DB::one('SELECT * FROM assistant_chats WHERE public_id = ? AND assistant_id = ?', [$chatId, $a['id']]) : null;
        if (!$chat) { $chat = Assistants::newChat($a, null, 'guest:' . substr(hash('sha256', client_ip()), 0, 12)); $_SESSION['guest_chat'][$a['id']] = $chat['public_id']; }
        @set_time_limit(120);
        $res = Assistants::reply($a, $chat, $text, null, true);
        json_out(['html' => md_lite($res['text'])]);
    }
    render('assistants/public', ['title' => $a['name'] . ' · ' . $org['name'], 'a' => $a, 'org' => $org], 'auth');
});
