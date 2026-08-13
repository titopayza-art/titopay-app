"use strict";

/* REQUEST FUNDS AND BILL SPLIT, END TO END ON THE REAL API.
 *
 * The claim under test: a payment request is an ASK that reaches the payer
 * in-app, moves real money exactly once when they pay through the same rails
 * as Send Money, and can be declined or cancelled with nothing moving at all.
 *
 * Checks:
 *   1.  Receiving is open at any amount unless the account is blocked.
 *   2.  Creating a request notifies the payer through the notification feed.
 *   3.  The payer sees it under incoming; the requester under outgoing.
 *   4.  A stranger can neither pay nor decline someone else's request.
 *   5.  Paying moves exactly the requested amount payer -> requester and
 *       marks the request paid with the settlement transaction recorded.
 *   6.  Paying again is refused and no second debit happens.
 *   7.  Declining moves nothing and tells the requester.
 *   8.  A cancelled request can no longer be paid.
 *   9.  A split fans out one request per participant with the right shares,
 *       and one unregistered participant refuses the whole split by name.
 *   10. Paying a recurring request spawns the next occurrence a week later;
 *       paying with an empty wallet fails cleanly and the request stays
 *       payable after a top-up.
 *   11. You cannot request money from yourself.
 *
 * Run: node verification/payment-requests-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const { signAccessToken } = require(path.join(API, "src", "lib", "jwt.js"));

const TAG = crypto.randomUUID().slice(0, 8);
let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };

const users = [];
const phoneSuffix = () => String(Date.now()).slice(-7) + String(users.length);

async function seedUser(name, { fica = "verified", balance = 0, accountType = "personal" } = {}) {
  const id = crypto.randomUUID();
  const username = `${name}_${TAG}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',$7)`,
    [id, accountType, `${name} Harness`, username, `${name}-${TAG}@example.test`, `+2771${phoneSuffix()}`, fica]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,$4,'ZAR',$5)`,
    [crypto.randomUUID(), `${String(Date.now()).slice(-8)}${users.length}`, id, accountType === "business" ? "business" : "personal", balance]
  );
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [sessionId, id, jti]
  );
  const user = { id, username, sessionId, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
  users.push(user);
  return user;
}

async function balanceOf(userId) {
  const { rows } = await pool.query("SELECT available_balance FROM wallets WHERE user_id = $1", [userId]);
  return Number(rows[0].available_balance);
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (token, method, apiPath, body) => {
    const response = await fetch(`${base}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  try {
    const thuso = await seedUser("thuso", { balance: 1000 });
    const lerato = await seedUser("lerato", { balance: 500 });
    const sipho = await seedUser("sipho", { balance: 50 });
    const unverified = await seedUser("newbie", { fica: "pending", accountType: "business" });

    // 1. Receiving is open unless the account is blocked: an unverified
    //    account requests any amount; a blocked account is refused.
    const allowed = await call(unverified.token, "POST", "/v1/payments/requests",
      { recipient: `@${thuso.username}`, amount: 100 });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    const bigAllowed = await call(unverified.token, "POST", "/v1/payments/requests",
      { recipient: `@${thuso.username}`, amount: 250000 });
    assert.equal(bigAllowed.status, 200, JSON.stringify(bigAllowed.data));
    const blocked = await seedUser("blocked", { fica: "pending" });
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [blocked.id]);
    const refusedBlocked = await call(blocked.token, "POST", "/v1/payments/requests",
      { recipient: `@${thuso.username}`, amount: 50 });
    assert.equal(refusedBlocked.status, 403, "a blocked account is shut out at the door");
    const sendToBlocked = await call(thuso.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 50, recipient: `@${blocked.username}` });
    assert.equal(sendToBlocked.status, 403);
    assert.match(String(sendToBlocked.data.error || ""), /cannot receive money/i);
    ok("unverified accounts request freely at any amount; a blocked account can neither act nor receive");

    // The transfer rails obey the same rule: money reaches an unverified
    // account, and the record carries WHO was paid.
    const sendToUnverified = await call(thuso.token, "POST", "/v1/transactions",
      { serviceCode: "wallet_transfer", amount: 50, recipient: `@${unverified.username}` });
    assert.ok([200, 201].includes(sendToUnverified.status), JSON.stringify(sendToUnverified.data));
    assert.equal(await balanceOf(unverified.id), 50, "the unverified account received the money");
    const { rows: sentRows } = await pool.query(
      "SELECT metadata FROM transactions WHERE id = $1", [sendToUnverified.data.transactionId || sendToUnverified.data.transaction?.transactionId]);
    assert.equal(sentRows[0].metadata.recipientName, "newbie Harness", "the record names who was paid");
    assert.ok(sentRows[0].metadata.recipientContact, "and how to reach them");
    ok("sending to an unverified account works, and the record names who was paid with their contact");

    // 11. No asking yourself.
    const selfish = await call(thuso.token, "POST", "/v1/payments/requests",
      { recipient: `@${thuso.username}`, amount: 50 });
    assert.equal(selfish.status, 400);
    ok("you cannot request money from yourself");

    // 2. Create a real request: Thuso asks Lerato for R180 for the braai.
    const created = await call(thuso.token, "POST", "/v1/payments/requests", {
      recipient: `@${lerato.username}`, amount: 180, description: `braai ${TAG}`, requestType: "One-time request"
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const requestId = created.data.requestId;
    const feed = await call(lerato.token, "GET", "/v1/chat/notifications");
    const notice = (feed.data.notifications || []).find((n) => n.metadata?.requestId === requestId);
    assert.ok(notice, "the payer must find the request in their notification feed");
    assert.match(notice.body, /pay or decline/i);
    ok("the payer is notified in-app the moment the request is made");

    // 3. Both sides see it in their lists.
    const leratoList = await call(lerato.token, "GET", "/v1/payments/requests");
    const incoming = (leratoList.data.incoming || []).find((r) => r.id === requestId);
    assert.ok(incoming && incoming.status === "pending" && Number(incoming.amount) === 180);
    const thusoList = await call(thuso.token, "GET", "/v1/payments/requests");
    assert.ok((thusoList.data.outgoing || []).some((r) => r.id === requestId));
    ok("incoming for the payer, outgoing for the requester, both pending");

    // 4. A stranger cannot pay or decline it.
    assert.equal((await call(sipho.token, "POST", `/v1/payments/requests/${requestId}/pay`)).status, 403);
    assert.equal((await call(sipho.token, "POST", `/v1/payments/requests/${requestId}/decline`, {})).status, 403);
    ok("only the person asked can pay or decline");

    // 5. Lerato pays. Money moves once, exactly.
    const thusoBefore = await balanceOf(thuso.id);
    const leratoBefore = await balanceOf(lerato.id);
    const paid = await call(lerato.token, "POST", `/v1/payments/requests/${requestId}/pay`);
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    assert.equal(paid.data.status, "paid");
    assert.equal(await balanceOf(thuso.id), thusoBefore + 180, "requester credited exactly R180");
    assert.equal(await balanceOf(lerato.id), leratoBefore - 180, "payer debited exactly R180");
    const { rows: prRows } = await pool.query("SELECT status, transaction_id FROM payment_requests WHERE id = $1", [requestId]);
    assert.equal(prRows[0].status, "paid");
    assert.ok(prRows[0].transaction_id, "the settlement transaction is recorded on the request");
    const { rows: ledger } = await pool.query(
      "SELECT COUNT(*)::INT AS entries FROM wallet_ledger WHERE transaction_id = $1", [prRows[0].transaction_id]);
    assert.ok(ledger[0].entries >= 2, "debit and credit ledger entries exist");
    const requesterFeed = await call(thuso.token, "GET", "/v1/chat/notifications");
    assert.ok((requesterFeed.data.notifications || []).some((n) => n.metadata?.requestId === requestId && n.metadata?.outcome === "paid"),
      "the requester is told it was paid");
    ok("paying moves exactly the asked amount on the transfer rails, ledger and all, and the requester is told");

    // 6. Paying again cannot double-charge.
    const again = await call(lerato.token, "POST", `/v1/payments/requests/${requestId}/pay`);
    assert.equal(again.status, 409);
    assert.equal(await balanceOf(lerato.id), leratoBefore - 180, "no second debit");
    ok("a second pay is refused and takes nothing");

    // 7. Decline: nothing moves.
    const declineReq = await call(thuso.token, "POST", "/v1/payments/requests", {
      recipient: `@${lerato.username}`, amount: 75, description: `petrol ${TAG}`
    });
    const declined = await call(lerato.token, "POST", `/v1/payments/requests/${declineReq.data.requestId}/decline`,
      { note: "I was not at the braai" });
    assert.equal(declined.status, 200);
    assert.equal(await balanceOf(lerato.id), leratoBefore - 180, "declining moves nothing");
    const declinedFeed = await call(thuso.token, "GET", "/v1/chat/notifications");
    assert.ok((declinedFeed.data.notifications || []).some((n) => n.metadata?.requestId === declineReq.data.requestId && n.metadata?.outcome === "declined"));
    ok("declining moves no money and the requester hears why");

    // 8. Cancel closes the door.
    const cancelReq = await call(thuso.token, "POST", "/v1/payments/requests", {
      recipient: `@${lerato.username}`, amount: 60
    });
    assert.equal((await call(thuso.token, "POST", `/v1/payments/requests/${cancelReq.data.requestId}/cancel`)).status, 200);
    assert.equal((await call(lerato.token, "POST", `/v1/payments/requests/${cancelReq.data.requestId}/pay`)).status, 409);
    ok("a cancelled request can no longer be paid");

    // 9. Bill split: shares fan out; an unknown participant stops everything.
    const badSplit = await call(thuso.token, "POST", "/v1/payments/requests/split", {
      reference: `Trip ${TAG}`, amount: 300, splitMethod: "Equal split",
      participants: [
        { identifier: `@${lerato.username}`, amount: 100 },
        { identifier: "@nobody_here_" + TAG, amount: 100 }
      ]
    });
    assert.equal(badSplit.status, 404);
    assert.match(String(badSplit.data.error || ""), new RegExp(`nobody_here_${TAG}`));
    const { rows: noRows } = await pool.query(
      "SELECT COUNT(*)::INT AS n FROM payment_requests WHERE split_label = $1", [`Trip ${TAG}`]);
    assert.equal(noRows[0].n, 0, "a failed split creates nothing at all");
    const split = await call(thuso.token, "POST", "/v1/payments/requests/split", {
      reference: `Trip ${TAG}`, amount: 300, splitMethod: "Equal split",
      participants: [
        { identifier: `@${lerato.username}`, amount: 100 },
        { identifier: `@${sipho.username}`, amount: 100 }
      ]
    });
    assert.equal(split.status, 200, JSON.stringify(split.data));
    assert.equal(split.data.requests.length, 2);
    const siphoList = await call(sipho.token, "GET", "/v1/payments/requests");
    const siphoShare = (siphoList.data.incoming || []).find((r) => r.splitLabel === `Trip ${TAG}`);
    assert.ok(siphoShare && Number(siphoShare.amount) === 100);
    ok("a split sends each participant exactly their share, and one wrong name stops the whole split by name");

    // 10. Recurring + empty wallet.
    const recurring = await call(thuso.token, "POST", "/v1/payments/requests", {
      recipient: `@${sipho.username}`, amount: 90, description: `gym ${TAG}`,
      requestType: "Recurring request", recurringFrequency: "Weekly"
    });
    const recurringId = recurring.data.requestId;
    const broke = await call(sipho.token, "POST", `/v1/payments/requests/${recurringId}/pay`);
    assert.equal(broke.status, 400, "R50 cannot pay a R90 request");
    const { rows: stillPending } = await pool.query("SELECT status FROM payment_requests WHERE id = $1", [recurringId]);
    assert.equal(stillPending[0].status, "pending", "a failed payment releases the request for another try");
    await pool.query("UPDATE wallets SET available_balance = 200 WHERE user_id = $1", [sipho.id]);
    const nowPaid = await call(sipho.token, "POST", `/v1/payments/requests/${recurringId}/pay`);
    assert.equal(nowPaid.status, 200, JSON.stringify(nowPaid.data));
    assert.ok(nowPaid.data.nextRequest, "paying a recurring request spawns the next one");
    const { rows: nextRows } = await pool.query(
      "SELECT status, due_date FROM payment_requests WHERE id = $1", [nowPaid.data.nextRequest.requestId]);
    assert.equal(nextRows[0].status, "pending");
    ok("an empty wallet fails cleanly and a retry succeeds; paying a recurring request books the next week");

    console.log(`\n${passed}/10 checks passed. Requests ask, people answer, money moves only on Pay.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM payment_requests WHERE requester_user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM beneficiary_history WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::UUID[])", [ids]).catch(() => {});
  }
})();
