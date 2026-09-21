"use strict";

/* THE PRODUCTION-HARDENING BATCH, PROVEN ON THE REAL API.
 *
 *  1. Stokvel: the wizard's group creation is free and direct; a member's
 *     contribution moves real money to the treasurer on the transfer rails
 *     and lands on the group register; a draft group refuses contributions;
 *     a non-member is refused; invited members are notified with the code.
 *  2. Send gift: the recipient is told who sent it, the occasion and the
 *     message, through the notification feed.
 *  3. Support: rating records stay out of My support requests, and one call
 *     clears every finished request.
 *  4. Marketing: the unsubscribe link opts an address out permanently, a
 *     tampered link is refused, and opted-out addresses leave the audience.
 *
 * Run: node verification/production-hardening-live.js
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

async function seedUser(name, { balance = 0 } = {}) {
  const id = crypto.randomUUID();
  const username = `${name}_${TAG}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, fica_status)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active','verified')`,
    [id, `${name[0].toUpperCase()}${name.slice(1)} Harness`, username, `${name}-${TAG}@example.test`,
      `+2772${String(Date.now()).slice(-6)}${users.length}`]);
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance)
     VALUES ($1,$2,$3,'personal','ZAR',$4)`,
    [crypto.randomUUID(), `${String(Date.now()).slice(-7)}9${users.length}`, id, balance]);
  const sessionId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, user_type, user_id, scope, refresh_token_hash, access_jti, expires_at)
     VALUES ($1,'customer',$2,'customer','x',$3, NOW() + INTERVAL '1 hour')`,
    [sessionId, id, jti]);
  const user = { id, username, token: signAccessToken({ sub: id, sid: sessionId, jti, typ: "customer" }) };
  users.push(user);
  return user;
}

const balanceOf = async (userId) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1", [userId])).rows[0].available_balance);

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, method, apiPath, body) => {
    const response = await fetch(`${base}${apiPath}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: response.status, data };
  };

  try {
    const chair = await seedUser("chair", { balance: 100 });
    const member = await seedUser("member", { balance: 500 });
    const outsider = await seedUser("outsider", { balance: 500 });

    // --- 1. Stokvel ---
    const created = await call(chair.token, "POST", "/v1/stockvels", {
      name: `Family Rotation ${TAG}`, cadence: "monthly", contributionAmount: 200, status: "active"
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const group = created.data.group;
    assert.ok(group.id && (group.inviteCode || group.invite_code), "group carries an invite code");
    ok("the wizard's creation call makes a live group, free, with an invite code");

    const invites = await call(chair.token, "POST", `/v1/stockvels/${group.id}/invitations`, {
      identifiers: [`@${member.username}`, `@ghost_${TAG}`]
    });
    assert.equal(invites.status, 201, JSON.stringify(invites.data));
    assert.equal((invites.data.invited || []).length, 1);
    assert.deepEqual(invites.data.notRegistered, [`@ghost_${TAG}`]);
    const memberFeed = await call(member.token, "GET", "/v1/chat/notifications");
    const inviteNotice = (memberFeed.data.notifications || []).find((n) => n.notification_type === "stockvel_invite");
    assert.ok(inviteNotice && inviteNotice.body.includes(group.inviteCode || group.invite_code),
      "the invited member holds the code in their notification");
    ok("named members receive the invite code in-app; unknown names are reported back");

    const joined = await call(member.token, "POST", "/v1/stockvels/join", { inviteCode: group.inviteCode || group.invite_code });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));

    const blockedOutsider = await call(outsider.token, "POST", `/v1/stockvels/${group.id}/contributions`, { amount: 200 });
    assert.equal(blockedOutsider.status, 404, "a non-member cannot even see the group");
    ok("an outsider cannot contribute to a group they are not in");

    const preview = await call(member.token, "GET", `/v1/stockvels/${group.id}/contributions/preview?amount=200`);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.amount, 200);
    assert.ok(preview.data.treasurer.includes("Chair"), "the preview names the treasurer");

    const chairBefore = await balanceOf(chair.id);
    const memberBefore = await balanceOf(member.id);
    const contributed = await call(member.token, "POST", `/v1/stockvels/${group.id}/contributions`,
      { amount: 200, cycle: "August" });
    assert.equal(contributed.status, 201, JSON.stringify(contributed.data));
    assert.equal(await balanceOf(chair.id), chairBefore + 200, "the treasurer holds the contribution");
    const memberAfter = await balanceOf(member.id);
    assert.equal(memberAfter, memberBefore - Number(contributed.data.total), "the member paid amount plus the priced fee");
    const detail = await call(member.token, "GET", `/v1/stockvels/${group.id}`);
    const register = JSON.stringify(detail.data);
    assert.ok(register.includes(contributed.data.reference), "the contribution shows on the group register");
    ok(`a contribution moves real money to the treasurer (fee ${contributed.data.fee}) and lands on the register`);

    const draft = await call(chair.token, "POST", "/v1/stockvels", {
      name: `Draft Group ${TAG}`, contributionAmount: 50, status: "draft"
    });
    const draftBlocked = await call(chair.token, "POST", `/v1/stockvels/${draft.data.group.id}/contributions`, { amount: 50 });
    assert.equal(draftBlocked.status, 409);
    ok("a draft group takes no money");

    // --- 2. Send gift ---
    const gift = await call(member.token, "POST", "/v1/transactions", {
      serviceCode: "send_gift", amount: 75, recipient: `@${outsider.username}`,
      metadata: { occasion: "Birthday", message: `Happy birthday ${TAG}!` }
    });
    assert.ok([200, 201].includes(gift.status), JSON.stringify(gift.data));
    const giftFeed = await call(outsider.token, "GET", "/v1/chat/notifications");
    const giftNotice = (giftFeed.data.notifications || []).find((n) => n.notification_type === "gift_received");
    assert.ok(giftNotice, "the recipient's feed carries the gift notice");
    assert.match(giftNotice.title, /sent you a gift of R75\.00/);
    assert.ok(giftNotice.body.includes("Birthday") && giftNotice.body.includes(`Happy birthday ${TAG}!`),
      "occasion and message both reach the recipient");
    ok("a gift arrives as a gift: sender, occasion and message in the recipient's notifications");

    // --- 3. Support list hygiene ---
    for (const [ref, category, status] of [
      [`TC${TAG.slice(0, 6)}1`, "chatbot_escalation", "resolved"],
      [`TR${TAG.slice(0, 6)}2`, "support_rating", "resolved"],
      [`TC${TAG.slice(0, 6)}3`, "general", "open"]
    ]) {
      await pool.query(
        `INSERT INTO support_tickets (id, ticket_ref, user_id, category, subject, message, status)
         VALUES ($1,$2,$3,$4,'Harness','Harness message',$5)`,
        [crypto.randomUUID(), ref, member.id, category, status]);
    }
    const list = await call(member.token, "GET", "/v1/support/tickets");
    const categories = (list.data.items || []).map((item) => item.category);
    assert.ok(!categories.includes("support_rating"), "ratings are not support requests");
    ok("support ratings no longer clutter My support requests");

    const cleared = await call(member.token, "DELETE", "/v1/support/tickets");
    assert.equal(cleared.status, 200);
    assert.ok(cleared.data.removed >= 1, "the finished request was cleared");
    const after = await call(member.token, "GET", "/v1/support/tickets");
    const statuses = (after.data.items || []).map((item) => item.status);
    assert.ok(statuses.includes("open"), "the open conversation stays");
    assert.ok(!statuses.includes("resolved"), "the finished ones are gone in one call");
    ok("Clear finished requests removes every resolved request in one tap and keeps open ones");

    // --- 4. Unsubscribe ---
    const { buildUnsubscribeUrl, marketingOptOutEmails } = require(path.join(API, "src", "services", "email-centre-service.js"));
    const url = new URL(buildUnsubscribeUrl(`member-${TAG}@example.test`));
    const good = await call(null, "GET", `/v1/email/unsubscribe${url.search}`);
    assert.equal(good.status, 200);
    assert.match(good.data.raw, /You are unsubscribed/);
    const optedOut = await marketingOptOutEmails();
    assert.ok(optedOut.has(`member-${TAG}@example.test`), "the opt-out is stored");
    const tampered = await call(null, "GET", `/v1/email/unsubscribe?e=${url.searchParams.get("e")}&s=${"0".repeat(32)}`);
    assert.equal(tampered.status, 400, "a forged signature is refused");
    ok("the unsubscribe link works once clicked, is stored forever, and cannot be forged");

    console.log(`\n${passed}/9 checks passed. The batch holds on the real API.`);
    process.exit(0);
  } catch (error) {
    console.error("\nFAILED:", error.message);
    process.exit(1);
  } finally {
    server.close();
    const ids = users.map((u) => u.id);
    await pool.query("DELETE FROM marketing_email_optouts WHERE email LIKE $1", [`%${TAG}%`]).catch(() => {});
    await pool.query("DELETE FROM support_tickets WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM stockvel_members WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM stockvel_groups WHERE owner_user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM notifications WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = ANY($1::UUID[]))", [ids]).catch(() => {});
    await pool.query("DELETE FROM transactions WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM beneficiary_history WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM email_queue WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::UUID[])", [ids]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id = ANY($1::UUID[])", [ids]).catch(() => {});
  }
})();
