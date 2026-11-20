<?php
/**
 * Database schema and versioned migrations. Works on MySQL/MariaDB and SQLite.
 * Add new migrations to the end of migrations(); never edit an applied one.
 */
declare(strict_types=1);

final class Schema
{
    /** Every table in the database, read from the database itself so new tables are never missed. */
    public static function tables(): array
    {
        $sql = DB::driver() === 'mysql'
            ? 'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name'
            : "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        return array_map(fn($r) => (string) reset($r), DB::all($sql));
    }

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
            3 => [
                "ALTER TABLE email_outbox ADD COLUMN headers {TEXT}",
                "ALTER TABLE users ADD COLUMN admin_role VARCHAR(30)",
                "ALTER TABLE users ADD COLUMN permissions {TEXT}",
                "ALTER TABLE users ADD COLUMN disabled_at {TS}",
                "UPDATE users SET admin_role = 'owner' WHERE is_admin = 1",
                "CREATE TABLE qr_codes (id {PK}, public_id VARCHAR(30) NOT NULL UNIQUE, org_id {ID} NOT NULL, code VARCHAR(16) NOT NULL UNIQUE, name VARCHAR(120), target_url VARCHAR(2000) NOT NULL, dynamic INTEGER NOT NULL DEFAULT 1, color VARCHAR(7) NOT NULL DEFAULT '#0b1f27', env VARCHAR(10) NOT NULL DEFAULT 'live', amount {MONEY} NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'active', scans INTEGER NOT NULL DEFAULT 0, last_scan_at {TS}, created_at {TS} NOT NULL, updated_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX qr_codes_org ON qr_codes (org_id, id)",
                "CREATE TABLE qr_scans (id {PK}, qr_id {ID} NOT NULL, device VARCHAR(20), created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX qr_scans_qr ON qr_scans (qr_id, created_at)",
                "CREATE TABLE stores (id {PK}, public_id VARCHAR(30) NOT NULL UNIQUE, org_id {ID} NOT NULL, platform VARCHAR(20) NOT NULL, name VARCHAR(120) NOT NULL, domain VARCHAR(190), token VARCHAR(48) NOT NULL UNIQUE, secret_enc {TEXT}, status VARCHAR(20) NOT NULL DEFAULT 'active', settings {TEXT}, list_id {ID}, events_received INTEGER NOT NULL DEFAULT 0, sms_sent INTEGER NOT NULL DEFAULT 0, last_event_at {TS}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX stores_org ON stores (org_id)",
                "CREATE TABLE store_events (id {PK}, store_id {ID} NOT NULL, topic VARCHAR(40) NOT NULL, dedupe VARCHAR(160) NOT NULL, order_ref VARCHAR(60), phone VARCHAR(30), status VARCHAR(20) NOT NULL, note VARCHAR(255), message_id VARCHAR(30), send_at {TS}, payload {TEXT}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE UNIQUE INDEX store_events_dedupe ON store_events (store_id, dedupe)",
                "CREATE INDEX store_events_store ON store_events (store_id, id)",
                "CREATE TABLE contact_lists (id {PK}, org_id {ID} NOT NULL, name VARCHAR(120) NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'static', created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX contact_lists_org ON contact_lists (org_id)",
                "CREATE TABLE contacts (id {PK}, org_id {ID} NOT NULL, list_id {ID} NOT NULL, name VARCHAR(160), phone VARCHAR(30), email VARCHAR(190), source VARCHAR(30), created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX contacts_list ON contacts (list_id, id)",
                "CREATE TABLE opt_outs (org_id {ID} NOT NULL, channel VARCHAR(10) NOT NULL, address VARCHAR(190) NOT NULL, reason VARCHAR(60), created_at {TS} NOT NULL, PRIMARY KEY (org_id, channel, address)){ENGINE}",
                "CREATE TABLE message_templates (id {PK}, org_id {ID} NOT NULL, channel VARCHAR(10) NOT NULL, name VARCHAR(120) NOT NULL, subject VARCHAR(255), body {TEXT} NOT NULL, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE campaigns (id {PK}, public_id VARCHAR(30) NOT NULL UNIQUE, org_id {ID} NOT NULL, name VARCHAR(160) NOT NULL, channel VARCHAR(10) NOT NULL, list_id {ID}, audience VARCHAR(30), subject VARCHAR(255), body {TEXT} NOT NULL, button_label VARCHAR(60), button_url VARCHAR(500), status VARCHAR(20) NOT NULL DEFAULT 'draft', scheduled_at {TS}, started_at {TS}, finished_at {TS}, total INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, cost {MONEY} NOT NULL DEFAULT 0, created_by {ID}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX campaigns_org ON campaigns (org_id, id)",
                "CREATE TABLE campaign_recipients (id {PK}, campaign_id {ID} NOT NULL, name VARCHAR(160), address VARCHAR(190) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', message_id VARCHAR(30), error VARCHAR(255), updated_at {TS}){ENGINE}",
                "CREATE INDEX campaign_recipients_c ON campaign_recipients (campaign_id, status, id)",
            ],
            4 => [
                "CREATE TABLE ip_blocks (ip VARCHAR(64) PRIMARY KEY, reason VARCHAR(120), until {TS} NOT NULL, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE security_events (id {PK}, ip VARCHAR(64) NOT NULL, kind VARCHAR(40) NOT NULL, detail VARCHAR(255), created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX security_events_ip ON security_events (ip, created_at)",
                "ALTER TABLE users ADD COLUMN totp_secret_enc {TEXT}",
                "ALTER TABLE users ADD COLUMN totp_enabled_at {TS}",
                "CREATE TABLE xero_sync (id {PK}, entity VARCHAR(20) NOT NULL, local_id {ID} NOT NULL, xero_id VARCHAR(64), status VARCHAR(20) NOT NULL, error VARCHAR(500), attempts INTEGER NOT NULL DEFAULT 0, synced_at {TS}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE UNIQUE INDEX xero_sync_entity ON xero_sync (entity, local_id)",
            ],
            5 => [
                // Plug-ins: website forms, short links, website monitors, chat widget settings
                "CREATE TABLE web_forms (id {PK}, org_id {ID} NOT NULL, token VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL, notify_email VARCHAR(190), notify_phone VARCHAR(30), to_desk INTEGER NOT NULL DEFAULT 1, auto_reply {TEXT}, thanks_url VARCHAR(500), submissions INTEGER NOT NULL DEFAULT 0, last_at {TS}, status VARCHAR(20) NOT NULL DEFAULT 'active', created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE web_form_entries (id {PK}, form_id {ID} NOT NULL, data {TEXT} NOT NULL, email VARCHAR(190), page VARCHAR(500), ip VARCHAR(64), ticket_id {ID}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX web_form_entries_form ON web_form_entries (form_id, id)",
                "CREATE TABLE short_links (id {PK}, org_id {ID} NOT NULL, code VARCHAR(20) NOT NULL UNIQUE, name VARCHAR(120), target_url VARCHAR(1000) NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, last_click_at {TS}, status VARCHAR(20) NOT NULL DEFAULT 'active', created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE short_link_clicks (id {PK}, link_id {ID} NOT NULL, device VARCHAR(20), created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX short_link_clicks_link ON short_link_clicks (link_id, created_at)",
                "CREATE TABLE monitors (id {PK}, org_id {ID} NOT NULL, name VARCHAR(120) NOT NULL, url VARCHAR(500) NOT NULL, every_min INTEGER NOT NULL DEFAULT 5, keyword VARCHAR(120), alert_email VARCHAR(190), alert_phone VARCHAR(30), state VARCHAR(20) NOT NULL DEFAULT 'pending', fails INTEGER NOT NULL DEFAULT 0, checks INTEGER NOT NULL DEFAULT 0, up_checks INTEGER NOT NULL DEFAULT 0, last_ms INTEGER, last_code INTEGER, last_error VARCHAR(255), last_check_at {TS}, next_check_at {TS}, state_since {TS}, paused INTEGER NOT NULL DEFAULT 0, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX monitors_due ON monitors (paused, next_check_at)",
                "CREATE TABLE monitor_events (id {PK}, monitor_id {ID} NOT NULL, state VARCHAR(20) NOT NULL, detail VARCHAR(255), created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX monitor_events_m ON monitor_events (monitor_id, id)",
                "ALTER TABLE orgs ADD COLUMN chat_settings {TEXT}",
            ],
            6 => [
                // Desk: attachments, rules, email mailbox import, who is viewing a ticket, merging, per-account settings
                "CREATE TABLE ticket_attachments (id {PK}, ticket_id {ID} NOT NULL, message_id {ID}, name VARCHAR(200) NOT NULL, mime VARCHAR(120) NOT NULL, size INTEGER NOT NULL, path VARCHAR(255) NOT NULL, token VARCHAR(48) NOT NULL UNIQUE, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX ticket_attachments_t ON ticket_attachments (ticket_id)",
                "CREATE TABLE desk_rules (id {PK}, org_id {ID} NOT NULL, name VARCHAR(120) NOT NULL, event VARCHAR(20) NOT NULL DEFAULT 'created', field VARCHAR(20) NOT NULL DEFAULT 'any', words VARCHAR(500), channel VARCHAR(20), set_priority VARCHAR(10), set_status VARCHAR(10), assign_to {ID}, add_tag VARCHAR(60), reply_macro {ID}, active INTEGER NOT NULL DEFAULT 1, hits INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE desk_mail_seen (id {PK}, org_id {ID} NOT NULL, uid VARCHAR(190) NOT NULL, created_at {TS} NOT NULL){ENGINE}",
                "CREATE UNIQUE INDEX desk_mail_seen_u ON desk_mail_seen (org_id, uid)",
                "CREATE TABLE desk_presence (id {PK}, ticket_id {ID} NOT NULL, user_id {ID} NOT NULL, typing INTEGER NOT NULL DEFAULT 0, seen_at {TS} NOT NULL){ENGINE}",
                "CREATE UNIQUE INDEX desk_presence_u ON desk_presence (ticket_id, user_id)",
                "ALTER TABLE tickets ADD COLUMN merged_into {ID}",
                "ALTER TABLE tickets ADD COLUMN last_customer_at {TS}",
                "ALTER TABLE orgs ADD COLUMN desk_settings {TEXT}",
            ],
            8 => [
                // Team access per area, data protection settings, and WhatsApp message templates
                "ALTER TABLE users ADD COLUMN team_access {TEXT}",
                "ALTER TABLE orgs ADD COLUMN ai_data_allowed INTEGER NOT NULL DEFAULT 1",
                "ALTER TABLE orgs ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 365",
                "CREATE TABLE wa_templates (id {PK}, org_id {ID} NOT NULL, name VARCHAR(60) NOT NULL, category VARCHAR(20) NOT NULL, language VARCHAR(10) NOT NULL, header_type VARCHAR(10) NOT NULL DEFAULT 'none', header_text VARCHAR(60), body {TEXT} NOT NULL, footer VARCHAR(60), buttons {TEXT}, samples {TEXT}, status VARCHAR(20) NOT NULL DEFAULT 'draft', created_at {TS} NOT NULL, updated_at {TS} NOT NULL){ENGINE}",
                "CREATE UNIQUE INDEX wa_templates_u ON wa_templates (org_id, name, language)",
            ],
            7 => [
                // Startup offers: a plan discount for a period
                "ALTER TABLE orgs ADD COLUMN plan_discount_pct INTEGER NOT NULL DEFAULT 0",
                "ALTER TABLE orgs ADD COLUMN plan_discount_until {TS}",
                // Assistants: AI agents people and companies deploy for work and projects
                "CREATE TABLE assistants (id {PK}, public_id VARCHAR(40) NOT NULL UNIQUE, org_id {ID} NOT NULL, owner_id {ID}, name VARCHAR(80) NOT NULL, role VARCHAR(40) NOT NULL, instructions {TEXT}, provider VARCHAR(20) NOT NULL, model VARCHAR(60) NOT NULL, effort VARCHAR(10) NOT NULL DEFAULT 'medium', tools VARCHAR(500) NOT NULL DEFAULT '', color VARCHAR(7) NOT NULL DEFAULT '#5fe3cf', shared INTEGER NOT NULL DEFAULT 1, share_token VARCHAR(48), brief_hour INTEGER, brief_last VARCHAR(10), status VARCHAR(20) NOT NULL DEFAULT 'active', created_at {TS} NOT NULL, updated_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE assistant_docs (id {PK}, assistant_id {ID} NOT NULL, title VARCHAR(200) NOT NULL, source VARCHAR(20) NOT NULL, content {TEXT} NOT NULL, chars INTEGER NOT NULL, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX assistant_docs_a ON assistant_docs (assistant_id)",
                "CREATE TABLE assistant_memory (id {PK}, assistant_id {ID} NOT NULL, fact VARCHAR(500) NOT NULL, created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE assistant_chats (id {PK}, public_id VARCHAR(40) NOT NULL UNIQUE, assistant_id {ID} NOT NULL, user_id {ID}, guest VARCHAR(120), title VARCHAR(160) NOT NULL, created_at {TS} NOT NULL, updated_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX assistant_chats_a ON assistant_chats (assistant_id, updated_at)",
                "CREATE TABLE assistant_messages (id {PK}, chat_id {ID} NOT NULL, role VARCHAR(12) NOT NULL, content {TEXT} NOT NULL, actions {TEXT}, amount {MONEY} NOT NULL DEFAULT 0, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX assistant_messages_c ON assistant_messages (chat_id, id)",
                "CREATE TABLE assistant_actions (id {PK}, assistant_id {ID} NOT NULL, chat_id {ID}, kind VARCHAR(20) NOT NULL, payload {TEXT} NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', result VARCHAR(255), decided_by {ID}, created_at {TS} NOT NULL, decided_at {TS}){ENGINE}",
                "CREATE TABLE projects (id {PK}, org_id {ID} NOT NULL, name VARCHAR(120) NOT NULL, description {TEXT}, status VARCHAR(20) NOT NULL DEFAULT 'active', due_on VARCHAR(10), created_at {TS} NOT NULL){ENGINE}",
                "CREATE TABLE tasks (id {PK}, org_id {ID} NOT NULL, project_id {ID}, title VARCHAR(200) NOT NULL, notes {TEXT}, status VARCHAR(10) NOT NULL DEFAULT 'todo', priority VARCHAR(10) NOT NULL DEFAULT 'normal', due_on VARCHAR(10), assignee_id {ID}, created_by VARCHAR(60), created_at {TS} NOT NULL, done_at {TS}){ENGINE}",
                "CREATE INDEX tasks_org ON tasks (org_id, status, due_on)",
                "CREATE TABLE reminders (id {PK}, org_id {ID} NOT NULL, assistant_id {ID}, user_id {ID}, message VARCHAR(500) NOT NULL, channel VARCHAR(10) NOT NULL DEFAULT 'email', due_at {TS} NOT NULL, sent_at {TS}, created_at {TS} NOT NULL){ENGINE}",
                "CREATE INDEX reminders_due ON reminders (sent_at, due_at)",
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
        if ($house = DB::one('SELECT id FROM orgs WHERE is_house = 1')) {
            foreach (array_keys(Services::sellable()) as $svc) if (Services::status((int) $house['id'], $svc) !== 'active') Services::activate((int) $house['id'], $svc, true);
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
