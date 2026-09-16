"use strict";

// TITOPRO: WHAT CUSTOMERS SAY AFTERWARDS, AND WHAT TITOPAY DOES ABOUT IT.
//
// Two records live here and they are deliberately different things:
//
//   A RATING is a customer scoring a job they paid for. It is tied to that
//   job, written once, by the person who was there, after the work was
//   confirmed. It is public, because a stranger deciding whether to let a
//   plumber into their house is the whole reason TitoPro is worth more than a
//   phone number on a lamp post.
//
//   A REPORT is a customer telling TitoPay something is wrong. It is private,
//   it reaches an operator, and it is an ACCUSATION rather than a finding.
//
// WHY A REPORT NEVER TAKES A LISTING DOWN BY ITSELF. It is the most tempting
// automation in a marketplace - three reports and you are gone - and it hands
// every competitor a delete button. Reports are ordered so the dangerous ones
// are read first; the decision is always a named person's, recorded in
// titopro-profile-service with their id against it.
//
// WHY A RATING CANNOT BE EDITED. A score that can be rewritten is a score that
// can be traded: "change it to five and I'll knock R200 off". Once written it
// stands. TitoPay can WITHDRAW one it finds to be fraudulent, and can hide a
// comment it will not publish, and both of those are recorded with a reason -
// but neither is a delete and neither is available to the two people with an
// interest in the number.
//
// WHY THE COMMENT HAS A LEVER OF ITS OWN. Hiding words TitoPay will not stand
// behind should not erase the customer's score: a real customer who was
// genuinely let down still gets their one star even if what they wrote about
// the person cannot be published.

const crypto = require("node:crypto");
const { pool } = require("../db/pool");
const { AppError } = require("../lib/errors");
const { boundedText, requireEnum } = require("../lib/validation");
const { writeAuditLog } = require("./audit-service");
const reference = require("../config/titopro-reference");

// A reference an operator and a customer can both say out loud. Same alphabet
// the job and booking engines use: no I, O, 0 or 1, because those are what get
// misheard down a phone line.
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function reportReference() {
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  }
  return `TP-R-${out}`;
}

// Somebody reporting the same professional over and over is either being
// harassed or doing the harassing, and either way a queue full of one person's
// rows stops the operator seeing anybody else's. One report per professional
// may be open at a time (a unique index below), and this caps the total a
// single account can raise in a day.
const REPORTS_PER_DAY = 10;

/* ------------------------------------------------------------------ schema */

let schemaReady = null;
async function ensureReputationSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    // Both tables point at titopro_jobs, so that table has to exist first.
    // Stated as a call rather than left to whichever route happened to run
    // earlier in the process.
    await require("./titopro-service").ensureTitoProSchema();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS titopro_ratings (
        id UUID PRIMARY KEY,
        job_id UUID NOT NULL REFERENCES titopro_jobs(id) ON DELETE CASCADE,
        professional_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        customer_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stars INTEGER NOT NULL,
        comment TEXT,
        -- Words TitoPay will not publish. The star still counts; see the file
        -- header for why those are two separate decisions.
        comment_hidden_at TIMESTAMPTZ,
        comment_hidden_reason TEXT,
        -- A rating TitoPay found to be fraudulent. Excluded from the average
        -- and from every read path, never deleted, because the row is the
        -- evidence for the decision to exclude it.
        withdrawn_at TIMESTAMPTZ,
        withdrawn_reason TEXT,
        moderated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT titopro_ratings_stars_check
          CHECK (stars >= ${reference.RATING_MIN} AND stars <= ${reference.RATING_MAX}),
        -- Nobody rates themselves. titopro_jobs already refuses a job with the
        -- same person on both sides; this refuses the rating as well, so the
        -- guarantee does not depend on that one holding.
        CONSTRAINT titopro_ratings_two_parties_check
          CHECK (customer_user_id <> professional_user_id)
      )
    `);
    // ONE RATING PER JOB. This index is what actually enforces it - the read
    // before the insert loses a race with a double-tapped button, and this
    // does not.
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_titopro_ratings_job ON titopro_ratings (job_id)");
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_ratings_professional
      ON titopro_ratings (professional_user_id, created_at DESC) WHERE withdrawn_at IS NULL`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS titopro_reports (
        id UUID PRIMARY KEY,
        reference TEXT NOT NULL,
        professional_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reporter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Optional: a report can come from somebody who never got as far as
        -- raising a job, which is exactly the case when the complaint is that
        -- they were asked to pay outside TitoPay.
        job_id UUID REFERENCES titopro_jobs(id) ON DELETE SET NULL,
        category TEXT NOT NULL,
        urgent BOOLEAN NOT NULL DEFAULT FALSE,
        detail TEXT NOT NULL,
        -- Whether this reporter has ever actually hired this professional.
        -- Recorded at the time, so an operator can tell a wronged customer
        -- from a rival with an account.
        had_job BOOLEAN NOT NULL DEFAULT FALSE,
        status TEXT NOT NULL DEFAULT 'open',
        -- Which listing action came out of this report, if any.
        outcome TEXT,
        resolution_note TEXT,
        reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
        reviewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT titopro_reports_status_check
          CHECK (status IN ('open','reviewing','actioned','dismissed')),
        CONSTRAINT titopro_reports_two_parties_check
          CHECK (reporter_user_id <> professional_user_id)
      )
    `);
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_titopro_reports_reference ON titopro_reports (reference)");
    // One open report per reporter per professional. Re-reporting the same
    // person while the first is still being read adds nothing to the queue and
    // is the cheapest way to flood it.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_titopro_reports_open
      ON titopro_reports (reporter_user_id, professional_user_id)
      WHERE status IN ('open','reviewing')`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_reports_queue
      ON titopro_reports (urgent DESC, created_at ASC) WHERE status IN ('open','reviewing')`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_titopro_reports_professional
      ON titopro_reports (professional_user_id, created_at DESC)`);
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

// Tests only: forget that the schema was ensured, so a test can drop a table
// and prove the guard rebuilds it. Nothing in the running API calls this.
function resetReputationSchemaCache() {
  schemaReady = null;
}

/* ----------------------------------------------------------------- ratings */

// THE CUSTOMER SCORES THE JOB THEY PAID FOR, ONCE, AFTER IT IS FINISHED.
//
// Every one of those words is a gate:
//   - the customer, not the professional and not a passer-by;
//   - the job, so a rating always has a piece of work behind it;
//   - once, enforced by a unique index rather than by a read;
//   - after it is finished, which on TitoPro means the customer confirmed it.
//     A score before confirmation is a score for work nobody has agreed is
//     done, and it would be the professional's incentive to chase.
async function rateJob(actor, jobId, payload = {}) {
  await ensureReputationSchema();
  if (!actor?.userId) throw new AppError(401, "Sign in to rate this job");

  const { rows: jobRows } = await pool.query(
    "SELECT id, reference, status, customer_user_id, professional_user_id FROM titopro_jobs WHERE id = $1 LIMIT 1",
    [jobId]);
  const job = jobRows[0];
  // 404 rather than 403 for somebody who is not on the job: whether a
  // particular job exists is not a stranger's business.
  if (!job || (actor.userId !== job.customer_user_id && actor.userId !== job.professional_user_id)) {
    throw new AppError(404, "Job not found");
  }
  if (actor.userId !== job.customer_user_id) {
    throw new AppError(403, "Only the customer who paid for the job can rate it");
  }
  if (!job.professional_user_id) {
    throw new AppError(409, "This job was never taken by a professional, so there is nobody to rate.");
  }
  if (job.status !== "confirmed") {
    throw new AppError(409, "You can rate this job once you have confirmed the work is done.",
      { code: "job_not_confirmed", status: job.status });
  }

  const stars = Number(payload.stars);
  if (!Number.isInteger(stars) || stars < reference.RATING_MIN || stars > reference.RATING_MAX) {
    throw new AppError(400, `Choose between ${reference.RATING_MIN} and ${reference.RATING_MAX} stars`);
  }
  const comment = payload.comment
    ? boundedText(payload.comment, "Your review", { min: 0, max: 1000 })
    : "";

  // ON CONFLICT DO NOTHING rather than DO UPDATE: a second rating for the same
  // job is not an edit, it is the thing this refuses.
  const { rows } = await pool.query(
    `INSERT INTO titopro_ratings
       (id, job_id, professional_user_id, customer_user_id, stars, comment)
     VALUES ($1,$2,$3,$4,$5,NULLIF($6, ''))
     ON CONFLICT (job_id) DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), job.id, job.professional_user_id, actor.userId, stars, comment]);
  if (!rows[0]) {
    throw new AppError(409, "You have already rated this job.", { code: "already_rated" });
  }

  await writeAuditLog({
    actorType: "customer", actorId: actor.userId,
    action: "titopro_job_rated", entityType: "titopro_job", entityId: job.id,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent,
    metadata: { reference: job.reference, stars, hasComment: Boolean(comment) }
  }).catch(() => null);
  return presentRating(rows[0], { own: true });
}

// What the customer already said about this job, if anything. This is what
// lets a screen show "You rated this 5" instead of offering the form again.
async function ratingForJob(actor, jobId) {
  await ensureReputationSchema();
  const { rows } = await pool.query(
    `SELECT r.* FROM titopro_ratings r
       JOIN titopro_jobs j ON j.id = r.job_id
      WHERE r.job_id = $1 AND ($2 = j.customer_user_id OR $2 = j.professional_user_id)
      LIMIT 1`, [jobId, actor.userId]);
  return rows[0] ? presentRating(rows[0], { own: rows[0].customer_user_id === actor.userId }) : null;
}

// THE NUMBER UNDER A NAME ON THE BROWSE SCREEN.
//
// Taken in one query for every professional on the page rather than one query
// each, and never denormalised onto the profile row - a stored average is a
// number that goes wrong quietly the first time a rating is withdrawn.
async function ratingSummaries(userIds = []) {
  await ensureReputationSchema();
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT professional_user_id, COUNT(*)::int AS count, AVG(stars)::numeric AS average
       FROM titopro_ratings
      WHERE professional_user_id = ANY($1::uuid[]) AND withdrawn_at IS NULL
      GROUP BY professional_user_id`, [ids]);
  const out = new Map();
  for (const row of rows) {
    out.set(row.professional_user_id, {
      count: row.count,
      // One decimal. Two would claim a precision that eleven ratings do not
      // have, and a bare integer would round a 4.4 up to a 4.
      average: Math.round(Number(row.average) * 10) / 10
    });
  }
  return out;
}

async function ratingSummary(userId) {
  const summaries = await ratingSummaries([userId]);
  return summaries.get(userId) || { count: 0, average: null };
}

// The reviews themselves, for a professional's page. Withdrawn ratings are not
// here, and a hidden comment comes back without its words rather than as a
// gap, so the star it carries still counts on the page as it does in the
// average.
async function ratingsForProfessional(userId, { limit = 20 } = {}) {
  await ensureReputationSchema();
  const { rows } = await pool.query(
    `SELECT r.*, u.full_name AS customer_name, j.profession
       FROM titopro_ratings r
       JOIN users u ON u.id = r.customer_user_id
       JOIN titopro_jobs j ON j.id = r.job_id
      WHERE r.professional_user_id = $1 AND r.withdrawn_at IS NULL
      ORDER BY r.created_at DESC
      LIMIT $2`, [userId, Math.max(1, Math.min(100, Number(limit) || 20))]);
  return rows.map((row) => presentRating(row, { isPublic: true }));
}

/* ----------------------------------------------------------------- reports */

// A CUSTOMER TELLING TITOPAY SOMETHING IS WRONG.
//
// Open to any signed-in user rather than only to somebody who hired them,
// because the worst thing a professional can do on a marketplace - "pay me
// cash instead" - happens BEFORE any job exists, and a rule that only
// customers may report would make that report impossible to file. What the
// report carries instead is whether this person ever actually hired them, so
// an operator can weigh a wronged customer against a rival with an account.
async function reportListing(actor, professionalUserId, payload = {}) {
  await ensureReputationSchema();
  if (!actor?.userId) throw new AppError(401, "Sign in to report a listing");
  if (actor.userId === professionalUserId) {
    throw new AppError(400, "You cannot report your own listing");
  }

  // The listing has to exist, in any state. Reporting somebody whose listing
  // came down this morning is a normal thing to want to do.
  const { rows: profileRows } = await pool.query(
    "SELECT id FROM titopro_profiles WHERE user_id = $1 LIMIT 1", [professionalUserId]);
  if (!profileRows[0]) throw new AppError(404, "That listing was not found on TitoPro.");

  const category = requireEnum(payload.category, reference.REPORT_CATEGORY_KEYS, "Reason");
  const detail = boundedText(payload.detail, "What happened", { min: 5, max: 2000 });

  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM titopro_reports WHERE reporter_user_id = $1 AND created_at > NOW() - INTERVAL '1 day'",
    [actor.userId]);
  if (countRows[0].count >= REPORTS_PER_DAY) {
    throw new AppError(429, "You have reported a lot of listings today. Contact TitoPay support so someone can help you directly.",
      { code: "report_limit" });
  }

  // Was this reporter ever a customer of this professional? Any job at all
  // counts, including one that was cancelled - being let down before the work
  // started is one of the things being reported.
  const { rows: jobRows } = await pool.query(
    `SELECT id FROM titopro_jobs
      WHERE customer_user_id = $1 AND professional_user_id = $2
      ORDER BY created_at DESC LIMIT 1`, [actor.userId, professionalUserId]);
  const hadJob = Boolean(jobRows[0]);
  // A job id sent from the app is only trusted if it really is this reporter's
  // job with this professional; anything else is dropped rather than refused,
  // because a wrong id must not stop a report being filed.
  let jobId = null;
  if (payload.jobId) {
    const { rows: named } = await pool.query(
      "SELECT id FROM titopro_jobs WHERE id = $1 AND customer_user_id = $2 AND professional_user_id = $3 LIMIT 1",
      [payload.jobId, actor.userId, professionalUserId]);
    jobId = named[0]?.id || null;
  }
  if (!jobId && hadJob) jobId = jobRows[0].id;

  let inserted = null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO titopro_reports
         (id, reference, professional_user_id, reporter_user_id, job_id, category, urgent, detail, had_job)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [crypto.randomUUID(), reportReference(), professionalUserId, actor.userId, jobId,
        category, reference.isUrgentReport(category), detail, hadJob]);
    inserted = rows[0];
  } catch (error) {
    // The partial unique index. Said plainly rather than as a database error,
    // because the person reading it has just tried to report the same person
    // twice and needs to know the first one was not lost.
    if (error?.code === "23505") {
      throw new AppError(409, "You have already reported this listing. TitoPay is looking at it.",
        { code: "report_already_open" });
    }
    throw error;
  }

  await writeAuditLog({
    actorType: "customer", actorId: actor.userId,
    action: "titopro_listing_reported", entityType: "titopro_profile", entityId: profileRows[0].id,
    ipAddress: actor.ipAddress, userAgent: actor.userAgent,
    // The words the reporter wrote are NOT copied into the audit log. They are
    // an untested accusation about a named person and they already live on the
    // report row, where the people who may read them are the ones who can act.
    metadata: { reference: inserted.reference, category, urgent: inserted.urgent, hadJob }
  }).catch(() => null);
  return presentReport(inserted, { reporter: true });
}

// What this reporter has already sent about this professional, so the app can
// say "you reported this" rather than offering the form again.
async function myReportFor(actor, professionalUserId) {
  await ensureReputationSchema();
  const { rows } = await pool.query(
    `SELECT * FROM titopro_reports
      WHERE reporter_user_id = $1 AND professional_user_id = $2
      ORDER BY created_at DESC LIMIT 1`, [actor.userId, professionalUserId]);
  return rows[0] ? presentReport(rows[0], { reporter: true }) : null;
}

/* ------------------------------------------------------------ the operator */

// THE QUEUE. Dangerous first, then oldest first - a report about somebody
// being threatened does not wait behind a fortnight of "he was late".
async function reportQueue({ status = "open", limit = 100 } = {}) {
  await ensureReputationSchema();
  const wanted = status === "all" ? reference.REPORT_STATUSES : [requireEnum(status, reference.REPORT_STATUSES, "Status")];
  const { rows } = await pool.query(
    `SELECT r.*,
            pro.full_name AS professional_name,
            rep.full_name AS reporter_name,
            p.status AS listing_status,
            p.admin_action AS listing_admin_action,
            (SELECT COUNT(*)::int FROM titopro_reports x
              WHERE x.professional_user_id = r.professional_user_id) AS reports_against_total
       FROM titopro_reports r
       JOIN users pro ON pro.id = r.professional_user_id
       JOIN users rep ON rep.id = r.reporter_user_id
       LEFT JOIN titopro_profiles p ON p.user_id = r.professional_user_id
      WHERE r.status = ANY($1::text[])
      ORDER BY r.urgent DESC, r.created_at ASC
      LIMIT $2`, [wanted, Math.max(1, Math.min(300, Number(limit) || 100))]);
  return rows.map((row) => presentReport(row, { admin: true }));
}

// Everything ever said about one professional, which is the view an operator
// needs before deciding whether one complaint is a pattern.
async function reportsForProfessional(userId) {
  await ensureReputationSchema();
  const { rows } = await pool.query(
    `SELECT r.*, rep.full_name AS reporter_name
       FROM titopro_reports r
       JOIN users rep ON rep.id = r.reporter_user_id
      WHERE r.professional_user_id = $1
      ORDER BY r.created_at DESC LIMIT 200`, [userId]);
  return rows.map((row) => presentReport(row, { admin: true }));
}

// CLOSING A REPORT IS A DECISION, SO IT IS WRITTEN DOWN.
//
// Dismissing needs a note exactly as actioning does: "we looked and there was
// nothing in it" is a finding, and a queue where rows can be cleared silently
// is a queue nobody can audit afterwards.
async function resolveReport(admin, reportId, payload = {}) {
  await ensureReputationSchema();
  if (!admin?.userId) throw new AppError(401, "Authentication required");
  const status = requireEnum(payload.status, ["reviewing", "actioned", "dismissed"], "Status");
  const note = status === "reviewing"
    ? (payload.note ? boundedText(payload.note, "Note", { min: 0, max: 2000 }) : "")
    : boundedText(payload.note, "What you decided", { min: 3, max: 2000 });

  const { rows } = await pool.query(
    `UPDATE titopro_reports
        SET status = $2,
            resolution_note = NULLIF($3, ''),
            outcome = COALESCE(NULLIF($4, ''), outcome),
            reviewed_by = $5,
            reviewed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [reportId, status, note, payload.outcome ? String(payload.outcome).slice(0, 40) : "", admin.userId]);
  if (!rows[0]) throw new AppError(404, "Report not found");

  await writeAuditLog({
    actorType: "admin", actorId: admin.userId,
    action: "titopro_report_resolved", entityType: "titopro_report", entityId: rows[0].id,
    ipAddress: admin.ipAddress, userAgent: admin.userAgent,
    metadata: { reference: rows[0].reference, status, outcome: rows[0].outcome || null }
  }).catch(() => null);
  return presentReport(rows[0], { admin: true });
}

// Every open report about one professional, closed in one go with the listing
// decision recorded against each. Called when an operator acts on a listing,
// so the queue reflects what was actually done rather than being cleared by
// hand afterwards - and so that deciding there was nothing in a complaint
// closes it as DISMISSED rather than as an action nobody took.
async function closeOpenReportsFor(admin, professionalUserId, { outcome, note, status = "actioned" } = {}) {
  await ensureReputationSchema();
  const resolvedStatus = requireEnum(status, ["actioned", "dismissed"], "Status");
  const { rows } = await pool.query(
    `UPDATE titopro_reports
        SET status = $5, outcome = $3, resolution_note = $4,
            reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
      WHERE professional_user_id = $1 AND status IN ('open','reviewing')
      RETURNING id`,
    [professionalUserId, admin?.userId || null, String(outcome || "").slice(0, 40),
      boundedText(note || "Listing action taken.", "Note", { min: 0, max: 2000 }), resolvedStatus]);
  return rows.length;
}

// MODERATING ONE RATING.
//
// Three actions and no delete. `hide_comment` takes down words TitoPay will
// not publish and leaves the star standing; `withdraw` takes the whole rating
// out of the average, for a rating found to be fraudulent; `restore` undoes
// either. A reason is required for all three, including restoring, because
// putting something back is as much a decision as taking it down.
async function moderateRating(admin, ratingId, payload = {}) {
  await ensureReputationSchema();
  if (!admin?.userId) throw new AppError(401, "Authentication required");
  const action = requireEnum(payload.action, ["hide_comment", "withdraw", "restore"], "Action");
  const reason = boundedText(payload.reason, "Reason", { min: 3, max: 1000 });

  const sets = {
    hide_comment: "comment_hidden_at = NOW(), comment_hidden_reason = $3",
    withdraw: "withdrawn_at = NOW(), withdrawn_reason = $3",
    restore: "comment_hidden_at = NULL, comment_hidden_reason = NULL, withdrawn_at = NULL, withdrawn_reason = $3"
  };
  const { rows } = await pool.query(
    `UPDATE titopro_ratings SET ${sets[action]}, moderated_by = $2 WHERE id = $1 RETURNING *`,
    [ratingId, admin.userId, reason]);
  if (!rows[0]) throw new AppError(404, "Rating not found");

  await writeAuditLog({
    actorType: "admin", actorId: admin.userId,
    action: `titopro_rating_${action}`, entityType: "titopro_rating", entityId: rows[0].id,
    ipAddress: admin.ipAddress, userAgent: admin.userAgent,
    metadata: { professionalUserId: rows[0].professional_user_id, stars: rows[0].stars }
  }).catch(() => null);
  return presentRating(rows[0], { admin: true });
}

/* ----------------------------------------------------------------- helpers */

// A CUSTOMER IS NAMED BY THEIR FIRST NAME AND NOTHING ELSE.
//
// A review on a public page beside a full surname is more than the reviewer
// agreed to hand over, and on a page about a tradesman who knows where they
// live it is a safety question rather than a privacy one.
function firstName(fullName) {
  const text = String(fullName || "").trim();
  if (!text) return "A TitoPay customer";
  return text.split(/\s+/)[0];
}

function presentRating(row, { own = false, admin = false, isPublic = false } = {}) {
  const hidden = Boolean(row.comment_hidden_at);
  return {
    id: row.id,
    jobId: row.job_id,
    stars: row.stars,
    word: reference.ratingWord(row.stars),
    // The comment is dropped rather than blanked for everybody except the
    // operator deciding about it and the customer who wrote it.
    comment: hidden && !(admin || own) ? null : (row.comment || null),
    commentHidden: hidden,
    createdAt: row.created_at,
    ...(isPublic || admin ? {
      by: firstName(row.customer_name),
      profession: row.profession ? (reference.profession(row.profession)?.label || row.profession) : null
    } : {}),
    ...(admin ? {
      professionalUserId: row.professional_user_id,
      customerUserId: row.customer_user_id,
      withdrawn: Boolean(row.withdrawn_at),
      withdrawnReason: row.withdrawn_reason || "",
      commentHiddenReason: row.comment_hidden_reason || ""
    } : {})
  };
}

function presentReport(row, { reporter = false, admin = false } = {}) {
  const category = reference.reportCategory(row.category);
  return {
    id: row.id,
    reference: row.reference,
    category: row.category,
    categoryLabel: category?.label || row.category,
    urgent: row.urgent,
    status: row.status,
    createdAt: row.created_at,
    // The reporter sees what they wrote. Nobody else outside the console does.
    ...(reporter || admin ? { detail: row.detail, jobId: row.job_id } : {}),
    ...(admin ? {
      professionalUserId: row.professional_user_id,
      professionalName: row.professional_name || null,
      reporterUserId: row.reporter_user_id,
      reporterName: row.reporter_name || null,
      hadJob: row.had_job,
      listingStatus: row.listing_status || null,
      listingAdminAction: row.listing_admin_action || null,
      reportsAgainstTotal: row.reports_against_total,
      outcome: row.outcome || "",
      resolutionNote: row.resolution_note || "",
      reviewedAt: row.reviewed_at
    } : {})
  };
}

module.exports = {
  REPORTS_PER_DAY,
  closeOpenReportsFor,
  ensureReputationSchema,
  moderateRating,
  myReportFor,
  rateJob,
  ratingForJob,
  ratingsForProfessional,
  ratingSummaries,
  ratingSummary,
  reportListing,
  reportQueue,
  reportsForProfessional,
  resetReputationSchemaCache,
  resolveReport
};
