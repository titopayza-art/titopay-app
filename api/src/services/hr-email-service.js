"use strict";

// HR work communications, sent through the email system TitoPay already has.
//
// This adds no mail path. Everything here calls queueEmail() in the Email
// Centre — the same function the customer app uses for a welcome email and
// Marketing uses for a campaign — so HR mail inherits the provider settings,
// the branding, the retry and dead-letter behaviour, the delivery log, and the
// operator's global off switch. What is new is which events raise a message and
// who it goes to.
//
// Three things about this system had to be worked around rather than through,
// and each one is a trap for whoever touches it next:
//
//   1. email_queue.user_id is a foreign key to `users` — the CUSTOMER table.
//      HR staff live in hr_users, and passing one of those ids makes the insert
//      fail. Every send here passes userId: null and records who the message is
//      about in metadata, which is JSONB and has no such constraint.
//
//   2. The Email Centre's own `sending_enabled` defaults to on, so a naive
//      integration would start mailing real staff the moment it deployed. HR
//      sending has its own switch, off unless an operator turns it on, and both
//      have to be on before anything leaves.
//
//   3. The worker that actually sends (src/email-worker.js) is a separate
//      process. If it is not running, mail queues and nothing is delivered —
//      quietly. /health reports it as ready, stalled or not_migrated.
//
// On content: a message says that something happened and where to read it. It
// does not carry salary figures, disciplinary detail, or the body of an
// internal request, because email is forwarded, printed and left open on
// shared screens. An expense claim decision is the one exception — the amount
// is the person's own claim, and a decision without the amount is not useful.

const crypto = require("crypto");
const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { getPlatformSetting, setPlatformSetting } = require("./platform-settings-service");
const { queueEmail } = require("./email-centre-service");

const SETTING_KEY = "hr_email";

// The environment is a floor, not a switch: an operator can turn HR mail off
// from the Admin Portal at any time, but nobody can turn it on in an
// environment that has not been configured for it. This is how Scan to Pay is
// gated, for the same reason — a staging box must not be able to mail staff.
function environmentAllows() {
  return String(process.env.HR_EMAIL_ENABLED || "").toLowerCase() === "true";
}

async function getHrEmailConfig() {
  const stored = await getPlatformSetting(SETTING_KEY, {});
  const operatorEnabled = stored?.value?.enabled === true;
  return {
    enabled: environmentAllows() && operatorEnabled,
    environmentAllows: environmentAllows(),
    operatorEnabled,
    // Which announcements reach whom. "all" mails every active employee;
    // "audience" restricts to the announcement's own audience field. Chosen by
    // the operator rather than fixed here, because it is a policy question
    // about who should read what.
    announcementAudience: stored?.value?.announcementAudience === "audience" ? "audience" : "all",
    events: {
      announcements: stored?.value?.events?.announcements !== false,
      leave: stored?.value?.events?.leave !== false,
      claims: stored?.value?.events?.claims !== false,
      requests: stored?.value?.events?.requests !== false,
      onboarding: stored?.value?.events?.onboarding !== false
    },
    updatedAt: stored?.updatedAt || null
  };
}

async function setHrEmailConfig(patch = {}, adminId = null) {
  const current = await getHrEmailConfig();
  const next = {
    enabled: patch.enabled === undefined ? current.operatorEnabled : Boolean(patch.enabled),
    announcementAudience: patch.announcementAudience === "audience" ? "audience"
      : patch.announcementAudience === "all" ? "all" : current.announcementAudience,
    events: { ...current.events }
  };
  for (const key of Object.keys(next.events)) {
    if (patch.events && patch.events[key] !== undefined) next.events[key] = Boolean(patch.events[key]);
  }
  await setPlatformSetting(SETTING_KEY, next, adminId);
  return getHrEmailConfig();
}

/* ------------------------------------------------------------- recipients */

const PORTAL_URL = () => process.env.HR_PORTAL_URL || `${config.appOrigin || ""}`.replace(/\/$/, "") + "/hr";

function firstNameOf(row) {
  return String(row.first_name || row.employee || "").trim().split(/\s+/)[0] || "there";
}

// Active employees with a work email address. Anyone without one is not an
// error: contractors and staff mid-onboarding legitimately have no mailbox yet.
async function activeStaff({ audience } = {}) {
  const values = [];
  let filter = "";
  const wanted = String(audience || "").trim().toLowerCase();
  if (wanted && wanted !== "all" && wanted !== "all staff") {
    values.push(wanted);
    filter = ` AND (LOWER(department) = $${values.length} OR LOWER(job_title) = $${values.length})`;
  }
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, email, department
       FROM hr_employees
      WHERE deleted_at IS NULL AND status = 'active'
        AND email IS NOT NULL AND email <> ''${filter}`, values);
  return rows;
}

async function employeeById(employeeId, fallbackName) {
  if (employeeId) {
    const { rows } = await pool.query(
      `SELECT id, first_name, last_name, email FROM hr_employees
        WHERE id = $1 AND deleted_at IS NULL`, [employeeId]);
    if (rows[0]) return rows[0];
  }
  if (!fallbackName) return null;
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, email FROM hr_employees
      WHERE deleted_at IS NULL
        AND LOWER(TRIM(first_name || ' ' || last_name)) = LOWER(TRIM($1))
      LIMIT 2`, [fallbackName]);
  // Two people with one name is not somebody to guess between.
  return rows.length === 1 ? rows[0] : null;
}

// The colour an outcome is drawn in. Fixed here rather than decided in the
// template, because a template is a static string and cannot branch — and
// fixed as a small map rather than passed through from anywhere a person can
// type, because it lands inside a style attribute.
const TONES = {
  approved: "#127a4a", manager_approved: "#127a4a", finance_approved: "#127a4a",
  paid: "#0b3f8f", payment_scheduled: "#0b3f8f",
  rejected: "#b3261e", cancelled: "#5b7799",
  resolved: "#127a4a", answered: "#127a4a", closed: "#5b7799"
};
function toneFor(decision) {
  return TONES[String(decision || "").toLowerCase().replace(/\s+/g, "_")] || "#0b3f8f";
}

// "5 days", "1 day" — not "5 day(s)", which is the sort of thing that tells a
// reader the message was assembled by a machine that did not care.
function dayCount(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return "";
  const rounded = Math.round(days * 2) / 2;
  return `${rounded % 1 === 0 ? rounded : rounded.toFixed(1)} ${rounded === 1 ? "day" : "days"}`;
}

// The eyebrow reads "TitoPay staff · <this>", so it has to be a complete phrase
// for every priority rather than a bare word that sometimes disappears.
function priorityPhrase(priority) {
  const value = String(priority || "").toLowerCase();
  if (value === "urgent" || value === "critical") return "Urgent announcement";
  if (value === "high" || value === "important") return "Important announcement";
  return "Staff announcement";
}

/* ----------------------------------------------------------------- sending */

// One place every HR message goes through, so the switch, the null user_id and
// the metadata shape cannot be got wrong in one caller and right in another.
async function send({ event, employee, templateKey, variables, reference }) {
  const settings = await getHrEmailConfig();
  if (!settings.enabled) return { skipped: true, reason: "hr_email_disabled" };
  if (settings.events[event] === false) return { skipped: true, reason: `event_disabled:${event}` };
  if (!employee?.email) return { skipped: true, reason: "no_email_address" };

  // Same event, same person, same record sends once however many times the
  // record is saved. The reference is part of the key so a second decision on
  // the same claim is a different message.
  const idempotencyKey = `hr:${event}:${reference}:${String(employee.email).toLowerCase()}`;

  try {
    const job = await queueEmail({
      recipient: employee.email,
      templateKey,
      // NOT employee.id and NOT an hr_users id: this column is a foreign key to
      // the customer users table, and either would fail the insert.
      userId: null,
      variables: {
        // Present on every HR message because the eyebrow is on every template.
        announcementPriority: "Internal message",
        decisionTone: "#0b3f8f",
        firstName: firstNameOf(employee),
        fullName: `${employee.first_name || ""} ${employee.last_name || ""}`.trim(),
        email: employee.email,
        appUrl: PORTAL_URL(),
        ...variables
      },
      idempotencyKey,
      metadata: { source: "hr", event, hrEmployeeId: employee.id || null, reference }
    });
    return job;
  } catch (error) {
    // A message that cannot be sent must never take the HR action down with
    // it. Approving leave is the operation; telling someone about it is not.
    console.error("[hr-email] queue failed", { event, reference, message: error.message });
    return { skipped: true, reason: "queue_failed", error: error.message };
  }
}

/* ------------------------------------------------------------------ events */

// An announcement that has just been published. Mail goes out once per
// announcement per person, so re-saving a published announcement does not
// send it again.
async function announcementPublished(announcement) {
  const settings = await getHrEmailConfig();
  if (!settings.enabled || settings.events.announcements === false) {
    return { skipped: true, reason: "disabled", sent: 0 };
  }
  const audience = settings.announcementAudience === "audience" ? announcement.audience : "all";
  const staff = await activeStaff({ audience });
  const results = await Promise.all(staff.map((person) => send({
    event: "announcements",
    employee: person,
    templateKey: "hr_announcement",
    reference: announcement.id,
    variables: {
      announcementTitle: announcement.title || "Company announcement",
      announcementBody: announcement.body || "",
      announcementPriority: priorityPhrase(announcement.priority)
    }
  })));
  return { sent: results.filter((r) => r && !r.skipped).length, considered: staff.length };
}

async function leaveDecided(leave) {
  const employee = await employeeById(leave.employee_id, leave.employee);
  if (!employee) return { skipped: true, reason: "employee_not_linked" };
  return send({
    event: "leave",
    employee,
    templateKey: "hr_leave_decision",
    reference: `${leave.id}:${leave.status}`,
    variables: {
      leaveType: String(leave.type || "leave"),
      leaveStart: String(leave.start_date || "").slice(0, 10),
      leaveEnd: String(leave.end_date || "").slice(0, 10),
      leaveDays: dayCount(leave.days),
      decision: String(leave.status || ""),
      decisionTone: toneFor(leave.status),
      decisionComment: String(leave.manager_comment || "")
    }
  });
}

// The amount is included because it is the person's own claim and a decision
// without it does not tell them what was actually approved.
async function claimDecided(claim) {
  const employee = await employeeById(claim.employee_id, claim.employee);
  if (!employee) return { skipped: true, reason: "employee_not_linked" };
  return send({
    event: "claims",
    employee,
    templateKey: "hr_claim_decision",
    reference: `${claim.id}:${claim.status}`,
    variables: {
      claimType: String(claim.type || "expense"),
      claimAmount: Number(claim.amount || 0).toFixed(2),
      currency: String(claim.currency || "ZAR"),
      decision: String(claim.status || "").replace(/_/g, " "),
      decisionTone: toneFor(claim.status)
    }
  });
}

// Deliberately says only that there is a reply waiting. Internal requests
// carry salary letters and grievances, and email is the wrong place for those
// to arrive in full.
async function requestUpdated(ticket) {
  // hr_tickets identifies its requester by hr_users id, not employee id — the
  // one employee-linked table that does. Going through the account is also the
  // more reliable route, because it does not depend on the name matching.
  let employeeId = null;
  if (ticket.requester_id) {
    const { rows } = await pool.query(
      "SELECT employee_id FROM hr_users WHERE id = $1 AND deleted_at IS NULL", [ticket.requester_id]);
    employeeId = rows[0]?.employee_id || null;
  }
  const employee = await employeeById(employeeId, ticket.requester);
  if (!employee) return { skipped: true, reason: "employee_not_linked" };
  return send({
    event: "requests",
    employee,
    templateKey: "hr_request_update",
    reference: `${ticket.id}:${ticket.status}`,
    variables: {
      requestReference: String(ticket.id || "").slice(0, 8),
      requestSubject: String(ticket.subject || "your request"),
      requestStatus: String(ticket.status || "").replace(/_/g, " "),
      decision: String(ticket.status || "").replace(/_/g, " "),
      decisionTone: toneFor(ticket.status)
    }
  });
}

async function onboardingAssigned(task) {
  const employee = await employeeById(task.employee_id, task.employee);
  if (!employee) return { skipped: true, reason: "employee_not_linked" };
  return send({
    event: "onboarding",
    employee,
    templateKey: "hr_onboarding_task",
    reference: task.id,
    variables: {
      taskTitle: String(task.title || "an onboarding task"),
      taskCategory: String(task.category || "Onboarding"),
      taskDueDate: task.due_date ? String(task.due_date).slice(0, 10) : "as soon as you can"
    }
  });
}

// Run from a schedule rather than an event: staff who are enrolled on a
// mandatory course they have not finished, and whose due date has passed.
// One reminder per course per person per day, so a daily schedule does not
// become a daily nag for the same thing twice.
async function mandatoryTrainingReminders({ today } = {}) {
  const settings = await getHrEmailConfig();
  if (!settings.enabled || settings.events.onboarding === false) {
    return { skipped: true, reason: "disabled", sent: 0 };
  }
  const stamp = String(today || new Date().toISOString().slice(0, 10));
  const { rows } = await pool.query(
    `SELECT e.id, e.first_name, e.last_name, e.email, c.id AS course_id, c.title, c.due_days,
            (en.created_at + (COALESCE(c.due_days, 14) || ' days')::INTERVAL)::date AS due_on
       FROM hr_learning_enrolments en
       JOIN hr_learning_courses c ON c.id = en.course_id AND c.deleted_at IS NULL
       JOIN hr_employees e ON e.id = en.employee_id AND e.deleted_at IS NULL
      WHERE en.deleted_at IS NULL
        AND c.mandatory = TRUE
        AND en.status <> 'complete'
        AND e.status = 'active'
        AND e.email IS NOT NULL AND e.email <> ''
        AND (en.created_at + (COALESCE(c.due_days, 14) || ' days')::INTERVAL)::date <= CURRENT_DATE`);
  const results = await Promise.all(rows.map((row) => send({
    event: "onboarding",
    employee: row,
    templateKey: "hr_training_reminder",
    reference: `${row.course_id}:${stamp}`,
    variables: {
      courseTitle: String(row.title || "a mandatory course"),
      courseDueDate: row.due_on ? String(row.due_on).slice(0, 10) : "already"
    }
  })));
  return { sent: results.filter((r) => r && !r.skipped).length, considered: rows.length };
}

module.exports = {
  SETTING_KEY,
  getHrEmailConfig,
  setHrEmailConfig,
  activeStaff,
  announcementPublished,
  leaveDecided,
  claimDecided,
  requestUpdated,
  onboardingAssigned,
  mandatoryTrainingReminders
};
