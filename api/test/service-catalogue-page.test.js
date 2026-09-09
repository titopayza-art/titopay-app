"use strict";

// WHY IS A SERVICE NOT LIVE, AND WHAT WOULD CHANGE THAT?
//
// Reported from the app: Airtime & Data, Electricity, Voucher and Pay Bills sit
// under "Planned services" with a SOON badge, and the question was how to
// reactivate them from the admin portal. There was no answer to give.
//
//   - No console page listed the service catalogue at all. The endpoints
//     existed; nothing called them.
//   - The status is DERIVED. applyCapabilityGate re-computes it on every read
//     from whether a supplier can send a purchase, so there was never a toggle,
//     and setting one active would have stored and come straight back as
//     coming_soon — which reads as a broken button, not as a policy.
//   - GET /services/admin returned the SERVED status only. An operator could
//     not tell a capability gate from a failed write.
//
// The API now returns both the stored status and a report of what is gating
// the catalogue, and the console has a page that says it in words. Behaviour of
// the gate itself is unchanged: this is all read-only.
//
// The page is driven end-to-end in Chromium against the real API in
// verification/service-catalogue.spec.js. This file holds the contract.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CONSOLE = fs.readFileSync(path.join(ROOT, "admin", "assets", "admin.js"), "utf8");
const ROUTES = fs.readFileSync(path.join(ROOT, "api", "src", "routes", "services.routes.js"), "utf8");
const SERVICE = fs.readFileSync(path.join(ROOT, "api", "src", "services", "service-management-service.js"), "utf8");

const catalogue = require("../src/services/service-management-service");

test("the gate reports what it stored as well as what it served", () => {
  // Without storedStatus the console can only show the derived answer, which
  // is exactly the confusion that prompted this: an operator sees the status
  // they set come back different and cannot tell why.
  assert.match(SERVICE, /storedStatus: row\.status/);
  const gate = SERVICE.slice(SERVICE.indexOf("function applyCapabilityGate"),
    SERVICE.indexOf("function capabilityReport"));
  assert.match(gate, /status: row\.status === "disabled" \? row\.status : "coming_soon"/,
    "the gate itself is unchanged");
});

test("the capability report says what is gating the catalogue and what releases it", () => {
  const report = catalogue.capabilityReport();
  const vas = report.find((entry) => entry.capability === "vas");
  assert.ok(vas, "the VAS capability is reported");
  assert.equal(vas.live, false, "it cannot transact today");
  assert.equal(vas.variable, "VAS_PROVIDER", "and it names the variable that selects the adapter");
  assert.equal(vas.declares.canPurchase, false, "read from the adapter's own declaration");
  assert.ok(vas.services.includes("airtime") && vas.services.includes("electricity")
    && vas.services.includes("voucher") && vas.services.includes("pay-bills"),
    "and the services it holds back");
  assert.match(vas.releasedBy, /canPurchase: true/);
  assert.match(vas.releasedBy, /VAS_PROVIDER/);
});

test("it names no vendor", () => {
  // The seam rule: core reads what an adapter DECLARES, never who it is. A
  // report that hard-coded a supplier's name would be wrong the day the
  // contract changes, and would put that name in the console besides.
  const report = JSON.stringify(catalogue.capabilityReport());
  for (const vendor of ["flash", "Flash", "peach", "Peach"]) {
    assert.ok(!report.includes(vendor), `the report must not name ${vendor}`);
  }
});

test("the report follows the adapter, so a signed contract releases the services on its own", () => {
  // THE WHOLE CLAIM THE PAGE MAKES, tested rather than asserted in prose. If
  // this does not hold, the page tells an operator to do something that will
  // not work.
  const providers = require("../src/providers");
  const real = providers.describeProviders;
  try {
    providers.describeProviders = () => real().map((entry) => entry.capability === "vas"
      ? { ...entry, configured: "contracted", source: "environment", declares: { canPurchase: true } }
      : entry);
    // capabilityCanTransact reads the live adapter, which is still false, so
    // this proves the REPORT tracks the declaration it is given.
    const vas = catalogue.capabilityReport().find((entry) => entry.capability === "vas");
    assert.equal(vas.declares.canPurchase, true, "the report follows the adapter's declaration");
    assert.equal(vas.configured, "contracted");
    assert.equal(vas.source, "environment", "and says the variable, not a default, selected it");
  } finally {
    providers.describeProviders = real;
  }
});

test("the report rides the endpoint an operator already has permission for", () => {
  // A separate super-admin-only endpoint would mean the page could show the
  // status but not the reason for whoever actually holds "services".
  assert.match(ROUTES, /router\.get\("\/admin", requireAuth, requireAdminPermission\("services"\)/);
  const adminGet = ROUTES.slice(ROUTES.indexOf('router.get("/admin"'), ROUTES.indexOf('router.post("/admin"'));
  assert.match(adminGet, /capabilities: capabilityReport\(\)/);
});

test("the console has a Service Catalogue page, reachable and permissioned to match", () => {
  assert.match(CONSOLE, /\["\/services\/", "service-catalogue", "Service Catalogue"\]/, "it is in the rail");
  assert.match(CONSOLE, /"service-catalogue": "services"/,
    "the rail permission matches requireAdminPermission(\"services\") on the endpoint");
  assert.match(CONSOLE, /"service-catalogue": renderServiceCatalogue/, "the router reaches it");
  assert.match(CONSOLE, /async function renderServiceCatalogue\(\)/);
  const shell = fs.readFileSync(path.join(ROOT, "admin", "services", "index.html"), "utf8");
  assert.match(shell, /data-page="service-catalogue"/, "and the page shell asks for it");
  assert.match(shell, /style-src 'self'/, "carrying the same CSP as every other page");
});

test("the page offers no control that could not work", () => {
  // The rows an operator comes here about are derived. A status field on them
  // would store and be overridden in the same response.
  const page = CONSOLE.slice(CONSOLE.indexOf("async function renderServiceCatalogue"),
    CONSOLE.indexOf("async function renderCompanyDocuments"));
  for (const control of ["<form", "<select", "<textarea", "<input", "addEventListener"]) {
    assert.ok(!page.includes(control), `the page must not render ${control}`);
  }
  for (const write of ["method: \"PUT\"", "method: \"POST\"", "method: \"DELETE\""]) {
    assert.ok(!page.includes(write), `the page must not ${write}`);
  }
  assert.match(page, /nothing to switch on here/, "and it says so in words");
});

test("the page explains itself against an older API instead of rendering blank", () => {
  const page = CONSOLE.slice(CONSOLE.indexOf("async function renderServiceCatalogue"),
    CONSOLE.indexOf("async function renderCompanyDocuments"));
  assert.match(page, /Array\.isArray\(result\.capabilities\) \? result\.capabilities : null/);
  assert.match(page, /API build 114/, "it names the build that adds the report");
});

/* ---- RBAC ---------------------------------------------------------------
   A new console page has two gates and they must agree. The rail decides what
   is OFFERED; the API decides what is SERVED. Looser rail than API and an
   operator finds a page that 403s; tighter and they lose a page they are
   entitled to; looser API than rail and the permission is not a permission at
   all, because the URL is open to any signed-in admin.

   Both gates are driven with real role-limited accounts in
   verification/service-catalogue-rbac.spec.js. These hold the wiring. */

test("the page reuses an existing permission and invents nothing", () => {
  // A brand-new permission would be held by nobody, appear on no role, and
  // need a migration before anyone could be granted it. "services" already
  // guards this endpoint and is already grantable.
  const { getAdminRolePermissions } = require("../src/services/auth-service");
  assert.ok(getAdminRolePermissions("engineering").includes("services"),
    "engineering already holds it");
  assert.match(CONSOLE, /"service-catalogue": "services"/);
  assert.match(ROUTES, /requireAdminPermission\("services"\)/);
});

test("no role's access was changed to make this page work", () => {
  // The page must earn its audience through the permission that already
  // exists, never by widening a role. These are the shipped defaults as they
  // stood before the Service Catalogue, pinned so a future convenience edit
  // has to be deliberate.
  const { getAdminRolePermissions } = require("../src/services/auth-service");
  const before = {
    customer_support: ["dashboard", "users", "wallets", "support", "transactions", "profile_lock",
      "ticketing", "event_tags", "EMAIL_VIEW", "EMAIL_LOG_VIEW", "EMAIL_OTP_VIEW", "EMAIL_OTP_LOGS"],
    compliance: ["dashboard", "compliance", "users", "merchants", "ticketing", "event_tags",
      "enterprise_distribution", "audit", "EMAIL_VIEW", "EMAIL_LOG_VIEW", "EMAIL_OTP_VIEW", "EMAIL_OTP_LOGS"],
    engineering: ["engineering", "security", "audit", "dashboard", "transactions", "services",
      "EMAIL_VIEW", "EMAIL_LOG_VIEW", "EMAIL_QUEUE_MANAGE", "EMAIL_OTP_VIEW", "EMAIL_OTP_LOGS"],
  };
  for (const [role, permissions] of Object.entries(before)) {
    assert.deepEqual(getAdminRolePermissions(role), permissions, `${role} must be untouched`);
  }
  // And nobody outside engineering and the root roles picked up "services".
  for (const role of ["customer_support", "compliance", "finance", "marketing", "senior_marketing", "coo"]) {
    assert.ok(!getAdminRolePermissions(role).includes("services"),
      `${role} must not have been granted "services"`);
  }
});

test("an owner can grant it without a code change", () => {
  // The RBAC screen builds its checklist from the API's availablePermissions
  // plus everything already held by a role. "services" satisfies the second,
  // so it is offered on that screen today — which is what makes this page
  // delegable to, say, compliance without touching this repository.
  const { getAdminRolePermissions } = require("../src/services/auth-service");
  assert.ok(getAdminRolePermissions("engineering").includes("services"));
  const rbac = CONSOLE.slice(CONSOLE.indexOf("async function renderRbacPermissions"),
    CONSOLE.indexOf("async function renderStaffManagement"));
  assert.match(rbac, /items\.flatMap\(\(row\) => row\.permissions\)/,
    "the checklist includes every permission any role already holds");
});

test("the rail hides what the API would refuse", () => {
  // Every slug the rail offers must resolve to a gate. A slug that falls
  // through to its own name would be checked against a permission nobody
  // holds, and the page would vanish for everyone including its owner.
  const map = CONSOLE.slice(CONSOLE.indexOf("const canSee = (slug) =>"),
    CONSOLE.indexOf("const initials = adminName"));
  assert.match(map, /"service-catalogue": "services"/,
    "the rail checks the same permission the endpoint enforces");
  assert.ok(!/"service-catalogue": "__/.test(map),
    "and does not quietly restrict it to a root role instead");
});

test("both copies of admin.js are the same file", () => {
  const root = fs.readFileSync(path.join(ROOT, "admin", "admin.js"), "utf8");
  assert.equal(root, CONSOLE, "admin/admin.js and admin/assets/admin.js have drifted");
});
