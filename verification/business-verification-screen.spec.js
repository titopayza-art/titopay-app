"use strict";

/* TWO SCREENS, TWO SUBJECTS, AND NEITHER ONE BORROWS THE OTHER'S FIELDS.
 *
 * The mistake this guards against is the obvious one: bolting a company
 * registration number onto "Verify your identity" because both are called
 * verification. A person does not have a registration number and a company
 * does not have a date of birth, so a screen that asks for both is asking the
 * wrong human being for the wrong document.
 *
 * Rendered in a real browser against stubbed API responses, so it measures the
 * screens the customer is actually served rather than the source that builds
 * them.
 *
 *   1. Verify your identity is unchanged: the document selector, the SA ID
 *      field, the passport route, and NO registration number anywhere on it.
 *   2. Business verification is a separate screen with two named halves.
 *   3. The authorised person is READ, not collected: no identity document
 *      field exists on the business screen at all.
 *   4. A business type with no registration number is not shown the field; a
 *      registered type is.
 *   5. Several businesses render side by side, each with its own status.
 *
 * Serve the PWA first:  python3 -m http.server 8099 --directory pwa
 * Run: node verification/business-verification-screen.spec.js
 */

const { chromium } = require("/tmp/claude-0/-home-user-titopay-app/b46bca12-b8d1-59fa-a0f4-cf119e42703a/scratchpad/node_modules/playwright-core");

const OVERVIEW = {
  ok: true,
  person: {
    name: "Thabo Mokoena",
    identityVerified: true,
    note: "Your identity is verified. You do not need to verify it again for any business you add."
  },
  businesses: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      businessName: "Mokoena Spaza",
      businessType: "sole_proprietor",
      businessTypeLabel: "Sole proprietor",
      registrationNumber: null,
      requiresRegistrationNumber: false,
      verificationStatus: "unverified",
      verificationLabel: "Not verified yet",
      yourRole: "owner",
      yourRoleLabel: "Owner"
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      businessName: "Mokoena Transport (Pty) Ltd",
      businessType: "private_company",
      businessTypeLabel: "Private company (Pty) Ltd",
      registrationNumber: "2020/123456/07",
      requiresRegistrationNumber: true,
      verificationStatus: "review_required",
      verificationLabel: "Under review",
      yourRole: "director",
      yourRoleLabel: "Director"
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      businessName: "Kasi Stokvel Admin CC",
      businessType: "close_corporation",
      businessTypeLabel: "Close corporation (CC)",
      registrationNumber: "CK1998/044556/23",
      requiresRegistrationNumber: true,
      verificationStatus: "verified",
      verificationLabel: "✓ Business verified",
      yourRole: "member",
      yourRoleLabel: "Member"
    }
  ],
  businessTypes: [
    { key: "sole_proprietor", label: "Sole proprietor", requiresRegistrationNumber: false },
    { key: "informal_trader", label: "Informal trader", requiresRegistrationNumber: false },
    { key: "private_company", label: "Private company (Pty) Ltd", requiresRegistrationNumber: true },
    { key: "close_corporation", label: "Close corporation (CC)", requiresRegistrationNumber: true }
  ],
  roles: [
    { key: "owner", label: "Owner" },
    { key: "director", label: "Director" },
    { key: "beneficial_owner", label: "Beneficial owner" },
    { key: "authorised_representative", label: "Authorised representative" }
  ],
  limitsNote: "Business limits follow the business's own verification, its risk profile and TitoPay's applicable compliance requirements."
};

let passed = 0;
const ok = (m) => { passed += 1; console.log("  PASS  " + m); };
const fail = (m) => { console.error("  FAIL  " + m); process.exitCode = 1; };
function check(condition, message) { condition ? ok(message) : fail(message); }

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox"]
  });
  // The service worker will happily serve the PREVIOUS bundle, which has made
  // more than one change look inert. Blocked, so this measures what was built.
  const context = await browser.newContext({ viewport: { width: 414, height: 896 }, serviceWorkers: "block" });
  const page = await context.newPage();

  // The PWA's API base is a const pointing at production, so the request is
  // intercepted and answered here rather than rewritten in the bundle.
  await page.route("https://api.titopay.co.za/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/v1/business/verification")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OVERVIEW) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("http://127.0.0.1:8099/", { waitUntil: "networkidle" });

  // ---- 1. The personal screen is untouched --------------------------------
  await page.evaluate(() => openIdentityVerificationModal());
  await page.waitForSelector('form[data-form="basic-verify"]', { timeout: 5000 });
  const personal = await page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    return {
      heading: card.querySelector("h2")?.textContent.trim(),
      eyebrow: card.querySelector(".eyebrow")?.textContent.trim(),
      hasDocumentSelector: Boolean(card.querySelector('select[name="documentType"]')),
      documentOptions: [...card.querySelectorAll('select[name="documentType"] option')].map((o) => o.value),
      hasSaIdField: Boolean(card.querySelector('input[name="idNumber"]')),
      hasPassportRoute: Boolean(card.querySelector('input[name="documentNumber"]')),
      // The thing that must NOT be there.
      hasRegistrationNumber: Boolean(card.querySelector('[name="registrationNumber"]')),
      mentionsCompanyNumber: /registration number|company registration|CIPC/i.test(card.textContent)
    };
  });
  check(personal.heading === "Verify your identity", "the personal screen still says Verify your identity");
  check(personal.eyebrow === "Limits & Verification", "and still sits under Limits & Verification");
  check(personal.hasDocumentSelector && personal.documentOptions.join(",") === "sa_id,passport,other",
    "the document selector still offers SA ID, passport and another approved document");
  check(personal.hasSaIdField && personal.hasPassportRoute, "the SA ID field and the passport route both survive");
  check(!personal.hasRegistrationNumber, "no company registration number field on the personal screen");
  check(!personal.mentionsCompanyNumber, "and the personal screen does not mention one in its copy either");

  // ---- 2 to 5. The business screen ----------------------------------------
  await page.evaluate(() => { closeModal(); });
  await page.evaluate(() => openBusinessVerificationModal());
  await page.waitForSelector('form[data-form="business-profile"]', { timeout: 5000 });

  const business = await page.evaluate(() => {
    const card = document.querySelector(".modal-card");
    const text = card.textContent;
    const typeSelect = card.querySelector('select[name="businessType"]');
    const registrationField = card.querySelector('[data-business-field="registration"]');
    return {
      heading: card.querySelector("h2")?.textContent.trim(),
      hasAuthorisedPersonHalf: /Authorised person/i.test(text),
      personName: /Thabo Mokoena/.test(text),
      saysVerifiedOnce: /do not need to verify it again/i.test(text),
      // No identity document is collected here. That is the whole point.
      hasIdNumberField: Boolean(card.querySelector('[name="idNumber"], [name="documentNumber"], [name="dateOfBirth"]')),
      hasBusinessNameField: Boolean(card.querySelector('[name="businessName"]')),
      hasRoleField: Boolean(card.querySelector('[name="role"]')),
      businessCount: [...card.querySelectorAll(".level-block")].filter((b) => /Mokoena|Kasi/.test(b.textContent)).length,
      statuses: [...card.querySelectorAll(".level-block .sv-chip")].map((c) => c.textContent.trim()),
      registrationHiddenForSoleProprietor: registrationField?.hidden === true,
      defaultType: typeSelect?.value,
      limitsNote: card.querySelector(".level-fineprint")?.textContent.trim() || ""
    };
  });
  check(business.heading === "Business verification", "business verification is its own screen");
  check(business.hasAuthorisedPersonHalf && business.personName,
    "it names the authorised person as a separate half of the screen");
  check(business.saysVerifiedOnce, "and says plainly that the person is verified once, not once per business");
  check(!business.hasIdNumberField,
    "no identity document field exists on the business screen at all");
  check(business.hasBusinessNameField && business.hasRoleField,
    "the entity is named and the person's ROLE at it is chosen");
  check(business.businessCount === 3, "three businesses under one verified person render together");
  check(business.statuses.includes("Not verified yet")
    && business.statuses.includes("Under review")
    && business.statuses.includes("✓ Business verified"),
  "each business carries its own KYB status, independently of the others");
  check(business.defaultType === "sole_proprietor" && business.registrationHiddenForSoleProprietor,
    "a sole proprietor is never shown a registration number field");
  check(/applicable compliance requirements/i.test(business.limitsNote)
    && !/guaranteed|automatic/i.test(business.limitsNote),
  "the limits note is conditional, never a promise");

  // Switching to a registered type reveals the field, and only then.
  await page.selectOption('form[data-form="business-profile"] select[name="businessType"]', "private_company");
  const revealed = await page.evaluate(() => {
    const field = document.querySelector('[data-business-field="registration"]');
    return { hidden: field.hidden, required: field.querySelector("input")?.required };
  });
  check(revealed.hidden === false && revealed.required === true,
    "choosing a registered company type asks for the registration number, and requires it");

  await browser.close();
  console.log(`\n  ${passed}/11 business verification screen checks passed`);
  if (process.exitCode) process.exit(1);
})().catch((error) => { console.error("\nFAILED:", error.message); process.exit(1); });
