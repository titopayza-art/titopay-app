<?php
/**
 * SeaGeek Desk: multi-tenant help desk. SeaGeek's own support runs on the "house" organisation;
 * every customer organisation gets the same Desk for its own customers.
 */
declare(strict_types=1);

final class Desk
{
    public const STATUSES = ['new', 'open', 'pending', 'solved', 'closed'];
    public const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
    private const SLA_HOURS = ['urgent' => 1, 'high' => 4, 'normal' => 24, 'low' => 72];

    public static function house(): array
    {
        return DB::one('SELECT * FROM orgs WHERE is_house = 1 ORDER BY id LIMIT 1');
    }

    public static function createTicket(int $orgId, string $subject, string $body, string $channel, array $requester, string $priority = 'normal', array $tags = [], bool $sandbox = false): array
    {
        $priority = in_array($priority, self::PRIORITIES, true) ? $priority : 'normal';
        if ($sandbox) $tags[] = 'sandbox';
        $number = (int) DB::value('SELECT COALESCE(MAX(number), 1000) FROM tickets WHERE org_id = ?', [$orgId]) + 1;
        $id = DB::insert('tickets', [
            'org_id' => $orgId, 'number' => $number, 'subject' => mb_substr(trim($subject) ?: 'Conversation', 0, 200), 'status' => 'new', 'priority' => $priority,
            'channel' => $channel, 'requester_name' => mb_substr((string) ($requester['name'] ?? ''), 0, 120) ?: null,
            'requester_email' => isset($requester['email']) && filter_var($requester['email'], FILTER_VALIDATE_EMAIL) ? strtolower($requester['email']) : null,
            'requester_phone' => mb_substr((string) ($requester['phone'] ?? ''), 0, 40) ?: null, 'token' => Crypto::token(18),
            'ai_active' => self::agentFor($orgId) ? 1 : 0, 'sla_due_at' => ts('+' . self::SLA_HOURS[$priority] . ' hours'),
            'tags' => mb_substr(implode(',', array_unique(array_filter(array_map('trim', $tags)))), 0, 255), 'created_at' => now(), 'updated_at' => now(),
        ]);
        self::addMessage($id, 'customer', $body);
        DeskRules::apply(self::ticket($id), 'created', $body);
        $t = self::ticket($id);
        if (!$sandbox && $t['requester_email'] && $channel !== 'chat') {
            $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
            Mail::queue($t['requester_email'], "[#{$t['number']}] We've received your request", 'ticket_received', ['ticket' => $t, 'org' => $org], DeskFlow::threadHeaders($t, $org));
        }
        Webhooks::queue($orgId, 'desk.ticket_created', self::publicTicket($t));
        return $t;
    }

    public static function ticket(int $id): ?array { return DB::one('SELECT * FROM tickets WHERE id = ?', [$id]); }

    public static function messages(int $ticketId, bool $includeInternal = true): array
    {
        return DB::all('SELECT m.*, u.name AS author_name FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = ?' . ($includeInternal ? '' : ' AND m.internal = 0') . ' ORDER BY m.id', [$ticketId]);
    }

    public static function addMessage(int $ticketId, string $author, string $body, bool $internal = false, ?int $authorId = null): int
    {
        $id = DB::insert('ticket_messages', ['ticket_id' => $ticketId, 'author' => $author, 'author_id' => $authorId, 'body' => mb_substr($body, 0, 20000), 'internal' => $internal ? 1 : 0, 'created_at' => now()]);
        DB::update('tickets', ['updated_at' => now()] + ($author === 'customer' ? ['last_customer_at' => now()] : []), 'id = ?', [$ticketId]);
        return $id;
    }

    /** An agent's reply. Public replies are emailed to the requester with a link to the conversation. */
    public static function agentReply(array $ticket, int $userId, string $body, bool $internal, ?string $status, ?callable $attach = null): void
    {
        $msgId = self::addMessage((int) $ticket['id'], 'agent', $body, $internal, $userId);
        $files = $attach ? $attach($msgId) : [];
        $upd = ['ai_active' => 0, 'assignee_id' => $ticket['assignee_id'] ?: $userId];
        if (!$internal && !$ticket['first_reply_at']) $upd['first_reply_at'] = now();
        $status = in_array($status, self::STATUSES, true) ? $status : ($ticket['status'] === 'new' ? 'open' : $ticket['status']);
        $upd['status'] = $status;
        if ($status === 'solved' && !$ticket['solved_at']) $upd['solved_at'] = now();
        DB::update('tickets', $upd, 'id = ?', [$ticket['id']]);
        if (!$internal) DeskFlow::deliver(self::ticket((int) $ticket['id']), $body, 'agent', $files);
    }

    /** A follow-up from the customer re-opens solved tickets and lets the AI answer again if it still owns the ticket. */
    public static function customerReply(array $ticket, string $body): array
    {
        self::addMessage((int) $ticket['id'], 'customer', $body);
        if (in_array($ticket['status'], ['solved', 'pending'], true)) DB::update('tickets', ['status' => 'open', 'solved_at' => null], 'id = ?', [$ticket['id']]);
        DeskRules::apply(self::ticket((int) $ticket['id']), 'replied', $body);
        $ticket = self::ticket((int) $ticket['id']);
        return $ticket['ai_active'] ? self::aiRespond($ticket) : ['reply' => null, 'handover' => true];
    }

    public static function agentFor(int $orgId): ?array
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
        if (!$org) return null;
        if ($org['is_house']) {
            $provider = Settings::get('chat_provider');
            return Ai::configured($provider) ? ['provider' => $provider, 'model' => Settings::get('chat_model_' . $provider), 'instructions' => '', 'knowledge' => '', 'house' => true] : null;
        }
        return DB::one('SELECT * FROM ai_agents WHERE org_id = ? AND active = 1 ORDER BY id LIMIT 1', [$orgId]);
    }

    /** Let the AI agent answer the latest customer message, or hand the ticket to people. */
    public static function aiRespond(array $ticket, string $env = 'live'): array
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$ticket['org_id']]);
        $agent = self::agentFor((int) $org['id']);
        if (!$agent) return self::handover($ticket, 'No AI agent is set up');

        $history = [];
        foreach (self::messages((int) $ticket['id'], false) as $m) {
            $role = $m['author'] === 'customer' ? 'user' : 'assistant';
            if ($history && end($history)['role'] === $role) {
                $history[count($history) - 1]['content'] .= "\n\n" . $m['body'];
            } else {
                $history[] = ['role' => $role, 'content' => $m['body']];
            }
        }
        if (!$history || $history[0]['role'] !== 'user') array_unshift($history, ['role' => 'user', 'content' => '(conversation started)']);
        if (end($history)['role'] !== 'user') return ['reply' => null, 'handover' => false];
        $history = array_slice($history, -20);
        if ($history[0]['role'] !== 'user') array_shift($history);

        $system = Ai::agentSystemPrompt($org, empty($agent['house']) ? $agent : null);
        $run = fn(string $prov, string $model) => !empty($agent['house'])
            ? Ai::complete($prov, $model, $system, $history, 1024, true)
            : Ai::meteredChat($org, $env, $prov, $model, $system, $history, 1024, (bool) $agent['handover'], 'ticket-' . $ticket['id']);
        try {
            try {
                $res = $run($agent['provider'], $agent['model']);
            } catch (AiError $e) {
                // One provider busy or down: answer with the other one instead of making the customer wait.
                $fb = Ai::transient($e) ? Ai::fallbackFor($agent['provider']) : null;
                if (!$fb) throw $e;
                log_line('ai', 'Agent on ticket ' . $ticket['id'] . ' switched to ' . $fb[0] . ': ' . $e->getMessage());
                $res = $run($fb[0], $fb[1]);
            }
        } catch (Throwable $e) {
            log_line('ai', 'Agent failed on ticket ' . $ticket['id'] . ': ' . $e->getMessage());
            return self::handover($ticket, 'The AI agent was unavailable: ' . mb_substr($e->getMessage(), 0, 120));
        }
        $reply = $res['text'] !== '' ? $res['text'] : "Thanks, I'm passing this to a member of the team who will reply shortly.";
        self::addMessage((int) $ticket['id'], 'ai', $reply);
        if ($ticket['channel'] !== 'chat') DeskFlow::deliver(self::ticket((int) $ticket['id']), $reply, 'ai');
        if ($ticket['status'] === 'new') DB::update('tickets', ['status' => 'open'], 'id = ?', [$ticket['id']]);
        if ($res['handover']) return ['reply' => $reply] + self::handover(self::ticket((int) $ticket['id']), $res['handover'], false);
        return ['reply' => $reply, 'handover' => false];
    }

    public static function handover(array $ticket, string $reason, bool $postNotice = true): array
    {
        DB::update('tickets', ['ai_active' => 0, 'status' => 'open', 'priority' => $ticket['priority'] === 'low' ? 'normal' : $ticket['priority']], 'id = ?', [$ticket['id']]);
        self::addMessage((int) $ticket['id'], 'system', 'Handed to a person: ' . $reason, true);
        $reply = null;
        if ($postNotice) {
            $reply = 'Thanks, a member of our team will pick this up. ' . (Settings::get('support_hours') ? 'We reply during ' . Settings::get('support_hours') . '.' : '');
            self::addMessage((int) $ticket['id'], 'system', $reply);
            if ($ticket['channel'] === 'whatsapp') DeskFlow::deliver(self::ticket((int) $ticket['id']), $reply, 'system');
        }
        foreach (DB::all("SELECT email FROM users WHERE org_id = ? AND role IN ('owner','agent')", [$ticket['org_id']]) as $u) {
            Mail::queue($u['email'], "Handover: #{$ticket['number']} {$ticket['subject']}", 'handover', ['ticket' => $ticket, 'reason' => $reason]);
        }
        Webhooks::queue((int) $ticket['org_id'], 'desk.handover', self::publicTicket($ticket) + ['reason' => $reason]);
        return ['reply' => $reply, 'handover' => true];
    }

    /** Flag tickets that missed their first-reply target and tell the team once. */
    public static function runSla(): int
    {
        $n = 0;
        foreach (DB::all("SELECT * FROM tickets WHERE first_reply_at IS NULL AND status IN ('new','open') AND ai_active = 0 AND sla_due_at < ? AND (tags IS NULL OR tags NOT LIKE '%sla-breach%')", [now()]) as $t) {
            DB::update('tickets', ['tags' => trim(($t['tags'] ? $t['tags'] . ',' : '') . 'sla-breach', ',')], 'id = ?', [$t['id']]);
            foreach (DB::all("SELECT email FROM users WHERE org_id = ? AND role IN ('owner','agent')", [$t['org_id']]) as $u) {
                Mail::queue($u['email'], "Overdue: #{$t['number']} {$t['subject']}", 'handover', ['ticket' => $t, 'reason' => 'First reply target missed']);
            }
            $n++;
        }
        return $n;
    }

    public static function publicTicket(array $t): array
    {
        return ['id' => (int) $t['number'], 'subject' => $t['subject'], 'status' => $t['status'], 'priority' => $t['priority'], 'channel' => $t['channel'],
            'requester' => ['name' => $t['requester_name'], 'email' => $t['requester_email'], 'phone' => $t['requester_phone']],
            'url' => app_url('/t/' . $t['token']), 'created_at' => gmdate('c', strtotime($t['created_at'] . ' UTC'))];
    }

    public static function stats(int $orgId): array
    {
        $since = ts('-30 days');
        $created = (int) DB::value('SELECT COUNT(*) FROM tickets WHERE org_id = ? AND created_at >= ?', [$orgId, $since]);
        $aiSolved = (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND created_at >= ? AND ai_active = 1 AND status IN ('solved','closed','open') AND NOT EXISTS (SELECT 1 FROM ticket_messages m WHERE m.ticket_id = tickets.id AND m.author = 'agent')", [$orgId, $since]);
        $csat = DB::one('SELECT AVG(csat) a, COUNT(csat) c FROM tickets WHERE org_id = ? AND csat IS NOT NULL AND created_at >= ?', [$orgId, $since]);
        return [
            'open' => (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND status IN ('new','open')", [$orgId]),
            'pending' => (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND status = 'pending'", [$orgId]),
            'created_30d' => $created,
            'ai_handled_30d' => $aiSolved,
            'breached' => (int) DB::value("SELECT COUNT(*) FROM tickets WHERE org_id = ? AND status IN ('new','open') AND tags LIKE '%sla-breach%'", [$orgId]),
            'csat' => $csat && $csat['c'] ? round((float) $csat['a'], 1) : null,
        ];
    }
}
