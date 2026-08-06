/* Deterministic TitoPay admin API stub plus static file server for the admin
   console suite. Serves the /admin folder and a /v1 API from one origin, so
   the console's own CSP (connect-src 'self') is exercised exactly as deployed.
   Every payload is derived from a fixed clock and a seeded generator: two runs
   in two processes return identical bytes, which is what lets the suite assert
   on content without flaking. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "admin");
const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 6, 3, 0, 0);

let seedState = 42;
const reseed = (seed) => { seedState = seed; };
const rnd = () => { seedState = (seedState * 1103515245 + 12345) % 2147483648; return seedState / 2147483648; };
const pick = (list) => list[Math.floor(rnd() * list.length)];

const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".txt": "text/plain; charset=utf-8" };

reseed(1001);
const users = Array.from({ length: 120 }, (_, index) => ({
  id: `usr_${index}`,
  full_name: `Customer ${index}`,
  username: `customer${index}`,
  email: `customer${index}@example.co.za`,
  phone: `+2782000${String(index).padStart(4, "0")}`,
  account_type: rnd() > 0.75 ? "business" : "personal",
  status: rnd() > 0.94 ? "suspended" : "active",
  fica_status: rnd() > 0.35 ? "verified" : "pending",
  profile_locked: rnd() > 0.93,
  wallet_id: `TP${100000 + index}`,
  created_at: new Date(NOW - Math.floor(rnd() * 200) * DAY).toISOString(),
  last_seen_at: new Date(NOW - Math.floor(rnd() * 30) * DAY).toISOString(),
}));

reseed(2002);
const merchants = Array.from({ length: 24 }, (_, index) => ({
  id: `mer_${index}`,
  merchant_number: `M${5000 + index}`,
  business_name: `Merchant ${index} Trading`,
  username: `merchant${index}`,
  email: `merchant${index}@example.co.za`,
  verification_status: rnd() > 0.3 ? "verified" : "pending",
  status: "active",
  created_at: new Date(NOW - Math.floor(rnd() * 180) * DAY).toISOString(),
}));

reseed(3003);
const wallets = Array.from({ length: 120 }, (_, index) => ({
  id: `wal_${index}`,
  wallet_number: `TP${100000 + index}`,
  account_type: index % 5 === 0 ? "business" : "personal",
  kind: index > 116 ? "revenue" : index % 5 === 0 ? "merchant" : "personal",
  available_balance: Math.round(rnd() * 250000) / 10,
  reserved_balance: Math.round(rnd() * 4000) / 10,
  status: "active",
  verification: "verified",
  risk_rating: pick(["low", "low", "medium", "high"]),
  created_at: new Date(NOW - Math.floor(rnd() * 200) * DAY).toISOString(),
}));

reseed(4004);
const transactions = Array.from({ length: 600 }, (_, index) => {
  const created = NOW - Math.floor(rnd() * 90) * DAY - Math.floor(rnd() * DAY);
  const amount = Math.round(rnd() * 500000) / 100;
  const fee = Math.round(amount * 1.9) / 100;
  const status = pick(["completed", "completed", "completed", "completed", "failed", "pending", "reversed"]);
  return {
    id: `txn_${index}`,
    reference: `TP-${200000 + index}`,
    created_at: new Date(created).toISOString(),
    amount,
    fee,
    total: Math.round((amount + fee) * 100) / 100,
    revenue_recorded: status === "completed" ? fee : 0,
    service_code: pick(["QR_PAYMENT", "WALLET_TRANSFER", "MERCHANT_PAYMENT", "WITHDRAWAL", "DEPOSIT", "SETTLEMENT"]),
    service_name: "Service",
    status,
    owner_name: `Customer ${index % 120}`,
    owner_identifier: `customer${index % 120}`,
    wallet_number: `TP${100000 + (index % 120)}`,
    reconciliation_status: rnd() > 0.95 ? "review" : "settled",
    merchant_number: index % 4 === 0 ? `M${5000 + (index % 24)}` : undefined,
  };
});

reseed(6006);
const securityEvents = Array.from({ length: 80 }, (_, index) => ({
  id: `evt_${index}`,
  actor_type: "customer",
  action: rnd() > 0.6 ? "login_failed" : "login_success",
  created_at: new Date(NOW - Math.floor(rnd() * 30) * DAY).toISOString(),
}));

const session = {
  accessToken: "stub-access",
  refreshToken: "stub-refresh",
  admin: { id: "adm_1", role: "owner", fullName: "Platform Owner" },
  session: { id: "sess_1" },
  sessionIdleTimeoutSeconds: 900,
};

const ROUTES = {
  "/v1/admin/login": () => session,
  "/v1/auth/email-otp/verify": () => session,
  "/v1/auth/password-reset": () => ({ ok: true }),
  "/v1/admin/me": () => ({ id: "adm_1", role: "owner", fullName: "Platform Owner", username: "owner", permissions: ["*"], position: "Platform Owner", session: { id: "sess_1" }, sessionIdleTimeoutSeconds: 900 }),
  "/v1/admin/dashboard/overview": () => ({ users: users.length, merchants: merchants.length, transactions: transactions.length, revenue: 184320.55, lockedProfiles: users.filter((row) => row.profile_locked).length, pendingCompliance: 7 }),
  "/v1/admin/users": () => ({ items: users }),
  "/v1/admin/merchants": () => ({ items: merchants }),
  "/v1/admin/wallets": () => ({ items: wallets }),
  "/v1/admin/transactions": (url) => {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = Number(url.searchParams.get("limit") || 500);
    let rows = transactions;
    if (from) rows = rows.filter((row) => row.created_at.slice(0, 10) >= from);
    if (to) rows = rows.filter((row) => row.created_at.slice(0, 10) <= to);
    return { items: rows.slice(0, limit) };
  },
  "/v1/admin/revenue": () => ({
    wallet: { available_balance: 482910.44, currency: "ZAR" },
    byService: ["QR_PAYMENT", "WALLET_TRANSFER", "SETTLEMENT"].map((code, index) => ({ service_type: code, total: 100000 * (index + 1) })),
    daily: Array.from({ length: 30 }, (_, index) => ({ day: new Date(NOW - (29 - index) * DAY).toISOString().slice(0, 10), total: 5000 + index * 100 })),
  }),
  "/v1/admin/compliance/queue": () => ({ items: Array.from({ length: 10 }, (_, index) => ({ id: `rev_${index}`, full_name: `Customer ${index}`, username: `customer${index}`, account_type: "personal", review_type: "FICA", status: index < 5 ? "pending" : "approved", notes: "" })) }),
  "/v1/admin/support/tickets": () => ({ items: Array.from({ length: 12 }, (_, index) => ({ id: `tkt_${index}`, subject: `Request ${index}`, category: "Payments", message: "Reported issue.", full_name: `Customer ${index}`, username: `customer${index}`, assigned_to: index % 3 ? "agent1" : "", status: index % 3 === 0 ? "open" : "resolved", created_at: new Date(NOW - index * DAY).toISOString() })) }),
  "/v1/admin/support/conversations": () => ({ items: Array.from({ length: 8 }, (_, index) => ({ id: `cnv_${index}`, status: index % 2 ? "RESOLVED" : "ESCALATED", created_at: new Date(NOW - index * DAY).toISOString(), updated_at: new Date(NOW - index * DAY).toISOString(), last_message: "Thanks", waitingSeconds: 60 * index })), counts: { waiting: 4, active: 2 } }),
  "/v1/admin/profile-change-requests": () => ({ items: [], metrics: {} }),
  "/v1/admin/security": () => ({
    otpPolicy: { authenticationMode: "password_only", otpRequired: false },
    smtp: {},
    emailTemplates: [],
    loginAttempts: securityEvents,
    otpLogs: [],
    profileLockEvents: securityEvents.slice(0, 10),
    adminSessions: Array.from({ length: 6 }, (_, index) => ({ id: `sess_${index}`, full_name: `Operator ${index % 3}`, email: `op${index % 3}@titopay.co.za`, device_name: `Device ${index % 2}`, platform: "Windows", last_activity_at: new Date(NOW - index * 3600000).toISOString(), revoked_at: index > 4 ? new Date(NOW).toISOString() : null })),
  }),
  "/v1/admin/module-health": () => ({ apiBase: "/v1", tables: ["users", "wallets", "transactions", "merchants", "audit_log"].map((name) => ({ table_name: name, exists: true })) }),
  "/v1/admin/audit": () => ({ items: Array.from({ length: 20 }, (_, index) => ({ id: `aud_${index}`, actor_type: "admin", actor_id: "adm_1", action: index % 4 === 0 ? "fraud_alert_raised" : "user_suspend", target_type: "user", target_id: `usr_${index}`, created_at: new Date(NOW - index * 3600000).toISOString() })) }),
};

function startAdminStub(port) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith("/v1/")) {
      // Conversation context is path-parameterised; everything else is exact.
      const contextMatch = url.pathname.match(/^\/v1\/admin\/support\/conversations\/([^/]+)\/context$/);
      if (contextMatch) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          conversation: { id: contextMatch[1], status: "AGENT_ACTIVE", customer: { username: "customer1" } },
          messages: [
            { sender: "CUSTOMER", message: "Hi, I need help with a payment.", createdAt: new Date(NOW - 600000).toISOString() },
            { sender: "AGENT", message: "Taking a look now.", createdAt: new Date(NOW - 300000).toISOString() },
          ],
          notes: [],
        }));
        return;
      }
      const handler = ROUTES[url.pathname];
      if (!handler) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(handler(url)));
      return;
    }
    let filePath = path.join(ROOT, url.pathname);
    if (url.pathname.endsWith("/")) filePath = path.join(filePath, "index.html");
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      const candidate = path.join(ROOT, url.pathname, "index.html");
      filePath = fs.existsSync(candidate) ? candidate : path.join(ROOT, "index.html");
    }
    response.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

module.exports = { startAdminStub };
