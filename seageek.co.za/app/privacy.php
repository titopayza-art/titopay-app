<?php
/**
 * Protecting company data: private details are removed before anything reaches an AI model,
 * a company can switch AI off for its data, old conversations are deleted on schedule,
 * and a company can download everything it holds.
 */
declare(strict_types=1);

final class Privacy
{
    /** Keys whose values are identifiers or types, never customer content. */
    private const SKIP_KEYS = ['id', 'type', 'name', 'role', 'signature', 'tool_use_id', 'toolUseID', 'tool_call_id', 'model', 'status', 'stop_reason', 'media_type'];

    private static function luhn(string $digits): bool
    {
        $sum = 0; $alt = false;
        for ($i = strlen($digits) - 1; $i >= 0; $i--) {
            $n = (int) $digits[$i];
            if ($alt) { $n *= 2; if ($n > 9) $n -= 9; }
            $sum += $n; $alt = !$alt;
        }
        return $sum % 10 === 0;
    }

    /** South African ID number: date of birth, a sex/serial part, a citizenship digit, and a checksum. */
    private static function saId(string $digits): bool
    {
        if (strlen($digits) !== 13) return false;
        $mm = (int) substr($digits, 2, 2); $dd = (int) substr($digits, 4, 2);
        return $mm >= 1 && $mm <= 12 && $dd >= 1 && $dd <= 31 && self::luhn($digits);
    }

    /** Returns the text with card numbers, ID numbers, bank account numbers and secret keys removed, and how many were removed. */
    public static function mask(string $text): array
    {
        $n = 0;
        $text = preg_replace_callback('/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/', function ($m) use (&$n) {
            $digits = preg_replace('/\D/', '', $m[0]);
            if (strlen($digits) >= 13 && strlen($digits) <= 19 && self::luhn($digits)) {
                if (strlen($digits) === 13 && self::saId($digits)) { $n++; return '[ID number removed]'; }
                if (strlen($digits) >= 13) { $n++; return '[card number removed]'; }
            }
            return $m[0];
        }, $text, -1, $c1);
        $text = preg_replace_callback('/(?<!\d)\d{13}(?!\d)/', function ($m) use (&$n) {
            if (self::saId($m[0])) { $n++; return '[ID number removed]'; }
            return $m[0];
        }, $text);
        $text = preg_replace_callback('/\b(account(?:\s+number|\s+no\.?)?|acc(?:ount)?\s*#)\s*[:#]?\s*(\d[\d ]{6,13}\d)/i', function ($m) use (&$n) {
            $n++; return $m[1] . ' [account number removed]';
        }, $text);
        $text = preg_replace_callback('/\b(sk_(?:live|test)_[A-Za-z0-9]{8,}|sg_(?:live|test)_[A-Za-z0-9_\-]{8,}|sgp_[A-Za-z0-9_\-]{8,})\b/', function () use (&$n) {
            $n++; return '[key removed]';
        }, $text);
        $text = preg_replace_callback('/\b(password|passcode|pin|pwd)\s*(is|:|=)\s*\S+/i', function ($m) use (&$n) {
            $n++; return $m[1] . ' ' . $m[2] . ' [removed]';
        }, $text);
        return [$text, $n];
    }

    /** Every text in a conversation payload, masked. Tool names, ids and similar fields are left alone. */
    public static function maskPayload($value, string $key = '')
    {
        if (is_string($value)) {
            if (in_array($key, self::SKIP_KEYS, true)) return $value;
            return self::mask($value)[0];
        }
        if (is_array($value)) {
            $out = [];
            foreach ($value as $k => $v) $out[$k] = self::maskPayload($v, is_string($k) ? $k : $key);
            return $out;
        }
        // SDK content blocks (objects) are passed through untouched.
        return $value;
    }

    /** Whether this company lets its messages go to an AI model at all. */
    public static function aiAllowed(array $org): bool
    {
        return !empty($org['is_house']) || (int) ($org['ai_data_allowed'] ?? 1) === 1;
    }

    /**
     * Delete conversations and uploads older than the company's retention period.
     * Only closed or solved tickets and finished assistant chats are removed; open work is never deleted.
     */
    public static function purge(array $org): array
    {
        $days = (int) ($org['retention_days'] ?? 0);
        if ($days <= 0) return [];
        $cut = ts("-$days days");
        $out = ['tickets' => 0, 'files' => 0, 'chats' => 0, 'form_entries' => 0];
        foreach (DB::all("SELECT id FROM tickets WHERE org_id = ? AND status IN ('solved','closed') AND updated_at < ?", [$org['id'], $cut]) as $t) {
            foreach (DB::all('SELECT * FROM ticket_attachments WHERE ticket_id = ?', [$t['id']]) as $a) {
                $p = STORAGE . '/' . $a['path'];
                if (is_file($p)) { @unlink($p); $out['files']++; }
                DB::run('DELETE FROM ticket_attachments WHERE id = ?', [$a['id']]);
            }
            DB::run('DELETE FROM ticket_messages WHERE ticket_id = ?', [$t['id']]);
            DB::run('DELETE FROM desk_presence WHERE ticket_id = ?', [$t['id']]);
            DB::run('DELETE FROM tickets WHERE id = ?', [$t['id']]);
            $out['tickets']++;
        }
        foreach (DB::all('SELECT c.id FROM assistant_chats c JOIN assistants a ON a.id = c.assistant_id WHERE a.org_id = ? AND c.updated_at < ?', [$org['id'], $cut]) as $c) {
            DB::run('DELETE FROM assistant_messages WHERE chat_id = ?', [$c['id']]);
            DB::run('DELETE FROM assistant_chats WHERE id = ?', [$c['id']]);
            $out['chats']++;
        }
        $out['form_entries'] = DB::run('DELETE FROM web_form_entries WHERE form_id IN (SELECT id FROM web_forms WHERE org_id = ?) AND created_at < ?', [$org['id'], $cut])->rowCount();
        return $out;
    }

    /** Scheduled: apply each company's retention once an hour. */
    public static function runAll(): int
    {
        $n = 0;
        foreach (DB::all('SELECT * FROM orgs WHERE retention_days > 0 AND is_house = 0') as $o) {
            try { $r = self::purge($o); $n += array_sum($r); }
            catch (Throwable $e) { log_line('privacy', 'Retention failed for ' . $o['slug'] . ': ' . $e->getMessage()); }
        }
        return $n;
    }

    /** Everything this company holds, as one JSON document. Passwords, API key hashes and stored secrets are never included. */
    public static function export(array $org): array
    {
        $oid = (int) $org['id'];
        $o = $org;
        foreach (['desk_settings', 'chat_settings'] as $k) unset($o[$k]);
        $data = ['exported_at' => now(), 'company' => $o, 'note' => 'Passwords, API key values and stored secrets are never included.'];
        $data['team'] = array_map(fn($u) => ['name' => $u['name'], 'email' => $u['email'], 'role' => $u['role'], 'created_at' => $u['created_at']], DB::all('SELECT name, email, role, created_at FROM users WHERE org_id = ?', [$oid]));
        $data['tickets'] = [];
        foreach (DB::all('SELECT * FROM tickets WHERE org_id = ? ORDER BY id', [$oid]) as $t) {
            $t['messages'] = DB::all('SELECT author, body, internal, created_at FROM ticket_messages WHERE ticket_id = ? ORDER BY id', [$t['id']]);
            unset($t['token']);
            $data['tickets'][] = $t;
        }
        foreach (['invoices' => 'org_id', 'payments' => 'org_id', 'ledger' => 'org_id', 'tasks' => 'org_id', 'projects' => 'org_id', 'contacts' => 'org_id', 'web_forms' => 'org_id', 'short_links' => 'org_id', 'monitors' => 'org_id', 'qr_codes' => 'org_id', 'wa_templates' => 'org_id', 'campaigns' => 'org_id'] as $tbl => $col) {
            $rows = DB::all("SELECT * FROM $tbl WHERE $col = ?", [$oid]);
            $data[$tbl] = array_map(fn($r) => array_diff_key($r, array_flip(['share_token', 'token', 'api_key_hash'])), $rows);
        }
        $data['assistants'] = [];
        foreach (DB::all('SELECT * FROM assistants WHERE org_id = ?', [$oid]) as $a) {
            unset($a['share_token']);
            $a['documents'] = DB::all('SELECT title, source, content, created_at FROM assistant_docs WHERE assistant_id = ?', [$a['id']]);
            $a['memory'] = DB::all('SELECT fact, created_at FROM assistant_memory WHERE assistant_id = ?', [$a['id']]);
            $a['chats'] = [];
            foreach (DB::all('SELECT * FROM assistant_chats WHERE assistant_id = ? ORDER BY id', [$a['id']]) as $c) {
                $c['messages'] = DB::all('SELECT role, content, created_at FROM assistant_messages WHERE chat_id = ? ORDER BY id', [$c['id']]);
                $a['chats'][] = $c;
            }
            $data['assistants'][] = $a;
        }
        $data['web_form_entries'] = DB::all('SELECT e.* FROM web_form_entries e JOIN web_forms f ON f.id = e.form_id WHERE f.org_id = ?', [$oid]);
        $data['activity'] = DB::all('SELECT action, detail, created_at, user_id FROM audit_log WHERE org_id = ? ORDER BY id', [$oid]);
        return $data;
    }
}
