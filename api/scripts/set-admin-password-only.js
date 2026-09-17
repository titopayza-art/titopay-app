const { pool } = require("../src/db/pool");

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::JSONB,
      updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ('admin_authentication', '{"mode":"password_only"}'::JSONB, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     RETURNING key, value, updated_at`
  );

  const expired = await pool.query(
    `UPDATE otp_codes
     SET expires_at = NOW()
     WHERE user_type = 'admin'
       AND purpose = 'admin_login'
       AND used_at IS NULL
       AND expires_at > NOW()`
  );

  console.log(JSON.stringify({
    ok: true,
    setting: rows[0],
    expiredAdminOtpChallenges: expired.rowCount
  }, null, 2));
  await pool.end();
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
