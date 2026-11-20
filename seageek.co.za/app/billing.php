<?php
/**
 * Billing: prepaid credit wallet, invoices, PayFast, automatic reminders, locking and unlocking.
 * Customer webhooks and the cron runner also live here.
 */
declare(strict_types=1);

final class InsufficientFunds extends RuntimeException {}

final class Billing
{
    public static function plan(array $org): array
    {
        return DB::one('SELECT * FROM plans WHERE code = ?', [$org['plan_code']]) ?? DB::one("SELECT * FROM plans WHERE code = 'payg'");
    }

    /** Price for one unit for this organisation after its plan discount. */
    public static function price(array $org, string $unit): array
    {
        $rate = DB::one('SELECT * FROM rates WHERE unit = ?', [$unit]);
        if (!$rate) throw new RuntimeException("No rate for $unit");
        $discount = (int) self::plan($org)['discount_pct'];
        return ['price' => round((float) $rate['price'] * (100 - $discount) / 100, 4), 'cost' => (float) $rate['cost'], 'label' => $rate['label']];
    }

    public static function available(array $org): float
    {
        return (float) $org['balance'] + (float) $org['credit_limit'];
    }

    /** Debit the wallet. Throws InsufficientFunds when balance plus credit limit can't cover it. */
    public static function charge(int $orgId, float $amount, string $type, string $ref, string $description): float
    {
        if ($amount <= 0) return (float) DB::value('SELECT balance FROM orgs WHERE id = ?', [$orgId]);
        return DB::tx(function () use ($orgId, $amount, $type, $ref, $description) {
            $lock = DB::driver() === 'mysql' ? ' FOR UPDATE' : '';
            $org = DB::one("SELECT id, balance, credit_limit FROM orgs WHERE id = ?$lock", [$orgId]);
            if ((float) $org['balance'] + (float) $org['credit_limit'] < $amount) throw new InsufficientFunds('insufficient_balance');
            $after = round((float) $org['balance'] - $amount, 4);
            DB::update('orgs', ['balance' => $after], 'id = ?', [$orgId]);
            DB::insert('ledger', ['org_id' => $orgId, 'type' => $type, 'amount' => -$amount, 'balance_after' => $after, 'ref' => $ref, 'description' => mb_substr($description, 0, 255), 'created_at' => now()]);
            return $after;
        });
    }

    public static function credit(int $orgId, float $amount, string $type, string $ref, string $description): float
    {
        return DB::tx(function () use ($orgId, $amount, $type, $ref, $description) {
            $lock = DB::driver() === 'mysql' ? ' FOR UPDATE' : '';
            $bal = (float) DB::value("SELECT balance FROM orgs WHERE id = ?$lock", [$orgId]);
            $after = round($bal + $amount, 4);
            DB::update('orgs', ['balance' => $after, 'low_balance_notified' => 0], 'id = ?', [$orgId]);
            DB::insert('ledger', ['org_id' => $orgId, 'type' => $type, 'amount' => $amount, 'balance_after' => $after, 'ref' => $ref, 'description' => mb_substr($description, 0, 255), 'created_at' => now()]);
            return $after;
        });
    }

    public static function aiSpentThisMonth(int $orgId): float
    {
        return (float) DB::value("SELECT COALESCE(SUM(amount),0) FROM messages WHERE org_id = ? AND service = 'ai' AND env = 'live' AND created_at >= ?", [$orgId, gmdate('Y-m-01 00:00:00')]);
    }

    public static function aiCap(array $org): float
    {
        $planCap = (float) self::plan($org)['ai_monthly_cap'];
        $own = $org['ai_monthly_cap'] !== null ? (float) $org['ai_monthly_cap'] : null;
        return $own !== null ? min($own, $planCap) : $planCap;
    }

    // ---------------------------------------------------------------
    // Customer numbers, invoices, payments
    // ---------------------------------------------------------------

    /** A unique 6-digit customer number. It is also the account's EFT payment reference. */
    public static function newCustomerNo(): string
    {
        do {
            $n = (string) random_int(100000, 999999);
        } while (DB::one('SELECT id FROM orgs WHERE customer_no = ?', [$n]));
        return $n;
    }

    /**
     * Create an invoice. $items: list of [kind, ref, description, quantity, unit_price].
     * kind: plan | package | topup | service. Without items, one line is made from the description.
     */
    public static function createInvoice(array $org, string $kind, float $subtotal, string $description, ?string $planCode = null, array $items = []): array
    {
        if (!$items) $items = [[$kind === 'plan' ? 'plan' : 'topup', $planCode, $description, 1, $subtotal]];
        $subtotal = round(array_sum(array_map(fn($i) => (float) $i[3] * (float) $i[4], $items)), 2);
        $vat = Settings::get('vat_registered') === '1' ? round($subtotal * (float) Settings::get('vat_rate') / 100, 2) : 0.0;
        $seq = (int) DB::value('SELECT COUNT(*) FROM invoices') + 1001;
        $id = DB::insert('invoices', [
            'number' => 'SG-' . gmdate('Y') . '-' . str_pad((string) $seq, 6, '0', STR_PAD_LEFT), 'org_id' => $org['id'], 'kind' => $kind,
            'description' => mb_substr($description, 0, 255), 'subtotal' => $subtotal, 'vat' => $vat, 'total' => round($subtotal + $vat, 2), 'status' => 'unpaid',
            'plan_code' => $planCode, 'due_at' => $kind === 'plan' ? ts('+' . (int) Settings::get('invoice_due_days') . ' days') : now(), 'created_at' => now(),
        ]);
        foreach ($items as [$k, $ref, $desc, $qty, $unit]) {
            DB::insert('invoice_items', ['invoice_id' => $id, 'kind' => $k, 'ref' => $ref, 'description' => mb_substr((string) $desc, 0, 255), 'quantity' => (float) $qty, 'unit_price' => (float) $unit, 'amount' => round((float) $qty * (float) $unit, 2)]);
        }
        return DB::one('SELECT * FROM invoices WHERE id = ?', [$id]);
    }

    public static function items(int $invoiceId): array
    {
        return DB::all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [$invoiceId]);
    }

    /** Apply a payment. Idempotent: a paid invoice is never applied twice. */
    public static function markPaid(int $invoiceId, string $gateway, string $gatewayRef, float $amount, array $raw = []): bool
    {
        return DB::tx(function () use ($invoiceId, $gateway, $gatewayRef, $amount, $raw) {
            $inv = DB::one('SELECT * FROM invoices WHERE id = ?', [$invoiceId]);
            if (!$inv || $inv['status'] === 'paid') return false;
            DB::insert('payments', ['org_id' => $inv['org_id'], 'invoice_id' => $inv['id'], 'gateway' => $gateway, 'amount' => $amount, 'status' => 'complete', 'gateway_ref' => $gatewayRef, 'raw' => json_encode($raw), 'created_at' => now()]);
            DB::update('invoices', ['status' => 'paid', 'paid_at' => now()], 'id = ?', [$inv['id']]);
            $orgId = (int) $inv['org_id'];
            foreach (self::items((int) $inv['id']) as $it) {
                if ($it['kind'] === 'topup') {
                    self::credit($orgId, (float) $it['amount'], 'topup', $inv['number'], $it['description']);
                } elseif ($it['kind'] === 'package') {
                    $pkg = DB::one('SELECT * FROM packages WHERE code = ?', [$it['ref']]);
                    $credit = $pkg ? (float) $pkg['credit'] * (float) $it['quantity'] : (float) $it['amount'];
                    self::credit($orgId, $credit, 'topup', $inv['number'], 'Credit from ' . $it['description'] . ($it['quantity'] > 1 ? ' x' . (float) $it['quantity'] : ''));
                    if ($pkg) Services::activate($orgId, $pkg['service']);
                } elseif ($it['kind'] === 'plan') {
                    $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
                    $plan = DB::one('SELECT * FROM plans WHERE code = ?', [$it['ref']]);
                    if (!$plan) continue;
                    $base = ($org['plan_code'] === $plan['code'] && $org['plan_renews_at'] && $org['plan_renews_at'] > now()) ? $org['plan_renews_at'] : now();
                    DB::update('orgs', ['plan_code' => $plan['code'], 'plan_renews_at' => gmdate('Y-m-d H:i:s', strtotime($base . ' +1 month'))], 'id = ?', [$orgId]);
                    if ((float) $plan['included_credit'] > 0) self::credit($orgId, (float) $plan['included_credit'], 'included', $inv['number'], $plan['name'] . ' plan usage credit');
                }
            }
            $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
            if ($org['status'] === 'locked' && str_starts_with((string) $org['locked_reason'], 'Unpaid')) {
                $stillOverdue = DB::value("SELECT COUNT(*) FROM invoices WHERE org_id = ? AND status = 'unpaid' AND kind = 'plan' AND due_at < ?", [$orgId, ts('-' . (int) Settings::get('lock_after_days') . ' days')]);
                if (!$stillOverdue) {
                    DB::update('orgs', ['status' => 'active', 'locked_reason' => null], 'id = ?', [$orgId]);
                    self::notifyOwners($orgId, 'Your SeaGeek account is active again', 'unlocked', []);
                }
            }
            self::maybeEnableLive($orgId);
            self::notifyOwners($orgId, 'Payment received: ' . $inv['number'], 'receipt', ['invoice' => DB::one('SELECT * FROM invoices WHERE id = ?', [$inv['id']])]);
            return true;
        });
    }

    /** Pay unpaid invoices, oldest first, from the credit balance where it covers them. */
    public static function settleFromCredit(int $orgId): int
    {
        $n = 0;
        foreach (DB::all("SELECT * FROM invoices WHERE org_id = ? AND status = 'unpaid' AND kind <> 'topup' ORDER BY due_at, id", [$orgId]) as $inv) {
            $bal = (float) DB::value('SELECT balance FROM orgs WHERE id = ?', [$orgId]);
            if ($bal < (float) $inv['total']) break;
            self::charge($orgId, (float) $inv['total'], 'invoice', $inv['number'], 'Invoice ' . $inv['number'] . ' paid from credit');
            self::markPaid((int) $inv['id'], 'credit', 'balance', (float) $inv['total']);
            $n++;
        }
        return $n;
    }

    /**
     * Apply one bank statement line. The 6-digit customer number in the reference identifies the account.
     * Exact invoice amounts settle that invoice; anything else becomes credit on a paid top-up invoice,
     * which then settles open invoices it covers. Every payment ends up on an invoice.
     */
    public static function applyBankLine(string $postedOn, string $reference, float $amount, int $lineNo = 0, ?int $forceOrgId = null): array
    {
        $hash = hash('sha256', $postedOn . '|' . strtoupper(trim($reference)) . '|' . number_format($amount, 2, '.', '') . '|' . $lineNo);
        if ($existing = DB::one('SELECT * FROM bank_lines WHERE hash = ?', [$hash])) return $existing + ['duplicate' => true];
        $org = null;
        if ($forceOrgId) {
            $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$forceOrgId]);
        } elseif (preg_match_all('/(?<!\d)(\d{6})(?!\d)/', $reference, $m)) {
            foreach ($m[1] as $candidate) {
                if ($org = DB::one('SELECT * FROM orgs WHERE customer_no = ?', [$candidate])) break;
            }
        }
        $line = ['hash' => $hash, 'posted_on' => mb_substr($postedOn, 0, 10), 'reference' => mb_substr($reference, 0, 160), 'amount' => $amount, 'org_id' => $org['id'] ?? null, 'invoice_id' => null, 'status' => 'unmatched', 'note' => null, 'created_at' => now()];
        if (!$org || $amount <= 0) {
            $line['note'] = $amount <= 0 ? 'Not a deposit' : 'No customer number found in the reference';
            $line['id'] = DB::insert('bank_lines', $line);
            return $line;
        }
        $ref = 'EFT ' . $postedOn . ' ' . mb_substr($reference, 0, 40);
        $exact = DB::one("SELECT * FROM invoices WHERE org_id = ? AND status = 'unpaid' AND ABS(total - ?) < 0.01 ORDER BY due_at, id LIMIT 1", [$org['id'], $amount]);
        if ($exact) {
            self::markPaid((int) $exact['id'], 'eft', $ref, $amount);
            $line['invoice_id'] = $exact['id'];
            $line['note'] = 'Paid invoice ' . $exact['number'];
        } else {
            $vatRate = Settings::get('vat_registered') === '1' ? (float) Settings::get('vat_rate') : 0.0;
            $net = round($amount / (1 + $vatRate / 100), 2);
            $inv = self::createInvoice($org, 'topup', $net, 'Prepaid credit received by EFT', null, [['topup', null, 'Prepaid credit received by EFT', 1, $net]]);
            self::markPaid((int) $inv['id'], 'eft', $ref, $amount);
            $settled = self::settleFromCredit((int) $org['id']);
            $line['invoice_id'] = $inv['id'];
            $line['note'] = 'Credit ' . zar($net) . ' on ' . $inv['number'] . ($settled ? ", settled $settled open invoice(s)" : '');
        }
        $line['status'] = 'matched';
        $line['id'] = DB::insert('bank_lines', $line);
        return $line;
    }

    /** Statement for one calendar month: opening balance, every ledger entry, closing balance. */
    public static function statement(int $orgId, string $month): array
    {
        $start = $month . '-01 00:00:00';
        $end = gmdate('Y-m-d H:i:s', strtotime($start . ' +1 month'));
        $opening = DB::one('SELECT balance_after FROM ledger WHERE org_id = ? AND created_at < ? ORDER BY id DESC LIMIT 1', [$orgId, $start]);
        $rows = DB::all('SELECT * FROM ledger WHERE org_id = ? AND created_at >= ? AND created_at < ? ORDER BY id', [$orgId, $start, $end]);
        $open = $opening ? (float) $opening['balance_after'] : 0.0;
        $in = array_sum(array_map(fn($r) => max(0, (float) $r['amount']), $rows));
        $out = array_sum(array_map(fn($r) => min(0, (float) $r['amount']), $rows));
        $invoices = DB::all("SELECT * FROM invoices WHERE org_id = ? AND created_at >= ? AND created_at < ? AND status <> 'void' ORDER BY id", [$orgId, $start, $end]);
        $due = (float) DB::value("SELECT COALESCE(SUM(total), 0) FROM invoices WHERE org_id = ? AND status = 'unpaid'", [$orgId]);
        return ['opening' => $open, 'rows' => $rows, 'credits' => $in, 'debits' => $out, 'closing' => $rows ? (float) end($rows)['balance_after'] : $open, 'start' => $start, 'end' => $end, 'invoices' => $invoices, 'due' => $due];
    }

    /** Live keys switch on automatically once the email is verified, the profile is complete and a payment has cleared. */
    public static function maybeEnableLive(int $orgId): void
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
        if (!$org || $org['live_enabled']) return;
        $verified = DB::value('SELECT COUNT(*) FROM users WHERE org_id = ? AND email_verified_at IS NOT NULL', [$orgId]);
        $paid = DB::value("SELECT COUNT(*) FROM payments WHERE org_id = ? AND status = 'complete'", [$orgId]);
        if ($verified && $paid && $org['phone'] && $org['name']) {
            DB::update('orgs', ['live_enabled' => 1], 'id = ?', [$orgId]);
            if (!DB::value("SELECT COUNT(*) FROM api_keys WHERE org_id = ? AND env = 'live' AND revoked_at IS NULL", [$orgId])) {
                $_SESSION['new_live_key'] = ApiKeys::create($orgId, 'live');
            }
            self::notifyOwners($orgId, 'Live access is on', 'live_enabled', []);
        }
    }

    public static function notifyOwners(int $orgId, string $subject, string $template, array $data): void
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$orgId]);
        foreach (DB::all("SELECT * FROM users WHERE org_id = ? AND role IN ('owner','billing')", [$orgId]) as $u) {
            Mail::queue($u['email'], $subject, $template, $data + ['user' => $u, 'org' => $org]);
        }
    }

    // ---------------------------------------------------------------
    // PayFast (card, Instant EFT, SnapScan, Zapper and more)
    // ---------------------------------------------------------------

    public static function payfastHost(): string
    {
        return Settings::get('payfast_mode') === 'live' ? 'www.payfast.co.za' : 'sandbox.payfast.co.za';
    }

    private static function pfSignature(array $fields, string $passphrase): string
    {
        $pairs = [];
        foreach ($fields as $k => $v) {
            if ($k === 'signature' || $v === '' || $v === null) continue;
            $pairs[] = $k . '=' . urlencode(trim((string) $v));
        }
        $str = implode('&', $pairs);
        if ($passphrase !== '') $str .= '&passphrase=' . urlencode(trim($passphrase));
        return md5($str);
    }

    public static function payfastForm(array $invoice, array $user): array
    {
        $names = explode(' ', trim($user['name']), 2);
        $fields = [
            'merchant_id' => Settings::get('payfast_merchant_id'),
            'merchant_key' => Settings::get('payfast_merchant_key'),
            'return_url' => app_url('/dashboard/pay/' . $invoice['number'] . '?paid=1'),
            'cancel_url' => app_url('/dashboard/pay/' . $invoice['number'] . '?cancelled=1'),
            'notify_url' => app_url('/webhooks/payfast'),
            'name_first' => $names[0] ?? '',
            'name_last' => $names[1] ?? '',
            'email_address' => $user['email'],
            'm_payment_id' => (string) $invoice['id'],
            'amount' => number_format((float) $invoice['total'], 2, '.', ''),
            'item_name' => 'SeaGeek ' . $invoice['number'],
            'item_description' => mb_substr((string) $invoice['description'], 0, 255),
        ];
        $fields['signature'] = self::pfSignature($fields, Settings::get('payfast_passphrase'));
        return ['action' => 'https://' . self::payfastHost() . '/eng/process', 'fields' => $fields];
    }

    /** Instant Transaction Notification from PayFast. Verifies signature, amount and confirms with PayFast's server. */
    public static function payfastItn(array $post, bool $confirmWithServer = true): string
    {
        $sig = self::pfSignature($post, Settings::get('payfast_passphrase'));
        if (!hash_equals($sig, (string) ($post['signature'] ?? ''))) return 'bad signature';
        $inv = DB::one('SELECT * FROM invoices WHERE id = ?', [(int) ($post['m_payment_id'] ?? 0)]);
        if (!$inv) return 'unknown invoice';
        if (abs((float) $inv['total'] - (float) ($post['amount_gross'] ?? 0)) > 0.01) return 'amount mismatch';
        if ($confirmWithServer) {
            $pairs = [];
            foreach ($post as $k => $v) if ($k !== 'signature') $pairs[] = $k . '=' . urlencode((string) $v);
            $res = Http::request('POST', 'https://' . self::payfastHost() . '/eng/query/validate', ['Content-Type' => 'application/x-www-form-urlencoded'], implode('&', $pairs), 20);
            if (trim($res['body']) !== 'VALID') return 'not confirmed by PayFast';
        }
        if (($post['payment_status'] ?? '') !== 'COMPLETE') {
            DB::insert('payments', ['org_id' => $inv['org_id'], 'invoice_id' => $inv['id'], 'gateway' => 'payfast', 'amount' => (float) ($post['amount_gross'] ?? 0), 'status' => strtolower((string) ($post['payment_status'] ?? 'unknown')), 'gateway_ref' => (string) ($post['pf_payment_id'] ?? ''), 'raw' => json_encode($post), 'created_at' => now()]);
            return 'recorded ' . ($post['payment_status'] ?? '');
        }
        self::markPaid((int) $inv['id'], 'payfast', (string) ($post['pf_payment_id'] ?? ''), (float) $post['amount_gross'], $post);
        return 'ok';
    }

    // ---------------------------------------------------------------
    // Automation, run by cron
    // ---------------------------------------------------------------

    /** Renew paid plans: invoice on the renewal date, pay from credit when auto-pay is on and the balance covers it. */
    public static function runRenewals(): int
    {
        $n = 0;
        $due = DB::all("SELECT * FROM orgs WHERE plan_code <> 'payg' AND is_house = 0 AND status <> 'closed' AND plan_renews_at IS NOT NULL AND plan_renews_at <= ?", [now()]);
        foreach ($due as $org) {
            $open = DB::one("SELECT * FROM invoices WHERE org_id = ? AND kind = 'plan' AND status = 'unpaid'", [$org['id']]);
            if ($open) continue;
            $plan = self::plan($org);
            $inv = self::createInvoice($org, 'plan', (float) $plan['price'], $plan['name'] . ' plan, ' . gmdate('F Y'), $plan['code']);
            if ($org['auto_pay'] && (float) $org['balance'] >= (float) $inv['total']) {
                try {
                    self::charge((int) $org['id'], (float) $inv['total'], 'plan', $inv['number'], 'Plan renewal paid from credit');
                    self::markPaid((int) $inv['id'], 'credit', 'balance', (float) $inv['total']);
                } catch (InsufficientFunds) {
                    // falls through to a normal invoice
                }
            } else {
                self::notifyOwners((int) $org['id'], 'Invoice ' . $inv['number'] . ' from SeaGeek', 'invoice', ['invoice' => $inv]);
                DB::update('invoices', ['reminder_stage' => 1], 'id = ?', [$inv['id']]);
            }
            $n++;
        }
        return $n;
    }

    /** Reminders on configured days after the due date, then lock live access. */
    public static function runReminders(): array
    {
        $days = array_values(array_filter(array_map('intval', explode(',', Settings::get('reminder_days'))), fn($d) => $d >= 0));
        sort($days);
        $lockAfter = (int) Settings::get('lock_after_days');
        $sent = 0;
        $locked = 0;
        foreach (DB::all("SELECT * FROM invoices WHERE status = 'unpaid' AND kind = 'plan'") as $inv) {
            $overdueDays = (int) floor((time() - strtotime($inv['due_at'] . ' UTC')) / 86400);
            $stage = (int) $inv['reminder_stage'];
            foreach ($days as $i => $d) {
                if ($overdueDays >= $d && $stage < $i + 2) {
                    self::notifyOwners((int) $inv['org_id'], $d === 0 ? "Invoice {$inv['number']} is due today" : "Reminder: invoice {$inv['number']} is overdue", 'reminder', ['invoice' => $inv, 'days' => $overdueDays, 'lock_in' => max(0, $lockAfter - $overdueDays)]);
                    DB::update('invoices', ['reminder_stage' => $i + 2], 'id = ?', [$inv['id']]);
                    $stage = $i + 2;
                    $sent++;
                }
            }
            if ($overdueDays >= $lockAfter) {
                $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$inv['org_id']]);
                if ($org && $org['status'] === 'active' && !$org['is_house']) {
                    DB::update('orgs', ['status' => 'locked', 'locked_reason' => 'Unpaid invoice ' . $inv['number']], 'id = ?', [$org['id']]);
                    self::notifyOwners((int) $org['id'], 'Live access paused: invoice ' . $inv['number'] . ' is unpaid', 'locked', ['invoice' => $inv]);
                    DB::insert('audit_log', ['user_id' => null, 'org_id' => $org['id'], 'action' => 'org.auto_locked', 'detail' => $inv['number'], 'ip' => 'cron', 'created_at' => now()]);
                    $locked++;
                }
            }
        }
        return ['reminders' => $sent, 'locked' => $locked];
    }

    public static function runLowBalance(): int
    {
        $n = 0;
        foreach (DB::all('SELECT * FROM orgs WHERE live_enabled = 1 AND is_house = 0 AND low_balance_notified = 0 AND balance < low_balance') as $org) {
            self::notifyOwners((int) $org['id'], 'Your SeaGeek balance is low', 'low_balance', []);
            DB::update('orgs', ['low_balance_notified' => 1], 'id = ?', [$org['id']]);
            $n++;
        }
        return $n;
    }

    /** Monthly WhatsApp number fees, charged from credit on the 1st. */
    public static function runNumberFees(): int
    {
        $job = DB::one("SELECT * FROM jobs WHERE name = 'wa_fees'");
        $month = gmdate('Y-m');
        if ($job && str_starts_with((string) $job['last_result'], $month)) return 0;
        $n = 0;
        foreach (DB::all("SELECT w.*, o.plan_code FROM wa_numbers w JOIN orgs o ON o.id = w.org_id WHERE w.status = 'active' AND o.is_house = 0") as $num) {
            $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$num['org_id']]);
            $p = self::price($org, 'wa_number');
            try {
                self::charge((int) $org['id'], $p['price'], 'usage', 'wa-' . $num['id'] . '-' . $month, 'WhatsApp number ' . $num['phone'] . ', ' . gmdate('F Y'));
            } catch (InsufficientFunds) {
                self::notifyOwners((int) $org['id'], 'Add credit to keep your WhatsApp number', 'low_balance', ['reason' => 'WhatsApp number fee for ' . $num['phone']]);
            }
            $n++;
        }
        Cron::mark('wa_fees', $month . ' charged ' . $n);
        return $n;
    }
}

final class Webhooks
{
    public static function queue(int $orgId, string $event, array $data): void
    {
        $org = DB::one('SELECT webhook_url FROM orgs WHERE id = ?', [$orgId]);
        if (!$org || !$org['webhook_url']) return;
        DB::insert('webhook_deliveries', [
            'org_id' => $orgId, 'event' => $event,
            'payload' => json_encode(['id' => public_id('evt'), 'type' => $event, 'created_at' => gmdate('c'), 'data' => $data], JSON_UNESCAPED_SLASHES),
            'status' => 'pending', 'next_attempt_at' => now(), 'created_at' => now(),
        ]);
    }

    public static function sign(string $secret, string $payload, int $t): string
    {
        return 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $payload, $secret);
    }

    /** Retries with backoff: 1, 5, 30 minutes, 2, 6, 12, 24 hours, then gives up. */
    public static function deliver(int $limit = 100): int
    {
        $backoff = [60, 300, 1800, 7200, 21600, 43200, 86400];
        $done = 0;
        foreach (DB::all("SELECT d.*, o.webhook_url, o.webhook_secret FROM webhook_deliveries d JOIN orgs o ON o.id = d.org_id WHERE d.status = 'pending' AND d.next_attempt_at <= ? ORDER BY d.id LIMIT " . $limit, [now()]) as $d) {
            if (!$d['webhook_url']) { DB::update('webhook_deliveries', ['status' => 'cancelled'], 'id = ?', [$d['id']]); continue; }
            $t = time();
            $res = Http::request('POST', $d['webhook_url'], ['Content-Type' => 'application/json', 'SeaGeek-Signature' => self::sign((string) $d['webhook_secret'], $d['payload'], $t), 'SeaGeek-Event' => $d['event']], $d['payload'], 10);
            $attempt = (int) $d['attempts'] + 1;
            $ok = $res['status'] >= 200 && $res['status'] < 300;
            DB::update('webhook_deliveries', [
                'attempts' => $attempt, 'last_status' => $res['status'],
                'status' => $ok ? 'delivered' : ($attempt > count($backoff) ? 'failed' : 'pending'),
                'next_attempt_at' => gmdate('Y-m-d H:i:s', time() + ($backoff[$attempt - 1] ?? 86400)),
            ], 'id = ?', [$d['id']]);
            $done++;
        }
        return $done;
    }
}

final class Cron
{
    public static function mark(string $name, string $result): void
    {
        if (DB::one('SELECT id FROM jobs WHERE name = ?', [$name])) {
            DB::update('jobs', ['last_run_at' => now(), 'last_result' => mb_substr($result, 0, 255)], 'name = ?', [$name]);
        } else {
            DB::insert('jobs', ['name' => $name, 'last_run_at' => now(), 'last_result' => mb_substr($result, 0, 255)]);
        }
    }

    /** Everything that keeps the business running without a person. Safe to run every minute. */
    public static function run(): array
    {
        $out = [];
        $steps = [
            'simulate' => fn() => Gateway::advanceSimulated(),
            'queue' => fn() => Gateway::processQueue(),
            'renewals' => fn() => Billing::runRenewals(),
            'reminders' => fn() => Billing::runReminders(),
            'low_balance' => fn() => Billing::runLowBalance(),
            'wa_fees' => fn() => (int) gmdate('j') === 1 ? Billing::runNumberFees() : 0,
            'desk_sla' => fn() => Desk::runSla(),
            'campaigns' => fn() => Campaigns::process(500),
            'store_reminders' => fn() => Stores::runScheduled(),
            'monitors' => fn() => Monitors::run(),
            'xero' => fn() => Xero::sync(),
            'webhooks' => fn() => Webhooks::deliver(),
            'email' => fn() => Mail::deliver(),
            'cleanup' => function () {
                DB::run('DELETE FROM rate_limits WHERE window_start < ?', [(int) floor(time() / 60) - 120]);
                DB::run('DELETE FROM sessions WHERE updated_at < ?', [time() - 86400 * 2]);
                DB::run("DELETE FROM otp_codes WHERE expires_at < ?", [ts('-30 days')]);
                DB::run('DELETE FROM idempotency WHERE created_at < ?', [ts('-24 hours')]);
                DB::run("UPDATE invoices SET status = 'void' WHERE status = 'unpaid' AND kind IN ('topup','order') AND created_at < ?", [ts('-30 days')]);
                DB::run('DELETE FROM security_events WHERE created_at < ?', [ts('-30 days')]);
                DB::run('DELETE FROM ip_blocks WHERE until < ?', [ts('-1 day')]);
                DB::run('DELETE FROM monitor_events WHERE created_at < ?', [ts('-180 days')]);
                DB::run("UPDATE quotes SET status = 'expired' WHERE status = 'open' AND valid_until < ?", [now()]);
                return 'ok';
            },
        ];
        foreach ($steps as $name => $fn) {
            try {
                $r = $fn();
                $out[$name] = $r;
                self::mark($name, is_scalar($r) ? (string) $r : json_encode($r));
            } catch (Throwable $e) {
                $out[$name] = 'error: ' . $e->getMessage();
                log_line('cron', "$name failed: " . $e->getMessage());
            }
        }
        Settings::set('last_cron_at', now());
        return $out;
    }
}
