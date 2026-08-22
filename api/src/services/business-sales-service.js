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

// classifyCredit()'s rules, mirrored in SQL so the report's channel split
// reconciles to the cent with the ledger list. The sale channels are exactly
// those classifyCredit marks isSale=true. Kept as ONE expression, reused by
// every aggregate below, so the JS and SQL classifications can never drift.
const CHANNEL_SQL = `
  CASE
    WHEN lower(t.service_code) IN ('qr_payment','customer_qr_payment','scan_to_pay') THEN 'qr'
    WHEN lower(t.service_code) IN ('ticket_purchase','ticket_sales') THEN 'tickets'
    WHEN lower(t.service_code) = 'event_tag' THEN 'tag'
    WHEN lower(t.service_code) IN ('wallet_transfer','bill_split','tip') THEN 'transfer'
    WHEN lower(t.service_code) = 'ticket_refund' THEN 'refund'
    WHEN lower(t.service_code) IN ('wallet_top_up','top_up','card_topups') THEN 'topup'
    WHEN lower(coalesce(t.service_code,'')) LIKE 'bulk_distribution%' THEN 'distribution'
    WHEN coalesce(t.service_code,'') = '' AND wl.reference ILIKE 'EBD%' THEN 'distribution'
    ELSE 'other'
  END`;
const SALE_CHANNELS = "('qr','tickets','tag','transfer')";

// Every credit that lands in the business wallet for the window, joined to the
// transaction that caused it. The single FROM/WHERE the aggregates share.
const CREDITS_FROM = `
  FROM wallet_ledger wl
  JOIN wallets w ON w.id = wl.wallet_id AND w.user_id = $1
  LEFT JOIN transactions t ON t.id = wl.transaction_id
  WHERE wl.entry_type = 'credit'`;

function scope(userId, from, to) {
  const values = [userId];
  const clause = windowClause(from, to, "wl.created_at", values);
  return { values, clause };
}

// Sales totals computed in SQL over the FULL window, never over a capped
// display page - a business past a few hundred credits was silently losing its
// oldest sales from every total. The items list stays capped for display; only
// the numbers changed source.
async function salesLedgerTotals(userId, { from, to } = {}) {
  const { values, clause } = scope(userId, from, to);
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(wl.amount) FILTER (WHERE ${CHANNEL_SQL} IN ${SALE_CHANNELS}), 0) AS sales,
       COUNT(*)                FILTER (WHERE ${CHANNEL_SQL} IN ${SALE_CHANNELS}) AS sales_count,
       COALESCE(SUM(wl.amount) FILTER (WHERE ${CHANNEL_SQL} NOT IN ${SALE_CHANNELS}), 0) AS other_in
     ${CREDITS_FROM}${clause}`,
    values
  );
  return {
    sales: money(rows[0].sales),
    salesCount: Number(rows[0].sales_count || 0),
    otherIn: money(rows[0].other_in)
  };
}

async function salesLedger(userId, { from, to } = {}) {
  await requireBusiness(userId);
  const items = await creditRows(userId, { from, to, limit: 500 });
  const totals = await salesLedgerTotals(userId, { from, to });
  return { items, totals };
}

// Just the sales total for a window (drives the growth line's previous period).
async function salesTotalOnly(userId, { from, to } = {}) {
  const { values, clause } = scope(userId, from, to);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(wl.amount) FILTER (WHERE ${CHANNEL_SQL} IN ${SALE_CHANNELS}), 0) AS total
     ${CREDITS_FROM}${clause}`,
    values
  );
  return money(rows[0].total);
}

async function salesSummary(userId, { from, to } = {}) {
  await requireBusiness(userId);

  // Per-channel totals over the full window (sales channels feed total/count/
  // average/perChannel; the rest feed otherIn).
  const chanScope = scope(userId, from, to);
  const { rows: channelRows } = await pool.query(
    `SELECT ${CHANNEL_SQL} AS channel, COALESCE(SUM(wl.amount), 0) AS total, COUNT(*) AS count
     ${CREDITS_FROM}${chanScope.clause}
     GROUP BY 1`,
    chanScope.values
  );

  const perChannel = {};
  let total = 0;
  let count = 0;
  let otherIn = 0;
  for (const row of channelRows) {
    const channel = row.channel;
    const channelTotal = money(row.total);
    const channelCount = Number(row.count || 0);
    if (CHANNELS[channel] && CHANNELS[channel].isSale) {
      total = money(total + channelTotal);
      count += channelCount;
      perChannel[channel] = { label: CHANNELS[channel].label, total: channelTotal, count: channelCount };
    } else {
      otherIn = money(otherIn + channelTotal);
    }
  }

  // Per-day and per-hour, both bucketed in SOUTH AFRICAN time so a sale at
  // 00:30 SAST counts under today, and the day chart agrees with the hour chart.
  const dayScope = scope(userId, from, to);
  const { rows: dayRows } = await pool.query(
    `SELECT to_char((wl.created_at AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(wl.amount), 0) AS total, COUNT(*) AS count
     ${CREDITS_FROM} AND ${CHANNEL_SQL} IN ${SALE_CHANNELS}${dayScope.clause}
     GROUP BY 1 ORDER BY 1`,
    dayScope.values
  );
  const perDay = {};
  for (const row of dayRows) perDay[row.day] = { total: money(row.total), count: Number(row.count || 0) };

  const hourScope = scope(userId, from, to);
  const { rows: hourRows } = await pool.query(
    `SELECT EXTRACT(HOUR FROM (wl.created_at AT TIME ZONE 'Africa/Johannesburg'))::int AS hr,
            COALESCE(SUM(wl.amount), 0) AS total
     ${CREDITS_FROM} AND ${CHANNEL_SQL} IN ${SALE_CHANNELS}${hourScope.clause}
     GROUP BY 1`,
    hourScope.values
  );
  const perHour = Array.from({ length: 24 }, () => 0);
  for (const row of hourRows) perHour[row.hr] = money(row.total);

  // The single biggest sale in the window.
  const bigScope = scope(userId, from, to);
  const { rows: biggestRows } = await pool.query(
    `SELECT wl.amount, ${CHANNEL_SQL} AS channel, wl.created_at
     ${CREDITS_FROM} AND ${CHANNEL_SQL} IN ${SALE_CHANNELS}${bigScope.clause}
     ORDER BY wl.amount DESC LIMIT 1`,
    bigScope.values
  );
  const biggest = biggestRows[0]
    ? {
        amount: money(biggestRows[0].amount),
        channelLabel: (CHANNELS[biggestRows[0].channel] || CHANNELS.other).label,
        createdAt: biggestRows[0].created_at
      }
    : null;

  // The previous window of the same length, for the growth line.
  let previousTotal = null;
  if (from && to) {
    const fromDate = new Date(`${from}T00:00:00Z`);
    const toDate = new Date(`${to}T00:00:00Z`);
    const days = Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1);
    const previousToDate = new Date(fromDate.getTime() - 86400000);
    const previousFromDate = new Date(previousToDate.getTime() - (days - 1) * 86400000);
    previousTotal = await salesTotalOnly(userId, {
      from: previousFromDate.toISOString().slice(0, 10),
      to: previousToDate.toISOString().slice(0, 10)
    });
  }

  return {
    total,
    count,
    average: count ? money(total / count) : 0,
    biggest,
    perDay,
    perChannel,
    perHour,
    otherIn,
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
  // Till sales taken by staff through My Workplaces, in the same window.
  const { staffSalesTotals } = require("./business-staff-service");
  const tillSales = await staffSalesTotals(userId, { from, to }).catch(() => []);
  const tillByUser = Object.fromEntries(tillSales.map((row) => [row.staffUserId, row]));

  const members = staffRows.map((row) => ({
    userId: row.user_id,
    fullName: row.full_name,
    username: row.username,
    eventsAssigned: Number(row.events_assigned),
    scans: Number(scansByUser[row.user_id]?.scans || 0),
    lastScanAt: scansByUser[row.user_id]?.last_scan_at || null,
    sharePercent: totalScans ? money((Number(scansByUser[row.user_id]?.scans || 0) / totalScans) * 100) : 0,
    salesCount: Number(tillByUser[row.user_id]?.salesCount || 0),
    salesTotal: money(tillByUser[row.user_id]?.salesTotal || 0)
  }));
  // Sellers who are not event scanners still belong on the report.
  const memberIds = new Set(members.map((member) => member.userId));
  for (const seller of tillSales) {
    if (memberIds.has(seller.staffUserId)) continue;
    memberIds.add(seller.staffUserId);
    members.push({
      userId: seller.staffUserId,
      fullName: seller.staffName,
      username: "",
      eventsAssigned: 0,
      scans: 0,
      lastScanAt: null,
      sharePercent: 0,
      salesCount: seller.salesCount,
      salesTotal: seller.salesTotal
    });
  }
  // Scans by people who are not on the staff list any more (or the owner).
  for (const row of scanRows) {
    if (memberIds.has(row.scanned_by)) continue;
    memberIds.add(row.scanned_by);
    const { rows: userRows } = await pool.query("SELECT full_name, username FROM users WHERE id = $1", [row.scanned_by]);
    members.push({
      userId: row.scanned_by,
      fullName: row.scanned_by === userId ? `${userRows[0]?.full_name || "Owner"} (you)` : (userRows[0]?.full_name || "Former staff"),
      username: userRows[0]?.username || "",
      eventsAssigned: 0,
      scans: Number(row.scans),
      lastScanAt: row.last_scan_at,
      sharePercent: totalScans ? money((Number(row.scans) / totalScans) * 100) : 0,
      salesCount: Number(tillByUser[row.scanned_by]?.salesCount || 0),
      salesTotal: money(tillByUser[row.scanned_by]?.salesTotal || 0)
    });
  }
  // A till-seller who also scanned may have entered via the till loop with
  // zero scans; give every member their scan numbers from the same source.
  for (const member of members) {
    if (!member.scans && scansByUser[member.userId]) {
      member.scans = Number(scansByUser[member.userId].scans);
      member.lastScanAt = scansByUser[member.userId].last_scan_at;
      member.sharePercent = totalScans ? money((member.scans / totalScans) * 100) : 0;
    }
  }
  members.sort((a, b) => (b.scans + b.salesCount) - (a.scans + a.salesCount) || b.salesTotal - a.salesTotal || a.fullName.localeCompare(b.fullName));

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
