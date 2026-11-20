<?php
/**
 * Xero accounting: connect once with Xero's sign-in (OAuth 2.0), then every SeaGeek invoice,
 * its customer and every payment are copied to Xero automatically by the scheduled jobs.
 */
declare(strict_types=1);

final class Xero
{
    public static function configured(): bool
    {
        return Settings::get('xero_client_id') !== '' && Settings::get('xero_client_secret') !== '';
    }

    public static function tokens(): array
    {
        return json_decode(Settings::get('xero_tokens'), true) ?: [];
    }

    public static function connected(): bool
    {
        return !empty(self::tokens()['refresh_token']) && !empty(self::tokens()['tenant_id']);
    }

    public static function redirectUri(): string
    {
        return app_url('/admin/xero/callback');
    }

    public static function authorizeUrl(): string
    {
        $_SESSION['xero_state'] = Crypto::token(16);
        return Settings::get('xero_login_url') . '?' . http_build_query([
            'response_type' => 'code', 'client_id' => Settings::get('xero_client_id'), 'redirect_uri' => self::redirectUri(),
            'scope' => Settings::get('xero_scopes'), 'state' => $_SESSION['xero_state'],
        ]);
    }

    private static function tokenRequest(array $form): array
    {
        $res = Http::request('POST', rtrim(Settings::get('xero_identity_url'), '/') . '/connect/token', [
            'Authorization' => 'Basic ' . base64_encode(Settings::get('xero_client_id') . ':' . Settings::get('xero_client_secret')),
            'Content-Type' => 'application/x-www-form-urlencoded',
        ], http_build_query($form), 20);
        if ($res['status'] !== 200 || empty($res['json']['access_token'])) {
            throw new RuntimeException('Xero sign-in failed: ' . mb_substr((string) ($res['json']['error'] ?? $res['error'] ?? $res['body']), 0, 200));
        }
        return $res['json'];
    }

    /** Exchange the code Xero sends back, then remember which organisation (tenant) to write to. */
    public static function finishConnect(string $code, string $state): string
    {
        if (!hash_equals((string) ($_SESSION['xero_state'] ?? ''), $state)) throw new RuntimeException('The Xero sign-in expired. Try connecting again.');
        unset($_SESSION['xero_state']);
        $t = self::tokenRequest(['grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => self::redirectUri()]);
        $conn = Http::request('GET', rtrim(Settings::get('xero_api_url'), '/') . '/connections', ['Authorization' => 'Bearer ' . $t['access_token']], null, 20);
        $tenant = $conn['json'][0] ?? null;
        if (!$tenant) throw new RuntimeException('No Xero organisation was shared. Connect again and choose your organisation.');
        Settings::set('xero_tokens', json_encode(['access_token' => $t['access_token'], 'refresh_token' => $t['refresh_token'], 'expires_at' => time() + (int) $t['expires_in'] - 60,
            'tenant_id' => $tenant['tenantId'], 'tenant_name' => $tenant['tenantName'] ?? 'Xero']));
        Settings::set('xero_tenant_name', (string) ($tenant['tenantName'] ?? 'Xero'));
        return (string) ($tenant['tenantName'] ?? 'Xero');
    }

    public static function disconnect(): void
    {
        Settings::set('xero_tokens', '');
        Settings::set('xero_tenant_name', '');
    }

    private static function accessToken(): string
    {
        $t = self::tokens();
        if (empty($t['refresh_token'])) throw new RuntimeException('Xero is not connected.');
        if (($t['expires_at'] ?? 0) <= time()) {
            $n = self::tokenRequest(['grant_type' => 'refresh_token', 'refresh_token' => $t['refresh_token']]);
            $t = ['access_token' => $n['access_token'], 'refresh_token' => $n['refresh_token'] ?? $t['refresh_token'], 'expires_at' => time() + (int) $n['expires_in'] - 60] + $t;
            Settings::set('xero_tokens', json_encode($t));
        }
        return $t['access_token'];
    }

    /** One call to the Xero Accounting API. */
    private static function api(string $method, string $path, ?array $body = null): array
    {
        $res = Http::request($method, rtrim(Settings::get('xero_api_url'), '/') . '/api.xro/2.0/' . ltrim($path, '/'), [
            'Authorization' => 'Bearer ' . self::accessToken(), 'Xero-Tenant-Id' => (string) self::tokens()['tenant_id'], 'Accept' => 'application/json',
        ], $body, 30);
        if ($res['status'] === 429) throw new RuntimeException('Xero asked us to slow down; will retry.');
        if ($res['status'] < 200 || $res['status'] >= 300) {
            $msg = $res['json']['Elements'][0]['ValidationErrors'][0]['Message'] ?? $res['json']['Message'] ?? $res['json']['Detail'] ?? $res['error'] ?? ('HTTP ' . $res['status']);
            throw new RuntimeException('Xero: ' . mb_substr((string) $msg, 0, 300));
        }
        return $res['json'] ?? [];
    }

    private static function synced(string $entity, int $id): ?array
    {
        return DB::one('SELECT * FROM xero_sync WHERE entity = ? AND local_id = ?', [$entity, $id]);
    }

    private static function mark(string $entity, int $id, ?string $xeroId, string $status, ?string $error = null): void
    {
        $row = self::synced($entity, $id);
        $d = ['xero_id' => $xeroId ?? ($row['xero_id'] ?? null), 'status' => $status, 'error' => $error ? mb_substr($error, 0, 500) : null, 'synced_at' => $status === 'synced' ? now() : ($row['synced_at'] ?? null)];
        if ($row) DB::update('xero_sync', $d + ['attempts' => (int) $row['attempts'] + 1], 'id = ?', [$row['id']]);
        else DB::insert('xero_sync', $d + ['entity' => $entity, 'local_id' => $id, 'attempts' => 1, 'created_at' => now()]);
    }

    /** The customer as a Xero contact, matched on the 6-digit customer number. */
    private static function contactFor(array $org): string
    {
        if (($s = self::synced('contact', (int) $org['id'])) && $s['xero_id']) return $s['xero_id'];
        $owner = DB::one("SELECT email FROM users WHERE org_id = ? AND role IN ('owner','billing') ORDER BY id LIMIT 1", [$org['id']]);
        $found = self::api('GET', 'Contacts?where=' . rawurlencode('ContactNumber=="' . $org['customer_no'] . '"'));
        $id = $found['Contacts'][0]['ContactID'] ?? null;
        if (!$id) {
            $res = self::api('POST', 'Contacts', ['Contacts' => [array_filter([
                'Name' => $org['name'] . ' (' . $org['customer_no'] . ')', 'ContactNumber' => $org['customer_no'], 'AccountNumber' => $org['customer_no'],
                'EmailAddress' => $owner['email'] ?? null, 'TaxNumber' => $org['vat_no'] ?: null,
            ])]]);
            $id = $res['Contacts'][0]['ContactID'] ?? null;
        }
        if (!$id) throw new RuntimeException('Xero did not return a contact.');
        self::mark('contact', (int) $org['id'], $id, 'synced');
        return $id;
    }

    public static function pushInvoice(array $inv): string
    {
        $org = DB::one('SELECT * FROM orgs WHERE id = ?', [$inv['org_id']]);
        $tax = Settings::get('xero_tax_type') ?: 'NONE';
        $lines = array_map(fn($it) => ['Description' => $it['description'], 'Quantity' => (float) $it['quantity'], 'UnitAmount' => (float) $it['unit_price'],
            'AccountCode' => Settings::get('xero_sales_account'), 'TaxType' => $tax], Billing::items((int) $inv['id']));
        $payload = ['Invoices' => [[
            'Type' => 'ACCREC', 'Contact' => ['ContactID' => self::contactFor($org)], 'InvoiceNumber' => $inv['number'], 'Reference' => 'Customer ' . $org['customer_no'],
            'Date' => substr($inv['created_at'], 0, 10), 'DueDate' => substr($inv['due_at'], 0, 10), 'CurrencyCode' => 'ZAR',
            'LineAmountTypes' => $tax === 'NONE' ? 'NoTax' : 'Exclusive', 'LineItems' => $lines, 'Status' => 'AUTHORISED',
        ]]];
        $res = self::api('POST', 'Invoices', $payload);
        $id = $res['Invoices'][0]['InvoiceID'] ?? null;
        if (!$id) throw new RuntimeException('Xero did not return an invoice.');
        return $id;
    }

    public static function pushPayment(array $pay, string $xeroInvoiceId): string
    {
        $inv = DB::one('SELECT number FROM invoices WHERE id = ?', [$pay['invoice_id']]);
        $res = self::api('PUT', 'Payments', ['Payments' => [[
            'Invoice' => ['InvoiceID' => $xeroInvoiceId], 'Account' => ['Code' => Settings::get('xero_bank_account')],
            'Date' => substr($pay['created_at'], 0, 10), 'Amount' => round((float) $pay['amount'], 2),
            'Reference' => strtoupper((string) $pay['gateway']) . ' ' . mb_substr((string) $pay['gateway_ref'], 0, 40) . ' ' . $inv['number'],
        ]]]);
        $id = $res['Payments'][0]['PaymentID'] ?? null;
        if (!$id) throw new RuntimeException('Xero did not return a payment.');
        return $id;
    }

    /** Scheduled job: copy new invoices, payments and voids to Xero. Safe to run every minute. */
    public static function sync(int $limit = 50): array
    {
        if (!self::configured() || !self::connected()) return ['skipped' => 'not connected'];
        $done = ['invoices' => 0, 'payments' => 0, 'voided' => 0, 'errors' => 0];
        $invoices = DB::all("SELECT i.* FROM invoices i LEFT JOIN xero_sync x ON x.entity = 'invoice' AND x.local_id = i.id
            WHERE i.status IN ('unpaid','paid') AND (x.id IS NULL OR (x.status = 'error' AND x.attempts < 5)) ORDER BY i.id LIMIT " . (int) $limit);
        foreach ($invoices as $inv) {
            try { self::mark('invoice', (int) $inv['id'], self::pushInvoice($inv), 'synced'); $done['invoices']++; }
            catch (Throwable $e) { self::mark('invoice', (int) $inv['id'], null, 'error', $e->getMessage()); $done['errors']++; if (str_contains($e->getMessage(), 'slow down')) return $done; }
        }
        $payments = DB::all("SELECT p.*, xi.xero_id xero_invoice FROM payments p JOIN xero_sync xi ON xi.entity = 'invoice' AND xi.local_id = p.invoice_id AND xi.status = 'synced'
            LEFT JOIN xero_sync x ON x.entity = 'payment' AND x.local_id = p.id
            WHERE p.status = 'complete' AND p.gateway <> 'credit' AND (x.id IS NULL OR (x.status = 'error' AND x.attempts < 5)) ORDER BY p.id LIMIT " . (int) $limit);
        foreach ($payments as $pay) {
            try { self::mark('payment', (int) $pay['id'], self::pushPayment($pay, $pay['xero_invoice']), 'synced'); $done['payments']++; }
            catch (Throwable $e) { self::mark('payment', (int) $pay['id'], null, 'error', $e->getMessage()); $done['errors']++; }
        }
        foreach (DB::all("SELECT i.id, x.xero_id FROM invoices i JOIN xero_sync x ON x.entity = 'invoice' AND x.local_id = i.id AND x.status = 'synced' WHERE i.status = 'void' LIMIT " . (int) $limit) as $v) {
            try { self::api('POST', 'Invoices/' . $v['xero_id'], ['Invoices' => [['InvoiceID' => $v['xero_id'], 'Status' => 'VOIDED']]]); self::mark('invoice', (int) $v['id'], null, 'voided'); $done['voided']++; }
            catch (Throwable $e) { $done['errors']++; }
        }
        return $done;
    }
}
