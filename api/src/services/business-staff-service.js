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
const { recordSale, priceSale, listProducts } = require("./business-products-service");
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
      // A TILL SALE IS NOT A PAYMENT UNTIL SOMEBODY PAYS IT.
      //
      // These rows were written when the QR was MINTED and nothing ever
      // revisited them, so a customer who changed their mind and walked away
      // still counted towards the cashier's totals for ever. The row is worth
      // keeping at mint time — it is the record of who rang up what — but it
      // has to say whether the money arrived.
      //
      //   pending  the QR is showing, nobody has paid it yet
      //   paid     qr-service settled a payment against this QR
      //   legacy   written before this column existed. Deliberately NOT
      //            backfilled to either of the other two: some were paid and
      //            some were abandoned, and this platform does not know which.
      //            Guessing would put a fabricated number in a revenue report.
      await pool.query("ALTER TABLE business_staff_sales ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'");
      await pool.query("ALTER TABLE business_staff_sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ");
      await pool.query("ALTER TABLE business_staff_sales ADD COLUMN IF NOT EXISTS transaction_id UUID");
      // Only rows that predate the column: anything written from now on is
      // created as pending by staffSale() and moved by qr-service.
      await pool.query(
        `UPDATE business_staff_sales SET status = 'legacy'
          WHERE status = 'pending' AND paid_at IS NULL AND created_at < NOW() - INTERVAL '1 hour'`
      );
      await pool.query(
        "CREATE INDEX IF NOT EXISTS idx_business_staff_sales_qr ON business_staff_sales (qr_id) WHERE qr_id IS NOT NULL"
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
  const body = `${business.full_name || "A business"} added you to their staff as ${role}. Open My Workplaces on your TitoPay profile. You can make sales for the business from your own phone, and every payment goes straight to the business wallet.`;
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
          "What you can do: open My Workplaces on your own TitoPay profile and make sales for the business: tap their products, show the payment QR, and the customer's payment goes straight into the business wallet. Sales you take are credited to your name on the business's performance report.",
          "",
          "What you cannot do: you never hold the business's money and you get no access to the business account itself.",
          "",
          "If you were not expecting this, you can ignore it, or ask the business to remove you."
        ].join("\n"),
        htmlBody: [
          `<p>Hi ${emailCentre.escapeHtml(staffUser.full_name || "there")},</p>`,
          `<p><strong>${emailCentre.escapeHtml(business.full_name || "A TitoPay business")}</strong> has added you to their staff register as <strong>${emailCentre.escapeHtml(role)}</strong>.</p>`,
          "<p><strong>What you can do:</strong> open <strong>My Workplaces</strong> on your own TitoPay profile and make sales for the business: tap their products, show the payment QR, and the customer's payment goes straight into the business wallet. Sales you take are credited to your name on the business's performance report.</p>",
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
    throw new AppError(400, "That contact is this business account itself. Add the person's own TitoPay details.");
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
      ? `${fullName} was added and notified. They can now sell for you from My Workplaces on their own phone.`
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
    throw new AppError(400, "That contact is this business account itself. Use the person's own TitoPay details.");
  }
  if (!staffUser) {
    // Save the corrected contact even when it still does not match, so the
    // owner is not retyping it every attempt.
    if (contact !== member.contact) {
      await pool.query("UPDATE business_staff SET contact = $1, updated_at = NOW() WHERE id = $2", [contact, memberId]);
    }
    throw new AppError(404, `No active TitoPay account matches "${contact}". Check the spelling with them, or ask them to sign up first. Their exact @username is the most reliable.`);
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
    message: `${rows[0].full_name} is linked to @${staffUser.username} and has been notified. My Workplaces now shows your business on their phone.`
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
// THE TILL, WHOEVER IS STANDING AT IT.
//
// A cashier's till and the owner's own till are the same act — price a
// basket, show a QR, wait — so they are the same code. Owning the shop only
// changes who is named on the row and who is allowed to open it; it does not
// change when the goods leave the shelf.
async function mintTillSale({ businessUserId, operatorUserId, operatorName, operatorHandle, businessName, payload }) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const reference = `SALE-${Date.now()}-BY-${String(operatorHandle || "staff").slice(0, 24)}`;
  let total;
  let lines = [];
  if (items.length) {
    // PRICED, NOT SOLD. The basket is valued so the QR can carry the right
    // amount, and the stock check still refuses a basket the shelf cannot
    // cover — but nothing leaves the shelf here. Goods move when the money
    // does, in markStaffSalePaid() below.
    const priced = await priceSale(businessUserId, {
      items,
      allowNegative: payload.allowNegative === true
    });
    total = priced.total;
    lines = priced.lines;
  } else {
    total = money(payload.amount);
    if (!(total > 0) || total > 100000) throw new AppError(400, "Enter a sale amount between R0.01 and R100,000");
  }
  const label = boundedText(payload.label || `${businessName} · served by ${operatorName}`, "Label", { min: 1, max: 48 });
  const qr = await persistQr({
    userId: businessUserId,
    codeType: "dynamic",
    amount: total,
    label,
    metadata: { staffSale: true, staffUserId: operatorUserId, staffName: operatorName, reference }
  });
  const saleId = uuidv4();
  // PENDING, said out loud rather than left to a column default. Nothing has
  // been paid at this point: the QR has only just been minted and is about to
  // be shown to the customer.
  await pool.query(
    `INSERT INTO business_staff_sales (id, business_user_id, staff_user_id, staff_name, amount, reference, qr_id, items, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, 'pending')`,
    [saleId, businessUserId, operatorUserId, operatorName, total, reference, qr.id, JSON.stringify(lines)]
  );
  return {
    saleId,
    total,
    reference,
    lines,
    businessName,
    qr: { id: qr.id, amount: qr.amount, label: qr.label, imageDataUrl: qr.imageDataUrl, reference: qr.reference }
  };
}

async function staffSale(staffUserId, businessUserId, payload = {}) {
  const membership = await assertActiveStaff(staffUserId, businessUserId);
  const { rows: staffRows } = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [staffUserId]);
  return mintTillSale({
    businessUserId,
    operatorUserId: staffUserId,
    operatorName: staffRows[0]?.full_name || membership.full_name || "Staff",
    operatorHandle: staffRows[0]?.username,
    businessName: membership.business_name,
    payload
  });
}

// THE OWNER'S OWN TILL. Same act, same pending row, same settlement hook.
//
// Before this existed the owner's Make a Sale wrote the stock movement the
// moment the QR appeared, so an abandoned basket left the shelf count wrong
// for ever — the same defect the staff till had, on the path most businesses
// actually use.
//
// The row is written with staff_user_id = business_user_id. That is what
// marks it as the owner's own, and staffSalesTotals() drops those rows: the
// staff performance report answers "how are my cashiers doing", and the owner
// appearing in their own staff league table would be a new, wrong answer to
// it. The owner's sale reports where it always has — the wallet transaction
// and the stock movement, both of which now happen only on payment.
async function ownerTillSale(businessUserId, payload = {}) {
  await ensureStaffSchema();
  const { rows } = await pool.query(
    "SELECT full_name, username, account_type FROM users WHERE id = $1",
    [businessUserId]
  );
  const owner = rows[0];
  if (!owner) throw new AppError(404, "Account not found");
  if (owner.account_type !== "business") throw new AppError(403, "Only a business account can take a sale");
  const businessName = owner.full_name || "Your business";
  return mintTillSale({
    businessUserId,
    operatorUserId: businessUserId,
    operatorName: businessName,
    operatorHandle: owner.username,
    businessName,
    payload
  });
}

// CALLED BY qr-service WHEN A PAYMENT SETTLES AGAINST A TILL QR.
//
// Scoped by qr_id and by status, so it can only ever move a row that is still
// waiting: a replayed or duplicated settlement updates nothing rather than
// double-counting a sale. Returns whether it moved one, so the caller can tell
// a till payment from an ordinary QR payment without asking first.
//
// Best effort by the caller's choice, never by this function's: the money has
// already moved by the time this runs, and a till row that fails to update is
// a reporting problem, not a lost payment.
async function markStaffSalePaid(qrId, transactionId = null) {
  if (!qrId) return false;
  await ensureStaffSchema();
  const { rows } = await pool.query(
    `UPDATE business_staff_sales
        SET status = 'paid', paid_at = NOW(), transaction_id = $2
      WHERE qr_id = $1 AND status = 'pending'
      RETURNING id, business_user_id, reference, items`,
    [qrId, transactionId]
  );
  const sale = rows[0];
  if (!sale) return false;
  // AND NOW THE GOODS LEAVE THE SHELF, because now they have been paid for.
  //
  // allowNegative is true here and that is deliberate. The money has already
  // moved; refusing the stock movement would leave a paid sale with the item
  // still counted on the shelf, which is a worse lie than a negative count.
  // If another till sold the last one while this customer was paying, the
  // count goes negative and says so — the same state the "Sell anyway" path
  // has always produced, and the same fix: a stock take.
  const lines = Array.isArray(sale.items) ? sale.items : [];
  if (lines.length) {
    await recordSale(sale.business_user_id, {
      items: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
      allowNegative: true,
      reference: sale.reference
    }).catch(() => null);
  }
  return true;
}

// Till sales per staff member in a window — merged into the Sales suite's
// staff performance report next to door scans.
async function staffSalesTotals(businessUserId, { from, to } = {}) {
  await ensureStaffSchema();
  const values = [businessUserId];
  let clause = "";
  // SA calendar dates (UTC+2), so a day's first two hours are not misfiled.
  if (from) { values.push(from); clause += ` AND created_at >= ($${values.length}::DATE AT TIME ZONE 'Africa/Johannesburg')`; }
  if (to) { values.push(to); clause += ` AND created_at < (($${values.length}::DATE + INTERVAL '1 day') AT TIME ZONE 'Africa/Johannesburg')`; }
  // SALES TOTAL IS PAID SALES. That is the number a business banks on, and
  // reporting a rung-up-but-unpaid sale inside it is how a till total stops
  // matching the wallet. Pending and legacy travel beside it, never inside it,
  // so an abandoned sale is visible rather than silently counted.
  const { rows } = await pool.query(
    `SELECT staff_user_id,
            staff_name,
            COUNT(*) FILTER (WHERE status = 'paid')::int          AS paid_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)    AS paid_total,
            COUNT(*) FILTER (WHERE status = 'pending')::int       AS pending_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_total,
            COUNT(*) FILTER (WHERE status = 'legacy')::int        AS legacy_count,
            COALESCE(SUM(amount) FILTER (WHERE status = 'legacy'), 0)  AS legacy_total,
            MAX(created_at) AS last_sale_at
     FROM business_staff_sales
     WHERE business_user_id = $1
       AND staff_user_id <> business_user_id${clause}
     GROUP BY staff_user_id, staff_name`,
    values
  );
  return rows.map((row) => ({
    staffUserId: row.staff_user_id,
    staffName: row.staff_name,
    salesCount: Number(row.paid_count),
    salesTotal: money(row.paid_total),
    // Rung up and showing a QR, not yet paid.
    pendingCount: Number(row.pending_count),
    pendingTotal: money(row.pending_total),
    // Written before payment was tracked; this platform cannot say whether
    // these were paid, and says so rather than picking an answer.
    legacyCount: Number(row.legacy_count),
    legacyTotal: money(row.legacy_total),
    lastSaleAt: row.last_sale_at
  }));
}

module.exports = {
  markStaffSalePaid,
  relinkStaff,
  ensureStaffSchema,
  listStaff,
  addStaff,
  removeStaff,
  listMyWorkplaces,
  assertActiveStaff,
  workplaceProducts,
  staffSale,
  ownerTillSale,
  staffSalesTotals,
  resolveStaffUser
};
