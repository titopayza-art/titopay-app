"use strict";

process.env.POSTGRES_URL ||= "postgres://localhost/titopay_email_test";
process.env.JWT_ACCESS_SECRET ||= "email-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "email-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const email = require("../src/services/email-centre-service");

const root = path.join(__dirname, "..");
const { pwaFile } = require("./pwa-path");

test("Email Centre seeds every required transactional template", () => {
  // 24 customer and transactional templates, plus 6 for HR work communications.
  // The exact count is the guard: it catches a template being dropped, which a
  // list of required keys alone would not.
  assert.equal(email.DEFAULT_TEMPLATES.length, 30);
  const keys = new Set(email.DEFAULT_TEMPLATES.map((item) => item[0]));
  assert.equal(keys.size, email.DEFAULT_TEMPLATES.length, "template keys must be unique");
  for (const key of ["welcome_email","personal_account_welcome","business_account_welcome","email_statement","verify_email_address","password_reset","password_changed","qr_payment_receipt","kyc_approved","support_ticket_resolved"]) assert.ok(keys.has(key));
  for (const key of ["hr_announcement","hr_leave_decision","hr_claim_decision","hr_request_update","hr_onboarding_task","hr_training_reminder"]) {
    assert.ok(keys.has(key), `HR template ${key} is missing`);
  }
  // Every variable an HR template refers to has to be permitted, or it renders
  // as an empty string and the message goes out with a hole in it.
  for (const [key, , subject, body] of email.DEFAULT_TEMPLATES) {
    if (!key.startsWith("hr_")) continue;
    for (const match of `${subject} ${body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      assert.ok(email.ALLOWED_VARIABLES.has(match[1]),
        `${key} uses {{${match[1]}}}, which is not an allowed variable`);
    }
  }
});

test("Email OTP generator is cryptographically random, numeric and correctly sized", () => {
  const otp=require("../src/services/email-otp-service");
  const values=new Set(Array.from({length:100},()=>otp.generateNumericOtp(6)));
  assert.equal(values.size,100);
  for(const value of values)assert.match(value,/^\d{6}$/);
  const cryptoSource=fs.readFileSync(path.join(root,"src/lib/crypto.js"),"utf8");
  assert.match(cryptoSource,/crypto\.randomInt/);
  assert.doesNotMatch(cryptoSource,/Math\.random/);
});

test("Email OTP defaults are off and all challenge states remain hash-only", () => {
  const schema=fs.readFileSync(path.join(root,"src/db/email-centre-schema.sql"),"utf8");
  assert.match(schema,/email_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema,/email_otp_expiry_minutes INTEGER NOT NULL DEFAULT 5/);
  assert.match(schema,/email_otp_maximum_attempts INTEGER NOT NULL DEFAULT 5/);
  assert.match(schema,/email_otp_maximum_resends INTEGER NOT NULL DEFAULT 3/);
  const service=fs.readFileSync(path.join(root,"src/services/email-otp-service.js"),"utf8");
  assert.match(service,/sha256\(code\)/);
  assert.match(service,/remainingAttempts/);
  assert.match(service,/pg_advisory_lock/);
  assert.doesNotMatch(service,/otp_plain|plain.*otp/i);
});

test("wallet unlock automatically uses the saved authentication preference with fallback", () => {
  const service = fs.readFileSync(path.join(root, "src/services/email-otp-service.js"), "utf8");
  const preference = fs.readFileSync(path.join(root, "src/services/authentication-preference-service.js"), "utf8");
  const routes = fs.readFileSync(path.join(root, "src/routes/security.routes.js"), "utf8");
  const app = fs.readFileSync(pwaFile("app.js"), "utf8");
  assert.match(service, /wallet_unlock/);
  assert.match(routes, /wallet-lock\/unlock\/options/);
  assert.match(preference, /emailOtp\.createChallenge/);
  assert.match(preference, /email_otp:\$\{WALLET_PURPOSE\}/);
  assert.match(app, /\/v1\/auth\/me\/authentication-preference/);
  assert.match(app, /Preferred Authentication Method/);
  assert.match(app, /body: \{ deviceName: "TitoPay PWA"/);
  assert.doesNotMatch(app, /Choose where TitoPay should send your one-time verification code/);
  assert.match(app, /wallet-lock\/unlock\/verify/);
});

test("Email OTP is free while Email Statements remain R0.10 and notifications are free", () => {
  const pricing=fs.readFileSync(path.join(root,"src/services/pricing-service.js"),"utf8");
  assert.match(pricing,/\["email_otp", "Email OTP"\]/);
  assert.match(pricing,/\["email_statement", "Email Statement", 0\.10\]/);
  assert.match(pricing,/\["email_notifications", "Email Notifications"\]/);
});

test("Email Statement uses the existing Email Centre template and safe statement variables", () => {
  const template=email.DEFAULT_TEMPLATES.find(([key])=>key==="email_statement");
  assert.ok(template);
  assert.equal(template[2],"Your TitoPay statement {{statementReference}}");
  for(const variable of ["statementPeriod","statementReference","transactionCount","moneyIn","moneyOut","netMovement","statementLines","statementFee"])assert.ok(email.ALLOWED_VARIABLES.has(variable));
  assert.match(template[3],/not a bank statement/);
});

test("customer-facing statement copy does not expose internal Email Centre details", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  const template=email.DEFAULT_TEMPLATES.find(([key])=>key==="email_statement");
  assert.ok(template);
  assert.doesNotMatch(app,/Email Centre queue/i);
  assert.doesNotMatch(template[3],/Email Centre queue|email queue/i);
});

test("Marketing Email Production reuses approval RBAC and publishes only through the queue", () => {
  const routes=fs.readFileSync(path.join(root,"src/routes/admin.routes.js"),"utf8");
  assert.match(routes,/marketing\/email-campaigns/);
  assert.match(routes,/marketing_email_approve/);
  assert.match(routes,/queueRawEmail/);
  assert.match(routes,/marketing_email_campaign_approved_and_published/);
});

test("safe interpolation escapes user content and rejects unsafe links", () => {
  assert.equal(email.interpolate("Hello {{fullName}}", {fullName:"<img src=x onerror=alert(1)>"}, {html:true}), "Hello &lt;img src=x onerror=alert(1)&gt;");
  assert.equal(email.interpolate("{{verificationLink}}", {verificationLink:"javascript:alert(1)"}, {html:true}), "#");
  assert.equal(email.interpolate("{{appUrl}}", {appUrl:"javascript:alert(1)"}, {html:true}), "#");
  assert.match(email.interpolate("{{verificationLink}}", {verificationLink:"https://app.titopay.co.za/verify?token=a&b=c"}, {html:true}), /^https:\/\/app\.titopay\.co\.za/);
});

test("Personal and Business registrations select separate Welcome Email templates", () => {
  assert.equal(email.welcomeTemplateKeyForAccountType("personal"),"personal_account_welcome");
  assert.equal(email.welcomeTemplateKeyForAccountType("business"),"business_account_welcome");
  assert.equal(email.welcomeTemplateKeyForAccountType("unexpected"),"personal_account_welcome");
  const templates=Object.fromEntries(email.DEFAULT_TEMPLATES.map(([key,name,subject,body])=>[key,{name,subject,body}]));
  assert.equal(templates.personal_account_welcome.subject,"Welcome to TitoPay");
  assert.equal(templates.business_account_welcome.subject,"Welcome to TitoPay Business");
  assert.match(templates.personal_account_welcome.body,/manage your wallet.*QR payments/);
  assert.match(templates.business_account_welcome.body,/business verification or approval/);
});

test("template markup sanitation removes scripts, event handlers and javascript URLs", () => {
  const clean=email.stripDangerousMarkup('<script>alert(1)</script><a onclick="x" href="javascript:alert(2)">Verify</a>');
  assert.doesNotMatch(clean,/script|onclick|javascript/i);
  assert.match(clean,/Verify/);
});

test("transactional emails use the official TitoPay logo with accessible fallback text", () => {
  const rendered=email.renderTemplate(
    {subject:"Welcome to {{companyName}}",html_body:"<p>Welcome {{firstName}}.</p>",text_body:"Welcome {{firstName}}."},
    {firstName:"Thuso"},
    {company_name:"TitoPay",support_email:"support@titopay.co.za",support_url:"https://titopay.co.za/support",website_url:"https://titopay.co.za",tagline:"Smart Payments, Simplified."}
  );
  assert.match(rendered.html,/https:\/\/titopay\.co\.za\/assets\/titopay-official-logo\.png/);
  assert.match(rendered.html,/alt="TitoPay"/);
  assert.match(rendered.html,/width="210"/);
});

test("secret masking and safe payloads never return credentials or links", () => {
  assert.deepEqual(email.maskSecrets({smtpHost:"mail.example",password:"secret",nested:{apiKey:"key"}}),{smtpHost:"mail.example",password:"••••••••",nested:{apiKey:"••••••••"}});
  assert.deepEqual(email.safePayload({firstName:"Tito",verificationLink:"https://example/token"}),{firstName:"Tito",verificationLink:"[REDACTED]"});
});

test("Email Centre schema is additive, indexed and stores only token hashes", () => {
  const schema=fs.readFileSync(path.join(root,"src/db/email-centre-schema.sql"),"utf8");
  assert.match(schema,/sender_name TEXT NOT NULL DEFAULT 'TitoPay'/);
  assert.match(schema,/sender_email TEXT NOT NULL DEFAULT 'no-reply@notify\.titopay\.co\.za'/);
  assert.match(schema,/reply_to_email TEXT NOT NULL DEFAULT 'support@titopay\.co\.za'/);
  assert.match(schema,/ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at/);
  assert.match(schema,/token_hash TEXT NOT NULL UNIQUE/g);
  assert.doesNotMatch(schema,/raw_token|verification_token TEXT|reset_token TEXT/);
  assert.match(schema,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(schema,/FOR UPDATE SKIP LOCKED|idx_email_queue_claim/);
  assert.match(schema,/dead_lettered/);
  assert.match(schema,/idx_email_delivery_events_message/);
  assert.match(schema,/idx_email_delivery_events_received/);
});

test("Email Analytics is additive and uses provider events for optional engagement metrics", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  const routes=fs.readFileSync(path.join(root,"src/routes/email-centre.routes.js"),"utf8");
  const admin=fs.readFileSync(path.join(root,"../admin/assets/admin.js"),"utf8");
  assert.match(service,/async function analytics\(query=\{\}, allowedTemplates=null\)/);
  assert.match(service,/open_tracking_supported/);
  assert.match(service,/click_tracking_supported/);
  assert.match(service,/spam_complaints/);
  assert.match(service,/DATE_TRUNC\('\$\{bucket\}'/);
  assert.match(routes,/router\.get\("\/analytics", permission\("VIEW"\)/);
  assert.match(routes,/email\.analytics\(req\.query,templateScope\(req\)\)/);
  assert.match(admin,/Email Analytics/);
  assert.match(admin,/\/admin\/email\/analytics\?days=30/);
});

test("worker claims with SKIP LOCKED, retries with backoff and shuts down gracefully", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  const worker=fs.readFileSync(path.join(root,"src/email-worker.js"),"utf8");
  assert.match(service,/FOR UPDATE SKIP LOCKED/);
  assert.match(service,/daily_sending_limit/);
  assert.match(service,/sending_enabled/);
  assert.match(service,/Math\.pow\(2,attempt\)/);
  assert.match(worker,/SIGTERM/);
  assert.match(worker,/pool\.end/);
});

test("configured API providers use provider-specific production adapters", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  for (const provider of ["resend","postmark","brevo","sendgrid","mailgun","ses"]) assert.match(service,new RegExp(`provider\\.provider===\\"${provider}\\"`));
  assert.match(service,/api\.resend\.com\/emails/);
  assert.match(service,/api\.postmarkapp\.com\/email/);
  assert.match(service,/api\.brevo\.com\/v3\/smtp\/email/);
  assert.match(service,/api\.sendgrid\.com\/v3\/mail\/send/);
  assert.match(service,/getEffectiveEmailProviderConfig/);
});

test("Email OTP remains unavailable until the global and event switches are enabled", () => {
  const routes=fs.readFileSync(path.join(root,"src/routes/auth.routes.js"),"utf8");
  assert.match(routes,/if\(!await emailOtp\.shouldRequireEmailOtp\(purpose\)\)throw new AppError\(409/);
  assert.doesNotMatch(routes,/force:purpose===\"optional_mfa\"/);
});

test("customer password changes add free Email OTP without replacing SMS recovery", () => {
  const routes=fs.readFileSync(path.join(root,"src/routes/auth.routes.js"),"utf8");
  const auth=fs.readFileSync(path.join(root,"src/services/auth-service.js"),"utf8");
  const paidOtp=fs.readFileSync(path.join(root,"src/services/password-change-otp-service.js"),"utf8");
  const emailOtp=fs.readFileSync(path.join(root,"src/services/email-otp-service.js"),"utf8");
  assert.match(routes,/router\.get\("\/me\/password-change\/options", requireAuth/);
  assert.match(routes,/router\.post\("\/me\/password-change\/request", requireAuth, otpLimiter/);
  assert.match(routes,/router\.post\("\/password-reset\/request", authLimiter/);
  assert.match(auth,/channel === "email"/);
  assert.match(auth,/purpose: "password_reset"/);
  assert.match(auth,/row\.purpose !== "password_reset" && !isEmailPasswordChange/);
  assert.match(paidOtp,/fee: 0/);
  assert.match(paidOtp,/pg_advisory_xact_lock/);
  assert.match(paidOtp,/client\.query\("BEGIN"\)/);
  assert.match(paidOtp,/client\.query\("COMMIT"\)/);
  assert.match(paidOtp,/client\.query\("ROLLBACK"\)/);
  assert.match(paidOtp,/fee: 0/);
  assert.doesNotMatch(paidOtp,/applyWalletMovement/);
  assert.doesNotMatch(paidOtp,/revenue_ledger/);
  assert.match(paidOtp,/email-otp-password-change:/);
  assert.match(emailOtp,/if\(options\.db\)return createChallengeInTransaction/);
  assert.match(emailOtp,/queueEmail\(\{recipient:user\.email,templateKey:"email_otp"/);
});

test("PWA offers authenticated password changes by SMS or free Email OTP", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  const styles=fs.readFileSync(pwaFile("styles.css"),"utf8");
  assert.match(app,/api\("\/v1\/auth\/me\/password-change\/options"\)/);
  assert.match(app,/api\("\/v1\/auth\/me\/password-change\/request"/);
  assert.match(app,/name="otpChannel" value="sms"/);
  assert.match(app,/name="otpChannel" value="email"/);
  assert.match(app,/SMS and Email OTP are free/);
  assert.match(app,/Email OTP is currently unavailable/);
  assert.match(app,/"Idempotency-Key": idempotencyKey/);
  assert.match(app,/api\("\/v1\/auth\/password-reset\/request"/);
  assert.match(app,/auth: false/);
  assert.match(styles,/\.otp-channel-option:has\(input:checked\)/);
  assert.match(styles,/\.otp-channel-option\.is-disabled/);
});

test("PWA notification clearing persists across server and transaction refreshes", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  assert.match(app,/function notificationClearedAtKey\(\)/);
  assert.match(app,/localStorage\.setItem\(notificationClearedAtKey\(\), String\(Date\.now\(\)\)\)/);
  assert.match(app,/Array\.isArray\(stored\) \? stored : defaultInAppNotifications\(\)/);
  assert.match(app,/Date\.parse\(createdAt\) <= clearedAt/);
});

test("health response includes non-breaking Email worker state", () => {
  const health=fs.readFileSync(path.join(root,"src/routes/health.routes.js"),"utf8");
  assert.match(health,/to_regclass\('public\.email_queue'\)/);
  assert.match(health,/emailWorker/);
  assert.match(health,/stale/);
});

test("admin email routes require authentication and explicit Email permissions", () => {
  const routes=fs.readFileSync(path.join(root,"src/routes/email-centre.routes.js"),"utf8");
  assert.match(routes,/router\.use\(requireAuth\)/);
  for (const permission of ["VIEW","TEMPLATE_EDIT","TEMPLATE_DELETE","QUEUE_MANAGE","LOG_VIEW","SETTINGS_EDIT","PROVIDER_EDIT","TEST_SEND"]) assert.match(routes,new RegExp(`permission\\(\\"${permission}\\"\\)`));
  assert.match(routes,/requireSuperAdmin/);
  assert.match(routes,/templateScope/);
});

test("expired admin access tokens return an authentication error instead of a server error", () => {
  const auth = fs.readFileSync(path.join(root, "src/middleware/auth.js"), "utf8");
  assert.match(auth, /TokenExpiredError/);
  assert.match(auth, /new AppError\(401, "Session expired"\)/);
});

test("Email dashboard rounds delivery latency with PostgreSQL-compatible numeric arithmetic", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  assert.match(service,/AVG\(EXTRACT\(EPOCH FROM\(delivered_at-sent_at\)\).*\)\)::numeric/);
  assert.match(service,/created_at::date AS "day"/);
  const otp=fs.readFileSync(path.join(root,"src/services/email-otp-service.js"),"utf8");
  assert.match(otp,/AVG\(EXTRACT\(EPOCH FROM\(delivered_at-sent_at\)\).*\)\)::numeric/);
  assert.match(otp,/metadata->>'location' AS "location"/);
});

test("scoped Admin roles cannot cross-read unrelated email categories", () => {
  const routes=fs.readFileSync(path.join(root,"src/routes/email-centre.routes.js"),"utf8");
  for(const role of ["customer_support","compliance","finance"])assert.match(routes,new RegExp(`role===\\"${role}\\"`));
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  assert.match(service,/allowedTemplates/);
  assert.match(service,/template_key=ANY/);
});

test("delivery attempt previews redact OTPs and secure-link tokens", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  assert.match(service,/safeContentPreview/);
  assert.match(service,/html_preview,text_preview/);
  assert.match(service,/\[REDACTED\]/);
});

test("registration queues email only after the existing account transaction commits", () => {
  const source=fs.readFileSync(path.join(root,"src/services/auth-service.js"),"utf8");
  const registerStart=source.indexOf("async function register");
  const registerEnd=source.indexOf("function getLoginIdentifier",registerStart);
  const register=source.slice(registerStart,registerEnd);
  assert.ok(register.indexOf('client.query("COMMIT")') < register.indexOf("createVerificationForUser"));
  assert.ok(register.indexOf('client.query("COMMIT")') < register.indexOf("queueWelcomeEmail"));
  assert.match(register,/registration welcome email queue failed/);
  assert.match(register,/notificationType: "account_welcome"/);
  assert.match(register,/welcomeNotification/);
  assert.match(register,/welcomeEmailQueued:Boolean/);
  assert.match(register,/welcomeInAppNotificationCreated:Boolean/);
});

test("Welcome Email queuing is OTP-independent, idempotent and separate from verification resend", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  const welcomeStart=service.indexOf("async function queueWelcomeEmail");
  const welcomeEnd=service.indexOf("async function queueRawEmail",welcomeStart);
  const welcome=service.slice(welcomeStart,welcomeEnd);
  assert.match(welcome,/welcome-email:\$\{user\.id\}:\$\{accountType\}/);
  assert.doesNotMatch(welcome,/otp|authenticationMode|preferred/i);
  const verificationStart=service.indexOf("async function createVerificationForUser");
  const verificationEnd=service.indexOf("async function verifyEmailToken",verificationStart);
  const verification=service.slice(verificationStart,verificationEnd);
  assert.match(verification,/templateKey:"verify_email_address"/);
  assert.doesNotMatch(verification,/personal_account_welcome|business_account_welcome|templateKey:"welcome_email"/);
  assert.match(service,/template_disabled/);
});

test("Welcome Email lifecycle and template changes use existing delivery and audit logs", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  for(const action of [
    "welcome_email_retried","welcome_template_changed",
    "welcome_template_enabled","welcome_template_disabled"
  ])assert.match(service,new RegExp(action));
  assert.match(service,/\$\{accountType\}_welcome_email_queued/);
  assert.match(service,/\$\{welcomeAccountType\(job\.template_key\)\}_welcome_email_sent/);
  assert.match(service,/\$\{welcomeAccountType\(job\.template_key\)\}_welcome_email_failed/);
  assert.match(service,/INSERT INTO email_delivery_logs/);
  assert.match(service,/provider_message_id/);
  assert.match(service,/sanitiseError\(error\)/);
});

test("App reports asynchronous Welcome Email status without changing the registration route", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  assert.match(app,/api\("\/v1\/auth\/register"/);
  assert.match(app,/registration\.user\?\.welcomeEmailQueued/);
  assert.match(app,/Your welcome email is on its way\./);
});

test("routine customer login alerts remain in-app while unrecognised-device emails remain enabled", () => {
  const auth=fs.readFileSync(path.join(root,"src/services/auth-service.js"),"utf8");
  const noticeStart=auth.indexOf("async function queueLoginNotice");
  const noticeEnd=auth.indexOf("async function login",noticeStart);
  const notice=auth.slice(noticeStart,noticeEnd);
  assert.match(notice,/user\.user_type==="customer"&&templateKey==="login_notification"/);
  assert.match(notice,/channel:"in_app"/);
  assert.match(notice,/notificationType:"login_notification"/);
  assert.match(notice,/deliveredInApp:true/);
  assert.ok(notice.indexOf("return;") < notice.indexOf("await queueEmail"));
  assert.match(notice,/templateKey="new_device_login"/);

  const routes=fs.readFileSync(path.join(root,"src/routes/chat.routes.js"),"utf8");
  assert.equal((routes.match(/notification_type = 'login_notification'/g)||[]).length,2);
});

test("production email-verification links have a working token-safe PWA landing page", () => {
  const service=fs.readFileSync(path.join(root,"src/services/email-centre-service.js"),"utf8");
  const page=fs.readFileSync(pwaFile("verify-email/index.html"),"utf8");
  const handler=fs.readFileSync(pwaFile("verify-email/verify-email.js"),"utf8");
  assert.match(service,/\/verify-email\?token=/);
  assert.match(page,/verify-email\.js\?v=227/);
  assert.match(handler,/\/v1\/auth\/email\/verify/);
  assert.match(handler,/history\.replaceState/);
  assert.match(handler,/JSON\.stringify\(\{ token \}\)/);
  assert.doesNotMatch(page,/404|Not Found/);
});

test("Email Statement wallet operations are authenticated, priced, atomic and idempotent", () => {
  const routes=fs.readFileSync(path.join(root,"src/routes/wallet.routes.js"),"utf8");
  const wallet=fs.readFileSync(path.join(root,"src/services/wallet-service.js"),"utf8");
  assert.match(routes,/router\.use\(requireAuth\)/);
  assert.match(routes,/statement\/email\/preview/);
  assert.match(routes,/statement\/email/);
  assert.match(wallet,/calculateFee\("email_statement",0\)/);
  assert.match(wallet,/idempotencyKey:`email-statement:\$\{userId\}:\$\{idempotencyKey\}`/);
  assert.match(wallet,/db:client/);
  assert.match(wallet,/client\.query\("BEGIN"\)/);
  assert.match(wallet,/client\.query\("COMMIT"\)/);
  assert.match(wallet,/client\.query\("ROLLBACK"\)/);
  assert.match(wallet,/serviceCode:"email_statement"/);
  assert.match(wallet,/email_statement_queued/);
  assert.match(wallet,/Insufficient balance for the R0\.10 Email Statement fee/);
});

test("Activity provides a confirmed Email Statement action with visible R0.10 pricing", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  assert.match(app,/data-action="email-statement"/);
  // The price is rendered from the constant rather than typed into the button,
  // so the assertion checks both halves: that the button shows the fee, and
  // that the fee is still ten cents.
  assert.match(app,/Email statement · \$\{money\(EMAIL_STATEMENT_FEE\)\}/);
  assert.match(app,/const EMAIL_STATEMENT_FEE = 0\.1;/);
  assert.match(app,/statement\/email\/preview/);
  assert.match(app,/data-action="confirm-email-statement"/);
  assert.match(app,/function receiptRow\(label, value\)/);
  assert.match(app,/confirmEmailStatement\(actionElement\)/);
  assert.match(app,/"Idempotency-Key":button\.dataset\.idempotencyKey/);
  assert.match(app,/No duplicate fee was charged/);
});

test("Personal and Business PDF statements use the current logo and fit amount values", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  assert.match(app,/const profileType = state\.accountType === "business" \? "Business profile" : "Personal profile"/);
  assert.match(app,/text\(52, 768, "Tito", 27, "F2", "0\.03 0\.08 0\.22"\)/);
  assert.match(app,/text\(97, 768, "Pay", 27, "F2", "0\.18 0\.54 0\.95"\)/);
  assert.match(app,/const statementHeaderX = 352/);
  assert.match(app,/text\(statementHeaderX, 776, "ACCOUNT STATEMENT", 15/);
  assert.match(app,/text\(statementHeaderX, 757, profileType, 9/);
  assert.match(app,/text\(statementHeaderX, 743, `Issued \$\{issuedDate\} at \$\{issuedTime\}`, 8\.5/);
  assert.match(app,/text\(statementHeaderX, 730, `Reference \$\{referenceNo\}`, 8\.5/);
  assert.match(app,/function statementAmountFontSize\(value, maxWidth = 92, maxSize = 9\)/);
  assert.match(app,/rightText\(528, y \+ 4, amountText, statementAmountFontSize\(amountText\)/);
});

test("customer Email Notification preferences are authenticated, free and backward-compatible", () => {
  const schema=fs.readFileSync(path.join(root,"src/db/schema.sql"),"utf8");
  const routes=fs.readFileSync(path.join(root,"src/routes/auth.routes.js"),"utf8");
  const service=require("../src/services/customer-notification-preference-service");
  assert.match(schema,/CREATE TABLE IF NOT EXISTS customer_notification_preferences/);
  assert.match(schema,/email_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(schema,/email_transaction_receipts BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(schema,/email_support_updates BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(routes,/router\.get\("\/me\/notification-preferences", requireAuth/);
  assert.match(routes,/router\.put\("\/me\/notification-preferences", requireAuth/);
  assert.equal(service.publicPreferences({}).email.price,0);
  assert.equal(service.publicPreferences({}).email.transactionReceipts,true);
  assert.equal(service.publicPreferences({email_notifications_enabled:false}).email.enabled,false);
});

test("critical emails remain protected while optional transaction and support emails respect preferences", () => {
  const preferenceService=fs.readFileSync(path.join(root,"src/services/customer-notification-preference-service.js"),"utf8");
  const transactions=fs.readFileSync(path.join(root,"src/services/transaction-service.js"),"utf8");
  const support=fs.readFileSync(path.join(root,"src/routes/support.routes.js"),"utf8");
  for(const category of ["password_reset","password_changed","account_security","email_verification","kyc","business_approval"])assert.match(preferenceService,new RegExp(`\\"${category}\\"`));
  assert.match(preferenceService,/if \(!userId \|\| REQUIRED_EMAIL_CATEGORIES\.has/);
  assert.match(preferenceService,/preference lookup failed open/);
  assert.match(preferenceService,/client\.query\("BEGIN"\)/);
  assert.match(preferenceService,/client\.query\("COMMIT"\)/);
  assert.match(preferenceService,/client\.query\("ROLLBACK"\)/);
  assert.match(preferenceService,/db: client/);
  assert.match(transactions,/shouldSendCustomerEmail\(actor\.userId, "transaction"\)/);
  assert.match(support,/shouldSendCustomerEmail\(req\.auth\.userId,"support"\)/);
});

test("PWA Notification Centre exposes account-wide Email preferences and protected critical notices", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  assert.match(app,/data-action="preview-email-notifications"/);
  assert.match(app,/Email notification preferences/);
  assert.match(app,/Transaction receipts/);
  assert.match(app,/Password and PIN resets", "Always on · Free/);
  assert.match(app,/Critical security alerts", "Always on · Free/);
  assert.match(app,/\/v1\/auth\/me\/notification-preferences/);
  assert.match(app,/method: "PUT"/);
});

test("PWA renames only the customer tickets tile to Event Tickets", () => {
  const app=fs.readFileSync(pwaFile("app.js"),"utf8");
  const catalogue=JSON.parse(fs.readFileSync(pwaFile("services-default.json"),"utf8"));
  const tickets=catalogue.items.find((item)=>item.service_code==="tickets");
  assert.equal(tickets.service_name,"Event Tickets");
  assert.equal(tickets.action,"tickets");
  assert.match(app,/serviceCode === "tickets" \|\| action === "tickets"/);
  assert.match(app,/\? "Event Tickets"/);
  assert.match(app,/if \(service\.type === "tickets" \|\| service\.action === "tickets"\) return openPersonalTicketsDashboard\(\)/);
});
