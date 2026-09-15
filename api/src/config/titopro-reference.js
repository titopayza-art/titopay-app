"use strict";

// TITOPRO: THE VOCABULARY.
//
// TitoPro is where somebody hires a professional - a plumber, a painter, a
// cleaner, a day nanny, a freelancer - and pays for the work through TitoPay.
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
//   recurring  The same visit on a repeat - a cleaner every Tuesday, a nanny
//              five mornings a week. Each visit IS a slot, so the engine still
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
// "enhanced" is for work that puts someone alone with a child or alone in an
// empty house with the keys. Identity is not sufficient there, and a
// marketplace that lists a day nanny beside a plumber on the same checks has
// made a decision about children's safety without noticing it was making one.
// The flag exists so that decision is explicit and visible in the catalogue;
// what enhanced vetting REQUIRES - police clearance, references, how often it
// is renewed - is a policy question for the business, not a constant here.
const VETTING = Object.freeze(["standard", "enhanced"]);

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
  { key: "day_nanny", label: "Day nanny", group: "Home care", shape: "recurring", bookCategory: null,
    vetting: "enhanced", certificate: "none",
    hint: "Daytime childcare in your home, by the day or the week" },

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
  { key: "tutor", label: "Tutor", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "enhanced", certificate: "none",
    hint: "School subjects, matric and tertiary" },
  { key: "virtual_assistant", label: "Virtual assistant", group: "Professional", shape: "remote", bookCategory: null,
    vetting: "standard", certificate: "none",
    hint: "Admin, diary, email and customer follow-up" }
]);

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
