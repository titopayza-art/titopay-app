"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const { pool } = require("../db/pool");
const { config } = require("../config/env");
const { AppError } = require("../lib/errors");
const { hashPassword } = require("../lib/passwords");
const { writeAuditLog } = require("./audit-service");
const { getEffectiveEmailProviderConfig } = require("./notification-service");

const EMAIL_PERMISSIONS = Object.freeze({
  VIEW: "EMAIL_VIEW", SEND: "EMAIL_SEND", TEMPLATE_EDIT: "EMAIL_TEMPLATE_EDIT",
  TEMPLATE_DELETE: "EMAIL_TEMPLATE_DELETE", QUEUE_MANAGE: "EMAIL_QUEUE_MANAGE",
  LOG_VIEW: "EMAIL_LOG_VIEW", SETTINGS_EDIT: "EMAIL_SETTINGS_EDIT",
  PROVIDER_EDIT: "EMAIL_PROVIDER_EDIT", TEST_SEND: "EMAIL_TEST_SEND"
});
const ALLOWED_VARIABLES = new Set([
  "firstName", "lastName", "fullName", "email", "businessName", "amount", "currency",
  "transactionReference", "verificationLink", "resetPasswordLink", "supportEmail", "supportUrl",
  "companyName", "currentYear", "ticketReference", "kycStatus", "accountType", "otp", "appUrl", "websiteUrl",
  "expiryMinutes", "statementPeriod", "statementReference", "transactionCount", "moneyIn", "moneyOut", "netMovement", "statementLines", "statementFee",
  // HR work communications. An unknown variable renders as an empty string
  // rather than an error, so a template referring to one of these before it was
  // permitted produced silently blank mail — which is why they are declared
  // here rather than left to the HR templates alone.
  "announcementTitle", "announcementBody", "announcementPriority",
  "leaveType", "leaveStart", "leaveEnd", "leaveDays", "decision", "decisionComment",
  "claimType", "claimAmount",
  "requestReference", "requestSubject", "requestStatus",
  "taskTitle", "taskCategory", "taskDueDate",
  "courseTitle", "courseDueDate", "decisionTone", "hrContactEmail"
]);
const SECRET_KEYS = /password|apiKey|api_key|secret|token|privateKey|credential/i;
const TITOPAY_LOGO_URL = "https://titopay.co.za/assets/titopay-official-logo.png";
const WELCOME_TEMPLATE_KEYS = new Set(["personal_account_welcome", "business_account_welcome"]);
const DEFAULT_TEMPLATES = [
  ["welcome_email", "Welcome Email", "Welcome to {{companyName}}", "<p>Welcome {{firstName}}. Your {{accountType}} TitoPay account is ready.</p><p><a href=\"{{verificationLink}}\" style=\"display:inline-block;padding:12px 20px;background:#168ac2;color:#fff;text-decoration:none;border-radius:6px\">Verify Email</a></p>"],
  ["personal_account_welcome", "Personal Account Welcome", "Welcome to TitoPay", "<p>Hello {{firstName}},</p><p>Welcome to TitoPay.</p><p>Your Personal account has been created successfully.</p><p>You can now access TitoPay to manage your wallet, send and receive money, make QR payments, view your transaction history, and use the available personal payment services.</p><p>For your security, never share your password, verification code, PIN, or account credentials with anyone.</p><p><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:12px 20px;background:#168ac2;color:#fff;text-decoration:none;border-radius:6px\">Open TitoPay</a><br>{{appUrl}}</p><p>Need assistance? Contact us at <a href=\"mailto:{{supportEmail}}\">{{supportEmail}}</a>.</p>"],
  ["business_account_welcome", "Business Account Welcome", "Welcome to TitoPay Business", "<p>Hello {{firstName}},</p><p>Welcome to TitoPay Business.</p><p>Your Business account has been created successfully.</p><p>You can use TitoPay Business to manage your business profile, receive payments, access your QR payment tools, view transactions, manage payouts, and use available merchant services.</p><p>Some business features may remain restricted until the required business verification or approval process has been completed.</p><p>For your security, never share your password, verification code, PIN, or account credentials with anyone.</p><p><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:12px 20px;background:#168ac2;color:#fff;text-decoration:none;border-radius:6px\">Open TitoPay Business</a><br>{{appUrl}}</p><p>Need assistance? Contact us at <a href=\"mailto:{{supportEmail}}\">{{supportEmail}}</a>.</p>"],
  ["email_statement", "Email Statement", "Your TitoPay statement {{statementReference}}", "<p>Hello {{firstName}},</p><p>Your TitoPay statement for <strong>{{statementPeriod}}</strong> is ready.</p><p><strong>Statement reference:</strong> {{statementReference}}<br><strong>Transactions:</strong> {{transactionCount}}<br><strong>Money in:</strong> {{currency}} {{moneyIn}}<br><strong>Money out:</strong> {{currency}} {{moneyOut}}<br><strong>Net movement:</strong> {{currency}} {{netMovement}}<br><strong>Email statement fee:</strong> {{currency}} {{statementFee}}</p><p style=\"font-family:monospace;white-space:pre-wrap;background:#f2f7fc;padding:16px;border-radius:8px\">{{statementLines}}</p><p>This is a record of TitoPay wallet activity and is not a bank statement. Contact {{supportEmail}} if you need assistance.</p>"],
  ["verify_email_address", "Verify Email Address", "Verify your TitoPay email address", "<p>Hello {{firstName}}. Confirm that this email address belongs to you.</p><p><a href=\"{{verificationLink}}\" style=\"display:inline-block;padding:12px 20px;background:#168ac2;color:#fff;text-decoration:none;border-radius:6px\">Verify Email Address</a></p>"],
  ["password_reset", "Password Reset", "Reset your TitoPay password", "<p>Use this secure, single-use link to reset your password.</p><p><a href=\"{{resetPasswordLink}}\" style=\"display:inline-block;padding:12px 20px;background:#168ac2;color:#fff;text-decoration:none;border-radius:6px\">Reset Password</a></p>"],
  ["password_changed", "Password Changed", "Your TitoPay password was changed", "Your TitoPay password was changed. Contact {{supportEmail}} if this was not you."],
  ["login_notification", "Login Notification", "New TitoPay login", "A login to your TitoPay account was recorded."],
  ["new_device_login", "New Device Login", "New device signed in to TitoPay", "A new device signed in to your TitoPay account."],
  ["payment_receipt", "Payment Receipt", "TitoPay payment receipt {{transactionReference}}", "Payment {{transactionReference}} for {{currency}} {{amount}} was completed."],
  ["wallet_top_up_receipt", "Wallet Top-Up Receipt", "TitoPay wallet top-up receipt", "Your wallet was topped up by {{currency}} {{amount}}. Reference: {{transactionReference}}."],
  ["money_transfer_receipt", "Money Transfer Receipt", "TitoPay transfer receipt {{transactionReference}}", "Your transfer of {{currency}} {{amount}} was completed."],
  ["qr_payment_receipt", "QR Payment Receipt", "TitoPay QR payment receipt", "Your QR payment of {{currency}} {{amount}} was completed. Reference: {{transactionReference}}."],
  ["refund_confirmation", "Refund Confirmation", "TitoPay refund confirmation", "Your refund of {{currency}} {{amount}} was processed. Reference: {{transactionReference}}."],
  ["business_account_submitted", "Business Account Submitted", "Business account submitted", "{{businessName}} was submitted for review."],
  ["business_account_approved", "Business Account Approved", "Business account approved", "{{businessName}} has been approved."],
  ["business_account_rejected", "Business Account Rejected", "Business account update", "{{businessName}} was not approved. Contact {{supportEmail}} for help."],
  ["kyc_submitted", "KYC Submitted", "KYC submission received", "Your KYC submission was received and is being reviewed."],
  ["kyc_approved", "KYC Approved", "KYC approved", "Your TitoPay KYC status is now {{kycStatus}}."],
  ["kyc_rejected", "KYC Rejected", "KYC update", "Your TitoPay KYC status is {{kycStatus}}. Contact {{supportEmail}} for help."],
  ["support_ticket_created", "Support Ticket Created", "Support ticket {{ticketReference}} created", "We received support ticket {{ticketReference}}."],
  ["support_ticket_updated", "Support Ticket Updated", "Support ticket {{ticketReference}} updated", "Support ticket {{ticketReference}} has been updated."],
  ["support_ticket_resolved", "Support Ticket Resolved", "Support ticket {{ticketReference}} resolved", "Support ticket {{ticketReference}} has been resolved."],
  // HR work communications. Each says what happened and where to read it; none
  // carries salary, disciplinary detail or the body of an internal request,
  // because work email is forwarded, printed and left open on shared screens.
  ["hr_announcement", "HR Announcement", "TitoPay staff: {{announcementTitle}}", "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr><td style=\"background:#eef4fb;border-left:3px solid #0b3f8f;padding:9px 14px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#3a5a86;font-weight:700\">TitoPay staff &middot; {{announcementPriority}}</td></tr></table><p style=\"margin:0 0 6px;font-size:15px;color:#0b1f3f\">Hello {{firstName}},</p><h1 style=\"margin:0 0 14px;font-size:23px;line-height:1.25;color:#0b1f3f;font-weight:700\">{{announcementTitle}}</h1><div style=\"font-size:16px;line-height:1.65;color:#22405f\">{{announcementBody}}</div><p style=\"margin:24px 0 0\"><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:13px 22px;background:#0b3f8f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px\">Open the HR portal</a></p><p style=\"margin:26px 0 0;padding-top:16px;border-top:1px solid #e2ebf5;font-size:13px;color:#5b7799;line-height:1.6\">Questions about this? Email <a href=\"mailto:{{hrContactEmail}}\" style=\"color:#0b3f8f\">{{hrContactEmail}}</a> &mdash; replying to this message reaches the same place.<br>An internal message for TitoPay staff. Please do not forward it outside the company.</p>"],
  ["hr_leave_decision", "HR Leave Decision", "Your {{leaveType}} leave was {{decision}}", "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr><td style=\"background:#eef4fb;border-left:3px solid #0b3f8f;padding:9px 14px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#3a5a86;font-weight:700\">TitoPay staff &middot; {{announcementPriority}}</td></tr></table><p style=\"margin:0 0 4px;font-size:15px;color:#0b1f3f\">Hello {{firstName}},</p><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:18px 0 22px\"><tr><td style=\"background:{{decisionTone}};padding:14px 20px;border-radius:8px\"><span style=\"display:block;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#ffffff;opacity:.85\">Leave request</span><span style=\"display:block;margin-top:3px;font-size:22px;line-height:1.2;font-weight:700;color:#ffffff;text-transform:capitalize\">{{decision}}</span></td></tr></table><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-top:1px solid #e2ebf5;border-bottom:1px solid #e2ebf5;margin:0 0 22px\"><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Leave type</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{leaveType}}</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">From</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{leaveStart}}</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">To</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{leaveEnd}}</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Length</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{leaveDays}}</td></tr></table><div style=\"font-size:15px;line-height:1.6;color:#22405f\">{{decisionComment}}</div><p style=\"margin:22px 0 0\"><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:13px 22px;background:#0b3f8f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px\">View it in the HR portal</a></p><p style=\"margin:26px 0 0;padding-top:16px;border-top:1px solid #e2ebf5;font-size:13px;color:#5b7799;line-height:1.6\">Questions about this? Email <a href=\"mailto:{{hrContactEmail}}\" style=\"color:#0b3f8f\">{{hrContactEmail}}</a> &mdash; replying to this message reaches the same place.<br>An internal message for TitoPay staff. Please do not forward it outside the company.</p>"],
  ["hr_claim_decision", "HR Expense Claim Decision", "Your {{claimType}} claim is {{decision}}", "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr><td style=\"background:#eef4fb;border-left:3px solid #0b3f8f;padding:9px 14px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#3a5a86;font-weight:700\">TitoPay staff &middot; {{announcementPriority}}</td></tr></table><p style=\"margin:0 0 4px;font-size:15px;color:#0b1f3f\">Hello {{firstName}},</p><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:18px 0 22px\"><tr><td style=\"background:{{decisionTone}};padding:14px 20px;border-radius:8px\"><span style=\"display:block;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#ffffff;opacity:.85\">Expense claim</span><span style=\"display:block;margin-top:3px;font-size:22px;line-height:1.2;font-weight:700;color:#ffffff;text-transform:capitalize\">{{decision}}</span></td></tr></table><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-top:1px solid #e2ebf5;border-bottom:1px solid #e2ebf5;margin:0 0 22px\"><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Claim type</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{claimType}}</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Amount</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{currency}} {{claimAmount}}</td></tr></table><p style=\"margin:22px 0 0\"><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:13px 22px;background:#0b3f8f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px\">View it in the HR portal</a></p><p style=\"margin:26px 0 0;padding-top:16px;border-top:1px solid #e2ebf5;font-size:13px;color:#5b7799;line-height:1.6\">Questions about this? Email <a href=\"mailto:{{hrContactEmail}}\" style=\"color:#0b3f8f\">{{hrContactEmail}}</a> &mdash; replying to this message reaches the same place.<br>An internal message for TitoPay staff. Please do not forward it outside the company.</p>"],
  ["hr_request_update", "HR Request Update", "Your HR request {{requestReference}} has an update", "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr><td style=\"background:#eef4fb;border-left:3px solid #0b3f8f;padding:9px 14px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#3a5a86;font-weight:700\">TitoPay staff &middot; {{announcementPriority}}</td></tr></table><p style=\"margin:0 0 4px;font-size:15px;color:#0b1f3f\">Hello {{firstName}},</p><table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:18px 0 22px\"><tr><td style=\"background:{{decisionTone}};padding:14px 20px;border-radius:8px\"><span style=\"display:block;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#ffffff;opacity:.85\">Internal request</span><span style=\"display:block;margin-top:3px;font-size:22px;line-height:1.2;font-weight:700;color:#ffffff;text-transform:capitalize\">{{decision}}</span></td></tr></table><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-top:1px solid #e2ebf5;border-bottom:1px solid #e2ebf5;margin:0 0 22px\"><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Request</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{requestSubject}}</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Reference</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{requestReference}}</td></tr></table><p style=\"margin:0 0 4px;font-size:15px;line-height:1.6;color:#22405f\">The reply is waiting in the HR portal. It is not repeated in this email, because internal requests can contain confidential information.</p><p style=\"margin:22px 0 0\"><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:13px 22px;background:#0b3f8f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px\">Read it in the HR portal</a></p><p style=\"margin:26px 0 0;padding-top:16px;border-top:1px solid #e2ebf5;font-size:13px;color:#5b7799;line-height:1.6\">Questions about this? Email <a href=\"mailto:{{hrContactEmail}}\" style=\"color:#0b3f8f\">{{hrContactEmail}}</a> &mdash; replying to this message reaches the same place.<br>An internal message for TitoPay staff. Please do not forward it outside the company.</p>"],
  ["hr_onboarding_task", "HR Onboarding Task", "Onboarding: {{taskTitle}}", "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr><td style=\"background:#eef4fb;border-left:3px solid #0b3f8f;padding:9px 14px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#3a5a86;font-weight:700\">TitoPay staff &middot; {{announcementPriority}}</td></tr></table><p style=\"margin:0 0 4px;font-size:15px;color:#0b1f3f\">Hello {{firstName}},</p><h1 style=\"margin:0 0 14px;font-size:22px;line-height:1.25;color:#0b1f3f;font-weight:700\">{{taskTitle}}</h1><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-top:1px solid #e2ebf5;border-bottom:1px solid #e2ebf5;margin:0 0 22px\"><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Part of</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{taskCategory}}</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Due by</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{taskDueDate}}</td></tr></table><p style=\"margin:0;font-size:15px;line-height:1.6;color:#22405f\">This has been added to your onboarding. You can complete it in the HR portal.</p><p style=\"margin:22px 0 0\"><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:13px 22px;background:#0b3f8f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px\">Open your onboarding</a></p><p style=\"margin:26px 0 0;padding-top:16px;border-top:1px solid #e2ebf5;font-size:13px;color:#5b7799;line-height:1.6\">Questions about this? Email <a href=\"mailto:{{hrContactEmail}}\" style=\"color:#0b3f8f\">{{hrContactEmail}}</a> &mdash; replying to this message reaches the same place.<br>An internal message for TitoPay staff. Please do not forward it outside the company.</p>"],
  ["hr_training_reminder", "HR Mandatory Training Reminder", "{{courseTitle}} is due", "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 22px\"><tr><td style=\"background:#eef4fb;border-left:3px solid #0b3f8f;padding:9px 14px;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#3a5a86;font-weight:700\">TitoPay staff &middot; {{announcementPriority}}</td></tr></table><p style=\"margin:0 0 4px;font-size:15px;color:#0b1f3f\">Hello {{firstName}},</p><h1 style=\"margin:0 0 14px;font-size:22px;line-height:1.25;color:#0b1f3f;font-weight:700\">{{courseTitle}}</h1><table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"border-top:1px solid #e2ebf5;border-bottom:1px solid #e2ebf5;margin:0 0 22px\"><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Status</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">Mandatory, not yet complete</td></tr><tr><td style=\"padding:7px 0;font-size:14px;color:#5b7799;width:42%\">Was due</td><td style=\"padding:7px 0;font-size:15px;color:#0b1f3f;font-weight:600\">{{courseDueDate}}</td></tr></table><p style=\"margin:0;font-size:15px;line-height:1.6;color:#22405f\">Please complete it in the Learning Hub. It should take one sitting.</p><p style=\"margin:22px 0 0\"><a href=\"{{appUrl}}\" style=\"display:inline-block;padding:13px 22px;background:#0b3f8f;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:15px\">Open the Learning Hub</a></p><p style=\"margin:26px 0 0;padding-top:16px;border-top:1px solid #e2ebf5;font-size:13px;color:#5b7799;line-height:1.6\">Questions about this? Email <a href=\"mailto:{{hrContactEmail}}\" style=\"color:#0b3f8f\">{{hrContactEmail}}</a> &mdash; replying to this message reaches the same place.<br>An internal message for TitoPay staff. Please do not forward it outside the company.</p>"],
  ["email_otp", "Email OTP", "Your TitoPay Verification Code", "<p>Hello {{firstName}},</p><p>Use the verification code below to continue.</p><p style=\"font-size:30px;font-weight:700;letter-spacing:8px;color:#0b1f3f\">{{otp}}</p><p>This code expires in {{expiryMinutes}} minutes and can only be used once. If you did not request it, ignore this email and contact {{supportEmail}}.</p>"]
];

let schemaReady;
async function ensureEmailSchema(db = pool) {
  if (!schemaReady) {
    const sql = fs.readFileSync(path.join(__dirname, "../db/email-centre-schema.sql"), "utf8");
    schemaReady = db.query(sql).then(() => seedDefaultTemplates(db)).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function stripDangerousMarkup(value) {
  return String(value || "")
    .replace(/<\s*(script|iframe|object|embed|form|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|form|style|link|meta)[^>]*\/?>/gi, "")
    .replace(/\s(on\w+|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*(?:javascript|data:text\/html):[\s\S]*?\2/gi, '$1="#"');
}

// A raw email queued with only a text body used to render as the branded
// shell around nothing: the HTML part wrapped an empty string, mail clients
// show the HTML part when both exist, and the words never reached the
// reader. The TitoKids guardian invite arrived exactly like that — logo,
// footer, and a blank middle. Deriving the HTML from the text makes a
// text-only raw email impossible to send blank.
function htmlFromText(text) {
  return String(text || "").trim().split(/\n{2,}/).filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function interpolate(template, variables = {}, { html = false } = {}) {
  return String(template || "").replace(/{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g, (_match, key) => {
    if (!ALLOWED_VARIABLES.has(key)) return "";
    let value = variables[key] ?? "";
    if (/(?:Link|Url)$/.test(key)) {
      try { const url = new URL(String(value)); value = url.protocol === "https:" ? url.toString() : "#"; }
      catch { value = "#"; }
    }
    return html ? escapeHtml(value) : String(value).replace(/[\u0000-\u001f\u007f]/g, " ");
  });
}

function validateTemplateSource(source) {
  const unknown = Array.from(String(source || "").matchAll(/{{\s*([^{}]+?)\s*}}/g))
    .map((match) => match[1]).filter((key) => !ALLOWED_VARIABLES.has(key));
  if (unknown.length) throw new AppError(400, `Unsupported template variable: ${unknown[0]}`);
}

function isWelcomeTemplateKey(templateKey) {
  return WELCOME_TEMPLATE_KEYS.has(String(templateKey || ""));
}

function welcomeAccountType(templateKey) {
  return String(templateKey || "").startsWith("business_") ? "business" : "personal";
}

function brandedHtml(content, settings) {
  return `<!doctype html><html><body style="margin:0;background:#f2f7fc;color:#0b1f3f;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px"><table role="presentation" width="600" style="max-width:100%;background:#fff;border-radius:12px;overflow:hidden"><tr><td style="background:#fff;padding:18px 28px;border-bottom:1px solid #dbe6f2"><img src="${TITOPAY_LOGO_URL}" alt="TitoPay" width="210" style="display:block;width:210px;max-width:100%;height:auto;border:0"></td></tr><tr><td style="padding:30px 28px;font-size:16px;line-height:1.65">${content}</td></tr><tr><td style="padding:22px 28px;background:#eaf5fc;color:#294563;font-size:13px;line-height:1.6"><strong>${escapeHtml(settings.company_name)}</strong><br>${escapeHtml(settings.tagline)}<br><a href="mailto:${escapeHtml(settings.support_email)}">${escapeHtml(settings.support_email)}</a> · <a href="${escapeHtml(settings.website_url)}">${escapeHtml(settings.website_url)}</a><br><a href="${escapeHtml(settings.support_url)}">Support</a> · <a href="${escapeHtml(settings.website_url)}/privacy">Privacy Policy</a> · <a href="${escapeHtml(settings.website_url)}/terms">Terms and Conditions</a></td></tr></table></td></tr></table></body></html>`;
}

function renderTemplate(template, variables, settings) {
  const defaults = {
    companyName: settings.company_name, supportEmail: settings.support_email,
    supportUrl: settings.support_url, websiteUrl: settings.website_url,
    appUrl: config.appOrigin, currentYear: new Date().getUTCFullYear()
  };
  const values = { ...defaults, ...variables };
  validateTemplateSource(`${template.subject}\n${template.html_body}\n${template.text_body}`);
  const htmlContent = interpolate(stripDangerousMarkup(template.html_body), values, { html: true }).replace(/\n/g, "<br>");
  return {
    subject: interpolate(template.subject, values),
    html: brandedHtml(htmlContent, settings),
    text: `${interpolate(template.text_body, values)}\n\n${settings.company_name}\n${settings.tagline}\n${settings.support_email}\n${settings.website_url}`
  };
}

function cryptoKey() {
  return crypto.createHash("sha256").update(process.env.EMAIL_ENCRYPTION_KEY || config.refreshSecret).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `enc:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}
function decrypt(value) {
  const [, iv, tag, body] = String(value).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", cryptoKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
function safePayload(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, /link|token|password|secret|otp|code/i.test(key) ? "[REDACTED]" : String(item ?? "").slice(0, 500)
  ]));
}
function sanitiseProviderResponse(value = {}) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.test(key)).map(([key, item]) => [key,
    typeof item === "object" ? sanitiseProviderResponse(item) : String(item ?? "").slice(0, 1000)
  ]));
}
function sanitiseError(error) {
  return String(error?.message || error || "Email delivery failed").replace(/(authorization|api[_-]?key|password|secret|token)=?[^\s,;]*/gi, "$1=[REDACTED]").slice(0, 1000);
}
function safeContentPreview(job) {
  try {
    const content=JSON.parse(decrypt(job.encrypted_content));
    const redact=(value)=>{let text=String(value||"").replace(/([?&](?:token|code)=)[^&\s"'<>]+/gi,"$1[REDACTED]");if(job.template_key==="email_otp")text=text.replace(/\b\d{6,8}\b/g,"[REDACTED]");return text.slice(0,20000);};
    return {html:stripDangerousMarkup(redact(content.html)),text:redact(content.text)};
  } catch {return {html:null,text:null};}
}

async function seedDefaultTemplates(db = pool) {
  // Copy fixups for templates already seeded with older wording. Guarded on
  // the old sentence, so an operator's own edits are never overwritten.
  await db.query(
    `UPDATE email_templates SET body = REPLACE(body,
       'The code expires shortly. If you did not request this verification, please ignore this email and contact',
       'This code expires in {{expiryMinutes}} minutes and can only be used once. If you did not request it, ignore this email and contact'),
       updated_at = NOW()
     WHERE template_key = 'email_otp' AND body LIKE '%The code expires shortly.%'`
  ).catch(() => {});
  for (const [key, name, subject, body] of DEFAULT_TEMPLATES) {
    const htmlBody = body;
    const textBody = body.replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();
    const { rows } = await db.query(
      `INSERT INTO email_templates (template_key,name,subject,html_body,text_body)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (template_key) DO NOTHING RETURNING id`,
      [key, name, subject, htmlBody, textBody]
    );
    if (rows[0]) await db.query(
      `INSERT INTO email_template_versions (template_id,version,subject,html_body,text_body,enabled)
       VALUES ($1,1,$2,$3,$4,TRUE) ON CONFLICT DO NOTHING`, [rows[0].id, subject, htmlBody, textBody]
    );
  }
}

async function getSettings({ masked = false, db = pool } = {}) {
  await ensureEmailSchema(db);
  const { rows } = await db.query("SELECT * FROM email_settings WHERE id=TRUE");
  const settings = rows[0];
  if (masked) settings.provider_config = maskSecrets(settings.provider_config);
  return settings;
}
function maskSecrets(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key,
    SECRET_KEYS.test(key) && item ? "••••••••" : (item && typeof item === "object" ? maskSecrets(item) : item)
  ]));
}
function encryptProviderSecrets(next = {}, previous = {}) {
  const result = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (SECRET_KEYS.test(key)) {
      if (!value || String(value).startsWith("••••")) continue;
      result[key] = encrypt(value);
    } else result[key] = value;
  }
  return result;
}
function decryptProviderSecrets(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key,
    SECRET_KEYS.test(key) && String(item || "").startsWith("enc:") ? decrypt(item) : item
  ]));
}

async function updateSettings(values, actor, { allowProvider = false } = {}) {
  const current = await getSettings();
  const email = (value, field) => {
    const text = String(value ?? current[field]).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new AppError(400, `${field} is invalid`);
    return text;
  };
  const providerConfig = allowProvider && values.providerConfig
    ? encryptProviderSecrets(values.providerConfig, current.provider_config) : current.provider_config;
  const provider = allowProvider ? String(values.defaultProvider || current.default_provider).toLowerCase() : current.default_provider;
  if (!/^(smtp|api|resend|postmark|brevo|mailgun|ses|sendgrid)$/.test(provider)) throw new AppError(400, "Unsupported email provider");
  const number = (key, currentKey, min, max) => {
    const result = Number(values[key] ?? current[currentKey]);
    if (!Number.isInteger(result) || result < min || result > max) throw new AppError(400, `${key} is invalid`);
    return result;
  };
  const httpsUrl = (value, field) => {
    const text = String(value ?? current[field]).trim();
    try { if (new URL(text).protocol !== "https:") throw new Error("HTTPS required"); }
    catch { throw new AppError(400, `${field} must be a valid HTTPS URL`); }
    return text;
  };
  if (allowProvider && values.providerConfig?.apiUrl) httpsUrl(values.providerConfig.apiUrl, "provider API URL");
  const params = [
    String(values.senderName ?? current.sender_name).trim().slice(0, 120), email(values.senderEmail, "sender_email"),
    email(values.replyToEmail, "reply_to_email"), String(values.companyName ?? current.company_name).trim().slice(0, 120),
    String(values.tagline ?? current.tagline).trim().slice(0, 200), email(values.supportEmail, "support_email"),
    httpsUrl(values.supportUrl, "support_url"), httpsUrl(values.websiteUrl, "website_url"),
    number("verificationTokenExpiryMinutes","verification_token_expiry_minutes",5,10080), number("passwordResetTokenExpiryMinutes","password_reset_token_expiry_minutes",5,1440),
    number("verificationResendCooldownSeconds","verification_resend_cooldown_seconds",15,3600), number("verificationResendWindowMinutes","verification_resend_window_minutes",5,1440),
    number("verificationMaxResends","verification_max_resends",1,50), number("maximumRetryCount","maximum_retry_count",1,20), number("dailySendingLimit","daily_sending_limit",1,10000000),
    number("workerConcurrency","worker_concurrency",1,50), provider, values.sendingEnabled ?? current.sending_enabled,
    JSON.stringify(providerConfig), actor.userId
  ];
  const { rows } = await pool.query(
    `UPDATE email_settings SET sender_name=$1,sender_email=$2,reply_to_email=$3,company_name=$4,tagline=$5,
     support_email=$6,support_url=$7,website_url=$8,verification_token_expiry_minutes=$9,password_reset_token_expiry_minutes=$10,
     verification_resend_cooldown_seconds=$11,verification_resend_window_minutes=$12,verification_max_resends=$13,
     maximum_retry_count=$14,daily_sending_limit=$15,worker_concurrency=$16,default_provider=$17,sending_enabled=$18,
     provider_config=$19::jsonb,updated_by=$20,updated_at=NOW() WHERE id=TRUE RETURNING *`, params
  );
  await writeAuditLog({ actorType:"admin", actorId:actor.userId, action:"email_settings_changed", entityType:"email_settings", metadata:{ fields:Object.keys(values), providerChanged:provider!==current.default_provider } });
  if(allowProvider)await writeAuditLog({actorType:"admin",actorId:actor.userId,action:provider!==current.default_provider?"email_provider_changed":"email_provider_credentials_updated",entityType:"email_settings",metadata:{provider,fields:Object.keys(values.providerConfig||{})}});
  return { ...rows[0], provider_config: maskSecrets(rows[0].provider_config) };
}

async function listTemplates(allowedTemplates=null) {
  await ensureEmailSchema();
  const { rows } = await pool.query(`SELECT t.*, a.full_name AS updated_by_name FROM email_templates t LEFT JOIN admin_users a ON a.id=t.updated_by ${allowedTemplates?"WHERE t.template_key=ANY($1::text[])":""} ORDER BY t.name`,allowedTemplates?[allowedTemplates]:[]);
  return rows;
}
async function getTemplate(idOrKey,allowedTemplates=null,db=pool) {
  await ensureEmailSchema(db);
  const { rows } = await db.query(`SELECT t.*,a.full_name AS updated_by_name FROM email_templates t LEFT JOIN admin_users a ON a.id=t.updated_by WHERE (t.id::text=$1 OR t.template_key=$1) ${allowedTemplates?"AND t.template_key=ANY($2::text[])":""} LIMIT 1`, allowedTemplates?[idOrKey,allowedTemplates]:[idOrKey]);
  if (!rows[0]) throw new AppError(404, "Email template not found");
  const versions = await db.query("SELECT id,version,subject,html_body,text_body,enabled,created_by,created_at FROM email_template_versions WHERE template_id=$1 ORDER BY version DESC", [rows[0].id]);
  return { ...rows[0], versions: versions.rows };
}
async function saveTemplate(id, values, actor) {
  await ensureEmailSchema();
  const current = id ? await getTemplate(id) : null;
  const key = String(values.templateKey || current?.template_key || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,79}$/.test(key)) throw new AppError(400, "Template key is invalid");
  const name = String(values.name || current?.name || "").trim().slice(0,120);
  const subject = String(values.subject || current?.subject || "").trim().slice(0,300);
  const htmlBody = stripDangerousMarkup(values.htmlBody ?? current?.html_body ?? "");
  const textBody = String(values.textBody ?? current?.text_body ?? "").slice(0,100000);
  if (!name || !subject || !htmlBody || !textBody) throw new AppError(400, "All template fields are required");
  validateTemplateSource(`${subject}\n${htmlBody}\n${textBody}`);
  const enabled = values.enabled === undefined ? (current?.enabled ?? true) : Boolean(values.enabled);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let template;
    if (current) {
      const nextVersion = current.current_version + 1;
      ({ rows:[template] } = await client.query(`UPDATE email_templates SET name=$2,subject=$3,html_body=$4,text_body=$5,enabled=$6,current_version=$7,updated_by=$8,updated_at=NOW() WHERE id=$1 RETURNING *`, [current.id,name,subject,htmlBody,textBody,enabled,nextVersion,actor.userId]));
      await client.query(`INSERT INTO email_template_versions (template_id,version,subject,html_body,text_body,enabled,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [current.id,nextVersion,subject,htmlBody,textBody,enabled,actor.userId]);
    } else {
      ({ rows:[template] } = await client.query(`INSERT INTO email_templates (template_key,name,subject,html_body,text_body,enabled,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [key,name,subject,htmlBody,textBody,enabled,actor.userId]));
      await client.query(`INSERT INTO email_template_versions (template_id,version,subject,html_body,text_body,enabled,created_by) VALUES ($1,1,$2,$3,$4,$5,$6)`, [template.id,subject,htmlBody,textBody,enabled,actor.userId]);
    }
    await writeAuditLog({ actorType:"admin",actorId:actor.userId,action:current?"email_template_edited":"email_template_created",entityType:"email_template",entityId:template.id,metadata:{templateKey:key,version:template.current_version},db:client });
    if (isWelcomeTemplateKey(key)) {
      await writeAuditLog({actorType:"admin",actorId:actor.userId,action:"welcome_template_changed",entityType:"email_template",entityId:template.id,metadata:{templateKey:key,version:template.current_version,enabled},db:client});
      if (current && Boolean(current.enabled) !== enabled) await writeAuditLog({actorType:"admin",actorId:actor.userId,action:enabled?"welcome_template_enabled":"welcome_template_disabled",entityType:"email_template",entityId:template.id,metadata:{templateKey:key,version:template.current_version},db:client});
    }
    await client.query("COMMIT");
    return template;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
async function deleteTemplate(id, actor) {
  const template = await getTemplate(id);
  const used = await pool.query("SELECT 1 FROM email_queue WHERE template_key=$1 LIMIT 1", [template.template_key]);
  if (used.rowCount) throw new AppError(409, "A used template cannot be deleted; disable it instead");
  await pool.query("DELETE FROM email_template_versions WHERE template_id=$1", [template.id]);
  await pool.query("DELETE FROM email_templates WHERE id=$1", [template.id]);
  await writeAuditLog({actorType:"admin",actorId:actor.userId,action:"email_template_deleted",entityType:"email_template",entityId:template.id,metadata:{templateKey:template.template_key}});
}

async function queueEmail({ recipient, templateKey, variables = {}, userId = null, idempotencyKey, metadata = {}, db = pool }) {
  await ensureEmailSchema(db);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipient || ""))) throw new AppError(400, "Recipient email is invalid");
  const template = await getTemplate(templateKey,null,db);
  if (!template.enabled) return { skipped:true, reason:"template_disabled" };
  const settings = await getSettings({db});
  if (!settings.sending_enabled) return { skipped:true, reason:"sending_disabled" };
  const rendered = renderTemplate(template, variables, settings);
  const encryptedContent = encrypt(JSON.stringify({ html:rendered.html, text:rendered.text }));
  const key = idempotencyKey || crypto.createHash("sha256").update(`${templateKey}:${recipient}:${JSON.stringify(safePayload(variables))}:${Date.now()}`).digest("hex");
  const { rows } = await db.query(
    `INSERT INTO email_queue (recipient,subject,template_key,template_version,variables,encrypted_content,provider,idempotency_key,maximum_attempts,user_id,metadata)
     VALUES (LOWER($1),$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [recipient,rendered.subject,template.template_key,template.current_version,JSON.stringify(safePayload(variables)),encryptedContent,settings.default_provider,key,settings.maximum_retry_count,userId,JSON.stringify(metadata)]
  );
  if (rows[0]) return {...rows[0],deduplicated:false};
  const existing = await db.query("SELECT * FROM email_queue WHERE idempotency_key=$1 LIMIT 1",[key]);
  return {...existing.rows[0],deduplicated:true};
}

function welcomeTemplateKeyForAccountType(accountType) {
  return String(accountType || "").toLowerCase() === "business"
    ? "business_account_welcome"
    : "personal_account_welcome";
}

async function queueWelcomeEmail(user, meta = {}) {
  if (!user?.email) return { skipped:true, reason:"no_email" };
  const accountType = String(user.account_type || meta.accountType || "personal").toLowerCase() === "business" ? "business" : "personal";
  const templateKey = welcomeTemplateKeyForAccountType(accountType);
  const names = String(user.full_name || "").trim().split(/\s+/);
  const job = await queueEmail({
    recipient:user.email,
    templateKey,
    userId:user.id,
    variables:{
      firstName:names[0]||"there", lastName:names.slice(1).join(" "), fullName:user.full_name,
      email:user.email, accountType, businessName:meta.businessName||user.full_name,
      appUrl:config.appOrigin
    },
    idempotencyKey:`welcome-email:${user.id}:${accountType}`,
    metadata:{event:"account_registration",accountType}
  });
  if (!job.skipped) {
    await writeAuditLog({
      actorType:"customer", actorId:user.id,
      action:`${accountType}_welcome_email_queued`, entityType:"email_queue", entityId:job.id,
      ipAddress:meta.ipAddress, userAgent:meta.userAgent,
      metadata:{templateKey,accountType}
    }).catch((error)=>console.error("[email-centre] welcome queue audit failed",{userId:user.id,templateKey,message:error.message}));
  } else {
    await writeAuditLog({
      actorType:"customer", actorId:user.id, action:"welcome_email_skipped",
      entityType:"user", entityId:user.id, ipAddress:meta.ipAddress, userAgent:meta.userAgent,
      metadata:{templateKey,accountType,reason:job.reason}
    }).catch((error)=>console.error("[email-centre] welcome skip audit failed",{userId:user.id,templateKey,message:error.message}));
  }
  return job;
}

async function queueRawEmail({recipient,subject,htmlBody,textBody,variables={},userId=null,idempotencyKey,metadata={}}) {
  await ensureEmailSchema();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipient||"")))throw new AppError(400,"Recipient email is invalid");
  const settings=await getSettings();if(!settings.sending_enabled)return {skipped:true,reason:"sending_disabled"};
  validateTemplateSource(`${subject}\n${htmlBody}\n${textBody}`);
  const values={companyName:settings.company_name,supportEmail:settings.support_email,supportUrl:settings.support_url,websiteUrl:settings.website_url,appUrl:config.appOrigin,currentYear:new Date().getUTCFullYear(),...variables};
  const renderedSubject=interpolate(String(subject||"").replace(/[\r\n]/g," ").slice(0,300),values);
  const effectiveHtmlBody=String(htmlBody||"").trim()?htmlBody:htmlFromText(textBody);
  const content={html:brandedHtml(interpolate(stripDangerousMarkup(effectiveHtmlBody),values,{html:true}),settings),text:`${interpolate(textBody,values)}\n\n${settings.company_name}\n${settings.tagline}\n${settings.support_email}\n${settings.website_url}`};
  const {rows}=await pool.query(`INSERT INTO email_queue(recipient,subject,template_key,template_version,variables,encrypted_content,provider,idempotency_key,maximum_attempts,user_id,metadata) VALUES(LOWER($1),$2,'marketing_email',1,$3::jsonb,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,[recipient,renderedSubject,JSON.stringify(safePayload(variables)),encrypt(JSON.stringify(content)),settings.default_provider,idempotencyKey,settings.maximum_retry_count,userId,JSON.stringify(metadata)]);
  return rows[0];
}

async function createVerificationForUser(user, meta = {}) {
  if (!user?.email) return { skipped:true, reason:"no_email" };
  await ensureEmailSchema();
  const settings = await getSettings();
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const client = await pool.connect();
  let tokenId;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE email_verification_tokens SET revoked_at=NOW() WHERE user_id=$1 AND used_at IS NULL AND revoked_at IS NULL", [user.id]);
    const { rows } = await client.query(`INSERT INTO email_verification_tokens (user_id,token_hash,expires_at,request_ip) VALUES ($1,$2,NOW()+($3||' minutes')::interval,$4) RETURNING id`, [user.id,tokenHash,settings.verification_token_expiry_minutes,meta.ipAddress||null]);
    tokenId = rows[0].id;
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const link = `${String(config.appOrigin).replace(/\/$/,"")}/verify-email?token=${encodeURIComponent(token)}`;
  const names = String(user.full_name || "").trim().split(/\s+/);
  const variables = { firstName:names[0]||"there",lastName:names.slice(1).join(" "),fullName:user.full_name,email:user.email,accountType:user.account_type,verificationLink:link };
  await queueEmail({recipient:user.email,templateKey:"verify_email_address",variables,userId:user.id,idempotencyKey:`verification:${tokenId}`});
  await writeAuditLog({actorType:"customer",actorId:user.id,action:"verification_email_queued",entityType:"email_verification",entityId:tokenId,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{}});
  return { queued:true };
}

async function verifyEmailToken(token, meta = {}) {
  const hash = crypto.createHash("sha256").update(String(token||"")).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM email_verification_tokens WHERE token_hash=$1 FOR UPDATE", [hash]);
    const record = rows[0];
    if (!record) throw new AppError(400,"Verification link is invalid");
    if (record.used_at) throw new AppError(409,"Verification link has already been used");
    if (record.revoked_at) throw new AppError(400,"Verification link has been replaced");
    if (new Date(record.expires_at)<=new Date()) throw new AppError(410,"Verification link has expired");
    await client.query("UPDATE email_verification_tokens SET used_at=NOW() WHERE id=$1",[record.id]);
    const { rows:users } = await client.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING id,email,email_verified_at",[record.user_id]);
    await writeAuditLog({actorType:"customer",actorId:record.user_id,action:"email_verified",entityType:"user",entityId:record.user_id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{},db:client});
    await client.query("COMMIT");
    return users[0];
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function resendVerification(identifier, meta = {}) {
  await ensureEmailSchema();
  const settings = await getSettings();
  const { rows } = await pool.query("SELECT * FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1",[String(identifier||"").trim()]);
  const user = rows[0];
  if (!user || user.email_verified_at) return { accepted:true };
  const recent = await pool.query(`SELECT COUNT(*)::int AS count,MAX(requested_at) AS latest FROM email_verification_tokens WHERE user_id=$1 AND requested_at>NOW()-($2||' minutes')::interval`,[user.id,settings.verification_resend_window_minutes]);
  if (recent.rows[0].latest && Date.now()-new Date(recent.rows[0].latest).getTime()<settings.verification_resend_cooldown_seconds*1000) return {accepted:true};
  if (recent.rows[0].count>=settings.verification_max_resends) return {accepted:true};
  await createVerificationForUser(user,meta);
  return {accepted:true};
}

async function requestEmailPasswordReset(user, meta = {}) {
  if (!user?.email) return { accepted:true };
  await ensureEmailSchema();
  const settings = await getSettings();
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const userType = user.user_type === "admin" ? "admin" : "customer";
  const client = await pool.connect();
  let tokenId;
  try {
    await client.query("BEGIN");
    await client.query("UPDATE password_reset_tokens SET revoked_at=NOW() WHERE user_type=$1 AND user_id=$2 AND used_at IS NULL AND revoked_at IS NULL", [userType,user.id]);
    const {rows}=await client.query(`INSERT INTO password_reset_tokens(user_type,user_id,token_hash,expires_at,request_ip) VALUES($1,$2,$3,NOW()+($4||' minutes')::interval,$5) RETURNING id`,[userType,user.id,tokenHash,settings.password_reset_token_expiry_minutes,meta.ipAddress||null]);
    tokenId=rows[0].id;
    await client.query("COMMIT");
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
  const link=`${String(config.appOrigin).replace(/\/$/,"")}/reset-password?token=${encodeURIComponent(token)}`;
  const names=String(user.full_name||"").trim().split(/\s+/);
  await queueEmail({recipient:user.email,templateKey:"password_reset",variables:{firstName:names[0]||"there",fullName:user.full_name,email:user.email,resetPasswordLink:link},idempotencyKey:`password-reset:${tokenId}`,metadata:{userType}});
  await writeAuditLog({actorType:userType,actorId:user.id,action:"password_reset_requested",entityType:"password_reset_token",entityId:tokenId,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{}});
  return {accepted:true};
}

async function confirmEmailPasswordReset(token,newPassword,meta={}) {
  if(String(newPassword||"").length<4)throw new AppError(400,"Enter a new PIN or password with at least 4 characters");
  const tokenHash=crypto.createHash("sha256").update(String(token||"")).digest("hex");
  const client=await pool.connect();let account;
  try{await client.query("BEGIN");const {rows}=await client.query("SELECT * FROM password_reset_tokens WHERE token_hash=$1 FOR UPDATE",[tokenHash]);const record=rows[0];
    if(!record)throw new AppError(400,"Password reset link is invalid");if(record.used_at)throw new AppError(409,"Password reset link has already been used");if(record.revoked_at)throw new AppError(400,"Password reset link has been replaced");if(new Date(record.expires_at)<=new Date())throw new AppError(410,"Password reset link has expired");
    const table=record.user_type==="admin"?"admin_users":"users";const passwordHash=await hashPassword(newPassword);
    await client.query("UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1",[record.id]);
    const {rows:accounts}=await client.query(`UPDATE ${table} SET password_hash=$2,failed_login_attempts=0,locked_until=NULL,last_failed_login_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING *`,[record.user_id,passwordHash]);account={...accounts[0],user_type:record.user_type};
    await client.query("UPDATE sessions SET revoked_at=NOW(),revoked_reason='password_reset' WHERE user_type=$2 AND user_id=$1 AND revoked_at IS NULL",[record.user_id,record.user_type]);
    await writeAuditLog({actorType:record.user_type,actorId:record.user_id,action:"password_reset_completed",entityType:"user",entityId:record.user_id,ipAddress:meta.ipAddress,userAgent:meta.userAgent,metadata:{},db:client});await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  if(account?.email)await queueEmail({recipient:account.email,templateKey:"password_changed",variables:{fullName:account.full_name,email:account.email},idempotencyKey:`password-changed:${tokenHash}`});
  return {ok:true};
}

async function listQueue(query = {}) {
  await ensureEmailSchema();
  const limit=Math.min(100,Math.max(1,Number(query.limit)||25)), page=Math.max(1,Number(query.page)||1);
  const values=[], where=[];
  const add=(sql,value)=>{values.push(value);where.push(sql.replace("?",`$${values.length}`));};
  const date=(value,label)=>{const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))throw new AppError(400,`${label} date is invalid`);return parsed.toISOString();};
  if(query.status){if(!["queued","processing","sent","delivered","failed","cancelled","dead_lettered"].includes(query.status))throw new AppError(400,"Queue status is invalid");add("status=?",query.status);} if(query.template)add("template_key=?",String(query.template).slice(0,80));
  if(query.recipient)add("LOWER(recipient) LIKE ?",`%${String(query.recipient).toLowerCase()}%`); if(query.provider)add("provider=?",query.provider);
  if(Array.isArray(query.allowedTemplates))add("template_key=ANY(?::text[])",query.allowedTemplates);
  if(query.from)add("created_at>=?",date(query.from,"From")); if(query.to)add("created_at<=?",date(query.to,"To"));
  const clause=where.length?`WHERE ${where.join(" AND ")}`:"";
  const total=(await pool.query(`SELECT COUNT(*)::int AS count FROM email_queue ${clause}`,values)).rows[0].count;
  values.push(limit,(page-1)*limit);
  const {rows}=await pool.query(`SELECT id,recipient,subject,template_key,template_version,provider,provider_message_id,status,attempt_count,maximum_attempts,scheduled_at,created_at,last_attempt_at,sent_at,delivered_at,failed_at,last_error,metadata FROM email_queue ${clause} ORDER BY created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  return {items:rows,total,page,limit};
}
async function queueDetail(id,allowedTemplates=null) {
  await ensureEmailSchema();
  const {rows}=await pool.query(`SELECT id,recipient,subject,template_key,template_version,variables,provider,provider_message_id,status,attempt_count,maximum_attempts,scheduled_at,created_at,last_attempt_at,sent_at,delivered_at,failed_at,last_error,metadata FROM email_queue WHERE id=$1 ${allowedTemplates?"AND template_key=ANY($2::text[])":""}`,allowedTemplates?[id,allowedTemplates]:[id]);
  if(!rows[0])throw new AppError(404,"Email queue item not found");
  const history=await pool.query("SELECT * FROM email_delivery_logs WHERE queue_id=$1 ORDER BY attempt_number DESC",[id]);
  return {...rows[0],history:history.rows};
}
async function manageQueue(id, action, actor,allowedTemplates=null) {
  await ensureEmailSchema();
  const scope=allowedTemplates?" AND template_key=ANY($2::text[])":"";
  const sql=action==="retry"?`UPDATE email_queue SET status='queued',scheduled_at=NOW(),locked_at=NULL,locked_by=NULL,last_error=NULL WHERE id=$1 AND status IN ('failed','dead_lettered')${scope} RETURNING *`:`UPDATE email_queue SET status='cancelled',cancelled_at=NOW() WHERE id=$1 AND status IN ('queued','failed')${scope} RETURNING *`;
  const {rows}=await pool.query(sql,allowedTemplates?[id,allowedTemplates]:[id]); if(!rows[0])throw new AppError(409,`Email cannot be ${action === "retry" ? "retried" : "cancelled"} in its current state`);
  await writeAuditLog({actorType:"admin",actorId:actor.userId,action:action==="retry"?"email_retried":"queued_email_cancelled",entityType:"email_queue",entityId:id,metadata:{}});
  if(action==="retry"&&isWelcomeTemplateKey(rows[0].template_key))await writeAuditLog({actorType:"admin",actorId:actor.userId,action:"welcome_email_retried",entityType:"email_queue",entityId:id,metadata:{templateKey:rows[0].template_key,accountType:welcomeAccountType(rows[0].template_key),attemptCount:rows[0].attempt_count}});
  return rows[0];
}
async function listLogs(query={}) {
  const limit=Math.min(100,Math.max(1,Number(query.limit)||25)),page=Math.max(1,Number(query.page)||1);
  const values=[],where=[];const add=(sql,value)=>{values.push(value);where.push(sql.replace("?",`$${values.length}`));};
  const date=(value,label)=>{const parsed=new Date(value);if(Number.isNaN(parsed.getTime()))throw new AppError(400,`${label} date is invalid`);return parsed.toISOString();};
  if(query.status)add("status=?",String(query.status).slice(0,40));if(query.template)add("template_key=?",String(query.template).slice(0,80));if(query.recipient)add("LOWER(recipient) LIKE ?",`%${String(query.recipient).toLowerCase()}%`);if(query.provider)add("provider=?",String(query.provider).slice(0,40));if(Array.isArray(query.allowedTemplates))add("template_key=ANY(?::text[])",query.allowedTemplates);if(query.from)add("created_at>=?",date(query.from,"From"));if(query.to)add("created_at<=?",date(query.to,"To"));
  const clause=where.length?`WHERE ${where.join(" AND ")}`:"";const total=(await pool.query(`SELECT COUNT(*)::int AS count FROM email_delivery_logs ${clause}`,values)).rows[0].count;
  values.push(limit,(page-1)*limit);const {rows}=await pool.query(`SELECT * FROM email_delivery_logs ${clause} ORDER BY created_at DESC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
  return {items:rows,total,page,limit};
}
async function logDetail(id,allowedTemplates=null){const {rows}=await pool.query(`SELECT * FROM email_delivery_logs WHERE id=$1 ${allowedTemplates?"AND template_key=ANY($2::text[])":""}`,allowedTemplates?[id,allowedTemplates]:[id]);if(!rows[0])throw new AppError(404,"Delivery log not found");const audit=await pool.query("SELECT * FROM audit_logs WHERE entity_id=$1 ORDER BY created_at DESC",[rows[0].queue_id]);return {...rows[0],audit:audit.rows};}

async function dashboard(allowedTemplates=null){await ensureEmailSchema();const scoped=allowedTemplates?"template_key=ANY($1::text[])":"TRUE",params=allowedTemplates?[allowedTemplates]:[];const [metrics,perDay,deliveryOutcomes,byTemplate,queueActivity,recent]=await Promise.all([
  pool.query(`SELECT COUNT(*) FILTER(WHERE sent_at::date=CURRENT_DATE)::int sent_today,COUNT(*) FILTER(WHERE delivered_at::date=CURRENT_DATE)::int delivered_today,COUNT(*) FILTER(WHERE failed_at::date=CURRENT_DATE)::int failed_today,COUNT(*) FILTER(WHERE status IN ('queued','processing'))::int queued,COALESCE(ROUND(100.0*COUNT(*) FILTER(WHERE delivered_at IS NOT NULL)/NULLIF(COUNT(*) FILTER(WHERE sent_at IS NOT NULL),0),2),0) delivery_rate,COALESCE(ROUND((AVG(EXTRACT(EPOCH FROM(delivered_at-sent_at))) FILTER(WHERE delivered_at IS NOT NULL))::numeric,0),0) average_delivery_seconds FROM email_queue WHERE ${scoped}`,params),
  pool.query(`SELECT created_at::date AS "day",COUNT(*)::int AS sent,COUNT(*) FILTER(WHERE status='delivered')::int AS delivered,COUNT(*) FILTER(WHERE status IN ('failed','dead_lettered'))::int AS failed FROM email_queue WHERE ${scoped} AND created_at>=CURRENT_DATE-INTERVAL '29 days' GROUP BY 1 ORDER BY 1`,params),
  pool.query(`SELECT CASE WHEN status='delivered' THEN 'successful' ELSE 'failed' END outcome,COUNT(*)::int count FROM email_queue WHERE ${scoped} AND created_at>=CURRENT_DATE-INTERVAL '29 days' AND status IN ('delivered','failed','dead_lettered') GROUP BY 1 ORDER BY 1`,params),
  pool.query(`SELECT template_key,COUNT(*)::int count FROM email_queue WHERE ${scoped} AND created_at>=CURRENT_DATE-INTERVAL '29 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,params),
  pool.query(`SELECT status,COUNT(*)::int count FROM email_queue WHERE ${scoped} GROUP BY status ORDER BY status`,params),
  pool.query(`SELECT recipient,subject,template_key,status,COALESCE(sent_at,created_at) sent_time FROM email_queue WHERE ${scoped} ORDER BY created_at DESC LIMIT 20`,params)
]);return {metrics:metrics.rows[0],charts:{perDay:perDay.rows,deliveryOutcomes:deliveryOutcomes.rows,byTemplate:byTemplate.rows,queueActivity:queueActivity.rows},recentActivity:recent.rows};}

async function analytics(query={}, allowedTemplates=null) {
  await ensureEmailSchema();
  const days=Math.min(365,Math.max(1,Number.parseInt(query.days,10)||30));
  const since=new Date(Date.now()-(days-1)*86400000);
  const scoped=allowedTemplates?"q.template_key=ANY($2::text[])":"TRUE";
  const eventRollup=`SELECT provider_message_id,
    COUNT(*) FILTER (WHERE REPLACE(REPLACE(LOWER(event_type),'-','_'),' ','_') IN ('open','opened'))::int opened,
    COUNT(*) FILTER (WHERE REPLACE(REPLACE(LOWER(event_type),'-','_'),' ','_') IN ('click','clicked'))::int clicked,
    COUNT(*) FILTER (WHERE REPLACE(REPLACE(LOWER(event_type),'-','_'),' ','_') IN ('bounce','bounced'))::int bounced,
    COUNT(*) FILTER (WHERE REPLACE(REPLACE(LOWER(event_type),'-','_'),' ','_') IN ('complaint','spamcomplaint','spam_complaint'))::int spam_complaints
    FROM email_delivery_events WHERE provider_message_id IS NOT NULL GROUP BY provider_message_id`;
  const rollup=(bucket,rangeStart)=>pool.query(`SELECT DATE_TRUNC('${bucket}',q.created_at) period,
    COUNT(*) FILTER (WHERE q.sent_at IS NOT NULL)::int sent,
    COUNT(*) FILTER (WHERE q.delivered_at IS NOT NULL)::int delivered,
    COUNT(*) FILTER (WHERE COALESCE(e.bounced,0)>0)::int bounced,
    COUNT(*) FILTER (WHERE COALESCE(e.opened,0)>0)::int opened,
    COUNT(*) FILTER (WHERE COALESCE(e.clicked,0)>0)::int clicked,
    COUNT(*) FILTER (WHERE COALESCE(e.spam_complaints,0)>0)::int spam_complaints,
    COALESCE(ROUND((AVG(EXTRACT(EPOCH FROM(q.delivered_at-q.sent_at))) FILTER (WHERE q.delivered_at IS NOT NULL AND q.sent_at IS NOT NULL))::numeric,0),0)::int average_delivery_seconds
    FROM email_queue q LEFT JOIN (${eventRollup}) e ON e.provider_message_id=q.provider_message_id
    WHERE q.created_at >= $1 AND ${scoped} GROUP BY 1 ORDER BY 1`,allowedTemplates?[rangeStart,allowedTemplates]:[rangeStart]);
  const [summaryResult,daily,weekly,monthly]=await Promise.all([
    pool.query(`SELECT COUNT(*) FILTER (WHERE q.sent_at IS NOT NULL)::int total_sent,
      COUNT(*) FILTER (WHERE q.delivered_at IS NOT NULL)::int delivered,
      COUNT(*) FILTER (WHERE COALESCE(e.bounced,0)>0)::int bounced,
      COUNT(*) FILTER (WHERE COALESCE(e.spam_complaints,0)>0)::int spam_complaints,
      COUNT(*) FILTER (WHERE COALESCE(e.opened,0)>0)::int opened_messages,
      COUNT(*) FILTER (WHERE COALESCE(e.clicked,0)>0)::int clicked_messages,
      COALESCE(ROUND((AVG(EXTRACT(EPOCH FROM(q.delivered_at-q.sent_at))) FILTER (WHERE q.delivered_at IS NOT NULL AND q.sent_at IS NOT NULL))::numeric,0),0)::int average_delivery_seconds
      FROM email_queue q LEFT JOIN (${eventRollup}) e ON e.provider_message_id=q.provider_message_id WHERE q.created_at >= $1 AND ${scoped}`,allowedTemplates?[since,allowedTemplates]:[since]),
    rollup("day",new Date(Date.now()-29*86400000)),
    rollup("week",new Date(Date.now()-83*86400000)),
    rollup("month",new Date(Date.now()-364*86400000))
  ]);
  const row=summaryResult.rows[0]||{};
  const sent=Number(row.total_sent||0),delivered=Number(row.delivered||0),opened=Number(row.opened_messages||0),clicked=Number(row.clicked_messages||0);
  const percentage=(value,denominator)=>denominator?Number((100*value/denominator).toFixed(2)):0;
  return {rangeDays:days,summary:{total_sent:sent,delivered,bounced:Number(row.bounced||0),spam_complaints:Number(row.spam_complaints||0),open_rate:percentage(opened,delivered),click_rate:percentage(clicked,delivered),bounce_rate:percentage(Number(row.bounced||0),sent),average_delivery_seconds:Number(row.average_delivery_seconds||0),open_tracking_supported:opened>0,click_tracking_supported:clicked>0},series:{daily:daily.rows,weekly:weekly.rows,monthly:monthly.rows}};
}

async function effectiveProvider(providerOverride){const settings=await getSettings(),stored=decryptProviderSecrets(settings.provider_config||{}),existing=await getEffectiveEmailProviderConfig();if(existing.enabled===false&&(providerOverride||settings.default_provider)==="smtp")throw new Error("SMTP integration is disabled");return {provider:providerOverride||settings.default_provider,from:`${settings.sender_name} <${settings.sender_email}>`,fromName:settings.sender_name,fromEmail:settings.sender_email,replyTo:settings.reply_to_email,smtpHost:stored.smtpHost||stored.host||existing.smtpHost,smtpPort:Number(stored.smtpPort||stored.port||existing.smtpPort),smtpSecure:stored.smtpSecure??stored.secure??existing.smtpSecure,smtpUser:stored.smtpUser||stored.username||existing.smtpUser,smtpPassword:stored.smtpPassword||stored.password||existing.smtpPassword,apiUrl:stored.apiUrl||config.integrations.email.apiUrl,apiKey:stored.apiKey||config.integrations.email.apiKey,mailgunDomain:stored.mailgunDomain||stored.domain||""};}
async function providerJsonRequest(provider,url,{headers={},payload}){const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(payload)});const responseText=await response.text();let json={};try{json=responseText?JSON.parse(responseText):{};}catch{json={response:responseText.slice(0,1000)};}if(!response.ok)throw new Error(`${provider.provider} returned ${response.status}`);return {json,response};}
async function deliverQueuedContent(job){const provider=await effectiveProvider(job.provider);
  // A reply should reach the desk that sent the message. reply_to_email is a
  // single global setting used by every provider branch below, so changing it
  // for HR would send customer replies to HR too. A job may name its own
  // address in metadata instead; anything else keeps the global default, so
  // every message that existed before this behaves exactly as it did.
  const jobReplyTo = job.metadata && typeof job.metadata.replyTo === "string" ? job.metadata.replyTo.trim() : "";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(jobReplyTo)) provider.replyTo = jobReplyTo;
  const content=JSON.parse(decrypt(job.encrypted_content));if(provider.provider==="smtp"||(provider.provider==="ses"&&provider.smtpHost)){if(!provider.smtpHost)throw new Error("SMTP email provider is not configured");const transport=nodemailer.createTransport({host:provider.smtpHost,port:provider.smtpPort,secure:Boolean(provider.smtpSecure),auth:provider.smtpUser||provider.smtpPassword?{user:provider.smtpUser,pass:provider.smtpPassword}:undefined,tls:{rejectUnauthorized:config.integrations.email.smtpRejectUnauthorized}});// A verification code is disposable mail, and the message can say so:
// Expiry-Date is honoured by Outlook and Exchange (shown struck through and
// eligible for auto-clean once past), and a stable References id makes Gmail
// stack every code for the same person into ONE conversation instead of a
// row per sign-in. No mail system lets a sender delete delivered mail; this
// is everything a sender can honestly do.
const otpMail=job.template_key==="email_otp"||job.template_key==="password_change_otp";
const otpExpiryMinutes=Number((job.variables&&job.variables.expiryMinutes)||10)||10;
const otpThreadId=`<titopay-otp-${crypto.createHash("sha256").update(String(job.recipient||"").toLowerCase()).digest("hex").slice(0,16)}@titopay.co.za>`;
const result=await transport.sendMail({from:provider.from,replyTo:provider.replyTo,to:job.recipient,subject:job.subject,html:content.html,text:content.text,...(otpMail?{headers:{"Expiry-Date":new Date(Date.now()+otpExpiryMinutes*60000).toUTCString(),"Auto-Submitted":"auto-generated"},inReplyTo:otpThreadId,references:otpThreadId}:{})});return {messageId:result.messageId,accepted:result.accepted,rejected:result.rejected,response:result.response};}
  if(!provider.apiKey)throw new Error(`${provider.provider} provider is not configured`);
  let result;
  if(provider.provider==="resend")result=await providerJsonRequest(provider,provider.apiUrl||"https://api.resend.com/emails",{headers:{authorization:`Bearer ${provider.apiKey}`},payload:{from:provider.from,to:[job.recipient],subject:job.subject,html:content.html,text:content.text,reply_to:provider.replyTo}});
  else if(provider.provider==="postmark")result=await providerJsonRequest(provider,provider.apiUrl||"https://api.postmarkapp.com/email",{headers:{"X-Postmark-Server-Token":provider.apiKey},payload:{From:provider.from,To:job.recipient,Subject:job.subject,HtmlBody:content.html,TextBody:content.text,ReplyTo:provider.replyTo,MessageStream:"outbound"}});
  else if(provider.provider==="brevo")result=await providerJsonRequest(provider,provider.apiUrl||"https://api.brevo.com/v3/smtp/email",{headers:{"api-key":provider.apiKey},payload:{sender:{name:provider.fromName,email:provider.fromEmail},to:[{email:job.recipient}],replyTo:{email:provider.replyTo},subject:job.subject,htmlContent:content.html,textContent:content.text}});
  else if(provider.provider==="sendgrid")result=await providerJsonRequest(provider,provider.apiUrl||"https://api.sendgrid.com/v3/mail/send",{headers:{authorization:`Bearer ${provider.apiKey}`},payload:{personalizations:[{to:[{email:job.recipient}]}],from:{email:provider.fromEmail,name:provider.fromName},reply_to:{email:provider.replyTo},subject:job.subject,content:[{type:"text/plain",value:content.text},{type:"text/html",value:content.html}]}});
  else if(provider.provider==="mailgun"){const url=provider.apiUrl||(provider.mailgunDomain?`https://api.mailgun.net/v3/${encodeURIComponent(provider.mailgunDomain)}/messages`:"");if(!url)throw new Error("Mailgun domain or API URL is not configured");const form=new URLSearchParams({from:provider.from,to:job.recipient,subject:job.subject,html:content.html,text:content.text,"h:Reply-To":provider.replyTo});const response=await fetch(url,{method:"POST",headers:{authorization:`Basic ${Buffer.from(`api:${provider.apiKey}`).toString("base64")}`,"content-type":"application/x-www-form-urlencoded"},body:form.toString()});const json=await response.json().catch(()=>({}));if(!response.ok)throw new Error(`${provider.provider} returned ${response.status}`);result={json,response};}
  else if(provider.provider==="ses")throw new Error("Amazon SES must be configured through its SMTP endpoint");
  else {if(!provider.apiUrl)throw new Error(`${provider.provider} API URL is not configured`);result=await providerJsonRequest(provider,provider.apiUrl,{headers:{authorization:`Bearer ${provider.apiKey}`},payload:{from:provider.from,to:job.recipient,subject:job.subject,html:content.html,text:content.text,replyTo:provider.replyTo}});}
  const json=result.json||{};return {messageId:json.id||json.MessageID||json.messageId||json.message_id||result.response?.headers?.get?.("x-message-id")||null,response:json};}

async function claimJobs(workerId,limit=5){await ensureEmailSchema();await pool.query(`UPDATE email_queue SET status='queued',locked_at=NULL,locked_by=NULL WHERE status='processing' AND locked_at<NOW()-INTERVAL '15 minutes'`);const client=await pool.connect();try{await client.query("BEGIN");const settings=(await client.query("SELECT daily_sending_limit,sending_enabled FROM email_settings WHERE id=TRUE FOR UPDATE")).rows[0];if(!settings?.sending_enabled){await client.query("COMMIT");return [];}const usage=(await client.query(`SELECT COUNT(*) FILTER(WHERE sent_at>=CURRENT_DATE)::int sent_today,COUNT(*) FILTER(WHERE status='processing')::int processing FROM email_queue`)).rows[0];const remaining=Math.max(0,Number(settings.daily_sending_limit)-Number(usage.sent_today)-Number(usage.processing));const claimLimit=Math.min(Math.max(1,Number(limit)||1),remaining);if(!claimLimit){await client.query("COMMIT");return [];}const {rows}=await client.query(`SELECT * FROM email_queue WHERE status='queued' AND scheduled_at<=NOW() ORDER BY scheduled_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1`,[claimLimit]);if(rows.length)await client.query(`UPDATE email_queue SET status='processing',locked_at=NOW(),locked_by=$2 WHERE id=ANY($1::uuid[])`,[rows.map(r=>r.id),workerId]);await client.query("COMMIT");return rows.map(r=>({...r,status:"processing"}));}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
async function processJob(job){const attempt=job.attempt_count+1,preview=safeContentPreview(job);try{const result=await deliverQueuedContent(job);const messageId=result.messageId||null;await pool.query(`UPDATE email_queue SET status='sent',attempt_count=$2,last_attempt_at=NOW(),sent_at=NOW(),provider_message_id=$3,locked_at=NULL,locked_by=NULL WHERE id=$1 AND status='processing'`,[job.id,attempt,messageId]);await pool.query(`INSERT INTO email_delivery_logs(queue_id,attempt_number,recipient,subject,template_key,template_version,status,provider,provider_message_id,provider_response,safe_variables,html_preview,text_preview,sent_at) VALUES($1,$2,$3,$4,$5,$6,'sent',$7,$8,$9::jsonb,$10::jsonb,$11,$12,NOW()) ON CONFLICT DO NOTHING`,[job.id,attempt,job.recipient,job.subject,job.template_key,job.template_version,job.provider,messageId,JSON.stringify(sanitiseProviderResponse(result)),JSON.stringify(job.variables),preview.html,preview.text]);if(isWelcomeTemplateKey(job.template_key))await writeAuditLog({actorType:"customer",actorId:job.user_id,action:`${welcomeAccountType(job.template_key)}_welcome_email_sent`,entityType:"email_queue",entityId:job.id,metadata:{templateKey:job.template_key,provider:job.provider,providerMessageId:messageId,attemptCount:attempt}}).catch((auditError)=>console.error("[email-centre] welcome sent audit failed",{queueId:job.id,message:auditError.message}));return {ok:true};}catch(error){const terminal=attempt>=job.maximum_attempts;const status=terminal?"dead_lettered":"failed";const delay=Math.min(3600,Math.pow(2,attempt)*30);const message=sanitiseError(error);await pool.query(`UPDATE email_queue SET status=$2,attempt_count=$3,last_attempt_at=NOW(),failed_at=NOW(),last_error=$4,scheduled_at=NOW()+($5||' seconds')::interval,locked_at=NULL,locked_by=NULL WHERE id=$1`,[job.id,status,attempt,message,delay]);await pool.query(`INSERT INTO email_delivery_logs(queue_id,attempt_number,recipient,subject,template_key,template_version,status,provider,safe_variables,html_preview,text_preview,error_code,error_message,failed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,NOW()) ON CONFLICT DO NOTHING`,[job.id,attempt,job.recipient,job.subject,job.template_key,job.template_version,status,job.provider,JSON.stringify(job.variables),preview.html,preview.text,error.code||null,message]);if(isWelcomeTemplateKey(job.template_key))await writeAuditLog({actorType:"customer",actorId:job.user_id,action:`${welcomeAccountType(job.template_key)}_welcome_email_failed`,entityType:"email_queue",entityId:job.id,metadata:{templateKey:job.template_key,provider:job.provider,status,attemptCount:attempt,reason:message}}).catch((auditError)=>console.error("[email-centre] welcome failure audit failed",{queueId:job.id,message:auditError.message}));return {ok:false,terminal};}}
async function requeueRetryable(){await ensureEmailSchema();const {rows}=await pool.query("UPDATE email_queue SET status='queued' WHERE status='failed' AND scheduled_at<=NOW() RETURNING id,user_id,template_key,attempt_count");for(const job of rows)if(isWelcomeTemplateKey(job.template_key))await writeAuditLog({actorType:"system",actorId:job.user_id,action:"welcome_email_retried",entityType:"email_queue",entityId:job.id,metadata:{templateKey:job.template_key,accountType:welcomeAccountType(job.template_key),attemptCount:job.attempt_count}}).catch((error)=>console.error("[email-centre] welcome retry audit failed",{queueId:job.id,message:error.message}));}
async function providerTest(to){const settings=await getSettings();const fake={recipient:to,subject:"TitoPay Email Centre test",encrypted_content:encrypt(JSON.stringify({html:brandedHtml("Email delivery is configured.",settings),text:"TitoPay Email Centre test. Email delivery is configured."}))};return deliverQueuedContent(fake);}

async function processWebhook(provider,event,signature,rawBody){
  await ensureEmailSchema();
  if(!/^(smtp|api|resend|postmark|brevo|mailgun|ses|sendgrid)$/.test(provider))throw new AppError(400,"Email webhook provider is invalid");
  const settings=await getSettings();const secrets=decryptProviderSecrets(settings.provider_config||{});const secret=secrets.webhookSecret||process.env.EMAIL_WEBHOOK_SECRET||"";
  if(!secret)throw new AppError(503,"Email webhook is not configured");
  const expected=crypto.createHmac("sha256",secret).update(rawBody).digest("hex"),provided=String(signature||"").replace(/^sha256=/,"");
  if(!/^[a-f0-9]{64}$/i.test(provided)||!crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(provided,"hex")))throw new AppError(401,"Webhook signature is invalid");
  const type=String(event.type||event.event||event.RecordType||event["event-data"]?.event||"").toLowerCase();
  const rawMessageId=String(event.messageId||event.message_id||event.MessageID||event.sg_message_id||event["message-id"]||event.data?.email_id||event["event-data"]?.message?.headers?.["message-id"]||"");
  const messageId=event.sg_message_id?rawMessageId.split(".")[0]:rawMessageId;
  const eventId=String(event.id||event.eventId||event.sg_event_id||event["event-data"]?.id||crypto.createHash("sha256").update(rawBody).digest("hex"));
  if(!type)throw new AppError(400,"Webhook event is invalid");
  const inserted=await pool.query(`INSERT INTO email_delivery_events(provider,provider_event_id,provider_message_id,event_type,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id`,[provider,eventId,messageId,type,JSON.stringify(sanitiseProviderResponse(event))]);
  if(!inserted.rowCount)return {duplicate:true};
  if(messageId&&["delivered","delivery","bounce","bounced","deferred","complaint","spamcomplaint","rejected","dropped"].includes(type)){const delivered=["delivered","delivery"].includes(type);await pool.query(`UPDATE email_queue SET status=$2,delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE delivered_at END,failed_at=CASE WHEN $2='failed' THEN NOW() ELSE failed_at END WHERE provider_message_id=$1`,[messageId,delivered?"delivered":"failed"]);await pool.query(`UPDATE email_delivery_logs SET status=$2,delivered_at=CASE WHEN $2='delivered' THEN NOW() ELSE delivered_at END,failed_at=CASE WHEN $2='failed' THEN NOW() ELSE failed_at END WHERE provider_message_id=$1`,[messageId,delivered?"delivered":"failed"]);}
  await writeAuditLog({actorType:"provider",action:"email_delivery_webhook_processed",entityType:"email_delivery_event",entityId:inserted.rows[0].id,metadata:{provider,eventType:type,providerMessageId:messageId}});return {processed:true};
}

// Once a code is expired it must stop existing in readable form ANYWHERE we
// control. The mailbox is the recipient's; this is ours: the sent queue row
// keeps its delivery record for the Email Centre's stats, but the encrypted
// body holding the code is replaced with an empty one. Expired challenge
// hashes go too, after the dashboard's reporting window.
async function sweepExpiredOtpEmails(){
  await ensureEmailSchema();
  const redacted=encrypt(JSON.stringify({html:"",text:""}));
  const {rowCount}=await pool.query(
    `UPDATE email_queue SET encrypted_content=$1, metadata=COALESCE(metadata,'{}'::jsonb)||'{"otpContentRedacted":true}'::jsonb
      WHERE template_key IN ('email_otp','password_change_otp') AND status='sent'
        AND sent_at < NOW() - INTERVAL '1 hour'
        AND COALESCE(metadata->>'otpContentRedacted','') <> 'true'`,[redacted]);
  const {rowCount:purged}=await pool.query(
    "DELETE FROM otp_codes WHERE expires_at < NOW() - INTERVAL '7 days'");
  return {redacted:rowCount,purged};
}
module.exports={EMAIL_PERMISSIONS,sweepExpiredOtpEmails,seedDefaultTemplates,ALLOWED_VARIABLES,DEFAULT_TEMPLATES,ensureEmailSchema,escapeHtml,stripDangerousMarkup,htmlFromText,interpolate,renderTemplate,getSettings,updateSettings,listTemplates,getTemplate,saveTemplate,deleteTemplate,queueEmail,queueWelcomeEmail,welcomeTemplateKeyForAccountType,isWelcomeTemplateKey,queueRawEmail,createVerificationForUser,verifyEmailToken,resendVerification,requestEmailPasswordReset,confirmEmailPasswordReset,listQueue,queueDetail,manageQueue,listLogs,logDetail,dashboard,analytics,claimJobs,processJob,requeueRetryable,providerTest,processWebhook,maskSecrets,safePayload,sanitiseError};
