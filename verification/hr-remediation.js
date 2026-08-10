// HR REMEDIATION — payroll amounts, expense claim approvals, employee links.
//
// Covers the findings the data-isolation harness does not:
//
//   F-03/F-19  a payslip with blank or zero amounts could not be saved
//   F-07/F-08  four independent status columns, none of them protected
//   F-04       HR Administrator was locked out of Disciplinary
//   F-06       records could name an employee who does not work here
//
// Everything here goes through the HTTP API as a signed-in person. Nothing is
// asserted by reading the source.
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const API = `http://127.0.0.1:${Number(process.argv[2] || 8110)}/v1/hr`;
const stamp = Date.now();
const PASSWORD = "HrRemediation!2026#x";
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
  console.log(`\n${"=".repeat(78)}\n  HR REMEDIATION — payroll, claim approvals, employee links\n${"=".repeat(78)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();
  // Login rate limits now persist in Postgres, so a previous run's attempts
  // would lock this one out before it started.
  await db.query("DELETE FROM rate_limit_counters").catch(() => {});

  const { hashPassword } = require("./api/src/lib/passwords");
  const hash = await hashPassword(PASSWORD);

  // Three real people: an employee who claims, a finance approver, and an HR
  // administrator. Each has an hr_employees row so the new link resolves.
  const cast = [
    { tag: "claimant", first: "Cleo", role: "Employee" },
    { tag: "finance", first: "Faith", role: "Finance" },
    { tag: "hradmin", first: "Hugo", role: "HR Administrator" }
  ];
  for (const person of cast) {
    person.email = `hr${person.tag}${stamp}@titopay.local`;
    person.name = `${person.first} Remedy`;
    const emp = await db.query(
      `INSERT INTO hr_employees (employee_number, first_name, last_name, email, job_title, department, status)
       VALUES ($1,$2,'Remedy',$3,'Analyst','Testing','active') RETURNING id`,
      [`R${String(stamp).slice(-6)}${person.tag[0].toUpperCase()}`, person.first, person.email]);
    person.employeeId = emp.rows[0].id;
    const user = await db.query(
      `INSERT INTO hr_users (name, email, password_hash, role, status, employee_id)
       VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
      [person.name, person.email, hash, person.role, person.employeeId]);
    person.userId = user.rows[0].id;
    const login = await call("/auth/login", { method: "POST", body: { email: person.email, password: PASSWORD } });
    person.token = login.payload?.accessToken || login.payload?.tokens?.accessToken;
    check(`${person.role} signed in`, Boolean(person.token),
      person.token ? "" : JSON.stringify(login.payload).slice(0, 100));
  }
  const [claimant, finance, hradmin] = cast;
  if (cast.some((p) => !p.token)) {
    console.log("\n  Cannot continue without all three logins.\n");
    await db.end();
    process.exit(1);
  }

  const created = { payroll: [], expenses: [], disciplinary: [] };

  /* ================================================== F-03/F-19  payroll */
  section("1. A payslip saves whatever combination of amounts it has");
  const payrollCases = [
    ["all values zero", { baseSalary: 0, allowances: 0, deductions: 0, bonuses: 0 }, 0],
    ["blank fields (an untouched form)", { baseSalary: "", allowances: "", deductions: "", bonuses: "" }, 0],
    ["salary only", { baseSalary: 25000 }, 25000],
    ["salary + allowance", { baseSalary: 25000, allowances: 1500 }, 26500],
    ["salary + deductions", { baseSalary: 25000, deductions: 3200 }, 21800],
    ["salary + allowance + deductions", { baseSalary: 25000, allowances: 1500, deductions: 3200 }, 23300],
    ["decimal values", { baseSalary: 25000.55, allowances: 0.45, deductions: 1.0 }, 25000.0]
  ];
  let month = 0;
  for (const [label, amounts, expectedNet] of payrollCases) {
    month += 1;
    const period = `2031-${String(month).padStart(2, "0")}`;
    const r = await call("/payroll", { method: "POST", token: hradmin.token,
      body: { employee: claimant.name, period, ...amounts } });
    const netPay = Number(r.payload?.data?.netPay ?? NaN);
    check(`payroll saves: ${label}`, r.status === 200 || r.status === 201,
      r.status === 200 || r.status === 201 ? `net R${netPay.toFixed(2)}`
        : `HTTP ${r.status} ${JSON.stringify(r.payload).slice(0, 90)}`);
    if (r.payload?.data?.id) {
      created.payroll.push(r.payload.data.id);
      check(`   net pay is right for: ${label}`, Math.abs(netPay - expectedNet) < 0.005,
        `expected R${expectedNet.toFixed(2)}, got R${Number.isNaN(netPay) ? "?" : netPay.toFixed(2)}`);
    }
  }

  const rubbish = await call("/payroll", { method: "POST", token: hradmin.token,
    body: { employee: claimant.name, period: "2031-11", baseSalary: "abc" } });
  check("payroll still refuses a value that is not a number", rubbish.status === 400, `HTTP ${rubbish.status}`);
  const negative = await call("/payroll", { method: "POST", token: hradmin.token,
    body: { employee: claimant.name, period: "2031-12", baseSalary: -100 } });
  check("payroll still refuses a negative amount", negative.status === 400, `HTTP ${negative.status}`);

  /* ============================================== F-07/F-08  claim status */
  section("2. An expense claim has ONE status, and nobody approves their own");
  const filed = await call("/expenses", { method: "POST", token: claimant.token,
    body: { employee: claimant.name, type: "travel", amount: 480.5, description: "Client visit" } });
  check("employee can file a claim", filed.status === 200 || filed.status === 201,
    `HTTP ${filed.status} ${filed.status >= 400 ? JSON.stringify(filed.payload).slice(0, 90) : ""}`);
  const claimId = filed.payload?.data?.id;
  if (claimId) created.expenses.push(claimId);
  check("a new claim starts at manager review", filed.payload?.data?.status === "manager_review",
    String(filed.payload?.data?.status));

  // The claimant is an Employee (expenses:self) — the three decisions are not theirs.
  const selfApprove = await call(`/expenses/${claimId}`, { method: "PATCH", token: claimant.token,
    body: { managerStatus: "approved", financeStatus: "approved", paymentStatus: "paid" } });
  const afterSelf = await db.query(
    "SELECT manager_status, finance_status, payment_status, status FROM hr_expense_claims WHERE id = $1", [claimId]);
  check("a claimant's own approval is not recorded",
    afterSelf.rows[0].manager_status === "pending" && afterSelf.rows[0].status === "manager_review",
    `HTTP ${selfApprove.status}, now ${afterSelf.rows[0].status}/${afterSelf.rows[0].manager_status}`);

  // Finance holds the whole expenses module — but not over its own claim.
  const financeClaim = await call("/expenses", { method: "POST", token: finance.token,
    body: { employee: finance.name, type: "travel", amount: 99, description: "Own claim" } });
  if (financeClaim.payload?.data?.id) created.expenses.push(financeClaim.payload.data.id);
  const ownApproval = await call(`/expenses/${financeClaim.payload?.data?.id}`, { method: "PATCH",
    token: finance.token, body: { managerStatus: "approved" } });
  check("APPROVER CANNOT APPROVE THEIR OWN CLAIM", ownApproval.status === 403,
    `HTTP ${ownApproval.status} ${JSON.stringify(ownApproval.payload?.error || ownApproval.payload).slice(0, 80)}`);

  // The ladder: finance cannot approve before a manager has, and nothing is
  // paid before finance approves.
  const earlyPay = await call(`/expenses/${claimId}`, { method: "PATCH", token: finance.token,
    body: { paymentStatus: "paid" } });
  check("a claim cannot be marked paid before finance approves it", earlyPay.status === 400,
    `HTTP ${earlyPay.status}`);
  const earlyFinance = await call(`/expenses/${claimId}`, { method: "PATCH", token: finance.token,
    body: { financeStatus: "approved" } });
  check("finance cannot approve before a manager does", earlyFinance.status === 400,
    `HTTP ${earlyFinance.status}`);

  // The proper sequence, one decision at a time. Each step must leave the
  // earlier decision alone — that is what a partial PATCH used to overwrite.
  const step1 = await call(`/expenses/${claimId}`, { method: "PATCH", token: hradmin.token,
    body: { managerStatus: "approved" } });
  check("a manager approves", step1.status === 200 && step1.payload?.data?.status === "manager_approved",
    `HTTP ${step1.status} ${step1.payload?.data?.status}`);

  const step2 = await call(`/expenses/${claimId}`, { method: "PATCH", token: finance.token,
    body: { financeStatus: "approved" } });
  check("finance approves, and the manager's approval survives",
    step2.status === 200 && step2.payload?.data?.status === "finance_approved"
      && step2.payload?.data?.managerStatus === "approved",
    `HTTP ${step2.status} ${step2.payload?.data?.status}/${step2.payload?.data?.managerStatus}`);

  const step3 = await call(`/expenses/${claimId}`, { method: "PATCH", token: finance.token,
    body: { paymentStatus: "paid" } });
  check("payment is recorded, and both approvals survive",
    step3.status === 200 && step3.payload?.data?.status === "paid"
      && step3.payload?.data?.managerStatus === "approved"
      && step3.payload?.data?.financeStatus === "approved",
    `HTTP ${step3.status} ${step3.payload?.data?.status}`);

  const conflicting = await db.query(
    `SELECT COUNT(*)::int AS n FROM hr_expense_claims
      WHERE id = $1 AND ((payment_status = 'paid' AND finance_status <> 'approved')
                      OR (finance_status = 'approved' AND manager_status <> 'approved'))`, [claimId]);
  check("NO CLAIM SHOWS TWO CONTRADICTORY STATUSES", conflicting.rows[0].n === 0);

  // A claim the frontend supplies a status for directly: still derived.
  const forced = await call("/expenses", { method: "POST", token: hradmin.token,
    body: { employee: claimant.name, type: "meals", amount: 12, status: "paid" } });
  if (forced.payload?.data?.id) created.expenses.push(forced.payload.data.id);
  check("a status supplied by the frontend is ignored",
    forced.payload?.data?.status === "manager_review", String(forced.payload?.data?.status));

  /* ================================================== F-04  disciplinary */
  section("3. HR Administrator can use Disciplinary");
  const discList = await call("/disciplinary?limit=5", { token: hradmin.token });
  check("HR Administrator can open Disciplinary", discList.status === 200, `HTTP ${discList.status}`);
  const discCreate = await call("/disciplinary", { method: "POST", token: hradmin.token,
    body: { caseNumber: `DC-${stamp}`, employee: claimant.name, type: "verbal_warning",
      description: "Test case", status: "open" } });
  check("HR Administrator can open a case", discCreate.status === 200 || discCreate.status === 201,
    `HTTP ${discCreate.status} ${discCreate.status >= 400 ? JSON.stringify(discCreate.payload).slice(0, 80) : ""}`);
  if (discCreate.payload?.data?.id) created.disciplinary.push(discCreate.payload.data.id);
  const discEmployee = await call("/disciplinary?limit=5", { token: claimant.token });
  check("an ordinary employee still cannot open Disciplinary", discEmployee.status === 403,
    `HTTP ${discEmployee.status}`);

  /* ================================================= F-06  employee links */
  section("4. A record cannot name someone who does not work here");
  const madeUp = await call("/expenses", { method: "POST", token: hradmin.token,
    body: { employee: "hh", type: "travel", amount: 50 } });
  check("a claim for \"hh\" is refused", madeUp.status === 400,
    `HTTP ${madeUp.status} ${JSON.stringify(madeUp.payload?.error?.message || madeUp.payload).slice(0, 90)}`);
  const madeUpLeave = await call("/leave", { method: "POST", token: hradmin.token,
    body: { employee: "hh", type: "annual", startDate: "2031-03-01", endDate: "2031-03-02" } });
  check("leave for \"hh\" is refused", madeUpLeave.status === 400, `HTTP ${madeUpLeave.status}`);
  const madeUpPayroll = await call("/payroll", { method: "POST", token: hradmin.token,
    body: { employee: "hh", period: "2031-09", baseSalary: 100 } });
  check("a payslip for \"hh\" is refused", madeUpPayroll.status === 400, `HTTP ${madeUpPayroll.status}`);

  const linked = await db.query(
    "SELECT employee_id, employee FROM hr_expense_claims WHERE id = $1", [claimId]);
  check("a real claim is linked to the employee record, not just their name",
    linked.rows[0].employee_id === claimant.employeeId,
    `${linked.rows[0].employee} -> ${linked.rows[0].employee_id ? "linked" : "NOT LINKED"}`);

  const byNumber = await call("/expenses", { method: "POST", token: hradmin.token,
    body: { employee: `R${String(stamp).slice(-6)}C`, type: "travel", amount: 20 } });
  if (byNumber.payload?.data?.id) created.expenses.push(byNumber.payload.data.id);
  check("an employee number identifies the same person",
    byNumber.payload?.data?.employee === claimant.name, String(byNumber.payload?.data?.employee));

  /* ====================================================== nothing regressed */
  section("5. The isolation fixes still hold");
  const otherClaims = await call("/expenses?limit=200", { token: claimant.token });
  const rows = otherClaims.payload?.data || [];
  check("an employee sees only their own claims",
    rows.length > 0 && rows.every((row) => row.employee === claimant.name),
    `${rows.length} row(s)`);

  // Cleanup: only what this test created.
  for (const [table, ids] of [["hr_payroll_records", created.payroll],
    ["hr_expense_claims", created.expenses], ["hr_disciplinary_cases", created.disciplinary]]) {
    if (ids.length) await db.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  }
  await db.query("DELETE FROM hr_leave_requests WHERE employee_id = ANY($1::uuid[])",
    [cast.map((p) => p.employeeId)]);
  await db.query("DELETE FROM hr_sessions WHERE user_id = ANY($1::uuid[])", [cast.map((p) => p.userId)]);
  await db.query("DELETE FROM hr_users WHERE id = ANY($1::uuid[])", [cast.map((p) => p.userId)]);
  await db.query("DELETE FROM hr_employees WHERE id = ANY($1::uuid[])", [cast.map((p) => p.employeeId)]);
  await db.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(78)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`    - ${f.name}`);
  console.log(`${"=".repeat(78)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.stack || e.message); process.exit(1); });
