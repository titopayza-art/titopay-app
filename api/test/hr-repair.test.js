"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/pool");
const { postgresSslForUrl, isLocalPostgresHost } = require("../src/db/pool");
const { hasHrPermission } = require("../src/middleware/hr-auth");
const hr = require("../src/services/hr-service");

const hrAdmin = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "hr@titopay.test",
  name: "HR Admin",
  role: "HR Admin"
};

test("production PostgreSQL TLS stays off for local VPS databases and on for remote databases", () => {
  assert.equal(
    postgresSslForUrl("postgres://api:test@127.0.0.1:5432/titopay", "production"),
    false
  );
  assert.equal(postgresSslForUrl("postgres://api:test@10.0.0.8:5432/titopay", "production"), false);
  assert.equal(postgresSslForUrl("postgres://api:test@172.20.1.8:5432/titopay", "production"), false);
  assert.equal(postgresSslForUrl("postgres://api:test@192.168.1.8:5432/titopay", "production"), false);
  assert.equal(postgresSslForUrl("postgres://api:test@postgres:5432/titopay", "production"), false);
  assert.deepEqual(
    postgresSslForUrl("postgres://api:test@database.example:5432/titopay", "production"),
    { rejectUnauthorized: false }
  );
  assert.equal(
    postgresSslForUrl("postgres://api:test@database.example:5432/titopay", "production", "false"),
    false
  );
  assert.equal(isLocalPostgresHost("database.example"), false);
});

test("legacy support columns are repaired before support backfill and chat tables", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8");
  const addUpdatedAt = schema.indexOf(
    "ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at"
  );
  const ticketBackfill = schema.indexOf("DO $$", addUpdatedAt);
  const chatTables = schema.indexOf("CREATE TABLE IF NOT EXISTS support_conversations");

  assert.ok(addUpdatedAt >= 0, "legacy support_tickets.updated_at repair is missing");
  assert.ok(ticketBackfill > addUpdatedAt, "ticket backfill must run after the column repair");
  assert.ok(chatTables > ticketBackfill, "chat tables must be created after the safe backfill");
});

test("production HR role aliases preserve scoped RBAC", () => {
  assert.equal(hasHrPermission("HR Admin", "employees", "write"), true);
  assert.equal(hasHrPermission("HR Admin", "payroll", "write"), true);
  assert.equal(hasHrPermission("Accountant", "payroll", "write"), true);
  assert.equal(hasHrPermission("Manager", "projects", "delete"), true);
  assert.equal(hasHrPermission("Compliance", "meetings", "write"), false);
  assert.equal(hasHrPermission("Employee", "payroll", "read"), false);
});

test("project progress rejects values outside 0 to 100", async () => {
  await assert.rejects(
    hr.create("projects", hrAdmin, { projectName: "Repair", progress: -3 }),
    (error) => error.statusCode === 400 && /between 0 and 100/.test(error.message)
  );
  await assert.rejects(
    hr.create("projects", hrAdmin, { projectName: "Repair", progress: 101 }),
    (error) => error.statusCode === 400 && /between 0 and 100/.test(error.message)
  );
});

test("HR schema persists every field exposed by learning, expense and announcement forms", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../src/db/hr-schema.sql"), "utf8");
  for (const column of [
    "format",
    "overview",
    "level",
    "video_url",
    "pdf_url",
    "presentation_url",
    "image_url",
    "certificate_enabled",
    "description",
    "priority"
  ]) {
    assert.match(schema, new RegExp(`\\b${column}\\b`));
  }
});

test("payroll uses decimal-safe reconciliation and blocks duplicate periods", async () => {
  const originalQuery = pool.query;
  let insertedValues;
  pool.query = async (sql, params = []) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    // A payslip now has to name a real employee, so creating one looks the
    // person up first. The stub answers with the employee this payslip is for.
    if (query.startsWith("SELECT id, first_name, last_name FROM hr_employees")) {
      return { rows: [{ id: "employee-1", first_name: "Test", last_name: "Employee" }] };
    }
    if (query.startsWith("SELECT id FROM hr_payroll_records")) return { rows: [] };
    if (query.startsWith("INSERT INTO hr_payroll_records")) {
      insertedValues = params;
      return { rows: [{
        id: "payroll-1",
        employee: "Test Employee",
        period: "2026-07",
        base_salary: 1000,
        uif: 2.4,
        net_pay: 997.6
      }] };
    }
    if (query.startsWith("INSERT INTO hr_audit_logs")) return { rows: [] };
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    const result = await hr.create("payroll", hrAdmin, {
      employee: "Test Employee",
      period: "2026-07",
      baseSalary: "1000.00",
      uif: "2.40"
    });
    assert.equal(result.data.netPay, 997.6);
    assert.ok(insertedValues.includes("997.60"));
  } finally {
    pool.query = originalQuery;
  }
});

test("employee creation reports duplicates instead of overwriting records", async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT COUNT(*)")) return { rows: [{ value: 1 }] };
    if (query.startsWith("INSERT INTO hr_employees")) {
      const error = new Error("duplicate");
      error.code = "23505";
      throw error;
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    await assert.rejects(
      hr.create("employees", hrAdmin, {
        firstName: "Test",
        lastName: "Employee",
        email: "existing@titopay.test",
        jobTitle: "Engineer",
        department: "Engineering"
      }),
      (error) => error.statusCode === 409
    );
  } finally {
    pool.query = originalQuery;
  }
});

test("attendance clock-in and clock-out use the authenticated identity and Johannesburg work date", async () => {
  const originalQuery = pool.query;
  const openRow = {
    id: "attendance-1",
    employee_id: "employee-1",
    employee: "HR Admin",
    work_date: "2026-07-27",
    clock_in: "2026-07-27T06:00:00.000Z",
    clock_out: null,
    break_minutes: 0,
    status: "present"
  };
  let attendanceLookup = 0;
  const queries = [];
  pool.query = async (sql, params = []) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    queries.push(query);
    // The employee record the signed-in account is linked to. Its spelling of
    // the name is the canonical one and is what gets stored — the account name
    // is only the fallback for an HR user with no employee record.
    if (query.startsWith("SELECT id, concat_ws")) {
      assert.ok(
        params.includes("employee-1"),
        "the contract must be looked up by the authenticated employee id"
      );
      return {
        rows: [{
          id: "employee-1",
          employee_name: "Canonical Employee Name",
          work_start_time: "08:00",
          work_end_time: "17:00",
          lunch_minutes: 60
        }]
      };
    }
    if (query.startsWith("SELECT * FROM hr_attendance_records")) {
      attendanceLookup += 1;
      return { rows: attendanceLookup === 1 ? [] : [openRow] };
    }
    if (query.startsWith("INSERT INTO hr_attendance_records")) {
      assert.equal(params[1], "Canonical Employee Name");
      assert.equal(params[0], "employee-1", "the record must carry the employee foreign key");
      return { rows: [openRow] };
    }
    if (query.startsWith("UPDATE hr_attendance_records") && query.includes("clock_out")) {
      return {
        rows: [{
          ...openRow,
          clock_out: "2026-07-27T15:00:00.000Z",
          status: "complete"
        }]
      };
    }
    if (query.startsWith("INSERT INTO hr_audit_logs")) return { rows: [] };
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    const auth = { ...hrAdmin, employeeId: "employee-1" };
    // A name in the request body is a signature, never an identity: posting a
    // colleague's name must not move the record onto them.
    const clockIn = await hr.clock(auth, {
      action: "clock_in", workMode: "Remote",
      fullName: "Somebody Else", employee: "Somebody Else"
    });
    const clockOut = await hr.clock(auth, { action: "clock_out", workMode: "Remote" });
    assert.ok(
      !queries.some((query) => query.includes("lower(concat_ws(' ', first_name, last_name)) = lower(")),
      "the employee must never be looked up by a name from the request body"
    );

    assert.equal(clockIn.action, "clocked_in");
    assert.equal(clockOut.action, "clocked_out");
    assert.ok(
      queries.some((query) => query.includes("(NOW() AT TIME ZONE 'Africa/Johannesburg')::date")),
      "attendance must use the Johannesburg calendar date"
    );
  } finally {
    pool.query = originalQuery;
  }
});

test("attendance export is a structured multipage-safe PDF", async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT * FROM hr_attendance_records")) {
      return {
        rowCount: 1,
        rows: [{
          employee: "Test Employee",
          work_date: "2026-07-27",
          clock_in: "08:00",
          clock_out: "17:00",
          break_minutes: 60,
          regular_minutes: 480,
          overtime_minutes: 0,
          minutes_late: 0,
          status: "complete"
        }]
      };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    const result = await hr.exportResource("attendance", "pdf", hrAdmin);
    const text = result.body.toString("latin1");
    assert.equal(result.contentType, "application/pdf");
    assert.match(text, /^%PDF-1\.4/);
    assert.match(text, /Attendance Report/);
    assert.match(text, /Employee/);
    assert.match(text, /Page 1 of 1/);
  } finally {
    pool.query = originalQuery;
  }
});

test("HR login accepts the employee number promised by the portal", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/hr-service.js"), "utf8");
  assert.match(source, /LEFT JOIN hr_employees e ON e\.id = u\.employee_id/);
  assert.match(source, /lower\(u\.email\) = lower\(\$1\)/);
  assert.match(source, /lower\(e\.employee_number\) = lower\(\$1\)/);
});

test("HR PostgreSQL queries quote the reserved value alias", () => {
  const hrServiceSource = fs.readFileSync(path.join(__dirname, "../src/services/hr-service.js"), "utf8");
  assert.doesNotMatch(hrServiceSource, /COUNT\(\*\)::int\s+value\b/i);
  assert.match(hrServiceSource, /COUNT\(\*\)::int AS \\"value\\"/);
  assert.match(hrServiceSource, /ORDER BY \\"value\\" DESC/);
});
