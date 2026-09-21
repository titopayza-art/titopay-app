"use strict";

// Find HR records that look like test or placeholder data — and delete none.
//
// The audit reported entries such as "tyui", "yui", "STRATEGISING" and "Team
// dinner" scattered across Announcements, Projects and Internal Requests. What
// it could not say is which of those are somebody's leftovers and which are a
// real announcement written in a hurry. "Team dinner" is a perfectly ordinary
// thing for a company to announce.
//
// So this reports and stops. It prints what it suspects, why, and the exact id,
// and then a person decides. Deleting through the HR portal is a soft delete
// that records who did it — which is the mechanism this report is meant to
// feed, rather than working around.
//
//     npm run hr:hygiene              list suspected records
//     npm run hr:hygiene -- --all     also list every record in the modules
//
// Nothing here writes to the database. It is safe to run against production.

const path = require("path");

require("../src/config/env");
const { pool } = require("../src/db/pool");

const SHOW_ALL = process.argv.includes("--all");

// Why a record draws attention. Each rule says what it noticed, in words a
// person can disagree with — the point is to make the judgement possible, not
// to make it automatically.
const SUSPICIONS = [
  { why: "no vowels and no spaces — looks like a keyboard test",
    test: (text) => /^[a-z]{2,10}$/i.test(text) && !/[aeiou]/i.test(text) },
  { why: "adjacent keyboard keys, in order",
    test: (text) => /^(?:qwer|wert|erty|rtyu|tyui|yuio|uiop|asdf|sdfg|dfgh|fghj|ghjk|hjkl|zxcv|xcvb|cvbn|vbnm)[a-z]*$/i.test(text) },
  { why: "one repeated character",
    test: (text) => /^(.)\1{1,}$/.test(text) },
  { why: "shorter than three characters",
    test: (text) => text.length > 0 && text.length < 3 },
  { why: "says test, demo, sample, dummy, placeholder or lorem",
    test: (text) => /\b(test|testing|demo|sample|dummy|placeholder|lorem ipsum|asdf|foo|bar|xxx)\b/i.test(text) },
  { why: "written entirely in capitals",
    test: (text) => text.length > 3 && text === text.toUpperCase() && /[A-Z]{4,}/.test(text) }
];

const MODULES = [
  { name: "Announcements", table: "hr_announcements", label: "title", extra: ["body", "status"] },
  { name: "Projects", table: "hr_projects", label: "project_name", extra: ["status"] },
  { name: "Internal requests", table: "hr_tickets", label: "subject", extra: ["type", "status"] },
  { name: "Recruitment", table: "hr_recruitment_candidates", label: "name", extra: ["job_title", "stage"] },
  { name: "Recruitment jobs", table: "hr_recruitment_jobs", label: "title", extra: ["status"] },
  { name: "Employees", table: "hr_employees", label: "concat_ws(' ', first_name, last_name)", extra: ["job_title", "department", "status"] },
  { name: "Payroll", table: "hr_payroll_records", label: "employee", extra: ["period", "status"] },
  { name: "Expense claims", table: "hr_expense_claims", label: "employee", extra: ["type", "status"] },
  { name: "Leave", table: "hr_leave_requests", label: "employee", extra: ["type", "status"] },
  { name: "Attendance", table: "hr_attendance_records", label: "employee", extra: ["work_date", "status"] },
  { name: "Learning courses", table: "hr_learning_courses", label: "title", extra: ["category", "status"] },
  { name: "Company documents", table: "hr_company_documents", label: "title", extra: ["category", "version"] },
  { name: "Onboarding", table: "hr_onboarding_tasks", label: "employee", extra: ["title", "status"] },
  { name: "Disciplinary", table: "hr_disciplinary_cases", label: "employee", extra: ["type", "status"] },
  { name: "Assets", table: "hr_assets", label: "asset_tag", extra: ["type", "assigned_to", "status"] },
  { name: "Meetings", table: "hr_meetings", label: "title", extra: ["status"] },
  { name: "Departments", table: "hr_departments", label: "name", extra: [] }
];

function suspicionsFor(text) {
  const value = String(text || "").trim();
  if (!value) return ["blank"];
  return SUSPICIONS.filter((rule) => rule.test(value)).map((rule) => rule.why);
}

async function scan(module) {
  const columns = ["id", `${module.label} AS label`, ...module.extra, "created_at"];
  let rows;
  try {
    const result = await pool.query(
      `SELECT ${columns.join(", ")} FROM ${module.table}
        WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500`);
    rows = result.rows;
  } catch (error) {
    // A table this build does not have is not a failure worth stopping for.
    return { module, missing: true, message: error.message, rows: [], flagged: [] };
  }
  const flagged = rows
    .map((row) => ({ row, why: suspicionsFor(row.label) }))
    .filter((entry) => entry.why.length);
  return { module, missing: false, rows, flagged };
}

function describe(row, module) {
  const detail = module.extra
    .map((key) => row[key])
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
    .map((value) => String(value).slice(0, 24))
    .join(" · ");
  return detail ? ` (${detail})` : "";
}

async function main() {
  console.log(`\n  HR DATA HYGIENE — suspected test and placeholder records`);
  console.log(`  Nothing is deleted by this report.\n`);

  let flaggedTotal = 0;
  let recordTotal = 0;
  for (const module of MODULES) {
    const result = await scan(module);
    if (result.missing) {
      console.log(`  ${module.name}: not in this build`);
      continue;
    }
    recordTotal += result.rows.length;
    flaggedTotal += result.flagged.length;

    if (!result.flagged.length && !SHOW_ALL) continue;
    console.log(`\n  ${module.name} — ${result.rows.length} record(s), ${result.flagged.length} to look at`);
    for (const { row, why } of result.flagged) {
      console.log(`    ${row.id}`);
      console.log(`      "${String(row.label).slice(0, 60)}"${describe(row, module)}`);
      console.log(`      ${why.join("; ")}`);
    }
    if (SHOW_ALL) {
      const rest = result.rows.filter((row) => !result.flagged.some((f) => f.row.id === row.id));
      for (const row of rest) {
        console.log(`    ok  "${String(row.label).slice(0, 60)}"${describe(row, module)}`);
      }
    }
  }

  console.log(`\n  ${flaggedTotal} record(s) worth a look, out of ${recordTotal} across ${MODULES.length} modules.`);
  if (flaggedTotal) {
    console.log(`
  These are SUSPICIONS, not verdicts. "Team dinner" is a real thing to announce
  and a company really can employ someone with a short name. Read each one,
  decide whether it is a leftover, and delete the ones that are through the HR
  portal — that records who removed it and keeps the row for the audit trail.
`);
  } else {
    console.log(`  Nothing looks like leftover test data.\n`);
  }
  await pool.end();
}

main().catch(async (error) => {
  console.error("\n  Could not complete the hygiene report:", error.message);
  console.error(`  Run it from the API directory (${path.join(__dirname, "..")}).\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
