"use strict";

// The settlement, reconciliation and payout engine, tested through the REAL
// POS engine: payments and refunds here move actual rands between actual
// wallets via pos.confirmPayment / pos.refundOrReverse, and the settlement
// batch must then agree with the ledger those calls wrote - or catch it when
// a test deliberately makes them disagree.

process.env.NODE_ENV = "test";
process.env.WEBHOOK_ALLOW_PRIVATE = "1";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "settlement-test-access-secret-32-bytes!";
process.env.JWT_REFRESH_SECRET ||= "settlement-test-refresh-secret-32-bytes";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { pool } = require("../src/db/pool");
const pos = require("../src/pos/service");
const settlements = require("../src/services/settlement-service");
const webhooks = require("../src/services/webhook-service");

const stamp = Date.now().toString(36);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function makeUser(tag, accountType = "personal") {
  const userId = crypto.randomUUID();
  const username = `set_${tag}_${stamp}_${crypto.randomBytes(2).toString("hex")}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, fica_status)
     VALUES ($1,$2,'Settlement Test',$3,$4,$5,'x','fully_verified')`,
    [userId, accountType, username, `${username}@t.local`, `+2774${Math.floor(1000000 + Math.random() * 8999999)}`]
  );
  return userId;
}

async function makeWallet(userId, kind, balance = 0) {
  const walletId = crypto.randomUUID();
  await pool.query(
    "INSERT INTO wallets (id, user_id, kind, currency, available_balance, status) VALUES ($1,$2,$3,'ZAR',$4,'active')",
    [walletId, userId, kind, balance]
  );
  return walletId;
}

// A full merchant: business owner + operating wallet + merchant + terminal,
// plus a funded customer to pay with.
async function makeMerchant(tag) {
  const ownerId = await makeUser(`${tag}o`, "business");
  const operatingWalletId = await makeWallet(ownerId, "merchant", 0);
  const merchantUuid = crypto.randomUUID();
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,'Settlement Cafe',$3,'active','verified')`,
    [merchantUuid, ownerId, `STM${stamp}${crypto.randomBytes(2).toString("hex")}`.toUpperCase().slice(0, 18)]
  );
  const terminalUuid = crypto.randomUUID();
  const terminalCode = `SET-TERM-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
  await pool.query(
    `INSERT INTO pos_terminals (id, terminal_id, merchant_id, provider, device_identifier, status, credential_encrypted, credential_fingerprint)
     VALUES ($1,$2,$3,'OTHER','test-device','active','enc:x:y:z',$4)`,
    [terminalUuid, terminalCode, merchantUuid, crypto.randomBytes(8).toString("hex")]
  );
  const customerId = await makeUser(`${tag}c`);
  await makeWallet(customerId, "personal", 100000);
  const { rows } = await pool.query("SELECT * FROM merchants WHERE id = $1", [merchantUuid]);
  return { ownerId, operatingWalletId, merchant: rows[0], merchantUuid, terminalUuid, terminalCode, customerId };
}

// The terminal context requireTerminalAuth attaches, built from the rows.
async function terminalContext(owner) {
  const { rows } = await pool.query(
    `SELECT t.*, t.merchant_id AS merchant_id_uuid,
            m.merchant_id AS merchant_code, m.business_name,
            m.status AS merchant_status, m.verification_status
       FROM pos_terminals t JOIN merchants m ON m.id = t.merchant_id
      WHERE t.id = $1 LIMIT 1`,
    [owner.terminalUuid]
  );
  return rows[0];
}

// Drive one real payment through the engine: intent -> scan -> confirm.
async function realPayment(owner, amount, reference = `TILL-${crypto.randomBytes(3).toString("hex")}`) {
  const terminal = await terminalContext(owner);
  const intent = await pos.createPaymentIntent(
    terminal,
    { merchantId: owner.merchant.merchant_id, terminalId: owner.terminalCode, amount, currency: "ZAR", merchantReference: reference },
    crypto.randomUUID(), `req-${crypto.randomUUID()}`
  );
  const token = String(intent.qrPayload).split("/").pop();
  const actor = { userType: "customer", userId: owner.customerId, profileLocked: false };
  await pos.resolvePaymentIntent(token, actor, `req-${crypto.randomUUID()}`);
  const confirmed = await pos.confirmPayment(intent.paymentId, actor, crypto.randomUUID(), `req-${crypto.randomUUID()}`);
  assert.equal(confirmed.status, "COMPLETED");
  return { paymentId: intent.paymentId, amount };
}

async function realRefund(owner, paymentId, amount) {
  const actor = { userType: "customer", userId: owner.ownerId };
  return pos.refundOrReverse("refund", paymentId, actor, { amount }, crypto.randomUUID(), `req-${crypto.randomUUID()}`);
}

async function walletBalance(walletId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId]);
  return Number(rows[0].available_balance);
}

function receiver() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      res.writeHead(200); res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ seen, server, url: `http://127.0.0.1:${server.address().port}/hook` }));
  });
}

test.before(async () => {
  await settlements.ensureSettlementSchema();
  await webhooks.ensureWebhookSchema();
});

test.after(async () => {
  await pool.end();
});

test("closeout derives the window from the ledger, reconciles, and the batch is the statement of record", async () => {
  const owner = await makeMerchant("close");
  await realPayment(owner, 149.5);
  const second = await realPayment(owner, 50);
  await realRefund(owner, second.paymentId, 20);

  const result = await settlements.closeSettlement(owner.merchantUuid, { actorType: "system" });
  assert.equal(result.settled, true);
  assert.equal(result.status, "paid");
  assert.equal(result.payoutMode, "realtime_wallet");

  const batch = await settlements.getSettlement(owner.merchant, result.batchId);
  assert.equal(batch.grossAmount, 199.5);
  assert.equal(batch.refundAmount, 20);
  assert.equal(batch.reversalAmount, 0);
  assert.equal(batch.feeAmount, 0);
  assert.equal(batch.netAmount, 179.5);
  assert.equal(batch.paymentCount, 2);
  assert.equal(batch.refundCount, 1);
  assert.equal(batch.items.length, 3);
  assert.ok(batch.items.every((item) => item.paymentId || item.type !== "payment"));

  // Real-time mode moved nothing: the operating wallet already holds the net.
  assert.equal(await walletBalance(owner.operatingWalletId), 179.5);

  // The event stream recorded every transition transactionally.
  const { rows: events } = await pool.query(
    "SELECT event_type FROM settlement_events WHERE batch_id = $1 ORDER BY created_at", [result.batchId]);
  assert.deepEqual(events.map((row) => row.event_type),
    ["batch_created", "reconciled", "payout_started", "paid"]);
});

test("windows tile: a second closeout settles only new activity and an empty window creates no batch", async () => {
  const owner = await makeMerchant("tile");
  await realPayment(owner, 30);
  const first = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(first.status, "paid");

  // Nothing new: no batch, honestly said.
  const empty = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(empty.settled, false);
  assert.match(empty.reason, /No POS activity|already settled/);

  await realPayment(owner, 45);
  const second = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(second.settled, true);
  const batch = await settlements.getSettlement(owner.merchant, second.batchId);
  assert.equal(batch.grossAmount, 45);

  // The two windows share a boundary and never overlap: every POS
  // transaction is claimed by exactly one batch (the global unique index).
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT total, COUNT(DISTINCT transaction_id)::INT distinct_total
       FROM settlement_batch_items i JOIN settlement_batches b ON b.id = i.batch_id
      WHERE b.merchant_id = $1`, [owner.merchantUuid]);
  assert.equal(rows[0].total, rows[0].distinct_total);
  assert.equal(rows[0].total, 2);
});

test("reconciliation catches a ledger tampered with after the fact", async () => {
  const owner = await makeMerchant("tamper");
  const payment = await realPayment(owner, 80);

  // Sabotage: shrink the merchant-side credit leg, as a bad migration or a
  // direct database edit would.
  const { rows: tx } = await pool.query(
    "SELECT transaction_id FROM pos_payment_intents WHERE payment_id = $1", [payment.paymentId]);
  await pool.query(
    `UPDATE wallet_ledger SET amount = amount - 10
      WHERE transaction_id = $1 AND entry_type = 'credit'`,
    [tx[0].transaction_id]
  );

  const result = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(result.settled, true);
  assert.equal(result.status, "discrepancy");
  const batch = await settlements.getSettlement(owner.merchant, result.batchId);
  assert.equal(batch.status, "discrepancy");
  assert.equal(batch.discrepancy.checks[0].check, "double_entry");

  // A discrepancy batch refuses payout outright.
  await assert.rejects(
    () => settlements.executePayout(result.batchId, { actorType: "admin" }),
    /discrepancy settlement cannot be paid/
  );

  // Repair the ledger, re-reconcile, and the same batch releases and pays.
  await pool.query(
    "UPDATE wallet_ledger SET amount = amount + 10 WHERE transaction_id = $1 AND entry_type = 'credit'",
    [tx[0].transaction_id]
  );
  const rerun = await settlements.rerunReconciliation(result.batchId, { actorType: "admin" });
  assert.equal(rerun.status, "reconciled");
  const paid = await settlements.executePayout(result.batchId, { actorType: "admin" });
  assert.equal(paid.status, "paid");
});

test("reconciliation catches a completed POS payment missing from the ledger-derived batch", async () => {
  const owner = await makeMerchant("stream");
  await realPayment(owner, 25);
  const hidden = await realPayment(owner, 60);

  // Sabotage the derivation source: flip the hidden payment's transaction
  // status so the batch cannot see it, while the intent stream still says
  // COMPLETED. Stream-vs-ledger must flag it.
  const { rows: tx } = await pool.query(
    "SELECT transaction_id FROM pos_payment_intents WHERE payment_id = $1", [hidden.paymentId]);
  await pool.query("UPDATE transactions SET status = 'failed' WHERE id = $1", [tx[0].transaction_id]);

  const result = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(result.status, "discrepancy");
  const batch = await settlements.getSettlement(owner.merchant, result.batchId);
  const checks = batch.discrepancy.checks.map((check) => check.check);
  assert.ok(checks.includes("stream_vs_ledger"), JSON.stringify(batch.discrepancy));

  await pool.query("UPDATE transactions SET status = 'completed' WHERE id = $1", [tx[0].transaction_id]);
});

test("payout sweeps the net into a configured settlement wallet and is idempotent", async () => {
  const owner = await makeMerchant("sweep");
  const settlementWalletId = await makeWallet(owner.ownerId, "business", 0);
  await settlements.updateSettlementConfig(owner.merchant, { settlementWalletId });

  await realPayment(owner, 200);
  const payment = await realPayment(owner, 100);
  await realRefund(owner, payment.paymentId, 40);

  const result = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(result.status, "paid");
  assert.equal(result.payoutMode, "settlement_wallet");

  // Net 260 moved out of the operating wallet into the settlement wallet.
  assert.equal(await walletBalance(owner.operatingWalletId), 0);
  assert.equal(await walletBalance(settlementWalletId), 260);

  // The payout is one transactions row with balanced ledger legs.
  const batch = await settlements.getSettlement(owner.merchant, result.batchId);
  const { rows: payout } = await pool.query(
    "SELECT * FROM settlement_batches WHERE id = $1", [result.batchId]);
  const { rows: legs } = await pool.query(
    "SELECT entry_type, SUM(amount)::NUMERIC total FROM wallet_ledger WHERE transaction_id = $1 GROUP BY entry_type",
    [payout[0].payout_transaction_id]);
  const byType = Object.fromEntries(legs.map((leg) => [leg.entry_type, Number(leg.total)]));
  assert.equal(byType.debit, 260);
  assert.equal(byType.credit, 260);
  assert.equal(batch.netAmount, 260);

  // Replaying the payout moves nothing again.
  const replay = await settlements.executePayout(result.batchId, { actorType: "admin" });
  assert.equal(replay.alreadyPaid, true);
  assert.equal(await walletBalance(settlementWalletId), 260);
});

test("a priced pos_settlement fee is collected into the revenue wallet, ledgered, and reflected in net", async () => {
  const owner = await makeMerchant("fee");
  const settlementWalletId = await makeWallet(owner.ownerId, "business", 0);
  await settlements.updateSettlementConfig(owner.merchant, { settlementWalletId });

  // The revenue wallet the whole platform books fees into.
  await pool.query(
    `INSERT INTO wallets (id, user_id, kind, currency, available_balance, status)
     SELECT $1, NULL, 'revenue', 'ZAR', 0, 'active'
      WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE kind = 'revenue' AND user_id IS NULL)`,
    [crypto.randomUUID()]
  );
  const { rows: revenueRows } = await pool.query(
    "SELECT id, available_balance FROM wallets WHERE kind = 'revenue' AND user_id IS NULL LIMIT 1");
  const revenueBefore = Number(revenueRows[0].available_balance);

  // Operator prices the settlement service: flat R5.
  const { ensureDefaultPricingRule } = require("../src/services/pricing-service");
  await ensureDefaultPricingRule("pos_settlement");
  await pool.query(
    `UPDATE pricing_rules SET flat_fee = 5, percentage_fee = 0, fee_type = 'FIXED', fee_value = 5, enabled = TRUE, active = TRUE
      WHERE service_code = 'pos_settlement'`);

  await realPayment(owner, 105);
  const result = await settlements.closeSettlement(owner.merchantUuid);
  assert.equal(result.status, "paid");

  const batch = await settlements.getSettlement(owner.merchant, result.batchId);
  assert.equal(batch.feeAmount, 5);
  assert.equal(batch.netAmount, 100);
  assert.equal(await walletBalance(settlementWalletId), 100);
  assert.equal(await walletBalance(owner.operatingWalletId), 0);
  assert.equal(Number((await pool.query(
    "SELECT available_balance FROM wallets WHERE id = $1", [revenueRows[0].id])).rows[0].available_balance),
    revenueBefore + 5);

  const { rows: revenue } = await pool.query(
    `SELECT rl.fee_collected FROM revenue_ledger rl
       JOIN settlement_batches b ON b.payout_transaction_id = rl.transaction_id
      WHERE b.id = $1`, [result.batchId]);
  assert.equal(Number(revenue[0].fee_collected), 5);

  // Unprice it so later tests stay fee-free.
  await pool.query(
    `UPDATE pricing_rules SET flat_fee = 0, percentage_fee = 0, fee_type = 'FREE', fee_value = 0
      WHERE service_code = 'pos_settlement'`);
});

test("a payout the wallet cannot cover fails loudly, moves nothing, and retries once funds return", async () => {
  const owner = await makeMerchant("fail");
  const settlementWalletId = await makeWallet(owner.ownerId, "business", 0);
  await settlements.updateSettlementConfig(owner.merchant, { settlementWalletId });

  await realPayment(owner, 90);
  // The merchant spends operating funds before the sweep runs.
  const drainTx = crypto.randomUUID();
  await pool.query("UPDATE wallets SET available_balance = available_balance - 50 WHERE id = $1", [owner.operatingWalletId]);

  await assert.rejects(() => settlements.closeSettlement(owner.merchantUuid), /Not enough available balance/);
  const { rows: failed } = await pool.query(
    "SELECT * FROM settlement_batches WHERE merchant_id = $1", [owner.merchantUuid]);
  assert.equal(failed[0].status, "failed");
  assert.match(failed[0].metadata.lastPayoutError, /Not enough available balance/);
  assert.equal(await walletBalance(settlementWalletId), 0);

  // Funds come back; the admin retry pays the SAME batch.
  await pool.query("UPDATE wallets SET available_balance = available_balance + 50 WHERE id = $1", [owner.operatingWalletId]);
  const retried = await settlements.executePayout(failed[0].id, { actorType: "admin" });
  assert.equal(retried.status, "paid");
  assert.equal(await walletBalance(settlementWalletId), 90);
  void drainTx;
});

test("settlement.completed rides the webhook rails: signed, correct payload, exactly once", async () => {
  const owner = await makeMerchant("hook");
  const target = await receiver();
  try {
    const { secret } = await webhooks.createSubscription(
      owner.merchant, { endpointUrl: target.url, events: ["settlement.completed"] }, { userId: owner.ownerId });

    await realPayment(owner, 75);
    const result = await settlements.closeSettlement(owner.merchantUuid);
    assert.equal(result.status, "paid");
    // The payout fires an immediate delivery nudge of its own, so the row may
    // already be claimed when this explicit pass runs - poll for the arrival
    // instead of racing the nudge.
    for (let i = 0; i < 40 && !target.seen.length; i += 1) {
      await webhooks.deliverDueOnce();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(target.seen.length, 1);
    const hit = target.seen[0];
    const envelope = JSON.parse(hit.body);
    assert.equal(envelope.type, "settlement.completed");
    assert.equal(envelope.data.merchantId, owner.merchant.merchant_id);
    assert.equal(envelope.data.grossAmount, 75);
    assert.equal(envelope.data.netAmount, 75);
    assert.equal(envelope.data.payoutMode, "realtime_wallet");

    // Byte-verify the signature exactly as a partner would.
    const expected = `sha256=${webhooks.signDelivery(
      secret, hit.headers["x-titopay-timestamp"], hit.headers["x-titopay-event-id"], hit.body)}`;
    assert.equal(hit.headers["x-titopay-signature"], expected);

    // A payout replay cannot double-notify: the delivery row is unique.
    await settlements.executePayout(result.batchId, { actorType: "admin" });
    await webhooks.deliverDueOnce();
    assert.equal(target.seen.length, 1);
  } finally {
    target.server.close();
  }
});

test("merchants are isolated and the admin view sees everything", async () => {
  const ownerA = await makeMerchant("isoA");
  const ownerB = await makeMerchant("isoB");
  await realPayment(ownerA, 10);
  const result = await settlements.closeSettlement(ownerA.merchantUuid);

  await assert.rejects(
    () => settlements.getSettlement(ownerB.merchant, result.batchId),
    /Settlement not found/
  );
  assert.equal((await settlements.listSettlements(ownerB.merchant)).length, 0);

  const adminView = await settlements.adminGetSettlement(result.batchId);
  assert.equal(adminView.businessName, "Settlement Cafe");
  assert.ok(adminView.events.length >= 3);
  const adminList = await settlements.adminListSettlements({ merchantId: ownerA.merchantUuid });
  assert.equal(adminList.length, 1);
});

test("the schedule sweep settles due merchants at the SA boundary and leaves manual merchants alone", async () => {
  const scheduled = await makeMerchant("swp");
  const manual = await makeMerchant("man");
  await settlements.updateSettlementConfig(scheduled.merchant, { schedule: "daily" });

  await realPayment(scheduled, 66);
  await realPayment(manual, 33);
  // Age the activity past today's SA midnight so the daily boundary covers it.
  await pool.query(
    `UPDATE transactions SET created_at = created_at - INTERVAL '2 days'
      WHERE merchant_id IN ($1, $2)`,
    [scheduled.merchantUuid, manual.merchantUuid]);

  const sweep = await settlements.runSettlementSweep();
  const mine = (sweep.results || []).filter((row) =>
    [scheduled.merchantUuid, manual.merchantUuid].includes(row.merchantId));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].merchantId, scheduled.merchantUuid);
  assert.equal(mine[0].status, "paid");

  assert.equal((await settlements.listSettlements(scheduled.merchant)).length, 1);
  assert.equal((await settlements.listSettlements(manual.merchant)).length, 0);

  // The swept window ends at the boundary, not "now": trade after the
  // boundary belongs to the next batch.
  const [batch] = await settlements.listSettlements(scheduled.merchant);
  assert.ok(new Date(batch.periodEnd) <= new Date(), "boundary in the past");
});

test("settlement config validates the wallet and the schedule", async () => {
  const owner = await makeMerchant("cfg");
  const stranger = await makeUser("cfgx");
  const strangerWallet = await makeWallet(stranger, "personal", 0);

  await assert.rejects(
    () => settlements.updateSettlementConfig(owner.merchant, { settlementWalletId: strangerWallet }),
    /must be one of this merchant's own active wallets/
  );
  await assert.rejects(
    () => settlements.updateSettlementConfig(owner.merchant, { schedule: "hourly" }),
    /schedule must be one of/
  );
  await assert.rejects(
    () => settlements.updateSettlementConfig(owner.merchant, { settlementWalletId: owner.operatingWalletId }),
    /already the operating wallet/
  );

  const config = await settlements.updateSettlementConfig(owner.merchant, { schedule: "weekly" });
  assert.equal(config.schedule, "weekly");
  assert.equal(config.payoutMode, "realtime_wallet");
});
