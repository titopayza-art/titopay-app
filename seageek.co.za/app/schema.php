<?php
/**
 * Database schema and versioned migrations. Works on MySQL/MariaDB and SQLite.
 * Add new migrations to the end of migrations(); never edit an applied one.
 */
declare(strict_types=1);

final class Schema
{
    private static function t(string $sql): string
    {
        $mysql = DB::driver() === 'mysql';
        return strtr($sql, [
            '{PK}' => $mysql ? 'BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT',
            '{ID}' => $mysql ? 'BIGINT UNSIGNED' : 'INTEGER',
            '{TS}' => 'VARCHAR(19)',
            '{MONEY}' => $mysql ? 'DECIMAL(16,4)' : 'REAL',
            '{TEXT}' => $mysql ? 'MEDIUMTEXT' : 'TEXT',
            '{ENGINE}' => $mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci' : '',
        ]);
    }

    public static function migrations(): array
    {
        return [
            1 => [
                "CREATE TABLE settings (k VARCHAR(80) PRIMARY KEY, v {TEXT}){ENGINE}",
                "CREATE TABLE sessions (id VARCHAR(128) PRIMARY KEY, data {TEXT}, updated_at INTEGER NOT NULL){ENGINE}",
                "CREATE TABLE orgs (
                    id {PK}, name VARCHAR(160) NOT NULL, slug VARCHAR(80) NOT NULL UNIQUE, company_reg VARCHAR(40), vat_no VARCHAR(40),
                    phone VARCHAR(40), website VARCHAR(200), industry VARCHAR(60), use_case VARCHAR(500), address VARCHAR(300),
                    plan_code VARCHAR(30) NOT NULL DEFAULT 'payg', plan_renews_at {TS}, status VARCHAR(20) NOT NULL DEFAULT 'active',
                    locked_reason VARCHAR(200), balance {MONEY} NOT NULL DEFAULT 0, credit_limit {MONEY} NOT NULL DEFAULT 0,
                    low_balance {MONEY} NOT NULL DEFAULT 50, low_balance_notified INTEGER NOT NULL DEFAULT 0,
                    live_enabled INTEGER NOT NULL DEFAULT 0, kyb_status VARCHAR(20) NOT NULL DEFAULT 'none',
                    sms_sender VARCHAR(11), sms_sender_status VARCHAR(20) NOT NULL DEFAULT 'none',
                    mail_domain VARCHAR(120), mail_domain_status VARCHAR(20) NOT NULL DEFAULT 'none',
                    webhook_url VARCHAR(300), webhook_secret VARCHAR(80),
                    ai_monthly_cap {MONEY}, ai_max_tokens INTEGER, auto_pay INTEGER NOT NULL DEFAULT 1,
                    is_house INTEGER NOT NULL DEFAULT 0, created_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE TABLE users (
                    id {PK}, org_id {ID}, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(20) NOT NULL DEFAULT 'owner', is_admin INTEGER NOT NULL DEFAULT 0, email_verified_at {TS},
                    last_login_at {TS}, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until {TS}, created_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE TABLE tokens (id {PK}, user_id {ID} NOT NULL, type VARCHAR(20) NOT NULL, token_hash VARCHAR(64) NOT NULL, expires_at {TS} NOT NULL, used_at {TS}){ENGINE}",
                "CREATE TABLE api_keys (
                    id {PK}, org_id {ID} NOT NULL, env VARCHAR(4) NOT NULL, prefix VARCHAR(20) NOT NULL, key_hash VARCHAR(64) NOT NULL UNIQUE,
                    label VARCHAR(80), last_used_at {TS}, revoked_at {TS}, created_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE TABLE plans (
                    code VARCHAR(30) PRIMARY KEY, name VARCHAR(60) NOT NULL, price {MONEY} NOT NULL, included_credit {MONEY} NOT NULL DEFAULT 0,
                    discount_pct INTEGER NOT NULL DEFAULT 0, ai_monthly_cap {MONEY} NOT NULL DEFAULT 0, ai_max_tokens INTEGER NOT NULL DEFAULT 1024,
                    ai_rpm INTEGER NOT NULL DEFAULT 10, api_rps INTEGER NOT NULL DEFAULT 5, desk_agents INTEGER NOT NULL DEFAULT 1,
                    wa_numbers INTEGER NOT NULL DEFAULT 0, features {TEXT}, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
                ){ENGINE}",
                "CREATE TABLE rates (unit VARCHAR(40) PRIMARY KEY, service VARCHAR(20) NOT NULL, label VARCHAR(120) NOT NULL, price {MONEY} NOT NULL, cost {MONEY} NOT NULL DEFAULT 0, per VARCHAR(30) NOT NULL){ENGINE}",
                "CREATE TABLE partners (
                    id {PK}, name VARCHAR(80) NOT NULL, service VARCHAR(20) NOT NULL, driver VARCHAR(30) NOT NULL, config_enc {TEXT},
                    priority INTEGER NOT NULL DEFAULT 10, active INTEGER NOT NULL DEFAULT 0, last_ok_at {TS}, last_error VARCHAR(500),
                    fail_count INTEGER NOT NULL DEFAULT 0, created_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE TABLE messages (
                    id {PK}, public_id VARCHAR(40) NOT NULL UNIQUE, org_id {ID} NOT NULL, env VARCHAR(4) NOT NULL, service VARCHAR(20) NOT NULL,
                    direction VARCHAR(3) NOT NULL DEFAULT 'out', unit VARCHAR(40), quantity {MONEY} NOT NULL DEFAULT 0, amount {MONEY} NOT NULL DEFAULT 0,
                    cost {MONEY} NOT NULL DEFAULT 0, partner_id {ID}, status VARCHAR(20) NOT NULL, to_addr VARCHAR(200), from_addr VARCHAR(200),
                    external_id VARCHAR(120), reference VARCHAR(120), error VARCHAR(500), meta {TEXT}, created_at {TS} NOT NULL, updated_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE INDEX messages_org ON messages (org_id, created_at)",
                "CREATE INDEX messages_ext ON messages (external_id)",
                "CREATE TABLE ledger (id {PK}, org_id {ID} NOT NULL, type VARCHAR(20) NOT NULL, amount {MONEY} NOT NULL, balance_after {MONEY} NOT NULL, ref VARCHAR(60), description VARCHAR(255), created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX ledger_org ON ledger (org_id, id)",
                "CREATE TABLE invoices (
                    id {PK}, number VARCHAR(30) NOT NULL UNIQUE, org_id {ID} NOT NULL, kind VARCHAR(20) NOT NULL, description VARCHAR(255),
                    subtotal {MONEY} NOT NULL, vat {MONEY} NOT NULL DEFAULT 0, total {MONEY} NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
                    plan_code VARCHAR(30), due_at {TS} NOT NULL, paid_at {TS}, reminder_stage INTEGER NOT NULL DEFAULT 0, created_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE TABLE payments (id {PK}, org_id {ID} NOT NULL, invoice_id {ID}, gateway VARCHAR(20) NOT NULL, amount {MONEY} NOT NULL, status VARCHAR(20) NOT NULL, gateway_ref VARCHAR(120), raw {TEXT}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE otp_codes (id {PK}, public_id VARCHAR(40) NOT NULL UNIQUE, org_id {ID} NOT NULL, env VARCHAR(4) NOT NULL, channel VARCHAR(10) NOT NULL, to_addr VARCHAR(200) NOT NULL, code_hash VARCHAR(64) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL, expires_at {TS} NOT NULL, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE webhook_deliveries (id {PK}, org_id {ID} NOT NULL, event VARCHAR(60) NOT NULL, payload {TEXT} NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'pending', next_attempt_at {TS} NOT NULL, last_status INTEGER, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE email_outbox (id {PK}, to_addr VARCHAR(190) NOT NULL, subject VARCHAR(255) NOT NULL, html {TEXT}, text_body {TEXT}, status VARCHAR(20) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error VARCHAR(500), created_at {TS} NOT NULL, sent_at {TS}){ENGINE}",
                "CREATE TABLE wa_numbers (id {PK}, org_id {ID} NOT NULL, phone VARCHAR(30) NOT NULL, display_name VARCHAR(80), status VARCHAR(20) NOT NULL DEFAULT 'pending', partner_id {ID}, channel_key_enc {TEXT}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE ai_agents (id {PK}, public_id VARCHAR(40) NOT NULL UNIQUE, org_id {ID} NOT NULL, name VARCHAR(80) NOT NULL, provider VARCHAR(20) NOT NULL, model VARCHAR(60) NOT NULL, instructions {TEXT}, knowledge {TEXT}, handover INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE tickets (
                    id {PK}, org_id {ID} NOT NULL, number INTEGER NOT NULL, subject VARCHAR(200) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'new',
                    priority VARCHAR(10) NOT NULL DEFAULT 'normal', channel VARCHAR(20) NOT NULL, requester_name VARCHAR(120), requester_email VARCHAR(190),
                    requester_phone VARCHAR(40), assignee_id {ID}, token VARCHAR(40) NOT NULL UNIQUE, ai_active INTEGER NOT NULL DEFAULT 1,
                    sla_due_at {TS}, first_reply_at {TS}, solved_at {TS}, csat INTEGER, tags VARCHAR(255), created_at {TS} NOT NULL, updated_at {TS} NOT NULL
                ){ENGINE}",
                "CREATE INDEX tickets_org ON tickets (org_id, status, updated_at)",
                "CREATE TABLE ticket_messages (id {PK}, ticket_id {ID} NOT NULL, author VARCHAR(20) NOT NULL, author_id {ID}, body {TEXT} NOT NULL, internal INTEGER NOT NULL DEFAULT 0, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX ticket_messages_t ON ticket_messages (ticket_id, id)",
                "CREATE TABLE macros (id {PK}, org_id {ID} NOT NULL, title VARCHAR(120) NOT NULL, body {TEXT} NOT NULL, set_status VARCHAR(20)){ENGINE}",
                "CREATE TABLE articles (id {PK}, org_id {ID} NOT NULL, category VARCHAR(80) NOT NULL, title VARCHAR(200) NOT NULL, slug VARCHAR(200) NOT NULL, body {TEXT} NOT NULL, published INTEGER NOT NULL DEFAULT 1, views INTEGER NOT NULL DEFAULT 0, updated_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE rate_limits (k VARCHAR(40) NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (k, window_start)){ENGINE}",
                "CREATE TABLE audit_log (id {PK}, user_id {ID}, org_id {ID}, action VARCHAR(60) NOT NULL, detail VARCHAR(500), ip VARCHAR(45), created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE idempotency (org_id {ID} NOT NULL, idem_key VARCHAR(120) NOT NULL, status INTEGER NOT NULL, response {TEXT} NOT NULL, created_at {TS} NOT NULL, PRIMARY KEY (org_id, idem_key)){ENGINE}",
                "CREATE TABLE jobs (id {PK}, name VARCHAR(60) NOT NULL UNIQUE, last_run_at {TS}, last_result VARCHAR(255)){ENGINE}",
            ],
            // Customer numbers, invoice line items, per-account services, packages, quotes, bank statement import
            2 => [
                "ALTER TABLE orgs ADD COLUMN customer_no VARCHAR(6)",
                "CREATE UNIQUE INDEX orgs_customer_no ON orgs (customer_no)",
                "CREATE TABLE invoice_items (id {PK}, invoice_id {ID} NOT NULL, kind VARCHAR(20) NOT NULL, ref VARCHAR(60), description VARCHAR(255) NOT NULL, quantity {MONEY} NOT NULL DEFAULT 1, unit_price {MONEY} NOT NULL, amount {MONEY} NOT NULL){ENGINE}",
                "CREATE INDEX invoice_items_inv ON invoice_items (invoice_id)",
                "CREATE TABLE org_services (org_id {ID} NOT NULL, service VARCHAR(20) NOT NULL, status VARCHAR(20) NOT NULL, activated_at {TS}, PRIMARY KEY (org_id, service)){ENGINE}",
                "CREATE TABLE packages (code VARCHAR(40) PRIMARY KEY, service VARCHAR(20) NOT NULL, name VARCHAR(80) NOT NULL, description VARCHAR(255), price {MONEY} NOT NULL, credit {MONEY} NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1){ENGINE}",
                "CREATE TABLE quotes (id {PK}, number VARCHAR(30) NOT NULL UNIQUE, org_id {ID}, inputs {TEXT} NOT NULL, items {TEXT} NOT NULL, plan_code VARCHAR(30), subtotal {MONEY} NOT NULL, vat {MONEY} NOT NULL DEFAULT 0, total {MONEY} NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'open', valid_until {TS} NOT NULL, invoice_id {ID}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX quotes_org ON quotes (org_id, id)",
                "CREATE TABLE bank_lines (id {PK}, hash VARCHAR(64) NOT NULL UNIQUE, posted_on VARCHAR(10), reference VARCHAR(160), amount {MONEY} NOT NULL, org_id {ID}, invoice_id {ID}, status VARCHAR(20) NOT NULL, note VARCHAR(255), created_at {TS} NOT NULL){ENGINE}",
            ],
        ];
    }

    public static function migrate(): array
    {
        $pdo = DB::pdo();
        $pdo->exec(self::t("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at {TS} NOT NULL){ENGINE}"));
        $done = array_map('intval', DB::all('SELECT version FROM schema_migrations') ? array_column(DB::all('SELECT version FROM schema_migrations'), 'version') : []);
        $applied = [];
        foreach (self::migrations() as $version => $statements) {
            if (in_array($version, $done, true)) continue;
            foreach ($statements as $sql) $pdo->exec(self::t($sql));
            DB::insert('schema_migrations', ['version' => $version, 'applied_at' => now()]);
            $applied[] = $version;
        }
        if ($applied) self::seed();
        return $applied;
    }

    /** Reference data. Safe to run more than once. */
    public static function seed(): void
    {
        foreach (Catalog::packages() as $p) {
            if (!DB::one('SELECT code FROM packages WHERE code = ?', [$p['code']])) DB::insert('packages', $p);
        }
        // Every account has a 6-digit customer number (also its EFT payment reference)
        foreach (DB::all('SELECT id FROM orgs WHERE customer_no IS NULL') as $o) {
            DB::update('orgs', ['customer_no' => Billing::newCustomerNo()], 'id = ?', [$o['id']]);
        }
        // Invoices from before line items existed get one line
        foreach (DB::all('SELECT * FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM invoice_items x WHERE x.invoice_id = i.id)') as $inv) {
            DB::insert('invoice_items', ['invoice_id' => $inv['id'], 'kind' => $inv['kind'] === 'plan' ? 'plan' : 'topup', 'ref' => $inv['plan_code'], 'description' => (string) $inv['description'], 'quantity' => 1, 'unit_price' => $inv['subtotal'], 'amount' => $inv['subtotal']]);
        }
        // Accounts that already used a service keep it switched on
        foreach (DB::all("SELECT DISTINCT org_id, service FROM messages WHERE env = 'live'") as $u) {
            Services::activate((int) $u['org_id'], (string) $u['service']);
        }
        foreach (Catalog::plans() as $p) {
            if (!DB::one('SELECT code FROM plans WHERE code = ?', [$p['code']])) {
                DB::insert('plans', $p);
            }
        }
        foreach (Catalog::rates() as $r) {
            if (!DB::one('SELECT unit FROM rates WHERE unit = ?', [$r['unit']])) DB::insert('rates', $r);
        }
        foreach (Catalog::partnerSeeds() as $p) {
            if (!DB::one('SELECT id FROM partners WHERE name = ? AND service = ?', [$p['name'], $p['service']])) {
                DB::insert('partners', $p + ['created_at' => now()]);
            }
        }
        if (!DB::one('SELECT id FROM orgs WHERE is_house = 1')) {
            $orgId = DB::insert('orgs', ['name' => 'SeaGeek Support', 'slug' => 'seageek', 'customer_no' => Billing::newCustomerNo(), 'plan_code' => 'enterprise', 'is_house' => 1, 'live_enabled' => 1, 'kyb_status' => 'approved', 'created_at' => now()]);
            foreach (array_keys(Services::sellable()) as $svc) Services::activate($orgId, $svc);
            foreach (Catalog::helpArticles() as $a) {
                DB::insert('articles', $a + ['org_id' => $orgId, 'published' => 1, 'views' => 0, 'updated_at' => now()]);
            }
            foreach (Catalog::macros() as $m) DB::insert('macros', $m + ['org_id' => $orgId]);
        }
    }
}
