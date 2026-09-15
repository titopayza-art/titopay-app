"use strict";

// ---------------------------------------------------------------------------
// The wording on Limits & Verification
//
// The NUMBERS on that screen have been admin-editable since the limit engine
// shipped: they live in platform_settings under compliance_tier_limits,
// versioned and reversible. The SENTENCES around them were not. They were
// hard-coded in the API and the app bundle, which meant that changing what
// TitoPay says about its own limits — the one part of that screen a compliance
// review is most likely to want changed, and to want changed quickly — needed
// a code change, a build and two uploads.
//
// That is the wrong way round. A number is checked by a form; a sentence is
// checked by a person, and the person who checks it should be able to fix it.
//
// The defaults below are the copy that is live today, word for word, so
// shipping this changes nothing a customer reads until an admin edits it.
//
// THREE RULES, and most of this file exists to keep them:
//
//   1. NOTHING MAY COME BACK BLANK. An emptied field falls back to its
//      default. A limits screen with no disclaimer is worse than one with an
//      old disclaimer, because the disclaimer is the sentence that says these
//      amounts are TitoPay's and not the law's.
//   2. NOTHING MAY FAIL HARD ON READ. A database problem serves the defaults.
//      The app also keeps its own copy, so it renders correctly with no
//      network at all.
//   3. THE COMPLIANCE CAVEATS CANNOT BE DELETED. The top level's note and the
//      disclaimer are the two sentences that stop a limit reading as a promise
//      or as a statutory threshold. An admin may reword them; an admin may not
//      empty them, and may not save wording that claims a regulator set or
//      approved an amount.
//
// The stored text is admin-authored and rendered in the customer app, so it is
// escaped at render time by the PWA's esc(). This service caps lengths and
// screens for forbidden claims; it does not sanitise HTML, and callers must
// not treat what it returns as safe markup.
// ---------------------------------------------------------------------------

const { AppError } = require("../lib/errors");
const {
  getPlatformSetting,
  getPlatformSettingRecord,
  setPlatformSetting
} = require("./platform-settings-service");

const LIMITS_CONTENT_KEY = "limits_screen_content";

// Word for word what the screen says today.
const LIMITS_CONTENT_DEFAULTS = {
  // The sentence under the heading. Attributes the limits to TitoPay's own
  // framework rather than to a regulator.
  lead: "Your limits depend on your verification status, risk profile and applicable TitoPay compliance requirements.",
  // The small print under the limit rows.
  disclaimer: "These are TitoPay operational limits based on its risk management and compliance framework. They are not statutory thresholds.",
  // Shown against a level that has no fixed monthly limit. It carries what
  // still applies, which is what stops "no fixed limit" reading as "no
  // controls".
  topLevelNote: "No fixed monthly transaction limit. Risk assessment, transaction monitoring and applicable TitoPay compliance requirements still apply.",
  // Under the call to action, for a customer who can still move up a level.
  upgradeHint: "Complete full verification to become eligible for higher limits, subject to TitoPay's risk and compliance requirements.",
  // Under the call to action for a customer already at the top level.
  atTopHint: "You are at TitoPay's highest verification level. Higher capability may still be reviewed against your risk profile and ongoing monitoring."
};

const FIELDS = Object.keys(LIMITS_CONTENT_DEFAULTS);
const MAX_LENGTH = 400;

// Fields whose whole purpose is to carry a caveat. Emptying one is refused
// rather than silently defaulted, so an admin cannot believe they removed a
// sentence that is in fact still being served.
const CAVEAT_FIELDS = ["disclaimer", "topLevelNote"];

// WHAT NO SAVED SENTENCE MAY CLAIM. None of TitoPay's limits is a statutory
// threshold, none has been approved by a regulator, and cash-threshold
// reporting is a different regime that does not govern an electronic wallet
// limit. An admin rewording this copy must not be able to introduce a claim
// the platform cannot support, whether by mistake or by enthusiasm.
const FORBIDDEN_CLAIMS = [
  [/\b(FICA|SARB|FSCA|PASA|FIC)\b[^.]{0,40}\b(limit|allows?|threshold|requires?)\b/i,
    "This wording states that a regulator sets or allows the amount. These are TitoPay operational limits."],
  [/\bstatutory\b[^.]{0,20}\b(limit|threshold|amount)/i,
    "This wording describes the amount as statutory. It is not."],
  [/\b(required|allowed|permitted|mandated) by law\b/i,
    "This wording says the limit is required by law. It is a TitoPay product limit."],
  [/\bcash threshold\b/i,
    "Cash-threshold reporting is a different regime and does not describe an electronic wallet limit."],
  [/\bapproved by\b[^.]{0,30}\b(regulator|SARB|FSCA|FIC|Reserve Bank)\b/i,
    "TitoPay has no documented regulatory approval for a specific amount, so the copy must not claim one."],
  [/\bunlimited\b/i,
    "No level is unlimited. Use \"no fixed monthly transaction limit\" and keep the controls that still apply."]
];

// A DENIAL IS NOT A CLAIM, and the two read almost identically to a regular
// expression. "They are not statutory thresholds" is the sentence that makes
// this screen correct; "This is the statutory threshold" is the one that makes
// it wrong, and they differ by one word. Every match is therefore checked
// against the words immediately before it, so the correct copy is not refused
// by the guard that exists to protect it.
const NEGATORS = /\b(not|never|no|neither|nor|isn't|aren't|is not|are not)\b[^.]{0,24}$/i;

function claimIsNegated(text, index) {
  return NEGATORS.test(text.slice(Math.max(0, index - 40), index));
}

function forbiddenClaimIn(text) {
  for (const [pattern, why] of FORBIDDEN_CLAIMS) {
    const match = new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(text);
    if (match && !claimIsNegated(text, match.index)) return why;
  }
  return null;
}

function cleanLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_LENGTH);
}

// Rule 1: an emptied or missing field serves its default rather than "".
function mergeWithDefaults(stored) {
  const merged = { ...LIMITS_CONTENT_DEFAULTS };
  if (stored && typeof stored === "object") {
    for (const field of FIELDS) {
      const text = cleanLine(stored[field]);
      if (text) merged[field] = text;
    }
  }
  return merged;
}

function normalizeForSave(payload = {}) {
  const next = {};
  for (const field of FIELDS) {
    const text = cleanLine(payload[field]);
    if (!text) {
      if (CAVEAT_FIELDS.includes(field)) {
        throw new AppError(400,
          `${field === "disclaimer" ? "The disclaimer" : "The note for the top level"} cannot be emptied. It is the sentence that keeps the amounts honest. Reword it instead.`);
      }
      // Everything else falls back to the shipped wording.
      next[field] = LIMITS_CONTENT_DEFAULTS[field];
      continue;
    }
    const why = forbiddenClaimIn(text);
    if (why) throw new AppError(400, `${why} (in "${field}")`);
    next[field] = text;
  }
  return next;
}

// Rule 2: never throws. A public-ish screen must render.
async function getLimitsContent() {
  try {
    const setting = await getPlatformSetting(LIMITS_CONTENT_KEY, null);
    return mergeWithDefaults(setting?.value ?? null);
  } catch (error) {
    console.error("[limits-content] falling back to defaults", { message: error.message });
    return { ...LIMITS_CONTENT_DEFAULTS };
  }
}

// For the console: the copy plus whether anything is actually stored, and who
// wrote it. A missing field is reported as unknown rather than as "nobody has
// edited this yet".
async function getLimitsContentRecord() {
  const record = await getPlatformSettingRecord(LIMITS_CONTENT_KEY).catch(() => null);
  return {
    content: mergeWithDefaults(record?.value ?? null),
    defaults: { ...LIMITS_CONTENT_DEFAULTS },
    stored: Boolean(record?.exists && record.value && Object.keys(record.value).length),
    updatedAt: record?.updatedAt ?? null,
    updatedBy: record?.updatedByName ?? null
  };
}

async function saveLimitsContent(actor, payload, { reset = false } = {}) {
  // "Put it back" is its own instruction, not an empty form. Sending blanks
  // would hit the caveat guard above, which is correct for an edit and wrong
  // for a deliberate reset.
  const next = reset ? { ...LIMITS_CONTENT_DEFAULTS } : normalizeForSave(payload);
  await setPlatformSetting(LIMITS_CONTENT_KEY, next, actor?.userId || null);
  return getLimitsContentRecord();
}

module.exports = {
  LIMITS_CONTENT_KEY,
  forbiddenClaimIn,
  LIMITS_CONTENT_DEFAULTS,
  FORBIDDEN_CLAIMS,
  getLimitsContent,
  getLimitsContentRecord,
  saveLimitsContent,
  // Exported so the guarantees can be tested by CALLING them: asserting the
  // shape of this source would only prove the source still looks the same.
  mergeWithDefaults,
  normalizeForSave
};
