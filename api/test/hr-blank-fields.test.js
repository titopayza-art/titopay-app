"use strict";

// A BLANK BOX ON AN HR FORM MUST NEVER REACH POSTGRES AS A TYPE ERROR.
//
// The HR portal renders a form per module and posts every field it draws,
// including the ones nobody filled in, which arrive as "". Two of those
// landed on columns that are not text:
//
//   emergency_contact  jsonb NOT NULL   ->  invalid input syntax for type json
//   manager_id         uuid             ->  invalid input syntax for type uuid: ""
//
// Both surfaced as a 500 reading "Unable to complete the request. Please try
// again." Invite employee could not succeed at all - not with the emergency
// contact filled in, and not with it left blank either, because the form
// posts the field either way. Creating an employee is the first thing anybody
// does in an HR system, so the portal was reported as entirely
// non-functional, and it was.
//
// The fix is in cleanPayload, which every HR create and update passes
// through: values bound for a JSON column become JSON, and a blank bound for
// any other non-text column becomes NULL, or is dropped so the column's own
// default applies where NULL would be refused.
//
// This drives it against a real database, because the fault was the database
// refusing a value and nothing short of one would have caught it. It walks
// EVERY writable resource rather than the two that were reported, since the
// forms all behave the same way and the next such column should fail here
// instead of in somebody's hands.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "hr-blank-fields-access-secret-long!!";
process.env.JWT_REFRESH_SECRET ||= "hr-blank-fields-refresh-secret-long!";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const hr = require("../src/services/hr-service");

const auth = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "hr.blank@titopay.test",
  name: "HR Admin",
  role: "CEO"
};

// The shapes a Postgres type refusal takes. A 400 from the service's own
// validation is a correct answer to an incomplete form and is not a fault;
// these are the database being handed something it cannot read.
const TYPE_ERROR = /invalid input syntax|invalid input value|cannot be cast|malformed/i;

function stamp() {
  return crypto.randomUUID().slice(0, 8);
}

// Every HR write is audited, and hr_audit_logs.user_id references hr_users.
// The actor has to be a real row or the audit - not the thing under test -
// is what fails.
test.before(async () => {
  await pool.query(
    `INSERT INTO hr_users (id, name, email, role, password_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, status = 'active'`,
    [auth.userId, auth.name, auth.email, auth.role, "not-a-usable-hash"]
  );
});

test.after(async () => {
  await pool.query("DELETE FROM hr_employees WHERE email LIKE 'blankfields%@titopay.test'").catch(() => {});
  await pool.query("DELETE FROM hr_audit_logs WHERE user_id = $1", [auth.userId]).catch(() => {});
  await pool.query("DELETE FROM hr_users WHERE email = $1", [auth.email]).catch(() => {});
  await pool.end().catch(() => {});
});

test("an employee is created with every optional box left empty", async () => {
  const mark = stamp();
  // Exactly what the portal posts, blanks included.
  const result = await hr.create("employees", auth, {
    firstName: "Blank",
    lastName: `Fields${mark}`,
    employeeNumber: `BF-${mark}`,
    email: `blankfields${mark}@titopay.test`,
    temporaryPassword: "BlankFields!2026#x",
    phone: "+27860000001",
    jobTitle: "Tester",
    department: "Engineering",
    employmentType: "Permanent",
    startDate: "2026-09-01",
    status: "active",
    managerId: "",
    emergencyContact: "",
    salary: "",
    workLocation: ""
  });
  assert.ok(result.data.id, "the employee was created");
  assert.equal(result.data.emergencyContact, "", "a blank emergency contact reads back blank");
  assert.equal(result.data.managerId, null, "a blank manager id is stored as nothing, not as an empty string");
});

test("AN EMERGENCY CONTACT IS STORED AS TYPED AND READ BACK AS TYPED", async () => {
  const mark = stamp();
  const typed = "Nomsa Dlamini (sister) +27 82 555 0199";
  const created = await hr.create("employees", auth, {
    firstName: "Round",
    lastName: `Trip${mark}`,
    employeeNumber: `RT-${mark}`,
    email: `blankfields${mark}@titopay.test`,
    temporaryPassword: "RoundTrip!2026#x",
    phone: "+27860000002",
    jobTitle: "Tester",
    department: "Engineering",
    emergencyContact: typed
  });
  assert.equal(created.data.emergencyContact, typed, "what was typed is what came back");

  // And it survives being read again, not just echoed by the insert.
  const { rows } = await pool.query("SELECT emergency_contact FROM hr_employees WHERE id = $1", [created.data.id]);
  assert.equal(rows[0].emergency_contact, typed, "the database holds it as JSON text, not as a broken value");
});

test("a structured emergency contact is kept as structure", async () => {
  const mark = stamp();
  const created = await hr.create("employees", auth, {
    firstName: "Struct",
    lastName: `Ured${mark}`,
    employeeNumber: `SU-${mark}`,
    email: `blankfields${mark}@titopay.test`,
    temporaryPassword: "Structured!2026#x",
    phone: "+27860000003",
    jobTitle: "Tester",
    department: "Engineering",
    emergencyContact: '{"name":"Sipho","phone":"+27825550100"}'
  });
  assert.deepEqual(created.data.emergencyContact, { name: "Sipho", phone: "+27825550100" });
});

test("NO HR FORM CAN SEND A BLANK THAT THE DATABASE REFUSES", async () => {
  const skip = new Set(["employees"]); // covered above, and it creates a login
  const refusals = [];
  for (const [name, config] of Object.entries(hr.resources)) {
    if (config.readOnly || skip.has(name)) continue;
    // Every field the resource exposes, blank - the worst case a form can
    // produce, and the case the portal produces for an untouched module.
    const payload = {};
    Object.keys(config.columns).forEach((key) => { payload[key] = ""; });
    try {
      await hr.create(name, auth, payload);
    } catch (error) {
      const message = String(error && error.message);
      if (TYPE_ERROR.test(message)) refusals.push(`${name}: ${message}`);
      // Anything else is the service saying the form is incomplete, which is
      // the right answer to a form full of blanks.
    }
  }
  assert.deepEqual(refusals, [], "a blank field reached a column that could not read it");
});
