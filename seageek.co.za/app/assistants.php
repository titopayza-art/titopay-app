<?php
/**
 * SeaGeek Assistants: AI agents people and companies set up for their work and projects.
 * Each assistant has a role, its own knowledge, a memory, and tools that act on the account:
 * tasks and projects, reminders, support tickets, and email or SMS drafts that a person approves before they go out.
 */
declare(strict_types=1);

final class Assistants
{
    /** Tool groups a user can switch on: key => [label, what it lets the assistant do]. */
    public const GROUPS = [
        'tasks' => ['Tasks and projects', 'Create, update and report on tasks and projects your team can see.'],
        'reminders' => ['Reminders', 'Remind you by email or SMS at a time you choose.'],
        'memory' => ['Memory', 'Remember facts and preferences you tell it, across conversations.'],
        'knowledge' => ['Knowledge', 'Answer from the documents and pages you add.'],
        'email' => ['Email drafts', 'Draft emails to anyone. Nothing is sent until you approve it.'],
        'sms' => ['SMS drafts', 'Draft SMS messages. Nothing is sent until you approve it; sending uses your SMS credit.'],
        'desk' => ['Support tickets', 'Look up and summarise your Desk tickets.'],
    ];

    public const EFFORT = ['low' => 'Quick', 'medium' => 'Balanced', 'high' => 'Thorough'];

    /** Ready-made roles. key => [name, one line, instructions, tool groups, effort, colour]. */
    public static function templates(): array
    {
        return [
            'personal' => ['Personal assistant', 'Keeps your to-do list, reminds you, drafts messages and remembers how you like things done.',
                "You are a personal work assistant. Keep the user's tasks and reminders in order, draft emails and messages in their voice, and remember their preferences. Be brief and practical. When the user mentions something they need to do, offer to add it as a task or a reminder.",
                ['tasks', 'reminders', 'memory', 'email', 'knowledge'], 'medium', '#5fe3cf'],
            'projects' => ['Project manager', 'Breaks work into tasks, tracks deadlines and owners, and writes status updates.',
                "You are a project manager. Turn goals into clear projects and tasks with owners and due dates, keep track of progress, flag what is late or blocked, and write short status updates. Ask for a due date or owner when one is missing. When asked for a status update, list done, in progress, late, and next steps.",
                ['tasks', 'reminders', 'memory', 'email', 'knowledge'], 'high', '#9b8cff'],
            'sales' => ['Sales assistant', 'Plans follow-ups, drafts emails and SMS to leads, and keeps your pipeline moving.',
                "You are a sales assistant for a South African business. Help plan follow-ups, write short, friendly emails and SMS messages to leads and customers, and keep a task for every promised follow-up. Never promise prices, discounts or dates that are not in the knowledge or that the user did not give you.",
                ['tasks', 'reminders', 'memory', 'email', 'sms', 'knowledge'], 'medium', '#ffb86b'],
            'support' => ['Support lead', 'Summarises tickets, spots patterns and drafts replies from your knowledge.',
                "You help a customer service team. Summarise support tickets, find patterns in what customers ask, draft clear replies using only the knowledge provided, and suggest help articles to write. Be accurate and say so when the knowledge does not cover something.",
                ['desk', 'knowledge', 'tasks', 'memory'], 'medium', '#6ec1ff'],
            'research' => ['Research and writing', 'Reads your documents and answers questions, writes summaries, reports and proposals.',
                "You are a research and writing assistant. Answer from the documents provided and say which document an answer comes from. Write summaries, reports, proposals and emails in clear South African English. If the documents do not answer a question, say so rather than guessing.",
                ['knowledge', 'memory', 'tasks'], 'high', '#ff8fb1'],
            'hr' => ['Policies and HR', 'Answers staff questions from your handbook and policies, in plain language.',
                "You answer staff questions about company policies, leave, benefits and procedures, using only the handbook and policy documents provided. Be kind and plain. For anything personal, disciplinary, medical or legal, say that the HR team must handle it and suggest who to contact.",
                ['knowledge', 'memory'], 'medium', '#8be28b'],
        ];
    }

    public static function chooseModel(): array
    {
        foreach ([['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-5']] as [$p, $m]) if (Ai::configured($p) && Catalog::aiModel($p, $m)) return [$p, $m];
        return ['anthropic', 'claude-opus-5-5'];
    }

    public static function create(array $org, int $userId, string $template, array $over = []): array
    {
        $tpl = self::templates()[$template] ?? self::templates()['personal'];
        [$prov, $model] = self::chooseModel();
        $id = DB::insert('assistants', [
            'public_id' => public_id('ast'), 'org_id' => $org['id'], 'owner_id' => $userId, 'name' => mb_substr((string) ($over['name'] ?? '') ?: $tpl[0], 0, 80), 'role' => $template,
            'instructions' => (string) ($over['instructions'] ?? $tpl[2]), 'provider' => $prov, 'model' => $model, 'effort' => $tpl[4], 'tools' => implode(',', $tpl[3]), 'color' => $tpl[5],
            'shared' => 1, 'created_at' => now(), 'updated_at' => now(),
        ]);
        return DB::one('SELECT * FROM assistants WHERE id = ?', [$id]);
    }

    public static function groups(array $a): array
    {
        return array_values(array_intersect(array_keys(self::GROUPS), explode(',', (string) $a['tools'])));
    }

    /** Can this signed-in user use this assistant? Team assistants: anyone in the account. Private: the owner. */
    public static function canUse(array $a, array $user): bool
    {
        return (int) $a['org_id'] === (int) $user['org_id'] && ($a['shared'] || (int) $a['owner_id'] === (int) $user['id']);
    }

    // Tools ----------------------------------------------------------------------

    /** Tool definitions the model sees, for the groups switched on. Guests (shared link) only get knowledge. */
    public static function toolDefs(array $a, bool $guest): array
    {
        $g = $guest ? array_intersect(self::groups($a), ['knowledge']) : self::groups($a);
        $o = fn(array $props, array $req = []) => ['type' => 'object', 'properties' => $props, 'required' => $req];
        $str = fn(string $d) => ['type' => 'string', 'description' => $d];
        $defs = [];
        if (in_array('knowledge', $g, true)) $defs[] = ['search_knowledge', 'Search the documents and pages added to this assistant. Use before answering questions about the business, its products, policies or documents.', $o(['query' => $str('Words to look for')], ['query'])];
        if (in_array('memory', $g, true)) {
            $defs[] = ['remember', 'Save a lasting fact or preference the user wants remembered across conversations (for example "My manager is Thabo" or "Send reports on Fridays").', $o(['fact' => $str('The fact, in one sentence')], ['fact'])];
            $defs[] = ['forget', 'Delete a remembered fact by its number when the user says it is wrong or no longer true.', $o(['id' => ['type' => 'integer', 'description' => 'Memory number']], ['id'])];
        }
        if (in_array('tasks', $g, true)) {
            $defs[] = ['list_tasks', 'List tasks. Filter by project name, status (todo, doing, done, open) or due (today, overdue, week).', $o(['project' => $str('Project name, optional'), 'status' => $str('todo, doing, done or open (default open)'), 'due' => $str('today, overdue or week, optional')])];
            $defs[] = ['create_task', 'Create a task. Use a clear action title. Dates as YYYY-MM-DD.', $o(['title' => $str('What needs doing'), 'notes' => $str('Details, optional'), 'due_on' => $str('YYYY-MM-DD, optional'), 'priority' => $str('low, normal, high or urgent'), 'project' => $str('Project name, optional'), 'assignee' => $str('Team member name or email, optional')], ['title'])];
            $defs[] = ['update_task', 'Change a task by its number: status (todo, doing, done), title, notes, due date, priority or assignee.', $o(['id' => ['type' => 'integer', 'description' => 'Task number'], 'status' => $str('todo, doing or done'), 'title' => $str('New title'), 'notes' => $str('New notes'), 'due_on' => $str('YYYY-MM-DD'), 'priority' => $str('low, normal, high or urgent'), 'assignee' => $str('Name or email')], ['id'])];
            $defs[] = ['list_projects', 'List projects with their open and late task counts.', $o([])];
            $defs[] = ['create_project', 'Create a project to group tasks.', $o(['name' => $str('Project name'), 'description' => $str('Goal, optional'), 'due_on' => $str('YYYY-MM-DD, optional')], ['name'])];
        }
        if (in_array('reminders', $g, true)) {
            $defs[] = ['set_reminder', 'Remind the user at a time. Times are South African time (SAST), as YYYY-MM-DD HH:MM. Channel email (default) or sms.', $o(['message' => $str('What to remind them about'), 'at' => $str('YYYY-MM-DD HH:MM in SAST'), 'channel' => $str('email or sms')], ['message', 'at'])];
            $defs[] = ['list_reminders', 'List the user\'s upcoming reminders.', $o([])];
        }
        if (in_array('email', $g, true)) $defs[] = ['draft_email', 'Prepare an email. It is NOT sent: the user sees it and presses Send or Cancel. Tell the user it is waiting for their approval.', $o(['to' => $str('Email address'), 'subject' => $str('Subject'), 'body' => $str('Plain text body, signed off as the user')], ['to', 'subject', 'body'])];
        if (in_array('sms', $g, true)) $defs[] = ['draft_sms', 'Prepare an SMS (under 300 characters). It is NOT sent: the user approves it first, and sending uses their SMS credit.', $o(['to' => $str('Mobile number'), 'text' => $str('The message')], ['to', 'text'])];
        if (in_array('desk', $g, true)) {
            $defs[] = ['search_tickets', 'Search Desk support tickets by words, status (open, pending, solved) or days back. Returns number, subject, status, channel and date.', $o(['query' => $str('Words, optional'), 'status' => $str('open, pending, solved or any'), 'days' => ['type' => 'integer', 'description' => 'How many days back, default 30']])];
            $defs[] = ['read_ticket', 'Read one Desk ticket\'s conversation by its number.', $o(['number' => ['type' => 'integer', 'description' => 'Ticket number']], ['number'])];
        }
        return $defs;
    }

    private static function userByName(int $orgId, string $who): ?array
    {
        $who = trim($who);
        if ($who === '') return null;
        return DB::one('SELECT id, name, email FROM users WHERE org_id = ? AND disabled_at IS NULL AND (LOWER(email) = ? OR LOWER(name) LIKE ?) ORDER BY id LIMIT 1', [$orgId, strtolower($who), '%' . strtolower($who) . '%']);
    }

    private static function project(int $orgId, string $name, bool $create = false): ?array
    {
        if (trim($name) === '') return null;
        $p = DB::one("SELECT * FROM projects WHERE org_id = ? AND LOWER(name) = ? AND status <> 'archived'", [$orgId, strtolower(trim($name))])
            ?? DB::one("SELECT * FROM projects WHERE org_id = ? AND LOWER(name) LIKE ? AND status <> 'archived' ORDER BY id LIMIT 1", [$orgId, '%' . strtolower(trim($name)) . '%']);
        if (!$p && $create) $p = DB::one('SELECT * FROM projects WHERE id = ?', [DB::insert('projects', ['org_id' => $orgId, 'name' => mb_substr(trim($name), 0, 120), 'created_at' => now()])]);
        return $p;
    }

    private static function date(?string $d): ?string
    {
        $d = trim((string) $d);
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d) ? $d : null;
    }

    private static function taskLine(array $t): string
    {
        return "#{$t['id']} [{$t['status']}] {$t['title']}" . ($t['due_on'] ? " (due {$t['due_on']})" : '') . ($t['priority'] !== 'normal' ? " {$t['priority']}" : '')
            . (!empty($t['project']) ? " · {$t['project']}" : '') . (!empty($t['assignee']) ? " · {$t['assignee']}" : '');
    }

    /**
     * Run one tool call. Returns [text for the model, summary shown to the user or null, is_error].
     * Everything is limited to the assistant's own account.
     */
    public static function runTool(array $a, ?array $user, int $chatId, string $name, array $in): array
    {
        $org = (int) $a['org_id'];
        $today = gmdate('Y-m-d', time() + 7200);
        try {
            switch ($name) {
                case 'search_knowledge':
                    $hits = self::search((int) $a['id'], (string) ($in['query'] ?? ''));
                    return [$hits ? implode("\n\n---\n\n", array_map(fn($h) => "From \"{$h['title']}\":\n{$h['text']}", $hits)) : 'Nothing in the documents matches. Say so instead of guessing.', null, false];
                case 'remember':
                    $fact = mb_substr(trim((string) ($in['fact'] ?? '')), 0, 500);
                    if ($fact === '') return ['No fact given.', null, true];
                    if ((int) DB::value('SELECT COUNT(*) FROM assistant_memory WHERE assistant_id = ?', [$a['id']]) >= 200) return ['Memory is full (200 facts). Ask the user which to forget.', null, true];
                    $id = DB::insert('assistant_memory', ['assistant_id' => $a['id'], 'fact' => $fact, 'created_at' => now()]);
                    return ["Saved as memory #$id.", 'Remembered: ' . $fact, false];
                case 'forget':
                    $n = DB::run('DELETE FROM assistant_memory WHERE id = ? AND assistant_id = ?', [(int) ($in['id'] ?? 0), $a['id']])->rowCount();
                    return [$n ? 'Forgotten.' : 'No such memory.', $n ? 'Forgot memory #' . (int) $in['id'] : null, !$n];
                case 'list_tasks':
                    $sql = 'SELECT t.*, p.name project, u.name assignee FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id WHERE t.org_id = ?';
                    $args = [$org];
                    $st = (string) ($in['status'] ?? 'open');
                    if (in_array($st, ['todo', 'doing', 'done'], true)) { $sql .= ' AND t.status = ?'; $args[] = $st; } elseif ($st !== 'all') $sql .= " AND t.status <> 'done'";
                    if (!empty($in['project'])) { $p = self::project($org, (string) $in['project']); if (!$p) return ['No project called "' . $in['project'] . '".', null, false]; $sql .= ' AND t.project_id = ?'; $args[] = $p['id']; }
                    $due = (string) ($in['due'] ?? '');
                    if ($due === 'today') { $sql .= ' AND t.due_on = ?'; $args[] = $today; }
                    if ($due === 'overdue') { $sql .= " AND t.due_on < ? AND t.status <> 'done'"; $args[] = $today; }
                    if ($due === 'week') { $sql .= ' AND t.due_on <= ?'; $args[] = gmdate('Y-m-d', time() + 7200 + 7 * 86400); }
                    $rows = DB::all($sql . " ORDER BY CASE WHEN t.due_on IS NULL THEN 1 ELSE 0 END, t.due_on, t.id LIMIT 60", $args);
                    return [$rows ? implode("\n", array_map([self::class, 'taskLine'], $rows)) : 'No tasks match.', null, false];
                case 'create_task':
                    $title = mb_substr(trim((string) ($in['title'] ?? '')), 0, 200);
                    if ($title === '') return ['A task needs a title.', null, true];
                    $p = !empty($in['project']) ? self::project($org, (string) $in['project'], true) : null;
                    $as = !empty($in['assignee']) ? self::userByName($org, (string) $in['assignee']) : null;
                    $id = DB::insert('tasks', ['org_id' => $org, 'project_id' => $p['id'] ?? null, 'title' => $title, 'notes' => mb_substr((string) ($in['notes'] ?? ''), 0, 4000) ?: null,
                        'priority' => in_array($in['priority'] ?? '', ['low', 'normal', 'high', 'urgent'], true) ? $in['priority'] : 'normal', 'due_on' => self::date($in['due_on'] ?? null),
                        'assignee_id' => $as['id'] ?? ($user['id'] ?? null), 'created_by' => mb_substr($a['name'], 0, 60), 'created_at' => now()]);
                    $t = DB::one('SELECT t.*, p.name project, u.name assignee FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id WHERE t.id = ?', [$id]);
                    $warn = !empty($in['assignee']) && !$as ? ' (No team member called "' . $in['assignee'] . '"; assigned to the user instead.)' : '';
                    return ['Created ' . self::taskLine($t) . $warn, 'Added task #' . $id . ': ' . $title . ($t['due_on'] ? ', due ' . $t['due_on'] : ''), false];
                case 'update_task':
                    $t = DB::one('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [(int) ($in['id'] ?? 0), $org]);
                    if (!$t) return ['No task #' . (int) ($in['id'] ?? 0) . ' in this account.', null, true];
                    $upd = [];
                    if (in_array($in['status'] ?? '', ['todo', 'doing', 'done'], true)) { $upd['status'] = $in['status']; $upd['done_at'] = $in['status'] === 'done' ? now() : null; }
                    if (!empty($in['title'])) $upd['title'] = mb_substr((string) $in['title'], 0, 200);
                    if (isset($in['notes'])) $upd['notes'] = mb_substr((string) $in['notes'], 0, 4000);
                    if (!empty($in['due_on'])) $upd['due_on'] = self::date($in['due_on']);
                    if (in_array($in['priority'] ?? '', ['low', 'normal', 'high', 'urgent'], true)) $upd['priority'] = $in['priority'];
                    if (!empty($in['assignee'])) { $as = self::userByName($org, (string) $in['assignee']); if (!$as) return ['No team member called "' . $in['assignee'] . '".', null, true]; $upd['assignee_id'] = $as['id']; }
                    if (!$upd) return ['Nothing to change.', null, true];
                    DB::update('tasks', $upd, 'id = ?', [$t['id']]);
                    return ['Updated task #' . $t['id'] . '.', 'Updated task #' . $t['id'] . (isset($upd['status']) ? ': ' . ['todo' => 'to do', 'doing' => 'in progress', 'done' => 'done'][$upd['status']] : ''), false];
                case 'list_projects':
                    $rows = DB::all("SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done') open_n, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_on < ?) late_n FROM projects p WHERE p.org_id = ? AND p.status <> 'archived' ORDER BY p.id", [$today, $org]);
                    return [$rows ? implode("\n", array_map(fn($p) => "{$p['name']}: {$p['open_n']} open, {$p['late_n']} late" . ($p['due_on'] ? ", due {$p['due_on']}" : ''), $rows)) : 'No projects yet.', null, false];
                case 'create_project':
                    $nm = mb_substr(trim((string) ($in['name'] ?? '')), 0, 120);
                    if ($nm === '') return ['A project needs a name.', null, true];
                    if (self::project($org, $nm)) return ['A project called "' . $nm . '" already exists.', null, false];
                    DB::insert('projects', ['org_id' => $org, 'name' => $nm, 'description' => mb_substr((string) ($in['description'] ?? ''), 0, 2000) ?: null, 'due_on' => self::date($in['due_on'] ?? null), 'created_at' => now()]);
                    return ['Created project "' . $nm . '".', 'Created project ' . $nm, false];
                case 'set_reminder':
                    if (!$user) return ['Reminders need a signed-in user.', null, true];
                    $at = strtotime(trim((string) ($in['at'] ?? '')) . ' +0200');
                    if (!$at) return ['Give the time as YYYY-MM-DD HH:MM.', null, true];
                    if ($at < time() - 60) return ['That time has passed. Ask for a future time.', null, true];
                    $ch = ($in['channel'] ?? 'email') === 'sms' ? 'sms' : 'email';
                    if ($ch === 'sms' && !DB::value('SELECT phone FROM orgs WHERE id = ?', [$org])) return ['No mobile number on file. Offer an email reminder instead.', null, true];
                    $msg = mb_substr(trim((string) ($in['message'] ?? '')), 0, 500);
                    DB::insert('reminders', ['org_id' => $org, 'assistant_id' => $a['id'], 'user_id' => $user['id'], 'message' => $msg, 'channel' => $ch, 'due_at' => gmdate('Y-m-d H:i:s', $at), 'created_at' => now()]);
                    $when = gmdate('D j M, H:i', $at + 7200);
                    return ["Reminder set for $when SAST by $ch.", "Reminder set for $when by " . ($ch === 'sms' ? 'SMS' : 'email') . ": $msg", false];
                case 'list_reminders':
                    if (!$user) return ['No reminders.', null, false];
                    $rows = DB::all('SELECT * FROM reminders WHERE user_id = ? AND sent_at IS NULL ORDER BY due_at LIMIT 30', [$user['id']]);
                    return [$rows ? implode("\n", array_map(fn($r) => gmdate('D j M H:i', strtotime($r['due_at'] . ' UTC') + 7200) . " ({$r['channel']}): {$r['message']}", $rows)) : 'No upcoming reminders.', null, false];
                case 'draft_email':
                    $to = strtolower(trim((string) ($in['to'] ?? '')));
                    if (!filter_var($to, FILTER_VALIDATE_EMAIL)) return ['That is not a valid email address. Ask the user for it.', null, true];
                    $id = DB::insert('assistant_actions', ['assistant_id' => $a['id'], 'chat_id' => $chatId, 'kind' => 'email', 'payload' => json_encode(['to' => $to, 'subject' => mb_substr((string) ($in['subject'] ?? ''), 0, 200), 'body' => mb_substr((string) ($in['body'] ?? ''), 0, 10000)], JSON_UNESCAPED_UNICODE), 'created_at' => now()]);
                    return ["Draft #$id is waiting for the user to press Send. It has not been sent.", "approval:$id", false];
                case 'draft_sms':
                    $to = preg_replace('/[^\d+]/', '', (string) ($in['to'] ?? ''));
                    if (strlen(ltrim($to, '+')) < 9) return ['That is not a valid mobile number. Ask the user for it.', null, true];
                    $id = DB::insert('assistant_actions', ['assistant_id' => $a['id'], 'chat_id' => $chatId, 'kind' => 'sms', 'payload' => json_encode(['to' => $to, 'text' => mb_substr((string) ($in['text'] ?? ''), 0, 300)], JSON_UNESCAPED_UNICODE), 'created_at' => now()]);
                    return ["SMS draft #$id is waiting for the user to press Send. It has not been sent.", "approval:$id", false];
                case 'search_tickets':
                    $sql = 'SELECT number, subject, status, channel, requester_name, created_at FROM tickets WHERE org_id = ? AND merged_into IS NULL AND created_at >= ?';
                    $args = [$org, ts('-' . max(1, min(365, (int) ($in['days'] ?? 30))) . ' days')];
                    $st = (string) ($in['status'] ?? 'any');
                    if ($st === 'open') $sql .= " AND status IN ('new','open')"; elseif (in_array($st, ['pending', 'solved'], true)) { $sql .= ' AND status = ?'; $args[] = $st; }
                    if (!empty($in['query'])) { $sql .= ' AND (subject LIKE ? OR id IN (SELECT ticket_id FROM ticket_messages WHERE body LIKE ?))'; $args[] = '%' . $in['query'] . '%'; $args[] = '%' . $in['query'] . '%'; }
                    $rows = DB::all($sql . ' ORDER BY id DESC LIMIT 40', $args);
                    return [$rows ? implode("\n", array_map(fn($t) => "#{$t['number']} [{$t['status']}, {$t['channel']}] {$t['subject']} (" . substr($t['created_at'], 0, 10) . ')', $rows)) : 'No tickets match.', null, false];
                case 'read_ticket':
                    $t = DB::one('SELECT * FROM tickets WHERE org_id = ? AND number = ?', [$org, (int) ($in['number'] ?? 0)]);
                    if (!$t) return ['No such ticket.', null, true];
                    $msgs = array_map(fn($m) => ucfirst($m['author']) . ': ' . mb_substr($m['body'], 0, 1500), Desk::messages((int) $t['id'], false));
                    return ["#{$t['number']} {$t['subject']} [{$t['status']}]\n" . implode("\n\n", array_slice($msgs, -15)), null, false];
            }
            return ['Unknown tool.', null, true];
        } catch (Throwable $e) {
            log_line('assistants', "Tool $name failed: " . $e->getMessage());
            return ['The tool failed: ' . mb_substr($e->getMessage(), 0, 150), null, true];
        }
    }

    // Knowledge ---------------------------------------------------------------------

    /** Plain text from an upload: .txt, .md, .csv, .html and Word (.docx). */
    public static function extract(string $name, string $data): ?string
    {
        $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
        if (in_array($ext, ['txt', 'md', 'csv'], true)) return mb_convert_encoding($data, 'UTF-8', 'UTF-8, ISO-8859-1');
        if (in_array($ext, ['html', 'htm'], true)) return self::htmlText($data);
        if ($ext === 'docx' && class_exists('ZipArchive')) {
            $tmp = tempnam(sys_get_temp_dir(), 'docx');
            file_put_contents($tmp, $data);
            $zip = new ZipArchive();
            $xml = $zip->open($tmp) === true ? (string) $zip->getFromName('word/document.xml') : '';
            if (isset($zip->numFiles)) @$zip->close();
            @unlink($tmp);
            if ($xml === '') return null;
            $xml = preg_replace(['#</w:p>#', '#<w:tab/>#', '#<w:br/>#'], ["\n", "\t", "\n"], $xml);
            return trim(html_entity_decode(strip_tags($xml), ENT_QUOTES | ENT_XML1, 'UTF-8'));
        }
        return null;
    }

    public static function htmlText(string $html): string
    {
        $html = preg_replace('#<(script|style|noscript|svg|nav|footer)[^>]*>.*?</\1>#is', ' ', $html);
        $html = preg_replace('#<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>#i', "\n", $html);
        $t = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        return trim(preg_replace(["/[ \t]+/", "/\n\s*\n+/"], [' ', "\n\n"], $t));
    }

    /** Read a public web page into the assistant's knowledge. Private and local addresses are refused. */
    public static function fetchPage(string $url): array
    {
        if ($err = Monitors::problem($url)) throw new RuntimeException($err);
        $res = Http::request('GET', $url, ['Accept' => 'text/html,text/plain'], null, 20);
        if ($res['error'] || $res['status'] >= 400) throw new RuntimeException('Could not read that page (' . ($res['error'] ?: 'error ' . $res['status']) . ').');
        $title = preg_match('#<title[^>]*>(.*?)</title>#is', $res['body'], $m) ? trim(html_entity_decode($m[1])) : $url;
        return [mb_substr($title, 0, 200), mb_substr(self::htmlText($res['body']), 0, 200000)];
    }

    /** Best-matching passages for a query, by simple word scoring over ~1,200-character chunks. */
    public static function search(int $assistantId, string $query, int $limit = 5): array
    {
        $words = array_values(array_filter(array_unique(preg_split('/[^\pL\pN]+/u', mb_strtolower($query))), fn($w) => mb_strlen($w) > 2));
        if (!$words) return [];
        $hits = [];
        foreach (DB::all('SELECT title, content FROM assistant_docs WHERE assistant_id = ?', [$assistantId]) as $d) {
            foreach (self::chunks($d['content']) as $c) {
                $lc = mb_strtolower($c);
                $score = 0;
                foreach ($words as $w) $score += substr_count($lc, $w) * (1 + mb_strlen($w) / 10);
                if (mb_stripos($d['title'], $words[0]) !== false) $score += 1;
                if ($score > 0) $hits[] = ['title' => $d['title'], 'text' => self::around($c, $words), 'score' => $score];
            }
        }
        usort($hits, fn($x, $y) => $y['score'] <=> $x['score']);
        return array_slice($hits, 0, $limit);
    }

    /** The part of a passage around the first matching word, so long passages do not hide the answer. */
    private static function around(string $chunk, array $words, int $width = 700): string
    {
        if (mb_strlen($chunk) <= $width) return $chunk;
        $pos = PHP_INT_MAX;
        foreach ($words as $w) { $p = mb_stripos($chunk, $w); if ($p !== false) $pos = min($pos, $p); }
        if ($pos === PHP_INT_MAX) return mb_substr($chunk, 0, $width) . '…';
        $start = max(0, $pos - intdiv($width, 3));
        return ($start > 0 ? '…' : '') . mb_substr($chunk, $start, $width) . ($start + $width < mb_strlen($chunk) ? '…' : '');
    }

    private static function chunks(string $text): array
    {
        $out = []; $buf = '';
        foreach (preg_split("/\n\s*\n/", $text) as $para) {
            if (mb_strlen($buf) + mb_strlen($para) > 1200 && $buf !== '') { $out[] = trim($buf); $buf = ''; }
            $buf .= $para . "\n\n";
            while (mb_strlen($buf) > 2400) { $out[] = mb_substr($buf, 0, 1200); $buf = mb_substr($buf, 1200); }
        }
        if (trim($buf) !== '') $out[] = trim($buf);
        return $out;
    }

    // Conversation ------------------------------------------------------------------

    public static function systemPrompt(array $a, ?array $user, bool $guest): string
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$a['org_id']]);
        $now = gmdate('l j F Y, H:i', time() + 7200);
        $team = $guest ? '' : implode(', ', array_column(DB::all('SELECT name FROM users WHERE org_id = ? AND disabled_at IS NULL LIMIT 30', [$a['org_id']]), 'name'));
        $memory = $guest ? [] : DB::all('SELECT id, fact FROM assistant_memory WHERE assistant_id = ? ORDER BY id', [$a['id']]);
        $docs = DB::all('SELECT title, content, chars FROM assistant_docs WHERE assistant_id = ? ORDER BY id', [$a['id']]);
        $total = array_sum(array_column($docs, 'chars'));
        $inline = $total > 0 && $total <= 40000;
        $groups = $guest ? array_intersect(self::groups($a), ['knowledge']) : self::groups($a);
        $can = implode("\n", array_map(fn($g) => '- ' . self::GROUPS[$g][0] . ': ' . self::GROUPS[$g][1], $groups)) ?: '- Conversation only.';
        $p = "You are {$a['name']}, an AI assistant working for {$org['name']}" . ($guest ? ', answering a visitor through a shared link' : ($user ? ", helping {$user['name']}" : '')) . ".\n"
            . "Today is $now (South African time, SAST). Use South African English and rand (R) for money.\n\n"
            . "# Your role\n" . trim((string) $a['instructions']) . "\n\n"
            . "# What you can do\n$can\n\n"
            . "# How to work\n"
            . "- Use your tools to act instead of only describing what you would do. After acting, say briefly what you did (for example \"Added task #12, due Friday\").\n"
            . "- Never claim you did something a tool did not confirm. If a tool fails, say so and suggest what to do.\n"
            . "- Emails and SMS are drafts until the user approves them in the chat. Say they are waiting for approval; never say they were sent.\n"
            . "- Be concise and plain. Use short lists when listing tasks or steps. Ask one clear question when something essential is missing, such as a due date or an email address.\n"
            . "- Never ask for passwords, card numbers or ID numbers. Do not give legal, medical or financial advice beyond what the documents say.\n";
        if ($team !== '') $p .= "\n# Team members\n$team\n";
        if ($memory) $p .= "\n# What you remember (number: fact)\n" . implode("\n", array_map(fn($m) => "{$m['id']}: {$m['fact']}", $memory)) . "\n";
        if ($inline) $p .= "\n# Documents\n" . implode("\n\n", array_map(fn($d) => "## {$d['title']}\n{$d['content']}", $docs)) . "\n";
        elseif ($total > 0) $p .= "\n# Documents\nThere are " . count($docs) . ' documents (' . implode(', ', array_column($docs, 'title')) . "). Use search_knowledge to look things up before answering from them.\n";
        return $p;
    }

    /**
     * One user message in, one assistant reply out, with as many tool steps as needed (up to 8).
     * Returns [text, actions (what was done), approvals (pending drafts), amount charged].
     */
    public static function reply(array $a, array $chat, string $text, ?array $user, bool $guest = false): array
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$a['org_id']]);
        $history = [];
        foreach (DB::all('SELECT role, content FROM assistant_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 30', [$chat['id']]) as $m) array_unshift($history, ['role' => $m['role'], 'content' => $m['content']]);
        while ($history && $history[0]['role'] !== 'user') array_shift($history);
        DB::insert('assistant_messages', ['chat_id' => $chat['id'], 'role' => 'user', 'content' => mb_substr($text, 0, 20000), 'created_at' => now()]);
        $messages = array_merge($history, [['role' => 'user', 'content' => $text]]);
        $system = self::systemPrompt($a, $user, $guest);
        $tools = self::toolDefs($a, $guest);
        $actions = []; $approvals = []; $amount = 0.0; $final = '';
        try {
            for ($step = 0; $step < 8; $step++) {
                $res = Ai::meteredToolTurn($org, $a['provider'], $a['model'], $system, $messages, $tools, $a['effort'], 'assistant:' . $a['public_id']);
                $amount += $res['amount'];
                if ($res['text'] !== '') $final = $res['text'];
                if (!$res['calls']) break;
                $results = [];
                foreach ($res['calls'] as $c) {
                    [$out, $summary, $err] = self::runTool($a, $user, (int) $chat['id'], $c['name'], (array) $c['input']);
                    if ($summary && str_starts_with($summary, 'approval:')) $approvals[] = (int) substr($summary, 9);
                    elseif ($summary) $actions[] = $summary;
                    $results[] = ['id' => $c['id'], 'content' => $out, 'error' => $err];
                }
                $messages[] = $res['assistant'];
                array_push($messages, ...Ai::toolResults($a['provider'], $results));
                if ($step === 7) $final = $final ?: 'I did several steps but ran out of turns. Here is where things stand: ' . implode('; ', $actions);
            }
        } catch (AiError $e) {
            $final = in_array($e->type, ['ai_cap_reached', 'insufficient_balance', 'ai_rate_limited'], true) ? $e->getMessage() : 'Sorry, I could not answer just now (' . $e->getMessage() . '). Please try again.';
            log_line('assistants', "{$a['public_id']}: " . $e->getMessage());
        }
        if ($final === '') $final = $actions ? 'Done.' : 'I am not sure how to help with that. Could you say a bit more?';
        DB::insert('assistant_messages', ['chat_id' => $chat['id'], 'role' => 'assistant', 'content' => $final, 'actions' => ($actions || $approvals) ? json_encode(['done' => $actions, 'approvals' => $approvals], JSON_UNESCAPED_UNICODE) : null, 'amount' => $amount, 'created_at' => now()]);
        $upd = ['updated_at' => now()];
        if ($chat['title'] === 'New conversation') $upd['title'] = mb_strimwidth(preg_replace('/\s+/', ' ', $text), 0, 60, '…');
        DB::update('assistant_chats', $upd, 'id = ?', [$chat['id']]);
        return ['text' => $final, 'actions' => $actions, 'approvals' => $approvals, 'amount' => $amount];
    }

    public static function newChat(array $a, ?int $userId, ?string $guest = null): array
    {
        $id = DB::insert('assistant_chats', ['public_id' => public_id('chat'), 'assistant_id' => $a['id'], 'user_id' => $userId, 'guest' => $guest, 'title' => 'New conversation', 'created_at' => now(), 'updated_at' => now()]);
        return DB::one('SELECT * FROM assistant_chats WHERE id = ?', [$id]);
    }

    /** A person approves or cancels a drafted email or SMS. */
    public static function decide(array $a, int $actionId, bool $approve, array $user): string
    {
        $x = DB::one("SELECT * FROM assistant_actions WHERE id = ? AND assistant_id = ? AND status = 'pending'", [$actionId, $a['id']]);
        if (!$x) return 'That draft was already handled.';
        $p = json_decode($x['payload'], true);
        if (!$approve) {
            DB::update('assistant_actions', ['status' => 'cancelled', 'decided_by' => $user['id'], 'decided_at' => now()], 'id = ?', [$x['id']]);
            return 'Cancelled. Nothing was sent.';
        }
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$a['org_id']]);
        if ($x['kind'] === 'email') {
            Mail::queue($p['to'], $p['subject'], 'assistant_email', ['body' => $p['body'], 'brand' => $org['name'], 'org' => $org], ['Reply-To' => $user['email'], 'X-From-Name' => $user['name'] . ' (' . $org['name'] . ')']);
            $result = 'Email queued to ' . $p['to'];
        } else {
            if (!$org['is_house'] && (!$org['live_enabled'] || $org['status'] !== 'active')) return 'SMS needs live access on your account first.';
            [$code, $res] = Gateway::run($org, 'live', 'POST', 'sms/messages', ['to' => [$p['to']], 'body' => $p['text'], 'reference' => 'assistant:' . $a['public_id']]);
            if ($code >= 300) return 'Not sent: ' . ($res['error']['message'] ?? 'error ' . $code);
            $result = 'SMS sent to ' . $p['to'];
        }
        DB::update('assistant_actions', ['status' => 'approved', 'result' => $result, 'decided_by' => $user['id'], 'decided_at' => now()], 'id = ?', [$x['id']]);
        audit('assistant.action_approved', (int) $a['org_id'], $x['kind'] . ' #' . $x['id']);
        return $result . '.';
    }

    // Scheduled -----------------------------------------------------------------------

    /** Send reminders that are due, and each assistant's morning brief. */
    public static function runScheduled(): int
    {
        $n = 0;
        foreach (DB::all('SELECT r.*, u.email, u.name FROM reminders r JOIN users u ON u.id = r.user_id WHERE r.sent_at IS NULL AND r.due_at <= ? LIMIT 100', [now()]) as $r) {
            DB::update('reminders', ['sent_at' => now()], 'id = ?', [$r['id']]);
            $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$r['org_id']]);
            if ($r['channel'] === 'sms' && ($phone = $org['phone'])) {
                $err = Plugins::alertSms($org, (string) $phone, 'Reminder: ' . $r['message'], 'reminder:' . $r['id']);
                if (!$err) { $n++; continue; }
            }
            Mail::queue($r['email'], 'Reminder: ' . mb_strimwidth($r['message'], 0, 70, '…'), 'assistant_reminder', ['r' => $r]);
            $n++;
        }
        $sast = time() + 7200;
        $today = gmdate('Y-m-d', $sast);
        foreach (DB::all('SELECT a.*, u.email, u.name uname FROM assistants a JOIN users u ON u.id = a.owner_id WHERE a.brief_hour IS NOT NULL AND a.status = ? AND (a.brief_last IS NULL OR a.brief_last <> ?)', ['active', $today]) as $a) {
            if ((int) gmdate('G', $sast) < (int) $a['brief_hour']) continue;
            DB::update('assistants', ['brief_last' => $today], 'id = ?', [$a['id']]);
            $tasks = DB::all("SELECT t.*, p.name project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.org_id = ? AND t.status <> 'done' AND (t.assignee_id = ? OR t.assignee_id IS NULL) AND t.due_on IS NOT NULL AND t.due_on <= ? ORDER BY t.due_on", [$a['org_id'], $a['owner_id'], gmdate('Y-m-d', $sast + 86400)]);
            $rem = DB::all('SELECT * FROM reminders WHERE user_id = ? AND sent_at IS NULL AND due_at < ? ORDER BY due_at', [$a['owner_id'], gmdate('Y-m-d 22:00:00', $sast)]);
            Mail::queue($a['email'], $a['name'] . ': your day, ' . gmdate('l j F', $sast), 'assistant_brief', ['a' => $a, 'tasks' => $tasks, 'reminders' => $rem, 'today' => $today, 'link' => app_url('/dashboard/assistants/' . $a['public_id'])]);
            $n++;
        }
        return $n;
    }
}

/** Safe, small Markdown for assistant replies: bold, italics, code, links, headings and lists. Everything is escaped first. */
function md_lite(string $text): string
{
    $lines = explode("\n", str_replace("\r", '', $text));
    $out = ''; $list = null; $para = [];
    $inline = function (string $s): string {
        $s = e($s);
        $s = preg_replace('/`([^`]+)`/', '<code>$1</code>', $s);
        $s = preg_replace('/\*\*(.+?)\*\*/', '<b>$1</b>', $s);
        $s = preg_replace('/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/', '<i>$1</i>', $s);
        return preg_replace_callback('/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/', fn($m) => '<a href="' . $m[2] . '" target="_blank" rel="noopener nofollow">' . $m[1] . '</a>', $s);
    };
    $flushP = function () use (&$para, &$out, $inline) { if ($para) { $out .= '<p>' . implode('<br>', array_map($inline, $para)) . '</p>'; $para = []; } };
    $flushL = function () use (&$list, &$out) { if ($list) { $out .= '</' . $list . '>'; $list = null; } };
    foreach ($lines as $l) {
        if (preg_match('/^\s*[-*•]\s+(.*)$/', $l, $m) || preg_match('/^\s*\d+[.)]\s+(.*)$/', $l, $m2)) {
            $tag = isset($m2) && $m2 ? 'ol' : 'ul';
            $item = $m[1] ?? $m2[1];
            $flushP();
            if ($list !== $tag) { $flushL(); $out .= "<$tag>"; $list = $tag; }
            $out .= '<li>' . $inline($item) . '</li>';
            unset($m2);
            continue;
        }
        unset($m2);
        if (preg_match('/^\s*#{1,4}\s+(.*)$/', $l, $m)) { $flushP(); $flushL(); $out .= '<h4>' . $inline($m[1]) . '</h4>'; continue; }
        if (trim($l) === '') { $flushP(); $flushL(); continue; }
        $flushL();
        $para[] = $l;
    }
    $flushP(); $flushL();
    return $out;
}
