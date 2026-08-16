"use strict";

// IDENTITY, BUSINESS AND SCREENING: the capability TitoPay has NOT yet bought.
//
// This is the one that most needs the seam, because it is the one still to be
// chosen. The console has carried "docfox" as a hardcoded default for the KYC
// row since the integration centre was built, and nothing has ever called it:
// no contract, no credential, no request. Writing a vendor's name into a
// default is how a decision gets made by accident, so the default here is
// `internal` and the operations describe exactly what TitoPay does today.
//
// WHAT "internal" HONESTLY MEANS. Today a Tier 1 identity check proves three
// things and no more: the document number is structurally valid, it is not
// already anchoring another TitoPay account, and it is not on TitoPay's own
// screening list. There is no Home Affairs match, no document image, no
// liveness check and no register lookup. The adapter says so in `assurance`,
// the limits for that level are set to that assurance, and NOTHING here
// fabricates a result it did not obtain.
//
// The day a verification provider is contracted, it arrives as a sibling
// adapter and KYC_PROVIDER selects it. Core does not change: it calls
// `verifyIdentity()` and `verifyBusiness()` today and it will call the same
// two functions then. What changes is that `status` starts coming back as
// `pending` or `review_required` for real reasons, which the callers already
// handle, because a level is granted on `verified` and on nothing else.

const { registerProvider, operation, CAPABILITIES, capabilityConfigured, configuredKey } = require("./index");

// THE TITOPAY VERIFICATION STATUSES. Every adapter normalises to these, so a
// provider's own vocabulary ("APPROVED", "MANUAL_REVIEW", "DECLINED_RETRY")
// never reaches a database column, a decision or a screen.
//
//   pending          submitted, no answer yet
//   verified         the check passed
//   review_required  a person has to look at it
//   failed           the check could not be completed (technical, retryable)
//   rejected         the check completed and did not pass
//
// These are deliberately the states the platform already has. No new
// compliance status is invented here, and none of them is a risk rating:
// KYC status, KYB status, screening status, risk status and account status
// stay five separate axes.
const VERIFICATION_STATUSES = ["pending", "verified", "review_required", "failed", "rejected"];

function normalizeVerificationStatus(value, fallback = "review_required") {
  const text = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return VERIFICATION_STATUSES.includes(text) ? text : fallback;
}

// ---------------------------------------------------------------------------
// Adapter: internal. No external call, and it never claims one was made.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.KYC,
  key: "internal",
  isDefault: true,

  // A natural person. The caller has already applied TitoPay's own structural
  // rules (which document types are accepted, the SA ID checksum, the date of
  // birth) because those are TitoPay's rules, not a vendor's. What this
  // answers is the ASSURANCE question: has the identity been confirmed against
  // an authoritative source? Internally, it has not, and it says so.
  async verifyIdentity(subject = {}) {
    return {
      status: "verified",
      assurance: "structural",
      provider: "internal",
      reference: null,
      documentType: subject.documentType || null,
      issuingCountry: subject.issuingCountry || null,
      checkedAgainstRegister: false
    };
  },

  // A business entity. A registration number cannot be confirmed without a
  // register lookup, and TitoPay has none, so this NEVER returns verified. It
  // routes to the human compliance review that already exists, which is what
  // actually happens today.
  async verifyBusiness(entity = {}) {
    return {
      status: "review_required",
      assurance: "manual",
      provider: "internal",
      reference: null,
      registrationNumber: entity.registrationNumber ? "supplied" : "not_supplied",
      checkedAgainstRegister: false
    };
  }
});

// ---------------------------------------------------------------------------
// Adapter: internal screening (AML). TitoPay maintains its own screening list
// through the console; this exposes it as a capability so a commercial
// sanctions/PEP feed can replace it without touching a caller.
// ---------------------------------------------------------------------------
registerProvider({
  capability: CAPABILITIES.AML,
  key: "internal",
  isDefault: true,

  async screenCustomer(subject = {}) {
    // Required late so the compliance service can use the provider layer
    // without the two files requiring each other at load time.
    const { screenUser } = require("../services/compliance-service");
    if (!subject.userId) return { status: "review_required", provider: "internal", hit: false };
    const result = await screenUser(subject.userId);
    return {
      // A screening hit is not a verification failure and must not be reported
      // as one: it raises a risk signal and a compliance case. The matched
      // list entry stays internal and is never returned to a customer.
      status: result && result.hit ? "review_required" : "verified",
      provider: "internal",
      listsChecked: ["titopay_screening_list"],
      hit: Boolean(result && result.hit)
    };
  }
});

// ---------------------------------------------------------------------------
// The interface core uses. Core calls verifyIdentity(), never verifyWithX().
// ---------------------------------------------------------------------------
module.exports = {
  VERIFICATION_STATUSES,
  normalizeVerificationStatus,
  verifyIdentity: (subject) => operation(CAPABILITIES.KYC, "verifyIdentity")(subject),
  verifyBusiness: (entity) => operation(CAPABILITIES.KYC, "verifyBusiness")(entity),
  screenCustomer: (subject) => operation(CAPABILITIES.AML, "screenCustomer")(subject),
  kycProviderKey: () => configuredKey(CAPABILITIES.KYC),
  kycCapabilityConfigured: () => capabilityConfigured(CAPABILITIES.KYC)
};
