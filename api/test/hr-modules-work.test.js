"use strict";

// THE HR MODULES, EXERCISED RATHER THAN READ.
//
// The portal was reported as non-functional. Two faults made it so: it could
// not be reached from the URL people open it with (fixed in hr-session.js),
// and Invite employee could not succeed at all because the form's blank boxes
// reached typed columns (fixed in cleanPayload - see hr-blank-fields.test.js).
//
// Neither of those would have been caught by anything that existed, because
// nothing had ever created an HR record end to end. This does: it hires
// somebody, edits them, gives them leave and approves it, pays them, pays
// back a claim, opens a disciplinary case, raises a request, and publishes
// and removes an announcement and a candidate. Against a real database,
// because both faults were the database refusing a value.
//
// The field names are the ones the portal's own forms post - read off the
// running forms rather than guessed - so this fails if the server and the
// screens ever stop agreeing. Attendance is not here: it has no form, it is
// the Clock in action, and it belongs with that flow.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET ||= "hr-modules-work-access-secret-long!!";
process.env.JWT_REFRESH_SECRET ||= "hr-modules-work-refresh-secret-long";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { pool } = require("../src/db/pool");
const hr = require("../src/services/hr-service");

const auth = {
  userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  email: "hr.modules@titopay.test",
  name: "HR Admin",
  role: "CEO"
};

const mark = crypto.randomUUID().slice(0, 8);
const staffEmail = `modules${mark}@titopay.test`;
let employee = null;

test.before(async () => {
  await pool.query(
    `INSERT INTO hr_users (id, name, email, role, password_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, status = 'active'`,
    [auth.userId, auth.name, auth.email, auth.role, "not-a-usable-hash"]
  );
});

test.after(async () => {
  await pool.query("DELETE FROM hr_audit_logs WHERE user_id = $1", [auth.userId]).catch(() => {});
  await pool.query("DELETE FROM hr_employees WHERE email = $1", [staffEmail]).catch(() => {});
  await pool.query("DELETE FROM hr_users WHERE email = $1", [auth.email]).catch(() => {});
  await pool.end().catch(() => {});
});

test("SOMEBODY CAN BE HIRED", async () => {
  const created = await hr.create("employees", auth, {
    firstName: "Module",
    lastName: `Walker${mark}`,
    employeeNumber: `MW-${mark}`,
    email: staffEmail,
    temporaryPassword: "ModuleWalker!2026#x",
    phone: "+27860000010",
    jobTitle: "Operations Assistant",
    department: "Operations",
    employmentType: "Permanent",
    startDate: "2026-09-01",
    salary: "24000",
    status: "active"
  });
  employee = created.data;
  assert.ok(employee.id);
  assert.equal(employee.name, `Module Walker${mark}`);
});

test("and appears in the employee list", async () => {
  const listed = await hr.list("employees", auth, { q: `Walker${mark}` });
  const items = listed.items || listed.data || [];
  assert.ok(items.some((row) => row.id === employee.id), "the new employee is listed");
});

test("their record can be changed", async () => {
  const updated = await hr.update("employees", employee.id, auth, { jobTitle: "Operations Lead" });
  assert.equal(updated.data.jobTitle, "Operations Lead");
});

test("LEAVE CAN BE REQUESTED AND APPROVED", async () => {
  const request = await hr.create("leave", auth, {
    employee: employee.name,
    type: "Annual leave",
    startDate: "2026-10-05",
    endDate: "2026-10-09",
    days: "5",
    reason: "Family commitment"
  });
  assert.ok(request.data.id, "the request was recorded");

  const decided = await hr.leaveDecision(request.data.id, auth, "approved", "Approved");
  assert.equal(decided.data.status, "approved", "the decision stuck");
});

test("a payroll run can be captured", async () => {
  const record = await hr.create("payroll", auth, {
    employee: employee.name,
    period: "2026-09",
    baseSalary: "24000",
    allowances: "1000",
    deductions: "500",
    bonuses: "",
    netPay: "24500",
    status: "draft"
  });
  assert.ok(record.data.id);
});

test("a claim can be submitted", async () => {
  const record = await hr.create("expenses", auth, {
    employee: employee.name,
    type: "Travel allowance",
    amount: "450.50",
    currency: "ZAR",
    description: "Client visit",
    status: "submitted"
  });
  assert.ok(record.data.id);
});

test("a disciplinary case can be opened", async () => {
  const record = await hr.create("disciplinary", auth, {
    caseNumber: `DC-${mark}`,
    employee: employee.name,
    type: "Timekeeping",
    incidentDate: "2026-09-12",
    description: "Late three times this month.",
    hearingDate: "",
    outcome: "",
    status: "open"
  });
  assert.ok(record.data.id);
});

test("a request can be raised", async () => {
  const record = await hr.create("tickets", auth, {
    requester: employee.name,
    type: "Equipment",
    subject: "New laptop",
    description: "Current one will not charge.",
    priority: "normal",
    status: "open"
  });
  assert.ok(record.data.id);
});

test("an announcement can be published and then removed", async () => {
  const created = await hr.create("announcements", auth, {
    title: `Office closure ${mark}`,
    audience: "All staff",
    priority: "normal",
    body: "The office is closed on the public holiday."
  });
  assert.ok(created.data.id);
  await hr.remove("announcements", created.data.id, auth);
  const listed = await hr.list("announcements", auth, { q: `Office closure ${mark}` });
  const items = listed.items || listed.data || [];
  assert.equal(items.filter((row) => row.id === created.data.id).length, 0, "it is gone from the list");
});

test("AND A RECRUITMENT CANDIDATE CAN BE DELETED", async () => {
  const created = await hr.create("candidates", auth, {
    name: `Candidate ${mark}`,
    email: `candidate${mark}@titopay.test`,
    jobTitle: "Operations Assistant",
    stage: "screening",
    notes: "",
    status: "active"
  });
  assert.ok(created.data.id);
  await hr.remove("candidates", created.data.id, auth);
  const listed = await hr.list("candidates", auth, { q: `Candidate ${mark}` });
  const items = listed.items || listed.data || [];
  assert.equal(items.filter((row) => row.id === created.data.id).length, 0, "it is gone from the list");
});
