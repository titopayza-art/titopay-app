// Render the HR emails exactly as the Email Centre would, and write them to
// disk so they can be looked at rather than imagined.
const fs = require("fs");
require("./api/src/config/env");
const email = require("./api/src/services/email-centre-service");
const settings = { company_name: "TitoPay", tagline: "Smart payments simplified",
  support_email: "support@titopay.co.za", support_url: "https://titopay.co.za/support",
  website_url: "https://titopay.co.za" };
const samples = {
  hr_announcement: { firstName: "Sipho", announcementPriority: "Important announcement", decisionTone: "#0b3f8f", announcementTitle: "Payday moves to the 25th",
    announcementBody: "From November, salaries are paid on the 25th of each month instead of the last working day. Nothing else about your payslip changes.",
    announcementPriority: "high", appUrl: "https://titopay.co.za/hr" },
  hr_leave_decision: { firstName: "Ayanda", leaveType: "annual", leaveStart: "2026-09-14",
    leaveEnd: "2026-09-18", leaveDays: "5 days", decision: "approved", decisionTone: "#127a4a", announcementPriority: "Internal message",
    decisionComment: "Enjoy the break — please hand over to Mo before you go.", appUrl: "https://titopay.co.za/hr" },
  hr_claim_decision: { firstName: "Thandi", claimType: "travel", claimAmount: "640.25", announcementPriority: "Internal message",
    currency: "ZAR", decision: "finance approved", decisionTone: "#127a4a", appUrl: "https://titopay.co.za/hr" },
  hr_claim_rejected: { firstName: "Thandi", claimType: "travel", claimAmount: "640.25", announcementPriority: "Internal message",
    currency: "ZAR", decision: "rejected", decisionTone: "#b3261e", appUrl: "https://titopay.co.za/hr" },
  hr_request_update: { firstName: "Mo", requestReference: "a1b2c3d4", announcementPriority: "Internal message", decision: "resolved", decisionTone: "#127a4a",
    requestSubject: "Salary letter request", requestStatus: "resolved", appUrl: "https://titopay.co.za/hr" },
  hr_onboarding_task: { firstName: "Lerato", announcementPriority: "Internal message", decisionTone: "#0b3f8f", taskTitle: "Sign your employment contract",
    taskCategory: "Paperwork", taskDueDate: "2026-08-20", appUrl: "https://titopay.co.za/hr" },
  hr_training_reminder: { firstName: "Sipho", announcementPriority: "Internal message", decisionTone: "#0b3f8f", courseTitle: "Anti-Fraud and AML Awareness",
    courseDueDate: "2026-08-01", appUrl: "https://titopay.co.za/hr" }
};
const out = [];
for (const [key, name, subject, body] of email.DEFAULT_TEMPLATES) {
  if (!key.startsWith("hr_")) continue;
  if (key === "hr_claim_decision") {
    const r = email.renderTemplate({ subject, html_body: body, text_body: "" }, samples.hr_claim_rejected, settings);
    fs.writeFileSync(`${__dirname}/hr-email-hr_claim_rejected.html`, r.html);
  }
  const rendered = email.renderTemplate(
    { subject, html_body: body, text_body: body.replace(/<[^>]+>/g, " ") }, samples[key], settings);
  fs.writeFileSync(`${__dirname}/hr-email-${key}.html`, rendered.html);
  out.push({ key, name, subject: rendered.subject });
}
console.table(out);
