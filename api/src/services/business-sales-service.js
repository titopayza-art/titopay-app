"use strict";

// Business Sales — the money-in story for a business account, told from the
// wallet ledger itself. Every credit that lands in the business wallet is a
// row here, classified by the transaction that caused it, so the Sales screen
// in the app reconciles to the cent with the wallet.
//
// Three views feed off this service:
//   ledger   — the raw day-by-day list of money in (searchable, filterable)
//   summary  — the report: totals, per-day, per-channel, per-hour, growth
//   staff    — door-staff performance across the business's events

const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");

const money = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

// service_code → sales channel. isSale=false rows are money in that is not
// trading income (top-ups, bulk distribution receipts); the report lists them
// separately so the sales total means what a trader thinks it means.
const CHANNELS = {
  qr: { label: "QR payments", isSale: true },
  tickets: { label: "Ticket sales", isSale: true },
  tag: { label: "Event Tag", isSale: true },
  transfer: { label: "Direct payments", isSale: true },
  refund: { label: "Refunds received", isSale: false },
  topup: { label: "Top-ups", isSale: false },
  distribution: { label: "Bulk distribution", isSale: false },
  other: { label: "Other money in", isSale: false }
};

function classifyCredit(serviceCode, reference) {
  const code = String(serviceCode || "").toLowerCase();
  if (code === "qr_payment" || code === "customer_qr_payment" || code === "scan_to_pay") return "qr";
  if (code === "ticket_purchase" || code === "ticket_sales") return "tickets";
  if (code === "event_tag") return "tag";
  if (code === "wallet_transfer" || code === "bill_split" || code === "tip") return "transfer";
  if (code === "ticket_refund") return "refund";
  if (code === "wallet_top_up" || code === "top_up" || code === "card_topups") return "topup";
  if (code.startsWith("bulk_distribution")) return "distribution";
  if (!code && /^EBD/i.test(String(reference || ""))) return "distribution";
  return "other";
}

async function requireBusiness(userId) {
  const { rows } = await pool.query(
    "SELECT id, account_type, full_name FROM users WHERE id = $1 LIMIT 1",
    [userId]
  );
  if (!rows[0]) throw new AppError(404, "Account not found");
  if (rows[0].account_type !== "business") throw new AppError(403, "Sales reporting is available on business accounts");
  return rows[0];
}

function windowClause(from, to, column, values) {
  let clause = "";
  if (from) {
    values.push(from);
    clause += ` AND ${column} >= $${values.length}::DATE`;
  }
  if (to) {
    values.push(to);
    clause += ` AND ${column} < ($${values.length}::DATE + INTERVAL '1 day')`;
  }
  return clause;
}

async function creditRows(userId, { from, to, limit = 1000 } = {}) {
  const values = [userId];
  const clause = windowClause(from, to, "wl.created_at", values);
  values.push(Math.min(Math.max(Number(limit) || 1000, 1), 2000));
  const { rows } = await pool.query(
    `SELECT wl.id, wl.amount, wl.reference, wl.created_at, wl.metadata,
            t.service_code, t.reference AS transaction_reference, t.metadata AS transaction_metadata,
            payer.full_name AS payer_name, payer.username AS payer_username
     FROM wallet_ledger wl
     JOIN wallets w ON w.id = wl.wallet_id AND w.user_id = $1
     LEFT JOIN transactions t ON t.id = wl.transaction_id
     LEFT JOIN users payer ON payer.id = t.user_id AND t.user_id <> $1
     WHERE wl.entry_type = 'credit'${clause}
     ORDER BY wl.created_at DESC
     LIMIT $${values.length}`,
    values
  );
  return rows.map((row) => {
    const channel = classifyCredit(row.service_code, row.reference);
    return {
      id: row.id,
      amount: money(row.amount),
      channel,
      channelLabel: CHANNELS[channel].label,
      isSale: CHANNELS[channel].isSale,
      reference: row.transaction_reference || row.reference || "",
      payerName: row.payer_name || "",
      payerUsername: row.payer_username || "",
      createdAt: row.created_at
    };
  });
}

async function salesLedger(userId, { from, to } = {}) {
  await requireBusiness(userId);
  const items = await creditRows(userId, { from, to, limit: 500 });
  const saleItems = items.filter((item) => item.isSale);
  return {
    items,
    totals: {
      sales: money(saleItems.reduce((sum, item) => sum + item.amount, 0)),
      salesCount: saleItems.length,
      otherIn: money(items.filter((item) => !item.isSale).reduce((sum, item) => sum + item.amount, 0))
    }
  };
}

function dayKey(value) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

async function salesSummary(userId, { from, to } = {}) {
  await requireBusiness(userId);
  const items = await creditRows(userId, { from, to, limit: 2000 });
  const sales = items.filter((item) => item.isSale);

  const perDay = {};
  const perChannel = {};
  const perHour = Array.from({ length: 24 }, () => 0);
  let biggest = null;
  for (const item of sales) {
    const day = dayKey(item.createdAt);
    perDay[day] = perDay[day] || { total: 0, count: 0 };
    perDay[day].total = money(perDay[day].total + item.amount);
    perDay[day].count += 1;
    perChannel[item.channel] = perChannel[item.channel] || { label: item.channelLabel, total: 0, count: 0 };
    perChannel[item.channel].total = money(perChannel[item.channel].total + item.amount);
    perChannel[item.channel].count += 1;
    // Hours reported in South African time (UTC+2, no daylight saving).
    const saHour = (new Date(item.createdAt).getUTCHours() + 2) % 24;
    perHour[saHour] = money(perHour[saHour] + item.amount);
    if (!biggest || item.amount > biggest.amount) biggest = item;
  }
  const total = money(sales.reduce((sum, item) => sum + item.amount, 0));

  // The previous window of the same length, for the growth line.
  let previousTotal = null;
  if (from && to) {
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    const days = Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1);
    const previousToDate = new Date(fromDate.getTime() - 86400000);
    const previousFromDate = new Date(previousToDate.getTime() - (days - 1) * 86400000);
    const previousItems = await creditRows(userId, {
      from: previousFromDate.toISOString().slice(0, 10),
      to: previousToDate.toISOString().slice(0, 10),
      limit: 2000
    });
    previousTotal = money(previousItems.filter((item) => item.isSale).reduce((sum, item) => sum + item.amount, 0));
  }

  return {
    total,
    count: sales.length,
    average: sales.length ? money(total / sales.length) : 0,
    biggest: biggest ? { amount: biggest.amount, channelLabel: biggest.channelLabel, createdAt: biggest.createdAt } : null,
    perDay,
    perChannel,
    perHour,
    otherIn: money(items.filter((item) => !item.isSale).reduce((sum, item) => sum + item.amount, 0)),
    previousTotal,
    changePercent: previousTotal === null || previousTotal === 0
      ? null
      : money(((total - previousTotal) / previousTotal) * 100)
  };
}

async function staffPerformance(userId, { from, to } = {}) {
  await requireBusiness(userId);
  const values = [userId];
  const clause = windowClause(from, to, "tk.scanned_at", values);
  // Every active staff member across the business's events, with the scans
  // they actually performed in the window. Owner scans are reported too so
  // the numbers add up to the door total.
  const { rows: staffRows } = await pool.query(
    `SELECT es.user_id, u.full_name, u.username,
            COUNT(DISTINCT es.event_id) AS events_assigned,
            MIN(es.created_at) AS first_assigned_at
     FROM event_staff es
     JOIN events e ON e.id = es.event_id AND e.business_user_id = $1
     JOIN users u ON u.id = es.user_id
     WHERE es.status = 'active'
     GROUP BY es.user_id, u.full_name, u.username`,
    [userId]
  );
  const { rows: scanRows } = await pool.query(
    `SELECT tk.scanned_by, COUNT(*) AS scans, MAX(tk.scanned_at) AS last_scan_at
     FROM tickets tk
     JOIN events e ON e.id = tk.event_id AND e.business_user_id = $1
     WHERE tk.scanned_by IS NOT NULL${clause}
     GROUP BY tk.scanned_by`,
    values
  );
  const scansByUser = Object.fromEntries(scanRows.map((row) => [row.scanned_by, row]));
  const totalScans = scanRows.reduce((sum, row) => sum + Number(row.scans), 0);

  const members = staffRows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    username: row.username,
    eventsAssigned: Number(row.events_assigned),
    scans: Number(scansByUser[row.user_id]?.scans || 0),
    lastScanAt: scansByUser[row.user_id]?.last_scan_at || null,
    sharePercent: totalScans ? money((Number(scansByUser[row.user_id]?.scans || 0) / totalScans) * 100) : 0
  }));
  // Scans by people who are not on the staff list any more (or the owner).
  const staffIds = new Set(staffRows.map((row) => row.user_id));
  for (const row of scanRows) {
    if (staffIds.has(row.scanned_by)) continue;
    const { rows: userRows } = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [row.scanned_by]);
    members.push({
      userId: row.scanned_by,
      fullName: row.scanned_by === userId ? `${userRows[0]?.full_name || "Owner"} (you)` : (userRows[0]?.full_name || "Former staff"),
      username: userRows[0]?.username || "",
      eventsAssigned: 0,
      scans: Number(row.scans),
      lastScanAt: row.last_scan_at,
      sharePercent: totalScans ? money((Number(row.scans) / totalScans) * 100) : 0
    });
  }
  members.sort((a, b) => b.scans - a.scans || a.fullName.localeCompare(b.fullName));

  // Per-event door coverage, so the report says which events were scanned in.
  const eventValues = [userId];
  const eventClause = windowClause(from, to, "tk.scanned_at", eventValues);
  const { rows: eventRows } = await pool.query(
    `SELECT e.id, e.event_name AS name, e.event_date,
            COUNT(tk.id) FILTER (WHERE tk.status IN ('valid','scanned')) AS issued,
            COUNT(tk.id) FILTER (WHERE tk.scanned_by IS NOT NULL${eventClause}) AS scanned
     FROM events e
     LEFT JOIN tickets tk ON tk.event_id = e.id
     WHERE e.business_user_id = $1
     GROUP BY e.id, e.event_name, e.event_date
     HAVING COUNT(tk.id) > 0
     ORDER BY e.event_date DESC NULLS LAST
     LIMIT 20`,
    eventValues
  );

  return {
    totalScans,
    members,
    events: eventRows.map((row) => ({
      id: row.id,
      name: row.name,
      eventDate: row.event_date,
      issued: Number(row.issued),
      scanned: Number(row.scanned)
    }))
  };
}

module.exports = { salesLedger, salesSummary, staffPerformance, classifyCredit, CHANNELS };
