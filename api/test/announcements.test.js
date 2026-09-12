"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

// Updated when Senior Marketing became the third approval seat. The rule this
// test defends did not weaken — it grew: any ONE of three seats may approve,
// each holds its own seat so nobody can approve twice, and super_admin still
// acts as the CEO. What changed is that the set is now three, not two.
test("PWA announcements are delivered after approval by any one of the three seats", () => {
  const schema = source("src/db/schema.sql");
  const routes = source("src/routes/admin.routes.js");

  assert.match(schema, /PRIMARY KEY \(campaign_id, approval_role\)/);
  assert.match(schema, /UNIQUE \(campaign_id, approved_by\)/);
  assert.match(schema, /approval_role TEXT NOT NULL CHECK \(approval_role IN \('ceo', 'coo', 'senior_marketing'\)\)/);
  // Still not an AND: one seat is enough to send, which is what "either" meant.
  assert.doesNotMatch(routes, /approvedRoles\.has\("ceo"\) && approvedRoles\.has\("coo"\)/);
  assert.match(routes, /function marketingApprovalSeat\(role\)/);
  assert.match(routes, /if \(!approvalRole\)/);
  assert.match(routes, /\["ceo", "super_admin", "owner", "root"\]\.includes\(normalized\)\) return "ceo"/);
  assert.match(routes, /normalized === "senior_marketing"\) return "senior_marketing"/);
  assert.match(routes, /status: "sent"/);
});

// The escalation handoff is the check that keeps escalation meaningful, so it
// is defended here rather than only in the end-to-end harness.
test("whoever escalates an announcement cannot then approve it", () => {
  const routes = source("src/routes/admin.routes.js");
  assert.match(routes, /campaign\.status === "escalated" && approvalRole === "senior_marketing"/);
  assert.match(routes, /Only Senior Marketing can escalate/);
  // A rejection must always carry a reason.
  assert.match(routes, /boundedText\(req\.body\?\.reason, "Rejection reason"/);
});

test("Super Admin retains full access while acting only as the CEO announcement approver", () => {
  const authService = source("src/services/auth-service.js");
  const routes = source("src/routes/admin.routes.js");

  assert.match(authService, /super_admin: \["\*"\]/);
  assert.match(routes, /\["ceo", "super_admin", "owner", "root"\]\.includes\(normalized\)\) return "ceo"/);
  assert.doesNotMatch(routes, /"super_admin"[\s\S]{0,40}return "coo"/);
  assert.doesNotMatch(routes, /CEO and COO approvals must be recorded by different authorised administrators/);
});

test("announcement delivery is audience-scoped and does not fan out one row per user", () => {
  const schema = source("src/db/schema.sql");
  const adminRoutes = source("src/routes/admin.routes.js");
  const chatRoutes = source("src/routes/chat.routes.js");

  assert.match(schema, /CREATE TABLE IF NOT EXISTS announcement_reads/);
  assert.match(schema, /PRIMARY KEY \(campaign_id, user_id\)/);
  assert.match(chatRoutes, /c\.audience = 'specific' AND c\.target_user_id = u\.id/);
  assert.match(chatRoutes, /INSERT INTO announcement_reads/);
  const approvalRoute = adminRoutes.slice(
    adminRoutes.indexOf('router.post("/marketing/announcements/:id/approve"'),
    adminRoutes.indexOf('router.get("/marketing/reviews"')
  );
  assert.doesNotMatch(approvalRoute, /INSERT INTO notifications/);
});

test("PWA notification inbox includes and marks announcements read", () => {
  const chatRoutes = source("src/routes/chat.routes.js");

  assert.match(chatRoutes, /notification_type LIKE '%_announcement'/);
  assert.match(chatRoutes, /FROM announcement_campaigns c/);
  assert.match(chatRoutes, /ON CONFLICT \(campaign_id, user_id\) DO NOTHING/);
});

test("SMS marketing supports the same four audience modes with exact specific-user resolution", () => {
  const adminRoutes = source("src/routes/admin.routes.js");

  assert.match(adminRoutes, /\["personal", "business", "specific", "both"\], "Audience"/);
  assert.match(adminRoutes, /async function resolveSpecificSmsRecipient/);
  assert.match(adminRoutes, /recipient\.replace\(\/\^@\/, ""\)/);
  assert.match(adminRoutes, /LOWER\(username\) = LOWER\(\$3\)/);
  assert.match(adminRoutes, /listMarketingSmsRecipients\(campaign\.audience, campaign\.targetUserId \|\| null\)/);
});

test("existing production announcement tables migrate to the four-audience constraint", () => {
  const schema = source("src/db/schema.sql");

  assert.match(schema, /DROP CONSTRAINT IF EXISTS announcement_campaigns_audience_check/);
  assert.match(schema, /ADD CONSTRAINT announcement_campaigns_audience_check/);
  assert.match(schema, /CHECK \(audience IN \('personal', 'business', 'specific', 'both'\)\)/);
});

test("Admin Database Health quotes its PostgreSQL keyword alias and checks announcement tables", () => {
  const adminRoutes = source("src/routes/admin.routes.js");
  // `exists` is a reserved word, so the alias has to stay quoted.
  assert.match(adminRoutes, /AS "exists"/);
  assert.doesNotMatch(adminRoutes, /AS exists\s+FROM unnest/);

  // The list of tables moved out of the route and into the diagnosis service,
  // so the console page and `npm run db:diagnose` ask the same question. The
  // announcement tables must still be in it.
  // Read as source rather than required, because this file sets no database
  // environment and the service pulls in the pool.
  const diagnosis = source("src/services/console-diagnosis-service.js");
  for (const table of ["announcement_campaigns", "announcement_approvals", "announcement_reads"]) {
    assert.match(diagnosis, new RegExp(`"${table}"`), `Database Health still checks ${table}`);
  }
  assert.match(adminRoutes, /require\("\.\.\/services\/console-diagnosis-service"\)/);
});
