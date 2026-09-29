"use strict";

// BUSINESS SALES SUITE — REAL DATABASE.
//
// Proves the new Sales screens against seeded ledger truth: the ledger view
// returns every credit classified by channel; the report totals only real
// sales (top-ups are listed separately, never counted as trading income);
// per-day and per-channel aggregates are cent-exact; the growth line compares
// the previous window; staff performance credits door scans to the right
// person; and a personal account is refused the endpoints entirely.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/business-sales-live.js

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const sales = require("../api/src/services/business-sales-service");
const { ensureTicketingSchema } = require("../api/src/services/ticketing-service");

const TAG = "saleslive";
const ids = {
  biz: randomUUID(), bizWallet: randomUUID(),
  payer: randomUUID(), payerWallet: randomUUID(),
  scanner: randomUUID(),
  event: randomUUID(), ticketType: randomUUID(), order: randomUUID(), ticket: randomUUID(), ticket2: randomUUID()
};
const money = (v) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

// Seeded on two fixed days so the window arithmetic is deterministic.
const DAY1 = "2026-08-03";
const DAY2 = "2026-08-05";
const PREV_DAY = "2026-07-29";

async function ledgerCredit({ amount, serviceCode, reference, createdAt }) {
  const txId = randomUUID();
  if (serviceCode) {
    await pool.query(
      `INSERT INTO transactions (id, user_id, wallet_id, service_code, amount, fee, total, status, direction, reference, created_at)
       VALUES ($1,$2,$3,$4,$5,0,$5,'completed','debit',$6,$7::timestamptz)`,
      [txId, ids.payer, ids.payerWallet, serviceCode, amount, reference, `${createdAt}T10:00:00Z`]
    );
  }
  await pool.query(
    `INSERT INTO wallet_ledger (id, wallet_id, transaction_id, entry_type, amount, balance_after, reference, metadata, created_at)
     VALUES ($1,$2,$3,'credit',$4,0,$5,'{}'::jsonb,$6::timestamptz)`,
    [randomUUID(), ids.bizWallet, serviceCode ? txId : null, amount, reference, `${createdAt}T10:00:00Z`]
  );
}

async function seed() {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business','${TAG} Traders','${TAG}_biz','${TAG}_biz@example.invalid','27110000601','x','active',FALSE,'approved'),
            ($2,'personal','${TAG} Payer','${TAG}_payer','${TAG}_payer@example.invalid','27110000602','x','active',FALSE,'pending'),
            ($3,'personal','${TAG} Scanner','${TAG}_scan','${TAG}_scan@example.invalid','27110000603','x','active',FALSE,'pending')`,
    [ids.biz, ids.payer, ids.scanner]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'business','ZAR',0,0,'active'), ($4,$5,$6,'personal','ZAR',0,0,'active')`,
    [ids.bizWallet, String(Date.now()).slice(-9), ids.biz, ids.payerWallet, String(Date.now() + 7).slice(-9), ids.payer]
  );

  // The sales mix: QR R100 + QR R50 (day 1), ticket revenue R200 (day 2),
  // transfer R25 (day 2), a R500 top-up (day 2, NOT a sale), and R80 of QR
  // sales in the PREVIOUS window for the growth line.
  await ledgerCredit({ amount: 100, serviceCode: "qr_payment", reference: `${TAG}-qr-1`, createdAt: DAY1 });
  await ledgerCredit({ amount: 50, serviceCode: "qr_payment", reference: `${TAG}-qr-2`, createdAt: DAY1 });
  await ledgerCredit({ amount: 200, serviceCode: "ticket_purchase", reference: `${TAG}-tickets`, createdAt: DAY2 });
  await ledgerCredit({ amount: 25, serviceCode: "wallet_transfer", reference: `${TAG}-transfer`, createdAt: DAY2 });
  await ledgerCredit({ amount: 500, serviceCode: "wallet_top_up", reference: `${TAG}-topup`, createdAt: DAY2 });
  await ledgerCredit({ amount: 80, serviceCode: "qr_payment", reference: `${TAG}-prev`, createdAt: PREV_DAY });

  // Door: an event with two tickets, one scanned by the staff member and one
  // by the owner, so attribution and share both have something to prove.
  await ensureTicketingSchema();
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, event_date)
     VALUES ($1,$2,'${TAG} Festival','${TAG}-festival','approved','2026-08-05')`,
    [ids.event, ids.biz]
  );
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available)
     VALUES ($1,$2,'General',100,100)`,
    [ids.ticketType, ids.event]
  );
  await pool.query(
    `INSERT INTO event_staff (event_id, user_id, role, permissions, status)
     VALUES ($1,$2,'scanner','["scan"]'::jsonb,'active')`,
    [ids.event, ids.scanner]
  );
  await pool.query(
    `INSERT INTO ticket_orders (id, event_id, ticket_type_id, buyer_user_id, order_reference, quantity, subtotal, total, status)
     VALUES ($1,$2,$3,$4,'ORD-${TAG}',2,200,200,'paid')`,
    [ids.order, ids.event, ids.ticketType, ids.payer]
  );
  await pool.query(
    `INSERT INTO tickets (id, order_id, event_id, ticket_type_id, owner_user_id, ticket_code, status, scanned_at, scanned_by)
     VALUES ($1,$2,$3,$4,$5,'TKT-${TAG}-1','scanned','2026-08-05T18:00:00Z',$6),
            ($7,$2,$3,$4,$5,'TKT-${TAG}-2','scanned','2026-08-05T18:05:00Z',$8)`,
    [ids.ticket, ids.order, ids.event, ids.ticketType, ids.payer, ids.scanner, ids.ticket2, ids.biz]
  );
}

async function cleanup() {
  await pool.query("DELETE FROM tickets WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM ticket_orders WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM event_staff WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM events WHERE id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [[ids.bizWallet, ids.payerWallet]]).catch(() => {});
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [[ids.biz, ids.payer]]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE id = ANY($1)", [[ids.bizWallet, ids.payerWallet]]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [[ids.biz, ids.payer, ids.scanner]]);
}

(async () => {
  let passed = 0;
  const ok = (label) => { console.log(`  ✓ ${label}`); passed += 1; };
  try {
    console.log("\n" + "=".repeat(80));
    console.log("  BUSINESS SALES SUITE — LEDGER, REPORT AND STAFF, REAL DATABASE");
    console.log("=".repeat(80));

    await seed();
    const WINDOW = { from: "2026-08-01", to: "2026-08-07" };

    // 1. Ledger: every credit in the window, correctly classified.
    const ledger = await sales.salesLedger(ids.biz, WINDOW);
    assert.equal(ledger.items.length, 5, "five credits in the window");
    const byRef = Object.fromEntries(ledger.items.map((item) => [item.reference, item]));
    assert.equal(byRef[`${TAG}-qr-1`].channel, "qr");
    assert.equal(byRef[`${TAG}-tickets`].channel, "tickets");
    assert.equal(byRef[`${TAG}-transfer`].channel, "transfer");
    assert.equal(byRef[`${TAG}-topup`].channel, "topup");
    assert.equal(byRef[`${TAG}-topup`].isSale, false, "a top-up is never a sale");
    assert.equal(byRef[`${TAG}-qr-1`].payerUsername, `${TAG}_payer`, "the payer is named on the row");
    ok("ledger returns every credit, each classified by its real cause");

    // 2. Totals: sales R375 (100+50+200+25); top-up listed apart as R500.
    assert.equal(money(ledger.totals.sales), 375, "sales total counts only trading income");
    assert.equal(ledger.totals.salesCount, 4);
    assert.equal(money(ledger.totals.otherIn), 500, "the top-up is reported separately");
    ok("totals: R375 of sales; the R500 top-up shown apart, never inflating sales");

    // 3. Report aggregates: per-day, per-channel, average — cent-exact.
    const summary = await sales.salesSummary(ids.biz, WINDOW);
    assert.equal(money(summary.total), 375);
    assert.equal(summary.count, 4);
    assert.equal(money(summary.average), money(375 / 4));
    assert.equal(money(summary.perDay[DAY1].total), 150, "day 1 holds the two QR sales");
    assert.equal(money(summary.perDay[DAY2].total), 225, "day 2 holds tickets + transfer");
    assert.equal(money(summary.perChannel.qr.total), 150);
    assert.equal(money(summary.perChannel.tickets.total), 200);
    assert.equal(money(summary.otherIn), 500);
    ok("report aggregates are cent-exact per day and per channel");

    // 4. Growth: previous window of the same length holds R80 → +368.75%.
    assert.equal(money(summary.previousTotal), 80, "previous window total found");
    assert.equal(money(summary.changePercent), money(((375 - 80) / 80) * 100), "growth percentage is computed from it");
    ok("growth line compares the equivalent previous window");

    // 5. Staff performance: the scan is credited to the right person.
    const staff = await sales.staffPerformance(ids.biz, WINDOW);
    assert.equal(staff.totalScans, 2, "both door scans counted");
    const scanner = staff.members.find((member) => member.userId === ids.scanner);
    const owner = staff.members.find((member) => member.userId === ids.biz);
    assert.ok(scanner, "the staff member appears on the report");
    assert.equal(scanner.scans, 1);
    assert.equal(scanner.eventsAssigned, 1);
    assert.ok(owner && owner.scans === 1 && /you/i.test(owner.fullName), "the owner's own scan is reported as theirs");
    const coverage = staff.events.find((row) => row.id === ids.event);
    assert.ok(coverage && coverage.scanned === 2 && coverage.issued === 2, "door coverage per event adds up");
    ok("staff performance credits each scan to the person who scanned");

    // 6. A personal account is refused the whole suite.
    let refused = false;
    try { await sales.salesSummary(ids.payer, WINDOW); }
    catch (error) { refused = error.statusCode === 403; }
    assert.ok(refused, "personal accounts get a 403");
    ok("personal accounts are refused sales reporting");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — the Sales suite reports the ledger truth.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup().catch((error) => console.error("  cleanup:", error.message));
    await pool.end();
  }
})();
