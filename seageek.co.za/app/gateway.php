<?php
/**
 * Public REST API: https://www.seageek.co.za/api/v1/...
 */
declare(strict_types=1);

final class ApiError extends RuntimeException
{
    public function __construct(public int $status, public string $type, string $message)
    {
        parent::__construct($message);
    }
}

final class Gateway
{
    private static array $ctx = [];

    public static function handle(string $method, string $path): never
    {
        header('X-Request-Id: ' . ($rid = public_id('req')));
        try {
            $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
            if (!preg_match('/^Bearer\s+(\S+)$/', $auth, $m)) throw new ApiError(401, 'authentication_error', 'Send your API key as "Authorization: Bearer sg_..."');
            $resolved = ApiKeys::resolve($m[1]);
            if (!$resolved) throw new ApiError(401, 'authentication_error', 'This API key is not valid or has been revoked.');
            $org = $resolved['org'];
            $env = $resolved['key']['env'];
            $plan = Billing::plan($org);
            if (rate_limited('api:' . $resolved['key']['id'], (int) $plan['api_rps'] * 60, 60)) {
                header('Retry-After: 10');
                throw new ApiError(429, 'rate_limited', "Your plan allows {$plan['api_rps']} requests a second on average. Slow down or upgrade.");
            }
            if ($org['status'] === 'closed') throw new ApiError(403, 'account_closed', 'This account is closed.');
            if ($env === 'live') {
                if ($org['status'] === 'locked') throw new ApiError(402, 'account_locked', 'Live access is paused: ' . ($org['locked_reason'] ?: 'contact support') . '. Pay in the dashboard to restore it.');
                if (!$org['live_enabled']) throw new ApiError(403, 'live_not_enabled', 'Live access turns on after your first payment. Use a sandbox key until then.');
            }
            $raw = file_get_contents('php://input') ?: '';
            $body = $raw !== '' ? json_decode($raw, true) : [];
            if ($raw !== '' && !is_array($body)) throw new ApiError(400, 'invalid_json', 'The request body must be JSON.');
            self::$ctx = ['org' => $org, 'env' => $env, 'key' => $resolved['key'], 'body' => $body ?? [], 'plan' => $plan];

            $idem = $_SERVER['HTTP_IDEMPOTENCY_KEY'] ?? '';
            if ($method === 'POST' && $idem !== '') {
                $prev = DB::one('SELECT * FROM idempotency WHERE org_id = ? AND idem_key = ?', [$org['id'], mb_substr($idem, 0, 120)]);
                if ($prev) { header('Idempotent-Replayed: true'); json_out(json_decode($prev['response'], true), (int) $prev['status']); }
            }
            [$status, $result] = self::route($method, $path);
            if ($method === 'POST' && $idem !== '' && $status < 500) {
                DB::insert('idempotency', ['org_id' => $org['id'], 'idem_key' => mb_substr($idem, 0, 120), 'status' => $status, 'response' => json_encode($result), 'created_at' => now()]);
            }
            json_out($result, $status);
        } catch (ApiError | AiError $e) {
            json_out(['error' => ['type' => $e->type, 'message' => $e->getMessage()], 'request_id' => $rid], $e->status);
        } catch (InsufficientFunds) {
            json_out(['error' => ['type' => 'insufficient_balance', 'message' => 'Your balance is too low for this request. Add credit in the dashboard.'], 'request_id' => $rid], 402);
        } catch (Throwable $e) {
            log_line('api', $rid . ' ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            json_out(['error' => ['type' => 'api_error', 'message' => 'Something went wrong on our side. It is safe to retry with the same Idempotency-Key.'], 'request_id' => $rid], 500);
        }
    }

    /** Run an API request on behalf of a signed-in customer (dashboard "Try it" console). Sandbox only. */
    public static function internal(array $org, string $method, string $path, array $body): array
    {
        self::$ctx = ['org' => $org, 'env' => 'test', 'key' => ['id' => 0], 'body' => $body, 'plan' => Billing::plan($org)];
        try {
            return self::route($method, $path);
        } catch (ApiError | AiError $e) {
            return [$e->status, ['error' => ['type' => $e->type, 'message' => $e->getMessage()]]];
        }
    }

    private static function route(string $method, string $path): array
    {
        $routes = [
            ['GET', '#^account$#', 'account'], ['GET', '#^balance$#', 'balance'], ['GET', '#^usage$#', 'usage'],
            ['GET', '#^messages/([\w-]+)$#', 'getMessage'],
            ['POST', '#^sms/messages$#', 'sendSms'], ['GET', '#^sms/messages/([\w-]+)$#', 'getMessage'],
            ['POST', '#^mail/messages$#', 'sendMail'], ['GET', '#^mail/messages/([\w-]+)$#', 'getMessage'],
            ['POST', '#^auth/otp$#', 'sendOtp'], ['POST', '#^auth/otp/([\w-]+)/check$#', 'checkOtp'],
            ['POST', '#^whatsapp/messages$#', 'sendWhatsapp'], ['GET', '#^whatsapp/messages/([\w-]+)$#', 'getMessage'], ['GET', '#^whatsapp/numbers$#', 'waNumbers'],
            ['POST', '#^verify/checks$#', 'verifyCheck'], ['GET', '#^verify/checks/([\w-]+)$#', 'getMessage'],
            ['POST', '#^voice/calls$#', 'voiceCall'], ['GET', '#^voice/calls/([\w-]+)$#', 'getMessage'],
            ['POST', '#^ai/chat$#', 'aiChat'], ['GET', '#^ai/models$#', 'aiModels'], ['POST', '#^ai/agents/([\w-]+)/messages$#', 'aiAgent'],
            ['POST', '#^desk/tickets$#', 'deskCreate'], ['GET', '#^desk/tickets$#', 'deskList'], ['POST', '#^desk/tickets/(\d+)/replies$#', 'deskReply'],
        ];
        $matchedPath = false;
        foreach ($routes as [$m, $re, $fn]) {
            if (preg_match($re, $path, $mm)) {
                $matchedPath = true;
                if ($m === $method) return self::$fn(...array_slice($mm, 1));
            }
        }
        throw $matchedPath ? new ApiError(405, 'method_not_allowed', "$method is not supported here.") : new ApiError(404, 'not_found', 'No such endpoint. See https://www.seageek.co.za/docs');
    }

    // ---------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------

    private static function p(string $key, bool $required = false)
    {
        $v = self::$ctx['body'][$key] ?? null;
        if ($required && ($v === null || $v === '' || $v === [])) throw new ApiError(422, 'missing_parameter', "$key is required.");
        return $v;
    }

    public static function phone(string $n): ?string
    {
        $d = preg_replace('/[\s()-]/', '', $n);
        if (preg_match('/^0(\d{9})$/', $d, $m)) return '+27' . $m[1];
        if (preg_match('/^27(\d{9})$/', $d, $m)) return '+27' . $m[1];
        if (preg_match('/^\+\d{8,15}$/', $d)) return $d;
        return null;
    }

    public static function segments(string $text): int
    {
        $gsm = preg_match('/^[\x{0020}-\x{007E}\x{00A1}\x{00A3}-\x{00A5}\x{00A7}\x{00BF}\x{00C4}-\x{00C6}\x{00C9}\x{00D1}\x{00D6}\x{00D8}\x{00DC}\x{00DF}\x{00E0}\x{00E4}-\x{00E9}\x{00EC}\x{00F1}\x{00F2}\x{00F6}\x{00F8}\x{00F9}\x{00FC}\x{0394}\x{03A6}\x{0393}\x{039B}\x{03A9}\x{03A0}\x{03A8}\x{03A3}\x{0398}\x{039E}\n\r]*$/u', $text) === 1;
        $len = mb_strlen($text) + ($gsm ? preg_match_all('/[\^{}\\\\\[~\]|€]/u', $text) : 0);
        if ($gsm) return $len <= 160 ? 1 : (int) ceil($len / 153);
        return $len <= 70 ? 1 : (int) ceil($len / 67);
    }

    /** South African ID: YYMMDD SSSS C A Z, Luhn check digit. Returns details or null. */
    public static function saId(string $id): ?array
    {
        if (!preg_match('/^\d{13}$/', $id)) return null;
        $sum = 0;
        for ($i = 0; $i < 13; $i++) {
            $d = (int) $id[12 - $i];
            if ($i % 2 === 1) { $d *= 2; if ($d > 9) $d -= 9; }
            $sum += $d;
        }
        if ($sum % 10 !== 0) return null;
        $yy = (int) substr($id, 0, 2);
        $year = $yy + ($yy > (int) gmdate('y') ? 1900 : 2000);
        if (!checkdate((int) substr($id, 2, 2), (int) substr($id, 4, 2), $year)) return null;
        return ['date_of_birth' => sprintf('%04d-%s-%s', $year, substr($id, 2, 2), substr($id, 4, 2)), 'gender' => (int) substr($id, 6, 4) >= 5000 ? 'male' : 'female', 'citizen' => $id[10] === '0'];
    }

    private static function record(string $service, ?string $unit, float $qty, float $amount, float $cost, string $to, string $status, array $meta = [], ?string $reference = null): array
    {
        $pid = public_id(match ($service) { 'verify' => 'chk', default => 'msg' });
        DB::insert('messages', [
            'public_id' => $pid, 'org_id' => self::$ctx['org']['id'], 'env' => self::$ctx['env'], 'service' => $service, 'direction' => 'out',
            'unit' => $unit, 'quantity' => $qty, 'amount' => $amount, 'cost' => $cost, 'status' => $status, 'to_addr' => mb_substr($to, 0, 200),
            'reference' => $reference !== null ? mb_substr((string) $reference, 0, 120) : null, 'meta' => json_encode($meta, JSON_UNESCAPED_UNICODE),
            'created_at' => now(), 'updated_at' => now(),
        ]);
        return DB::one('SELECT * FROM messages WHERE public_id = ?', [$pid]);
    }

    private static function charge(float $amount, string $ref, string $desc): void
    {
        if (self::$ctx['env'] === 'live' && $amount > 0) Billing::charge((int) self::$ctx['org']['id'], $amount, 'usage', $ref, $desc);
    }

    public static function present(array $m): array
    {
        $meta = json_decode((string) $m['meta'], true) ?: [];
        unset($meta['payload']);
        return array_filter([
            'id' => $m['public_id'], 'service' => $m['service'], 'direction' => $m['direction'], 'status' => $m['status'], 'to' => $m['to_addr'],
            'from' => $m['from_addr'], 'amount' => round((float) $m['amount'], 4), 'currency' => 'ZAR', 'reference' => $m['reference'],
            'error' => $m['error'], 'environment' => $m['env'] === 'live' ? 'live' : 'sandbox', 'meta' => $meta ?: null,
            'created_at' => gmdate('c', strtotime($m['created_at'] . ' UTC')), 'updated_at' => gmdate('c', strtotime($m['updated_at'] . ' UTC')),
        ], fn($v) => $v !== null);
    }

    /**
     * Send one recorded message through partners (live) or the simulator (sandbox).
     * On failure the customer is refunded automatically.
     */
    public static function dispatch(array $msg): array
    {
        if ($msg['env'] !== 'live') {
            DB::update('messages', ['status' => 'sent', 'updated_at' => now()], 'id = ?', [$msg['id']]);
            return DB::one('SELECT * FROM messages WHERE id = ?', [$msg['id']]);
        }
        $meta = json_decode((string) $msg['meta'], true) ?: [];
        $payload = ($meta['payload'] ?? []) + ['id' => $msg['public_id'], 'reference' => (string) $msg['reference']];
        if (!empty($meta['number_id'])) {
            $num = DB::one('SELECT * FROM wa_numbers WHERE id = ?', [$meta['number_id']]);
            $payload['channel_key'] = $num ? Crypto::decrypt($num['channel_key_enc']) : '';
            $partner = $num && $num['partner_id'] ? DB::one('SELECT * FROM partners WHERE id = ?', [$num['partner_id']]) : null;
            if ($partner) {
                $r = Adapters::send($partner, 'whatsapp', $payload);
                $res = $r['ok'] ? ['ok' => true, 'partner' => $partner, 'external_id' => $r['external_id'] ?? null, 'error' => null] : ['ok' => false, 'partner' => $partner, 'error' => $r['error'] ?? 'failed'];
                $r['ok'] ? Partners::markOk($partner) : Partners::markFail($partner, (string) $res['error']);
            } else {
                $res = Partners::dispatch('whatsapp', $payload);
            }
        } else {
            $res = Partners::dispatch($msg['service'] === 'auth' ? (string) ($meta['channel_service'] ?? 'sms') : $msg['service'], $payload);
        }
        if ($res['ok']) {
            DB::update('messages', ['status' => 'sent', 'partner_id' => $res['partner']['id'], 'external_id' => $res['external_id'], 'updated_at' => now()], 'id = ?', [$msg['id']]);
        } else {
            DB::update('messages', ['status' => 'failed', 'error' => mb_substr((string) $res['error'], 0, 500), 'updated_at' => now()], 'id = ?', [$msg['id']]);
            if ((float) $msg['amount'] > 0) Billing::credit((int) $msg['org_id'], (float) $msg['amount'], 'refund', $msg['public_id'], 'Refund: message could not be sent');
            Webhooks::queue((int) $msg['org_id'], 'message.failed', self::present(DB::one('SELECT * FROM messages WHERE id = ?', [$msg['id']])));
        }
        return DB::one('SELECT * FROM messages WHERE id = ?', [$msg['id']]);
    }

    /** Large batches and scheduled sends are queued and sent here (cron or a worker). */
    public static function processQueue(int $limit = 500): int
    {
        $n = 0;
        foreach (DB::all("SELECT * FROM messages WHERE status = 'queued' AND env = 'live' AND service IN ('sms','mail','whatsapp','voice') ORDER BY id LIMIT " . $limit) as $m) {
            $meta = json_decode((string) $m['meta'], true) ?: [];
            if (!empty($meta['send_at']) && $meta['send_at'] > now()) continue;
            self::dispatch($m);
            $n++;
        }
        return $n;
    }

    /** Sandbox messages move through realistic statuses so customers can test webhooks. */
    public static function advanceSimulated(): int
    {
        $n = 0;
        foreach (DB::all("SELECT * FROM messages WHERE env = 'test' AND status IN ('queued','sent') AND created_at <= ? LIMIT 500", [ts('-3 seconds')]) as $m) {
            $fail = str_ends_with((string) $m['to_addr'], '0000') || str_ends_with((string) $m['to_addr'], '@bounce.test');
            $status = $fail ? 'failed' : ($m['service'] === 'whatsapp' ? 'read' : ($m['service'] === 'voice' ? 'completed' : 'delivered'));
            $upd = ['status' => $status, 'updated_at' => now(), 'error' => $fail ? 'undeliverable' : null];
            if ($m['service'] === 'voice') $upd['meta'] = json_encode((json_decode((string) $m['meta'], true) ?: []) + ['duration_seconds' => 20]);
            DB::update('messages', $upd, 'id = ?', [$m['id']]);
            $fresh = DB::one('SELECT * FROM messages WHERE id = ?', [$m['id']]);
            Webhooks::queue((int) $m['org_id'], $fail ? 'message.failed' : ($status === 'read' ? 'message.read' : 'message.delivered'), self::present($fresh));
            if ($m['service'] === 'whatsapp' && $m['to_addr'] === '+27000000001' && !$fail) {
                $in = public_id('msg');
                DB::insert('messages', ['public_id' => $in, 'org_id' => $m['org_id'], 'env' => 'test', 'service' => 'whatsapp', 'direction' => 'in', 'status' => 'received', 'from_addr' => '+27000000001', 'to_addr' => 'sandbox', 'meta' => json_encode(['text' => 'Thanks! This is a simulated reply.']), 'created_at' => now(), 'updated_at' => now()]);
                Webhooks::queue((int) $m['org_id'], 'whatsapp.inbound', ['id' => $in, 'from' => '+27000000001', 'text' => 'Thanks! This is a simulated reply.']);
            }
            $n++;
        }
        return $n;
    }

    // ---------------------------------------------------------------
    // Platform
    // ---------------------------------------------------------------

    private static function account(): array
    {
        $o = self::$ctx['org'];
        $p = self::$ctx['plan'];
        return [200, ['id' => (int) $o['id'], 'name' => $o['name'], 'environment' => self::$ctx['env'] === 'live' ? 'live' : 'sandbox', 'status' => $o['status'], 'plan' => $p['name'],
            'limits' => ['requests_per_second' => (int) $p['api_rps'], 'ai_requests_per_minute' => (int) $p['ai_rpm'], 'ai_max_tokens' => (int) $p['ai_max_tokens'], 'ai_monthly_cap' => Billing::aiCap($o)]]];
    }

    private static function balance(): array
    {
        $o = self::$ctx['org'];
        return [200, ['balance' => round((float) $o['balance'], 2), 'credit_limit' => (float) $o['credit_limit'], 'currency' => 'ZAR', 'ai_spent_this_month' => round(Billing::aiSpentThisMonth((int) $o['id']), 2), 'ai_monthly_cap' => Billing::aiCap($o)]];
    }

    private static function usage(): array
    {
        $where = ['org_id = ?', 'env = ?'];
        $args = [self::$ctx['org']['id'], self::$ctx['env']];
        if ($s = $_GET['service'] ?? null) { $where[] = 'service = ?'; $args[] = $s; }
        if (($f = $_GET['from'] ?? null) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $f)) { $where[] = 'created_at >= ?'; $args[] = "$f 00:00:00"; }
        if (($t = $_GET['to'] ?? null) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $t)) { $where[] = 'created_at <= ?'; $args[] = "$t 23:59:59"; }
        $limit = max(1, min(500, (int) ($_GET['limit'] ?? 100)));
        $rows = DB::all('SELECT * FROM messages WHERE ' . implode(' AND ', $where) . " ORDER BY id DESC LIMIT $limit", $args);
        return [200, ['data' => array_map([self::class, 'present'], $rows), 'total_amount' => round(array_sum(array_column($rows, 'amount')), 4)]];
    }

    private static function getMessage(string $id): array
    {
        $m = DB::one('SELECT * FROM messages WHERE public_id = ? AND org_id = ?', [$id, self::$ctx['org']['id']]);
        if (!$m) throw new ApiError(404, 'not_found', 'No message with that ID on this account.');
        if ($m['env'] === 'test' && in_array($m['status'], ['queued', 'sent'], true) && $m['created_at'] <= ts('-3 seconds')) {
            self::advanceSimulated();
            $m = DB::one('SELECT * FROM messages WHERE id = ?', [$m['id']]);
        }
        return [200, self::present($m)];
    }

    // ---------------------------------------------------------------
    // SMS
    // ---------------------------------------------------------------

    private static function sendSms(): array
    {
        $to = (array) self::p('to', true);
        $body = (string) self::p('body', true);
        if (count($to) > 1000) throw new ApiError(422, 'too_many_recipients', 'Send to at most 1,000 numbers per request.');
        if (mb_strlen($body) > 1530) throw new ApiError(422, 'body_too_long', 'body can be at most 1,530 characters.');
        $org = self::$ctx['org'];
        $from = self::p('from') ?: ($org['sms_sender_status'] === 'approved' ? $org['sms_sender'] : null);
        if ($from !== null && self::$ctx['env'] === 'live' && ($org['sms_sender_status'] !== 'approved' || strcasecmp((string) $from, (string) $org['sms_sender']) !== 0)) {
            throw new ApiError(422, 'sender_not_approved', 'That sender ID is not approved on your account. Request it under SMS in the dashboard.');
        }
        $sendAt = self::p('schedule_at');
        if ($sendAt !== null) {
            $t = strtotime((string) $sendAt);
            if (!$t || $t < time() - 60 || $t > time() + 30 * 86400) throw new ApiError(422, 'invalid_schedule', 'schedule_at must be a time in the next 30 days.');
            $sendAt = gmdate('Y-m-d H:i:s', $t);
        }
        $numbers = [];
        foreach ($to as $n) {
            $norm = self::phone((string) $n);
            if (!$norm) throw new ApiError(422, 'invalid_number', "\"$n\" is not a valid phone number. Use +27821234567.");
            $numbers[$norm] = true;
        }
        $seg = self::segments($body);
        $rate = Billing::price($org, 'sms');
        $each = round($rate['price'] * $seg, 4);
        $total = round($each * count($numbers), 4);
        $batch = public_id('bat');
        self::charge($total, $batch, 'SMS to ' . count($numbers) . ' recipient(s), ' . $seg . ' segment(s) each');
        $out = [];
        $sync = count($numbers) <= 10 && !$sendAt;
        foreach (array_keys($numbers) as $n) {
            $m = self::record('sms', 'sms', $seg, self::$ctx['env'] === 'live' ? $each : 0, $rate['cost'] * $seg, $n, 'queued',
                ['segments' => $seg, 'batch' => $batch, 'send_at' => $sendAt, 'payload' => ['to' => $n, 'body' => $body, 'from' => (string) $from]], self::p('reference'));
            if ($sync) $m = self::dispatch($m);
            $out[] = ['id' => $m['public_id'], 'to' => $n, 'status' => $m['status'], 'segments' => $seg, 'amount' => (float) $m['amount']] + ($m['error'] ? ['error' => $m['error']] : []);
        }
        return [202, ['data' => $out, 'total_amount' => self::$ctx['env'] === 'live' ? $total : 0, 'currency' => 'ZAR']];
    }

    // ---------------------------------------------------------------
    // Mail
    // ---------------------------------------------------------------

    private static function sendMail(): array
    {
        $to = (array) self::p('to', true);
        $subject = (string) self::p('subject', true);
        $html = (string) (self::p('html') ?? '');
        $text = (string) (self::p('text') ?? '');
        if ($html === '' && $text === '') throw new ApiError(422, 'missing_parameter', 'Send html or text.');
        if (count($to) > 50) throw new ApiError(422, 'too_many_recipients', 'Send to at most 50 addresses per request.');
        $org = self::$ctx['org'];
        $fromEmail = (string) (self::p('from_email') ?? '');
        if ($fromEmail !== '') {
            $domain = strtolower(substr(strrchr($fromEmail, '@') ?: '', 1));
            if ($org['mail_domain_status'] !== 'verified' || $domain !== strtolower((string) $org['mail_domain'])) {
                throw new ApiError(422, 'domain_not_verified', 'from_email must be on your verified domain. Verify a domain under Mail in the dashboard.');
            }
        } else {
            $fromEmail = 'no-reply@mail.seageek.co.za';
        }
        $fromName = (string) (self::p('from_name') ?: $org['name']);
        $rate = Billing::price($org, 'email');
        foreach ($to as $addr) if (!filter_var($addr, FILTER_VALIDATE_EMAIL)) throw new ApiError(422, 'invalid_email', "\"$addr\" is not a valid email address.");
        $total = round($rate['price'] * count($to), 4);
        $batch = public_id('bat');
        self::charge($total, $batch, 'Email to ' . count($to) . ' recipient(s)');
        $out = [];
        foreach ($to as $addr) {
            $m = self::record('mail', 'email', 1, self::$ctx['env'] === 'live' ? $rate['price'] : 0, $rate['cost'], strtolower($addr), 'queued', ['batch' => $batch, 'subject' => mb_substr($subject, 0, 120),
                'payload' => ['to' => [strtolower($addr)], 'subject' => $subject, 'html' => $html, 'text' => $text, 'from' => sprintf('%s <%s>', str_replace(['<', '>', '"'], '', $fromName), $fromEmail), 'from_name' => $fromName, 'from_email' => $fromEmail, 'reply_to' => (string) (self::p('reply_to') ?? '')]], self::p('reference'));
            if (count($to) <= 10) $m = self::dispatch($m);
            $out[] = ['id' => $m['public_id'], 'to' => $m['to_addr'], 'status' => $m['status'], 'amount' => (float) $m['amount']];
        }
        return [202, ['data' => $out, 'total_amount' => self::$ctx['env'] === 'live' ? $total : 0, 'currency' => 'ZAR']];
    }

    // ---------------------------------------------------------------
    // Auth (OTP)
    // ---------------------------------------------------------------

    private static function sendOtp(): array
    {
        $channel = (string) self::p('channel', true);
        if (!in_array($channel, ['sms', 'email', 'whatsapp', 'voice'], true)) throw new ApiError(422, 'invalid_channel', 'channel must be sms, email, whatsapp or voice.');
        $to = (string) self::p('to', true);
        $to = $channel === 'email' ? (filter_var($to, FILTER_VALIDATE_EMAIL) ? strtolower($to) : null) : self::phone($to);
        if (!$to) throw new ApiError(422, 'invalid_recipient', 'to is not a valid ' . ($channel === 'email' ? 'email address' : 'phone number') . '.');
        $len = max(4, min(8, (int) (self::p('length') ?? 6)));
        $ttl = max(60, min(1800, (int) (self::p('ttl') ?? 600)));
        $org = self::$ctx['org'];
        if (rate_limited('otp:' . $org['id'] . ':' . $to, 5, 600)) throw new ApiError(429, 'too_many_codes', 'Too many codes sent to this recipient. Wait 10 minutes.');
        $brand = mb_substr((string) (self::p('brand') ?: $org['name']), 0, 30);
        $sandbox = self::$ctx['env'] !== 'live';
        $code = $sandbox ? str_repeat('0', $len) : str_pad((string) random_int(0, 10 ** $len - 1), $len, '0', STR_PAD_LEFT);
        $text = "Your $brand code is $code. It expires in " . (int) ceil($ttl / 60) . ' minutes. Never share it.';
        $rate = Billing::price($org, 'otp_' . $channel);
        $pid = public_id('otp');
        self::charge($rate['price'], $pid, 'OTP by ' . $channel);
        DB::insert('otp_codes', ['public_id' => $pid, 'org_id' => $org['id'], 'env' => self::$ctx['env'], 'channel' => $channel, 'to_addr' => $to, 'code_hash' => hash('sha256', $pid . $code), 'status' => 'pending', 'expires_at' => gmdate('Y-m-d H:i:s', time() + $ttl), 'created_at' => now()]);
        $payload = match ($channel) {
            'email' => ['to' => [$to], 'subject' => "$brand verification code", 'text' => $text, 'html' => '<p>' . e($text) . '</p>', 'from' => "$brand <no-reply@mail.seageek.co.za>"],
            'whatsapp' => ['to' => $to, 'type' => 'template', 'template' => ['name' => 'otp_code', 'language' => 'en', 'components' => [['type' => 'body', 'parameters' => [['type' => 'text', 'text' => $code]]], ['type' => 'button', 'sub_type' => 'url', 'index' => '0', 'parameters' => [['type' => 'text', 'text' => $code]]]]]],
            'voice' => ['to' => $to, 'text' => "Your $brand code is " . implode(', ', str_split($code)) . '.', 'repeat' => 2],
            default => ['to' => $to, 'body' => $text, 'from' => $org['sms_sender_status'] === 'approved' ? (string) $org['sms_sender'] : ''],
        };
        $m = self::record('auth', 'otp_' . $channel, 1, $sandbox ? 0 : $rate['price'], $rate['cost'], $to, 'queued', ['otp_id' => $pid, 'channel_service' => $channel === 'email' ? 'mail' : $channel, 'payload' => $payload]);
        $m = self::dispatch($m);
        if ($m['status'] === 'failed') DB::update('otp_codes', ['status' => 'failed'], 'public_id = ?', [$pid]);
        return [202, array_filter(['id' => $pid, 'status' => $m['status'] === 'failed' ? 'failed' : 'pending', 'channel' => $channel, 'expires_at' => gmdate('c', time() + $ttl), 'amount' => $sandbox ? 0 : $rate['price'], 'sandbox_code' => $sandbox ? $code : null], fn($v) => $v !== null)];
    }

    private static function checkOtp(string $id): array
    {
        $code = (string) self::p('code', true);
        $otp = DB::one('SELECT * FROM otp_codes WHERE public_id = ? AND org_id = ?', [$id, self::$ctx['org']['id']]);
        if (!$otp) throw new ApiError(404, 'not_found', 'No verification with that ID.');
        if ($otp['status'] === 'approved') return [200, ['id' => $id, 'valid' => false, 'status' => 'already_used']];
        if ($otp['status'] !== 'pending') return [200, ['id' => $id, 'valid' => false, 'status' => $otp['status']]];
        if ($otp['expires_at'] < now()) { DB::update('otp_codes', ['status' => 'expired'], 'id = ?', [$otp['id']]); return [200, ['id' => $id, 'valid' => false, 'status' => 'expired']]; }
        if (hash_equals($otp['code_hash'], hash('sha256', $id . $code))) {
            DB::update('otp_codes', ['status' => 'approved'], 'id = ?', [$otp['id']]);
            return [200, ['id' => $id, 'valid' => true, 'status' => 'approved']];
        }
        $attempts = (int) $otp['attempts'] + 1;
        DB::update('otp_codes', ['attempts' => $attempts, 'status' => $attempts >= 5 ? 'locked' : 'pending'], 'id = ?', [$otp['id']]);
        return [200, ['id' => $id, 'valid' => false, 'status' => $attempts >= 5 ? 'locked' : 'incorrect', 'attempts_left' => max(0, 5 - $attempts)]];
    }

    // ---------------------------------------------------------------
    // WhatsApp
    // ---------------------------------------------------------------

    private static function waNumbers(): array
    {
        $rows = DB::all('SELECT id, phone, display_name, status FROM wa_numbers WHERE org_id = ? ORDER BY id', [self::$ctx['org']['id']]);
        return [200, ['data' => array_map(fn($r) => ['id' => (int) $r['id']] + $r, $rows)]];
    }

    private static function sendWhatsapp(): array
    {
        $to = self::phone((string) self::p('to', true));
        if (!$to) throw new ApiError(422, 'invalid_number', 'to is not a valid phone number.');
        $type = (string) self::p('type', true);
        $org = self::$ctx['org'];
        $live = self::$ctx['env'] === 'live';
        $number = null;
        if ($live) {
            $nid = self::p('number_id');
            $number = $nid ? DB::one("SELECT * FROM wa_numbers WHERE id = ? AND org_id = ? AND status = 'active'", [$nid, $org['id']])
                : DB::one("SELECT * FROM wa_numbers WHERE org_id = ? AND status = 'active' ORDER BY id LIMIT 1", [$org['id']]);
            if (!$number) throw new ApiError(422, 'no_whatsapp_number', 'You have no active WhatsApp number. Connect one under WhatsApp in the dashboard.');
        }
        if ($type === 'template') {
            $tpl = self::p('template', true);
            if (!is_array($tpl) || empty($tpl['name'])) throw new ApiError(422, 'invalid_template', 'template.name is required.');
            $cat = (string) self::p('category', true);
            if (!in_array($cat, ['marketing', 'utility', 'authentication'], true)) throw new ApiError(422, 'invalid_category', 'category must be marketing, utility or authentication.');
            $unit = 'wa_' . $cat;
            $payload = ['to' => $to, 'type' => 'template', 'template' => $tpl];
        } elseif ($type === 'text') {
            $text = (string) self::p('text', true);
            if ($live) {
                $window = DB::value("SELECT MAX(created_at) FROM messages WHERE org_id = ? AND service = 'whatsapp' AND direction = 'in' AND from_addr = ?", [$org['id'], $to]);
                if (!$window || $window < ts('-24 hours')) throw new ApiError(422, 'outside_service_window', 'Free-form messages can only be sent within 24 hours of the customer\'s last message. Send an approved template instead.');
            }
            $unit = 'wa_service';
            $payload = ['to' => $to, 'type' => 'text', 'text' => $text];
        } else {
            throw new ApiError(422, 'invalid_type', 'type must be template or text.');
        }
        $rate = Billing::price($org, $unit);
        $pid = public_id('msg');
        self::charge($rate['price'], $pid, $rate['label']);
        $m = self::record('whatsapp', $unit, 1, $live ? $rate['price'] : 0, $rate['cost'], $to, 'queued', ['number_id' => $number['id'] ?? null, 'payload' => $payload], self::p('reference'));
        DB::update('messages', ['from_addr' => $number['phone'] ?? 'sandbox'], 'id = ?', [$m['id']]);
        $m = self::dispatch($m);
        return [202, ['id' => $m['public_id'], 'status' => $m['status'], 'amount' => (float) $m['amount'], 'currency' => 'ZAR'] + ($m['error'] ? ['error' => $m['error']] : [])];
    }

    // ---------------------------------------------------------------
    // Verify
    // ---------------------------------------------------------------

    private static function verifyCheck(): array
    {
        $type = (string) self::p('type', true);
        $map = ['id' => 'verify_id', 'id_photo' => 'verify_id_photo', 'pep' => 'verify_pep', 'business' => 'verify_business', 'bank' => 'verify_bank'];
        if (!isset($map[$type])) throw new ApiError(422, 'invalid_type', 'type must be id, id_photo, pep, business or bank.');
        $org = self::$ctx['org'];
        $live = self::$ctx['env'] === 'live';
        if ($live && $org['kyb_status'] !== 'approved') throw new ApiError(403, 'kyb_required', 'Live identity checks need an approved business verification. Submit it under Verify in the dashboard.');
        $idInfo = null;
        if (in_array($type, ['id', 'id_photo', 'pep', 'bank'], true)) {
            $idn = preg_replace('/\D/', '', (string) self::p('id_number', true));
            $idInfo = self::saId($idn);
            if (!$idInfo) throw new ApiError(422, 'invalid_id_number', 'That is not a valid South African ID number (date or check digit is wrong). You were not charged.');
        }
        if ($type === 'pep' && (!self::p('first_name') || !self::p('last_name'))) throw new ApiError(422, 'missing_parameter', 'first_name and last_name are required for pep.');
        if ($type === 'id_photo' && !self::p('selfie')) throw new ApiError(422, 'missing_parameter', 'selfie is required for id_photo.');
        if ($type === 'business' && !preg_match('#^\d{4}/\d{6}/\d{2}$#', (string) self::p('company_reg', true))) throw new ApiError(422, 'invalid_company_reg', 'company_reg must look like 2027/123456/07.');
        if ($type === 'bank' && (!self::p('account_number') || !self::p('branch_code'))) throw new ApiError(422, 'missing_parameter', 'account_number and branch_code are required for bank.');

        $rate = Billing::price($org, $map[$type]);
        $pid = public_id('chk');
        self::charge($rate['price'], $pid, $rate['label']);
        $params = array_intersect_key(self::$ctx['body'], array_flip(['id_number', 'first_name', 'last_name', 'company_reg', 'account_number', 'branch_code', 'selfie']));
        if (!$live) {
            $result = match ($type) {
                'pep' => ['hit' => strcasecmp((string) self::p('last_name'), 'Testpep') === 0, 'lists_checked' => ['UN', 'OFAC', 'EU', 'SA domestic PEP']],
                'business' => ['found' => true, 'name' => 'Sandbox Trading (Pty) Ltd', 'status' => 'In business', 'registration_date' => '2019-04-11'],
                'bank' => ['account_exists' => true, 'id_matches' => true, 'account_open' => true, 'accepts_debits' => true],
                default => ['match' => !str_starts_with((string) self::p('id_number'), '00'), 'deceased' => false] + $idInfo + ($type === 'id_photo' ? ['face_match_score' => 0.96] : []),
            };
            $m = self::record('verify', $map[$type], 1, 0, 0, (string) ($params['id_number'] ?? $params['company_reg'] ?? ''), 'completed', ['type' => $type, 'result' => $result], self::p('reference'));
            return [200, ['id' => $m['public_id'], 'type' => $type, 'status' => 'completed', 'result' => $result, 'amount' => 0]];
        }
        $res = Partners::dispatch('verify', ['type' => $type, 'id' => $pid] + array_map('strval', $params));
        $result = $res['ok'] ? ($res['data'] + ($idInfo ? ['date_of_birth' => $idInfo['date_of_birth']] : [])) : null;
        $m = self::record('verify', $map[$type], 1, $res['ok'] ? $rate['price'] : 0, $rate['cost'], (string) ($params['id_number'] ?? $params['company_reg'] ?? ''), $res['ok'] ? 'completed' : 'failed', ['type' => $type, 'result' => $result], self::p('reference'));
        if (!$res['ok']) {
            Billing::credit((int) $org['id'], $rate['price'], 'refund', $pid, 'Refund: check could not be completed');
            throw new ApiError(502, 'check_failed', 'The check could not be completed right now. You were not charged. Try again shortly.');
        }
        DB::update('messages', ['partner_id' => $res['partner']['id'], 'external_id' => $res['external_id']], 'id = ?', [$m['id']]);
        Webhooks::queue((int) $org['id'], 'verify.completed', self::present($m));
        return [200, ['id' => $m['public_id'], 'type' => $type, 'status' => 'completed', 'result' => $result, 'amount' => $rate['price']]];
    }

    // ---------------------------------------------------------------
    // Voice
    // ---------------------------------------------------------------

    private static function voiceCall(): array
    {
        $to = self::phone((string) self::p('to', true));
        if (!$to) throw new ApiError(422, 'invalid_number', 'to is not a valid phone number.');
        $text = (string) self::p('text', true);
        if (mb_strlen($text) > 1000) throw new ApiError(422, 'text_too_long', 'text can be at most 1,000 characters.');
        $org = self::$ctx['org'];
        $rate = Billing::price($org, 'voice_minute');
        $pid = public_id('msg');
        self::charge($rate['price'], $pid, 'Voice call (first minute)');
        $m = self::record('voice', 'voice_minute', 1, self::$ctx['env'] === 'live' ? $rate['price'] : 0, $rate['cost'], $to, 'queued',
            ['payload' => ['to' => $to, 'text' => $text, 'language' => (string) (self::p('language') ?: 'en-ZA'), 'repeat' => max(1, min(3, (int) (self::p('repeat') ?? 2)))]], self::p('reference'));
        $m = self::dispatch($m);
        return [202, ['id' => $m['public_id'], 'status' => $m['status'], 'amount' => (float) $m['amount'], 'currency' => 'ZAR']];
    }

    // ---------------------------------------------------------------
    // AI
    // ---------------------------------------------------------------

    private static function aiModels(): array
    {
        $out = [];
        foreach (Catalog::aiModels() as $m) {
            $p = Catalog::aiPrice($m);
            $out[] = ['provider' => $m['provider'], 'model' => $m['model'], 'name' => $m['label'], 'price_per_million' => ['input' => $p['in'], 'output' => $p['out']], 'currency' => 'ZAR'];
        }
        return [200, ['data' => $out]];
    }

    private static function aiChat(): array
    {
        $messages = self::p('messages', true);
        if (!is_array($messages) || !$messages) throw new ApiError(422, 'invalid_messages', 'messages must be a non-empty array.');
        $clean = [];
        foreach ($messages as $m) {
            if (!is_array($m) || !in_array($m['role'] ?? '', ['user', 'assistant'], true) || !is_string($m['content'] ?? null)) {
                throw new ApiError(422, 'invalid_messages', 'Each message needs role ("user" or "assistant") and string content.');
            }
            $clean[] = ['role' => $m['role'], 'content' => $m['content']];
        }
        if ($clean[0]['role'] !== 'user') throw new ApiError(422, 'invalid_messages', 'The first message must have role "user".');
        $r = Ai::meteredChat(self::$ctx['org'], self::$ctx['env'], (string) self::p('provider', true), (string) self::p('model', true), (string) (self::p('system') ?? ''), $clean, self::p('max_tokens') !== null ? (int) self::p('max_tokens') : null);
        return [200, ['id' => $r['id'], 'provider' => self::p('provider'), 'model' => $r['model'], 'content' => $r['text'],
            'usage' => ['input_tokens' => $r['input_tokens'], 'output_tokens' => $r['output_tokens']], 'amount' => $r['amount'], 'currency' => 'ZAR',
            'limits' => ['month_spent' => round($r['spent'], 2), 'month_cap' => $r['cap']]]];
    }

    private static function aiAgent(string $agentId): array
    {
        $org = self::$ctx['org'];
        $agent = DB::one('SELECT * FROM ai_agents WHERE public_id = ? AND org_id = ? AND active = 1', [$agentId, $org['id']]);
        if (!$agent) throw new ApiError(404, 'not_found', 'No active agent with that ID.');
        $text = trim((string) self::p('message', true));
        $conv = (string) (self::p('conversation_id') ?? '');
        $sandbox = self::$ctx['env'] !== 'live';
        if ($conv !== '') {
            $t = DB::one('SELECT * FROM tickets WHERE token = ? AND org_id = ?', [preg_replace('/^tkt_/', '', $conv), $org['id']]);
            if (!$t) throw new ApiError(404, 'not_found', 'Unknown conversation_id.');
            Desk::addMessage((int) $t['id'], 'customer', $text);
        } else {
            $cust = (array) (self::p('customer') ?? []);
            $t = Desk::createTicket((int) $org['id'], mb_substr($text, 0, 80), $text, 'api', $cust, 'normal', ['ai-agent'], $sandbox);
        }
        $t = Desk::ticket((int) $t['id']);
        $res = $t['ai_active'] ? Desk::aiRespond($t, self::$ctx['env']) : ['reply' => null, 'handover' => true];
        return [200, ['conversation_id' => 'tkt_' . $t['token'], 'reply' => $res['reply'], 'handover' => (bool) $res['handover'], 'ticket' => (int) $t['number']]];
    }

    // ---------------------------------------------------------------
    // Desk
    // ---------------------------------------------------------------

    private static function deskCreate(): array
    {
        $req = self::p('requester', true);
        if (!is_array($req) || !filter_var($req['email'] ?? '', FILTER_VALIDATE_EMAIL)) throw new ApiError(422, 'invalid_requester', 'requester.email must be a valid email address.');
        $t = Desk::createTicket((int) self::$ctx['org']['id'], (string) self::p('subject', true), (string) self::p('body', true), 'api', $req, (string) (self::p('priority') ?? 'normal'), (array) (self::p('tags') ?? []), self::$ctx['env'] !== 'live');
        if ($t['ai_active']) Desk::aiRespond($t, self::$ctx['env']);
        return [201, Desk::publicTicket(Desk::ticket((int) $t['id']))];
    }

    private static function deskList(): array
    {
        $args = [self::$ctx['org']['id']];
        $where = 'org_id = ?';
        if (($s = $_GET['status'] ?? null) && in_array($s, Desk::STATUSES, true)) { $where .= ' AND status = ?'; $args[] = $s; }
        $rows = DB::all("SELECT * FROM tickets WHERE $where ORDER BY updated_at DESC LIMIT 100", $args);
        return [200, ['data' => array_map([Desk::class, 'publicTicket'], $rows)]];
    }

    private static function deskReply(string $number): array
    {
        $t = DB::one('SELECT * FROM tickets WHERE org_id = ? AND number = ?', [self::$ctx['org']['id'], (int) $number]);
        if (!$t) throw new ApiError(404, 'not_found', 'No ticket with that number.');
        $owner = DB::value("SELECT id FROM users WHERE org_id = ? ORDER BY id LIMIT 1", [self::$ctx['org']['id']]);
        Desk::agentReply($t, (int) $owner, (string) self::p('body', true), (bool) self::p('internal'), self::p('status'));
        return [200, Desk::publicTicket(Desk::ticket((int) $t['id']))];
    }
}
