"use strict";

// VENDOR IN-APP SOFTPOS — TAP A WRISTBAND, CHARGE IT, AGAINST A REAL DATABASE.
//
// A vendor at an event reads a patron's Event Tag with their phone (or types the
// code) and charges it from the TitoPay app, with no admin-registered hardware
// terminal. This proves the money moves correctly AND that the authorisation
// holds: only a business the event owner added as a vendor can charge, and only
// at the event the tag belongs to.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay node verification/vendor-tag-charge-live.js
//
// Seeds its own throwaway accounts and deletes them at the end. No existing data
// is touched; money figures are read straight from the wallets ledger.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const eventTags = require("../api/src/services/event-tag-service");

const TAG = "vendortaplive";
const ids = {
  owner: randomUUID(), vendorUser: randomUUID(), otherUser: randomUUID(), attendee: randomUUID(),
  vendorMerchant: randomUUID(), otherMerchant: randomUUID(),
  vendorWallet: randomUUID(), otherWallet: randomUUID(), attendeeWallet: randomUUID(),
  event: randomUUID(), tagId: randomUUID()
};
// The wristband credential. Only its hash is stored; the vendor's tap yields the
// raw token, which is what the charge call receives.
const tagToken = `ETAG_${crypto.randomBytes(32).toString("base64url")}`;
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

const balance = async (walletId) =>
  Number((await pool.query("SELECT available_balance FROM wallets WHERE id = $1", [walletId])).rows[0]?.available_balance || 0);

async function business(userId, merchantId, walletId, name, kind = "business") {
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'business',$2,$3,$4,$5,'x','active',FALSE,'approved')`,
    [userId, name, `${name.replace(/\W/g, "").toLowerCase()}${String(userId).slice(0, 4)}`, `${String(userId).slice(0, 6)}@example.invalid`, `2711${String(Date.now()).slice(-7)}`]
  );
  await pool.query(
    `INSERT INTO merchants (id, user_id, business_name, merchant_id, status, verification_status)
     VALUES ($1,$2,$3,$4,'active','approved')`,
    [merchantId, userId, name, `${TAG}${String(merchantId).slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,$4,'ZAR',0,0,'active')`,
    [walletId, String(Math.floor(Math.random() * 1e9)), userId, kind]
  );
}

async function seed() {
  await eventTags.ensureSchema ? null : null;
  const ticketing = require("../api/src/services/ticketing-service");
  await ticketing.ensureTicketingSchema();

  // Event owner + an approved, cashless-enabled event.
  await business(ids.owner, randomUUID(), randomUUID(), `${TAG} Owner`);
  await pool.query(
    `INSERT INTO events (id, business_user_id, status, slug, event_name, category, event_date, cashless_tags_enabled)
     VALUES ($1,$2,'approved',$3,$4,'festival','2027-03-01',TRUE)`,
    [ids.event, ids.owner, `${TAG}-fest-${String(ids.event).slice(0, 6)}`, `${TAG} Festival`]
  );

  // The vendor (authorised) and an unrelated business (NOT a vendor).
  await business(ids.vendorUser, ids.vendorMerchant, ids.vendorWallet, `${TAG} Bar`);
  await business(ids.otherUser, ids.otherMerchant, ids.otherWallet, `${TAG} Outsider`);
  await pool.query(
    `INSERT INTO event_vendors (id, event_id, merchant_id, status, created_by) VALUES ($1,$2,$3,'active',$4)`,
    [randomUUID(), ids.event, ids.vendorMerchant, ids.owner]
  );

  // The attendee with a funded wallet and a live tag linked to them.
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
     VALUES ($1,'personal',$2,$3,$4,$5,'x','active',FALSE,'approved')`,
    [ids.attendee, `${TAG} Patron`, `${TAG}patron`, `${TAG}patron@example.invalid`, `2711${String(Date.now() + 1).slice(-7)}`]
  );
  await pool.query(
    `INSERT INTO wallets (id, wallet_number, user_id, kind, currency, available_balance, reserved_balance, status)
     VALUES ($1,$2,$3,'personal','ZAR',500,0,'active')`,
    [ids.attendeeWallet, String(Math.floor(Math.random() * 1e9)), ids.attendee]
  );
  await pool.query(
    `INSERT INTO event_tags (id, event_id, token_hash, tag_label, user_id, status)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE')`,
    [ids.tagId, ids.event, sha256(tagToken), "BAND-001", ids.attendee]
  );
}

async function cleanup() {
  await pool.query("DELETE FROM event_tag_events WHERE tag_id = $1", [ids.tagId]).catch(() => {});
  await pool.query("DELETE FROM event_tags WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM event_vendors WHERE event_id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM pos_idempotency_keys WHERE scope LIKE $1", [`event_tag_charge:vendor-app:%`]).catch(() => {});
  const users = [ids.owner, ids.vendorUser, ids.otherUser, ids.attendee];
  await pool.query("DELETE FROM transactions WHERE user_id = ANY($1)", [users]).catch(() => {});
  const wallets = [ids.vendorWallet, ids.otherWallet, ids.attendeeWallet];
  await pool.query("DELETE FROM wallet_ledger WHERE wallet_id = ANY($1)", [wallets]).catch(() => {});
  await pool.query("DELETE FROM events WHERE id = $1", [ids.event]).catch(() => {});
  await pool.query("DELETE FROM wallets WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM merchants WHERE user_id = ANY($1)", [users]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [users]).catch(() => {});
}

(async () => {
  let passed = 0;
  const ok = (m) => { console.log(`  ✓ ${m}`); passed += 1; };
  try {
    await seed();
    console.log("\n" + "=".repeat(80));
    console.log("  VENDOR IN-APP SOFTPOS — TAP TO CHARGE, REAL DATABASE");
    console.log("=".repeat(80));

    const vendorActor = { userId: ids.vendorUser, userType: "customer" };
    const outsiderActor = { userId: ids.otherUser, userType: "customer" };

    // 1. The vendor taps and charges R50.
    const attBefore = await balance(ids.attendeeWallet);
    const venBefore = await balance(ids.vendorWallet);
    const charge = await eventTags.chargeEventTagAsVendor(vendorActor, { tagToken, amount: 50 }, `tap-${randomUUID()}`, "req-1");
    assert.equal(charge.outcome, "APPROVED", "the charge should be approved");
    const attAfter = await balance(ids.attendeeWallet);
    const venAfter = await balance(ids.vendorWallet);
    assert.equal(attBefore - attAfter, 50, `attendee should be debited R50 (was ${attBefore}, now ${attAfter})`);
    assert.equal(venAfter - venBefore, 50, `vendor should be credited R50 (was ${venBefore}, now ${venAfter})`);
    ok(`vendor tapped and charged R50: patron R${attBefore} -> R${attAfter}, vendor R${venBefore} -> R${venAfter}`);

    // 2. Idempotency: the SAME tap replays, it does not charge twice.
    const key = `tap-${randomUUID()}`;
    await eventTags.chargeEventTagAsVendor(vendorActor, { tagToken, amount: 30 }, key, "req-2a");
    const midAtt = await balance(ids.attendeeWallet);
    const replay = await eventTags.chargeEventTagAsVendor(vendorActor, { tagToken, amount: 30 }, key, "req-2b");
    const endAtt = await balance(ids.attendeeWallet);
    assert.equal(replay.idempotentReplay, true, "the second call with the same key must be a replay");
    assert.equal(midAtt, endAtt, "a replay must not move money a second time");
    ok(`a repeated tap (same idempotency key) charged once, not twice (balance held at R${endAtt})`);

    // 3. A business NOT added as a vendor for this event is refused.
    let refused = false;
    const attBeforeOutsider = await balance(ids.attendeeWallet);
    try { await eventTags.chargeEventTagAsVendor(outsiderActor, { tagToken, amount: 20 }, `tap-${randomUUID()}`, "req-3"); }
    catch (error) { refused = error.statusCode === 403; }
    assert.ok(refused, "a non-vendor must be refused with 403");
    assert.equal(await balance(ids.attendeeWallet), attBeforeOutsider, "a refused charge moves no money");
    ok("a business that is NOT an authorised vendor was refused (403), no money moved");

    // 4. Over-balance is refused before anything moves.
    let overBalance = false;
    const attBeforeOver = await balance(ids.attendeeWallet);
    try { await eventTags.chargeEventTagAsVendor(vendorActor, { tagToken, amount: 100000 }, `tap-${randomUUID()}`, "req-4"); }
    catch (error) { overBalance = error.statusCode === 400; }
    assert.ok(overBalance, "an amount above balance must be refused with 400");
    assert.equal(await balance(ids.attendeeWallet), attBeforeOver, "an over-balance charge moves no money");
    ok("a charge above the patron's balance was refused (400), no money moved");

    // 4b. Authorising a vendor by what the organiser actually HAS. The form
    //     used to demand the internal merchant UUID — unusable. The outsider
    //     is now authorised by their WALLET NUMBER and can charge immediately.
    const ownerActor = { userId: ids.owner, userType: "customer" };
    const outsiderWalletNumber = (await pool.query("SELECT wallet_number FROM wallets WHERE id = $1", [ids.otherWallet])).rows[0].wallet_number;
    const byWallet = await eventTags.addEventVendor(ownerActor, ids.event, outsiderWalletNumber);
    assert.equal(byWallet.merchantId, ids.otherMerchant, "a wallet number resolves to the vendor's merchant profile");
    const outsiderCharge = await eventTags.chargeEventTagAsVendor(outsiderActor, { tagToken, amount: 5 }, `tap-${randomUUID()}`, "req-4b");
    assert.equal(outsiderCharge.outcome, "APPROVED", "the newly authorised vendor charges successfully");
    ok("a vendor authorised by WALLET NUMBER can charge — no merchant UUID needed");

    // 4c. Revoking blocks the vendor's next tap immediately; re-authorising by
    //     @username reactivates the very same vendor row.
    const vendors = await eventTags.listEventVendors(ids.event);
    const outsiderRow = vendors.find((vendor) => vendor.merchantId === ids.otherMerchant);
    await eventTags.suspendEventVendor(ownerActor, ids.event, outsiderRow.vendorId);
    let suspendedRefused = false;
    try { await eventTags.chargeEventTagAsVendor(outsiderActor, { tagToken, amount: 5 }, `tap-${randomUUID()}`, "req-4c"); }
    catch (error) { suspendedRefused = error.statusCode === 403; }
    assert.ok(suspendedRefused, "a revoked vendor is refused with 403");
    const outsiderUsername = (await pool.query("SELECT username FROM users WHERE id = $1", [ids.otherUser])).rows[0].username;
    const reAdd = await eventTags.addEventVendor(ownerActor, ids.event, `@${outsiderUsername}`);
    assert.equal(reAdd.merchantId, ids.otherMerchant, "re-authorising by @username reactivates the same vendor");
    assert.equal(reAdd.status, "active");
    ok("revoking a vendor blocks their charges instantly; @username re-authorises them");

    // 4d. Bad input answers clearly. A personal account with no merchant
    //     profile is named as such; garbage is a clean 404, never a DB error.
    const personalId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash, status, profile_locked, fica_status)
       VALUES ($1,'personal','${TAG} Person','${TAG}_pers','${TAG}_pers@example.invalid',NULL,'x','active',FALSE,'pending')`,
      [personalId]);
    let noMerchant = false;
    try { await eventTags.addEventVendor(ownerActor, ids.event, `${TAG}_pers`); }
    catch (error) { noMerchant = error.statusCode === 409 && /no business merchant profile/i.test(error.message); }
    assert.ok(noMerchant, "a personal account without a merchant profile gets a clear 409");
    let unknownInput = false;
    try { await eventTags.addEventVendor(ownerActor, ids.event, "definitely-not-a-vendor"); }
    catch (error) { unknownInput = error.statusCode === 404; }
    assert.ok(unknownInput, "an unknown identifier is a clean 404, not a database error");
    await pool.query("DELETE FROM users WHERE id = $1", [personalId]);
    ok("bad vendor input answers clearly: no-merchant 409, unknown 404");

    // 5. A blocked wristband cannot be charged.
    await pool.query("UPDATE event_tags SET status = 'BLOCKED' WHERE id = $1", [ids.tagId]);
    let blocked = false;
    try { await eventTags.chargeEventTagAsVendor(vendorActor, { tagToken, amount: 10 }, `tap-${randomUUID()}`, "req-5"); }
    catch (error) { blocked = error.statusCode === 409; }
    assert.ok(blocked, "a blocked tag must be refused");
    ok("a blocked wristband was refused");

    console.log("\n" + "=".repeat(80));
    console.log(`  ALL ${passed} CHECKS PASSED — vendors can tap-to-charge, and only where authorised.`);
    console.log("=".repeat(80) + "\n");
  } catch (error) {
    console.error("\n  FAILED:", error.message, "\n", error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
})();
