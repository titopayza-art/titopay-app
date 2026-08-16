const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { writeAuditLog } = require("./audit-service");
const { createTransaction } = require("./transaction-service");
const { calculateFee, roundMoney } = require("./pricing-service");

async function persistQr({ userId, codeType, amount = null, label = null, metadata = {}, expiresAt = null }) {
  const id = uuidv4();
  const reference = `QR-${Date.now()}`;
  // WHAT GETS PRINTED ON A WALL, AND WHY IT IS NOW SHORT.
  //
  // Every character encoded here makes the printed code denser, and a denser
  // code has smaller modules at the same physical size, which is exactly what a
  // phone camera struggles with across a counter or off a lit screen.
  //
  // This carried the id, the owner's account UUID, the amount, the currency,
  // the reference, the label and a metadata object: 219 characters, a 61x61
  // code. The server reads NONE of it. payQr resolves the owner, the price, the
  // status and the expiry from the qr_codes row, keyed on the id alone, which
  // is why a forged payload has always changed nothing (proven in
  // verification/qr-tamper-audit.js). All of it was dead weight, shrinking the
  // modules of every poster TitoPay has ever printed.
  //
  //   was    219 characters   61 x 61 modules
  //   now     66 characters   37 x 37 modules
  //
  // At one printed size that makes each module about 65% wider, which is the
  // single biggest thing that can be done for scanning reliability.
  //
  // codeType stays because the scanner classifies a payment code on id PLUS
  // codeType, and because a reader can tell a one-off sale from a till code
  // without a round trip. Everything already printed still carries the long
  // form and still scans: the id is the only field anything has ever read.
  const payload = { id, codeType };
  // THE QUIET ZONE. The QR standard requires four modules of clear border, and
  // this was set to one. A camera finds a code by locating its three finder
  // patterns against clear space; starve that space and the lock fails, most
  // often in exactly the conditions a till is in — a busy counter, a printed
  // sheet with text near it, a code shown on a screen.
  const render = { margin: 4, color: { dark: "#0057FF", light: "#FFFFFF" } };
  const imageSvg = await QRCode.toString(JSON.stringify(payload), { type: "svg", ...render });
  const imageDataUrl = await QRCode.toDataURL(JSON.stringify(payload), render);
  await pool.query(
    `INSERT INTO qr_codes
      (id, user_id, code_type, label, amount, reference, payload, image_svg, image_data_url, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, userId, codeType, label, amount, reference, JSON.stringify(payload), imageSvg, imageDataUrl, expiresAt]
  );
  return {
    id,
    reference,
    codeType,
    amount,
    label,
    imageSvg,
    imageDataUrl,
    payload
  };
}

async function createQr(actor, payload) {
  const qr = await persistQr({
    userId: actor.userId,
    codeType: payload.codeType || "merchant",
    amount: payload.amount ?? null,
    label: payload.label ?? null,
    metadata: payload.metadata || {},
    expiresAt: payload.expiresAt || null
  });
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "qr_created",
    entityType: "qr_code",
    entityId: qr.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { codeType: qr.codeType }
  });
  return qr;
}

async function getMerchantQrs(userId) {
  const { rows } = await pool.query(
    `SELECT id, code_type AS "codeType", label, amount, reference, image_data_url AS "imageDataUrl", created_at AS "createdAt"
     FROM qr_codes
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

async function getQrHistory(userId) {
  const { rows } = await pool.query(
    `SELECT id, service_code AS "serviceCode", amount, fee, total, status, recipient_reference AS "recipientReference", created_at AS "createdAt"
     FROM transactions
     WHERE user_id = $1 AND qr_code_id IS NOT NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return rows;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A camera scan hands over the QR's whole JSON payload; a typed entry hands
// over the UUID. Both arrive on the same field, so both are unwrapped here
// rather than twice, differently.
function readQrId(raw) {
  let qrId = String(raw || "").trim();
  if (qrId.startsWith("{")) {
    let parsed = null;
    try { parsed = JSON.parse(qrId); } catch { parsed = null; }
    // Tickets and payment QRs are separate instruments: a ticket must never be
    // payable, and a payment QR must never admit anyone through a gate.
    if (parsed && parsed.type === "titopay_ticket") {
      throw new AppError(400, "This is a TitoPay event ticket, not a payment QR. Nothing can be paid with it. Present it at the event entrance instead.");
    }
    qrId = parsed && parsed.id ? String(parsed.id).trim() : "";
  }
  if (!UUID_PATTERN.test(qrId)) throw new AppError(404, "QR code not found");
  return qrId;
}

// WHO OWNS THIS QR CODE, ANSWERED BEFORE ANY MONEY MOVES.
//
// The review screen has always had a card for this, and it has always read
// "Owner not confirmed", for every code and every customer, because the app
// called an endpoint that was never built. The Security Tip screen tells people
// to "read the verified recipient name before you press Confirm" and there was
// no name to read.
//
// What comes back is the least that answers the question: the name a payer can
// check against the shopfront in front of them, the TitoPay username, and
// whether it is a business or a person. Never an email address, never a phone
// number, never a wallet number, never a balance — a payment QR is shown to
// strangers by design, so anything returned here is effectively public.
async function getQrDetails(actor, rawQrId) {
  const qrId = readQrId(rawQrId);
  const { rows } = await pool.query(
    `SELECT q.id, q.reference, q.code_type, q.label, q.amount, q.status, q.expires_at,
            u.id AS owner_id, u.full_name, u.username, u.account_type,
            m.business_name
       FROM qr_codes q
       JOIN users u ON u.id = q.user_id
       LEFT JOIN merchants m ON m.user_id = q.user_id AND m.status = 'active'
      WHERE q.id = $1
      LIMIT 1`,
    [qrId]
  );
  const qr = rows[0];
  if (!qr) throw new AppError(404, "QR code not found");
  const isBusiness = String(qr.account_type || "").toLowerCase() === "business";
  return {
    id: qr.id,
    reference: qr.reference,
    codeType: qr.code_type,
    label: qr.label || null,
    amount: qr.amount === null ? null : Number(qr.amount),
    status: qr.status || "active",
    expired: Boolean(qr.expires_at && new Date(qr.expires_at).getTime() < Date.now()),
    isOwnCode: qr.owner_id === actor.userId,
    owner: {
      // A registered business trades under its business name; a person is known
      // by the name on their verified identity.
      displayName: (isBusiness && qr.business_name) ? qr.business_name : (qr.full_name || ""),
      username: qr.username || "",
      accountType: isBusiness ? "business" : "personal"
    }
  };
}

// HAS THIS CODE BEEN PAID? THE ONE QUESTION A TILL NEEDS TO ASK.
//
// Make a Sale puts a code on screen and waits. To know when the money lands,
// the app was searching the MERCHANT'S OWN transaction list for a credit of the
// right amount. There has never been such a row: a payment writes ONE
// transaction, owned by the payer, and the merchant is credited through
// wallet_ledger. listTransactionsForUser filters on t.user_id, so the till was
// looking for something that could not be there, and every completed sale sat
// on "Waiting for payment..." until it expired.
//
// This answers it directly, for the owner of the code and nobody else.
//
// What comes back is what a slip needs and no more. The payer is named, as they
// would be on any wallet transfer the merchant receives, and nothing else about
// them is disclosed.
async function getQrPaymentStatus(actor, rawQrId) {
  const qrId = readQrId(rawQrId);
  const { rows } = await pool.query(
    "SELECT id, user_id, code_type, amount, reference, status, expires_at FROM qr_codes WHERE id = $1 LIMIT 1",
    [qrId]
  );
  const qr = rows[0];
  // Not the owner is the same answer as not existing: a code id is public, and
  // whether it has been paid is the merchant's business alone.
  if (!qr || qr.user_id !== actor.userId) throw new AppError(404, "QR code not found");

  const { rows: paid } = await pool.query(
    `SELECT t.id, t.amount, t.fee, t.total, t.status, t.reference, t.created_at,
            (t.metadata->>'netAmount')::NUMERIC AS net_amount,
            u.full_name, u.username, u.account_type,
            m.business_name
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN merchants m ON m.user_id = t.user_id AND m.status = 'active'
      WHERE t.qr_code_id = $1 AND t.status = 'completed'
      ORDER BY t.created_at ASC
      LIMIT 1`,
    [qr.id]
  );
  const row = paid[0];
  if (!row) {
    return {
      qrId: qr.id,
      paid: false,
      codeStatus: qr.status || "active",
      expired: Boolean(qr.expires_at && new Date(qr.expires_at).getTime() < Date.now())
    };
  }
  const payerIsBusiness = String(row.account_type || "").toLowerCase() === "business";
  // WHAT THE MERCHANT ACTUALLY RECEIVED. On a QR payment the fee is the
  // PAYER'S: they are debited amount + fee and the merchant is credited the
  // amount in full. The slip used to subtract that fee from the merchant's
  // takings, so a R250.00 sale printed as R249.50 received.
  const received = row.net_amount === null || row.net_amount === undefined
    ? Number(row.amount)
    : Number(row.net_amount);
  const merchantFee = roundMoney(Math.max(0, Number(row.amount) - received));
  return {
    qrId: qr.id,
    paid: true,
    codeStatus: qr.status || "paid",
    expired: false,
    transactionId: row.id,
    reference: row.reference,
    paidAt: row.created_at,
    amount: Number(row.amount),
    received,
    // Named separately so a slip can say who paid it, never implying the
    // merchant was charged it.
    payerFee: Number(row.fee || 0),
    payerTotal: Number(row.total || 0),
    // What the merchant was charged on this sale, so the slip can show it
    // rather than leaving a gap between the sale price and the credit.
    merchantFee,
    payer: {
      displayName: (payerIsBusiness && row.business_name) ? row.business_name : (row.full_name || ""),
      username: row.username || "",
      accountType: payerIsBusiness ? "business" : "personal"
    }
  };
}

async function payQr(actor, payload) {
  // Anything that is not a UUID answers a clean 404 rather than a database
  // error, and an event ticket is refused by name.
  const qrId = readQrId(payload.qrId);
  const { rows } = await pool.query(
    `SELECT q.*, u.username, m.id AS merchant_row_id
     FROM qr_codes q
     JOIN users u ON u.id = q.user_id
     LEFT JOIN merchants m ON m.user_id = q.user_id
     WHERE q.id = $1
     LIMIT 1`,
    [qrId]
  );
  const qr = rows[0];
  if (!qr) throw new AppError(404, "QR code not found");
  // Paying your own QR moved money in a circle and took the fee for doing it.
  // Nothing about it is a payment, and a person who scans their own code has
  // made a mistake that should be named rather than charged for.
  if (qr.user_id === actor.userId) {
    throw new AppError(400, "This is your own QR code. Show it to the person paying you instead of scanning it yourself.");
  }
  if (qr.status && qr.status !== "active") throw new AppError(409, "This QR code is no longer available for payment");
  if (qr.expires_at && new Date(qr.expires_at).getTime() < Date.now()) throw new AppError(410, "This QR code has expired");
  if (qr.code_type === "dynamic") {
    const existing = await pool.query(
      "SELECT id, reference FROM transactions WHERE qr_code_id = $1 AND status IN ('completed', 'pending') LIMIT 1",
      [qr.id]
    );
    if (existing.rows[0]) throw new AppError(409, "This QR code has already been paid");
  }
  // THE PRICE ON A CODE IS THE MERCHANT'S, AND THE PAYER'S PHONE IS THE ONE
  // PLACE IT MUST NOT BE TAKEN FROM.
  //
  // This used to read `payload.amount ?? qr.amount`, so the REQUEST BODY won
  // and the merchant's own price was only a fallback. Make a Sale mints a
  // dynamic code for one exact amount and shows "Waiting for payment...". A
  // payer sending amount: 1 against a R200 sale was paid through: the merchant
  // was credited R1.00, the code was marked paid, and the till screen turned
  // over to a completed sale. Measured, in verification/qr-tamper-audit.js.
  //
  // A QR is handed to strangers by design, so everything in it is readable and
  // editable by whoever is paying. Only the id may be trusted from the scan;
  // the price is re-read from TitoPay's own row.
  //
  // An open code (no amount) is unchanged: the payer names the amount, because
  // on those the merchant never named one.
  const fixedAmount = qr.amount === null || qr.amount === undefined ? null : Number(qr.amount);
  const requested = payload.amount === undefined || payload.amount === null ? null : Number(payload.amount);
  let amount;
  if (fixedAmount !== null && fixedAmount > 0) {
    // A disagreement is refused rather than silently corrected: nobody may be
    // charged an amount they did not see on their own review screen.
    if (requested !== null && Number.isFinite(requested) && Math.abs(requested - fixedAmount) >= 0.005) {
      throw new AppError(409,
        `This QR code is for R${fixedAmount.toFixed(2)}. Scan it again to pay the amount the merchant asked for. Nothing was taken from your wallet.`);
    }
    amount = fixedAmount;
  } else {
    amount = Number(requested ?? 0);
  }
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "Amount must be greater than zero");
  // TWO SIDES, PRICED SEPARATELY.
  //
  //   the customer pays   R1.50 + 1%, capped at R10, ON TOP of the amount
  //   the merchant pays   1.5% of the amount, OUT OF what they are credited
  //
  // Both come from the pricing schedule, so an operator changes them in the
  // admin console and neither is a number written into this file. The merchant
  // rule has existed since the schedule was written and was read by nothing:
  // every merchant was credited in full on every payment ever settled.
  const merchantPricing = await calculateFee("merchant_qr_payment", amount);
  const merchantFee = Math.min(roundMoney(merchantPricing.fee), amount);
  const tx = await createTransaction(actor, {
    serviceCode: "qr_payment",
    amount,
    recipient: qr.username,
    idempotencyKey: payload.idempotencyKey,
    merchantReceivesFee: false,
    recipientFee: merchantFee,
    metadata: {
      qrId: qr.id,
      qrReference: qr.reference,
      merchantUserId: qr.user_id,
      merchantFeeServiceCode: "merchant_qr_payment",
      merchantFeePercentage: Number(merchantPricing.percentageFee || 0)
    }
  });
  await pool.query(
    "UPDATE transactions SET qr_code_id = $2, merchant_id = $3 WHERE id = $1",
    [tx.transactionId, qr.id, qr.merchant_row_id || null]
  );
  if (qr.code_type === "dynamic") {
    await pool.query("UPDATE qr_codes SET status = 'paid', updated_at = NOW() WHERE id = $1", [qr.id]);
  }
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "qr_paid",
    entityType: "transaction",
    entityId: tx.transactionId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { qrId, amount }
  });
  return {
    transactionId: tx.transactionId,
    qrId,
    amount,
    fee: tx.fee,
    total: tx.total,
    netAmount: tx.netAmount,
    status: "completed",
    reference: tx.reference
  };
}

function qrResponse(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    codeType: row.code_type || row.codeType,
    amount: row.amount,
    label: row.label,
    imageSvg: row.image_svg || row.imageSvg,
    imageDataUrl: row.image_data_url || row.imageDataUrl,
    payload: row.payload
  };
}

async function ensureProfileQr(actor) {
  const isBusiness = actor.accountType === "business";
  const table = isBusiness ? "business_qr_codes" : "user_qr_codes";
  const lookupColumn = isBusiness ? "user_id" : "user_id";
  const { rows } = await pool.query(
    `SELECT q.*
     FROM ${table} p
     JOIN qr_codes q ON q.id = p.qr_code_id
     WHERE p.${lookupColumn} = $1 AND p.status = 'active'
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [actor.userId]
  );
  if (rows[0]) return qrResponse(rows[0]);

  const qr = await persistQr({
    userId: actor.userId,
    codeType: "static",
    label: isBusiness ? "TitoPay Business Profile QR" : "TitoPay Profile QR",
    metadata: { profileQr: true, accountType: actor.accountType || "personal" }
  });
  await pool.query(
    `INSERT INTO ${table} (id, user_id, qr_code_id, status)
     VALUES ($1,$2,$3,'active')`,
    [uuidv4(), actor.userId, qr.id]
  );
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "profile_qr_created",
    entityType: "qr_code",
    entityId: qr.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { accountType: actor.accountType || "personal" }
  });
  return qr;
}

async function shareQr(actor, payload = {}) {
  if (!payload.qrId) throw new AppError(400, "QR ID is required");
  await writeAuditLog({
    actorType: actor.userType,
    actorId: actor.userId,
    action: "qr_shared",
    entityType: "qr_code",
    entityId: payload.qrId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { channel: payload.channel || "web_share" }
  });
  return { ok: true };
}

module.exports = {
  createQr,
  // Exported for staff selling: a QR minted with the BUSINESS's userId pays
  // the business wallet no matter whose phone displays it.
  persistQr,
  getMerchantQrs,
  getQrHistory,
  getQrDetails,
  getQrPaymentStatus,
  payQr,
  ensureProfileQr,
  shareQr
};
