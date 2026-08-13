"use strict";

// Business staff — the real, server-backed register behind Business tools >
// Staff, and the day-to-day operation it unlocks: a cashier selling for the
// business from their own phone.
//
// The money path is deliberately boring: a staff sale mints a payment QR
// carrying the BUSINESS's user id, so the customer's payment lands in the
// business wallet directly. Staff never hold, route or touch a cent — their
// name is only written on the sale for the performance report.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { persistQr } = require("./qr-service");
const { recordSale, listProducts } = require("./business-products-service");
const { createNotification } = require("./notification-service");

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const ROLES = ["Cashier", "Manager", "Assistant", "Other"];

let schemaReady = null;
function ensureStaffSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS business_staff (
          id UUID PRIMARY KEY,
          business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          full_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'Other',
          contact TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_business_staff_member
         ON business_staff (business_user_id, staff_user_id)
         WHERE staff_user_id IS NOT NULL AND status = 'active'`
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS business_staff_sales (
          id UUID PRIMARY KEY,
          business_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          staff_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          staff_name TEXT NOT NULL,
          amount NUMERIC(18,2) NOT NULL,
          reference TEXT NOT NULL,
          qr_id UUID,
          items JSONB NOT NULL DEFAULT '[]'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_business_staff_sales_business ON business_staff_sales (business_user_id, created_at DESC)"
      );
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function requireBusiness(userId) {
  const { rows } = await pool.query("SELECT id, account_type, full_name, username FROM users WHERE id = $1 LIMIT 1", [userId]);
  if (!rows[0]) throw new AppError(404, "Account not found");
  if (rows[0].account_type !== "business") throw new AppError(403, "The staff register is available on business accounts");
  return rows[0];
}

// Resolve a contact string (@username, email, phone digits) to an active
// TitoPay user, or null. A register entry without a TitoPay account is fine
// — the person just cannot sign in or sell until they join and are re-added.
async function resolveStaffUser(contact) {
  const text = String(contact || "").trim();
  if (!text) return null;
  const handle = text.replace(/^@/, "").toLowerCase();
  const digits = text.replace(/\D/g, "");
  const clauses = ["LOWER(username) = $1", "LOWER(email) = $1"];
  const values = [handle];
  if (digits.length >= 6) {
    values.push(`%${digits.slice(-9)}`);
    clauses.push(`REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $${values.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, full_name, username, email, account_type, status
     FROM users
     WHERE (${clauses.join(" OR ")}) AND status = 'active'
     ORDER BY (LOWER(username) = $1) DESC, (account_type = 'personal') DESC
     LIMIT 1`,
    values
  );
  return rows[0] || null;
}

function shapeMember(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    role: row.role,
    contact: row.contact,
    username: row.staff_username || "",
    linked: Boolean(row.staff_user_id),
    status: row.status,
    addedAt: row.created_at
  };
}

async function listStaff(businessUserId) {
  await ensureStaffSchema();
  await requireBusiness(businessUserId);
  const { rows } = await pool.query(
    `SELECT bs.*, u.username AS staff_username
     FROM business_staff bs
     LEFT JOIN users u ON u.id = bs.staff_user_id
     WHERE bs.business_user_id = $1 AND bs.status = 'active'
     ORDER BY bs.created_at DESC
     LIMIT 200`,
    [businessUserId]
  );
  return rows.map(shapeMember);
}

async function notifyStaffAdded(business, staffUser, role) {
  const body = `${business.full_name || "A business"} added you to their staff as ${role}. Open My Workplaces on your TitoPay profile — you can make sales for the business from your own phone, and every payment goes straight to the business wallet.`;
  try {
    await createNotification({
      user: { id: staffUser.id, user_type: "customer" },
      channel: "in_app",
      notificationType: "business_staff_added",
      title: `You joined ${business.full_name || "a business"}'s staff`,
      body,
      provider: "in_app",
      metadata: { businessUserId: business.id, role, clientNotificationId: `business-staff-added-${business.id}-${staffUser.id}-${Date.now()}` }
    });
  } catch (error) {
    console.error("[business-staff] add notification failed", { businessUserId: business.id, staffUserId: staffUser.id, message: error.message });
  }
  if (staffUser.email) {
    try {
      const emailCentre = require("./email-centre-service");
      await emailCentre.queueRawEmail({
        recipient: staffUser.email,
        subject: `You are now ${role} at ${business.full_name || "a TitoPay business"}`,
        textBody: [
          `Hi ${staffUser.full_name || "there"},`,
          "",
          `${business.full_name || "A TitoPay business"} has added you to their staff register as ${role}.`,
          "",
          "What you can do: open My Workplaces on your own TitoPay profile and make sales for the business — tap their products, show the payment QR, and the customer's payment goes straight into the business wallet. Sales you take are credited to your name on the business's performance report.",
          "",
          "What you cannot do: you never hold the business's money and you get no access to the business account itself.",
          "",
          "If you were not expecting this, you can ignore it, or ask the business to remove you."
        ].join("\n"),
        htmlBody: [
          `<p>Hi ${emailCentre.escapeHtml(staffUser.full_name || "there")},</p>`,
          `<p><strong>${emailCentre.escapeHtml(business.full_name || "A TitoPay business")}</strong> has added you to their staff register as <strong>${emailCentre.escapeHtml(role)}</strong>.</p>`,
          "<p><strong>What you can do:</strong> open <strong>My Workplaces</strong> on your own TitoPay profile and make sales for the business — tap their products, show the payment QR, and the customer's payment goes straight into the business wallet. Sales you take are credited to your name on the business's performance report.</p>",
          "<p><strong>What you cannot do:</strong> you never hold the business's money and you get no access to the business account itself.</p>",
          "<p>If you were not expecting this, you can ignore it, or ask the business to remove you.</p>"
        ].join("\n"),
        userId: staffUser.id,
        idempotencyKey: `business-staff-added:${business.id}:${staffUser.id}:${Date.now()}`,
        metadata: { businessUserId: business.id, role }
      });
    } catch (error) {
      console.error("[business-staff] add email failed", { businessUserId: business.id, staffUserId: staffUser.id, message: error.message });
    }
  }
}

async function addStaff(businessUserId, payload = {}) {
  await ensureStaffSchema();
  const business = await requireBusiness(businessUserId);
  const fullName = boundedText(payload.fullName, "Full name", { min: 2, max: 120 });
  const role = ROLES.includes(String(payload.role)) ? String(payload.role) : "Other";
  const contact = boundedText(payload.contact, "Contact", { min: 3, max: 120 });
  const staffUser = await resolveStaffUser(contact);
  if (staffUser && staffUser.id === businessUserId) {
    throw new AppError(400, "That contact is this business account itself — add the person's own TitoPay details.");
  }
  const id = uuidv4();
  let row;
  if (staffUser) {
    const { rows } = await pool.query(
      `INSERT INTO business_staff (id, business_user_id, staff_user_id, full_name, role, contact)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (business_user_id, staff_user_id) WHERE staff_user_id IS NOT NULL AND status = 'active'
       DO UPDATE SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, contact = EXCLUDED.contact, updated_at = NOW()
       RETURNING *`,
      [id, businessUserId, staffUser.id, fullName, role, contact]
    );
    row = rows[0];
    await notifyStaffAdded(business, staffUser, role);
  } else {
    const { rows } = await pool.query(
      `INSERT INTO business_staff (id, business_user_id, staff_user_id, full_name, role, contact)
       VALUES ($1, $2, NULL, $3, $4, $5)
       RETURNING *`,
      [id, businessUserId, fullName, role, contact]
    );
    row = rows[0];
  }
  return {
    member: shapeMember({ ...row, staff_username: staffUser?.username || "" }),
    linked: Boolean(staffUser),
    message: staffUser
      ? `${fullName} was added and notified — they can now sell for you from My Workplaces on their own phone.`
      : `${fullName} was saved on the register. No TitoPay account matches "${contact}" yet, so they were not notified and cannot sell until they join TitoPay and you add them again.`
  };
}

// "I added them and nothing appears on their phone."
//
// A register entry only reaches a person when the contact typed matches an
// active TitoPay account. When it does not, the entry is still saved — that is
// deliberate, a business may list someone before they join — but nothing is
// sent and My Workplaces stays empty for them. The only sign of it used to be
// one toast at the moment of adding.
//
// This is the repair: try again on the stored contact, or on a corrected one.
// It is also the flow for "they have joined TitoPay since I added them".
async function relinkStaff(businessUserId, memberId, payload = {}) {
  await ensureStaffSchema();
  const business = await requireBusiness(businessUserId);
  const { rows: existing } = await pool.query(
    "SELECT * FROM business_staff WHERE id = $1 AND business_user_id = $2 AND status = 'active' LIMIT 1",
    [memberId, businessUserId]
  );
  const member = existing[0];
  if (!member) throw new AppError(404, "That person is not on your staff register");

  const contact = payload.contact === undefined || payload.contact === null || String(payload.contact).trim() === ""
    ? member.contact
    : boundedText(payload.contact, "Contact", { min: 3, max: 120 });

  const staffUser = await resolveStaffUser(contact);
  if (staffUser && staffUser.id === businessUserId) {
    throw new AppError(400, "That contact is this business account itself — use the person's own TitoPay details.");
  }
  if (!staffUser) {
    // Save the corrected contact even when it still does not match, so the
    // owner is not retyping it every attempt.
    if (contact !== member.contact) {
      await pool.query("UPDATE business_staff SET contact = $1, updated_at = NOW() WHERE id = $2", [contact, memberId]);
    }
    throw new AppError(404, `No active TitoPay account matches "${contact}". Check the spelling with them, or ask them to sign up first — the exact @username is the most reliable.`);
  }
  if (member.staff_user_id === staffUser.id) {
    return { member: shapeMember({ ...member, contact, staff_username: staffUser.username }), linked: true, message: `${member.full_name} is already linked to @${staffUser.username}.` };
  }
  // The partial unique index allows one active row per (business, staff user).
  const { rows: clash } = await pool.query(
    "SELECT id, full_name FROM business_staff WHERE business_user_id = $1 AND staff_user_id = $2 AND status = 'active' AND id <> $3 LIMIT 1",
    [businessUserId, staffUser.id, memberId]
  );
  if (clash[0]) {
    throw new AppError(409, `@${staffUser.username} is already on your staff register as ${clash[0].full_name}. Remove that entry first if this one should replace it.`);
  }

  const { rows } = await pool.query(
    `UPDATE business_staff SET staff_user_id = $1, contact = $2, updated_at = NOW()
     WHERE id = $3 AND business_user_id = $4 AND status = 'active'
     RETURNING *`,
    [staffUser.id, contact, memberId, businessUserId]
  );
  await notifyStaffAdded(business, staffUser, rows[0].role);
  return {
    member: shapeMember({ ...rows[0], staff_username: staffUser.username }),
    linked: true,
    message: `${rows[0].full_name} is linked to @${staffUser.username} and has been notified — My Workplaces now shows your business on their phone.`
  };
}

async function removeStaff(businessUserId, memberId) {
  await ensureStaffSchema();
  const business = await requireBusiness(businessUserId);
  const { rows } = await pool.query(
    `UPDATE business_staff SET status = 'removed', updated_at = NOW()
     WHERE id = $1 AND business_user_id = $2 AND status = 'active'
     RETURNING *`,
    [memberId, businessUserId]
  );
  if (!rows[0]) throw new AppError(404, "That person is not on your staff register");
  if (rows[0].staff_user_id) {
    try {
      await createNotification({
        user: { id: rows[0].staff_user_id, user_type: "customer" },
        channel: "in_app",
        notificationType: "business_staff_removed",
        title: "Removed from a staff register",
        body: `${business.full_name || "A business"} removed you from their staff. Selling for them from My Workplaces is switched off.`,
        provider: "in_app",
        metadata: { businessUserId, clientNotificationId: `business-staff-removed-${rows[0].id}-${rows[0].updated_at?.toISOString?.() || ""}` }
      });
    } catch (error) {
      console.error("[business-staff] removal notification failed", { memberId, message: error.message });
    }
  }
  return shapeMember(rows[0]);
}

async function listMyWorkplaces(staffUserId) {
  await ensureStaffSchema();
  const { rows } = await pool.query(
    `SELECT bs.business_user_id, bs.role, bs.created_at, u.full_name AS business_name, u.username AS business_username
     FROM business_staff bs
     JOIN users u ON u.id = bs.business_user_id AND u.status = 'active'
     WHERE bs.staff_user_id = $1 AND bs.status = 'active'
     ORDER BY bs.created_at DESC
     LIMIT 50`,
    [staffUserId]
  );
  return rows.map((row) => ({
    businessUserId: row.business_user_id,
    businessName: row.business_name,
    businessUsername: row.business_username,
    role: row.role,
    since: row.created_at
  }));
}

async function assertActiveStaff(staffUserId, businessUserId) {
  await ensureStaffSchema();
  const { rows } = await pool.query(
    `SELECT bs.*, u.full_name AS business_name, u.account_type
     FROM business_staff bs
     JOIN users u ON u.id = bs.business_user_id
     WHERE bs.staff_user_id = $1 AND bs.business_user_id = $2 AND bs.status = 'active'
     LIMIT 1`,
    [staffUserId, businessUserId]
  );
  if (!rows[0] || rows[0].account_type !== "business") {
    throw new AppError(403, "You are not on this business's staff register");
  }
  return rows[0];
}

async function workplaceProducts(staffUserId, businessUserId) {
  await assertActiveStaff(staffUserId, businessUserId);
  return listProducts(businessUserId);
}

// The staff sale: price the basket (or take a typed amount), count tracked
// stock down on the business, log the sale under the staff member's name,
// and mint the payment QR that pays the BUSINESS wallet.
async function staffSale(staffUserId, businessUserId, payload = {}) {
  const membership = await assertActiveStaff(staffUserId, businessUserId);
  const { rows: staffRows } = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [staffUserId]);
  const staffName = staffRows[0]?.full_name || membership.full_name || "Staff";
  const items = Array.isArray(payload.items) ? payload.items : [];
  let total;
  let lines = [];
  let reference;
  if (items.length) {
    const sale = await recordSale(businessUserId, {
      items,
      allowNegative: payload.allowNegative === true,
      reference: `SALE-${Date.now()}-BY-${(staffRows[0]?.username || "staff").slice(0, 24)}`
    });
    total = sale.total;
    lines = sale.lines;
    reference = sale.reference;
  } else {
    total = money(payload.amount);
    if (!(total > 0) || total > 100000) throw new AppError(400, "Enter a sale amount between R0.01 and R100,000");
    reference = `SALE-${Date.now()}-BY-${(staffRows[0]?.username || "staff").slice(0, 24)}`;
  }
  const label = boundedText(payload.label || `${membership.business_name} — served by ${staffName}`, "Label", { min: 1, max: 48 });
  const qr = await persistQr({
    userId: businessUserId,
    codeType: "dynamic",
    amount: total,
    label,
    metadata: { staffSale: true, staffUserId, staffName, reference }
  });
  const saleId = uuidv4();
  await pool.query(
    `INSERT INTO business_staff_sales (id, business_user_id, staff_user_id, staff_name, amount, reference, qr_id, items)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)`,
    [saleId, businessUserId, staffUserId, staffName, total, reference, qr.id, JSON.stringify(lines)]
  );
  return {
    saleId,
    total,
    reference,
    lines,
    businessName: membership.business_name,
    qr: { id: qr.id, amount: qr.amount, label: qr.label, imageDataUrl: qr.imageDataUrl, reference: qr.reference }
  };
}

// Till sales per staff member in a window — merged into the Sales suite's
// staff performance report next to door scans.
async function staffSalesTotals(businessUserId, { from, to } = {}) {
  await ensureStaffSchema();
  const values = [businessUserId];
  let clause = "";
  if (from) { values.push(from); clause += ` AND created_at >= $${values.length}::DATE`; }
  if (to) { values.push(to); clause += ` AND created_at < ($${values.length}::DATE + INTERVAL '1 day')`; }
  const { rows } = await pool.query(
    `SELECT staff_user_id, staff_name, COUNT(*)::int AS sales_count, COALESCE(SUM(amount), 0) AS sales_total, MAX(created_at) AS last_sale_at
     FROM business_staff_sales
     WHERE business_user_id = $1${clause}
     GROUP BY staff_user_id, staff_name`,
    values
  );
  return rows.map((row) => ({
    staffUserId: row.staff_user_id,
    staffName: row.staff_name,
    salesCount: Number(row.sales_count),
    salesTotal: money(row.sales_total),
    lastSaleAt: row.last_sale_at
  }));
}

module.exports = {
  relinkStaff,
  ensureStaffSchema,
  listStaff,
  addStaff,
  removeStaff,
  listMyWorkplaces,
  assertActiveStaff,
  workplaceProducts,
  staffSale,
  staffSalesTotals,
  resolveStaffUser
};
