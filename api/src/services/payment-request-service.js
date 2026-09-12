"use strict";

// PAYMENT REQUESTS: ASKING IS FREE, PAYING IS REAL.
//
// A payment request stores WHO asked WHOM for HOW MUCH and WHY. No money moves
// when it is created. Money moves exactly once, when the person being asked
// presses Pay, and that payment runs through createTransaction on the same
// wallet_transfer rails as Send Money - wallet locks, ledger entries,
// idempotency, receipts - so a request can never move money any way a normal
// transfer could not.
//
// A bill split is the same thing fanned out: one request per participant,
// sharing a split group, each independently payable or declinable.
//
// The person being asked is always in control: they can pay or decline, and
// nothing leaves their wallet until they choose. The requester can cancel a
// request that has not been answered. A recurring request spawns its next
// occurrence only when the current one is PAID - decline or cancel ends the
// series - so a series can never pile up unpaid copies.

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { verifyRecipient } = require("./security-service");
const { createNotification } = require("./notification-service");

const REQUEST_STATUSES = new Set(["pending", "paying", "paid", "declined", "cancelled"]);
const RECURRING_FREQUENCIES = { weekly: "7 days", monthly: "1 month", quarterly: "3 months" };
const MAX_REQUEST_AMOUNT = 1000000;
const MAX_SPLIT_PARTICIPANTS = 20;

let ensured = null;
function ensurePaymentRequests() {
  ensured ||= pool.query(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL,
      requester_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      description TEXT,
      due_date DATE,
      request_type TEXT NOT NULL DEFAULT 'one_time',
      recurring_frequency TEXT,
      recurring_end_date DATE,
      split_group_id UUID,
      split_label TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decline_note TEXT,
      transaction_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    )
  `).then(() => pool.query(
    "CREATE INDEX IF NOT EXISTS payment_requests_payer_idx ON payment_requests (payer_user_id, status, created_at DESC)"
  )).catch((error) => { ensured = null; throw error; });
  return ensured;
}

function money(value) {
  return `R${Number(value || 0).toFixed(2)}`;
}

function requestReference() {
  return `REQ-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function cleanAmount(value) {
  const amount = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError(400, "Amount must be greater than zero.");
  if (amount > MAX_REQUEST_AMOUNT) throw new AppError(400, "Amount is above the request limit.");
  return amount;
}

function cleanDate(value, label) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new AppError(400, `${label} is not a valid date.`);
  return date.toISOString().slice(0, 10);
}

// node-postgres hands a DATE column back as a JS Date at local midnight, so
// naive String() gives "Thu Aug 20 ..." and a naive toISOString() can land a
// day early in a positive-offset timezone. Shift by the offset first.
function isoDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

// The requester RECEIVES the money, and receiving is open unless TitoPay
// has blocked the account. Same rule as the transfer rails, checked here so
// a request that could never be paid is refused when it is made.
async function assertRequesterCanReceive(userId, amount = 0) {
  void amount;
  const { rows } = await pool.query(
    "SELECT id, account_type, status, fica_status, username, full_name, email, phone FROM users WHERE id = $1",
    [userId]
  );
  const requester = rows[0];
  if (!requester) throw new AppError(404, "Account not found.");
  const { BLOCKED_ACCOUNT_STATUSES } = require("../lib/chat-policy");
  if (BLOCKED_ACCOUNT_STATUSES.has(String(requester.status || "").toLowerCase())) {
    throw new AppError(403, "Your account cannot receive money at the moment. Contact TitoPay support.");
  }
  // The tier-based receive limit, so a request that could never be paid is
  // refused now with the upgrade path named.
  await require("./compliance-service").assertCanReceiveAmount(userId, amount, { selfView: true });
  return requester;
}

async function resolvePayer(actor, identifier) {
  const status = await verifyRecipient({ userType: "customer", userId: actor.userId }, { recipient: identifier });
  if (!status.registered || !status.recipient?.userId) {
    throw new AppError(404, `${identifier} is not a registered TitoPay user, so a request cannot reach them yet. They can join at titopay.co.za first.`);
  }
  if (status.recipient.userId === actor.userId) {
    throw new AppError(400, "You cannot send a payment request to yourself.");
  }
  return status.recipient;
}

function displayName(user) {
  return user.full_name || user.fullName || (user.username ? `@${user.username}` : "A TitoPay user");
}

async function notifyPayerOfRequest({ requester, payer, request }) {
  const requesterName = displayName(requester);
  const forLine = request.description ? ` for ${request.description}` : "";
  const dueLine = request.due_date ? ` It is due by ${request.due_date}.` : "";
  await createNotification({
    user: { id: payer.userId || payer.id, user_type: "customer" },
    channel: "in_app", notificationType: "payment_request", provider: "in_app",
    title: `${requesterName} requests ${money(request.amount)}`,
    body: `${requesterName} asked you for ${money(request.amount)}${forLine}.${dueLine} Open Request funds in the app to pay or decline. Nothing leaves your wallet unless you choose to pay.`,
    metadata: { requestId: request.id, reference: request.reference, clientNotificationId: `payment-request-${request.id}` }
  }).catch(() => {});
  if (payer.email) {
    try {
      const emailCentre = require("./email-centre-service");
      const esc = emailCentre.escapeHtml;
      await emailCentre.queueRawEmail({
        recipient: payer.email,
        subject: `${requesterName} requests ${money(request.amount)} on TitoPay`,
        textBody: [
          `Hi ${payer.fullName || payer.full_name || "there"},`,
          "",
          `${requesterName} has asked you for ${money(request.amount)}${forLine} on TitoPay.${dueLine}`,
          "",
          "To answer it:",
          "1. Open the TitoPay app ({{appUrl}}) and sign in.",
          "2. Open Send & pay and choose Request funds.",
          "3. The request is under Requests waiting for you. Choose Pay or Decline.",
          "",
          "Nothing has been taken from your wallet. Money only moves if you choose to pay, and you will see the exact amount before you confirm.",
          "",
          "If you were not expecting this, decline it in the app or simply ignore this email.",
          "",
          "TitoPay"
        ].join("\n"),
        htmlBody: [
          `<p>Hi ${esc(payer.fullName || payer.full_name || "there")},</p>`,
          `<p><strong>${esc(requesterName)}</strong> has asked you for <strong>${esc(money(request.amount))}</strong>${esc(forLine)} on TitoPay.${esc(dueLine)}</p>`,
          "<p><strong>To answer it:</strong></p>",
          "<ol>",
          '<li>Open the <a href="{{appUrl}}">TitoPay app</a> and sign in.</li>',
          "<li>Open <strong>Send &amp; pay</strong> and choose <strong>Request funds</strong>.</li>",
          "<li>The request is under <strong>Requests waiting for you</strong>. Choose <strong>Pay</strong> or <strong>Decline</strong>.</li>",
          "</ol>",
          "<p>Nothing has been taken from your wallet. Money only moves if you choose to pay, and you will see the exact amount before you confirm.</p>",
          "<p>If you were not expecting this, decline it in the app or simply ignore this email.</p>",
          "<p>TitoPay</p>"
        ].join("\n"),
        userId: payer.userId || payer.id,
        idempotencyKey: `payment-request-${request.id}`,
        metadata: { requestId: request.id }
      });
    } catch (error) {
      console.error("[payment-request] request email failed", { requestId: request.id, message: error.message });
    }
  }
}

async function notifyRequesterOfOutcome({ request, payerName, outcome, note }) {
  const titles = {
    paid: `${payerName} paid your request of ${money(request.amount)}`,
    declined: `${payerName} declined your request of ${money(request.amount)}`
  };
  const bodies = {
    paid: `Your request ${request.reference}${request.description ? ` for ${request.description}` : ""} has been paid. The money is in your wallet now.`,
    declined: `Your request ${request.reference}${request.description ? ` for ${request.description}` : ""} was declined${note ? `: "${note}"` : "."} No money moved.`
  };
  await createNotification({
    user: { id: request.requester_user_id, user_type: "customer" },
    channel: "in_app", notificationType: "payment_request_update", provider: "in_app",
    title: titles[outcome], body: bodies[outcome],
    metadata: { requestId: request.id, reference: request.reference, outcome, clientNotificationId: `payment-request-${outcome}-${request.id}` }
  }).catch(() => {});
  try {
    const { rows } = await pool.query("SELECT email, full_name FROM users WHERE id = $1", [request.requester_user_id]);
    const requester = rows[0];
    if (requester?.email) {
      const emailCentre = require("./email-centre-service");
      await emailCentre.queueRawEmail({
        recipient: requester.email,
        subject: `TitoPay: ${titles[outcome]}`,
        textBody: `Hi ${requester.full_name || "there"},\n\n${bodies[outcome]}\n\nTitoPay`,
        htmlBody: `<p>Hi ${emailCentre.escapeHtml(requester.full_name || "there")},</p><p>${emailCentre.escapeHtml(bodies[outcome])}</p><p>TitoPay</p>`,
        userId: request.requester_user_id,
        idempotencyKey: `payment-request-${outcome}-${request.id}`,
        metadata: { requestId: request.id, outcome }
      });
    }
  } catch (error) {
    console.error("[payment-request] outcome email failed", { requestId: request.id, message: error.message });
  }
}

function requestRow(row) {
  return {
    id: row.id,
    reference: row.reference,
    amount: Number(row.amount),
    description: row.description || "",
    dueDate: isoDay(row.due_date),
    requestType: row.request_type,
    recurringFrequency: row.recurring_frequency,
    status: row.status === "paying" ? "pending" : row.status,
    splitLabel: row.split_label || null,
    declineNote: row.decline_note || null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    requester: { userId: row.requester_user_id, name: row.requester_name, username: row.requester_username },
    payer: { userId: row.payer_user_id, name: row.payer_name, username: row.payer_username }
  };
}

async function insertRequest(fields) {
  const id = uuidv4();
  const reference = requestReference();
  await pool.query(
    `INSERT INTO payment_requests
      (id, reference, requester_user_id, payer_user_id, amount, description, due_date,
       request_type, recurring_frequency, recurring_end_date, split_group_id, split_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, reference, fields.requesterUserId, fields.payerUserId, fields.amount, fields.description,
      fields.dueDate, fields.requestType, fields.recurringFrequency, fields.recurringEndDate,
      fields.splitGroupId || null, fields.splitLabel || null]
  );
  return { id, reference, amount: fields.amount, description: fields.description, due_date: fields.dueDate };
}

async function createRequest(actor, payload = {}) {
  await ensurePaymentRequests();
  const amount = cleanAmount(payload.amount);
  const requester = await assertRequesterCanReceive(actor.userId, amount);
  const description = String(payload.description || "").trim().slice(0, 240);
  const dueDate = cleanDate(payload.dueDate, "Due date");
  const recurring = /recur/i.test(String(payload.requestType || ""));
  const frequency = recurring ? String(payload.recurringFrequency || "").trim().toLowerCase() : null;
  if (recurring && !RECURRING_FREQUENCIES[frequency]) {
    throw new AppError(400, "A recurring request needs a frequency: weekly, monthly or quarterly.");
  }
  const recurringEndDate = recurring ? cleanDate(payload.recurringEndDate, "Recurring end date") : null;
  const payer = await resolvePayer(actor, String(payload.recipient || "").trim());

  const request = await insertRequest({
    requesterUserId: actor.userId,
    payerUserId: payer.userId,
    amount, description, dueDate,
    requestType: recurring ? "recurring" : "one_time",
    recurringFrequency: frequency,
    recurringEndDate
  });
  await notifyPayerOfRequest({ requester, payer, request });
  return {
    requestId: request.id,
    reference: request.reference,
    amount,
    payer: { name: displayName(payer), username: payer.username || null },
    status: "pending"
  };
}

async function createSplit(actor, payload = {}) {
  await ensurePaymentRequests();
  const label = String(payload.reference || payload.label || "").trim().slice(0, 120);
  if (!label) throw new AppError(400, "Say what the bill is for. Every participant sees it.");
  const total = cleanAmount(payload.amount || payload.total);
  const requester = await assertRequesterCanReceive(actor.userId, total);
  const rawParticipants = Array.isArray(payload.participants) ? payload.participants : [];
  if (!rawParticipants.length) throw new AppError(400, "Add at least one participant.");
  if (rawParticipants.length > MAX_SPLIT_PARTICIPANTS) {
    throw new AppError(400, `A split can have at most ${MAX_SPLIT_PARTICIPANTS} participants.`);
  }

  const resolved = [];
  const seen = new Set();
  let sum = 0;
  for (const entry of rawParticipants) {
    const identifier = String(entry.identifier || entry.recipient || "").trim();
    if (!identifier) throw new AppError(400, "Every participant needs a username, cellphone number or email.");
    const share = cleanAmount(entry.amount);
    const payer = await resolvePayer(actor, identifier);
    if (seen.has(payer.userId)) throw new AppError(400, `${identifier} is in the split twice.`);
    seen.add(payer.userId);
    sum = Math.round((sum + share) * 100) / 100;
    resolved.push({ payer, share });
  }
  if (sum > total + 0.01) {
    throw new AppError(400, `The shares add up to ${money(sum)}, which is more than the ${money(total)} bill.`);
  }

  const splitGroupId = uuidv4();
  const requests = [];
  for (const { payer, share } of resolved) {
    const request = await insertRequest({
      requesterUserId: actor.userId,
      payerUserId: payer.userId,
      amount: share,
      description: label,
      dueDate: cleanDate(payload.dueDate, "Due date"),
      requestType: "one_time",
      recurringFrequency: null,
      recurringEndDate: null,
      splitGroupId,
      splitLabel: label
    });
    await notifyPayerOfRequest({ requester, payer, request });
    requests.push({ requestId: request.id, reference: request.reference, amount: share, payer: { name: displayName(payer), username: payer.username || null } });
  }
  return { splitGroupId, label, total, requests };
}

async function listRequests(actor) {
  await ensurePaymentRequests();
  const { rows } = await pool.query(
    `SELECT pr.*,
            ru.full_name AS requester_name, ru.username AS requester_username,
            pu.full_name AS payer_name, pu.username AS payer_username
     FROM payment_requests pr
     JOIN users ru ON ru.id = pr.requester_user_id
     JOIN users pu ON pu.id = pr.payer_user_id
     WHERE pr.requester_user_id = $1 OR pr.payer_user_id = $1
     ORDER BY (pr.status IN ('pending','paying')) DESC, pr.created_at DESC
     LIMIT 100`,
    [actor.userId]
  );
  const incoming = [];
  const outgoing = [];
  for (const row of rows) {
    const shaped = requestRow(row);
    if (row.payer_user_id === actor.userId) incoming.push(shaped);
    if (row.requester_user_id === actor.userId) outgoing.push(shaped);
  }
  return { incoming, outgoing };
}

async function loadRequest(id) {
  const { rows } = await pool.query(
    `SELECT pr.*, ru.username AS requester_username, ru.email AS requester_email,
            ru.phone AS requester_phone, ru.full_name AS requester_name,
            pu.full_name AS payer_name, pu.username AS payer_username
     FROM payment_requests pr
     JOIN users ru ON ru.id = pr.requester_user_id
     JOIN users pu ON pu.id = pr.payer_user_id
     WHERE pr.id = $1`,
    [id]
  );
  if (!rows[0]) throw new AppError(404, "Payment request not found.");
  return rows[0];
}

// Spawn the next occurrence of a recurring request after this one is paid.
// Decline and cancel do NOT spawn: an unwanted series must be stoppable by
// answering one request.
async function spawnNextOccurrence(request) {
  if (request.request_type !== "recurring" || !RECURRING_FREQUENCIES[request.recurring_frequency]) return null;
  const { rows } = await pool.query(
    `SELECT TO_CHAR((COALESCE($1::DATE, NOW()::DATE) + $2::INTERVAL)::DATE, 'YYYY-MM-DD') AS next_due`,
    [isoDay(request.due_date), RECURRING_FREQUENCIES[request.recurring_frequency]]
  );
  const nextDue = rows[0].next_due;
  if (request.recurring_end_date && nextDue > isoDay(request.recurring_end_date)) return null;
  const next = await insertRequest({
    requesterUserId: request.requester_user_id,
    payerUserId: request.payer_user_id,
    amount: Number(request.amount),
    description: request.description,
    dueDate: nextDue,
    requestType: "recurring",
    recurringFrequency: request.recurring_frequency,
    recurringEndDate: isoDay(request.recurring_end_date)
  });
  const requester = {
    full_name: request.requester_name, username: request.requester_username
  };
  const { rows: payerRows } = await pool.query("SELECT id, full_name, email, username FROM users WHERE id = $1", [request.payer_user_id]);
  if (payerRows[0]) {
    await notifyPayerOfRequest({ requester, payer: { ...payerRows[0], userId: payerRows[0].id }, request: next });
  }
  return next;
}

async function payRequest(actor, requestId, options = {}) {
  await ensurePaymentRequests();
  // Atomic claim: whichever device wins moves the row to 'paying'; a row
  // already 'paying' may be re-entered because the transfer idempotency key
  // below makes the money movement single-shot either way.
  const { rows: claimed } = await pool.query(
    `UPDATE payment_requests SET status = 'paying'
     WHERE id = $1 AND payer_user_id = $2 AND status IN ('pending', 'paying')
     RETURNING id`,
    [requestId, actor.userId]
  );
  if (!claimed[0]) {
    const request = await loadRequest(requestId);
    if (request.payer_user_id !== actor.userId) throw new AppError(403, "Only the person the request was sent to can pay it.");
    throw new AppError(409, `This request is already ${request.status}. No further payment is needed.`);
  }
  const request = await loadRequest(requestId);
  try {
    const { createTransaction } = require("./transaction-service");
    const transfer = await createTransaction(actor, {
      serviceCode: "wallet_transfer",
      amount: Number(request.amount),
      recipient: request.requester_username || request.requester_email || request.requester_phone,
      idempotencyKey: `payment-request:${request.id}`,
      metadata: {
        paymentRequestId: request.id,
        paymentRequestReference: request.reference,
        description: request.description || null
      }
    });
    await pool.query(
      `UPDATE payment_requests
       SET status = 'paid', transaction_id = $2, resolved_at = NOW()
       WHERE id = $1`,
      [request.id, transfer.transactionId]
    );
    await notifyRequesterOfOutcome({ request, payerName: displayName({ full_name: request.payer_name, username: request.payer_username }), outcome: "paid" });
    const next = await spawnNextOccurrence(request);
    return {
      requestId: request.id,
      reference: request.reference,
      status: "paid",
      transaction: transfer,
      nextRequest: next ? { requestId: next.id, dueDate: next.due_date } : null
    };
  } catch (error) {
    // The claim is released so the payer can try again once the cause (for
    // example an insufficient balance) is fixed. The idempotency key above
    // guarantees a retry can never pay twice.
    await pool.query(
      "UPDATE payment_requests SET status = 'pending' WHERE id = $1 AND status = 'paying'",
      [request.id]
    ).catch(() => {});
    throw error;
  }
}

async function declineRequest(actor, requestId, payload = {}) {
  await ensurePaymentRequests();
  const note = String(payload.note || "").trim().slice(0, 240) || null;
  const { rows } = await pool.query(
    `UPDATE payment_requests
     SET status = 'declined', decline_note = $3, resolved_at = NOW()
     WHERE id = $1 AND payer_user_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, actor.userId, note]
  );
  if (!rows[0]) {
    const request = await loadRequest(requestId);
    if (request.payer_user_id !== actor.userId) throw new AppError(403, "Only the person the request was sent to can decline it.");
    throw new AppError(409, `This request is already ${request.status}.`);
  }
  const request = await loadRequest(requestId);
  await notifyRequesterOfOutcome({
    request,
    payerName: displayName({ full_name: request.payer_name, username: request.payer_username }),
    outcome: "declined",
    note
  });
  return { requestId, status: "declined" };
}

async function cancelRequest(actor, requestId) {
  await ensurePaymentRequests();
  const { rows } = await pool.query(
    `UPDATE payment_requests
     SET status = 'cancelled', resolved_at = NOW()
     WHERE id = $1 AND requester_user_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, actor.userId]
  );
  if (!rows[0]) {
    const request = await loadRequest(requestId);
    if (request.requester_user_id !== actor.userId) throw new AppError(403, "Only the person who made the request can cancel it.");
    throw new AppError(409, `This request is already ${request.status}.`);
  }
  const request = await loadRequest(requestId);
  await createNotification({
    user: { id: request.payer_user_id, user_type: "customer" },
    channel: "in_app", notificationType: "payment_request_update", provider: "in_app",
    title: `Request for ${money(request.amount)} was cancelled`,
    body: `${displayName({ full_name: request.requester_name, username: request.requester_username })} cancelled the request${request.description ? ` for ${request.description}` : ""}. Nothing is owed and no money moved.`,
    metadata: { requestId: request.id, reference: request.reference, outcome: "cancelled", clientNotificationId: `payment-request-cancelled-${request.id}` }
  }).catch(() => {});
  return { requestId, status: "cancelled" };
}

module.exports = {
  ensurePaymentRequests,
  createRequest,
  createSplit,
  listRequests,
  payRequest,
  declineRequest,
  cancelRequest,
  REQUEST_STATUSES
};
