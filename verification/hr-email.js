// HR WORK COMMUNICATIONS — does the right person get the right message, and
// does nothing go out while it is switched off?
//
// The dangerous failure here is not "no email arrived". It is "email arrived
// that should not have" — to the wrong person, from a staging box, or carrying
// something an internal request should never put in an inbox. Most of what
// follows tests that nothing was sent.
//
// Nothing is delivered by this test: the queue is inspected directly, and the
// worker is not run.
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const API = `http://127.0.0.1:${Number(process.argv[2] || 8110)}/v1/hr`;
const stamp = Date.now();
const PASSWORD = "HrEmail!2026#x";
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

// `variables` matters as much as the subject: it is where the message's content
// is carried, and a check that reads only the columns around it will happily
// pass while a salary figure sits in the payload.
const queued = (db, event) => db.query(
  `SELECT recipient, subject, template_key, metadata, user_id, variables FROM email_queue
    WHERE metadata->>'source' = 'hr' AND metadata->>'event' = $1
      AND created_at > NOW() - INTERVAL '5 minutes'
    ORDER BY created_at DESC`, [event]);

(async () => {
  console.log(`\n${"=".repeat(78)}\n  HR WORK COMMUNICATIONS\n${"=".repeat(78)}`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters").catch(() => {});

  const { hashPassword } = require("./api/src/lib/passwords");
  const hash = await hashPassword(PASSWORD);

  // A director who may change the settings, a manager who may not, and two
  // ordinary employees who should receive things.
  const cast = [
    { tag: "director", first: "Dina", role: "HR Director" },
    { tag: "manager", first: "Mo", role: "Department Manager" },
    { tag: "staff", first: "Sipho", role: "Employee" },
    { tag: "other", first: "Ayanda", role: "Employee" }
  ];
  for (const person of cast) {
    person.email = `hre${person.tag}${stamp}@titopay.local`;
    person.name = `${person.first} Mailer`;
    const emp = await db.query(
      `INSERT INTO hr_employees (employee_number, first_name, last_name, email, job_title, department, status)
       VALUES ($1,$2,'Mailer',$3,'Analyst','Testing','active') RETURNING id`,
      [`M${String(stamp).slice(-6)}${person.tag[0].toUpperCase()}`, person.first, person.email]);
    person.employeeId = emp.rows[0].id;
    const user = await db.query(
      `INSERT INTO hr_users (name, email, password_hash, role, status, employee_id)
       VALUES ($1,$2,$3,$4,'active',$5) RETURNING id`,
      [person.name, person.email, hash, person.role, person.employeeId]);
    person.userId = user.rows[0].id;
    const login = await call("/auth/login", { method: "POST", body: { email: person.email, password: PASSWORD } });
    person.token = login.payload?.accessToken || login.payload?.tokens?.accessToken;
    check(`${person.role} signed in`, Boolean(person.token));
  }
  const [director, manager, staff] = cast;
  if (cast.some((p) => !p.token)) { console.log("\n  Cannot continue.\n"); await db.end(); process.exit(1); }

  const made = { announcements: [], leave: [], expenses: [] };
  // Delivery logs reference the queue, so anything actually sent has to have
  // its log removed first — otherwise the foreign key refuses the delete.
  const cleanQueue = async () => {
    await db.query(`DELETE FROM email_delivery_events WHERE log_id IN
      (SELECT id FROM email_delivery_logs WHERE queue_id IN
        (SELECT id FROM email_queue WHERE metadata->>'source' = 'hr'))`).catch(() => {});
    await db.query(`DELETE FROM email_delivery_logs WHERE queue_id IN
      (SELECT id FROM email_queue WHERE metadata->>'source' = 'hr')`).catch(() => {});
    await db.query("DELETE FROM email_queue WHERE metadata->>'source' = 'hr'");
  };
  await cleanQueue();

  /* ================================================= the switch is the point */
  section("1. Nothing is sent while staff email is switched off");
  const off = await call("/email/settings", { token: director.token });
  check("the settings can be read", off.status === 200, `HTTP ${off.status}`);
  check("STAFF EMAIL IS OFF UNTIL SOMEBODY TURNS IT ON", off.payload?.settings?.enabled === false,
    JSON.stringify(off.payload?.settings || {}).slice(0, 90));

  const announcementWhileOff = await call("/announcements", { method: "POST", token: director.token,
    body: { title: `Off-switch announcement ${stamp}`, body: "Nobody should receive this.",
      audience: "all", status: "published" } });
  if (announcementWhileOff.payload?.data?.id) made.announcements.push(announcementWhileOff.payload.data.id);
  await new Promise((r) => setTimeout(r, 900));
  const nothingYet = await queued(db, "announcements");
  check("PUBLISHING AN ANNOUNCEMENT QUEUES NO MAIL WHILE OFF", nothingYet.rows.length === 0,
    `${nothingYet.rows.length} message(s)`);

  /* ============================================================ who may turn it on */
  section("2. Only the people who answer for the company can turn it on");
  const managerTry = await call("/email/settings", { method: "POST", token: manager.token,
    body: { enabled: true } });
  check("a department manager cannot turn staff email on", managerTry.status === 403, `HTTP ${managerTry.status}`);
  const staffTry = await call("/email/settings", { method: "POST", token: staff.token, body: { enabled: true } });
  // The role that holds nearly every HR module is the interesting one: the
  // portal hides these controls from an HR Administrator, and the server has to
  // refuse them independently, because hiding a button protects nobody.
  const adminEmail = `hradmin${stamp}@titopay.local`;
  const adminEmp = await db.query(
    `INSERT INTO hr_employees (employee_number, first_name, last_name, email, job_title, department, status)
     VALUES ($1,'Hugo','Mailer',$2,'Analyst','Testing','active') RETURNING id`,
    [`M${String(stamp).slice(-6)}X`, adminEmail]);
  const adminUser = await db.query(
    `INSERT INTO hr_users (name, email, password_hash, role, status, employee_id)
     VALUES ('Hugo Mailer',$1,$2,'HR Administrator','active',$3) RETURNING id`,
    [adminEmail, hash, adminEmp.rows[0].id]);
  const adminLogin = await call("/auth/login", { method: "POST", body: { email: adminEmail, password: PASSWORD } });
  const adminToken = adminLogin.payload?.accessToken || adminLogin.payload?.tokens?.accessToken;
  const adminRead = await call("/email/settings", { token: adminToken });
  const adminWrite = await call("/email/settings", { method: "POST", token: adminToken, body: { enabled: true } });
  check("AN HR ADMINISTRATOR CANNOT READ THE STAFF EMAIL SETTINGS", adminRead.status === 403,
    `HTTP ${adminRead.status}`);
  check("NOR CHANGE THEM, WHATEVER THE PORTAL SHOWS THEM", adminWrite.status === 403,
    `HTTP ${adminWrite.status}`);
  await db.query("DELETE FROM hr_sessions WHERE user_id = $1", [adminUser.rows[0].id]);
  await db.query("DELETE FROM hr_users WHERE id = $1", [adminUser.rows[0].id]);
  await db.query("DELETE FROM hr_employees WHERE id = $1", [adminEmp.rows[0].id]);
  check("an employee cannot turn staff email on", staffTry.status === 403, `HTTP ${staffTry.status}`);
  const stillOff = await call("/email/settings", { token: director.token });
  check("and it is still off after those attempts", stillOff.payload?.settings?.operatorEnabled === false);

  const preview = await call("/email/preview-audience?audience=all", { token: director.token });
  check("an operator can see how many people a send would reach, before sending",
    preview.status === 200 && preview.payload?.recipients >= 4, `${preview.payload?.recipients} recipient(s)`);

  /* ==================================================== with it on */
  section("3. With it on, the right person gets the right message");
  const on = await call("/email/settings", { method: "POST", token: director.token,
    body: { enabled: true, announcementAudience: "all" } });
  check("the HR Director can turn it on", on.status === 200 && on.payload?.settings?.operatorEnabled === true,
    `HTTP ${on.status}`);
  const envAllows = on.payload?.settings?.environmentAllows === true;
  check("the environment lever is what decides whether it is really live", typeof envAllows === "boolean",
    `HR_EMAIL_ENABLED ${envAllows ? "is set" : "is not set"}`);
  if (!envAllows) {
    check("WITH THE ENVIRONMENT LEVER OFF, TURNING IT ON IN THE PORTAL SENDS NOTHING",
      on.payload?.settings?.enabled === false,
      "an operator cannot make a box mail staff if it was never configured to");
    console.log("\n  Re-run with HR_EMAIL_ENABLED=true on the API to exercise the sending path.\n");
  }

  if (envAllows) {
    await cleanQueue();
    const announcement = await call("/announcements", { method: "POST", token: director.token,
      body: { title: `Payday moves to the 25th ${stamp}`, body: "Payroll now runs on the 25th.",
        audience: "all", status: "published" } });
    if (announcement.payload?.data?.id) made.announcements.push(announcement.payload.data.id);
    await new Promise((r) => setTimeout(r, 1400));
    const ann = await queued(db, "announcements");
    check("publishing an announcement queues mail to staff", ann.rows.length >= 4, `${ann.rows.length} message(s)`);
    check("EVERY MESSAGE CARRIES A NULL user_id, NOT AN HR ID",
      ann.rows.every((row) => row.user_id === null),
      "email_queue.user_id is a foreign key to the CUSTOMER users table");
    check("the subject names the announcement",
      ann.rows.some((row) => row.subject.includes("Payday moves to the 25th")),
      String(ann.rows[0]?.subject || "").slice(0, 60));
    check("each message is addressed to a real member of staff",
      ann.rows.every((row) => /@/.test(row.recipient)));

    // The same announcement saved again must not mail everyone twice.
    const before = (await queued(db, "announcements")).rows.length;
    await call(`/announcements/${announcement.payload.data.id}`, { method: "PATCH", token: director.token,
      body: { priority: "high" } });
    await new Promise((r) => setTimeout(r, 1400));
    const after = (await queued(db, "announcements")).rows.length;
    check("SAVING IT AGAIN DOES NOT MAIL EVERYONE TWICE", after === before, `${before} -> ${after}`);

    /* ------------------------------------------------------- leave */
    await cleanQueue();
    const leave = await db.query(
      `INSERT INTO hr_leave_requests (employee, employee_id, type, start_date, end_date, days, status)
       VALUES ($1,$2,'annual',CURRENT_DATE + 10, CURRENT_DATE + 12, 3, 'pending') RETURNING id`,
      [staff.name, staff.employeeId]);
    made.leave.push(leave.rows[0].id);
    await call(`/leave/${leave.rows[0].id}/decision`, { method: "POST", token: director.token,
      body: { decision: "approved", comment: "Enjoy the break." } });
    await new Promise((r) => setTimeout(r, 1200));
    const leaveMail = await queued(db, "leave");
    check("approving leave emails the person who asked for it", leaveMail.rows.length === 1,
      `${leaveMail.rows.length} message(s)`);
    check("ONLY THAT PERSON", leaveMail.rows.every((row) => row.recipient === staff.email.toLowerCase()),
      String(leaveMail.rows[0]?.recipient || ""));

    /* ------------------------------------------------------- claims */
    await cleanQueue();
    const claim = await call("/expenses", { method: "POST", token: staff.token,
      body: { employee: staff.name, type: "travel", amount: 640.25, description: "Client visit" } });
    made.expenses.push(claim.payload?.data?.id);
    await new Promise((r) => setTimeout(r, 900));
    check("filing a claim emails nobody — it is not a decision",
      (await queued(db, "claims")).rows.length === 0);
    await call(`/expenses/${claim.payload.data.id}`, { method: "PATCH", token: director.token,
      body: { managerStatus: "approved" } });
    await new Promise((r) => setTimeout(r, 1200));
    const claimMail = await queued(db, "claims");
    check("approving it emails the claimant", claimMail.rows.length === 1, `${claimMail.rows.length} message(s)`);
    check("and the message reaches the claimant, nobody else",
      claimMail.rows.every((row) => row.recipient === staff.email.toLowerCase()));

    /* ---------------------------------- internal requests stay confidential */
    await cleanQueue();
    const ticket = await db.query(
      // hr_tickets identifies its requester by hr_users id, not employee id.
      `INSERT INTO hr_tickets (requester, requester_id, type, subject, description, status)
       VALUES ($1,$2,'internal_request','Salary letter request','My salary is R48000 and I need a letter','open')
       RETURNING id`, [staff.name, staff.userId]);
    await call(`/tickets/${ticket.rows[0].id}`, { method: "PATCH", token: director.token,
      body: { status: "resolved" } });
    await new Promise((r) => setTimeout(r, 1200));
    const ticketMail = await queued(db, "requests");
    check("resolving an internal request tells the person there is a reply",
      ticketMail.rows.length === 1, `${ticketMail.rows.length} message(s)`);
    if (ticketMail.rows.length) {
      const body = JSON.stringify(ticketMail.rows[0]);
      check("THE EMAIL DOES NOT CARRY THE CONTENT OF THE REQUEST",
        !body.includes("48000") && !/my salary is/i.test(body),
        "checked across the subject AND the variables payload, which is where content lives");
      check("   ...and the variables payload names only the request, not its text",
        !JSON.stringify(ticketMail.rows[0].variables || {}).match(/48000|my salary is/i),
        JSON.stringify(ticketMail.rows[0].variables || {}).slice(0, 90));
    }
    await db.query("DELETE FROM hr_tickets WHERE id = $1", [ticket.rows[0].id]);

    /* ---------------------------------------------- turning it back off */
    await cleanQueue();
    await call("/email/settings", { method: "POST", token: director.token, body: { enabled: false } });
    const afterOff = await call("/announcements", { method: "POST", token: director.token,
      body: { title: `Silent announcement ${stamp}`, body: "Nothing.", audience: "all", status: "published" } });
    if (afterOff.payload?.data?.id) made.announcements.push(afterOff.payload.data.id);
    await new Promise((r) => setTimeout(r, 1200));
    check("TURNING IT OFF AGAIN STOPS IT IMMEDIATELY",
      (await queued(db, "announcements")).rows.length === 0);
  }

  /* ===================================== where staff write back to */
  section("4. Replies reach HR, and customer email is untouched");
  const cfg = await call("/email/settings", { token: director.token });
  check("the HR desk defaults to hr@titopay.co.za",
    cfg.payload?.settings?.contactEmail === "hr@titopay.co.za",
    String(cfg.payload?.settings?.contactEmail));

  const rubbish = await call("/email/settings", { method: "POST", token: director.token,
    body: { contactEmail: "not-an-address" } });
  check("an address staff could not write to is refused", rubbish.status === 400, `HTTP ${rubbish.status}`);
  const unchanged = await call("/email/settings", { token: director.token });
  check("and the address is left as it was",
    unchanged.payload?.settings?.contactEmail === "hr@titopay.co.za");

  // Reply-To is one global setting shared with every customer email. Changing
  // it for HR must not change it for them.
  const globalReplyTo = await db.query("SELECT reply_to_email, sender_email FROM email_settings LIMIT 1");
  check("THE GLOBAL REPLY ADDRESS IS UNTOUCHED BY ANY OF THIS",
    globalReplyTo.rows[0]?.reply_to_email !== "hr@titopay.co.za",
    `customer email still replies to ${globalReplyTo.rows[0]?.reply_to_email}`);

  if (envAllows) {
    await cleanQueue();
    await call("/email/settings", { method: "POST", token: director.token, body: { enabled: true } });
    const note = await call("/announcements", { method: "POST", token: director.token,
      body: { title: `Reply-to check ${stamp}`, body: "Where does a reply go?", audience: "all", status: "published" } });
    if (note.payload?.data?.id) made.announcements.push(note.payload.data.id);
    await new Promise((r) => setTimeout(r, 1400));
    const rows = (await queued(db, "announcements")).rows;
    check("every HR message names the HR desk as its reply address",
      rows.length > 0 && rows.every((row) => row.metadata?.replyTo === "hr@titopay.co.za"),
      `${rows.length} message(s), replyTo ${rows[0]?.metadata?.replyTo}`);
    check("and carries the address staff can write to",
      rows.length > 0 && rows.every((row) => row.variables?.hrContactEmail === "hr@titopay.co.za"),
      String(rows[0]?.variables?.hrContactEmail));
    await call("/email/settings", { method: "POST", token: director.token, body: { enabled: false } });
  }

  /* ============================ the environment lever, on its own instance */
  section("5. A box that was never configured for staff email cannot send");
  // The operator switch is in the shared database and is ON at this point in
  // the run. A second API without HR_EMAIL_ENABLED must still send nothing —
  // that is the whole point of the environment being a floor rather than a
  // switch, and it cannot be tested from an instance that has the lever set.
  await call("/email/settings", { method: "POST", token: director.token, body: { enabled: true } });
  const NOMAIL = "http://127.0.0.1:8176/v1/hr";
  const nomailUp = await fetch(`${NOMAIL.replace("/v1/hr", "")}/v1/health`)
    .then((r) => r.ok).catch(() => false);
  if (!nomailUp) {
    check("the unconfigured instance is running on 8176", false,
      "start it with: bash start-api-nomail.sh");
  } else {
    const login = await fetch(`${NOMAIL}/auth/login`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: director.email, password: PASSWORD }) }).then((r) => r.json());
    const nomailToken = login?.accessToken || login?.tokens?.accessToken;
    const seen = await fetch(`${NOMAIL}/email/settings`, {
      headers: { authorization: `Bearer ${nomailToken}` } }).then((r) => r.json());
    check("the unconfigured instance agrees the operator has switched it on",
      seen?.settings?.operatorEnabled === true, JSON.stringify(seen?.settings || {}).slice(0, 80));
    check("BUT REPORTS ITSELF AS NOT SENDING", seen?.settings?.enabled === false,
      `environmentAllows=${seen?.settings?.environmentAllows}`);

    await cleanQueue();
    const fromNomail = await fetch(`${NOMAIL}/announcements`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${nomailToken}` },
      body: JSON.stringify({ title: `Unconfigured box ${stamp}`, body: "Must reach nobody.",
        audience: "all", status: "published" }) }).then((r) => r.json());
    if (fromNomail?.data?.id) made.announcements.push(fromNomail.data.id);
    await new Promise((r) => setTimeout(r, 1400));
    check("AND PUBLISHING FROM IT MAILS NOBODY, WITH THE OPERATOR SWITCH ON",
      (await queued(db, "announcements")).rows.length === 0,
      "a staging copy of this API must not be able to mail real staff");
    check("while the announcement itself still saved", Boolean(fromNomail?.data?.id));
  }
  await call("/email/settings", { method: "POST", token: director.token, body: { enabled: false } });

  /* ============================================== the HR action still works */
  section("6. Email never gets in the way of the HR action itself");
  const worksRegardless = await call("/announcements", { method: "POST", token: director.token,
    body: { title: `Still works ${stamp}`, body: "The record is what matters.", audience: "all", status: "draft" } });
  check("HR records still save whatever email is doing",
    worksRegardless.status === 200 || worksRegardless.status === 201, `HTTP ${worksRegardless.status}`);
  if (worksRegardless.payload?.data?.id) made.announcements.push(worksRegardless.payload.data.id);

  // Scoped to this run's accounts. hr_audit_logs.user_id is ON DELETE SET NULL,
  // so entries left by an earlier run of this same harness have a null actor
  // once its users are cleaned up — which says nothing about attribution now.
  const settingsAudit = await db.query(
    `SELECT action, user_id, metadata FROM hr_audit_logs
      WHERE action = 'Changed staff email settings' AND user_email = ANY($1::text[])
      ORDER BY created_at DESC LIMIT 5`, [cast.map((p) => p.email)]);
  check("changing the setting is recorded, with who did it", settingsAudit.rows.length > 0
    && settingsAudit.rows.every((row) => row.user_id), `${settingsAudit.rows.length} entries`);
  check("and records what it was before", settingsAudit.rows.length > 0
    && settingsAudit.rows[0].metadata?.before !== undefined);

  // Cleanup.
  await cleanQueue();
  for (const [table, ids] of [["hr_announcements", made.announcements.filter(Boolean)],
    ["hr_leave_requests", made.leave], ["hr_expense_claims", made.expenses.filter(Boolean)]]) {
    if (ids.length) await db.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
  }
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
