// VerifyNow electronic organiser checks (KYC/KYB), against a harness instance
// and the local mock VerifyNow (dev/mock-verifynow.js, started here).
//
//   node ticketroom/live/dev/tests/verifynow.js <dir> <port> [mockPort]
//
// Covers: the Integrations card (write-only key, live-key rule for production,
// generated webhook secret, Test connection with credits, TEST label), POPIA
// consent before any check, checks queued by the request and run in the
// background, each check's pass / review / fail, details changed -> checked
// again, admin review queue with reasons, accept / reject / re-run, automatic
// "verification complete", payouts gated until the bank account is verified,
// the webhook signature rules (good, bad, stale, duplicate), job polling when
// no webhook comes, idempotent retries after a lost answer and a timeout,
// Retry-After on 429, no credits (402), and that the API key and full ID
// numbers never reach the logs or the database in plain text.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { Client, outbox, sql, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = Number(process.argv[3] || 8653);
const MOCK_PORT = Number(process.argv[4] || process.env.TR_VN_MOCK_PORT || 8805);
const BASE = `http://localhost:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DATA = path.join(DIR, "ticketroom-data");
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
if (!process.argv[2] || !ADMIN_PW) { console.error("usage: TR_TEST_ADMIN_PASSWORD=... node tests/verifynow.js <dir> <port> [mockPort]"); process.exit(2); }
const KEY = "vn_live_" + crypto.randomBytes(18).toString("hex");

let failures = 0;
const ok = (cond, name, info) => { if (cond) console.log("  ok   " + name); else { failures++; console.log("  FAIL " + name + (info !== undefined ? "  " + (typeof info === "string" ? info : JSON.stringify(info)).slice(0, 600) : "")); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (query, params = []) => sql(DATA, query, params);

// ---------------------------------------------------------------- helpers
// A valid SA ID (Luhn), born 1990-01-01, citizen. tail: last two digits wanted
// ("90" negative path, "91" error path), or null for any.
function saId(tail = null) {
  for (let n = 0; n < 100000; n++) {
    const body = "900101" + String(5000 + crypto.randomInt(4999)).padStart(4, "0") + "0" + (tail ? tail[0] : String(crypto.randomInt(8)));
    let sum = 0;
    for (let i = 0; i < 12; i++) { let d = +body[11 - i]; if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; } sum += d; }
    const id = body + ((10 - (sum % 10)) % 10);
    if (tail ? id.endsWith(tail) : !/9[01]$/.test(id)) return id;
  }
  throw new Error("no ID for tail " + tail);
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function mock(p, body) { const r = await fetch(MOCK + p, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return r.json(); }
function cron() { execFileSync("php", [path.join(DIR, "public_html/api/cron.php"), "--all"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
const openChecks = (orgId) => q("SELECT count(*) AS n FROM kyc_checks WHERE status IN ('queued','running','waiting')" + (orgId ? " AND organiser_id = ?" : ""), orgId ? [orgId] : [])[0].n;
// Runs the background worker until nothing is left to do (or the time is up).
async function drain(orgId = null, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    cron();
    if (!openChecks(orgId)) return true;
    await sleep(400);
  }
  return false;
}
const latest = (orgId, type) => q("SELECT * FROM kyc_checks WHERE organiser_id = ? AND check_type = ? AND status <> 'superseded' ORDER BY created_at DESC, rowid DESC LIMIT 1", [orgId, type])[0];
const item = (v, key) => v.requirements.find((r) => r.key === key);
function writeConfig(vn) {
  const f = path.join(DATA, "config.php");
  let s = fs.readFileSync(f, "utf8").replace(/\n    'verifynow' => \[[^\n]*\],/, "");
  if (vn) s = s.replace(/\n\];\s*$/, `\n    'verifynow' => ${vn},\n];\n`);
  fs.writeFileSync(f, s);
}
// PHP's opcache may keep the old config.php for up to 2 seconds.
const setConfig = async (vn) => { writeConfig(vn); await sleep(2500); };
const VN_CONFIG = (extra = "") => `['baseUrl' => '${MOCK}', 'allowPrivateHosts' => true, 'timeout' => 3, 'retryBaseSeconds' => 1, 'maxAttempts' => 3, 'pollSeconds' => 2${extra}]`;

async function makeOrg(label) {
  const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  const email = `vn-${label}+${stamp}@example.test`;
  const password = "Tst-" + crypto.randomBytes(12).toString("base64url");
  const c = new Client(BASE, DATA);
  await c.call("POST", "/api/organiser/signup", { fullName: `Owner ${label}`, email, password, organisation: `VN ${label} Events ${stamp}`, acceptTerms: true }, 201);
  const link = outbox(DATA, email, /#\/verify\/([A-Za-z0-9._~%-]+)/);
  await c.call("POST", "/api/auth/verify-email", { token: decodeURIComponent(link[1]) });
  await c.refreshCsrf();
  const orgs = await c.call("GET", "/api/organiser/orgs");
  const orgId = (orgs.organisers || orgs.orgs || orgs)[0].id;
  await admin.call("POST", `/api/admin/organisers/${orgId}/status`, { status: "approved" });
  return { c, orgId, base: `/api/organiser/${orgId}` };
}
const upload = (o, req) => o.c.call("POST", `${o.base}/verification/documents?requirement=${req}`, PNG, 201, { "content-type": "image/png", "x-file-name": req + ".png" });
const verif = async (o) => (await o.c.call("GET", `${o.base}/verification`)).verification;
async function freeEvent(o, title) {
  const t = new Date(Date.now() + 20 * 86400000); t.setUTCHours(17, 0, 0, 0);
  const e = new Date(t.getTime() + 4 * 3600000);
  return (await o.c.call("POST", `${o.base}/events`, { title, summary: "A test event for the VerifyNow checks", category: "music", venueName: "Test Hall", address: "1 Test Street",
    city: "Cape Town", province: "Western Cape", startsAt: t.toISOString(), endsAt: e.toISOString(), description: "Local test data for the VerifyNow checks. Nothing real happens here.", isFree: true, capacity: 100 }, 201)).event;
}
async function expectError(p, code) {
  try { await p; return { status: 200, code: null }; }
  catch (e) { const m = String(e.message).match(/-> (\d{3}) (.*)$/s); let j = {}; try { j = JSON.parse(m[2]); } catch { /* */ } return { status: m ? +m[1] : 0, code: j.error?.code, body: j }; }
}
async function saveVn(values, expect) { return admin.call("PUT", "/api/admin/integrations/verifynow", { currentPassword: ADMIN_PW, values }, expect); }

let admin;
let mockProc;
const ids = [];
(async () => {
  console.log("VerifyNow checks");
  mockProc = spawn(process.execPath, [path.join(__dirname, "..", "mock-verifynow.js"), String(MOCK_PORT), KEY], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((res, rej) => { mockProc.stdout.once("data", res); mockProc.once("exit", (c) => rej(new Error("mock exited " + c))); });
  const who = await mock("/__mock/calls");
  if (who.pid !== mockProc.pid) throw new Error(`port ${MOCK_PORT} is answered by another process (pid ${who.pid}), not the mock started here`);
  await setConfig(VN_CONFIG());
  admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);

  // ============================================================ Integrations card
  let integ = (await admin.call("GET", "/api/admin/integrations")).integrations;
  let card = integ.find((i) => i.key === "verifynow");
  ok(card && card.fields.some((f) => f.name === "apiKey" && f.secret && !f.set), "Integrations lists a VerifyNow card with a write-only API key box");
  ok(card && ["checkAml", "checkCipc", "checkBank", "checkFace"].every((n) => card.fields.some((f) => f.name === n)), "the card lets admins choose the checks");
  let r = await expectError(saveVn({ enabled: "on", mode: "production", apiKey: "sk_test_" + "x".repeat(20) }, 200));
  ok(r.status === 422 && /vn_live_/.test(JSON.stringify(r.body)), "production refuses a key that is not a live key", r);
  const saved = await saveVn({ enabled: "on", mode: "sandbox", apiKey: KEY, checkAml: "on", checkCipc: "on", checkBank: "on", checkFace: "off" });
  card = saved.integration;
  ok(card.test === true && /TEST/.test(card.environment), "sandbox is labelled TEST", card.environment);
  ok(card.fields.find((f) => f.name === "apiKey").set && card.fields.find((f) => f.name === "webhookSecret").set, "key saved and a webhook secret generated");
  ok(!JSON.stringify(saved).includes(KEY) && !JSON.stringify(await admin.call("GET", "/api/admin/integrations")).includes(KEY), "the key is never sent back to the browser");
  const stored = q("SELECT value FROM integration_settings WHERE key = 'verifynow'")[0].value;
  ok(!stored.includes(KEY) && /"webhookSecret":"v1\./.test(stored), "key and webhook secret are stored encrypted");
  let h = await admin.call("POST", "/api/admin/integrations/verifynow/health");
  ok(h.ok && h.credits === 50 && /TEST/.test(h.detail), "Test connection calls /my_credits and shows the balance", h);
  ok(q("SELECT count(*) AS n FROM kyc_checks")[0].n === 0, "nothing runs before an organiser asks");
  await mock("/__mock/config", { key: "vn_live_someoneelseskey0000000" });
  h = await admin.call("POST", "/api/admin/integrations/verifynow/health");
  ok(!h.ok && /refused the API key/.test(h.detail), "an invalid key is reported plainly", h);
  await mock("/__mock/config", { key: KEY });

  // ============================================================ A: individual, free, all pass
  console.log(" organiser A: consent, background checks, all pass, verification completes");
  const A = await makeOrg("a");
  const idA = saId(); ids.push(idA);
  await A.c.call("PUT", `${A.base}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Thandi Tester", surname: "Tester", idNumber: idA, plansPaid: false });
  await A.c.call("POST", `${A.base}/verification/terms`, { fullName: "Thandi Tester", accept: true });
  const docA = (await upload(A, "id_document")).document;
  ok(docA.status === "submitted", "ID document waits for a check");
  let v = await verif(A);
  ok(item(v, "vn_said")?.status === "not_started" && item(v, "vn_aml_person")?.status === "not_started", "Home Affairs and sanctions checks appear in the checklist, not started", v.requirements.map((i) => i.key + ":" + i.status));
  ok(v.electronic.on && v.electronic.test && !v.electronic.consent.given, "the page knows checks are on, in TEST mode, without consent");
  const evA = await freeEvent(A, "VerifyNow Test Evening");
  const callsBefore = (await mock("/__mock/calls")).calls.length;
  r = await expectError(A.c.call("POST", `${A.base}/events/${evA.id}/submit`, {}));
  ok(r.status === 409 && r.code === "consent_required" && r.body.error.details.canConsent && /POPIA/.test(r.body.error.details.consent.text), "submitting asks for POPIA consent first", r);
  ok(q("SELECT status FROM events WHERE id = ?", [evA.id])[0].status === "draft", "the event stays a draft until consent is given");
  r = await expectError(A.c.call("POST", `${A.base}/verification/consent`, { accept: false, version: v.electronic.consent.version }));
  ok(r.status === 422, "consent needs the box ticked", r.status);
  r = await expectError(A.c.call("POST", `${A.base}/verification/consent`, { accept: true, version: "old-version" }));
  ok(r.status === 409 && r.code === "consent_changed", "an old consent wording is refused", r);
  await A.c.call("POST", `${A.base}/verification/consent`, { accept: true, version: v.electronic.consent.version });
  const consent = q("SELECT * FROM kyc_consents WHERE organiser_id = ?", [A.orgId]);
  ok(consent.length === 1 && consent[0].text_version === v.electronic.consent.version && consent[0].text_sha256 === crypto.createHash("sha256").update(v.electronic.consent.text).digest("hex") && consent[0].created_at,
    "consent is stored once with time, text version and the text's hash", consent);
  await A.c.call("POST", `${A.base}/verification/consent`, { accept: true, version: v.electronic.consent.version });
  ok(q("SELECT count(*) AS n FROM kyc_consents WHERE organiser_id = ?", [A.orgId])[0].n === 1, "asked once: a second consent adds nothing");
  const sub = await A.c.call("POST", `${A.base}/events/${evA.id}/submit`, {});
  ok(sub.status === "pending_approval", "with consent the event is submitted");
  const queued = q("SELECT check_type, status FROM kyc_checks WHERE organiser_id = ? ORDER BY check_type", [A.orgId]);
  ok(queued.length === 2 && queued.every((x) => x.status === "queued"), "the checks are queued, not run in the request", queued);
  ok((await mock("/__mock/calls")).calls.length === callsBefore, "VerifyNow was not called during the request");
  ok(await drain(A.orgId), "the background worker finishes the checks");
  const saidA = latest(A.orgId, "said");
  ok(saidA.status === "passed" && latest(A.orgId, "aml_person").status === "passed", "SA ID and sanctions checks pass", [saidA.status, latest(A.orgId, "aml_person").status]);
  ok(saidA.idempotency_key === "tr-kyc-" + saidA.id && saidA.provider_ref, "each check keeps its idempotency key and VerifyNow's reference", saidA);
  const callA = (await mock("/__mock/calls")).calls.filter((c) => c.idempotencyKey === saidA.idempotency_key);
  ok(callA.length === 1 && callA[0].path === "/verify", "the request carried that Idempotency-Key", callA);
  ok(!saidA.response_json.includes(idA) && saidA.response_json.includes(idA.slice(-4)) && saidA.response_json.includes("•"), "the stored response has the full ID number removed");
  ok(q("SELECT status, reviewed_by FROM verification_documents WHERE id = ?", [docA.id])[0].status === "approved", "the ID document is approved automatically");
  v = await verif(A);
  ok(v.overall === "complete" && q("SELECT completed_at FROM organiser_verification WHERE organiser_id = ?", [A.orgId])[0].completed_at, "verification is marked complete automatically", v.overall);
  ok(!!outbox(DATA, (await A.c.call("GET", "/api/auth/me")).user?.email || "", /verified on TicketRoom|has been checked and approved/), "the organiser is told by email");
  ok(q("SELECT status FROM events WHERE id = ?", [evA.id])[0].status === "pending_approval", "the event still waits for an admin");
  await admin.call("POST", `/api/admin/events/${evA.id}/status`, { action: "publish" });
  ok(q("SELECT status FROM events WHERE id = ?", [evA.id])[0].status === "published", "the admin approves the event as before");

  // ============================================================ B: fail, fix, review, admin decisions
  console.log(" organiser B: fail, details changed, review, admin accept / reject / re-run");
  const B = await makeOrg("b");
  const idBbad = saId("90"); const idB = saId(); ids.push(idBbad, idB);
  await mock("/__mock/config", { surnames: { [idB]: "Ndlovu90" } });
  await B.c.call("PUT", `${B.base}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Sipho Ndlovu90", surname: "Ndlovu90", idNumber: idBbad, plansPaid: false });
  v = await verif(B);
  r = await expectError(B.c.call("POST", `${B.base}/verification/checks/run`, {}));
  ok(r.status === 409 && r.code === "consent_required", "Run checks now also asks for consent first", r);
  await B.c.call("POST", `${B.base}/verification/consent`, { accept: true, version: v.electronic.consent.version });
  const run = await B.c.call("POST", `${B.base}/verification/checks/run`, {});
  ok(run.queued === 2, "Run checks now queues the due checks", run.queued);
  await drain(B.orgId);
  ok(latest(B.orgId, "said").status === "failed", "an ID number Home Affairs cannot confirm fails", latest(B.orgId, "said").status);
  ok(latest(B.orgId, "aml_person").status === "review", "a possible sanctions or PEP match goes to review", latest(B.orgId, "aml_person").status);
  v = await verif(B);
  ok(item(v, "vn_said").status === "rejected" && /Home Affairs could not confirm/.test(item(v, "vn_said").rejectReason), "the organiser sees a plain reason", item(v, "vn_said"));
  ok(item(v, "vn_aml_person").status === "submitted" && /PEP/.test(item(v, "vn_aml_person").detail), "a review shows as being looked at", item(v, "vn_aml_person").detail);
  let queue = await admin.call("GET", "/api/admin/verification");
  const qB = queue.checks.filter((c) => c.organiserId === B.orgId);
  ok(qB.some((c) => c.type === "said" && c.status === "failed" && c.reasons.length) && qB.some((c) => c.type === "aml_person" && c.status === "review" && /PEP/.test(c.reasons.join(" "))), "the admin review queue lists failed and review checks with reasons", qB);
  ok(qB.every((c) => !JSON.stringify(c.response || {}).includes(idBbad)), "the admin sees the response without the full ID number");
  await B.c.call("PUT", `${B.base}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Sipho Ndlovu90", surname: "Ndlovu90", idNumber: idB, plansPaid: false });
  ok(latest(B.orgId, "said").status === "queued", "changed details queue the check again (consent already given)");
  await drain(B.orgId);
  ok(latest(B.orgId, "said").status === "passed", "with a good ID number it passes", latest(B.orgId, "said").status);
  ok(q("SELECT count(*) AS n FROM kyc_checks WHERE organiser_id = ? AND check_type = 'said' AND status = 'superseded'", [B.orgId])[0].n === 1, "the failed run is kept as history");
  const amlB = latest(B.orgId, "aml_person");
  r = await expectError(admin.call("POST", `/api/admin/verification/checks/${amlB.id}/decide`, { accept: false }));
  ok(r.status === 400, "rejecting needs a reason", r.status);
  const re = await admin.call("POST", `/api/admin/verification/checks/${amlB.id}/rerun`, {});
  ok(re.check.status === "queued" && re.check.idempotencyKey !== amlB.idempotency_key, "an admin can re-run a check (with a new request key)", re.check);
  await sleep(2100); // the sandbox refuses the same payload from the same address within 2 seconds
  await drain(B.orgId);
  const amlB2 = latest(B.orgId, "aml_person");
  ok(amlB2.status === "review" && amlB2.id === re.check.id, "the re-run result is stored", amlB2.status);
  await admin.call("POST", `/api/admin/verification/checks/${amlB2.id}/decide`, { accept: true, note: "Different person: date of birth differs." });
  v = await verif(B);
  ok(item(v, "vn_aml_person").status === "approved" && /Accepted by TicketRoom/.test(item(v, "vn_aml_person").detail), "an accepted review counts as passed", item(v, "vn_aml_person"));
  ok(!(await admin.call("GET", "/api/admin/verification")).checks.some((c) => c.id === amlB2.id), "a decided check leaves the review queue");

  // ============================================================ C: paid individual, payouts gated by the bank check
  console.log(" organiser C: review on Home Affairs name, bank check gates payouts, bank error");
  const C = await makeOrg("c");
  const idC = saId(); ids.push(idC);
  await mock("/__mock/config", { surnames: { [idB]: "Ndlovu90", [idC]: "Dlamini" } });
  await C.c.call("PUT", `${C.base}/bank`, { bankName: "FNB", accountHolder: "Lerato Mokoena", accountNumber: "6200000190", branchCode: "250655" });
  await C.c.call("PUT", `${C.base}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Lerato Mokoena", surname: "Mokoena", idNumber: idC, plansPaid: true, bankAccountType: "savings" });
  await C.c.call("POST", `${C.base}/verification/terms`, { fullName: "Lerato Mokoena", accept: true });
  const docC = (await upload(C, "id_document")).document;
  const poa = (await upload(C, "proof_of_address")).document;
  v = await verif(C);
  ok(item(v, "vn_bank")?.needFor.join() === "payouts" && item(v, "bank_confirmation")?.required === false, "the bank check replaces the bank letter and is needed for payouts", [item(v, "vn_bank"), item(v, "bank_confirmation")?.required]);
  await C.c.call("POST", `${C.base}/verification/consent`, { accept: true, version: v.electronic.consent.version });
  await C.c.call("POST", `${C.base}/verification/checks/run`, {});
  await drain(C.orgId);
  const saidC = latest(C.orgId, "said");
  ok(saidC.status === "review" && /surname/.test(saidC.reasons), "a different surname at Home Affairs goes to review", saidC.reasons);
  ok(q("SELECT status FROM verification_documents WHERE id = ?", [docC.id])[0].status === "submitted", "an ID document is not approved on a review");
  const bankC = latest(C.orgId, "bank");
  ok(bankC.status === "review" && /account holder name/.test(bankC.reasons), "a bank account the bank cannot match goes to review", bankC.reasons);
  await admin.call("POST", `/api/admin/verification/documents/${poa.id}/decide`, { approve: true });
  await admin.call("POST", `/api/admin/verification/documents/${docC.id}/decide`, { approve: true });
  await admin.call("POST", `/api/admin/verification/checks/${saidC.id}/decide`, { accept: true, note: "Married name; matches the ID document." });
  r = await expectError(C.c.call("POST", `${C.base}/payouts`, { amountCents: 10000 }));
  ok(r.status === 409 && r.code === "bank_not_verified" && JSON.stringify(r.body.error.details.missing) === JSON.stringify(["Bank account check"]), "payouts are blocked until the bank account is verified", r.body);
  await admin.call("POST", `/api/admin/verification/checks/${bankC.id}/decide`, { accept: true, note: "Checked the bank letter by hand." });
  r = await expectError(C.c.call("POST", `${C.base}/payouts`, { amountCents: 10000 }));
  ok(r.status === 409 && r.code === "insufficient_balance", "once verified, the payout gate opens (only the balance stops it here)", r.body);
  v = await verif(C);
  ok(v.overall === "complete", "C's verification completes once staff accept the reviews", v.overall);
  await C.c.call("PUT", `${C.base}/bank`, { bankName: "FNB", accountHolder: "Lerato Mokoena", accountNumber: "6200000191", branchCode: "250655" });
  ok(latest(C.orgId, "bank").status === "queued", "a new bank account is checked again");
  await drain(C.orgId);
  const bankErr = latest(C.orgId, "bank");
  ok(bankErr.status === "error" && bankErr.attempts === 3 && /tried 3 times/.test(bankErr.reasons), "VerifyNow errors are retried with backoff, then reported plainly", [bankErr.status, bankErr.attempts, bankErr.reasons]);
  r = await expectError(C.c.call("POST", `${C.base}/payouts`, { amountCents: 10000 }));
  ok(r.status === 409 && r.code === "bank_not_verified", "payouts stop again for the unverified new account", r.code);

  // ============================================================ D: company, CIPC and business bank by webhook
  console.log(" organiser D: company, CIPC, business bank by webhook, signature rules, polling");
  const D = await makeOrg("d");
  const idD = saId(); ids.push(idD);
  await mock("/__mock/config", { surnames: { [idB]: "Ndlovu90", [idC]: "Dlamini", [idD]: "Khumalo" }, companies: { "2019/123456/07": "Harbour Test Events (Pty) Ltd" }, deliverWebhooks: true });
  await D.c.call("PUT", `${D.base}/bank`, { bankName: "Capitec Business", accountHolder: "Harbour Test Events", accountNumber: "1234567", branchCode: "450105" });
  await D.c.call("PUT", `${D.base}/verification/profile`, { entityType: "company", nationality: "sa", legalName: "Ayanda Khumalo", surname: "Khumalo", idNumber: idD, registrationNumber: "2019/123456/07",
    companyName: "Harbour Test Events (Pty) Ltd", repIsDirector: true, plansPaid: true, bankAccountType: "current" });
  const cipcDoc = (await upload(D, "cipc_certificate")).document;
  v = await verif(D);
  ok(["vn_said", "vn_aml_person", "vn_aml_company", "vn_cipc", "vn_bank"].every((k) => item(v, k)), "a company gets person, company, CIPC and bank checks", v.requirements.map((i) => i.key));
  await D.c.call("POST", `${D.base}/verification/consent`, { accept: true, version: v.electronic.consent.version });
  await D.c.call("POST", `${D.base}/verification/checks/run`, {});
  await drain(D.orgId);
  ok(["said", "aml_person", "aml_company", "cipc"].every((t) => latest(D.orgId, t).status === "passed"), "person, company and CIPC checks pass", ["said", "aml_person", "aml_company", "cipc"].map((t) => latest(D.orgId, t).status));
  ok(q("SELECT status FROM verification_documents WHERE id = ?", [cipcDoc.id])[0].status === "approved", "the CIPC certificate is approved by the passed CIPC check");
  let bankD = latest(D.orgId, "bank");
  ok(bankD.status === "passed" && bankD.job_id, "the business bank check is completed by VerifyNow's webhook", bankD);
  ok(q("SELECT status FROM webhook_events WHERE provider = 'verifynow' AND status = 'processed'").length >= 1, "the webhook was recorded as processed");
  const bankCall = (await mock("/__mock/calls")).calls.find((c) => c.idempotencyKey === bankD.idempotency_key);
  ok(bankCall && bankCall.path === "/business-bank-account-verification", "the business endpoint was used");
  // Webhook signature rules on a fresh job.
  await mock("/__mock/config", { deliverWebhooks: false });
  await admin.call("POST", `/api/admin/verification/checks/${bankD.id}/rerun`, {});
  // The sandbox answers 429 to the same payload within 2 seconds; the worker waits for Retry-After.
  for (let end = Date.now() + 15000; Date.now() < end && latest(D.orgId, "bank").status !== "waiting"; await sleep(300)) cron();
  bankD = latest(D.orgId, "bank");
  ok(bankD.status === "waiting" && bankD.job_id, "the bank check waits for the bank", bankD.status);
  let d = await mock(`/__mock/deliver/${bankD.job_id}`, { sig: "bad" });
  ok(d.status === 401, "a webhook with a bad signature is refused", d);
  d = await mock(`/__mock/deliver/${bankD.job_id}`, { age: 600 });
  ok(d.status === 401, "a webhook older than five minutes is refused", d);
  ok(latest(D.orgId, "bank").status === "waiting", "refused webhooks change nothing");
  ok(q("SELECT count(*) AS n FROM webhook_events WHERE provider = 'verifynow' AND status = 'rejected'")[0].n >= 2, "refused webhooks are recorded");
  d = await mock(`/__mock/deliver/${bankD.job_id}`, { eventId: "evt_duplicate_test_1" });
  ok(d.status === 200 && latest(D.orgId, "bank").status === "passed", "a correctly signed, fresh webhook completes the check", d);
  d = await mock(`/__mock/deliver/${bankD.job_id}`, { eventId: "evt_duplicate_test_1" });
  ok(d.status === 200 && JSON.parse(d.body).duplicate === true, "the same event id is handled once", d);
  ok(q("SELECT attempts FROM webhook_events WHERE provider = 'verifynow' AND event_id = 'evt_duplicate_test_1'")[0].attempts === 2, "the duplicate is counted, not applied again");
  // Polling when no webhook arrives.
  await admin.call("POST", `/api/admin/verification/checks/${bankD.id}/rerun`, {});
  await drain(D.orgId);
  bankD = latest(D.orgId, "bank");
  const jobCalls = (await mock("/__mock/calls")).calls.filter((c) => c.method === "GET" && c.path.includes(bankD.job_id));
  ok(bankD.status === "passed" && jobCalls.length >= 1, "with no webhook, the worker polls the job and finishes it", [bankD.status, jobCalls.length]);
  // Sandbox scenario header, CIPC failure and name mismatch.
  await setConfig(VN_CONFIG(", 'sandboxScenario' => 'company_registration_mismatch'"));
  await admin.call("POST", `/api/admin/verification/checks/${bankD.id}/rerun`, {});
  await drain(D.orgId);
  bankD = latest(D.orgId, "bank");
  ok(bankD.status === "review" && /registration number/.test(bankD.reasons), "the sandbox scenario header gives a review with a plain reason", bankD.reasons);
  await setConfig(VN_CONFIG());
  await D.c.call("PUT", `${D.base}/verification/profile`, { entityType: "company", nationality: "sa", legalName: "Ayanda Khumalo", surname: "Khumalo", registrationNumber: "2019/123490/90", companyName: "Harbour Test Events (Pty) Ltd", repIsDirector: true, plansPaid: true });
  await drain(D.orgId);
  ok(latest(D.orgId, "cipc").status === "failed" && /CIPC has no company/.test(latest(D.orgId, "cipc").reasons), "an unknown registration number fails the CIPC check", latest(D.orgId, "cipc").reasons);
  await D.c.call("PUT", `${D.base}/verification/profile`, { entityType: "company", nationality: "sa", legalName: "Ayanda Khumalo", surname: "Khumalo", registrationNumber: "2019/123456/08", companyName: "Harbour Test Events (Pty) Ltd", repIsDirector: true, plansPaid: true });
  await drain(D.orgId);
  ok(latest(D.orgId, "cipc").status === "review" && /differs/.test(latest(D.orgId, "cipc").reasons), "a different registered name goes to review", latest(D.orgId, "cipc").reasons);

  // ============================================================ production: idempotency, timeout, 429, no credits
  console.log(" production mode: idempotent retries, timeout, Retry-After, no credits");
  await saveVn({ mode: "production" });
  const before = (await mock("/__mock/calls")).charged;
  await mock("/__mock/config", { chargeThenFail: [{ path: "/verify" }] });
  let rr = (await admin.call("POST", `/api/admin/verification/checks/${latest(A.orgId, "said").id}/rerun`, {})).check;
  ok(rr.mode === "production", "re-runs use the current mode");
  await drain(A.orgId);
  let row = q("SELECT * FROM kyc_checks WHERE id = ?", [rr.id])[0];
  let calls = (await mock("/__mock/calls")).calls.filter((c) => c.idempotencyKey === rr.idempotencyKey);
  ok(row.status === "passed" && calls.length === 2 && calls[0].status === 503 && calls[1].replayed, "a lost answer is retried with the same Idempotency-Key and replayed", calls);
  ok((await mock("/__mock/calls")).charged - before === 1, "the retry is not charged twice");
  await mock("/__mock/config", { slowNext: [{ path: "/aml-screening", ms: 4500 }] });
  rr = (await admin.call("POST", `/api/admin/verification/checks/${latest(A.orgId, "aml_person").id}/rerun`, {})).check;
  await drain(A.orgId);
  row = q("SELECT * FROM kyc_checks WHERE id = ?", [rr.id])[0];
  ok(row.status === "passed" && row.attempts >= 2, "a timeout is retried and then succeeds", [row.status, row.attempts]);
  await mock("/__mock/config", { force429: [{ path: "/aml-screening", retryAfter: 2 }] });
  rr = (await admin.call("POST", `/api/admin/verification/checks/${row.id}/rerun`, {})).check;
  cron();
  row = q("SELECT * FROM kyc_checks WHERE id = ?", [rr.id])[0];
  const wait = (Date.parse(row.next_attempt_at) - Date.now()) / 1000;
  ok(row.status === "queued" && row.http_status === 429 && wait > 0.5 && wait <= 2.5, "429 waits for Retry-After", [row.status, row.http_status, wait]);
  const n429 = (await mock("/__mock/calls")).calls.filter((c) => c.idempotencyKey === rr.idempotencyKey).length;
  cron();
  ok((await mock("/__mock/calls")).calls.filter((c) => c.idempotencyKey === rr.idempotencyKey).length === n429, "no call is made before Retry-After");
  await sleep(2200);
  await drain(A.orgId);
  ok(q("SELECT status FROM kyc_checks WHERE id = ?", [rr.id])[0].status === "passed", "after Retry-After the check passes");
  ok((await mock("/__mock/calls")).calls.filter((c) => c.method === "POST" && c.status && c.path !== "/__mock/config").every((c) => !c.idempotencyKey || c.idempotencyKey.length >= 8), "every request key is 8 characters or more");
  await mock("/__mock/config", { credits: 0 });
  rr = (await admin.call("POST", `/api/admin/verification/checks/${latest(A.orgId, "aml_person").id}/rerun`, {})).check;
  await drain(A.orgId);
  row = q("SELECT * FROM kyc_checks WHERE id = ?", [rr.id])[0];
  ok(row.status === "error" && /no credits left/.test(row.reasons) && row.attempts === 1, "no credits (402) is an error with a plain reason, not retried", [row.status, row.reasons, row.attempts]);
  card = (await admin.call("GET", "/api/admin/integrations")).integrations.find((i) => i.key === "verifynow");
  ok(/no credits left/.test(card.problem || ""), "the Integrations card shows the problem", card.problem);
  queue = await admin.call("GET", "/api/admin/verification");
  ok(queue.checks.some((c) => c.id === rr.id && c.status === "error"), "the error waits in the admin queue");
  await mock("/__mock/config", { credits: 20 });
  const rr2 = (await admin.call("POST", `/api/admin/verification/checks/${rr.id}/rerun`, {})).check;
  await drain(A.orgId);
  ok(q("SELECT status FROM kyc_checks WHERE id = ?", [rr2.id])[0].status === "passed", "after topping up, a re-run passes");
  h = await admin.call("POST", "/api/admin/integrations/verifynow/health");
  ok(h.ok && h.credits === (await mock("/__mock/calls")).credits && !(await admin.call("GET", "/api/admin/integrations")).integrations.find((i) => i.key === "verifynow").problem, "Test connection shows the new balance and clears the problem", h);
  ok((await mock("/__mock/calls")).calls.filter((c) => c.method === "POST" && c.status === 400 && c.path !== "/__mock/config").length === 0, "no request was refused for a missing Idempotency-Key");

  // ============================================================ secrets stay out of logs
  console.log(" nothing secret in logs or the database");
  const log = fs.readFileSync(path.join(DIR, "php.log"), "utf8");
  const dump = execFileSync("php", ["-r", `$db = new PDO('sqlite:' . $argv[1] . '/ticketroom.sqlite'); $out = '';
foreach ($db->query("SELECT name FROM sqlite_master WHERE type = 'table'")->fetchAll(PDO::FETCH_COLUMN) as $t) { foreach ($db->query("SELECT * FROM \\"$t\\"")->fetchAll(PDO::FETCH_ASSOC) as $r) $out .= json_encode($r, JSON_UNESCAPED_UNICODE) . "\\n"; }
echo $out;`, DATA], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  ok(!log.includes(KEY) && !dump.includes(KEY), "the API key is in neither the server log nor the database");
  ok(ids.every((id) => !log.includes(id) && !dump.includes(id)), "full ID numbers are in neither the server log nor the database", ids.filter((id) => log.includes(id) || dump.includes(id)));
  ok(!/6200000190|6200000191/.test(dump.replace(/"to_address"[^,]*,/g, "")), "full bank account numbers are not stored in check results");

  // ============================================================ pages render
  console.log(" pages");
  await saveVn({ mode: "sandbox" });
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ executablePath: process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = async (client, url, check) => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await ctx.addCookies(Object.entries(client.cookies).map(([name, value]) => ({ name, value, url: BASE })));
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await p.goto(BASE + url, { waitUntil: "networkidle" });
    await p.waitForTimeout(800);
    const out = await check(p);
    await ctx.close();
    return [out, errors];
  };
  let [txt, errs] = await page(admin, "/admin#/integrations", (p) => p.locator("[data-integ=verifynow]").innerText());
  ok(/VerifyNow/.test(txt) && /TEST/.test(txt) && /Test connection/.test(txt) && /Credits/.test(txt) && !txt.includes(KEY), "Admin > Integrations shows the VerifyNow card, labelled TEST", txt.slice(0, 300));
  ok(!errs.length, "no console errors on Integrations", errs);
  [txt, errs] = await page(admin, `/admin#/organisers/${B.orgId}`, (p) => p.locator("main").innerText());
  ok(/Electronic checks \(VerifyNow\)/.test(txt) && /Accepted by TicketRoom|accepted by staff/i.test(txt) && /Run again/.test(txt), "the admin organiser page shows each check with its reasons and actions", txt.slice(0, 200));
  ok(!errs.length, "no console errors on the organiser review page", errs);
  [txt, errs] = await page(admin, "/admin#/verification", (p) => p.locator("main").innerText());
  ok(/Electronic checks that need a look/.test(txt), "the admin verification queue lists checks that need a look");
  [txt, errs] = await page(C.c, "/organisers#/verification", (p) => p.locator("main").innerText());
  ok(/Electronic checks/.test(txt) && /Bank account check/.test(txt) && /Payout account type/.test(txt), "the organiser's Verification page shows the checks and the extra details", txt.slice(0, 200));
  ok(!errs.length, "no console errors on the organiser Verification page", errs);
  const E = await makeOrg("e");
  await E.c.call("PUT", `${E.base}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Naledi Tester", surname: "Tester", idNumber: saId(), plansPaid: false });
  [txt, errs] = await page(E.c, "/organisers#/verification", async (p) => {
    await p.locator("[data-vn-run]").click();
    await p.locator("#vnc").waitFor();
    const t = await p.locator("dialog[open]").innerText();
    await p.locator("#vnc input[name=accept]").check();
    await p.locator("#vnc button.btn-primary").click();
    await p.waitForTimeout(1500);
    return t;
  });
  ok(/POPIA/.test(txt) && /Home Affairs/.test(txt) && q("SELECT count(*) AS n FROM kyc_consents WHERE organiser_id = ?", [E.orgId])[0].n === 1 && q("SELECT count(*) AS n FROM kyc_checks WHERE organiser_id = ?", [E.orgId])[0].n >= 1,
    "the organiser gives consent in the dialog and the checks start", txt.slice(0, 200));
  ok(!errs.length, "no console errors in the consent dialog", errs);
  await browser.close();
  await drain(null);
})().catch((e) => { failures++; console.log("  FAIL (crash) " + (e.stack || e)); }).finally(async () => {
  // Leave the instance as other suites expect it: VerifyNow off, test config removed.
  try { if (admin) await saveVn({ enabled: "off", mode: "sandbox" }); } catch (e) { console.log("  (cleanup) " + e.message); }
  try { writeConfig(null); } catch { /* */ }
  if (mockProc) mockProc.kill();
  console.log(failures ? `verifynow: ${failures} failed` : "verifynow: all passed");
  process.exit(failures ? 1 : 0);
});
