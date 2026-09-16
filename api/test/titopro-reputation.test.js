"use strict";

// RATING A JOB, REPORTING A LISTING, AND TAKING ONE DOWN.
//
// What is defended here:
//
//   1. only the customer who paid rates the job, only after confirming it,
//      and only once - and the "once" survives a double-tapped button;
//   2. a professional cannot manufacture their own reputation;
//   3. a rating cannot be edited, by anybody, ever;
//   4. a report never takes a listing down by itself;
//   5. the same listing cannot be reported into the ground by one account;
//   6. AN ADMIN TAKEDOWN CANNOT BE UNDONE BY THE PERSON TAKEN DOWN. This was
//      a live hole: publishProfile checked FICA, vetting and account standing,
//      every one of which still passes for somebody suspended for bad work,
//      so pressing "Go live" put them straight back in front of customers;
//   7. approving a listing does NOT publish it - nothing an operator does can
//      put a listing live that would not have been allowed there anyway;
//   8. removal is not a delete;
//   9. a withdrawn rating leaves the average, and a hidden comment does not
//      take its star with it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const profiles = require("../src/services/titopro-profile-service");
const jobs = require("../src/services/titopro-service");
const reputation = require("../src/services/titopro-reputation-service");
const vetting = require("../src/services/titopro-vetting-service");
const reference = require("../src/config/titopro-reference");
const pricing = require("../src/services/pricing-service");

let sequence = 0;
async function makeUser(label = "Thandi") {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,$2,$3,$4,$5,'personal','active','verified','x')`,
    [id, `${label} Ndlovu`, `rep_${tag}`, `rep_${tag}@test.local`, `+2782${tag}`.slice(0, 13)]);
  return { userId: id, ipAddress: "127.0.0.1", userAgent: "node-test" };
}

async function makeAdmin() {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Moderator',$2,$3,'super_admin','x','active')`,
    [id, `radm_${tag}`, `radm_${tag}@titopay.test`]);
  return { userId: id, userType: "admin", ipAddress: "127.0.0.1", userAgent: "node-test" };
}

async function makeListedProfessional(profession = "plumber") {
  const actor = await makeUser("Sipho");
  await profiles.saveProfile(actor, {
    professions: [profession], headline: "Available in Soweto", suburb: "Pimville", city: "Soweto"
  });
  const admin = await makeAdmin();
  for (const check of reference.requiredChecksFor(profession)) {
    await vetting.recordCheck(admin, actor.userId, {
      checkType: check, status: "cleared", evidenceReference: `REF-${check}`,
      note: "Cleared for the purposes of this fixture."
    });
  }
  await profiles.publishProfile(actor);
  return actor;
}

// A finished job, which is the only kind that can be rated.
async function confirmedJob(profession = "plumber") {
  const customer = await makeUser("Thandi");
  const professional = await makeListedProfessional(profession);
  const job = await jobs.createJob(customer, {
    profession, professionalUserId: professional.userId,
    title: "Blocked kitchen drain", suburb: "Pimville", city: "Soweto"
  });
  await jobs.quoteJob(professional, job.id, { amount: 850 });
  await jobs.acceptQuote(customer, job.id);
  await jobs.startJob(professional, job.id);
  await jobs.markWorkDone(professional, job.id);
  await jobs.confirmJob(customer, job.id);
  return { customer, professional, job };
}

test.before(async () => {
  await jobs.ensureTitoProSchema();
  await profiles.ensureProfileSchema();
  await vetting.ensureVettingSchema();
  await reputation.ensureReputationSchema();
  await pricing.applyTitoProPricingOnce();
});

/* ----------------------------------------------------------------- ratings */

test("THE CUSTOMER RATES THE JOB THEY PAID FOR, AND IT SHOWS ON THE LISTING", async () => {
  const { customer, professional, job } = await confirmedJob();

  const rating = await reputation.rateJob(customer, job.id, { stars: 5, comment: "On time, cleaned up after himself." });
  assert.equal(rating.stars, 5);
  assert.equal(rating.word, "Excellent");
  assert.equal(rating.comment, "On time, cleaned up after himself.");

  const summary = await reputation.ratingSummary(professional.userId);
  assert.deepEqual(summary, { count: 1, average: 5 });

  const page = await profiles.publicProfile(professional.userId);
  assert.equal(page.rating, 5);
  assert.equal(page.ratingCount, 1);
  assert.equal(page.reviews.length, 1);
  // A first name and nothing else. A full surname beside a review, on a page
  // about a tradesman who has been inside the reviewer's house, is a safety
  // question rather than a privacy one.
  assert.equal(page.reviews[0].by, "Thandi");
  assert.ok(!JSON.stringify(page.reviews[0]).includes("Ndlovu"), "and never the surname");
});

test("A JOB CANNOT BE RATED BEFORE THE CUSTOMER SAYS IT IS FINISHED", async () => {
  const customer = await makeUser("Thandi");
  const professional = await makeListedProfessional();
  const job = await jobs.createJob(customer, {
    profession: "plumber", professionalUserId: professional.userId, title: "Leaking tap"
  });
  await jobs.quoteJob(professional, job.id, { amount: 400 });
  await jobs.acceptQuote(customer, job.id);
  await jobs.startJob(professional, job.id);
  await jobs.markWorkDone(professional, job.id);

  // work_done is the professional SAYING it is finished. The customer has not
  // agreed yet, and a score at this point is one the professional can chase.
  await assert.rejects(() => reputation.rateJob(customer, job.id, { stars: 5 }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.details?.code, "job_not_confirmed");
    return true;
  });

  await jobs.confirmJob(customer, job.id);
  assert.equal((await reputation.rateJob(customer, job.id, { stars: 4 })).stars, 4);
});

test("A PROFESSIONAL CANNOT RATE THEIR OWN JOB", async () => {
  const { professional, job } = await confirmedJob();
  await assert.rejects(() => reputation.rateJob(professional, job.id, { stars: 5 }), (error) => {
    assert.equal(error.statusCode, 403);
    assert.match(error.message, /Only the customer/i);
    return true;
  });
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 0, average: null });
});

test("A STRANGER CANNOT RATE A JOB THEY WERE NOT ON, AND IS NOT TOLD IT EXISTS", async () => {
  const { job } = await confirmedJob();
  const stranger = await makeUser("Bongani");
  await assert.rejects(() => reputation.rateJob(stranger, job.id, { stars: 1 }), (error) => {
    // 404 rather than 403: whether a particular job exists is not a
    // stranger's business.
    assert.equal(error.statusCode, 404);
    assert.equal(error.message, "Job not found");
    return true;
  });
});

test("A RATING IS WRITTEN ONCE AND CANNOT BE REWRITTEN", async () => {
  const { customer, professional, job } = await confirmedJob();
  await reputation.rateJob(customer, job.id, { stars: 1, comment: "Never came back to finish." });

  await assert.rejects(() => reputation.rateJob(customer, job.id, { stars: 5 }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.details?.code, "already_rated");
    return true;
  });
  // A score that can be rewritten is a score that can be traded: "change it
  // to five and I'll knock R200 off".
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 1, average: 1 });
});

test("A DOUBLE-TAPPED BUTTON DOES NOT LEAVE TWO RATINGS", async () => {
  const { customer, professional, job } = await confirmedJob();
  // Both start before either finishes, so the read-then-insert in the service
  // cannot be what saves this. The unique index is.
  const results = await Promise.allSettled([
    reputation.rateJob(customer, job.id, { stars: 5 }),
    reputation.rateJob(customer, job.id, { stars: 5 })
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 1, average: 5 });
});

test("ONLY ONE TO FIVE STARS", async () => {
  const { customer, job } = await confirmedJob();
  for (const stars of [0, 6, -1, 4.5, "five", null]) {
    await assert.rejects(() => reputation.rateJob(customer, job.id, { stars }),
      /between 1 and 5 stars/i, `stars=${stars}`);
  }
});

test("THE AVERAGE IS ONE DECIMAL, AND A NEW PROFESSIONAL IS NOT ZERO", async () => {
  const professional = await makeListedProfessional();
  // Nobody has rated them. NULL, not 0 - "0.0" on a browse screen reads as
  // terrible rather than as new, and that decides whether they ever get a
  // first job.
  const [listed] = await profiles.searchProfessionals({ profession: "plumber", city: "Soweto" })
    .then((rows) => rows.filter((row) => row.userId === professional.userId));
  assert.equal(listed.rating, null);
  assert.equal(listed.ratingCount, 0);

  for (const stars of [5, 4, 4]) {
    const customer = await makeUser("Thandi");
    const job = await jobs.createJob(customer, {
      profession: "plumber", professionalUserId: professional.userId, title: "Geyser"
    });
    await jobs.quoteJob(professional, job.id, { amount: 500 });
    await jobs.acceptQuote(customer, job.id);
    await jobs.startJob(professional, job.id);
    await jobs.markWorkDone(professional, job.id);
    await jobs.confirmJob(customer, job.id);
    await reputation.rateJob(customer, job.id, { stars });
  }
  // 13/3 = 4.333... One decimal. Two would claim a precision three ratings
  // do not have.
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 3, average: 4.3 });
});

/* ----------------------------------------------------------------- reports */

test("A CUSTOMER REPORTS A LISTING, AND NOTHING HAPPENS TO IT AUTOMATICALLY", async () => {
  const { customer, professional } = await confirmedJob();

  const report = await reputation.reportListing(customer, professional.userId, {
    category: "off_platform_payment",
    detail: "He asked me to EFT him directly instead of paying in the app."
  });
  assert.match(report.reference, /^TP-R-[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(report.status, "open");
  assert.equal(report.urgent, true, "being asked to pay outside TitoPay is read first");

  // THE LISTING IS STILL LIVE. Three reports and you are gone is the most
  // tempting automation in a marketplace and it hands every competitor a
  // delete button.
  const still = await profiles.publicProfile(professional.userId);
  assert.equal(still.userId, professional.userId);

  const queue = await reputation.reportQueue({ status: "open" });
  const mine = queue.find((row) => row.reference === report.reference);
  assert.equal(mine.hadJob, true, "and the operator is told this reporter really did hire them");
  assert.equal(mine.professionalUserId, professional.userId);
});

test("SOMEBODY WHO NEVER HIRED THEM CAN STILL REPORT, AND IS MARKED AS SUCH", async () => {
  const professional = await makeListedProfessional();
  const passerby = await makeUser("Lerato");
  // The worst thing a professional can do on a marketplace - "pay me cash
  // instead" - happens BEFORE any job exists. A rule that only customers may
  // report would make that report impossible to file.
  const report = await reputation.reportListing(passerby, professional.userId, {
    category: "impersonation", detail: "The photo on this listing is not the person who arrived."
  });
  const queue = await reputation.reportQueue({ status: "open" });
  assert.equal(queue.find((row) => row.reference === report.reference).hadJob, false);
});

test("THE SAME LISTING CANNOT BE REPORTED TWICE WHILE THE FIRST IS OPEN", async () => {
  const professional = await makeListedProfessional();
  const customer = await makeUser("Thandi");
  await reputation.reportListing(customer, professional.userId, {
    category: "no_show", detail: "He accepted and never came."
  });
  await assert.rejects(() => reputation.reportListing(customer, professional.userId, {
    category: "poor_work", detail: "And he still has not come."
  }), (error) => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.details?.code, "report_already_open");
    return true;
  });
});

test("NOBODY REPORTS THEMSELVES, AND A REPORT NEEDS WORDS", async () => {
  const professional = await makeListedProfessional();
  await assert.rejects(() => reputation.reportListing(professional, professional.userId, {
    category: "other", detail: "Testing the form."
  }), /cannot report your own listing/i);

  const customer = await makeUser("Thandi");
  await assert.rejects(() => reputation.reportListing(customer, professional.userId, {
    category: "other", detail: "bad"
  }), /What happened is required/i);
  await assert.rejects(() => reputation.reportListing(customer, professional.userId, {
    category: "made_up_reason", detail: "Something happened here."
  }), /Reason is invalid/i);
});

/* -------------------------------------------------------------- moderation */

test("AN ADMIN SUSPENDS A LISTING AND THE PROFESSIONAL CANNOT PUT IT BACK", async () => {
  const professional = await makeListedProfessional();
  const customer = await makeUser("Thandi");
  const admin = await makeAdmin();
  const report = await reputation.reportListing(customer, professional.userId, {
    category: "poor_work", detail: "Left the bathroom flooded and drove off."
  });

  const { profile, reportsClosed } = await profiles.moderateListing(admin, professional.userId, {
    action: "suspend", reason: "Two complaints of abandoning work. Reported by a verified customer."
  });
  assert.equal(profile.adminAction, "suspended");
  assert.equal(profile.statusLabel, "Suspended by TitoPay");
  assert.equal(reportsClosed, 1, "and the report that prompted it is closed with the decision");

  // Off the browse screen entirely.
  const found = await profiles.searchProfessionals({ profession: "plumber" });
  assert.ok(!found.some((row) => row.userId === professional.userId));
  await assert.rejects(() => profiles.publicProfile(professional.userId), /not currently listed/i);

  // THE HOLE THIS CLOSES. FICA, vetting and account standing all still pass
  // for somebody suspended for bad work, so before the admin_action gate every
  // other check here waved them straight back through.
  await assert.rejects(() => profiles.publishProfile(professional), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details?.code, "listing_suspended");
    return true;
  });

  // And the reason the operator wrote never reaches them.
  const { profile: mine } = await profiles.getMyProfile(professional);
  assert.equal(mine.adminAction, "suspended");
  assert.ok(!JSON.stringify(mine).includes("Two complaints"),
    "the operator's words name the customer who complained and stay internal");
  const closed = (await reputation.reportsForProfessional(professional.userId))
    .find((row) => row.reference === report.reference);
  assert.equal(closed.status, "actioned");
  assert.equal(closed.outcome, "suspend");
});

test("APPROVING HANDS THE LISTING BACK - IT DOES NOT PUT IT LIVE", async () => {
  const professional = await makeListedProfessional();
  const admin = await makeAdmin();
  await profiles.moderateListing(admin, professional.userId, {
    action: "suspend", reason: "Under review after a complaint."
  });

  const { profile } = await profiles.moderateListing(admin, professional.userId, {
    action: "approve", reason: "Looked at the photographs. The work was finished."
  });
  assert.equal(profile.adminAction, null);
  // NOT 'published'. Nothing an operator does on this screen can put a listing
  // in front of customers that would not have been allowed there anyway, so a
  // mis-click here cannot expose an unverified person.
  assert.equal(profile.status, "paused");
  const found = await profiles.searchProfessionals({ profession: "plumber" });
  assert.ok(!found.some((row) => row.userId === professional.userId));

  // The professional puts it back themselves, through the usual gates.
  assert.equal((await profiles.publishProfile(professional)).status, "published");
});

test("APPROVING A LIVE LISTING DOES NOT KNOCK IT OFFLINE", async () => {
  const professional = await makeListedProfessional();
  const customer = await makeUser("Thandi");
  const admin = await makeAdmin();
  await reputation.reportListing(customer, professional.userId, {
    category: "overcharged", detail: "He charged more than the quote said."
  });

  const { profile, reportsClosed } = await profiles.moderateListing(admin, professional.userId, {
    action: "approve", reason: "The re-quote was accepted in the app. Nothing in it."
  });
  assert.equal(profile.status, "published", "an approval is not a reason to take somebody down");
  assert.equal(reportsClosed, 1);
  // Nothing in it means DISMISSED, not actioned. A queue where clearing a row
  // and acting on one look the same is a queue nobody can audit.
  const [closed] = await reputation.reportsForProfessional(professional.userId);
  assert.equal(closed.status, "dismissed");
});

test("REMOVAL IS NOT A DELETE, AND IT DOES NOT COME BACK", async () => {
  const { customer, professional, job } = await confirmedJob();
  await reputation.rateJob(customer, job.id, { stars: 1, comment: "Dangerous work." });
  const admin = await makeAdmin();

  const { profile } = await profiles.moderateListing(admin, professional.userId, {
    action: "remove", reason: "Unsafe electrical work confirmed by a second professional."
  });
  assert.equal(profile.adminAction, "removed");
  assert.equal(profile.statusLabel, "Removed by TitoPay");

  await assert.rejects(() => profiles.publishProfile(professional), (error) => {
    assert.equal(error.details?.code, "listing_removed");
    assert.match(error.message, /removed by TitoPay/i);
    return true;
  });

  // EVERY ROW IS STILL THERE. A takedown is the thing somebody asks about six
  // months later and "we deleted it" is not an answer.
  const { rows: stillThere } = await pool.query(
    "SELECT status, admin_action, admin_reason FROM titopro_profiles WHERE user_id = $1", [professional.userId]);
  assert.equal(stillThere.length, 1);
  assert.equal(stillThere[0].admin_reason, "Unsafe electrical work confirmed by a second professional.");
  const { rows: ratings } = await pool.query(
    "SELECT id FROM titopro_ratings WHERE professional_user_id = $1", [professional.userId]);
  assert.equal(ratings.length, 1, "and so is what the customer said");

  // An operator can find it again.
  const listings = await profiles.moderationListings({ state: "actioned" });
  assert.ok(listings.some((row) => row.userId === professional.userId && row.adminAction === "removed"));
});

test("MODERATING A LISTING REFUSES TO HAPPEN WITHOUT A REASON", async () => {
  const professional = await makeListedProfessional();
  const admin = await makeAdmin();
  for (const action of ["approve", "suspend", "remove"]) {
    await assert.rejects(() => profiles.moderateListing(admin, professional.userId, { action }),
      /Reason is required/i, action);
  }
  await assert.rejects(() => profiles.moderateListing(admin, professional.userId, {
    action: "delete", reason: "Trying it on."
  }), /approve, suspend or remove/i);
});

test("A HIDDEN COMMENT KEEPS ITS STAR; A WITHDRAWN RATING LEAVES THE AVERAGE", async () => {
  const { customer, professional, job } = await confirmedJob();
  const admin = await makeAdmin();
  await reputation.rateJob(customer, job.id, { stars: 1, comment: "This man is a thief." });
  const [review] = await reputation.ratingsForProfessional(professional.userId);

  // TitoPay cannot stand behind an accusation of theft it has not tested. The
  // words come down; the customer's one star does not, because a real customer
  // who was genuinely let down still gets to say so.
  await reputation.moderateRating(admin, review.id, {
    action: "hide_comment", reason: "Unverified accusation of a crime against a named person."
  });
  const [afterHide] = await reputation.ratingsForProfessional(professional.userId);
  assert.equal(afterHide.comment, null);
  assert.equal(afterHide.commentHidden, true);
  assert.equal(afterHide.stars, 1);
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 1, average: 1 });

  await reputation.moderateRating(admin, review.id, {
    action: "withdraw", reason: "Reporter is a competing plumber; no job was ever done."
  });
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 0, average: null });
  assert.equal((await reputation.ratingsForProfessional(professional.userId)).length, 0);
  // Withdrawn, not deleted. The row is the evidence for the decision.
  const { rows } = await pool.query("SELECT withdrawn_reason FROM titopro_ratings WHERE id = $1", [review.id]);
  assert.match(rows[0].withdrawn_reason, /competing plumber/);

  await reputation.moderateRating(admin, review.id, { action: "restore", reason: "Confirmed the job was real after all." });
  assert.deepEqual(await reputation.ratingSummary(professional.userId), { count: 1, average: 1 });
});

test("NEITHER SIDE OF A JOB CAN MODERATE A RATING", async () => {
  const { customer, professional, job } = await confirmedJob();
  await reputation.rateJob(customer, job.id, { stars: 2 });
  const [review] = await reputation.ratingsForProfessional(professional.userId);
  // No admin id on the actor. moderateRating is reached only from an admin
  // route, and refuses anyway rather than trusting that to stay true.
  for (const actor of [{ userId: null }, {}]) {
    await assert.rejects(() => reputation.moderateRating(actor, review.id, {
      action: "withdraw", reason: "I do not like it."
    }), /Authentication required/i);
  }
});

test("CLOSING A REPORT IS A DECISION, SO IT NEEDS A NOTE", async () => {
  const professional = await makeListedProfessional();
  const customer = await makeUser("Thandi");
  const admin = await makeAdmin();
  const report = await reputation.reportListing(customer, professional.userId, {
    category: "no_show", detail: "Waited the whole morning."
  });

  await assert.rejects(() => reputation.resolveReport(admin, report.id, { status: "dismissed" }),
    /What you decided is required/i);

  const reviewing = await reputation.resolveReport(admin, report.id, { status: "reviewing" });
  assert.equal(reviewing.status, "reviewing");
  const dismissed = await reputation.resolveReport(admin, report.id, {
    status: "dismissed", note: "Customer confirmed he arrived the next day."
  });
  assert.equal(dismissed.status, "dismissed");
  assert.equal(dismissed.resolutionNote, "Customer confirmed he arrived the next day.");

  // And with the first one closed, the same customer may report again.
  const second = await reputation.reportListing(customer, professional.userId, {
    category: "poor_work", detail: "The second visit was no better."
  });
  assert.equal(second.status, "open");
});

test("THE QUEUE PUTS THE DANGEROUS ONES FIRST", async () => {
  const admin = await makeAdmin();
  // Clear the queue this test reasons about, so it measures ordering rather
  // than whatever the tests above left behind.
  await pool.query("UPDATE titopro_reports SET status = 'dismissed' WHERE status IN ('open','reviewing')");

  const slow = await makeListedProfessional();
  const dangerous = await makeListedProfessional();
  const first = await makeUser("Thandi");
  const second = await makeUser("Lerato");
  await reputation.reportListing(first, slow.userId, { category: "no_show", detail: "Did not arrive on Tuesday." });
  await reputation.reportListing(second, dangerous.userId, { category: "harassment", detail: "He would not leave the property." });

  const queue = await reputation.reportQueue({ status: "open" });
  assert.equal(queue.length, 2);
  // Raised second, read first. A report about somebody being threatened does
  // not wait behind a fortnight of "he was late".
  assert.equal(queue[0].professionalUserId, dangerous.userId);
  assert.equal(queue[0].urgent, true);
  assert.equal(queue[1].professionalUserId, slow.userId);
  assert.equal(admin.userType, "admin");
});

test("ONE ACCOUNT CANNOT FLOOD THE QUEUE", async () => {
  const reporter = await makeUser("Bongani");
  for (let i = 0; i < reputation.REPORTS_PER_DAY; i += 1) {
    const professional = await makeListedProfessional();
    await reputation.reportListing(reporter, professional.userId, {
      category: "other", detail: `Complaint number ${i + 1} from the same account.`
    });
  }
  const oneMore = await makeListedProfessional();
  await assert.rejects(() => reputation.reportListing(reporter, oneMore.userId, {
    category: "other", detail: "And one more for luck."
  }), (error) => {
    assert.equal(error.statusCode, 429);
    assert.equal(error.details?.code, "report_limit");
    return true;
  });
});

test("THE SCHEMA GUARD REBUILDS BOTH TABLES", async () => {
  await pool.query("DROP TABLE IF EXISTS titopro_ratings CASCADE");
  await pool.query("DROP TABLE IF EXISTS titopro_reports CASCADE");
  reputation.resetReputationSchemaCache();
  await reputation.ensureReputationSchema();
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('titopro_ratings','titopro_reports') ORDER BY table_name`);
  assert.deepEqual(rows.map((row) => row.table_name), ["titopro_ratings", "titopro_reports"]);
});

test.after(async () => {
  await pool.end();
});
