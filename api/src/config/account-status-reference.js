"use strict";

// WHY AN ACCOUNT IS NOT ACTIVE.
//
// TitoPay does not delete customers, and that is deliberate rather than an
// omission: FICA requires identification and transaction records to be kept
// for years after a business relationship ends, so a customer row erased on
// request would take the evidence with it. account-closure-service.js already
// says this in its own words - "closure is containment plus record retention".
//
// What was missing is the REASON, on the path where it matters most. A
// customer who asks to close their account states a reason and an admin
// records a decision note. An account restricted by TitoPay for suspected
// fraud or money laundering recorded nothing at all: users.status became
// 'suspended' and the audit log said "user_suspended". Six months later
// nobody can say which of those suspensions was a dormancy sweep and which
// was a sanctions match.
//
// This file is the vocabulary for both halves - what state an account is in,
// and why it was put there.

/* ----------------------------------------------------------- what it is */

// users.status carries no CHECK constraint, and four values are already in
// use across the codebase. Listing them here is what makes a typo a 400
// instead of a customer silently locked out of their money by 'susupended',
// a value nothing queries and no screen can see.
const ACCOUNT_STATUSES = Object.freeze([
  { key: "active", label: "Active", restricted: false, says: "Full access." },
  { key: "suspended", label: "Suspended", restricted: true, says: "Access stopped by TitoPay. Reversible." },
  { key: "blocked", label: "Blocked", restricted: true, says: "Access stopped and not expected to be restored." },
  { key: "inactive", label: "Inactive", restricted: true, says: "Dormant. No activity for a long period." },
  { key: "closed", label: "Closed", restricted: true, says: "The relationship has ended. Records are retained." }
]);

const ACCOUNT_STATUS_KEYS = Object.freeze(ACCOUNT_STATUSES.map((item) => item.key));
const RESTRICTED_STATUSES = Object.freeze(
  ACCOUNT_STATUSES.filter((item) => item.restricted).map((item) => item.key)
);

/* ---------------------------------------------------------------- why */

// TIPPING OFF IS THE REASON THIS LIST HAS A `disclose` COLUMN.
//
// Under the Financial Intelligence Centre Act a reportable suspicion must be
// reported, and telling the customer they are the subject of one is a criminal
// offence in its own right. So for those categories the customer is told their
// account is restricted and to contact support - the truthful, neutral thing -
// and never why. The internal reason is written down in full and is readable
// by compliance staff; it simply never travels to a customer-facing surface.
//
// Categories where there is nothing to tip off - a dormancy sweep, a customer
// who asked to close, a deceased estate - may say so plainly, because a
// customer being kept in the dark about ordinary administration is its own
// harm.
const RESTRICTION_CATEGORIES = Object.freeze([
  { key: "aml_review", label: "AML review", disclose: false, statuses: ["suspended"],
    says: "Under anti-money-laundering review." },
  { key: "fraud_suspected", label: "Suspected fraud", disclose: false, statuses: ["suspended", "blocked"],
    says: "Account activity consistent with fraud." },
  { key: "sanctions_match", label: "Sanctions match", disclose: false, statuses: ["suspended", "blocked"],
    says: "Screening returned a possible sanctions match." },
  { key: "law_enforcement", label: "Law enforcement or court order", disclose: false, statuses: ["suspended", "blocked"],
    says: "Restricted on instruction from an authority." },
  { key: "chargeback_abuse", label: "Chargeback abuse", disclose: true, statuses: ["suspended", "blocked"],
    says: "Repeated disputed payments." },
  { key: "terms_breach", label: "Breach of terms", disclose: true, statuses: ["suspended", "blocked"],
    says: "Use of TitoPay outside the customer agreement." },
  { key: "dormant", label: "Dormant", disclose: true, statuses: ["inactive"],
    says: "No activity for a long period." },
  { key: "customer_request", label: "Customer asked to close", disclose: true, statuses: ["closed"],
    says: "The customer asked for the account to be closed." },
  { key: "deceased_estate", label: "Deceased estate", disclose: true, statuses: ["closed", "suspended"],
    says: "Held pending the estate." },
  // Not a real reason, and named so it reads as the gap it is. The legacy
  // admin action that suspends with no stated reason records this, so a
  // suspension is never invisible even when nobody typed anything.
  { key: "unspecified", label: "No reason recorded", disclose: false, statuses: ["suspended", "blocked", "inactive", "closed"],
    says: "Restricted before a reason was required. Needs review." }
]);

const RESTRICTION_CATEGORY_KEYS = Object.freeze(RESTRICTION_CATEGORIES.map((item) => item.key));

// THE ONLY SENTENCES A RESTRICTED CUSTOMER EVER SEES.
//
// Chosen from this map by STATUS, never composed from the internal reason.
// A message built by interpolating the reason is one careless edit away from
// telling somebody they are under investigation.
const CUSTOMER_MESSAGES = Object.freeze({
  suspended: "Your TitoPay account is currently restricted. Please contact TitoPay support.",
  blocked: "Your TitoPay account is currently restricted. Please contact TitoPay support.",
  inactive: "Your TitoPay account is inactive. Please contact TitoPay support to reactivate it.",
  closed: "Your TitoPay account is closed. Please contact TitoPay support if you need help.",
  active: ""
});

/* ------------------------------------------------------------- lookups */

function isAccountStatus(key) {
  return ACCOUNT_STATUS_KEYS.includes(String(key || ""));
}

function isRestrictedStatus(key) {
  return RESTRICTED_STATUSES.includes(String(key || ""));
}

function isRestrictionCategory(key) {
  return RESTRICTION_CATEGORY_KEYS.includes(String(key || ""));
}

function restrictionCategory(key) {
  return RESTRICTION_CATEGORIES.find((item) => item.key === key) || null;
}

// Whether the reason may be shown to the customer whose account it is.
function mayDiscloseReason(categoryKey) {
  return restrictionCategory(categoryKey)?.disclose === true;
}

// Is this category a sensible thing to put an account into this status for?
// Marking someone dormant for a sanctions match, or blocked for dormancy,
// is a mis-keyed action that a reviewer would then read as fact.
function categoryAllowsStatus(categoryKey, status) {
  const category = restrictionCategory(categoryKey);
  return Boolean(category && category.statuses.includes(String(status || "")));
}

function customerMessageFor(status) {
  return CUSTOMER_MESSAGES[String(status || "")] ?? CUSTOMER_MESSAGES.suspended;
}

module.exports = {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_KEYS,
  RESTRICTED_STATUSES,
  RESTRICTION_CATEGORIES,
  RESTRICTION_CATEGORY_KEYS,
  CUSTOMER_MESSAGES,
  categoryAllowsStatus,
  customerMessageFor,
  isAccountStatus,
  isRestrictedStatus,
  isRestrictionCategory,
  mayDiscloseReason,
  restrictionCategory
};
