// DOES A REPLY ACTUALLY REACH HR?
//
// The queue row can be inspected for a replyTo in its metadata, but that only
// proves the intention was recorded. This runs the real delivery path against a
// local SMTP sink and reads the headers the API actually sent — which is the
// only way to know the worker applies the override, and the only test in this
// project that exercises sending at all.
//
// Nothing leaves the machine: the provider is pointed at 127.0.0.1:2525.
const fs = require("fs");
const path = require("path");
process.env.SMTP_HOST = "127.0.0.1";
process.env.SMTP_PORT = "2525";
process.env.SMTP_SECURE = "false";
process.env.SMTP_REJECT_UNAUTHORIZED = "false";
process.env.HR_EMAIL_ENABLED = "true";

const API_DIR = path.join(__dirname, "api");
require(path.join(API_DIR, "src/config/env"));
const { pool } = require(path.join(API_DIR, "src/db/pool"));
const email = require(path.join(API_DIR, "src/services/email-centre-service"));
const hrEmail = require(path.join(API_DIR, "src/services/hr-email-service"));

const INBOX = `${__dirname}/fake-smtp-inbox.json`;
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

(async () => {
  console.log(`\n${"=".repeat(78)}\n  HR EMAIL DELIVERY — the headers that actually go out\n${"=".repeat(78)}\n`);
  const stamp = Date.now();
  fs.writeFileSync(INBOX, "[]");

  // Templates are seeded ON CONFLICT DO NOTHING, so a database that already
  // holds an older copy of an HR template keeps it. That is correct for
  // production — an operator's edits are not to be overwritten by a deploy —
  // but it means this test would otherwise send the previous design and prove
  // nothing about the current one. The HR templates are dropped so they seed
  // fresh; customer templates are left exactly as they are.
  await pool.query(`DELETE FROM email_template_versions WHERE template_id IN
    (SELECT id FROM email_templates WHERE template_key LIKE 'hr\\_%')`);
  await pool.query(`DELETE FROM email_templates WHERE template_key LIKE 'hr\\_%'`);

  await email.seedDefaultTemplates();
  await email.ensureEmailSchema();
  // Earlier test runs leave queued messages behind, and the worker claims the
  // oldest first — so without this the cycle below claims somebody else's
  // backlog and reports that nothing was sent.
  await pool.query("DELETE FROM email_queue WHERE status IN ('queued','processing')");
  // Point the Email Centre at the sink and make sure sending is on.
  await pool.query(`UPDATE email_settings SET default_provider='smtp', sending_enabled=TRUE`);
  const settingsRow = await pool.query("SELECT reply_to_email, sender_email FROM email_settings LIMIT 1");
  const globalReplyTo = settingsRow.rows[0].reply_to_email;

  const employeeEmail = `delivery${stamp}@titopay.local`;
  const employee = await pool.query(
    `INSERT INTO hr_employees (employee_number, first_name, last_name, email, job_title, department, status)
     VALUES ($1,'Delivery','Tester',$2,'Analyst','Testing','active') RETURNING id, first_name, last_name, email`,
    [`D${String(stamp).slice(-6)}`, employeeEmail]);

  await hrEmail.setHrEmailConfig({ enabled: true, contactEmail: "hr@titopay.co.za" }, null);
  const config = await hrEmail.getHrEmailConfig();
  check("staff email is on for this test", config.enabled === true,
    `env ${config.environmentAllows}, operator ${config.operatorEnabled}`);

  // A leave decision addressed to that employee.
  const queuedJob = await hrEmail.leaveDecided({
    id: `00000000-0000-4000-8000-${String(stamp).slice(-12)}`,
    employee_id: employee.rows[0].id, employee: "Delivery Tester",
    type: "annual", start_date: "2026-09-01", end_date: "2026-09-03", days: 3,
    status: "approved", manager_comment: "Approved."
  });
  check("the message was queued", Boolean(queuedJob && queuedJob.id),
    queuedJob?.skipped ? `skipped: ${queuedJob.reason}` : "");

  // Run the worker's own claim-and-send cycle, once.
  const jobs = await email.claimJobs(`delivery-test-${stamp}`, 20);
  const mine = jobs.filter((job) => job.recipient === employeeEmail.toLowerCase());
  check("the worker claimed it", mine.length === 1, `${jobs.length} job(s) claimed, ${mine.length} mine`);
  for (const job of mine) await email.processJob(job);
  await new Promise((r) => setTimeout(r, 800));

  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
  const sent = inbox.find((m) => m.includes(employeeEmail));
  check("IT WAS ACTUALLY DELIVERED", Boolean(sent), `${inbox.length} message(s) reached the sink`);

  if (sent) {
    const header = (name) => {
      const match = sent.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
      return match ? match[1].trim() : "";
    };
    check("REPLYING REACHES HR, NOT CUSTOMER SUPPORT",
      header("Reply-To").includes("hr@titopay.co.za"),
      `Reply-To: ${header("Reply-To") || "(absent)"}`);
    check("and that is NOT the global reply address customer email uses",
      globalReplyTo !== "hr@titopay.co.za", `customer email replies to ${globalReplyTo}`);
    check("the subject says what happened", /leave was approved/i.test(header("Subject")),
      header("Subject"));
    // The body arrives quoted-printable, so soft line breaks and =XX escapes
    // have to come out before anything is looked for in it. Searching the raw
    // message would also match the headers, and the Reply-To header contains
    // the very address this is meant to find in the body.
    const body = sent.split(/\r?\n\r?\n/).slice(1).join("\n")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
    check("the body tells staff where to write",
      /hr@titopay\.co\.za/.test(body), "found in the message body, not just the headers");
    check("and marks itself as internal, not customer mail",
      /TITOPAY STAFF|internal message for TitoPay staff/i.test(body));
    check("the outcome is stated as its own element, not buried in a sentence",
      /Approved/.test(body) && /Leave request/i.test(body));
  }

  // A customer message must still reply to the global address.
  fs.writeFileSync(INBOX, "[]");
  const customer = await email.queueRawEmail({
    recipient: `customer${stamp}@titopay.local`, subject: "Customer notice",
    htmlBody: "<p>Hello.</p>", textBody: "Hello.",
    idempotencyKey: `delivery-customer-${stamp}`, metadata: { source: "test" }
  });
  const customerJobs = await email.claimJobs(`delivery-test-c-${stamp}`, 20);
  for (const job of customerJobs) await email.processJob(job);
  await new Promise((r) => setTimeout(r, 800));
  const customerInbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
  const customerSent = customerInbox.find((m) => m.includes(`customer${stamp}`));
  if (customerSent) {
    const replyTo = (customerSent.match(/^Reply-To:\s*(.+)$/im) || [])[1] || "";
    check("A CUSTOMER EMAIL STILL REPLIES TO CUSTOMER SUPPORT",
      !replyTo.includes("hr@titopay.co.za"), `Reply-To: ${replyTo.trim() || "(absent)"}`);
  } else {
    check("a customer email was sent for comparison", false, "not delivered");
  }

  // Delivery logs reference the queue, so they go first.
  await pool.query(`DELETE FROM email_delivery_events WHERE log_id IN
    (SELECT id FROM email_delivery_logs WHERE queue_id IN
      (SELECT id FROM email_queue WHERE recipient LIKE $1))`, [`%${stamp}%`]).catch(() => {});
  await pool.query(`DELETE FROM email_delivery_logs WHERE queue_id IN
    (SELECT id FROM email_queue WHERE recipient LIKE $1)`, [`%${stamp}%`]).catch(() => {});
  await pool.query("DELETE FROM email_queue WHERE recipient LIKE $1", [`%${stamp}%`]);
  await pool.query("DELETE FROM hr_employees WHERE id = $1", [employee.rows[0].id]);
  await hrEmail.setHrEmailConfig({ enabled: false }, null);
  await pool.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(78)}\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`    - ${f.name}`);
  console.log(`${"=".repeat(78)}\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.stack || e.message); process.exit(1); });
