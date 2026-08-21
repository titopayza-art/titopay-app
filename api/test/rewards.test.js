"use strict";

// Rewards publications (build 90): marketing drafts an offer, an approval
// seat puts it live, the customer feed serves only live, in-window,
// audience-matched publications. Behavioral against the real database.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "rewards-test-access-secret-32-bytes-okay!";
process.env.JWT_REFRESH_SECRET ||= "rewards-test-refresh-secret-32-bytes-ok!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const { hashPassword } = require("../src/lib/passwords");
const {
  listRewardsForCustomer,
  markRewardsSeen,
  recordCouponCopy,
  createPublication,
  approvePublication,
  rejectPublication,
  withdrawPublication,
  listPublicationsForAdmin
} = require("../src/services/rewards-service");

const stamp = Date.now().toString(36);
const meta = { ipAddress: "127.0.0.1", userAgent: "node-test" };

async function makeCustomer(accountType = "personal") {
  const id = crypto.randomUUID();
  const username = `rw_${stamp}_${crypto.randomBytes(3).toString("hex")}`;
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, phone, password_hash)
     VALUES ($1,$2,'Rewards Test',$3,$4,$5,$6)`,
    [id, accountType, username, `${username}@t.local`,
     `+2773${Math.floor(1000000 + Math.random() * 8999999)}`, await hashPassword("Str0ngPass!2026")]
  );
  return { id, username, accountType };
}

async function makeAdmin() {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     VALUES ($1,'Rewards Admin',$2,$3,'super_admin',$4)`,
    [id, `rwadmin_${stamp}_${crypto.randomBytes(3).toString("hex")}`,
     `rwadmin_${stamp}_${crypto.randomBytes(3).toString("hex")}@t.local`, await hashPassword("Str0ngPass!2026")]
  );
  return id;
}

async function cleanupPublications(ids) {
  for (const id of ids) {
    await pool.query("DELETE FROM reward_publications WHERE id=$1", [id]).catch(() => {});
  }
}

async function cleanupUser(userId) {
  await pool.query("DELETE FROM reward_publication_reads WHERE user_id=$1", [userId]).catch(() => {});
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
}

async function cleanupAdmin(adminId) {
  await pool.query("DELETE FROM admin_users WHERE id=$1", [adminId]);
}

function findMine(feed, publicationId) {
  return (feed.items || []).find((item) => item.id === publicationId) || null;
}

test("invisible until approved; seen tracking; withdraw hides instantly", async () => {
  const customer = await makeCustomer();
  const admin = await makeAdmin();
  const created = [];
  try {
    const publication = await createPublication(
      { kind: "promotion", title: "Spring launch", body: "A promotion customers should only see after approval.", audience: "both" },
      admin, meta
    );
    created.push(publication.id);
    assert.equal(publication.status, "pending_approval");

    let feed = await listRewardsForCustomer(customer.id, "personal");
    assert.equal(findMine(feed, publication.id), null, "pending publication must not reach the feed");

    const live = await approvePublication(publication.id, admin, "ceo", meta);
    assert.equal(live.status, "live");
    // Decide-once: a second approval of the same publication must refuse.
    await assert.rejects(() => approvePublication(publication.id, admin, "ceo", meta), /not awaiting approval/i);

    feed = await listRewardsForCustomer(customer.id, "personal");
    const mine = findMine(feed, publication.id);
    assert.ok(mine, "live publication reaches the feed");
    assert.equal(mine.seen, false);

    await markRewardsSeen(customer.id, "personal");
    feed = await listRewardsForCustomer(customer.id, "personal");
    assert.equal(findMine(feed, publication.id).seen, true, "seen after opening the screen");

    await withdrawPublication(publication.id, admin, "typo in the offer", meta);
    feed = await listRewardsForCustomer(customer.id, "personal");
    assert.equal(findMine(feed, publication.id), null, "withdrawn publication disappears immediately");
    // The kill switch is also decide-once.
    await assert.rejects(() => withdrawPublication(publication.id, admin, "", meta), /not live/i);
  } finally {
    await cleanupPublications(created);
    await cleanupUser(customer.id);
    await cleanupAdmin(admin);
  }
});

test("audience targeting and expiry window filter the feed", async () => {
  const personal = await makeCustomer("personal");
  const business = await makeCustomer("business");
  const admin = await makeAdmin();
  const created = [];
  try {
    const businessOnly = await createPublication(
      { kind: "notice", title: "Business fee update", body: "A business-only publication for the audience filter." },
      admin, { ...meta }
    ).then((p) => approvePublication(p.id, admin, "ceo", meta));
    created.push(businessOnly.id);
    await pool.query("UPDATE reward_publications SET audience='business' WHERE id=$1", [businessOnly.id]);

    assert.equal(findMine(await listRewardsForCustomer(personal.id, "personal"), businessOnly.id), null,
      "business-only offer hidden from personal customers");
    assert.ok(findMine(await listRewardsForCustomer(business.id, "business"), businessOnly.id),
      "business-only offer served to business customers");

    const expiring = await createPublication(
      { kind: "discount", title: "Weekend discount", body: "A discount that is about to end for the window filter." },
      admin, meta
    ).then((p) => approvePublication(p.id, admin, "coo", meta));
    created.push(expiring.id);
    assert.ok(findMine(await listRewardsForCustomer(personal.id, "personal"), expiring.id), "in-window offer served");
    await pool.query("UPDATE reward_publications SET ends_at = NOW() - INTERVAL '1 minute' WHERE id=$1", [expiring.id]);
    assert.equal(findMine(await listRewardsForCustomer(personal.id, "personal"), expiring.id), null,
      "expired offer disappears with no admin action");
    const adminRows = await listPublicationsForAdmin();
    assert.equal(adminRows.find((row) => row.id === expiring.id).liveState, "ended",
      "admin queue names the expired state");
  } finally {
    await cleanupPublications(created);
    await cleanupUser(personal.id);
    await cleanupUser(business.id);
    await cleanupAdmin(admin);
  }
});

test("coupon rules, engagement counts, rejection needs a reason", async () => {
  const customer = await makeCustomer();
  const admin = await makeAdmin();
  const created = [];
  try {
    await assert.rejects(
      () => createPublication({ kind: "coupon", title: "Code missing", body: "A coupon without a code must refuse." }, admin, meta),
      /coupon code is required/i
    );
    const coupon = await createPublication(
      { kind: "coupon", title: "R25 off airtime", body: "Use this code at checkout for R25 off.", couponCode: "spring25" },
      admin, meta
    ).then((p) => approvePublication(p.id, admin, "senior_marketing", meta));
    created.push(coupon.id);
    assert.equal(coupon.coupon_code, "SPRING25", "codes are stored uppercase");

    await markRewardsSeen(customer.id, "personal");
    await recordCouponCopy(coupon.id);
    const adminRow = (await listPublicationsForAdmin()).find((row) => row.id === coupon.id);
    assert.equal(adminRow.copyCount, 1, "copy tap counted");
    assert.ok(adminRow.viewCount >= 1, "seen counted as a view");

    const pending = await createPublication(
      { kind: "advert", title: "New feature advert", body: "An advert destined for rejection in this test." },
      admin, meta
    );
    created.push(pending.id);
    await assert.rejects(() => rejectPublication(pending.id, admin, "", meta), /reason is required/i);
    const rejected = await rejectPublication(pending.id, admin, "Off-brand wording", meta);
    assert.equal(rejected.status, "rejected");
    assert.equal(findMine(await listRewardsForCustomer(customer.id, "personal"), pending.id), null);
  } finally {
    await cleanupPublications(created);
    await cleanupUser(customer.id);
    await cleanupAdmin(admin);
  }
});
