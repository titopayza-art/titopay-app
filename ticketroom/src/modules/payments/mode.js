// Test payments in one click (Admin portal → Integrations). The card provider
// normally comes from the configuration (PAYMENT_PROVIDER and the provider's
// own settings). An admin can switch to a test setup instead:
//   "ticketroom" TicketRoom's own sandbox: works anywhere, no provider account.
//   "payfast"    PayFast's shared sandbox account (published by PayFast for
//                testing; no real money moves).
// The choice is kept in platform_meta so it survives a restart, and can be
// switched off again to return to the configured provider.
const config = require("../../config");
const db = require("../../lib/db");

const KEY = "payments_override";
// PayFast's public sandbox merchant (from PayFast's developer documentation).
const PAYFAST_SANDBOX = {
  env: "sandbox", merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "jt7NOE43FZPn",
  processUrl: "https://sandbox.payfast.co.za/eng/process", validateUrl: "https://sandbox.payfast.co.za/eng/query/validate",
};

// What the configuration said before any override, to go back to.
let configured = null;
let active = null;
const snapshot = () => {
  if (!configured) configured = { provider: config.payments.provider, payfast: { ...config.integrations.payfast } };
};

function apply(override) {
  snapshot();
  active = override ? override.kind : null;
  if (!override) {
    config.payments.provider = configured.provider;
    Object.assign(config.integrations.payfast, configured.payfast);
    return;
  }
  if (override.kind === "payfast") {
    Object.assign(config.integrations.payfast, PAYFAST_SANDBOX);
    config.payments.provider = "payfast";
  } else {
    config.payments.provider = "sandbox";
  }
}

// Called once at start-up.
async function load() {
  const { rows } = await db.query("SELECT value FROM platform_meta WHERE key = $1", [KEY]);
  let override = null;
  try { override = rows[0] ? JSON.parse(rows[0].value) : null; } catch { override = null; }
  apply(override);
  return override;
}

async function useSandbox(q, kind) {
  const override = { kind: kind === "payfast" ? "payfast" : "ticketroom" };
  await q.query(
    `INSERT INTO platform_meta (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [KEY, JSON.stringify(override)]);
  apply(override);
  return override;
}

async function clear(q) {
  await q.query("DELETE FROM platform_meta WHERE key = $1", [KEY]);
  apply(null);
}

// The override in force, if any (for the admin portal).
const current = () => active;

module.exports = { load, useSandbox, clear, current, PAYFAST_SANDBOX };
