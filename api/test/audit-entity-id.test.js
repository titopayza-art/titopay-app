"use strict";

// A NON-UUID IDENTIFIER MUST NOT COST US THE AUDIT RECORD.
//
// audit_logs.entity_id is a uuid column, and callers of writeAuditLog arrive
// with whatever names the thing they changed: usually a row id, sometimes a
// settings key ("security_content") or a role slug ("coo"). Postgres rejects
// the non-UUIDs, and because the audit write is the LAST step of a handler, the
// change it describes has already been committed. So the caller answers 500
// over work that actually happened, and the log that existed to record it holds
// nothing at all.
//
// That was found twice within one review: the security content save and the
// RBAC role save. Both were invisible to every unit test, because nothing
// exercised the write against a real database. Guarding it at the two call
// sites would have left the third to be found the same way.
//
// The end-to-end proof is verification/rbac-audit-live.js, which drives the
// real route against real Postgres. This pins the rule itself.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { splitEntityId } = require("../src/services/audit-service");
const ADMIN_ROUTES = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "admin.routes.js"), "utf8");

test("a real UUID still goes in the column, untouched", () => {
  for (let i = 0; i < 5; i += 1) {
    const id = crypto.randomUUID();
    assert.deepEqual(splitEntityId(id, { a: 1 }), { id, metadata: { a: 1 } });
  }
  // Upper case is still a UUID as far as Postgres is concerned.
  const upper = crypto.randomUUID().toUpperCase();
  assert.equal(splitEntityId(upper, {}).id, upper);
});

test("nothing at all stays nothing at all", () => {
  for (const empty of [null, undefined, ""]) {
    assert.deepEqual(splitEntityId(empty, { a: 1 }), { id: null, metadata: { a: 1 } });
  }
});

test("a slug or a key is kept, in the metadata, instead of throwing", () => {
  for (const key of ["coo", "security_content", "admin_role_permission_overrides", "support_agent"]) {
    const out = splitEntityId(key, { permissions: ["security"] });
    assert.equal(out.id, null, `${key} must not be forced into the uuid column`);
    assert.equal(out.metadata.entityKey, key, `${key} must survive in the metadata`);
    assert.deepEqual(out.metadata.permissions, ["security"], "the caller's own metadata is kept");
  }
});

test("a near-miss UUID is treated as a key, not risked against the column", () => {
  for (const nearly of [
    "123e4567-e89b-12d3-a456",                      // truncated
    "123e4567e89b12d3a4564266141740000",            // no dashes
    "123e4567-e89b-12d3-a456-42661417400g",         // not hex
    "123e4567-e89b-12d3-a456-4266141740000"         // one too long
  ]) {
    const out = splitEntityId(nearly, {});
    assert.equal(out.id, null, `${nearly} is not a UUID and must not reach the column`);
    assert.equal(out.metadata.entityKey, nearly);
  }
});

test("the caller's metadata object is not mutated", () => {
  // The same object is often reused or logged by the caller afterwards.
  const original = { permissions: ["a"] };
  splitEntityId("coo", original);
  assert.deepEqual(original, { permissions: ["a"] }, "splitEntityId must not write into the caller's object");
});

test("the two known offenders no longer pass a name into the uuid column", () => {
  for (const [marker, name] of [
    ['router.put("/security-content"', "the security content save"],
    ['router.put("/roles/:role"', "the RBAC role save"]
  ]) {
    const start = ADMIN_ROUTES.indexOf(marker);
    assert.ok(start > -1, `${name} route exists`);
    const handler = ADMIN_ROUTES.slice(start, ADMIN_ROUTES.indexOf("\n});", start));
    assert.match(handler, /entityId: null/, `${name} passes null`);
    assert.doesNotMatch(handler, /entityId: role\b/, `${name} does not pass a role slug`);
    assert.doesNotMatch(handler, /entityId: SECURITY_CONTENT_KEY/, `${name} does not pass a settings key`);
  }
  // And the role change says WHICH role, which the log never did before: it
  // recorded the new permissions without naming whose they were.
  const roleHandler = ADMIN_ROUTES.slice(
    ADMIN_ROUTES.indexOf('router.put("/roles/:role"'),
    ADMIN_ROUTES.indexOf("\n});", ADMIN_ROUTES.indexOf('router.put("/roles/:role"'))
  );
  assert.match(roleHandler, /metadata: \{ role, permissions: updated\[role\] \}/);
});
