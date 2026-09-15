"use strict";

// TITOPRO: THE JOB RECORD.
//
// A plumber, a painter, a cleaner and a bookkeeper are all hired
// through TitoPro, and only the first of those is a calendar booking. What is
// defended here is the reasoning that follows from that:
//
//   1. a job cannot skip a step - nothing gets confirmed without a price
//      somebody agreed to;
//   2. work that runs over days is REFUSED a diary slot, rather than being
//      given one that will be a lie by Tuesday;
//   3. an electrician cannot close a job without a Certificate of Compliance;
//   4. the fee is the one the customer was told: R5 from them, R20 + 1,5% from
//      the professional, read from the pricing engine and not recalculated;
//   5. a job is between two people and nobody else can read it;
//   6. scope changing on site goes BACK to the customer.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../src/db/pool");
const pro = require("../src/services/titopro-service");
const reference = require("../src/config/titopro-reference");
const profiles = require("../src/services/titopro-profile-service");
const vetting = require("../src/services/titopro-vetting-service");
const pricing = require("../src/services/pricing-service");

let sequence = 0;
async function makeUser(label) {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO users (id, full_name, username, email, phone, account_type, status, fica_status, password_hash)
     VALUES ($1,$2,$3,$4,$5,'personal','active','verified','x')`,
    [id, label, `${label.toLowerCase()}_${tag}`, `${label.toLowerCase()}_${tag}@test.local`, `+2782${tag}`.slice(0, 13)]);
  return { userId: id, ipAddress: "127.0.0.1", userAgent: "node-test" };
}

// A job can only be sent to somebody who is LISTED, and listing requires FICA
// verification - see titopro-listing-fica.test.js. So a professional in these
// tests is a published one; a bare user id would now be refused, which is the
// gate doing its job rather than a fixture problem.
async function makeListedProfessional(profession) {
  const actor = await makeUser("Sipho");
  await profiles.saveProfile(actor, {
    professions: [profession], headline: "Available in Soweto", suburb: "Pimville", city: "Soweto"
  });
  // An enhanced profession - a cleaner, a tutor, a locksmith -
  // also needs background checks cleared before it can be listed, on top of
  // FICA. See titopro-vetting.test.js for why, and for the gate itself.
  const admin = await makeComplianceAdmin();
  for (const check of reference.requiredChecksFor(profession)) {
    await vetting.recordCheck(admin, actor.userId, {
      checkType: check, status: "cleared",
      evidenceReference: `REF-${check}-TEST`,
      note: "Cleared for the purposes of this fixture."
    });
  }
  await profiles.publishProfile(actor);
  return actor;
}

async function makeComplianceAdmin() {
  const id = uuidv4();
  sequence += 1;
  const tag = `${String(Date.now()).slice(-6)}${sequence}`;
  await pool.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash, status)
     VALUES ($1,'Compliance',$2,$3,'super_admin','x','active')`,
    [id, `jadm_${tag}`, `jadm_${tag}@titopay.test`]);
  return { userId: id, userType: "admin", ipAddress: "127.0.0.1", userAgent: "node-test" };
}

// The fees have to exist in the database for calculateFee to read them; on a
// fresh test database the one-shot has never run.
test.before(async () => {
  await pro.ensureTitoProSchema();
  await profiles.ensureProfileSchema();
  await vetting.ensureVettingSchema();
  await pricing.applyTitoProPricingOnce();
});

async function jobFor(profession = "plumber") {
  const customer = await makeUser("Thandi");
  const professional = await makeListedProfessional(profession);
  const job = await pro.createJob(customer, {
    profession,
    professionalUserId: professional.userId,
    title: "Blocked kitchen drain",
    description: "Water comes back up since Tuesday.",
    suburb: "Pimville", city: "Soweto"
  });
  return { customer, professional, job };
}

test("A JOB RUNS END TO END - request, quote, accept, work, sign off", async () => {
  const { customer, professional, job } = await jobFor("plumber");
  assert.equal(job.status, "requested");
  assert.match(job.reference, /^TP-J-[A-HJ-NP-Z2-9]{8}$/, "a reference somebody can read down a phone");
  assert.equal(job.quotedAmount, null, "no price until the professional names one");

  const quoted = await pro.quoteJob(professional, job.id, { amount: 850 });
  assert.equal(quoted.status, "quoted");
  assert.equal(quoted.quotedAmount, 850);

  const accepted = await pro.acceptQuote(customer, job.id);
  assert.equal(accepted.status, "accepted");

  await pro.scheduleJob(professional, job.id, { bookingId: uuidv4() });
  await pro.startJob(professional, job.id);
  const done = await pro.markWorkDone(professional, job.id);
  assert.equal(done.status, "work_done");

  const confirmed = await pro.confirmJob(customer, job.id);
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.certificateRequired === false);
});

test("THE FEE IS R5 FROM THE CUSTOMER AND R20 PLUS 1,5% FROM THE PROFESSIONAL", async () => {
  // The numbers a plumber will judge this product by. Read from the pricing
  // engine so an operator changing a rate changes it here too.
  const cases = [
    { amount: 350, professional: 25.25, customerPays: 355, receives: 324.75 },
    { amount: 850, professional: 32.75, customerPays: 855, receives: 817.25 },
    { amount: 5000, professional: 95.00, customerPays: 5005, receives: 4905 }
  ];
  for (const expected of cases) {
    const fees = await pro.quoteFees(expected.amount);
    assert.equal(fees.customerFee, 5, `R${expected.amount}: the customer always pays R5`);
    assert.equal(fees.professionalFee, expected.professional, `R${expected.amount}: professional fee`);
    assert.equal(fees.customerPays, expected.customerPays);
    assert.equal(fees.professionalReceives, expected.receives);
  }
});

test("the fee is SNAPSHOT on the job, not recalculated when it is read", async () => {
  // A rate an operator changes next month must not silently restate what two
  // people already agreed on a job from last month.
  const { professional, job } = await jobFor("plumber");
  const quoted = await pro.quoteJob(professional, job.id, { amount: 850 });
  assert.equal(quoted.customerFee, 5);
  assert.equal(quoted.professionalFee, 32.75);
  const { rows } = await pool.query("SELECT customer_fee, professional_fee FROM titopro_jobs WHERE id = $1", [job.id]);
  assert.equal(Number(rows[0].customer_fee), 5, "stored, not derived at read time");
  assert.equal(Number(rows[0].professional_fee), 32.75);
});

test("WORK THAT RUNS OVER DAYS IS REFUSED A DIARY SLOT", async () => {
  // A painter given a two-hour slot for three days of work leaves the diary
  // reporting them free while they are up a ladder in somebody's lounge.
  const { customer, professional, job } = await jobFor("painter");
  assert.equal(job.shape, "project");
  assert.equal(job.usesDiary, false);
  assert.equal(job.bookingWord, "Project", "and it is not called a booking either");

  await pro.quoteJob(professional, job.id, { amount: 5000 });
  await pro.acceptQuote(customer, job.id);
  await assert.rejects(
    () => pro.scheduleJob(professional, job.id, { bookingId: uuidv4() }),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /does not take a diary slot/i);
      return true;
    }
  );
  // It still runs - it simply goes straight to work without a slot.
  await pro.startJob(professional, job.id);
  const done = await pro.markWorkDone(professional, job.id);
  assert.equal(done.status, "work_done");
});

test("a remote brief has no calendar at all", async () => {
  const { customer, professional, job } = await jobFor("bookkeeper");
  assert.equal(job.shape, "remote");
  assert.equal(job.usesDiary, false);
  assert.equal(job.bookingWord, "Brief");
  await pro.quoteJob(professional, job.id, { amount: 1200 });
  await pro.acceptQuote(customer, job.id);
  await assert.rejects(() => pro.scheduleJob(professional, job.id, {}), /does not take a diary slot/i);
});

test("a cleaner every Tuesday DOES take a slot - recurring is still a span", async () => {
  const { customer, professional, job } = await jobFor("cleaner");
  assert.equal(job.shape, "recurring");
  assert.equal(job.usesDiary, true, "each visit is a real slot; what is new is the series");
  assert.equal(job.bookingWord, "Visit");
  await pro.quoteJob(professional, job.id, { amount: 400 });
  await pro.acceptQuote(customer, job.id);
  const scheduled = await pro.scheduleJob(professional, job.id, { bookingId: uuidv4() });
  assert.equal(scheduled.status, "scheduled");
});

test("AN ELECTRICIAN CANNOT CLOSE A JOB WITHOUT THE CERTIFICATE", async () => {
  // The customer will be asked for the COC years later when they sell the
  // house. Losing it is not a paperwork problem, it is taking something from
  // them that cannot be given back.
  const { customer, professional, job } = await jobFor("electrician");
  assert.equal(job.certificateRequired, true);
  await pro.quoteJob(professional, job.id, { amount: 1800 });
  await pro.acceptQuote(customer, job.id);
  await pro.startJob(professional, job.id);

  await assert.rejects(
    () => pro.markWorkDone(professional, job.id),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.details?.code, "certificate_required");
      return true;
    }
  );
  const done = await pro.markWorkDone(professional, job.id, { certificateReference: "COC-2026-114872" });
  assert.equal(done.certificateReference, "COC-2026-114872");
  // And it stays on the record after the money has moved on.
  const later = await pro.getJob(customer, job.id);
  assert.equal(later.certificateReference, "COC-2026-114872");
});

test("a plumber is not held to the electrician's certificate", () => {
  assert.equal(reference.profession("plumber").certificate, "conditional");
  assert.equal(reference.profession("electrician").certificate, "required");
  assert.equal(reference.profession("handyman").certificate, "none");
});

test("NOTHING IS CONFIRMED WITHOUT A PRICE SOMEBODY AGREED TO", async () => {
  const { customer, professional, job } = await jobFor("plumber");
  // Straight from requested to confirmed would be a job with no quote and no
  // acceptance that nonetheless reads as complete.
  await assert.rejects(() => pro.confirmJob(customer, job.id), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /cannot become confirmed/i);
    return true;
  });
  await assert.rejects(() => pro.startJob(professional, job.id), /cannot become in progress/i);
  await assert.rejects(() => pro.markWorkDone(professional, job.id), /cannot become work done/i);
});

test("SCOPE CHANGING ON SITE GOES BACK TO THE CUSTOMER", async () => {
  // A plumber lifts the drain cover and finds a cracked pipe. The R850 job is
  // now R2 400, and the customer has to agree to that before it continues.
  const { customer, professional, job } = await jobFor("plumber");
  await pro.quoteJob(professional, job.id, { amount: 850 });
  await pro.acceptQuote(customer, job.id);
  await pro.startJob(professional, job.id);

  const requoted = await pro.reQuoteJob(professional, job.id, { amount: 2400, reason: "Cracked pipe under the slab" });
  assert.equal(requoted.status, "re_quoted");
  assert.equal(requoted.quotedAmount, 2400);
  assert.equal(requoted.professionalFee, 56, "the fee follows the new figure: R20 + 1,5% of R2 400");

  // The professional cannot simply carry on at the new price.
  await assert.rejects(() => pro.markWorkDone(professional, job.id), /cannot become work done/i);
  await pro.acceptQuote(customer, job.id);
  await pro.startJob(professional, job.id);
  assert.equal((await pro.markWorkDone(professional, job.id)).status, "work_done");
});

test("haggling before the work starts is allowed; changing the price after is not", async () => {
  const { customer, professional, job } = await jobFor("painter");
  await pro.quoteJob(professional, job.id, { amount: 6000 });
  const second = await pro.quoteJob(professional, job.id, { amount: 5200 });
  assert.equal(second.quotedAmount, 5200, "quoted -> quoted is the normal case, not an error");
  await pro.acceptQuote(customer, job.id);
  await assert.rejects(() => pro.quoteJob(professional, job.id, { amount: 9000 }),
    /cannot become quoted/i, "once accepted the figure is fixed until a re-quote");
});

test("AN EXPIRED QUOTE CANNOT BE ACCEPTED", async () => {
  const { customer, professional, job } = await jobFor("plumber");
  await pro.quoteJob(professional, job.id, { amount: 850, validForDays: 7 });
  await pool.query("UPDATE titopro_jobs SET quote_expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [job.id]);
  await assert.rejects(() => pro.acceptQuote(customer, job.id), (error) => {
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /expired/i);
    return true;
  });
});

test("A JOB IS BETWEEN TWO PEOPLE AND NOBODY ELSE READS IT", async () => {
  // The customer's suburb and photographs of the inside of their house are on
  // this record. A stranger gets 404, not 403 - the existence of the job is
  // not theirs to learn either.
  const { customer, professional, job } = await jobFor("plumber");
  const stranger = await makeUser("Nosy");
  await assert.rejects(() => pro.getJob(stranger, job.id), (error) => {
    assert.equal(error.statusCode, 404);
    return true;
  });
  assert.ok(await pro.getJob(customer, job.id));
  assert.ok(await pro.getJob(professional, job.id));
});

test("each side can only do its own half", async () => {
  const { customer, professional, job } = await jobFor("plumber");
  await assert.rejects(() => pro.quoteJob(customer, job.id, { amount: 10 }),
    /Only the professional/i, "a customer cannot quote themselves a price");
  await pro.quoteJob(professional, job.id, { amount: 850 });
  await assert.rejects(() => pro.acceptQuote(professional, job.id),
    /Only the customer/i, "a professional cannot accept on the customer's behalf");
});

test("NOBODY CAN HIRE THEMSELVES", async () => {
  // Otherwise a professional raises and confirms their own jobs and
  // manufactures a review history out of nothing.
  const solo = await makeUser("Solo");
  await assert.rejects(
    () => pro.createJob(solo, { profession: "plumber", professionalUserId: solo.userId, title: "Fixing my own tap" }),
    /cannot hire yourself/i
  );
  // And the database refuses it too, not only the service.
  await assert.rejects(() => pool.query(
    `INSERT INTO titopro_jobs (id, reference, customer_user_id, professional_user_id, profession, shape, title)
     VALUES ($1,$2,$3,$3,'plumber','callout','Direct insert')`,
    [uuidv4(), "TP-J-SELFTEST", solo.userId]), /titopro_jobs_two_parties_check/);
});

test("either side may raise a dispute, and it freezes the job", async () => {
  const { customer, professional, job } = await jobFor("plumber");
  await pro.quoteJob(professional, job.id, { amount: 850 });
  await pro.acceptQuote(customer, job.id);
  await pro.startJob(professional, job.id);
  await pro.markWorkDone(professional, job.id);
  const disputed = await pro.disputeJob(customer, job.id, { reason: "Drain blocked again the next morning" });
  assert.equal(disputed.status, "disputed");
  // A disputed job cannot be quietly marked done again around the customer.
  await assert.rejects(() => pro.markWorkDone(professional, job.id), /cannot become work done/i);
});

test("an unknown profession is refused rather than stored", async () => {
  const customer = await makeUser("Curious");
  for (const bad of ["", "astronaut", "PLUMBER", "plumber; DROP TABLE", null]) {
    await assert.rejects(
      () => pro.createJob(customer, { profession: bad, title: "Something" }),
      /what kind of professional/i, `refused: ${JSON.stringify(bad)}`);
  }
});

test("every profession declares a shape the database will accept", () => {
  // shape reaches a CHECK constraint, so a profession with a typo in it would
  // fail on insert rather than at review.
  for (const key of reference.PROFESSION_KEYS) {
    const item = reference.profession(key);
    assert.ok(reference.SHAPES.includes(item.shape), `${key} has shape "${item.shape}"`);
    assert.ok(reference.SHAPE_COPY[item.shape], `${item.shape} needs copy for the screen`);
    assert.ok(reference.VETTING.includes(item.vetting), `${key} vetting`);
    assert.ok(item.label && item.hint && item.group, `${key} needs a label, hint and group`);
    assert.match(key, /^[a-z][a-z0-9_]*$/, `${key} is machine-safe`);
  }
  assert.equal(new Set(reference.PROFESSION_KEYS).size, reference.PROFESSION_KEYS.length, "no duplicates");
});

test("WORK WITH CHILDREN AND KEYS IS FLAGGED FOR ENHANCED VETTING", () => {
  // Identity checks are enough for somebody who fixes a geyser and leaves. A
  // tutor sits alone with a child and a cleaner holds the keys to an empty
  // house. Listing them on the same checks would be a decision about a child's
  // safety taken without noticing one was being made.
  for (const key of ["cleaner", "tutor", "locksmith"]) {
    assert.equal(reference.requiresEnhancedVetting(key), true, `${key} needs more than identity`);
  }
  for (const key of ["plumber", "electrician", "painter", "bookkeeper"]) {
    assert.equal(reference.requiresEnhancedVetting(key), false, `${key} is a standard check`);
  }
});

test("the professions the product promised are all there", () => {
  for (const key of ["plumber", "electrician", "painter", "garden_service", "cleaner",
    "carpenter", "appliance_technician", "handyman"]) {
    assert.equal(reference.isProfession(key), true, `${key} is listed`);
  }
  // Freelance work is present as the actual professions people hire, rather
  // than as a category called "freelancer" that says nothing about the job.
  const remote = reference.PROFESSION_KEYS.filter((key) => reference.shapeOf(key) === "remote");
  assert.ok(remote.length >= 4, `remote professions: ${remote.join(", ")}`);
});

test("THE SCHEMA HEALS ITSELF IF THE TABLE IS MISSING", async () => {
  await pool.query("DROP TABLE IF EXISTS titopro_jobs CASCADE");
  pro.resetTitoProSchemaCache();
  const { job } = await jobFor("handyman");
  assert.equal(job.status, "requested");
  const { rows } = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'titopro_jobs' ORDER BY indexname");
  assert.ok(rows.some((row) => row.indexname === "uq_titopro_jobs_reference"), rows.map((r) => r.indexname).join(","));
});

test("the chat thread where the price was agreed stays with the job", async () => {
  const { customer, job } = await jobFor("painter");
  const threadId = uuidv4();
  const linked = await pro.attachChatThread(customer, job.id, threadId);
  assert.equal(linked.chatThreadId, threadId);
});

test("a job lists for both the customer and the professional", async () => {
  const { customer, professional, job } = await jobFor("plumber");
  const mine = await pro.listJobsForUser(customer.userId, { role: "customer" });
  const theirs = await pro.listJobsForUser(professional.userId, { role: "professional" });
  assert.ok(mine.some((item) => item.id === job.id));
  assert.ok(theirs.some((item) => item.id === job.id));
  assert.equal((await pro.listJobsForUser(customer.userId, { role: "professional" })).length, 0,
    "the customer is not the professional on their own job");
});

test.after(async () => { await pool.end().catch(() => null); });
