"use strict";

// TITOPRO: THE VOCABULARY.
//
// TitoPro is where somebody hires a professional - a plumber, a painter, a
// cleaner, a freelancer - and pays for the work through TitoPay.
//
// THE ONE IDEA THIS FILE EXISTS FOR IS SHAPE.
//
// It is tempting to treat every one of these as "a service you book", and that
// is wrong in a way that breaks the product on contact with a real customer.
// TitoPay Book answers "a resource with capacity, for a span of time", and
// book_services_duration_check caps that span at 1440 minutes. A plumber fits
// it exactly. A painter on a three-day job does not, and forcing one in would
// have the diary reporting a painter free on Tuesday afternoon while they are
// up a ladder in somebody's lounge.
//
// So every service here declares how it is actually fulfilled:
//
//   callout    One visit, measured in hours, finished the same day. This is a
//              slot, and it runs on the existing booking engine unchanged.
//
//   recurring  The same visit on a repeat - a cleaner every Tuesday, a garden
//              service every fortnight. Each visit IS a slot, so the engine still
//              works; what is new is the series that generates them and the
//              agreement that spans it.
//
//   project    Quoted work that runs over days. There is no slot to hold. What
//              is agreed is a price, a start date and what "finished" means.
//              Putting this in a calendar would be a promise nobody can keep.
//
//   remote     No address and no calendar at all. A bookkeeper or a designer
//              is hired against a brief and paid against milestones.
//
// Only `callout` is fully served by what TitoPay has today. The other three
// are why TitoPro needs a job record of its own rather than a longer list of
// Book categories.
//
// Like book-reference.js, this is APPLICATION CONFIGURATION rather than a
// database constraint: adding a profession must be a deploy, not a migration.

/* -------------------------------------------------------------- the shapes */

const SHAPES = Object.freeze(["callout", "recurring", "project", "remote"]);

// What a customer is agreeing to, in each shape's own words. These reach the
// screen, so they are written for the person paying rather than for us.
const SHAPE_COPY = Object.freeze({
  callout: {
    label: "Call-out",
    bookingWord: "Job",
    priceBasis: "Quoted per job",
    says: "One visit. You choose a time, they arrive, the job is done that day."
  },
  recurring: {
    label: "Regular visits",
    bookingWord: "Visit",
    priceBasis: "Quoted per visit",
    says: "The same visit on a repeat. Agree a day and a rate, change or stop it whenever you want."
  },
  project: {
    label: "Project",
    bookingWord: "Project",
    priceBasis: "Quoted for the work",
    says: "Work that runs over days. You agree a price and a start date, not a time slot."
  },
  remote: {
    label: "Remote",
    bookingWord: "Brief",
    priceBasis: "Quoted for the brief",
    says: "No visit. Agree what is being delivered and by when."
  }
});

/* --------------------------------------------------------- the professions */

// VETTING IS NOT THE SAME QUESTION FOR EVERY PROFESSION.
//
// "standard" is identity: the person is who they say they are, which is FICA
// and what TitoPay already does for every account.
//
// "enhanced" is for work that puts someone alone in an empty house with the
// keys, or alone with somebody's child. Identity is not sufficient there, and
// a marketplace that lists a cleaner beside a plumber on the same checks has
// made a decision about a stranger's home without noticing it was making one.
// The flag exists so that decision is explicit and visible in the catalogue;
// what enhanced vetting REQUIRES - police clearance, references, how often it
// is renewed - is a policy question for the business, not a constant here.
const VETTING = Object.freeze(["standard", "enhanced"]);

// WHAT "ENHANCED" ACTUALLY REQUIRES.
//
// FICA answers "is this person who they say they are". It is an identity
// check and it is NOT a background check - somebody can be perfectly
// identified and still be unsuitable to be alone with a child.
//
// THE PERIODS BELOW ARE DEFAULTS, NOT LAW. How long a clearance stays good
// for is a policy decision for the business and its compliance advisers; a
// SAPS certificate has no statutory shelf life and employers commonly treat
// one as current for somewhere between six months and two years. They sit in
// configuration so changing them is a deploy rather than a migration, and so
// the figure being used is visible rather than buried in a validation branch.
const VETTING_CHECKS = Object.freeze([
  { key: "police_clearance", label: "Police clearance", validDays: 365,
    says: "A SAPS Police Clearance Certificate, dated within the last year." },
  { key: "reference_check", label: "References", validDays: 730,
    says: "Two contactable references from previous work of the same kind." }
]);

const VETTING_CHECK_KEYS = Object.freeze(VETTING_CHECKS.map((item) => item.key));

// Applied to every profession marked `enhanced`. If one of them ever needs a
// different set - a tutor working with matric pupils, say, against a cleaner
// with a set of keys - give that profession its own requiredChecks array and
// requiredChecksFor will use it instead.
const ENHANCED_VETTING_CHECKS = Object.freeze(["police_clearance", "reference_check"]);

function vettingCheck(key) {
  return VETTING_CHECKS.find((item) => item.key === key) || null;
}

// The checks a person must have cleared before this profession may be listed.
// An empty list means identity alone is enough, which is the case for every
// profession that does not put somebody alone with a child or a set of keys.
function requiredChecksFor(professionKey) {
  const item = PROFESSIONS.find((entry) => entry.key === professionKey);
  if (!item || item.vetting !== "enhanced") return [];
  return Array.isArray(item.requiredChecks) ? item.requiredChecks : ENHANCED_VETTING_CHECKS;
}

const PROFESSIONS = Object.freeze([
  // -- Home repairs. One visit, a few hours, finished the same day. ---------
  { key: "plumber", label: "Plumber", group: "Home repairs", shape: "callout", bookCategory: "plumber",
    vetting: "standard", certificate: "conditional",
    hint: "Burst pipes, geysers, blocked drains, leaking taps" },
  { key: "electrician", label: "Electrician", group: "Home repairs", shape: "callout", bookCategory: "electrician",
    vetting: "standard", certificate: "required",
    hint: "Faults, DB boards, plugs and lights, certificates of compliance" },
  { key: "appliance_technician", label: "Appliance technician", group: "Home repairs", shape: "callout", bookCategory: "appliance_repair",
    vetting: "standard", certificate: "none",
    hint: "Fridges, washing machines, stoves and ovens" },
  { key: "handyman", label: "Handyman", group: "Home repairs", shape: "callout", bookCategory: "handyman",
    vetting: "standard", certificate: "none",
    hint: "Small repairs, mounting, assembly, odd jobs" },
  { key: "locksmith", label: "Locksmith", group: "Home repairs", shape: "callout", bookCategory: null,
    vetting: "enhanced", certificate: "none",
    hint: "Lockouts, lock changes, keys cut on site" },

  // -- Home improvement. Days, not hours. No slot to hold. ------------------
  { key: "painter", label: "Painter", group: "Home improvement", shape: "project", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Interior and exterior painting, prep and finishing" },
  { key: "carpenter", label: "Carpenter", group: "Home improvement", shape: "project", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Built-in cupboards, doors, decking, repairs in wood" },
  { key: "tiler", label: "Tiler", group: "Home improvement", shape: "project", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Floors, walls, bathrooms, waterproofing" },
  { key: "paving", label: "Paving", group: "Home improvement", shape: "project", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Driveways, walkways, retaining and kerbs" },

  // -- Home care. The same visit, again and every week. ---------------------
  { key: "cleaner", label: "Cleaner", group: "Home care", shape: "recurring", bookCategory: null,
    vetting: "enhanced", certificate: "none",
    hint: "Home and office cleaning, once off or every week" },
  { key: "garden_service", label: "Garden service", group: "Home care", shape: "recurring", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Lawns, hedges, refuse removal, seasonal clearing" },
  { key: "pool_service", label: "Pool service", group: "Home care", shape: "recurring", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Weekly cleaning, chemicals, pumps and filters" },
  // DAY NANNY WAS HERE AND WAS WITHDRAWN.
  //
  // Childcare is not a harder version of cleaning, it is a different
  // undertaking: a marketplace that introduces somebody to a child carries a
  // duty that a police clearance and two references do not discharge, and it
  // carries it every day the arrangement continues rather than for the hours
  // of one job. TitoPro is not set up for that and should not pretend to be.
  //
  // Left as a note rather than deleted silently so the next person to think
  // "we should add nannies" finds the reasoning instead of the idea.

  // -- Professional. No address and no calendar. ----------------------------
  { key: "bookkeeper", label: "Bookkeeper", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Books, VAT, payroll and SARS submissions" },
  { key: "designer", label: "Designer", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Logos, branding, social media and print" },
  { key: "it_support", label: "IT support", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Computers, networks, websites and email" },
  { key: "graphic_designer", label: "Graphic designer", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Logos, packaging, adverts, brand and print artwork" },
  { key: "web_developer", label: "Web developer", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Websites, online shops, hosting and domains" },
  { key: "tutor", label: "Tutor", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "enhanced", certificate: "none",
    hint: "School subjects, matric and tertiary" },
  { key: "virtual_assistant", label: "Virtual assistant", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Admin, diary, email and customer follow-up" },

  // "OTHER" IS A DOOR, AND A DOOR NEEDS A LOCK.
  //
  // It is the right thing to offer: the list above cannot name every trade in
  // South Africa, and a welder or a signwriter should not be turned away
  // because nobody thought of them. But an unnamed service is one nobody can
  // categorise, price or vet, so it carries two conditions that no other
  // profession does:
  //
  //   1. it is the only profession that REQUIRES the professional to say what
  //      the work actually is - see otherServiceIsAllowed and
  //      titopro-profile-service, which refuse to publish without it;
  //   2. what they write is checked against the work TitoPay has decided not
  //      to carry. Childcare was withdrawn deliberately (see the note above
  //      where day_nanny used to be) and "Other" is exactly how it would come
  //      back - as a free-text listing with no checks at all, which is worse
  //      than the tile that was removed.
  //
  // `remote` because the shape cannot be known in advance, and remote is the
  // only shape that promises the customer nothing about a diary slot.
  { key: "other", label: "Other", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Something else — tell customers what you do" }
]);

// WORK TITOPAY HAS DECIDED NOT TO CARRY, matched against what somebody writes
// in the "Other" box.
//
// This is not a content filter and does not try to be clever. It is a short,
// specific list of the one category that was withdrawn on purpose, in the
// words a person would actually use, so that the decision survives the
// existence of a free-text field. Anything it catches is refused with the
// reason said out loud rather than silently dropped.
const WITHDRAWN_WORK = Object.freeze([
  { match: /\b(nanny|nannies|au ?pair|child ?min[dp]er|babysit\w*|baby ?sit\w*|creche|cr[eè]che|day ?care|daycare|child ?care|childcare)\b/i,
    says: "TitoPay does not carry childcare. Introducing somebody to a child is a duty a police clearance does not discharge, and TitoPro is not set up for it." }
]);

// What a professional wrote in the "Other" box, weighed against that list.
// Returns { allowed, says } so the caller can refuse with the reason rather
// than with a generic rejection.
function otherServiceIsAllowed(description) {
  const text = String(description || "");
  for (const entry of WITHDRAWN_WORK) {
    if (entry.match.test(text)) return { allowed: false, says: entry.says };
  }
  return { allowed: true, says: "" };
}

// Whether this profession makes the free-text description compulsory. Asked
// as a question rather than compared to a string, so a second open-ended
// profession later needs no new branch at any call site.
function requiresOwnDescription(key) {
  return String(key || "") === "other";
}

/* ------------------------------------------------------------ job statuses */

// TitoPro's own vocabulary, so unlike the profession list this IS constrained
// in the database - under a named constraint, so it can be widened later
// without rewriting the table.
//
// re_quoted is here because of what happens on site. A plumber lifts a drain
// cover and finds a cracked pipe; the R850 job is now R2 400. Without a state
// for that the professional either works for free or argues in a chat thread,
// and the agreed figure silently stops matching the work.
const JOB_STATUSES = Object.freeze([
  "requested",   // customer has described the work; no price yet
  "quoted",      // a price has been named and sent
  "re_quoted",   // scope changed after the work started; the customer must agree again
  "accepted",    // the customer took the quote
  "scheduled",   // a callout or recurring job has a slot
  "in_progress", // the professional has started
  "work_done",   // the professional says it is finished; the customer has not agreed yet
  "confirmed",   // the customer signed off
  "declined",    // the quote was refused
  "cancelled",   // called off before the work started
  "expired",     // the quote lapsed with no answer
  "disputed"     // the two sides disagree about the work
]);

// A job in one of these is finished as far as the work is concerned.
const TERMINAL_JOB_STATUSES = Object.freeze(["confirmed", "declined", "cancelled", "expired"]);

// Statuses where the professional's time is committed - what a diary must
// treat as taken.
const COMMITTED_JOB_STATUSES = Object.freeze(["accepted", "scheduled", "in_progress", "work_done"]);

/* ------------------------------------------------------- rating and reports */

// WHAT A STAR RATING IS ALLOWED TO MEAN HERE.
//
// One rating per JOB, by the customer who paid for it, only once the job is
// confirmed. Every other arrangement is worse: a rating per profile invites
// somebody who never hired anybody to leave one, a rating that can be rewritten
// invites a professional to trade a discount for a better score, and a rating
// before confirmation is a score for work nobody has agreed is finished.
const RATING_MIN = 1;
const RATING_MAX = 5;

// The word next to the number, so a screen does not have to invent one and two
// screens cannot invent different ones.
const RATING_WORDS = Object.freeze({
  1: "Poor",
  2: "Not good",
  3: "Fine",
  4: "Good",
  5: "Excellent"
});

function ratingWord(stars) {
  return RATING_WORDS[Number(stars)] || "";
}

// WHY A CUSTOMER IS REPORTING A LISTING.
//
// Written in the words a customer would use, not ours, because the person
// choosing one of these has just had a bad experience and will not translate.
//
// `urgent` decides what an operator is shown first. It does NOT suspend
// anything by itself: a report is an accusation, and a listing that comes down
// on an accusation alone is a listing any competitor can take down. Every
// suspension on TitoPro is a decision a named person made.
const REPORT_CATEGORIES = Object.freeze([
  { key: "off_platform_payment", label: "Asked me to pay outside TitoPay", urgent: true,
    says: "They wanted cash or an EFT instead of paying through the app." },
  { key: "impersonation", label: "Not who they say they are", urgent: true,
    says: "The person who arrived was not the person on the listing." },
  { key: "unsafe", label: "Unsafe or dangerous", urgent: true,
    says: "The work or their behaviour put someone at risk." },
  { key: "harassment", label: "Threatening or abusive", urgent: true,
    says: "They were abusive, threatening or would not leave." },
  { key: "no_show", label: "Did not arrive", urgent: false,
    says: "They accepted the job and never came." },
  { key: "poor_work", label: "Work was not done properly", urgent: false,
    says: "The work was left unfinished or badly done." },
  { key: "overcharged", label: "Charged more than quoted", urgent: false,
    says: "The final price did not match what was agreed." },
  { key: "not_qualified", label: "Not qualified for the work", urgent: false,
    says: "No certificate, or clearly not trained for what they took on." },
  { key: "other", label: "Something else", urgent: false,
    says: "Tell us what happened." }
]);

const REPORT_CATEGORY_KEYS = Object.freeze(REPORT_CATEGORIES.map((item) => item.key));

function reportCategory(key) {
  return REPORT_CATEGORIES.find((item) => item.key === key) || null;
}

function isReportCategory(key) {
  return REPORT_CATEGORY_KEYS.includes(String(key || ""));
}

function isUrgentReport(key) {
  return Boolean(reportCategory(key)?.urgent);
}

// Where a report can get to. `reviewing` exists so two operators do not work
// the same report at once, and `dismissed` exists because most reports are not
// takedowns and closing one has to be a recorded decision rather than a row
// quietly left open forever.
const REPORT_STATUSES = Object.freeze(["open", "reviewing", "actioned", "dismissed"]);

// WHAT AN OPERATOR CAN DO TO A LISTING.
//
// `approved` is the absence of an action rather than a state of its own - it
// clears whatever was applied and hands the listing back to the professional,
// who still has to satisfy FICA and vetting to put it live again. Approving
// does NOT publish somebody; nothing an operator does here can put a listing in
// front of customers that would not have been allowed there anyway.
//
// `removed` is not a delete. The listing stops being findable and stays on
// file, because the reports, the jobs and the reasoning behind a takedown are
// exactly what gets asked for months later.
const LISTING_ADMIN_ACTIONS = Object.freeze(["approve", "suspend", "remove"]);
const LISTING_ADMIN_STATES = Object.freeze(["suspended", "removed"]);

/* ---------------------------------------------------------------- the fees */

// Named here so a screen and the pricing engine cannot quote different codes.
// The FIGURES live in the approved pricing schedule and nowhere else, because
// an operator has to be able to change a fee without a deploy.
const CUSTOMER_FEE_CODE = "titopro_customer_fee";
const PROFESSIONAL_FEE_CODE = "titopro_professional_fee";

/* ------------------------------------------------------------------ lookup */

const PROFESSION_KEYS = Object.freeze(PROFESSIONS.map((item) => item.key));
const PROFESSION_GROUPS = Object.freeze([...new Set(PROFESSIONS.map((item) => item.group))]);

function isProfession(key) {
  return PROFESSION_KEYS.includes(String(key || ""));
}

function profession(key) {
  return PROFESSIONS.find((item) => item.key === key) || null;
}

function shapeOf(key) {
  return profession(key)?.shape || null;
}

function isJobStatus(status) {
  return JOB_STATUSES.includes(String(status || ""));
}

function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(String(status || ""));
}

function commitsTime(status) {
  return COMMITTED_JOB_STATUSES.includes(String(status || ""));
}

// Whether this profession can be put in the booking diary at all. A project or
// a remote brief cannot: there is no span to hold.
function usesBookingDiary(key) {
  const shape = shapeOf(key);
  return shape === "callout" || shape === "recurring";
}

function requiresEnhancedVetting(key) {
  return profession(key)?.vetting === "enhanced";
}

module.exports = {
  WITHDRAWN_WORK,
  otherServiceIsAllowed,
  requiresOwnDescription,
  RATING_MIN,
  RATING_MAX,
  RATING_WORDS,
  ratingWord,
  REPORT_CATEGORIES,
  REPORT_CATEGORY_KEYS,
  REPORT_STATUSES,
  LISTING_ADMIN_ACTIONS,
  LISTING_ADMIN_STATES,
  reportCategory,
  isReportCategory,
  isUrgentReport,
  ENHANCED_VETTING_CHECKS,
  VETTING_CHECKS,
  VETTING_CHECK_KEYS,
  requiredChecksFor,
  vettingCheck,
  SHAPES,
  SHAPE_COPY,
  VETTING,
  PROFESSIONS,
  PROFESSION_KEYS,
  PROFESSION_GROUPS,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  COMMITTED_JOB_STATUSES,
  CUSTOMER_FEE_CODE,
  PROFESSIONAL_FEE_CODE,
  isProfession,
  profession,
  shapeOf,
  isJobStatus,
  isTerminalJobStatus,
  commitsTime,
  usesBookingDiary,
  requiresEnhancedVetting
};
