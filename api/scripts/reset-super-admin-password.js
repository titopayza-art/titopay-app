const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");
const { forceAdminPasswordOnlyPolicy } = require("../src/services/platform-settings-service");

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function assertStrongPassword(password) {
  const valid =
    password.length >= 14 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password);
  if (!valid) {
    throw new Error("ADMIN_PASSWORD must be at least 14 characters and include upper, lower, number and symbol characters");
  }
}

async function main() {
  const fullName = (process.env.ADMIN_FULL_NAME || "TitoPay CEO").trim();
  const username = (process.env.ADMIN_USERNAME || "ceo").trim().toLowerCase();
  const email = (process.env.ADMIN_EMAIL || "ceo@titopay.co.za").trim().toLowerCase();
  const password = required("ADMIN_PASSWORD");
  const role = "super_admin";

  assertStrongPassword(password);
  const passwordHash = await hashPassword(password);

  await pool.query("BEGIN");
  try {
    const existing = await pool.query(
      `SELECT id
       FROM admin_users
       WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)
       ORDER BY
         CASE WHEN LOWER(email) = LOWER($1) THEN 0 ELSE 1 END,
         CASE WHEN status = 'active' THEN 0 ELSE 1 END,
         updated_at DESC,
         created_at DESC`,
      [email, username]
    );

    let result;
    if (existing.rows.length) {
      const ids = existing.rows.map((row) => row.id);
      result = await pool.query(
        `UPDATE admin_users
         SET full_name = $2,
             username = $3,
             email = $4,
             role = $5,
             password_hash = $6,
             status = 'active',
             failed_login_attempts = 0,
             locked_until = NULL,
             last_failed_login_at = NULL,
             updated_at = NOW()
         WHERE id = ANY($1::uuid[])
         RETURNING id, full_name, username, email, role, status`,
        [ids, fullName, username, email, role, passwordHash]
      );
    } else {
      result = await pool.query(
        `INSERT INTO admin_users
          (id, full_name, username, email, role, password_hash, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active')
         RETURNING id, full_name, username, email, role, status`,
        [uuidv4(), fullName, username, email, role, passwordHash]
      );
    }

    await pool.query(
      `UPDATE otp_codes
       SET expires_at = NOW()
       WHERE user_type = 'admin'
         AND purpose = 'admin_login'
         AND used_at IS NULL
         AND expires_at > NOW()`
    );

    await pool.query("COMMIT");
    await forceAdminPasswordOnlyPolicy("super_admin_reset_script");
    console.log(JSON.stringify({
      ok: true,
      admin: result.rows[0],
      synchronizedAdminRows: result.rowCount,
      authMode: "password_only"
    }, null, 2));
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
