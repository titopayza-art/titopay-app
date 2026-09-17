const { pool } = require("../src/db/pool");
const { verifyPassword } = require("../src/lib/passwords");
const { login } = require("../src/services/auth-service");
const { getAdminAuthenticationPolicy } = require("../src/services/platform-settings-service");

function required(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

async function main() {
  const identifier = (process.env.ADMIN_IDENTIFIER || "ceo@titopay.co.za").trim();
  const password = required("ADMIN_PASSWORD");
  const adminEmail = identifier.toLowerCase();
  const adminUsername = identifier.replace(/^@/, "").toLowerCase();

  const { rows } = await pool.query(
    `SELECT id, full_name, username, email, role, status, password_hash, failed_login_attempts, locked_until
     FROM admin_users
     WHERE LOWER(email) = $1 OR LOWER(username) = $2
     ORDER BY
       CASE WHEN LOWER(email) = $1 THEN 0 ELSE 1 END,
       CASE WHEN status = 'active' THEN 0 ELSE 1 END,
       updated_at DESC,
       created_at DESC
     LIMIT 1`,
    [adminEmail, adminUsername]
  );
  const admin = rows[0] || null;
  const passwordMatches = admin ? await verifyPassword(password, admin.password_hash) : false;
  const policy = await getAdminAuthenticationPolicy();

  let loginResult = null;
  let loginError = null;
  if (admin && passwordMatches) {
    try {
      loginResult = await login(
        {
          identifier,
          password,
          scope: "admin",
          deviceName: "Admin diagnostic",
          platform: "server"
        },
        {
          ipAddress: "127.0.0.1",
          userAgent: "titopay-admin-diagnostic"
        }
      );
    } catch (error) {
      loginError = { message: error.message, status: error.status || error.statusCode || 500 };
    }
  }

  console.log(JSON.stringify(
    {
      ok: Boolean(loginResult?.accessToken),
      adminUserFound: Boolean(admin),
      identifier,
      passwordHashPresent: Boolean(admin?.password_hash),
      passwordHashLength: admin?.password_hash?.length || 0,
      passwordMatches,
      role: admin?.role || null,
      status: admin?.status || null,
      lockedUntil: admin?.locked_until || null,
      authenticationPolicy: policy,
      sessionCreated: Boolean(loginResult?.accessToken && loginResult?.refreshToken),
      authMode: loginResult?.auth_mode || loginResult?.authenticationMode || null,
      otpRequired: Boolean(loginResult?.otpRequired || loginResult?.otp_required),
      loginError
    },
    null,
    2
  ));

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
