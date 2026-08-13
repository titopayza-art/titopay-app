"use strict";

// TitoKids — TitoPay's family money platform, built on the systems the app
// already trusts. A child's wallet is a REAL wallet (kind 'system', no wallet
// number, owned by the parent's account): funding and spending move through
// the same ledger as every other rand, so balances, activity and limits are
// read from recorded truth, never a parallel tally.
//
// Money paths (all inside this service, all conserving):
//   fund     parent wallet  -> child wallet   (optionally toward a goal)
//   pay      child wallet   -> a TitoPay recipient, category-checked
// A linked child (their own TitoPay login) can REQUEST money; the parent
// approves or declines, and approval executes the funding transfer. Children
// never touch parental controls, and nothing about a child is visible to any
// other account.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { createNotification } = require("./notification-service");
const { writeAuditLog } = require("./audit-service");

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const CATEGORIES = ["school", "food", "transport", "airtime_data", "shopping", "pocket_money", "savings", "entertainment", "other"];
const CATEGORY_LABELS = {
  school: "School", food: "Food", transport: "Transport", airtime_data: "Airtime & Data",
  shopping: "Shopping", pocket_money: "Pocket Money", savings: "Savings", entertainment: "Entertainment", other: "Other"
};
const RELATIONSHIPS = ["parent", "guardian", "other"];

let schemaReady = null;
function ensureTitoKidsSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS titokids_children (
          id UUID PRIMARY KEY,
          parent_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          child_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
          full_name TEXT NOT NULL,
          date_of_birth DATE,
          relationship TEXT NOT NULL DEFAULT 'parent' CHECK (relationship IN ('parent','guardian','other')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_titokids_child_link
         ON titokids_children (parent_user_id, child_user_id)
         WHERE child_user_id IS NOT NULL AND status = 'active'`
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS titokids_limits (
          child_id UUID PRIMARY KEY REFERENCES titokids_children(id) ON DELETE CASCADE,
          daily_limit NUMERIC(18,2),
          weekly_limit NUMERIC(18,2),
          monthly_limit NUMERIC(18,2),
          approval_threshold NUMERIC(18,2),
          categories JSONB NOT NULL DEFAULT '{}'::JSONB,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS titokids_requests (
          id UUID PRIMARY KEY,
          child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
          requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          amount NUMERIC(18,2) NOT NULL,
          category TEXT NOT NULL DEFAULT 'other',
          note TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','declined')),
          decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
          decided_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS titokids_goals (
          id UUID PRIMARY KEY,
          child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          target_amount NUMERIC(18,2) NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function loadOwnChild(parentUserId, childId, { forUpdate = false, client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT c.*, u.username AS child_username, u.full_name AS child_account_name, u.email AS child_email
     FROM titokids_children c
     LEFT JOIN users u ON u.id = c.child_user_id
     WHERE c.id = $1 AND c.parent_user_id = $2 AND c.status = 'active'
     LIMIT 1${forUpdate ? " FOR UPDATE OF c" : ""}`,
    [childId, parentUserId]
  );
  if (!rows[0]) throw new AppError(404, "Child not found");
  return rows[0];
}

async function walletBalance(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return money(rows[0]?.available_balance);
}

// Everything that ever moved through the child's wallet, straight from the
// ledger — the same rows the parent's own statement is built from.
async function childActivity(walletId, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT wl.id, wl.entry_type, wl.amount, wl.balance_after, wl.reference, wl.metadata, wl.created_at
     FROM wallet_ledger wl
     WHERE wl.wallet_id = $1
     ORDER BY wl.created_at DESC
     LIMIT $2`,
    [walletId, Math.min(Math.max(Number(limit) || 100, 1), 300)]
  );
  return rows.map((row) => ({
    id: row.id,
    direction: row.entry_type === "credit" ? "in" : "out",
    amount: money(row.amount),
    category: row.metadata?.category || (row.entry_type === "credit" ? "funding" : "other"),
    categoryLabel: row.metadata?.category ? (CATEGORY_LABELS[row.metadata.category] || row.metadata.category) : (row.entry_type === "credit" ? "Parent funding" : "Other"),
    note: row.metadata?.note || "",
    recipient: row.metadata?.recipientName || "",
    goalId: row.metadata?.goalId || null,
    reference: row.reference,
    createdAt: row.created_at
  }));
}

function shapeLimits(row) {
  return {
    dailyLimit: row?.daily_limit === null || row?.daily_limit === undefined ? null : money(row.daily_limit),
    weeklyLimit: row?.weekly_limit === null || row?.weekly_limit === undefined ? null : money(row.weekly_limit),
    monthlyLimit: row?.monthly_limit === null || row?.monthly_limit === undefined ? null : money(row.monthly_limit),
    approvalThreshold: row?.approval_threshold === null || row?.approval_threshold === undefined ? null : money(row.approval_threshold),
    categories: CATEGORIES.reduce((output, key) => {
      const stored = row?.categories?.[key];
      output[key] = stored === undefined ? true : Boolean(stored);
      return output;
    }, {})
  };
}

async function childLimits(childId) {
  const { rows } = await pool.query("SELECT * FROM titokids_limits WHERE child_id = $1", [childId]);
  return shapeLimits(rows[0]);
}

// Spending already recorded in the window, from the ledger, so a cap can be
// enforced against truth. Days and months are calendar (SAST is UTC+2 all
// year; windows use UTC dates for determinism).
async function spentInWindows(walletId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0) AS day,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0) AS week,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS month
     FROM wallet_ledger
     WHERE wallet_id = $1 AND entry_type = 'debit'`,
    [walletId]
  );
  return { day: money(rows[0].day), week: money(rows[0].week), month: money(rows[0].month) };
}

function shapeChild(row, extras = {}) {
  return {
    id: row.id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth,
    relationship: row.relationship,
    linked: Boolean(row.child_user_id),
    childUsername: row.child_username || "",
    status: row.status,
    createdAt: row.created_at,
    ...extras
  };
}

async function listChildren(parentUserId) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT c.*, u.username AS child_username, w.available_balance
     FROM titokids_children c
     LEFT JOIN users u ON u.id = c.child_user_id
     JOIN wallets w ON w.id = c.wallet_id
     WHERE c.parent_user_id = $1 AND c.status = 'active'
     ORDER BY c.created_at ASC
     LIMIT 20`,
    [parentUserId]
  );
  const { rows: pending } = await pool.query(
    `SELECT r.child_id, COUNT(*)::int AS count
     FROM titokids_requests r
     JOIN titokids_children c ON c.id = r.child_id AND c.parent_user_id = $1
     WHERE r.status = 'requested'
     GROUP BY r.child_id`,
    [parentUserId]
  );
  const pendingByChild = Object.fromEntries(pending.map((row) => [row.child_id, row.count]));
  return rows.map((row) => shapeChild(row, {
    balance: money(row.available_balance),
    pendingRequests: pendingByChild[row.id] || 0
  }));
}

async function addChild(parentUserId, payload = {}) {
  await ensureTitoKidsSchema();
  const { rows: parents } = await pool.query("SELECT id, account_type, full_name FROM users WHERE id = $1", [parentUserId]);
  if (!parents[0]) throw new AppError(404, "Account not found");
  const fullName = boundedText(payload.fullName || payload.name, "Child's name", { min: 2, max: 120 });
  const relationship = RELATIONSHIPS.includes(String(payload.relationship)) ? String(payload.relationship) : "parent";
  let dateOfBirth = null;
  if (payload.dateOfBirth) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.dateOfBirth))) throw new AppError(400, "Enter the date of birth as YYYY-MM-DD");
    dateOfBirth = String(payload.dateOfBirth);
  }

  // Optional link: the child's own TitoPay account, by @username / email /
  // phone. Linking is what gives the child their Family view and requests.
  let childUser = null;
  if (payload.childIdentifier) {
    const { resolveStaffUser } = require("./business-staff-service");
    childUser = await resolveStaffUser(payload.childIdentifier);
    if (!childUser) throw new AppError(404, `No TitoPay account matches "${String(payload.childIdentifier).trim()}". Leave it blank to add the child without a linked account.`);
    if (childUser.id === parentUserId) throw new AppError(400, "That is your own account — enter the child's TitoPay details.");
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM titokids_children WHERE parent_user_id = $1 AND child_user_id = $2 AND status = 'active'",
      [parentUserId, childUser.id]
    );
    if (existing[0]) throw new AppError(409, "That child is already linked to your TitoKids.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const walletId = uuidv4();
    // A real wallet, deliberately outside every external lookup: kind
    // 'system' and no wallet number, so nothing but TitoKids can reach it.
    await client.query(
      `INSERT INTO wallets (id, user_id, kind, currency, available_balance, reserved_balance, status)
       VALUES ($1, $2, 'system', 'ZAR', 0, 0, 'active')`,
      [walletId, parentUserId]
    );
    const childId = uuidv4();
    const { rows } = await client.query(
      `INSERT INTO titokids_children (id, parent_user_id, child_user_id, wallet_id, full_name, date_of_birth, relationship)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [childId, parentUserId, childUser?.id || null, walletId, fullName, dateOfBirth, relationship]
    );
    await client.query("INSERT INTO titokids_limits (child_id) VALUES ($1) ON CONFLICT DO NOTHING", [childId]);
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: "customer", actorId: parentUserId, action: "titokids_child_added",
      entityType: "titokids_child", entityId: childId, metadata: { linked: Boolean(childUser) }
    }).catch(() => {});
    if (childUser) {
      await createNotification({
        user: { id: childUser.id, user_type: "customer" },
        channel: "in_app", notificationType: "titokids_linked", provider: "in_app",
        title: "You joined a family on TitoKids",
        body: `${parents[0].full_name || "A parent"} linked you on TitoKids. Open My Family on your profile to see your balance and ask for money when you need it.`,
        metadata: { childId, clientNotificationId: `titokids-linked-${childId}` }
      }).catch(() => {});
    }
    return shapeChild({ ...rows[0], child_username: childUser?.username || "" }, { balance: 0, pendingRequests: 0 });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getChild(parentUserId, childId) {
  await ensureTitoKidsSchema();
  const child = await loadOwnChild(parentUserId, childId);
  const [balance, limits, activity, spent, goals, requests] = await Promise.all([
    walletBalance(child.wallet_id),
    childLimits(childId),
    childActivity(child.wallet_id, { limit: 60 }),
    spentInWindows(child.wallet_id),
    listGoals(childId, child.wallet_id),
    pool.query(
      "SELECT * FROM titokids_requests WHERE child_id = $1 ORDER BY created_at DESC LIMIT 20",
      [childId]
    ).then((result) => result.rows)
  ]);
  return shapeChild(child, {
    balance, limits, activity, spent, goals,
    requests: requests.map((row) => ({
      id: row.id, amount: money(row.amount), category: row.category,
      categoryLabel: CATEGORY_LABELS[row.category] || row.category,
      note: row.note, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at
    }))
  });
}

async function updateChild(parentUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  const child = await loadOwnChild(parentUserId, childId);
  const fullName = payload.fullName !== undefined ? boundedText(payload.fullName, "Child's name", { min: 2, max: 120 }) : child.full_name;
  const relationship = payload.relationship !== undefined && RELATIONSHIPS.includes(String(payload.relationship)) ? String(payload.relationship) : child.relationship;
  let status = child.status;
  if (payload.status === "removed") {
    const balance = await walletBalance(child.wallet_id);
    if (balance > 0) throw new AppError(409, `The child's wallet still holds R${balance.toFixed(2)}. Pay it out or move it back before removing.`);
    status = "removed";
  }
  const { rows } = await pool.query(
    `UPDATE titokids_children SET full_name = $3, relationship = $4, status = $5, updated_at = NOW()
     WHERE id = $1 AND parent_user_id = $2 RETURNING *`,
    [childId, parentUserId, fullName, relationship, status]
  );
  await writeAuditLog({
    actorType: "customer", actorId: parentUserId, action: status === "removed" ? "titokids_child_removed" : "titokids_child_updated",
    entityType: "titokids_child", entityId: childId, metadata: {}
  }).catch(() => {});
  return shapeChild(rows[0]);
}

// parent wallet -> child wallet, one transaction, conserving to the cent.
async function fundChild(parentUserId, childId, payload = {}, options = {}) {
  await ensureTitoKidsSchema();
  const amount = money(payload.amount);
  if (!(amount > 0) || amount > 100000) throw new AppError(400, "Enter an amount between R0.01 and R100,000");
  const note = payload.note ? boundedText(payload.note, "Note", { min: 1, max: 200 }) : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const child = await loadOwnChild(parentUserId, childId, { forUpdate: true, client });
    let goal = null;
    if (payload.goalId) {
      const { rows } = await client.query(
        "SELECT * FROM titokids_goals WHERE id = $1 AND child_id = $2 AND status = 'active'", [payload.goalId, childId]);
      goal = rows[0];
      if (!goal) throw new AppError(404, "Savings goal not found");
    }
    const { rows: parentWallets } = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 AND kind = 'personal' AND status = 'active' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [parentUserId]
    );
    const parentWallet = parentWallets[0];
    if (!parentWallet) throw new AppError(404, "Your TitoPay wallet is not available");
    if (money(parentWallet.available_balance) < amount) {
      throw new AppError(409, `Not enough in your wallet — you have R${money(parentWallet.available_balance).toFixed(2)} available.`);
    }
    const transactionId = uuidv4();
    const reference = `TKID-${Date.now().toString(36).toUpperCase()}`;
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, metadata)
       VALUES ($1,$2,$3,'wallet_transfer',$4,0,$4,'completed','debit',$5,$6::jsonb)`,
      [transactionId, parentUserId, parentWallet.id, amount, reference,
       JSON.stringify({ titokids: true, childId, childName: child.full_name, purpose: "funding", goalId: goal?.id || null, note })]
    );
    await client.query(
      `UPDATE wallets SET available_balance = available_balance - $2, updated_at = NOW() WHERE id = $1`,
      [parentWallet.id, amount]
    );
    await client.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'debit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::jsonb)`,
      [uuidv4(), parentWallet.id, transactionId, amount, reference, JSON.stringify({ titokids: true, childId, purpose: "funding" })]
    );
    await client.query(
      `UPDATE wallets SET available_balance = available_balance + $2, updated_at = NOW() WHERE id = $1`,
      [child.wallet_id, amount]
    );
    await client.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'credit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::jsonb)`,
      [uuidv4(), child.wallet_id, transactionId, amount, reference,
       JSON.stringify({ titokids: true, purpose: "funding", goalId: goal?.id || null, note, category: goal ? "savings" : undefined })]
    );
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: "customer", actorId: parentUserId, action: "titokids_child_funded",
      entityType: "titokids_child", entityId: childId,
      metadata: { amount, goalId: goal?.id || null, requestId: options.requestId || null }
    }).catch(() => {});
    if (child.child_user_id) {
      await createNotification({
        user: { id: child.child_user_id, user_type: "customer" },
        channel: "in_app", notificationType: "titokids_funded", provider: "in_app",
        title: goal ? `R${amount.toFixed(2)} toward ${goal.name}` : `You received R${amount.toFixed(2)}`,
        body: goal ? `Money was added toward your "${goal.name}" goal.` : `Money was added to your TitoKids wallet${note ? ` — "${note}"` : ""}.`,
        metadata: { childId, clientNotificationId: `titokids-fund-${transactionId}` }
      }).catch(() => {});
    }
    return { reference, amount, balance: await walletBalance(child.wallet_id) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// child wallet -> a TitoPay recipient, category- and limit-checked. The
// parent is the actor; an explicit override above a cap is allowed and
// audited (the parent is the authority), but a switched-off category never
// pays without being switched back on.
async function payForChild(parentUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  const amount = money(payload.amount);
  if (!(amount > 0) || amount > 100000) throw new AppError(400, "Enter an amount between R0.01 and R100,000");
  const category = CATEGORIES.includes(String(payload.category)) ? String(payload.category) : "other";
  const note = payload.note ? boundedText(payload.note, "Note", { min: 1, max: 200 }) : "";
  const { resolveStaffUser } = require("./business-staff-service");
  const recipient = await resolveStaffUser(payload.identifier || payload.recipient);
  if (!recipient) throw new AppError(404, "No TitoPay account matches that recipient. Check the @username, email or cellphone.");

  const limits = await childLimits(childId);
  if (!limits.categories[category]) {
    throw new AppError(409, `${CATEGORY_LABELS[category]} is switched off for this child. Turn it on under Limits & Controls first.`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const child = await loadOwnChild(parentUserId, childId, { forUpdate: true, client });
    const spent = await spentInWindows(child.wallet_id);
    const breaches = [];
    if (limits.dailyLimit !== null && spent.day + amount > limits.dailyLimit) breaches.push(`daily R${limits.dailyLimit.toFixed(2)}`);
    if (limits.weeklyLimit !== null && spent.week + amount > limits.weeklyLimit) breaches.push(`weekly R${limits.weeklyLimit.toFixed(2)}`);
    if (limits.monthlyLimit !== null && spent.month + amount > limits.monthlyLimit) breaches.push(`monthly R${limits.monthlyLimit.toFixed(2)}`);
    if (breaches.length && payload.allowOverLimit !== true) {
      throw new AppError(409, `This would go past the ${breaches.join(" and ")} limit. Confirm to pay anyway, or adjust the limits.`);
    }
    const { rows: childWallets } = await client.query("SELECT * FROM wallets WHERE id = $1 FOR UPDATE", [child.wallet_id]);
    if (money(childWallets[0].available_balance) < amount) {
      throw new AppError(409, `The child's wallet holds R${money(childWallets[0].available_balance).toFixed(2)} — add money first.`);
    }
    const { rows: recipientWallets } = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 AND kind IN ('personal','business') AND status = 'active' ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [recipient.id]
    );
    const recipientWallet = recipientWallets[0];
    if (!recipientWallet) throw new AppError(404, "The recipient has no active TitoPay wallet");

    const transactionId = uuidv4();
    const reference = `TKID-${Date.now().toString(36).toUpperCase()}`;
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, recipient_reference, metadata)
       VALUES ($1,$2,$3,'wallet_transfer',$4,0,$4,'completed','debit',$5,$6,$7::jsonb)`,
      [transactionId, parentUserId, child.wallet_id, amount, reference, recipient.full_name || recipient.username,
       JSON.stringify({ titokids: true, childId, childName: child.full_name, purpose: "payment", category, note, recipientUserId: recipient.id, overLimit: breaches.length > 0 })]
    );
    await client.query("UPDATE wallets SET available_balance = available_balance - $2, updated_at = NOW() WHERE id = $1", [child.wallet_id, amount]);
    await client.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'debit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::jsonb)`,
      [uuidv4(), child.wallet_id, transactionId, amount, reference,
       JSON.stringify({ titokids: true, category, note, recipientName: recipient.full_name || recipient.username })]
    );
    await client.query("UPDATE wallets SET available_balance = available_balance + $2, updated_at = NOW() WHERE id = $1", [recipientWallet.id, amount]);
    await client.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'credit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::jsonb)`,
      [uuidv4(), recipientWallet.id, transactionId, amount, reference,
       JSON.stringify({ titokids: true, purpose: "titokids_payment", category })]
    );
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: "customer", actorId: parentUserId, action: "titokids_payment",
      entityType: "titokids_child", entityId: childId,
      metadata: { amount, category, recipientUserId: recipient.id, overLimit: breaches.length > 0 }
    }).catch(() => {});
    // Approaching-limit heads-up, computed from the same ledger truth.
    if (limits.weeklyLimit !== null) {
      const after = spent.week + amount;
      if (after >= limits.weeklyLimit * 0.8 && after <= limits.weeklyLimit) {
        await createNotification({
          user: { id: parentUserId, user_type: "customer" },
          channel: "in_app", notificationType: "titokids_limit_near", provider: "in_app",
          title: `${child.full_name} is approaching the weekly limit`,
          body: `R${after.toFixed(2)} of the R${limits.weeklyLimit.toFixed(2)} weekly limit is used.`,
          metadata: { childId, clientNotificationId: `titokids-limit-${childId}-${new Date().toISOString().slice(0, 10)}` }
        }).catch(() => {});
      }
    }
    return { reference, amount, category, recipientName: recipient.full_name || recipient.username, balance: await walletBalance(child.wallet_id) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setLimits(parentUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  await loadOwnChild(parentUserId, childId);
  const clean = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = money(value);
    if (!(parsed >= 0) || parsed > 1000000) throw new AppError(400, `${label} must be between R0 and R1,000,000`);
    return parsed;
  };
  const daily = clean(payload.dailyLimit, "Daily limit");
  const weekly = clean(payload.weeklyLimit, "Weekly limit");
  const monthly = clean(payload.monthlyLimit, "Monthly limit");
  const threshold = clean(payload.approvalThreshold, "Approval threshold");
  const categories = {};
  for (const key of CATEGORIES) {
    if (payload.categories && payload.categories[key] !== undefined) categories[key] = Boolean(payload.categories[key]);
  }
  const { rows: current } = await pool.query("SELECT categories FROM titokids_limits WHERE child_id = $1", [childId]);
  const merged = { ...(current[0]?.categories || {}), ...categories };
  const { rows } = await pool.query(
    `INSERT INTO titokids_limits (child_id, daily_limit, weekly_limit, monthly_limit, approval_threshold, categories, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,NOW())
     ON CONFLICT (child_id) DO UPDATE SET daily_limit=$2, weekly_limit=$3, monthly_limit=$4, approval_threshold=$5, categories=$6::jsonb, updated_at=NOW()
     RETURNING *`,
    [childId, daily, weekly, monthly, threshold, JSON.stringify(merged)]
  );
  await writeAuditLog({
    actorType: "customer", actorId: parentUserId, action: "titokids_limits_updated",
    entityType: "titokids_child", entityId: childId, metadata: { daily, weekly, monthly, threshold }
  }).catch(() => {});
  return shapeLimits(rows[0]);
}

/* ---- Savings goals: progress is the ledger's word, not a counter ------- */

async function listGoals(childId, walletId) {
  const { rows: goals } = await pool.query(
    "SELECT * FROM titokids_goals WHERE child_id = $1 AND status <> 'archived' ORDER BY created_at ASC LIMIT 20",
    [childId]
  );
  if (!goals.length) return [];
  const { rows: sums } = await pool.query(
    `SELECT metadata->>'goalId' AS goal_id, COALESCE(SUM(amount), 0) AS saved
     FROM wallet_ledger
     WHERE wallet_id = $1 AND entry_type = 'credit' AND metadata->>'goalId' IS NOT NULL
     GROUP BY metadata->>'goalId'`,
    [walletId]
  );
  const savedByGoal = Object.fromEntries(sums.map((row) => [row.goal_id, money(row.saved)]));
  return goals.map((goal) => {
    const saved = savedByGoal[goal.id] || 0;
    const target = money(goal.target_amount);
    return {
      id: goal.id, name: goal.name, target, saved: money(Math.min(saved, target * 100)),
      percent: target > 0 ? Math.min(100, money((saved / target) * 100)) : 0,
      achieved: saved >= target, status: goal.status, createdAt: goal.created_at
    };
  });
}

async function createGoal(parentUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  const child = await loadOwnChild(parentUserId, childId);
  const name = boundedText(payload.name, "Goal name", { min: 2, max: 120 });
  const target = money(payload.target || payload.targetAmount);
  if (!(target > 0) || target > 1000000) throw new AppError(400, "Set a target between R0.01 and R1,000,000");
  const id = uuidv4();
  await pool.query(
    "INSERT INTO titokids_goals (id, child_id, name, target_amount) VALUES ($1,$2,$3,$4)",
    [id, childId, name, target]
  );
  return (await listGoals(childId, child.wallet_id)).find((goal) => goal.id === id);
}

/* ---- The child's side: My Family and money requests -------------------- */

async function myFamily(childUserId) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT c.id, c.full_name, c.parent_user_id, c.wallet_id, u.full_name AS parent_name,
            w.available_balance
     FROM titokids_children c
     JOIN users u ON u.id = c.parent_user_id
     JOIN wallets w ON w.id = c.wallet_id
     WHERE c.child_user_id = $1 AND c.status = 'active'
     ORDER BY c.created_at ASC
     LIMIT 10`,
    [childUserId]
  );
  const output = [];
  for (const row of rows) {
    const { rows: requests } = await pool.query(
      "SELECT * FROM titokids_requests WHERE child_id = $1 ORDER BY created_at DESC LIMIT 10", [row.id]);
    output.push({
      childId: row.id,
      parentName: row.parent_name,
      balance: money(row.available_balance),
      activity: await childActivity(row.wallet_id, { limit: 15 }),
      requests: requests.map((request) => ({
        id: request.id, amount: money(request.amount), category: request.category,
        categoryLabel: CATEGORY_LABELS[request.category] || request.category,
        note: request.note, status: request.status, createdAt: request.created_at
      }))
    });
  }
  return output;
}

async function createRequest(childUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT c.*, u.full_name AS parent_name FROM titokids_children c
     JOIN users u ON u.id = c.parent_user_id
     WHERE c.id = $1 AND c.child_user_id = $2 AND c.status = 'active' LIMIT 1`,
    [childId, childUserId]
  );
  const child = rows[0];
  if (!child) throw new AppError(404, "Family link not found");
  const amount = money(payload.amount);
  if (!(amount > 0) || amount > 100000) throw new AppError(400, "Ask for an amount between R0.01 and R100,000");
  const category = CATEGORIES.includes(String(payload.category)) ? String(payload.category) : "other";
  const note = payload.note ? boundedText(payload.note, "Note", { min: 1, max: 200 }) : "";
  const { rows: open } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM titokids_requests WHERE child_id = $1 AND status = 'requested'", [childId]);
  if (open[0].count >= 5) throw new AppError(429, "You already have 5 requests waiting — give your parent a moment to answer.");
  const id = uuidv4();
  await pool.query(
    `INSERT INTO titokids_requests (id, child_id, requested_by, amount, category, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, childId, childUserId, amount, category, note]
  );
  await createNotification({
    user: { id: child.parent_user_id, user_type: "customer" },
    channel: "in_app", notificationType: "titokids_request", provider: "in_app",
    title: "TitoKids approval needed",
    body: `${child.full_name} is asking for R${amount.toFixed(2)} (${CATEGORY_LABELS[category]})${note ? ` — "${note}"` : ""}.`,
    metadata: { childId, requestId: id, clientNotificationId: `titokids-request-${id}` }
  }).catch(() => {});
  return { id, status: "requested" };
}

async function listApprovals(parentUserId) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT r.*, c.full_name AS child_name
     FROM titokids_requests r
     JOIN titokids_children c ON c.id = r.child_id AND c.parent_user_id = $1 AND c.status = 'active'
     WHERE r.status = 'requested'
     ORDER BY r.created_at ASC
     LIMIT 50`,
    [parentUserId]
  );
  return rows.map((row) => ({
    id: row.id, childId: row.child_id, childName: row.child_name,
    amount: money(row.amount), category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    note: row.note, createdAt: row.created_at
  }));
}

async function decideRequest(parentUserId, requestId, approve) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT r.*, c.parent_user_id, c.child_user_id, c.full_name AS child_name
     FROM titokids_requests r
     JOIN titokids_children c ON c.id = r.child_id
     WHERE r.id = $1 LIMIT 1`,
    [requestId]
  );
  const request = rows[0];
  if (!request || request.parent_user_id !== parentUserId) throw new AppError(404, "Request not found");
  if (request.status !== "requested") throw new AppError(409, `That request was already ${request.status}`);
  let funded = null;
  if (approve) {
    funded = await fundChild(parentUserId, request.child_id, {
      amount: money(request.amount),
      note: request.note || `Approved ${CATEGORY_LABELS[request.category] || request.category} request`
    }, { requestId });
  }
  await pool.query(
    "UPDATE titokids_requests SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1",
    [requestId, approve ? "approved" : "declined", parentUserId]
  );
  await writeAuditLog({
    actorType: "customer", actorId: parentUserId, action: approve ? "titokids_request_approved" : "titokids_request_declined",
    entityType: "titokids_request", entityId: requestId, metadata: { amount: money(request.amount) }
  }).catch(() => {});
  if (request.child_user_id) {
    await createNotification({
      user: { id: request.child_user_id, user_type: "customer" },
      channel: "in_app", notificationType: "titokids_request_decided", provider: "in_app",
      title: approve ? `Your R${money(request.amount).toFixed(2)} request was approved` : "Your request was declined",
      body: approve ? "The money is in your TitoKids wallet." : `Your request for R${money(request.amount).toFixed(2)} was declined${request.note ? ` — "${request.note}"` : ""}.`,
      metadata: { requestId, clientNotificationId: `titokids-decided-${requestId}` }
    }).catch(() => {});
  }
  return { id: requestId, status: approve ? "approved" : "declined", funded };
}

module.exports = {
  ensureTitoKidsSchema,
  CATEGORIES,
  CATEGORY_LABELS,
  listChildren,
  addChild,
  getChild,
  updateChild,
  fundChild,
  payForChild,
  childLimits,
  setLimits,
  createGoal,
  listGoals,
  myFamily,
  createRequest,
  listApprovals,
  decideRequest
};
