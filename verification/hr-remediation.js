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

  /* ============================================ salary and bank details */
  section("5. The employee directory does not hand out salaries");
  // A team lead needs the directory. They do not need everyone's bank account.
  const leadEmail = `hrlead${stamp}@titopay.local`;
  const leadEmp = await db.query(
    `INSERT INTO hr_employees (employee_number, first_name, last_name, email, job_title, department, status,
                               salary, hourly_rate, tax_number, bank_name, bank_account, medical_info, emergency_contact)
     VALUES ($1,'Lena','Lead',$2,'Team Lead','Testing','active',
             81000, 450, 'TAX-1234', 'Test Bank', '99887766', '{"notes":"private"}'::jsonb, '{"name":"Next Of Kin"}'::jsonb)
     RETURNING id`, [`L${String(stamp).slice(-6)}`, leadEmail]);
  const leadUser = await db.query(
    `INSERT INTO hr_users (name, email, password_hash, role, status, employee_id)
     VALUES ('Lena Lead',$1,$2,'Team Lead','active',$3) RETURNING id`, [leadEmail, hash, leadEmp.rows[0].id]);
  const leadLogin = await call("/auth/login", { method: "POST", body: { email: leadEmail, password: PASSWORD } });
  const leadToken = leadLogin.payload?.accessToken || leadLogin.payload?.tokens?.accessToken;
  check("Team Lead signed in", Boolean(leadToken));

  // Give the claimant pay details worth protecting.
  await db.query(
    `UPDATE hr_employees SET salary = 55000, bank_account = '11223344', tax_number = 'TAX-9999',
            medical_info = '{"notes":"confidential"}'::jsonb WHERE id = $1`, [claimant.employeeId]);

  const leadView = await call("/employees?limit=200", { token: leadToken });
  const others = (leadView.payload?.data || []).filter((row) => row.email !== leadEmail);
  check("Team Lead can still see the staff directory",
    leadView.status === 200 && others.length > 0, `${others.length} colleague(s)`);
  check("A TEAM LEAD CANNOT SEE COLLEAGUES' SALARIES",
    others.every((row) => row.salary === undefined && row.bankAccount === undefined
      && row.taxNumber === undefined && row.medicalInfo === undefined),
    JSON.stringify(others.find((row) => row.salary !== undefined) || {}).slice(0, 90));
  const ownRow = (leadView.payload?.data || []).find((row) => row.email === leadEmail);
  check("but they can see their OWN salary", ownRow && ownRow.salary !== undefined,
    ownRow ? `salary ${ownRow.salary}` : "own record missing");
  const leadNames = (leadView.payload?.data || []).filter((row) => row.name && row.jobTitle);
  check("the directory still carries names and job titles", leadNames.length > 0,
    `${leadNames.length} row(s)`);

  const csv = await fetch(`${API}/export/employees.csv`, { headers: { authorization: `Bearer ${leadToken}` } });
  const csvBody = await csv.text();
  check("THE CSV EXPORT IS REDACTED THE SAME WAY",
    !csvBody.includes("11223344") && !csvBody.includes("TAX-9999") && !csvBody.includes("confidential"),
    `${csvBody.length} bytes`);

  const payrollView = await call("/employees?limit=200", { token: finance.token });
  const payrollRows = (payrollView.payload?.data || []).filter((row) => row.email === claimant.email);
  check("Finance CAN see salaries, because paying people needs them",
    payrollRows.length === 1 && payrollRows[0].salary !== undefined,
    payrollRows.length ? `salary ${payrollRows[0].salary}` : "not found");
  check("but Finance does not see medical notes",
    payrollRows.length === 1 && payrollRows[0].medicalInfo === undefined);

  await db.query("DELETE FROM hr_sessions WHERE user_id = $1", [leadUser.rows[0].id]);
  await db.query("DELETE FROM hr_users WHERE id = $1", [leadUser.rows[0].id]);
  await db.query("DELETE FROM hr_employees WHERE id = $1", [leadEmp.rows[0].id]);

  /* ====================================================== nothing regressed */
  section("6. The isolation fixes still hold");
  const otherClaims = await call("/expenses?limit=200", { token: claimant.token });
  const rows = otherClaims.payload?.data || [];
  check("an employee sees only their own claims",
    rows.length > 0 && rows.every((row) => row.employee === claimant.name),
    `${rows.length} row(s)`);

  /* ============================================= F-02  attendance clock in */
  section("7. Clocking in records the person who is signed in");
  const clockIn = await call("/attendance/clock", { method: "POST", token: claimant.token,
    body: { action: "clock_in", workMode: "Office" } });
  check("an employee can clock in", clockIn.status === 200, `HTTP ${clockIn.status}`);
  const clockRow = await db.query(
    `SELECT id, employee, employee_id, clock_in, work_date, status, attendance_source
       FROM hr_attendance_records WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [claimant.employeeId]);
  check("the record is linked to their employee record",
    clockRow.rows[0]?.employee_id === claimant.employeeId, clockRow.rows[0]?.employee || "no row");
  check("the timestamp is written by the server, not sent by the browser",
    Boolean(clockRow.rows[0]?.clock_in), String(clockRow.rows[0]?.clock_in || ""));
  const saDate = await db.query("SELECT (NOW() AT TIME ZONE 'Africa/Johannesburg')::date AS d");
  check("the work date is today in South Africa",
    String(clockRow.rows[0]?.work_date) === String(saDate.rows[0].d),
    `${clockRow.rows[0]?.work_date} vs ${saDate.rows[0].d}`);

  const clockAgain = await call("/attendance/clock", { method: "POST", token: claimant.token,
    body: { action: "clock_in" } });
  check("clocking in twice is refused rather than duplicated", clockAgain.status === 409,
    `HTTP ${clockAgain.status}`);
  const dupes = await db.query(
    `SELECT COUNT(*)::int n FROM hr_attendance_records
      WHERE employee_id = $1 AND work_date = (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
        AND deleted_at IS NULL`, [claimant.employeeId]);
  check("exactly one attendance record exists for today", dupes.rows[0].n === 1, `${dupes.rows[0].n} row(s)`);

  // The identity must come from the session, not the request body.
  const impersonate = await call("/attendance/clock", { method: "POST", token: finance.token,
    body: { action: "clock_in", fullName: claimant.name, employee: claimant.name } });
  const stolen = await db.query(
    `SELECT COUNT(*)::int n FROM hr_attendance_records
      WHERE employee_id = $1 AND work_date = (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
        AND deleted_at IS NULL`, [claimant.employeeId]);
  check("ONE EMPLOYEE CANNOT CLOCK IN AS ANOTHER", stolen.rows[0].n === 1,
    `HTTP ${impersonate.status}, ${stolen.rows[0].n} record(s) against the claimant`);
  const financeRow = await db.query(
    `SELECT employee, employee_id FROM hr_attendance_records
      WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1`, [finance.employeeId]);
  check("their clock-in is recorded against themselves instead",
    financeRow.rows[0]?.employee === finance.name, String(financeRow.rows[0]?.employee));

  const clockOut = await call("/attendance/clock", { method: "POST", token: claimant.token,
    body: { action: "clock_out" } });
  check("clock out works", clockOut.status === 200, `HTTP ${clockOut.status}`);
  const outAgain = await call("/attendance/clock", { method: "POST", token: claimant.token,
    body: { action: "clock_out" } });
  check("clocking out twice is refused", outAgain.status === 409, `HTTP ${outAgain.status}`);

  // The sharpest version of the same question: with the target having no record
  // at all today, does a name in the request body create one against them?
  await db.query("DELETE FROM hr_attendance_records WHERE employee_id = ANY($1::uuid[])",
    [cast.map((p) => p.employeeId)]);
  const forged = await call("/attendance/clock", { method: "POST", token: hradmin.token,
    body: { action: "clock_in", fullName: claimant.name, employee: claimant.name } });
  const forgedRows = await db.query(
    `SELECT COUNT(*)::int n FROM hr_attendance_records
      WHERE (employee_id = $1 OR LOWER(employee) = LOWER($2))
        AND work_date = (NOW() AT TIME ZONE 'Africa/Johannesburg')::date
        AND deleted_at IS NULL`, [claimant.employeeId, claimant.name]);
  check("A NAME IN THE REQUEST BODY CREATES NO RECORD AGAINST THAT PERSON",
    forgedRows.rows[0].n === 0, `HTTP ${forged.status}, ${forgedRows.rows[0].n} record(s) against the claimant`);

  await db.query("DELETE FROM hr_attendance_records WHERE employee_id = ANY($1::uuid[])",
    [cast.map((p) => p.employeeId)]);

  /* ======================================== N-04/N-05  deleting records */
  section("8. Records that should be removable can be removed, safely");
  for (const [resource, table, body] of [
    ["announcements", "hr_announcements", { title: `Test announcement ${stamp}`, body: "Placeholder", audience: "all" }],
    ["recruitment", "hr_recruitment_candidates", { candidateName: `Test Candidate ${stamp}`, email: `cand${stamp}@titopay.local`, stage: "applied" }]
  ]) {
    const made = await call(`/${resource}`, { method: "POST", token: hradmin.token, body });
    const recordId = made.payload?.data?.id;
    check(`${resource}: a record can be created`, Boolean(recordId),
      recordId ? "" : `HTTP ${made.status} ${JSON.stringify(made.payload).slice(0, 80)}`);
    if (!recordId) continue;

    const refused = await call(`/${resource}/${recordId}`, { method: "DELETE", token: claimant.token });
    check(`${resource}: an ordinary employee cannot delete it`, refused.status === 403 || refused.status === 404,
      `HTTP ${refused.status}`);

    const removed = await call(`/${resource}/${recordId}`, { method: "DELETE", token: hradmin.token });
    check(`${resource}: an authorised user CAN delete it`, removed.status === 200, `HTTP ${removed.status}`);

    const after = await db.query(`SELECT deleted_at FROM ${table} WHERE id = $1`, [recordId]);
    check(`${resource}: the row is kept for the record, not destroyed`,
      after.rows.length === 1 && after.rows[0].deleted_at !== null,
      after.rows.length ? "soft deleted" : "ROW GONE");

    const listed = await call(`/${resource}?limit=200`, { token: hradmin.token });
    check(`${resource}: it disappears from the list`,
      !(listed.payload?.data || []).some((row) => row.id === recordId));

    const twice = await call(`/${resource}/${recordId}`, { method: "DELETE", token: hradmin.token });
    check(`${resource}: deleting it again says so rather than failing oddly`, twice.status === 404,
      `HTTP ${twice.status}`);

    await db.query(`DELETE FROM ${table} WHERE id = $1`, [recordId]);
  }

  /* ================================== N-02  learning resource validation */
  section("9. A course cannot publish a link that goes nowhere");
  const courseBase = { title: `Test course ${stamp}`, category: "Testing", description: "Test" };
  const badLinks = [
    ["a bare word", { videoUrl: "hr-learning" }],
    ["a host with no scheme", { pdfUrl: "www.example.com/policy.pdf" }],
    ["a javascript: URL", { presentationUrl: "javascript:alert(1)" }],
    ["a data: URL", { pdfUrl: "data:text/html,<script>alert(1)</script>" }]
  ];
  for (const [label, link] of badLinks) {
    const r = await call("/learning", { method: "POST", token: hradmin.token, body: { ...courseBase, ...link } });
    check(`a course cannot be saved with ${label}`, r.status === 400, `HTTP ${r.status}`);
    if (r.payload?.data?.id) await db.query("DELETE FROM hr_learning_courses WHERE id = $1", [r.payload.data.id]);
  }
  const goodCourse = await call("/learning", { method: "POST", token: hradmin.token,
    body: { ...courseBase, pdfUrl: "https://titopay.co.za/learning/policy.pdf", videoUrl: "/hr/media/intro.mp4" } });
  check("a course with real links still saves", goodCourse.status === 200 || goodCourse.status === 201,
    `HTTP ${goodCourse.status} ${goodCourse.status >= 400 ? JSON.stringify(goodCourse.payload).slice(0, 80) : ""}`);
  if (goodCourse.payload?.data?.id) {
    await db.query("DELETE FROM hr_learning_courses WHERE id = $1", [goodCourse.payload.data.id]);
  }

  /* ================================================ audit attribution */
  section("10. The audit log names who did it");
  const attribution = await db.query(
    `SELECT action, user_id, user_email, metadata FROM hr_audit_logs
      WHERE user_email = ANY($1::text[]) AND created_at > NOW() - INTERVAL '10 minutes'
      ORDER BY created_at DESC LIMIT 40`, [cast.map((p) => p.email)]);
  check("recent actions were recorded at all", attribution.rows.length > 0,
    `${attribution.rows.length} entries`);
  check("EVERY ENTRY CARRIES THE ACTOR'S ID",
    attribution.rows.length > 0 && attribution.rows.every((row) => row.user_id),
    `${attribution.rows.filter((r) => r.user_id).length}/${attribution.rows.length}`);
  const logins = attribution.rows.filter((row) => row.action === "Login");
  check("logins are attributed too, which they were not before",
    logins.length > 0 && logins.every((row) => row.user_id), `${logins.length} login entries`);
  check("each entry records the role the person acted under",
    attribution.rows.every((row) => row.metadata?.actorRole),
    String(attribution.rows[0]?.metadata?.actorRole));

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
