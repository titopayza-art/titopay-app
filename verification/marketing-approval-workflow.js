// THREE-SEAT MARKETING APPROVAL — CEO, COO and Senior Marketing.
//
// The questions that matter: can Senior Marketing actually approve and reject,
// can it escalate, and — the one that would quietly undo the whole point — can
// it then approve the thing it just escalated?
const fs = require("fs");
const { Client } = require("./api/node_modules/pg");

const API = `http://127.0.0.1:${Number(process.argv[2] || 8110)}/v1`;
const stamp = Date.now();
const POSTGRES_URL = process.env.POSTGRES_URL
  || fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function call(path, { method = "GET", body, token } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n${"=".repeat(76)}\n  MARKETING APPROVAL — three seats, reject and escalate\n${"=".repeat(76)}\n`);

  const db = new Client({ connectionString: POSTGRES_URL });
  await db.connect();
  await db.query("DELETE FROM rate_limit_counters");

  // The e2e admin is super_admin, which occupies the CEO seat. A second admin
  // is given the senior_marketing role so the two seats are genuinely different
  // people, which is the whole point of a multi-seat approval.
  const ceo = (await call("/admin/login", { method: "POST",
    body: { identifier: "e2e@titopay.local", password: "LocalE2E!Passw0rd#2026" } })).payload;
  check("CEO-seat admin signed in", Boolean(ceo.accessToken));

  const seniorEmail = `senior${stamp}@titopay.local`;
  // Reuse the test admin's password hash so this fixture signs in with the same
  // password. id, full_name, username, email, role and password_hash are the
  // NOT NULL columns without a default.
  await db.query(
    `INSERT INTO admin_users (id, full_name, username, email, role, password_hash)
     SELECT gen_random_uuid(), $2, $3, $4, 'senior_marketing', password_hash
       FROM admin_users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    ["e2e@titopay.local", "Senior Marketing Tester", `senior${stamp}`, seniorEmail]);
  const senior = (await call("/admin/login", { method: "POST",
    body: { identifier: seniorEmail, password: "LocalE2E!Passw0rd#2026" } })).payload;
  check("Senior Marketing admin signed in", Boolean(senior.accessToken),
    senior.accessToken ? "" : JSON.stringify(senior).slice(0, 80));

  const makeAnnouncement = async (title) => {
    const created = await call("/admin/marketing/announcements", { method: "POST", token: ceo.accessToken,
      body: { title, body: `Body for ${title}. This is a test announcement.`,
        category: "marketing", audience: "personal" } });
    return created.payload?.announcement?.id
      || (await db.query("SELECT id FROM announcement_campaigns WHERE title=$1", [title])).rows[0]?.id;
  };

  /* -------------------------------------------- Senior Marketing can approve */
  const a1 = await makeAnnouncement(`Approve by senior ${stamp}`);
  check("announcement created for approval", Boolean(a1));
  const approved = await call(`/admin/marketing/announcements/${a1}/approve`,
    { method: "POST", token: senior.accessToken });
  check("SENIOR MARKETING CAN APPROVE", approved.status === 200,
    `HTTP ${approved.status} ${String(approved.payload.error || "").slice(0, 50)}`);
  const seat = await db.query(
    "SELECT approval_role FROM announcement_approvals WHERE campaign_id=$1", [a1]);
  check("the approval is recorded in its own seat",
    seat.rows.some((r) => r.approval_role === "senior_marketing"),
    seat.rows.map((r) => r.approval_role).join(", "));

  /* --------------------------------------------- Senior Marketing can reject */
  const a2 = await makeAnnouncement(`Reject by senior ${stamp}`);
  const noReason = await call(`/admin/marketing/announcements/${a2}/reject`,
    { method: "POST", token: senior.accessToken, body: {} });
  check("a rejection without a reason is refused", noReason.status === 400, `HTTP ${noReason.status}`);

  const rejected = await call(`/admin/marketing/announcements/${a2}/reject`,
    { method: "POST", token: senior.accessToken, body: { reason: "Wording is off-brand for this quarter" } });
  check("SENIOR MARKETING CAN REJECT", rejected.status === 200, `HTTP ${rejected.status}`);
  const rejectedRow = await db.query(
    "SELECT status, decision_reason, decided_by FROM announcement_campaigns WHERE id=$1", [a2]);
  check("the rejection records the reason and who took it",
    rejectedRow.rows[0].status === "rejected"
      && /off-brand/.test(rejectedRow.rows[0].decision_reason)
      && Boolean(rejectedRow.rows[0].decided_by),
    rejectedRow.rows[0].status);

  const rejectAgain = await call(`/admin/marketing/announcements/${a2}/reject`,
    { method: "POST", token: senior.accessToken, body: { reason: "Changed my mind again" } });
  check("a decided announcement cannot be decided twice", rejectAgain.status === 409,
    `HTTP ${rejectAgain.status}`);

  /* ------------------------------------------------------------- escalation */
  const a3 = await makeAnnouncement(`Escalate ${stamp}`);
  const escalated = await call(`/admin/marketing/announcements/${a3}/escalate`,
    { method: "POST", token: senior.accessToken, body: { note: "Legal wording — needs an executive call" } });
  check("SENIOR MARKETING CAN ESCALATE TO THE CEO/COO", escalated.status === 200, `HTTP ${escalated.status}`);

  const escalatedRow = await db.query(
    "SELECT status, escalation_note, escalated_by FROM announcement_campaigns WHERE id=$1", [a3]);
  check("the escalation records the note and who raised it",
    escalatedRow.rows[0].status === "escalated"
      && /executive call/.test(escalatedRow.rows[0].escalation_note),
    escalatedRow.rows[0].status);

  const selfApprove = await call(`/admin/marketing/announcements/${a3}/approve`,
    { method: "POST", token: senior.accessToken });
  check("SENIOR MARKETING CANNOT APPROVE WHAT IT ESCALATED", selfApprove.status === 403,
    `HTTP ${selfApprove.status} ${String(selfApprove.payload.error || "").slice(0, 60)}`);

  const ceoCloses = await call(`/admin/marketing/announcements/${a3}/approve`,
    { method: "POST", token: ceo.accessToken });
  check("the CEO can close out an escalation", ceoCloses.status === 200, `HTTP ${ceoCloses.status}`);

  const cannotEscalate = await call(`/admin/marketing/announcements/${await makeAnnouncement(`No escalate ${stamp}`)}/escalate`,
    { method: "POST", token: ceo.accessToken, body: { note: "Trying to escalate from the top" } });
  check("the CEO has nobody to escalate to and is refused", cannotEscalate.status === 403,
    `HTTP ${cannotEscalate.status}`);

  /* -------------------------------------------------- nothing else regressed */
  const stillLists = await call("/admin/marketing/announcements", { token: ceo.accessToken });
  check("the announcements list still works", stillLists.status === 200, `HTTP ${stillLists.status}`);

  const audits = await db.query(
    `SELECT DISTINCT action FROM audit_logs
      WHERE action LIKE 'in_app_announcement_%' AND created_at > NOW() - INTERVAL '5 minutes'`);
  const actions = audits.rows.map((r) => r.action);
  check("rejection is in the audit log", actions.includes("in_app_announcement_rejected"), actions.join(", "));
  check("escalation is in the audit log", actions.includes("in_app_announcement_escalated"));

  // Deactivated, not deleted: announcement_approvals holds the approver with
  // ON DELETE RESTRICT, so an admin who has approved something cannot be
  // removed. That is the right rule — an approval must always name a person —
  // and the fixture respects it rather than working around it.
  await db.query("UPDATE admin_users SET status='disabled' WHERE LOWER(email)=LOWER($1)", [seniorEmail])
    .catch(() => {});
  await db.end();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
