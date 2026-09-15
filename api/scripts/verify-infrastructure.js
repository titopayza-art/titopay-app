const { pool } = require("../src/db/pool");
const { config } = require("../src/config/env");

const API_BASE = process.env.VERIFY_API_BASE || `http://${config.apiHost}:${config.apiPort}`;

const requiredTables = [
  "admin_users",
  "users",
  "wallets",
  "merchants",
  "qr_codes",
  "transactions",
  "sessions",
  "otp_codes",
  "audit_logs"
];

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function verifyDatabase() {
  const version = await pool.query("SELECT version() AS version");
  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1)
     ORDER BY table_name`,
    [requiredTables]
  );
  const found = new Set(tables.rows.map((row) => row.table_name));
  const missing = requiredTables.filter((table) => !found.has(table));
  if (missing.length) {
    throw new Error(`Missing required tables: ${missing.join(", ")}`);
  }
  return { postgres: version.rows[0].version, tables: requiredTables };
}

async function verifyCustomerAuth() {
  if (!process.env.VERIFY_CUSTOMER_IDENTIFIER || !process.env.VERIFY_CUSTOMER_PASSWORD) {
    return { skipped: true, reason: "Set VERIFY_CUSTOMER_IDENTIFIER and VERIFY_CUSTOMER_PASSWORD to test customer auth" };
  }
  const login = await request("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: process.env.VERIFY_CUSTOMER_IDENTIFIER,
      password: process.env.VERIFY_CUSTOMER_PASSWORD,
      deviceName: "Infrastructure Verification",
      platform: "server"
    })
  });
  if (!login.accessToken || !login.refreshToken) {
    throw new Error("Customer JWT login did not return access and refresh tokens");
  }
  const me = await request("/v1/auth/me", {
    headers: { authorization: `Bearer ${login.accessToken}` }
  });
  return { login, me };
}

async function verifyAdminAuthAndRbac() {
  if (!process.env.VERIFY_ADMIN_IDENTIFIER || !process.env.VERIFY_ADMIN_PASSWORD) {
    return { skipped: true, reason: "Set VERIFY_ADMIN_IDENTIFIER and VERIFY_ADMIN_PASSWORD to test admin auth and RBAC" };
  }
  const challenge = await request("/v1/admin/login", {
    method: "POST",
    body: JSON.stringify({
      identifier: process.env.VERIFY_ADMIN_IDENTIFIER,
      password: process.env.VERIFY_ADMIN_PASSWORD
    })
  });
  if (challenge.accessToken && challenge.user?.role) {
    const adminMe = await request("/v1/admin/me", {
      headers: { authorization: `Bearer ${challenge.accessToken}` }
    });
    const security = await request("/v1/admin/security", {
      headers: { authorization: `Bearer ${challenge.accessToken}` }
    });
    return { login: challenge, adminMe, security, otpBypassedForUat: challenge.otpRequired === false };
  }
  if (!challenge.challengeId && !challenge.adminId) {
    throw new Error("Admin login did not return an OTP challenge or JWT session");
  }
  if (!process.env.VERIFY_ADMIN_OTP) {
    return {
      skippedVerification: true,
      challenge,
      reason: "Set VERIFY_ADMIN_OTP to the delivered OTP to complete admin JWT and RBAC verification"
    };
  }
  const verified = await request("/v1/admin/login/verify", {
    method: "POST",
    body: JSON.stringify({
      adminId: challenge.adminId,
      challengeId: challenge.challengeId,
      otp: process.env.VERIFY_ADMIN_OTP,
      deviceName: "Infrastructure Verification",
      platform: "server"
    })
  });
  const adminMe = await request("/v1/admin/me", {
    headers: { authorization: `Bearer ${verified.accessToken}` }
  });
  const security = await request("/v1/admin/security", {
    headers: { authorization: `Bearer ${verified.accessToken}` }
  });
  return { challenge, verified, adminMe, security };
}

async function verifyQr(customerToken) {
  const qr = await request("/v1/qr/generate-dynamic", {
    method: "POST",
    headers: { authorization: `Bearer ${customerToken}` },
    body: JSON.stringify({
      amount: 10,
      label: "Infrastructure verification QR"
    })
  });
  if (!qr.qr?.imageDataUrl || !qr.qr?.id) {
    throw new Error("QR generation did not return image data and QR id");
  }
  const payment = process.env.VERIFY_QR_PAYMENT === "true"
    ? await request("/v1/qr/pay", {
        method: "POST",
        headers: { authorization: `Bearer ${customerToken}` },
        body: JSON.stringify({
          qrId: qr.qr.id,
          amount: Number(process.env.VERIFY_QR_PAYMENT_AMOUNT || 10)
        })
      })
    : { skipped: true, reason: "Set VERIFY_QR_PAYMENT=true with a funded verification wallet to test QR payment settlement" };
  const history = await request("/v1/qr/history", {
    headers: { authorization: `Bearer ${customerToken}` }
  });
  return { qr, payment, history };
}

async function verifyAuditLogs() {
  const result = await pool.query("SELECT COUNT(*)::INT AS count FROM audit_logs");
  if (result.rows[0].count < 1) {
    throw new Error("Audit logging did not record verification activity");
  }
  return result.rows[0].count;
}

async function main() {
  const report = {
    node: process.version,
    apiBase: API_BASE,
    database: await verifyDatabase()
  };
  const customer = await verifyCustomerAuth();
  report.authentication = {
    skipped: Boolean(customer.skipped),
    customerJwt: Boolean(customer.login?.accessToken),
    customerMe: customer.me?.user?.email || null,
    reason: customer.reason || null
  };
  const admin = await verifyAdminAuthAndRbac();
  report.admin = {
    skipped: Boolean(admin.skipped),
    skippedVerification: Boolean(admin.skippedVerification),
    otp: Boolean(admin.challenge?.challengeId),
    jwt: Boolean(admin.verified?.accessToken),
    role: admin.adminMe?.admin?.role,
    rbacSecurityRoute: Boolean(admin.security?.ok),
    reason: admin.reason || null
  };
  if (customer.login?.accessToken) {
    const qr = await verifyQr(customer.login.accessToken);
    report.qr = {
      generated: Boolean(qr.qr?.id),
      paid: qr.payment.status === "completed",
      paymentSkipped: Boolean(qr.payment.skipped),
      historyCount: qr.history.history?.length || 0
    };
  } else {
    report.qr = { skipped: true, reason: "Customer verification credentials are required to test QR payment" };
  }
  report.auditLogs = await verifyAuditLogs();
  report.status = "passed";
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ status: "failed", error: error.message }, null, 2));
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
