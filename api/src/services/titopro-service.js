"use strict";

// TITOPRO: THE JOB.
//
// One record carries a piece of work from "my drain is blocked" to "that is
// finished, pay them". It is the thing every profession on TitoPro has in
// common, whatever shape the work takes - the calendar booking is an OPTIONAL
// attachment to a job, not the job itself.
//
// WHY A JOB RATHER THAN A LONGER LIST OF BOOK CATEGORIES. Book answers "a
// resource with capacity, for a span of time" and caps that span at a day. A
// plumber fits. A painter working Tuesday to Thursday has no span to hold, a
// cleaner every Tuesday has a series of them, and a bookkeeper has no calendar
// at all. Modelling those as bookings would have the diary lying from the
// first one. See config/titopro-reference.js for the four shapes.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO: move money. A job records what was
// quoted and what the fees would be, and it stops there. Holding a customer's
// payment and releasing it to an unrelated professional is a different
// regulated activity from moving money between two TitoPay wallets, and the
// transaction engine already refuses multi-party settlement for exactly that
// reason. The hold belongs behind that answer, not in front of it.
//
// CHAT IS PART OF THE JOB, NOT BESIDE IT. A price for painting a house is
// negotiated, not listed, so the thread where that happens is attached to the
// job record. Without that the agreement lives in a conversation nobody can
// find afterwards, which is the state every WhatsApp trade deal is already in.

const crypto = require("node:crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText } = require("../lib/validation");
const { writeAuditLog } = require("./audit-service");
const reference = require("../config/titopro-reference");
const { calculateFee } = require("./pricing-service");

// A reference a person can read down a phone line. Same alphabet the booking
// engine uses: no I, O, 0 or 1, because those are what get misheard.
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function jobReference() {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  }
  return `TP-J-${out}`;
}

/* ------------------------------------------------------------------ schema */

let schemaReady = null;
async function ensureTitoProSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS titopro_jobs (
        id UUID PRIMARY KEY,
        reference TEXT NOT NULL,
        customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        professional_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        profession TEXT NOT NULL,
        shape TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        suburb TEXT,
        city TEXT,
        status TEXT NOT NULL DEFAULT 'requested',
        quoted_amount NUMERIC(18,2),
        quoted_at TIMESTAMPTZ,
        quote_expires_at TIMESTAMPTZ,
        customer_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
        professional_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
        chat_thread_id UUID,
        booking_id UUID,
        certificate_required BOOLEAN NOT NULL DEFAULT FALSE,
        certificate_reference TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
        accepted_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        work_done_at TIMESTAMPTZ,
        confirmed_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        -- Named so the vocabulary can be widened later without a table rewrite,
        -- which is the same reasoning book_bookings_status_check carries.
        CONSTRAINT titopro_jobs_status_check CHECK (status IN (
          'requested','quoted','re_quoted','accepted','scheduled','in_progress',
          'work_done','confirmed','declined','cancelled','expired','disputed')),
        CONSTRAINT titopro_jobs_shape_check CHECK (shape IN ('callout','recurring','project','remote')),
        CONSTRAINT titopro_jobs_amount_check CHECK (quoted_amount IS NULL OR quoted_amount >= 0),
        -- A customer cannot hire themselves. Without this, a professional could
        -- raise and confirm their own job and manufacture a review history.
        CONSTRAINT titopro_jobs_two_parties_check
          CHECK (professional_user_id IS NULL OR professional_user_id <> customer_user_id)
      )
    `);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_titopro_jobs_reference ON titopro_jobs (reference)");
    await pool.query("CREATE INDEX IF NOT EXISTS idx_titopro_jobs_customer ON titopro_jobs (customer_user_id, created_at DESC)");
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_jobs_professional
      ON titopro_jobs (professional_user_id, created_at DESC) WHERE professional_user_id IS NOT NULL`);
    // The professional's work queue: everything still open, newest first.
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_jobs_open
      ON titopro_jobs (professional_user_id, status)
      WHERE status NOT IN ('confirmed','declined','cancelled','expired')`);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

// Tests only: forget that the schema was ensured, so a test can drop the table
// and prove the guard rebuilds it. Nothing in the running API calls this.
function resetTitoProSchemaCache() {
  schemaReady = null;
}

/* ------------------------------------------------------- the state machine */

// WHAT MAY FOLLOW WHAT. Written out rather than inferred, because an illegal
// jump here is a job that was confirmed without anybody agreeing a price.
const TRANSITIONS = Object.freeze({
  requested:   ["quoted", "declined", "cancelled", "expired"],
  quoted:      ["accepted", "declined", "cancelled", "expired", "quoted"],
  re_quoted:   ["accepted", "declined", "cancelled", "disputed"],
  accepted:    ["scheduled", "in_progress", "cancelled", "disputed"],
  scheduled:   ["in_progress", "cancelled", "disputed"],
  in_progress: ["work_done", "re_quoted", "disputed", "cancelled"],
  work_done:   ["confirmed", "disputed", "re_quoted"],
  confirmed:   [],
  declined:    [],
  cancelled:   [],
  expired:     [],
  disputed:    ["confirmed", "cancelled"]
});

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!reference.isJobStatus(to)) throw new AppError(400, "Unknown job status");
  if (!canTransition(from, to)) {
    throw new AppError(409, `A job that is ${String(from).replace(/_/g, " ")} cannot become ${String(to).replace(/_/g, " ")}`);
  }
}

/* -------------------------------------------------------------------- fees */

// WHAT THIS JOB WOULD COST BOTH SIDES, asked of the pricing engine rather than
// worked out here, so an operator changing a rate in the console changes it
// everywhere at once. Nothing is charged; this is the figure a quote shows.
async function quoteFees(amount) {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value < 0) throw new AppError(400, "A quote amount cannot be negative");
  const [customerFee, professionalFee] = await Promise.all([
    calculateFee(reference.CUSTOMER_FEE_CODE, value),
    calculateFee(reference.PROFESSIONAL_FEE_CODE, value)
  ]);
  // calculateFee returns { amount, fee, total, ... }. Read `fee` and nothing
  // else: a fallback chain here would quietly produce a different number the
  // day that shape changed, and this figure is what both sides are charged.
  const customer = Number(customerFee.fee);
  const professional = Number(professionalFee.fee);
  return {
    amount: round(value),
    customerFee: round(customer),
    professionalFee: round(professional),
    customerPays: round(value + customer),
    professionalReceives: round(value - professional)
  };
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/* --------------------------------------------------------------- the job */

async function createJob(actor, payload = {}) {
  await ensureTitoProSchema();
  if (!actor?.userId) throw new AppError(401, "Sign in to request a professional");
  const professionKey = String(payload.profession || "").trim();
  if (!reference.isProfession(professionKey)) throw new AppError(400, "Choose what kind of professional you need");
  const info = reference.profession(professionKey);

  const professionalUserId = payload.professionalUserId || null;
  if (professionalUserId && professionalUserId === actor.userId) {
    throw new AppError(400, "You cannot hire yourself");
  }
  // THE BACK DOOR, CLOSED.
  //
  // Listing requires FICA verification. Without this check that requirement
  // would guard only the browse screen: a job posted straight at a user id
  // would reach somebody who never verified, or whose listing was taken down
  // this morning, and the money path would follow it. The professional named
  // on a job must be live on TitoPro at the moment the job is raised.
  if (professionalUserId) {
    await require("./titopro-profile-service").requirePublishedProfessional(professionalUserId);
  }

  const id = crypto.randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO titopro_jobs
      (id, reference, customer_user_id, professional_user_id, profession, shape,
       title, description, suburb, city, certificate_required, chat_thread_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::JSONB)
     RETURNING *`,
    [
      id,
      jobReference(),
      actor.userId,
      professionalUserId,
      professionKey,
      info.shape,
      boundedText(payload.title, "What you need done", { min: 3, max: 160 }),
      payload.description ? boundedText(payload.description, "Description", { min: 0, max: 4000 }) : null,
      payload.suburb ? boundedText(payload.suburb, "Suburb", { min: 0, max: 120 }) : null,
      payload.city ? boundedText(payload.city, "City", { min: 0, max: 120 }) : null,
      info.certificate === "required",
      payload.chatThreadId || null,
      JSON.stringify({ photos: Array.isArray(payload.photos) ? payload.photos.slice(0, 8) : [] })
    ]
  );
  await audit(actor, rows[0], "titopro_job_requested", { profession: professionKey, shape: info.shape });
  return present(rows[0]);
}

// THE PRICE, NAMED BY THE PROFESSIONAL.
//
// A quote may be sent more than once while the customer is still deciding -
// the transition table allows quoted -> quoted - because haggling over a price
// before any work starts is the normal case, not an error. What it may NOT do
// is change after the customer has accepted; that is re_quoteJob, which puts
// the job back in front of them.
async function quoteJob(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireProfessional(actor, job);
  assertTransition(job.status, "quoted");
  const fees = await quoteFees(payload.amount);
  const days = Number(payload.validForDays || 7);
  const { rows } = await pool.query(
    `UPDATE titopro_jobs
        SET status = 'quoted', quoted_amount = $2, quoted_at = NOW(),
            quote_expires_at = NOW() + ($3 || ' days')::interval,
            customer_fee = $4, professional_fee = $5, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [jobId, fees.amount, String(Math.max(1, Math.min(90, days))), fees.customerFee, fees.professionalFee]
  );
  await audit(actor, rows[0], "titopro_job_quoted", { amount: fees.amount });
  return present(rows[0], fees);
}

// SCOPE CHANGED ON SITE. The figure both sides agreed no longer matches the
// work, so it goes back to the customer rather than being quietly raised.
async function reQuoteJob(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireProfessional(actor, job);
  assertTransition(job.status, "re_quoted");
  const fees = await quoteFees(payload.amount);
  const { rows } = await pool.query(
    `UPDATE titopro_jobs
        SET status = 're_quoted', quoted_amount = $2, quoted_at = NOW(),
            customer_fee = $3, professional_fee = $4,
            metadata = jsonb_set(metadata, '{reQuoteReason}', to_jsonb($5::TEXT), true),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [jobId, fees.amount, fees.customerFee, fees.professionalFee,
      boundedText(payload.reason, "Why the price changed", { min: 3, max: 500 })]
  );
  await audit(actor, rows[0], "titopro_job_requoted", { amount: fees.amount, previousAmount: Number(job.quoted_amount || 0) });
  return present(rows[0], fees);
}

async function acceptQuote(actor, jobId) {
  const job = await requireJob(jobId);
  requireCustomer(actor, job);
  assertTransition(job.status, "accepted");
  if (job.quote_expires_at && new Date(job.quote_expires_at).getTime() < Date.now()) {
    throw new AppError(409, "That quote has expired. Ask for a new one.");
  }
  const { rows } = await pool.query(
    "UPDATE titopro_jobs SET status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
    [jobId]
  );
  await audit(actor, rows[0], "titopro_job_accepted", { amount: Number(job.quoted_amount || 0) });
  return present(rows[0]);
}

async function declineQuote(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireCustomer(actor, job);
  assertTransition(job.status, "declined");
  const { rows } = await pool.query(
    `UPDATE titopro_jobs SET status = 'declined', closed_at = NOW(), updated_at = NOW(),
        metadata = jsonb_set(metadata, '{declineReason}', to_jsonb($2::TEXT), true)
      WHERE id = $1 RETURNING *`,
    [jobId, payload.reason ? boundedText(payload.reason, "Reason", { min: 0, max: 500 }) : ""]
  );
  await audit(actor, rows[0], "titopro_job_declined", {});
  return present(rows[0]);
}

// A DIARY SLOT IS FOR THE SHAPES THAT HAVE ONE.
//
// A project has no span to hold and a remote brief has no calendar, so
// attaching a booking to either would put a painter in a two-hour slot for
// three days of work - the diary would then report them free while they are up
// a ladder. Refused here rather than left to whoever writes the screen.
async function scheduleJob(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireProfessional(actor, job);
  if (!reference.usesBookingDiary(job.profession)) {
    throw new AppError(409,
      `A ${reference.profession(job.profession).label.toLowerCase()} job is ${reference.SHAPE_COPY[job.shape].label.toLowerCase()} work and does not take a diary slot. Agree a start date instead.`);
  }
  assertTransition(job.status, "scheduled");
  const { rows } = await pool.query(
    "UPDATE titopro_jobs SET status = 'scheduled', booking_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    [jobId, payload.bookingId || null]
  );
  await audit(actor, rows[0], "titopro_job_scheduled", { bookingId: payload.bookingId || null });
  return present(rows[0]);
}

async function startJob(actor, jobId) {
  const job = await requireJob(jobId);
  requireProfessional(actor, job);
  assertTransition(job.status, "in_progress");
  const { rows } = await pool.query(
    "UPDATE titopro_jobs SET status = 'in_progress', started_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
    [jobId]
  );
  await audit(actor, rows[0], "titopro_job_started", {});
  return present(rows[0]);
}

// AN ELECTRICIAN CANNOT CLOSE A JOB WITHOUT THE CERTIFICATE.
//
// Notifiable electrical work requires a Certificate of Compliance, and the
// customer will be asked for it years later when they sell the house. A
// marketplace that lets the job close without one has quietly taken something
// from the customer that it cannot give back, so the completion is refused
// rather than the certificate being chased afterwards.
async function markWorkDone(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireProfessional(actor, job);
  assertTransition(job.status, "work_done");
  const certificate = payload.certificateReference
    ? boundedText(payload.certificateReference, "Certificate number", { min: 3, max: 120 })
    : "";
  if (job.certificate_required && !certificate) {
    throw new AppError(400,
      "This job needs a Certificate of Compliance before it can be marked done. Add the certificate number to finish.",
      { code: "certificate_required" });
  }
  const { rows } = await pool.query(
    `UPDATE titopro_jobs
        SET status = 'work_done', work_done_at = NOW(), certificate_reference = NULLIF($2, ''), updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [jobId, certificate]
  );
  await audit(actor, rows[0], "titopro_job_work_done", { certificate: Boolean(certificate) });
  return present(rows[0]);
}

async function confirmJob(actor, jobId) {
  const job = await requireJob(jobId);
  requireCustomer(actor, job);
  assertTransition(job.status, "confirmed");
  const { rows } = await pool.query(
    "UPDATE titopro_jobs SET status = 'confirmed', confirmed_at = NOW(), closed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
    [jobId]
  );
  await audit(actor, rows[0], "titopro_job_confirmed", { amount: Number(job.quoted_amount || 0) });
  return present(rows[0]);
}

// EITHER SIDE MAY RAISE A DISPUTE, which is the point of it.
async function disputeJob(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireParty(actor, job);
  assertTransition(job.status, "disputed");
  const { rows } = await pool.query(
    `UPDATE titopro_jobs SET status = 'disputed', updated_at = NOW(),
        metadata = jsonb_set(metadata, '{disputeReason}', to_jsonb($2::TEXT), true)
      WHERE id = $1 RETURNING *`,
    [jobId, boundedText(payload.reason, "What went wrong", { min: 3, max: 1000 })]
  );
  await audit(actor, rows[0], "titopro_job_disputed", { raisedBy: actor.userId === job.customer_user_id ? "customer" : "professional" });
  return present(rows[0]);
}

async function cancelJob(actor, jobId, payload = {}) {
  const job = await requireJob(jobId);
  requireParty(actor, job);
  assertTransition(job.status, "cancelled");
  const { rows } = await pool.query(
    `UPDATE titopro_jobs SET status = 'cancelled', closed_at = NOW(), updated_at = NOW(),
        metadata = jsonb_set(metadata, '{cancelReason}', to_jsonb($2::TEXT), true)
      WHERE id = $1 RETURNING *`,
    [jobId, payload.reason ? boundedText(payload.reason, "Reason", { min: 0, max: 500 }) : ""]
  );
  await audit(actor, rows[0], "titopro_job_cancelled", { by: actor.userId === job.customer_user_id ? "customer" : "professional" });
  return present(rows[0]);
}

// The conversation where the price was agreed, kept with the job it belongs to.
async function attachChatThread(actor, jobId, threadId) {
  const job = await requireJob(jobId);
  requireParty(actor, job);
  const { rows } = await pool.query(
    "UPDATE titopro_jobs SET chat_thread_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
    [jobId, threadId]
  );
  return present(rows[0]);
}

/* -------------------------------------------------------------- read paths */

async function listJobsForUser(userId, { role = "customer", limit = 50 } = {}) {
  await ensureTitoProSchema();
  const column = role === "professional" ? "professional_user_id" : "customer_user_id";
  const { rows } = await pool.query(
    `SELECT * FROM titopro_jobs WHERE ${column} = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.max(1, Math.min(200, Number(limit) || 50))]
  );
  return rows.map((row) => present(row));
}

async function getJob(actor, jobId) {
  const job = await requireJob(jobId);
  requireParty(actor, job);
  return present(job);
}

/* ----------------------------------------------------------------- helpers */

async function requireJob(jobId) {
  await ensureTitoProSchema();
  const { rows } = await pool.query("SELECT * FROM titopro_jobs WHERE id = $1 LIMIT 1", [jobId]);
  if (!rows[0]) throw new AppError(404, "Job not found");
  return rows[0];
}

// A JOB IS BETWEEN TWO PEOPLE AND NOBODY ELSE READS IT. The customer's address
// and photographs of the inside of their house are on this record.
function requireParty(actor, job) {
  if (!actor?.userId) throw new AppError(401, "Sign in to continue");
  if (actor.userId !== job.customer_user_id && actor.userId !== job.professional_user_id) {
    throw new AppError(404, "Job not found");
  }
}

function requireCustomer(actor, job) {
  requireParty(actor, job);
  if (actor.userId !== job.customer_user_id) throw new AppError(403, "Only the customer can do that");
}

function requireProfessional(actor, job) {
  requireParty(actor, job);
  if (actor.userId !== job.professional_user_id) throw new AppError(403, "Only the professional can do that");
}

async function audit(actor, job, action, metadata) {
  await writeAuditLog({
    actorType: "customer",
    actorId: actor.userId,
    action,
    entityType: "titopro_job",
    entityId: job.id,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    metadata: { reference: job.reference, status: job.status, ...metadata }
  }).catch(() => null);
}

// Built by hand rather than by spreading the row, so a column added later
// cannot appear on a customer-facing surface by accident.
function present(row, fees = null) {
  const info = reference.profession(row.profession);
  const copy = reference.SHAPE_COPY[row.shape] || {};
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    profession: row.profession,
    professionLabel: info?.label || row.profession,
    shape: row.shape,
    shapeLabel: copy.label || row.shape,
    // What this job is called to the people in it: a Job, a Visit, a Project
    // or a Brief. One word, and it is the difference between the screen making
    // sense to a plumber and to a bookkeeper.
    bookingWord: copy.bookingWord || "Job",
    title: row.title,
    description: row.description,
    suburb: row.suburb,
    city: row.city,
    quotedAmount: row.quoted_amount === null ? null : Number(row.quoted_amount),
    quotedAt: row.quoted_at,
    quoteExpiresAt: row.quote_expires_at,
    customerFee: Number(row.customer_fee || 0),
    professionalFee: Number(row.professional_fee || 0),
    chatThreadId: row.chat_thread_id,
    bookingId: row.booking_id,
    usesDiary: reference.usesBookingDiary(row.profession),
    certificateRequired: row.certificate_required,
    certificateReference: row.certificate_reference,
    enhancedVetting: reference.requiresEnhancedVetting(row.profession),
    photos: Array.isArray(row.metadata?.photos) ? row.metadata.photos : [],
    createdAt: row.created_at,
    ...(fees ? { fees } : {})
  };
}

module.exports = {
  TRANSITIONS,
  acceptQuote,
  attachChatThread,
  canTransition,
  cancelJob,
  confirmJob,
  createJob,
  declineQuote,
  disputeJob,
  ensureTitoProSchema,
  getJob,
  listJobsForUser,
  markWorkDone,
  quoteFees,
  quoteJob,
  reQuoteJob,
  resetTitoProSchemaCache,
  scheduleJob,
  startJob
};
