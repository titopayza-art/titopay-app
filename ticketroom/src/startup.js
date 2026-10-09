// Start-up checks for a production host (including cPanel shared hosting):
// database reachable and new enough, migrations applied, first admin present.
const config = require("./config");
const db = require("./lib/db");
const { hashSecret } = require("./lib/crypto");

async function checkDatabase() {
  const { rows } = await db.query("SELECT current_setting('server_version_num')::int AS v, current_setting('server_version') AS label");
  if (rows[0].v < 130000) {
    throw new Error(`PostgreSQL ${rows[0].label} is too old. TicketRoom needs PostgreSQL 13 or newer (16 recommended). See AFRIHOST-SETUP for database options.`);
  }
  return rows[0].label;
}

// Creates the first platform admin from ADMIN_EMAIL / ADMIN_PASSWORD, only if
// no admin exists. Afterwards remove ADMIN_PASSWORD from the configuration.
async function bootstrapAdmin(log = console.log) {
  const { email, password, name } = config.bootstrapAdmin;
  if (!email || !password) return null;
  const { rows: admins } = await db.query("SELECT 1 FROM tr.platform_roles WHERE role = 'admin' LIMIT 1");
  if (admins[0]) return null;
  if (password.length < 10) throw new Error("ADMIN_PASSWORD must be at least 10 characters");
  return db.withTx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (email, full_name, password_hash, email_verified_at) VALUES (lower($1), $2, $3, now())
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active' RETURNING id`,
      [email, name, hashSecret(password)]);
    for (const role of ["admin", "finance"]) await c.query("INSERT INTO platform_roles (user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING", [rows[0].id, role]);
    await require("./lib/audit").record(c, { action: "admin.bootstrapped", entityType: "user", entityId: rows[0].id, details: { email } });
    log(`Created first admin account ${email}. Sign in, change the password, then remove ADMIN_PASSWORD from the configuration.`);
    return rows[0].id;
  });
}

async function run({ migrate = process.env.MIGRATE_ON_START === "true", log = console.log } = {}) {
  const version = await checkDatabase();
  log(`Database OK (PostgreSQL ${version})`);
  if (migrate) await require("./db/migrate").up({ log });
  await bootstrapAdmin(log);
  await require("./modules/site/assistant").ensureDefaults();
  if (config.isProd && config.publicBaseUrl.startsWith("http://")) log("WARNING: PUBLIC_BASE_URL is http://. Enable SSL (cPanel → SSL/TLS Status → Run AutoSSL) — sign-in cookies require HTTPS.");
  if (config.payments.provider === "none") log("Card payments are OFF (PAYMENT_PROVIDER=none): paid tickets cannot be sold until a gateway is configured.");
}

module.exports = { run, checkDatabase, bootstrapAdmin };
