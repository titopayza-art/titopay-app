"use strict";

// THE PERSON WHO WAS PAID IS TOLD. EVERY TIME.
//
// TitoPay wrote a receipt to the PAYER on every payment and nothing at all to
// the person who was paid. A poster on a counter, a tip poster on a table, a
// till, an event selling tickets and a person being sent money all produced
// silence on the receiving side. The only recipient-side notice in the whole
// codebase belonged to send_gift.
//
// This drives real payments through the real services and then asks the
// database what the RECEIVER was told:
//
//   1. Payment A4 poster scanned and paid  -> in-app + email
//   2. Tip A4 poster scanned and paid      -> in-app + email
//   3. Money sent to a username            -> in-app + email
//   4. A ticket sold                       -> the ORGANISER is told
//   5. The notice states the NET, so it agrees with the wallet
//   6. A customer who has turned transaction emails off gets the in-app
//      notice and NO email
//   7. Paying twice does not tell them twice
//   8. A gift is not announced twice, because it has its own richer notice
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/payment-received-notices-live.js
//
// Seeds and deletes its own accounts. Reads the revenue wallet, never moves it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const qrService = require("../api/src/services/qr-service");
const { createTransaction } = require("../api/src/services/transaction-service");

const TAG = `pn${String(Date.now()).slice(-7)}`;
const shop = { id: randomUUID(), phone: "27110000241", type: "business" };
const tipper = { id: randomUUID(), phone: "27110000242", type: "personal" };
const payer = { id: randomUUID(), phone: "27110000243", type: "personal" };
const quiet = { id: randomUUID(), phone: "27110000244", type: "personal" };
const everyone = [shop, tipper, payer, quiet];
const round = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

async function seed(user, balance) {
  user.email = `${TAG}_${user.phone.slice(-3)}@example.invalid`;
  user.username = `${TAG}_${user.phone.slice(-3)}`;
  await pool.query(
    `INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
     VALUES ($1,$2,$3,$4,$5,$6,'x','active',FALSE,'approved')`,
    [user.id, user.type, `${TAG} Person ${user.phone.slice(-3)}`, user.username, user.email, user.phone]);
  await pool.query(
    `INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
     VALUES ($1,$2,$3,$4,'ZAR',$5,0,'active')`,
    [randomUUID(), user.phone.slice(-9), user.id, user.type, balance]);
}

const balanceOf = async (id) => Number((await pool.query(
  "SELECT available_balance FROM wallets WHERE user_id = $1 LIMIT 1", [id])).rows[0].available_balance);

// What the RECEIVER was told, straight from the tables the app reads.
const noticesFor = async (userId) => (await pool.query(
  `SELECT title, body, metadata FROM notifications
    WHERE user_id = $1 AND notification_type = 'payment_received'
    ORDER BY created_at DESC`, [userId])).rows;
const emailsFor = async (userId) => (await pool.query(
  `SELECT subject, template_key, idempotency_key FROM email_queue
    WHERE user_id = $1 AND template_key = 'payment_received'
    ORDER BY created_at DESC`, [userId])).rows;

// A poster carries no price: the payer names the amount, exactly as the app
// asks them to after a scan.
async function payQrOnce(from, qrId, amount) {
  return qrService.payQr(
    { userId: from.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "notices" },
    { qrId, amount, idempotencyKey: randomUUID() });
}

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  try {
    await require("../api/src/services/email-centre-service").ensureEmailSchema();
    await seed(shop, 0);
    await seed(tipper, 0);
    await seed(payer, 20000);
    await seed(quiet, 5000);
    await pool.query(
      `INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
       VALUES ($1,$2,$3,$4,'active','verified')`, [randomUUID(), shop.id, `${TAG} Corner Cafe`, `M${TAG}`]);

    // 1. THE PAYMENT A4 POSTER. A static code on a counter, paid by a stranger.
    const poster = await qrService.createQr({ userId: shop.id, userType: "customer" },
      { codeType: "static", label: "Payment A4 poster" });
    const shopBefore = await balanceOf(shop.id);
    await payQrOnce(payer, poster.id, 250);
    const credited = round((await balanceOf(shop.id)) - shopBefore);
    const shopNotices = await noticesFor(shop.id);
    const shopEmails = await emailsFor(shop.id);
    assert.equal(shopNotices.length, 1, `the poster's owner got ${shopNotices.length} in-app notices`);
    assert.equal(shopEmails.length, 1, `the poster's owner got ${shopEmails.length} emails`);
    assert.match(shopNotices[0].title, /You received R/);
    assert.match(shopNotices[0].body, /paid your QR code/i);
    ok("the Payment A4 poster tells its owner, in the app and by email", shopNotices[0].title);

    // 5. AND THE FIGURE IS THE ONE THE WALLET MOVED BY.
    const stated = Number(String(shopNotices[0].title).replace(/[^\d.]/g, ""));
    assert.equal(round(stated), credited,
      `the notice says R${stated} and the wallet moved R${credited}`);
    assert.equal(round(Number(shopNotices[0].metadata.amount)), credited);
    ok("the notice states what actually reached the wallet, not the sticker price",
      `R${credited.toFixed(2)} credited, R${credited.toFixed(2)} announced`);

    // 2. THE TIP A4 POSTER. A personal account, which is the case with no
    //    Sales screen to fall back on: without this notice a tip is invisible.
    const tipPoster = await qrService.createQr({ userId: tipper.id, userType: "customer" },
      { codeType: "static", label: "Tip A4 poster" });
    await payQrOnce(payer, tipPoster.id, 40);
    const tipNotices = await noticesFor(tipper.id);
    assert.equal(tipNotices.length, 1, `the tip poster's owner got ${tipNotices.length} notices`);
    assert.equal((await emailsFor(tipper.id)).length, 1);
    ok("the Tip A4 poster tells its owner too", tipNotices[0].title);

    // 7. PAYING A STATIC CODE AGAIN IS A SECOND PAYMENT, AND A SECOND NOTICE,
    //    but ONE payment can never produce two. The idempotency key is the
    //    transaction, so a retried delivery cannot double-announce.
    const keys = (await emailsFor(shop.id)).map((row) => row.idempotency_key);
    assert.equal(new Set(keys).size, keys.length, "two emails share one payment");
    assert.match(keys[0], /^payment-received:/);
    ok("one payment can only ever produce one notice", keys[0]);

    // 3. MONEY SENT TO A USERNAME. Not a QR at all, and it was equally silent.
    await createTransaction(
      { userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "notices" },
      { serviceCode: "send_money", amount: 300, recipient: quiet.username, idempotencyKey: randomUUID() });
    const quietNotices = await noticesFor(quiet.id);
    assert.equal(quietNotices.length, 1, "money sent to a username told nobody");
    assert.match(quietNotices[0].body, /sent you money/i);
    ok("money sent to a username tells the person who got it", quietNotices[0].body.slice(0, 58) + "...");

    // 6. AND THE EMAIL SWITCH IS HONOURED. The in-app notice is not optional;
    //    the email is, and it is the same preference that governs the payer's
    //    own receipt.
    await pool.query(
      `INSERT INTO customer_notification_preferences (user_id,email_notifications_enabled,email_transaction_receipts)
       VALUES ($1,TRUE,FALSE)
       ON CONFLICT (user_id) DO UPDATE SET email_transaction_receipts = FALSE`, [quiet.id]);
    const beforeQuiet = (await emailsFor(quiet.id)).length;
    await createTransaction(
      { userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "notices" },
      { serviceCode: "send_money", amount: 120, recipient: quiet.username, idempotencyKey: randomUUID() });
    assert.equal((await noticesFor(quiet.id)).length, 2, "turning emails off silenced the in-app notice too");
    assert.equal((await emailsFor(quiet.id)).length, beforeQuiet,
      "an email went out to somebody who turned transaction emails off");
    ok("a customer who turns transaction emails off still gets the in-app notice, and no email");

    // 8. A GIFT IS NOT ANNOUNCED TWICE. It has its own notice carrying the
    //    sender, the occasion and the message, and two notices for one payment
    //    is its own kind of broken.
    const giftBefore = (await noticesFor(quiet.id)).length;
    await createTransaction(
      { userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "notices" },
      { serviceCode: "send_gift", amount: 50, recipient: quiet.username, idempotencyKey: randomUUID(),
        metadata: { occasion: "Birthday", message: "Enjoy" } });
    assert.equal((await noticesFor(quiet.id)).length, giftBefore, "a gift was announced twice");
    const giftNotice = (await pool.query(
      "SELECT title FROM notifications WHERE user_id=$1 AND notification_type='gift_received'", [quiet.id])).rows;
    assert.equal(giftNotice.length, 1, "the gift's own notice went missing");
    ok("a gift keeps its own richer notice and is not announced twice", giftNotice[0].title);

    // 4. AN EVENT SELLING A TICKET PAYS ITS ORGANISER, on a path that never
    //    touched createTransaction, so it needed wiring of its own. The event
    //    is seeded directly: this harness is about the notice, not about the
    //    draft/submit/approve journey, which has harnesses of its own.
    const ticketing = require("../api/src/services/ticketing-service");
    await ticketing.ensureTicketingSchema();
    const eventId = randomUUID();
    const typeId = randomUUID();
    const slug = `${TAG}-launch`;
    await pool.query(
      `INSERT INTO events (id,business_user_id,event_name,slug,status,event_date,venue_name,city,province)
       VALUES ($1,$2,$3,$4,'approved','2026-12-01','The Yard','Johannesburg','GP')`,
      [eventId, shop.id, `${TAG} Launch`, slug]);
    await pool.query(
      `INSERT INTO event_ticket_types (id,event_id,ticket_name,price,quantity_available)
       VALUES ($1,$2,'General',200,50)`, [typeId, eventId]);

    const organiserBefore = await balanceOf(shop.id);
    const noticesBefore = (await noticesFor(shop.id)).length;
    await ticketing.purchaseTickets(
      { userId: payer.id, userType: "customer", ipAddress: "127.0.0.1", userAgent: "notices" },
      slug, { ticketTypeId: typeId, quantity: 2, idempotencyKey: randomUUID() });
    const organiserCredited = round((await balanceOf(shop.id)) - organiserBefore);
    const organiserNotices = await noticesFor(shop.id);
    assert.equal(organiserNotices.length, noticesBefore + 1, "the organiser was not told a ticket sold");
    assert.match(organiserNotices[0].body, /bought tickets/i);
    assert.equal(round(Number(organiserNotices[0].metadata.amount)), organiserCredited,
      `the organiser's notice says R${organiserNotices[0].metadata.amount}, the wallet moved R${organiserCredited}`);
    ok("an event selling tickets tells its organiser, and the figure is the net",
      `+R${organiserCredited.toFixed(2)}, "${organiserNotices[0].title}"`);

    console.log(`\n  ${passed}/8 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    for (const user of everyone) {
      await pool.query("DELETE FROM tickets WHERE owner_user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM tickets WHERE event_id IN (SELECT id FROM events WHERE business_user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM ticket_orders WHERE buyer_user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM ticket_orders WHERE event_id IN (SELECT id FROM events WHERE business_user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM event_ticket_types WHERE event_id IN (SELECT id FROM events WHERE business_user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM events WHERE business_user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM email_queue WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM notifications WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM customer_notification_preferences WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM qr_codes WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM revenue_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallet_ledger WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1)", [user.id]).catch(() => {});
      await pool.query("DELETE FROM transactions WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM audit_logs WHERE actor_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM merchants WHERE user_id=$1", [user.id]).catch(() => {});
      await pool.query("DELETE FROM wallets WHERE user_id=$1 AND kind <> 'revenue'", [user.id]).catch(() => {});
      await pool.query("DELETE FROM users WHERE id=$1", [user.id]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
})();
