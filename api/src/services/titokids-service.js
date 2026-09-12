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
      // A co-parent, guardian or grandparent who helps manage ONE child. It is
      // per child, never per family: being trusted with one child's money says
      // nothing about another's. An invitation must be accepted before it gives
      // anybody access.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS titokids_guardians (
          id UUID PRIMARY KEY,
          child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          invited_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          relationship TEXT NOT NULL DEFAULT 'co-parent',
          status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','declined','removed')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          responded_at TIMESTAMPTZ
        )`);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_titokids_guardian
         ON titokids_guardians (child_id, user_id)
         WHERE status IN ('invited','active')`
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS titokids_goals (
          id UUID PRIMARY KEY,
          child_id UUID NOT NULL REFERENCES titokids_children(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          target_amount NUMERIC(18,2) NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','archived')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      // A PARENT MAY HAVE MORE THAN ONE CHILD. Every child is a kind 'system'
      // wallet under the parent, and the old idx_wallets_user_kind enforced
      // one per user per kind across ALL kinds, so the second child's wallet
      // was a duplicate-key 500. The 20260820_titokids_sibling_wallets
      // migration rebuilds it partial; this is the same statement pair here
      // because ensure functions are what kept features alive the week the
      // production database ran three days behind its migrations. Both
      // statements are idempotent, and the NEW index name is what lets
      // IF NOT EXISTS converge a database still carrying the old definition.
      await pool.query("DROP INDEX IF EXISTS idx_wallets_user_kind");
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user_kind_ex_system
         ON wallets (user_id, kind) WHERE kind <> 'system'`
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

// THE ONE PLACE THAT DECIDES WHO MAY TOUCH A CHILD'S MONEY.
//
// The owner is whoever added the child. An accepted co-parent gets the same
// day-to-day reach — fund, pay, set limits, answer requests — because half a
// guardian is no use when the school asks for money on a Tuesday. What stays
// with the owner alone is the shape of the arrangement itself: inviting and
// removing guardians, and removing the child. Those checks are `is_owner`.
//
// Funding is safe by construction: fundChild debits the wallet of whoever
// calls it, so a co-parent always spends their OWN money, never the owner's.
async function loadOwnChild(actorUserId, childId, { forUpdate = false, client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT c.*, u.username AS child_username, u.full_name AS child_account_name, u.email AS child_email,
            (c.parent_user_id = $2) AS is_owner
     FROM titokids_children c
     LEFT JOIN users u ON u.id = c.child_user_id
     WHERE c.id = $1 AND c.status = 'active'
       AND (c.parent_user_id = $2 OR EXISTS (
         SELECT 1 FROM titokids_guardians g
         WHERE g.child_id = c.id AND g.user_id = $2 AND g.status = 'active'))
     LIMIT 1${forUpdate ? " FOR UPDATE OF c" : ""}`,
    [childId, actorUserId]
  );
  if (!rows[0]) throw new AppError(404, "Child not found");
  return rows[0];
}

// Reused by every list: "children I own, plus children I help manage".
const CHILD_ACCESS_SQL = `(c.parent_user_id = $1 OR EXISTS (
  SELECT 1 FROM titokids_guardians g
  WHERE g.child_id = c.id AND g.user_id = $1 AND g.status = 'active'))`;

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
// enforced against truth. Day/week/month are SOUTH AFRICAN calendar windows,
// anchored the same way the main limit engine and the regulatory monthly cap
// are: DATE_TRUNC over NOW() shifted into Africa/Johannesburg, then shifted
// back to a timestamptz boundary. Using a bare UTC date_trunc would roll each
// window at 02:00 SAST, so a child at their daily cap could spend it again in
// the 00:00-02:00 SAST slice of the SAME SA day - the cap is an enforced block,
// not a display, so this has to be the SA calendar day.
async function spentInWindows(walletId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= (DATE_TRUNC('day',   NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')), 0) AS day,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= (DATE_TRUNC('week',  NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')), 0) AS week,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= (DATE_TRUNC('month', NOW() AT TIME ZONE 'Africa/Johannesburg') AT TIME ZONE 'Africa/Johannesburg')), 0) AS month
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
    // Whoever added the child. A co-parent gets the same day-to-day reach, so
    // the app cannot tell the two apart without being told - and the one action
    // reserved to the owner, moving money back out to their own wallet, has to
    // be hidden from a co-parent rather than offered and then refused.
    isOwner: row.is_owner === undefined ? undefined : Boolean(row.is_owner),
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
    `SELECT c.*, u.username AS child_username, w.available_balance,
            (c.parent_user_id = $1) AS is_owner
     FROM titokids_children c
     LEFT JOIN users u ON u.id = c.child_user_id
     JOIN wallets w ON w.id = c.wallet_id
     WHERE ${CHILD_ACCESS_SQL} AND c.status = 'active'
     ORDER BY c.created_at ASC
     LIMIT 20`,
    [parentUserId]
  );
  const { rows: pending } = await pool.query(
    `SELECT r.child_id, COUNT(*)::int AS count
     FROM titokids_requests r
     JOIN titokids_children c ON c.id = r.child_id AND ${CHILD_ACCESS_SQL}
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
    if (childUser.id === parentUserId) throw new AppError(400, "That is your own account. Enter the child's TitoPay details.");
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
    // is_owner is not a column, it is computed per reader - and the person who
    // just added the child is by definition the owner.
    return shapeChild({ ...rows[0], child_username: childUser?.username || "", is_owner: true },
      { balance: 0, pendingRequests: 0 });
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
    balance, limits, activity, spent, goals, isOwner: Boolean(child.is_owner),
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
    // A co-parent helps manage the money; ending the arrangement is the
    // owner's decision alone.
    if (!child.is_owner) throw new AppError(403, "Only the parent who set up this TitoKids wallet can remove the child.");
    const balance = await walletBalance(child.wallet_id);
    if (balance > 0) throw new AppError(409, `The child's wallet still holds R${balance.toFixed(2)}. Move it back to your wallet or pay it out, then remove the child.`);
    status = "removed";
  }
  // Keyed on the child, not the caller: loadOwnChild above has already decided
  // whether this person may be here at all, and a co-parent's rename must not
  // silently do nothing.
  const { rows } = await pool.query(
    `UPDATE titokids_children SET full_name = $2, relationship = $3, status = $4, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [childId, fullName, relationship, status]
  );
  await writeAuditLog({
    actorType: "customer", actorId: parentUserId, action: status === "removed" ? "titokids_child_removed" : "titokids_child_updated",
    entityType: "titokids_child", entityId: childId, metadata: {}
  }).catch(() => {});
  return shapeChild({ ...rows[0], is_owner: child.is_owner });
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
      throw new AppError(409, `Not enough in your wallet. You have R${money(parentWallet.available_balance).toFixed(2)} available.`);
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
        body: goal ? `Money was added toward your "${goal.name}" goal.` : `Money was added to your TitoKids wallet${note ? ` · "${note}"` : ""}.`,
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

// CHILD WALLET -> THE OWNER'S OWN WALLET. The way back.
//
// Money could go into a child wallet and never come out except by paying a
// third party. updateChild() refuses to remove a child while the balance is
// non-zero and tells the parent to "pay it out or move it back" - and moving it
// back was not a thing this service could do. The only escape was to notice
// that payForChild accepts any TitoPay account and pay yourself, which is
// undiscoverable and records the parent's own money as a payment out.
//
// OWNER ONLY, and only to the owner's own wallet. A co-parent may fund and may
// spend on the child's behalf, because both leave the money with the child or
// with a merchant. Pulling it into a personal wallet is different: it ends the
// arrangement's money, and it must not be possible for anyone but the person
// whose wallet it came from. Same rule updateChild() applies to removal.
//
// No platform limit check, deliberately: this returns the account holder's own
// money to the account holder's own wallet. Nothing leaves their control, so
// there is nothing for a send limit to be protecting.
async function returnFromChild(parentUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  const note = payload.note ? boundedText(payload.note, "Note", { min: 1, max: 200 }) : "";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const child = await loadOwnChild(parentUserId, childId, { forUpdate: true, client });
    if (!child.is_owner) {
      throw new AppError(403, "Only the parent who set up this TitoKids wallet can move money back out of it.");
    }
    const { rows: childWallets } = await client.query(
      "SELECT * FROM wallets WHERE id = $1 FOR UPDATE", [child.wallet_id]);
    const held = money(childWallets[0].available_balance);
    // "all" is the case that matters - a parent emptying the wallet so the
    // child can be removed - and asking them to retype the balance to the cent
    // is how an off-by-one cent leaves a child unremovable.
    const amount = payload.all === true || payload.amount === undefined || payload.amount === null
      ? held
      : money(payload.amount);
    if (!(amount > 0)) throw new AppError(400, "There is nothing in this wallet to move back.");
    if (amount > held) {
      throw new AppError(409, `The child's wallet holds R${held.toFixed(2)}. Move back that much or less.`);
    }
    const { rows: parentWallets } = await client.query(
      `SELECT * FROM wallets WHERE user_id = $1 AND kind = 'personal' AND status = 'active'
        ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [parentUserId]
    );
    const parentWallet = parentWallets[0];
    if (!parentWallet) throw new AppError(404, "Your TitoPay wallet is not available");

    const transactionId = uuidv4();
    const reference = `TKID-${Date.now().toString(36).toUpperCase()}`;
    const meta = JSON.stringify({
      titokids: true, childId, childName: child.full_name, purpose: "return", note
    });
    // Recorded as a CREDIT on the parent, which is what it is: their own money
    // coming home. The debit leg on the child wallet carries the same
    // reference, so the two halves reconcile the way funding's do.
    await client.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, metadata)
       VALUES ($1,$2,$3,'wallet_transfer',$4,0,$4,'completed','credit',$5,$6::jsonb)`,
      [transactionId, parentUserId, parentWallet.id, amount, reference, meta]
    );
    // The balance guard is on the UPDATE itself and its result is CHECKED. The
    // row is already locked, so this cannot fire - which is exactly why it is
    // here: if it ever does, the alternative is a credit leg with no debit
    // behind it, and money invented out of a race is the one bug this codebase
    // must never ship.
    const debited = await client.query(
      `UPDATE wallets SET available_balance = available_balance - $2, updated_at = NOW()
        WHERE id = $1 AND available_balance >= $2`,
      [child.wallet_id, amount]
    );
    if (debited.rowCount !== 1) throw new AppError(409, "The child's wallet balance changed. Try again.");
    await client.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'debit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::jsonb)`,
      [uuidv4(), child.wallet_id, transactionId, amount, reference,
       JSON.stringify({ titokids: true, purpose: "return", note })]
    );
    await client.query(
      `UPDATE wallets SET available_balance = available_balance + $2, updated_at = NOW() WHERE id = $1`,
      [parentWallet.id, amount]
    );
    await client.query(
      `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata)
       VALUES ($1,$2,$3,'credit',$4,(SELECT available_balance FROM wallets WHERE id = $2),$5,$6::jsonb)`,
      [uuidv4(), parentWallet.id, transactionId, amount, reference,
       JSON.stringify({ titokids: true, childId, purpose: "return", note })]
    );
    await client.query("COMMIT");
    await writeAuditLog({
      actorType: "customer", actorId: parentUserId, action: "titokids_child_returned",
      entityType: "titokids_child", entityId: childId, metadata: { amount }
    }).catch(() => {});
    if (child.child_user_id) {
      await createNotification({
        user: { id: child.child_user_id, user_type: "customer" },
        channel: "in_app", notificationType: "titokids_returned", provider: "in_app",
        title: `R${amount.toFixed(2)} moved back`,
        body: `${child.full_name}, money was moved from your TitoKids wallet back to your parent's wallet${note ? ` \u00b7 "${note}"` : ""}.`,
        metadata: { childId, clientNotificationId: `titokids-return-${transactionId}` }
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

  // THE PLATFORM'S LIMITS APPLY HERE, AND UNTIL NOW THEY DID NOT.
  //
  // This is the hop where money LEAVES the account holder's control: a child
  // wallet is owned by the parent, so funding one moves nothing outside the
  // household, but paying from one reaches a third party's wallet. Every other
  // rail in the platform consults the limit engine before doing that -
  // transfers, withdrawals, VAS purchases, payment requests, even the admin
  // adjustment path - and TitoKids consulted it zero times.
  //
  // The effect was a two-hop channel around a customer's own limits: fund a
  // child (no ceiling but the parent's balance), then pay anybody from the
  // child wallet, with only TitoKids' own caps in the way - and those default
  // to none and can be overridden with allowOverLimit.
  //
  // Charged to the PARENT, because the parent is the account holder whose
  // money is leaving. The recipient's receive capacity is checked the same way
  // an ordinary transfer checks it, so a child's payment cannot push somebody
  // past a ceiling their own account would have refused.
  const compliance = require("./compliance-service");
  await compliance.assertCanSendAmount(parentUserId, amount, { serviceCode: "wallet_transfer" });
  await compliance.assertCanReceiveAmount(recipient.id, amount, { serviceCode: "wallet_transfer" });

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
      throw new AppError(409, `The child's wallet holds R${money(childWallets[0].available_balance).toFixed(2)}. Add money first.`);
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

/* ---- Co-parents ----------------------------------------------------------
   Adding somebody to a child's wallet is not a setting, it is a relationship
   between two adults about a third person's money. So: the owner invites, the
   other adult ACCEPTS, and either side can end it. Nobody is given reach over
   a child's money without having agreed to hold it. */
async function listGuardians(actorUserId, childId) {
  await ensureTitoKidsSchema();
  const child = await loadOwnChild(actorUserId, childId);
  const { rows } = await pool.query(
    `SELECT g.*, u.full_name, u.username, u.email
     FROM titokids_guardians g
     JOIN users u ON u.id = g.user_id
     WHERE g.child_id = $1 AND g.status IN ('invited','active')
     ORDER BY g.created_at ASC`,
    [childId]
  );
  const { rows: owner } = await pool.query(
    "SELECT id, full_name, username FROM users WHERE id = $1", [child.parent_user_id]);
  return {
    isOwner: Boolean(child.is_owner),
    owner: owner[0] ? { userId: owner[0].id, fullName: owner[0].full_name, username: owner[0].username } : null,
    items: rows.map((row) => ({
      id: row.id, userId: row.user_id, fullName: row.full_name, username: row.username,
      relationship: row.relationship, status: row.status, invitedAt: row.created_at, respondedAt: row.responded_at
    }))
  };
}

async function inviteGuardian(ownerUserId, childId, payload = {}) {
  await ensureTitoKidsSchema();
  const child = await loadOwnChild(ownerUserId, childId);
  if (!child.is_owner) throw new AppError(403, "Only the parent who set up this TitoKids wallet can invite someone else to help manage it.");
  const contact = boundedText(payload.contact, "Their TitoPay details", { min: 3, max: 120 });
  const relationship = boundedText(payload.relationship || "co-parent", "Relationship", { min: 2, max: 40 });
  // Same resolver the staff register uses: @username, email or phone -> an
  // active TitoPay account, or nothing.
  const { resolveStaffUser } = require("./business-staff-service");
  const person = await resolveStaffUser(contact);
  if (!person) {
    throw new AppError(404, `No active TitoPay account matches "${contact}". Their exact @username is the most reliable, and they need a TitoPay account before they can help manage ${child.full_name}'s wallet.`);
  }
  if (person.id === ownerUserId) throw new AppError(400, "You already manage this wallet.");
  if (child.child_user_id && person.id === child.child_user_id) {
    throw new AppError(400, `${child.full_name} cannot be a manager of their own wallet, because that would put the limits in their hands.`);
  }
  const { rows: existing } = await pool.query(
    "SELECT * FROM titokids_guardians WHERE child_id = $1 AND user_id = $2 AND status IN ('invited','active') LIMIT 1",
    [childId, person.id]
  );
  if (existing[0]) {
    throw new AppError(409, existing[0].status === "active"
      ? `@${person.username} already helps manage ${child.full_name}'s wallet.`
      : `@${person.username} has already been invited. They still need to accept.`);
  }
  const id = uuidv4();
  await pool.query(
    "INSERT INTO titokids_guardians (id, child_id, user_id, invited_by, relationship) VALUES ($1,$2,$3,$4,$5)",
    [id, childId, person.id, ownerUserId, relationship]
  );
  const { rows: inviter } = await pool.query("SELECT full_name FROM users WHERE id = $1", [ownerUserId]);
  const inviterName = inviter[0]?.full_name || "A TitoPay parent";
  await createNotification({
    user: { id: person.id, user_type: "customer" },
    channel: "in_app", notificationType: "titokids_guardian_invite", provider: "in_app",
    title: `${inviterName} asked you to help manage ${child.full_name}'s money`,
    body: `Accept in TitoKids and you can add money from your own wallet, pay for needs, set limits and answer ${child.full_name}'s requests. You will never be able to spend ${inviterName}'s money, because funding always comes from your own wallet.`,
    metadata: { childId, guardianId: id, clientNotificationId: `titokids-guardian-invite-${id}` }
  }).catch(() => {});
  if (person.email) {
    try {
      const emailCentre = require("./email-centre-service");
      const esc = emailCentre.escapeHtml;
      await emailCentre.queueRawEmail({
        recipient: person.email,
        subject: `${inviterName} asked you to help manage ${child.full_name}'s TitoKids wallet`,
        textBody: [
          `Hi ${person.full_name || "there"},`,
          "",
          `${inviterName} has asked you to help manage ${child.full_name}'s TitoKids wallet on TitoPay.`,
          "",
          `If you accept, you can add pocket money from your own wallet, pay for needs like school or transport, set spending limits and answer ${child.full_name}'s requests. Money you add always comes out of your own wallet, and nobody else can ever spend from yours.`,
          "",
          "To accept or decline:",
          `1. Open the TitoPay app ({{appUrl}}) and sign in as ${person.username ? `@${person.username}` : "yourself"}.`,
          "2. Open Services and choose TitoKids.",
          "3. Your invitation is at the top of the screen. Choose Accept or Decline.",
          "",
          "There is no deadline. The invitation stays open until you answer it, and nothing changes on your account unless you accept.",
          "",
          `If you were not expecting this, you can decline it in the app or simply ignore this email. ${child.full_name}'s wallet stays exactly as it is.`,
          "",
          "TitoPay"
        ].join("\n"),
        htmlBody: [
          `<p>Hi ${esc(person.full_name || "there")},</p>`,
          `<p><strong>${esc(inviterName)}</strong> has asked you to help manage <strong>${esc(child.full_name)}</strong>'s TitoKids wallet on TitoPay.</p>`,
          `<p>If you accept, you can add pocket money from your own wallet, pay for needs like school or transport, set spending limits and answer ${esc(child.full_name)}'s requests. Money you add always comes out of your own wallet, and nobody else can ever spend from yours.</p>`,
          "<p><strong>To accept or decline:</strong></p>",
          "<ol>",
          `<li>Open the <a href="{{appUrl}}">TitoPay app</a> and sign in${person.username ? ` as @${esc(person.username)}` : ""}.</li>`,
          "<li>Open <strong>Services</strong> and choose <strong>TitoKids</strong>.</li>",
          "<li>Your invitation is at the top of the screen. Choose <strong>Accept</strong> or <strong>Decline</strong>.</li>",
          "</ol>",
          "<p>There is no deadline. The invitation stays open until you answer it, and nothing changes on your account unless you accept.</p>",
          `<p>If you were not expecting this, you can decline it in the app or simply ignore this email. ${esc(child.full_name)}'s wallet stays exactly as it is.</p>`,
          "<p>TitoPay</p>"
        ].join("\n"),
        userId: person.id,
        idempotencyKey: `titokids-guardian-invite-${id}`,
        metadata: { childId, guardianId: id }
      });
    } catch (error) {
      console.error("[titokids] guardian invite email failed", { guardianId: id, message: error.message });
    }
  }
  return {
    guardian: { id, userId: person.id, fullName: person.full_name, username: person.username, relationship, status: "invited" },
    message: `${person.full_name || `@${person.username}`} was invited. They help manage ${child.full_name}'s wallet as soon as they accept.`
  };
}

// The invitations waiting for me, shown wherever TitoKids opens.
async function listGuardianInvites(userId) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT g.id, g.child_id, g.relationship, g.created_at, c.full_name AS child_name, u.full_name AS invited_by_name
     FROM titokids_guardians g
     JOIN titokids_children c ON c.id = g.child_id AND c.status = 'active'
     JOIN users u ON u.id = g.invited_by
     WHERE g.user_id = $1 AND g.status = 'invited'
     ORDER BY g.created_at ASC
     LIMIT 20`,
    [userId]
  );
  return rows.map((row) => ({
    id: row.id, childId: row.child_id, childName: row.child_name,
    invitedByName: row.invited_by_name, relationship: row.relationship, invitedAt: row.created_at
  }));
}

async function respondToGuardianInvite(userId, guardianId, accept) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT g.*, c.full_name AS child_name, c.parent_user_id
     FROM titokids_guardians g
     JOIN titokids_children c ON c.id = g.child_id
     WHERE g.id = $1 AND g.user_id = $2 LIMIT 1`,
    [guardianId, userId]
  );
  const invite = rows[0];
  if (!invite) throw new AppError(404, "Invitation not found");
  if (invite.status !== "invited") throw new AppError(409, `That invitation was already ${invite.status}`);
  await pool.query(
    "UPDATE titokids_guardians SET status = $2, responded_at = NOW() WHERE id = $1",
    [guardianId, accept ? "active" : "declined"]
  );
  const { rows: me } = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [userId]);
  const myName = me[0]?.full_name || `@${me[0]?.username || "Someone"}`;
  await createNotification({
    user: { id: invite.parent_user_id, user_type: "customer" },
    channel: "in_app", notificationType: "titokids_guardian_response", provider: "in_app",
    title: accept ? `${myName} now helps manage ${invite.child_name}'s money` : `${myName} declined`,
    body: accept
      ? `${myName} can add money from their own wallet, pay for needs, set limits and answer ${invite.child_name}'s requests.`
      : `${myName} declined the invitation to help manage ${invite.child_name}'s wallet.`,
    metadata: { childId: invite.child_id, guardianId, clientNotificationId: `titokids-guardian-response-${guardianId}` }
  }).catch(() => {});
  await writeAuditLog({
    actorType: "customer", actorId: userId,
    action: accept ? "titokids_guardian_accepted" : "titokids_guardian_declined",
    entityType: "titokids_guardian", entityId: guardianId, metadata: { childId: invite.child_id }
  }).catch(() => {});
  return { status: accept ? "active" : "declined", childId: invite.child_id, childName: invite.child_name };
}

// Either side can end it: the owner removes a co-parent, a co-parent steps
// down. Nobody is held to it.
async function removeGuardian(actorUserId, guardianId) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT g.*, c.parent_user_id, c.full_name AS child_name
     FROM titokids_guardians g
     JOIN titokids_children c ON c.id = g.child_id
     WHERE g.id = $1 AND g.status IN ('invited','active') LIMIT 1`,
    [guardianId]
  );
  const guardian = rows[0];
  if (!guardian) throw new AppError(404, "That person does not help manage this wallet");
  const isOwner = guardian.parent_user_id === actorUserId;
  const isSelf = guardian.user_id === actorUserId;
  if (!isOwner && !isSelf) throw new AppError(404, "That person does not help manage this wallet");
  await pool.query("UPDATE titokids_guardians SET status = 'removed', responded_at = NOW() WHERE id = $1", [guardianId]);
  const tellUserId = isOwner ? guardian.user_id : guardian.parent_user_id;
  await createNotification({
    user: { id: tellUserId, user_type: "customer" },
    channel: "in_app", notificationType: "titokids_guardian_removed", provider: "in_app",
    title: `TitoKids: ${guardian.child_name}`,
    body: isOwner
      ? `You no longer help manage ${guardian.child_name}'s TitoKids wallet.`
      : `Someone stepped down from helping manage ${guardian.child_name}'s TitoKids wallet.`,
    metadata: { childId: guardian.child_id, guardianId, clientNotificationId: `titokids-guardian-removed-${guardianId}` }
  }).catch(() => {});
  await writeAuditLog({
    actorType: "customer", actorId: actorUserId, action: "titokids_guardian_removed",
    entityType: "titokids_guardian", entityId: guardianId, metadata: { childId: guardian.child_id, byOwner: isOwner }
  }).catch(() => {});
  return { removed: true };
}

// Everyone who should hear that a child asked for money: the owner and every
// accepted co-parent. Whoever answers first settles it.
async function childApprovers(childId) {
  const { rows } = await pool.query(
    `SELECT c.parent_user_id AS user_id FROM titokids_children c WHERE c.id = $1
     UNION
     SELECT g.user_id FROM titokids_guardians g WHERE g.child_id = $1 AND g.status = 'active'`,
    [childId]
  );
  return rows.map((row) => row.user_id);
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
  if (open[0].count >= 5) throw new AppError(429, "You already have 5 requests waiting. Give your parent a moment to answer.");
  const id = uuidv4();
  await pool.query(
    `INSERT INTO titokids_requests (id, child_id, requested_by, amount, category, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, childId, childUserId, amount, category, note]
  );
  for (const approverId of await childApprovers(childId)) {
    await createNotification({
      user: { id: approverId, user_type: "customer" },
      channel: "in_app", notificationType: "titokids_request", provider: "in_app",
      title: "TitoKids approval needed",
      body: `${child.full_name} is asking for R${amount.toFixed(2)} (${CATEGORY_LABELS[category]})${note ? ` · "${note}"` : ""}.`,
      metadata: { childId, requestId: id, clientNotificationId: `titokids-request-${id}-${approverId}` }
    }).catch(() => {});
  }
  return { id, status: "requested" };
}

async function listApprovals(parentUserId) {
  await ensureTitoKidsSchema();
  const { rows } = await pool.query(
    `SELECT r.*, c.full_name AS child_name
     FROM titokids_requests r
     JOIN titokids_children c ON c.id = r.child_id AND ${CHILD_ACCESS_SQL} AND c.status = 'active'
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
  if (!request) throw new AppError(404, "Request not found");
  // Owner or accepted co-parent. loadOwnChild is the single access rule, and
  // it throws 404 for anybody else — a stranger learns nothing.
  await loadOwnChild(parentUserId, request.child_id);
  if (request.status !== "requested") throw new AppError(409, `That request was already ${request.status}`);
  // CLAIM THE DECISION BEFORE MOVING MONEY. The status read above ran on the
  // pool with no lock, so two parents answering at once (or a double-tap
  // retry) both saw 'requested', both called fundChild, and the parent was
  // debited twice for one request. The conditional UPDATE admits exactly one
  // decider; the loser gets the same "already decided" answer a late tap gets.
  const claim = await pool.query(
    `UPDATE titokids_requests
     SET status = $2, decided_by = $3, decided_at = NOW()
     WHERE id = $1 AND status = 'requested'
     RETURNING id`,
    [requestId, approve ? "approved" : "declined", parentUserId]
  );
  if (!claim.rows[0]) throw new AppError(409, "That request has already been decided");
  let funded = null;
  if (approve) {
    try {
      funded = await fundChild(parentUserId, request.child_id, {
        amount: money(request.amount),
        note: request.note || `Approved ${CATEGORY_LABELS[request.category] || request.category} request`
      }, { requestId });
    } catch (error) {
      // Funding failed (insufficient balance, limits): put the request back so
      // the parent can fix the cause and answer it again — the claim must not
      // strand it 'approved' with no money moved.
      await pool.query(
        "UPDATE titokids_requests SET status = 'requested', decided_by = NULL, decided_at = NULL WHERE id = $1 AND status = 'approved'",
        [requestId]
      ).catch(() => {});
      throw error;
    }
  }
  await writeAuditLog({
    actorType: "customer", actorId: parentUserId, action: approve ? "titokids_request_approved" : "titokids_request_declined",
    entityType: "titokids_request", entityId: requestId, metadata: { amount: money(request.amount) }
  }).catch(() => {});
  if (request.child_user_id) {
    await createNotification({
      user: { id: request.child_user_id, user_type: "customer" },
      channel: "in_app", notificationType: "titokids_request_decided", provider: "in_app",
      title: approve ? `Your R${money(request.amount).toFixed(2)} request was approved` : "Your request was declined",
      body: approve ? "The money is in your TitoKids wallet." : `Your request for R${money(request.amount).toFixed(2)} was declined${request.note ? ` · "${request.note}"` : ""}.`,
      metadata: { requestId, clientNotificationId: `titokids-decided-${requestId}` }
    }).catch(() => {});
  }
  return { id: requestId, status: approve ? "approved" : "declined", funded };
}

module.exports = {
  listGuardians,
  inviteGuardian,
  listGuardianInvites,
  respondToGuardianInvite,
  removeGuardian,
  ensureTitoKidsSchema,
  CATEGORIES,
  CATEGORY_LABELS,
  listChildren,
  addChild,
  getChild,
  updateChild,
  fundChild,
  returnFromChild,
  payForChild,
  childLimits,
  spentInWindows,
  setLimits,
  createGoal,
  listGoals,
  myFamily,
  createRequest,
  listApprovals,
  decideRequest
};
