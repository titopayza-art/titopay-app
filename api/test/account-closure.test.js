"use strict";

// Account closure requests (build 89): a customer asks, the request lands in
// the admin console, an admin decides. Behavioral against the real database.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "closure-test-access-secret-32-bytes-okay!";
process.env.JWT_REFRESH_SECRET ||= "closure-test-refresh-secret-32-bytes-ok!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");
const { login } = require("../src/services/auth-service");
const {
  createClosureRequest,
  getOwnClosureRequest,
  cancelOwnClosureRequest,
  listClosureRequests,
  approveClosureRequest,
  declineClosureRequest
} = require("../src/services/account-closure-service");

const stamp = Date.now().toString(36);
const PASSWORD = "Str0ngPass!2026";
const meta = { ipAddress: "127.0.0.1", userAgent: "node-test" };

async function makeCustomer({ balance = 0 } = {}) {
  const id = crypto.randomUUID();
  const username = `close_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,'personal','Closure Test',$2,$3,$4,$5)`,
    [id, username, `${username}@t.local`, `+2772${Math.floor(1000000 + Math.random() * 8999999)}`, await hashPassword(PASSWORD)]
  );
  const walletId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO wallets (id, user_id, wallet_number, kind, available_balance, reserved_balance)
     VALUES ($1,$2,$3,'personal',$4,0)`,
    [walletId, id, String(Math.floor(100000000 + Math.random() * 899999999)), balance]
  );
  return { id, username, walletId };
}

async function makeAdmin() {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     VALUES ($1,'Closure Admin',$2,$3,'super_admin',$4)`,
    [id, `cladmin_${stamp}_${crypto.randomBytes(3).toString("hex")}`,
     `cladmin_${stamp}_${crypto.randomBytes(3).toString("hex")}@t.local`, await hashPassword(PASSWORD)]
  );
  return id;
}

async function cleanupAdmin(adminId) {
  await pool.query("UPDATE account_closure_requests SET decided_by = NULL WHERE decided_by=$1", [adminId]).catch(() => {});
  await pool.query("DELETE FROM admin_users WHERE id=$1", [adminId]);
}

async function cleanup(userId) {
  await pool.query("DELETE FROM account_closure_requests WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM sessions WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
}

test("request -> admin list -> approve: sign-in blocked, sessions revoked, records kept", async () => {
  const { id, username } = await makeCustomer();
  const admin = await makeAdmin();
  try {
    // A live session that must die at approval.
    const before = await login({ identifier: username, password: PASSWORD, scope: "customer" }, meta);
    assert.ok(before.accessToken, "customer signs in normally before closing");

    const request = await createClosureRequest(id, { reason: "Moving banks" }, meta);
    assert.equal(request.status, "pending");

    // The request LANDS in the admin console list.
    const listed = (await listClosureRequests("pending")).find((row) => row.id === request.id);
    assert.ok(listed, "the pending request is visible to admins");
    assert.equal(listed.user.username, username);
    assert.equal(listed.balances.available, 0);

    const decided = await approveClosureRequest(request.id, admin, meta);
    assert.equal(decided.status, "approved");

    // Sign-in refused, sessions revoked, user row retained (not deleted).
    await assert.rejects(
      login({ identifier: username, password: PASSWORD, scope: "customer" }, meta),
      /not active/i,
      "a closed account must not sign in"
    );
    const { rows: sessions } = await pool.query(
      "SELECT COUNT(*)::int AS open FROM sessions WHERE user_id=$1 AND revoked_at IS NULL", [id]);
    assert.equal(sessions[0].open, 0, "every live session is revoked at closure");
    const { rows: users } = await pool.query("SELECT status FROM users WHERE id=$1", [id]);
    assert.equal(users[0].status, "closed", "the record is retained with a closed status, never deleted");
  } finally {
    await cleanup(id);
    await cleanupAdmin(admin);
  }
});

test("approval is refused while the wallet still holds money", async () => {
  const { id } = await makeCustomer({ balance: 50 });
  const admin = await makeAdmin();
  try {
    const request = await createClosureRequest(id, {}, meta);
    await assert.rejects(
      approveClosureRequest(request.id, admin, meta),
      /Settle the wallet to zero/i,
      "closing over a balance would strand the customer's money"
    );
    const current = await getOwnClosureRequest(id);
    assert.equal(current.status, "pending", "the refusal leaves the request open for after settlement");
  } finally {
    await cleanup(id);
    await cleanupAdmin(admin);
  }
});

test("one open request per customer; cancel reopens the door; decline carries a note", async () => {
  const { id } = await makeCustomer();
  const admin = await makeAdmin();
  try {
    await createClosureRequest(id, {}, meta);
    await assert.rejects(createClosureRequest(id, {}, meta), /already have a closure request/i,
      "a double-submit is answered kindly, enforced by the database");

    const cancelled = await cancelOwnClosureRequest(id, meta);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(cancelOwnClosureRequest(id, meta), /no closure request/i,
      "cancel is decide-once too");

    const again = await createClosureRequest(id, { reason: "second thoughts, final" }, meta);
    await assert.rejects(declineClosureRequest(again.id, admin, "", meta), /note.*required/i);
    const declined = await declineClosureRequest(again.id, admin, "Please settle your open ticket order first.", meta);
    assert.equal(declined.status, "declined");
    assert.match(declined.decisionNote, /ticket order/);
    await assert.rejects(declineClosureRequest(again.id, admin, "twice", meta), /already decided/i);

    // A declined customer can still sign in — nothing changed on the account.
    const { rows } = await pool.query("SELECT status FROM users WHERE id=$1", [id]);
    assert.equal(rows[0].status, "active");
  } finally {
    await cleanup(id);
    await cleanupAdmin(admin);
  }
});
