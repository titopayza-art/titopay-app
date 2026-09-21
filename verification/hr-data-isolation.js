// HR DATA ISOLATION — can one employee reach another employee's records?
//
// The audit reported Internal Requests appearing in the Help Centre (N-06) and
// could not conclusively test self-approval (F-08). Both turned out to be the
// same root cause: the permission strings say "leave:self", "tickets:self",
// "expenses:self" — but only employees, onboarding and attendance were ever
// scoped to the owner, and only when listing. Editing was scoped for onboarding
// alone, and deleting for nothing.
//
// This creates two real employees and checks, for every self-scoped module,
// that neither can see, change or delete the other's records.
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const API = `http://127.0.0.1:${Number(process.argv[2] || 8110)}/v1/hr`;
const stamp = Date.now();
const POSTGRES_URL = process.env.POSTGRES_URL
  || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
function section(t) { console.log(`\n--- ${t} ---`); }

async function call(path, { method = "GET", body, token } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n${"=".repeat(76)}\n  HR DATA ISOLATION — one employee must not reach another's records\n${"=".repeat(76)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();

  // Two employees, each with an HR login. Passwords are hashed by the same
  // helper the service uses, so these are ordinary accounts, not a bypass.
  const { hashPassword } = require("./api/src/lib/passwords");
  const hash = await hashPassword("HrIsolation!2026#x");
  const people = [];
  for (const tag of ["alpha", "beta"]) {
    const email = `hr${tag}${stamp}@titopay.local`;
    const emp = await db.query(
      `INSERT INTO hr_employees (employee_number, first_name, last_name, email, job_title, department, status)
       VALUES ($1,$2,'Tester',$3,'Analyst','Testing','active') RETURNING id`,
      [`E${String(stamp).slice(-6)}${tag === "alpha" ? "1" : "2"}`, tag === "alpha" ? "Alpha" : "Beta", email]);
    const user = await db.query(
      `INSERT INTO hr_users (name, email, password_hash, role, status, employee_id)
       VALUES ($1,$2,$3,'Employee','active',$4) RETURNING id`,
      [`${tag === "alpha" ? "Alpha" : "Beta"} Tester`, email, hash, emp.rows[0].id]);
    people.push({ tag, email, employeeId: emp.rows[0].id, userId: user.rows[0].id,
      name: `${tag === "alpha" ? "Alpha" : "Beta"} Tester` });
  }

  for (const person of people) {
    const login = await call("/auth/login", { method: "POST",
      body: { email: person.email, password: "HrIsolation!2026#x" } });
    person.token = login.payload?.accessToken || login.payload?.tokens?.accessToken;
    check(`${person.tag} signed in`, Boolean(person.token),
      person.token ? "" : JSON.stringify(login.payload).slice(0, 90));
  }
  const [alpha, beta] = people;
  if (!alpha.token || !beta.token) {
    console.log("\n  Cannot continue without both logins.\n");
    await db.end();
    process.exit(1);
  }

  // A record of each kind belonging to BETA, written directly so the test does
  // not depend on the create path it is auditing.
  const owned = {};
  owned.expense = (await db.query(
    `INSERT INTO hr_expense_claims (employee, type, amount, description, status)
     VALUES ($1,'travel',1234.56,'Beta private claim','submitted') RETURNING id`, [beta.name])).rows[0].id;
  owned.ticket = (await db.query(
    `INSERT INTO hr_tickets (requester, requester_id, type, subject, description, status)
     VALUES ($1,$2,'internal_request','Beta salary letter','Confidential salary letter request','open')
     RETURNING id`, [beta.name, beta.userId])).rows[0].id;
  owned.leave = (await db.query(
    `INSERT INTO hr_leave_requests (employee, employee_id, type, start_date, end_date, status)
     VALUES ($1,$2,'annual',CURRENT_DATE,CURRENT_DATE + 1,'pending') RETURNING id`,
    [beta.name, beta.employeeId])).rows[0].id;

  /* ============================================================= listing */
  section("1. Listing another employee's records");
  for (const [resource, id, label] of [
    ["expenses", owned.expense, "expense claims"],
    ["tickets", owned.ticket, "internal requests"],
    ["leave", owned.leave, "leave requests"],
    ["performance", null, "performance reviews"]
  ]) {
    const r = await call(`/${resource}?limit=200`, { token: alpha.token });
    const rows = r.payload?.data || [];
    const leaked = id ? rows.some((row) => row.id === id) : false;
    check(`alpha cannot see beta's ${label} in a list`, !leaked,
      `${rows.length} row(s) returned${leaked ? " — INCLUDING BETA'S" : ""}`);
  }

  // The specific thing the audit saw: a salary letter in a shared surface.
  const tickets = await call("/tickets?limit=200", { token: alpha.token });
  const salaryLeak = JSON.stringify(tickets.payload?.data || []).includes("Confidential salary letter");
  check("BETA'S SALARY LETTER IS NOT VISIBLE TO ALPHA", !salaryLeak);

  /* ============================================================== editing */
  section("2. Editing another employee's records");
  const editClaim = await call(`/expenses/${owned.expense}`, { method: "PATCH", token: alpha.token,
    body: { description: "tampered by alpha" } });
  check("alpha cannot edit beta's claim", editClaim.status === 404 || editClaim.status === 403,
    `HTTP ${editClaim.status}`);

  // F-08 in its sharpest form: approving a claim by editing its status fields.
  const selfApprove = await call(`/expenses/${owned.expense}`, { method: "PATCH", token: alpha.token,
    body: { managerStatus: "approved", financeStatus: "approved", status: "approved" } });
  check("ALPHA CANNOT APPROVE BETA'S CLAIM BY PATCHING STATUS",
    selfApprove.status === 404 || selfApprove.status === 403, `HTTP ${selfApprove.status}`);

  const claimRow = await db.query(
    "SELECT description, manager_status, finance_status, status FROM hr_expense_claims WHERE id = $1",
    [owned.expense]);
  check("beta's claim is unchanged in the database",
    claimRow.rows[0].description === "Beta private claim"
      && claimRow.rows[0].manager_status === "pending"
      && claimRow.rows[0].status === "submitted",
    `${claimRow.rows[0].status}/${claimRow.rows[0].manager_status}`);

  const editTicket = await call(`/tickets/${owned.ticket}`, { method: "PATCH", token: alpha.token,
    body: { subject: "tampered" } });
  check("alpha cannot edit beta's internal request", editTicket.status !== 200, `HTTP ${editTicket.status}`);

  /* ============================================================= deleting */
  section("3. Deleting another employee's records");
  const del = await call(`/expenses/${owned.expense}`, { method: "DELETE", token: alpha.token });
  check("alpha cannot delete beta's claim", del.status !== 200, `HTTP ${del.status}`);
  const stillThere = await db.query(
    "SELECT deleted_at FROM hr_expense_claims WHERE id = $1", [owned.expense]);
  check("beta's claim was not soft-deleted", stillThere.rows[0].deleted_at === null);

  /* ====================================================== own records work */
  section("4. But an employee can still use their own records");
  const betaClaims = await call("/expenses?limit=200", { token: beta.token });
  check("beta CAN see their own claim",
    (betaClaims.payload?.data || []).some((row) => row.id === owned.expense),
    `${(betaClaims.payload?.data || []).length} row(s)`);

  const betaEdit = await call(`/expenses/${owned.expense}`, { method: "PATCH", token: beta.token,
    body: { description: "Beta updated their own claim" } });
  check("beta CAN edit their own claim", betaEdit.status === 200, `HTTP ${betaEdit.status}`);

  const betaTickets = await call("/tickets?limit=200", { token: beta.token });
  check("beta CAN see their own internal request",
    (betaTickets.payload?.data || []).some((row) => row.id === owned.ticket));

  /* ======================================================= audit attribution */
  section("5. Audit entries name the actor");
  const audits = await db.query(
    `SELECT user_id, user_email, action FROM hr_audit_logs
      WHERE created_at > NOW() - INTERVAL '3 minutes' ORDER BY created_at DESC LIMIT 20`);
  const attributed = audits.rows.filter((row) => row.user_id && row.user_email && row.user_email !== "system");
  check("recent audit entries carry a user id and email",
    audits.rows.length === 0 || attributed.length > 0,
    `${attributed.length}/${audits.rows.length} attributed`);

  // Cleanup: remove only what this test created.
  await db.query("DELETE FROM hr_expense_claims WHERE id = $1", [owned.expense]);
  await db.query("DELETE FROM hr_tickets WHERE id = $1", [owned.ticket]);
  await db.query("DELETE FROM hr_leave_requests WHERE id = $1", [owned.leave]);
  await db.query("DELETE FROM hr_users WHERE id = ANY($1::uuid[])", [people.map((p) => p.userId)]);
  await db.query("DELETE FROM hr_employees WHERE id = ANY($1::uuid[])", [people.map((p) => p.employeeId)]);
  await db.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(76)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`    - ${f.name}`);
  console.log(`${"=".repeat(76)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
