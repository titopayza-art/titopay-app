// Organiser verification (FICA / KYC): rules per kind of organiser, paid
// tickets and event risk; private documents; review in the admin portal;
// enforcement on the server; emails; the identity-check sandbox and your own
// provider; POPIA keeping rules; the schema upgrade.
// Run after php-walkthrough.js on the same instance:
//   node tests-ui/php-verification.js http://127.0.0.1:8600 /path/to/public_html
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const { execFileSync, spawn } = require("child_process");
const { chromium } = require("playwright");
const { saId, client, TINY_PNG, TINY_PDF } = require("./kyc-helper");

const BASE = process.argv[2] || "http://127.0.0.1:8600";
const ROOT = process.argv[3] || "/srv/trtest/public_html";
const ADMIN = { email: "hello@ticketroom.co.za", password: "Admin-pass-#2026", portal: "admin" };
const NALEDI = { email: "naledi@example.co.za", password: "organiser-pass-1", portal: "organiser" };
const MOCK_PORT = process.env.TR_MOCK_PORT4 || "8704";
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const problems = [];
const step = (m) => console.log(`  ok  ${m}`);
const dataDir = [path.join(path.dirname(ROOT), "ticketroom-data"), path.join(ROOT, "data")].find((d) => fs.existsSync(path.join(d, "ticketroom.sqlite")));
const sql = (q, ...args) => JSON.parse(execFileSync("php", ["-r", `$d=new PDO('sqlite:${dataDir}/ticketroom.sqlite'); $s=$d->prepare($argv[1]); $s->execute(array_slice($argv, 2)); echo json_encode($s->fetchAll(PDO::FETCH_ASSOC));`, q, ...args]).toString());
const php = (code) => execFileSync("php", ["-r", `require '${ROOT}/api/bootstrap.php'; tr_load(); ${code}`]).toString();
const mails = (to) => sql("SELECT subject, body FROM message_outbox WHERE to_address = ? ORDER BY created_at DESC, rowid DESC", to);
const anonGet = (u) => fetch(`${BASE}${u}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
// A valid SA ID number whose last digit is d (for the provider stand-in).
const idEnding = (d) => { for (let s = 6000; s < 9999; s++) { const id = saId("850615", String(s)); if (id.endsWith(d)) return id; } throw new Error("none"); };

async function page(browser, creds, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`[pageerror] ${p.url()} ${e.message}`));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(400|401|403|404|409|410|413|415|422)/.test(m.text())) problems.push(`[console] ${p.url()} ${m.text()}`); });
  if (creds) assert.equal((await p.request.post(`${BASE}/api/auth/login`, { data: creds })).status(), 200, `sign in ${creds.email}`);
  return p;
}
// A new organiser account, confirmed by its email link, approved by TicketRoom.
async function newOrganiser(browser, a, email, organisation, fullName) {
  const p = await page(browser);
  const r = await p.request.post(`${BASE}/api/organiser/signup`, { data: { fullName, email, password: "organiser-pass-7", organisation, acceptTerms: true } });
  assert.equal(r.status(), 201, `sign-up ${email}`);
  const token = mails(email)[0].body.match(/#\/verify\/(\S+)/)[1];
  assert.equal((await p.request.post(`${BASE}/api/auth/verify-email`, { data: { token } })).status(), 200);
  const o = client(p.request, BASE);
  const orgId = (await o.get("/api/auth/me")).body.user.organisers[0].id;
  assert.equal((await a.post(`/api/admin/organisers/${orgId}/status`, { status: "approved" })).status, 200);
  return { p, o, orgId, email };
}
const reqs = async (o, orgId) => (await o.get(`/api/organiser/${orgId}/verification`)).body.verification;
const keys = (v) => v.requirements.map((i) => i.key).sort().join(",");
const up = (o, orgId, key, buf = TINY_PDF, type = "application/pdf", ev = "") => o.upload(`/api/organiser/${orgId}/verification/documents?requirement=${key}${ev ? `&eventId=${ev}` : ""}`, buf, type);
const approveAll = async (a, orgId) => { for (const d of (await a.get("/api/admin/verification")).body.documents.filter((x) => x.organiser_id === orgId)) assert.equal((await a.post(`/api/admin/verification/documents/${d.id}/decide`, { approve: true })).status, 200); };
const newEvent = async (o, orgId, extra = {}, price = 15000) => {
  const ev = (await o.post(`/api/organiser/${orgId}/events`, { title: `Event ${Math.random().toString(36).slice(2, 7)}`, category: "music", venueName: "Hall", city: "Pretoria",
    startsAt: new Date(Date.now() + 9 * 86400e3).toISOString(), endsAt: new Date(Date.now() + 9 * 86400e3 + 4 * 3600e3).toISOString(), capacity: 300, ...extra })).body.event;
  assert.ok(ev, "event created");
  assert.equal((await o.post(`/api/organiser/${orgId}/events/${ev.id}/ticket-types`, { name: "General", priceCents: price, quantityTotal: Math.min(ev.capacity, 100), perOrderLimit: 6 })).status, 201);
  return ev;
};

(async () => {
  sql("DELETE FROM rate_limits");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  const cfgFile = path.join(dataDir, "config.php");
  const original = fs.readFileSync(cfgFile, "utf8");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "tr-kyc-"));
  const mock = spawn("php", ["-S", `127.0.0.1:${MOCK_PORT}`, path.join(__dirname, "mocks", "providers.php")], { env: { ...process.env, TARGET: BASE, STATE: state }, stdio: "ignore" });
  try {
    const adm = await page(browser, ADMIN);
    const a = client(adm.request, BASE);

    // 1. SA ID numbers are checked here: check digit, date of birth, age, citizenship.
    const K = await newOrganiser(browser, a, "kgosi@example.co.za", "Kgosi Live (Pty) Ltd", "Kgosi Molefe");
    const prof = (x) => K.o.put(`/api/organiser/${K.orgId}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Kgosi Molefe", ...x });
    const good = saId("880412", "5123");
    const badLuhn = good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
    assert.match((await prof({ idNumber: badLuhn })).body.error.details.idNumber, /not valid/, "wrong check digit refused");
    assert.match((await prof({ idNumber: saId("150101", "5123") })).body.error.details.idNumber, /18 or older/, "under 18 refused");
    assert.match((await prof({ idNumber: saId("881301", "5123") })).body.error.details.idNumber, /date of birth/, "month 13 refused");
    assert.match((await prof({ idNumber: saId("880412", "5123", "2") })).body.error.details.idNumber, /11th digit/, "citizenship digit must be 0 or 1");
    assert.match((await prof({ idNumber: "12345" })).body.error.details.idNumber, /13 digits/);
    assert.equal((await prof({ idNumber: good })).status, 200);
    const stored = sql("SELECT * FROM organiser_verification WHERE organiser_id = ?", K.orgId)[0];
    assert.equal(stored.id_dob, "1988-04-12");
    assert.ok(!JSON.stringify(stored).includes(good) && !fs.readFileSync(path.join(dataDir, "ticketroom.sqlite")).includes(good), "ID number stored encrypted");
    assert.ok(!JSON.stringify((await K.o.get(`/api/organiser/${K.orgId}/verification`)).body).includes(good), "and never sent back in full");
    step("SA ID numbers: check digit, real date of birth, 18+, citizenship digit; stored encrypted, shown masked");

    // 2. Only what the rules require: by kind of organiser and paid tickets.
    let v = await reqs(K.o, K.orgId);
    assert.equal(keys(v), "email,id_document,phone,terms", "individual, free events: ID, terms, email (phone shown, not required)");
    assert.equal(v.requirements.find((i) => i.key === "phone").status, "not_verified");
    assert.equal(v.requirements.find((i) => i.key === "phone").required, false, "phone does not hold anything up");
    assert.equal(v.requirements.find((i) => i.key === "email").status, "approved");
    assert.ok(v.requirements.every((i) => i.reason && i.reason.length > 10), "every item says why");
    await prof({ plansPaid: true });
    assert.equal(keys(await reqs(K.o, K.orgId)), "bank_confirmation,email,id_document,phone,proof_of_address,terms", "paid: bank letter and proof of address, for payouts");
    const co = { entityType: "company", nationality: "sa", legalName: "Kgosi Molefe", registrationNumber: "2019/123456/07", repIsDirector: false, plansPaid: true };
    assert.match((await K.o.put(`/api/organiser/${K.orgId}/verification/profile`, { ...co, registrationNumber: "12345" })).body.error.details.registrationNumber, /CIPC/);
    assert.equal((await K.o.put(`/api/organiser/${K.orgId}/verification/profile`, co)).status, 200);
    v = await reqs(K.o, K.orgId);
    assert.equal(keys(v), "authorisation_letter,bank_confirmation,business_address,cipc_certificate,email,phone,rep_id,terms", "company, rep not a director");
    assert.equal(v.requirements.find((i) => i.key === "bank_confirmation").label, "Business bank confirmation letter");
    await K.o.put(`/api/organiser/${K.orgId}/verification/profile`, { ...co, entityType: "npo", registrationNumber: "123-456 NPO" });
    assert.equal(keys(await reqs(K.o, K.orgId)), "bank_confirmation,constitution,email,npo_certificate,phone,rep_id,resolution,terms", "NPO");
    await K.o.put(`/api/organiser/${K.orgId}/verification/profile`, { ...co, repIsDirector: true });
    assert.ok(!keys(await reqs(K.o, K.orgId)).includes("authorisation_letter"), "a director needs no letter of authorisation");
    step("requirements follow the rules: individual / company / NPO, paid or free; phone shown as not verified and never blocks");

    // 3. Uploads: PDF, JPG or PNG only, by their first bytes; only what is needed.
    assert.equal((await up(K.o, K.orgId, "cipc_certificate", Buffer.from("just text, not a pdf"))).status, 415, "magic bytes checked");
    assert.equal((await up(K.o, K.orgId, "cipc_certificate", TINY_PDF, "text/plain")).status, 415, "type checked");
    assert.equal((await up(K.o, K.orgId, "liquor_licence")).status, 400, "documents the rules don't ask for are refused");
    assert.equal((await up(K.o, K.orgId, "bank_confirmation")).body.error.code, "no_bank_details", "bank letter needs bank details first");
    const big = Buffer.concat([TINY_PDF, Buffer.alloc(11 * 1024 * 1024)]);
    assert.equal((await up(K.o, K.orgId, "cipc_certificate", big)).status, 413, "over the size limit");
    const cipc = await up(K.o, K.orgId, "cipc_certificate");
    assert.equal(cipc.status, 201);
    assert.equal(cipc.body.document.status, "submitted");
    const docRow = sql("SELECT * FROM verification_documents WHERE id = ?", cipc.body.document.id)[0];
    assert.match(docRow.file_name, /^[0-9a-f]{40}$/, "random file name");
    const onDisk = path.join(dataDir, "private", docRow.file_name);
    assert.ok(fs.existsSync(onDisk), "stored in the private data folder");
    assert.ok(!fs.readFileSync(onDisk).includes(TINY_PDF.subarray(0, 8)), "encrypted at rest");
    // Never reachable over the web, wherever the data folder sits.
    assert.notEqual((await fetch(`${BASE}/data/private/${docRow.file_name}`)).status, 200);
    assert.notEqual((await fetch(`${BASE}/data/ticketroom.sqlite`)).status, 200);
    assert.notEqual((await fetch(`${BASE}/ticketroom-data/private/${docRow.file_name}`)).status, 200);
    // Who may open it: the owners and TicketRoom staff; every view logged.
    const fileUrl = `/api/verification/documents/${docRow.id}/file`;
    assert.equal((await anonGet(fileUrl)).status, 401);
    const nal = await page(browser, NALEDI);
    assert.equal((await nal.request.get(`${BASE}${fileUrl}`)).status(), 404, "another organiser can't");
    const own = await K.p.request.get(`${BASE}${fileUrl}`);
    assert.equal(own.status(), 200);
    assert.ok((await own.body()).equals(TINY_PDF), "owner gets the original back");
    assert.match(own.headers()["content-disposition"], /attachment/);
    assert.equal((await adm.request.get(`${BASE}${fileUrl}`)).status(), 200, "staff can");
    assert.equal(Number(sql("SELECT count(*) AS n FROM audit_log WHERE action = 'verification.document_viewed' AND entity_id = ?", docRow.id)[0].n), 2, "both views audited");
    v = await reqs(K.o, K.orgId);
    assert.ok(v.accessLog.some((x) => /TicketRoom admin/.test(x.who)), "the organiser sees that staff opened it");
    assert.ok(v.held.some((h) => h.id === docRow.id), "and what is held");
    step("documents: PDF/JPG/PNG by magic bytes, 10 MB cap, random names, encrypted outside public_html; owners and staff only; every view audited and shown to the organiser");

    // 4. The organiser portal: checklist with reasons, sign terms, upload.
    const kp = K.p;
    await kp.goto(`${BASE}/organisers#/verification`);
    await kp.getByRole("heading", { name: "Verification" }).waitFor();
    await kp.getByText("Confirms the company is registered and who its directors are.").waitFor();
    await kp.getByText(/Payouts/).first().waitFor();
    await kp.getByText(/Phone checks are not available yet/).first().waitFor();
    await kp.getByRole("button", { name: "Read and sign" }).click();
    const td = kp.locator("dialog[open]");
    await td.getByLabel("Your full name").fill("Kgosi Molefe");
    await td.getByRole("checkbox").check();
    await td.getByRole("button", { name: "Sign the terms" }).click();
    await kp.getByText("Terms signed.").waitFor();
    await kp.locator('[data-req="rep_id"] input[type=file]').setInputFiles({ name: "my-id.png", mimeType: "image/png", buffer: TINY_PNG });
    await kp.getByText("Uploaded. TicketRoom will check it.").waitFor();
    await kp.locator('[data-req="rep_id"] .badge', { hasText: "submitted" }).waitFor();
    step("organiser portal: one checklist with a reason per item, sign the terms, upload, instant status");

    // 5. Enforcement: a paid event can be submitted once documents are in, but
    // goes on sale only after they are approved.
    const ev = await newEvent(K.o, K.orgId);
    // nothing missing now except approval
    let sub = await K.o.post(`/api/organiser/${K.orgId}/events/${ev.id}/submit`);
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const pub = await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" });
    assert.equal(pub.body.error.code, "verification_required", "not on sale before approval");
    assert.ok(pub.body.error.details.missing.includes("CIPC registration certificate"));
    // An event submitted with an item missing is refused, naming it.
    await K.o.put(`/api/organiser/${K.orgId}/verification/profile`, { ...co, repIsDirector: false });
    const ev2 = await newEvent(K.o, K.orgId);
    sub = await K.o.post(`/api/organiser/${K.orgId}/events/${ev2.id}/submit`);
    assert.equal(sub.body.error.code, "verification_required");
    assert.match(sub.body.error.message, /Letter of authorisation/);
    await K.o.put(`/api/organiser/${K.orgId}/verification/profile`, { ...co, repIsDirector: true });
    step("paid events: submit needs ID, company papers and signed terms uploaded; going on sale needs them approved");

    // 6. Admin review: reject with a reason (emailed), the organiser re-uploads, approve.
    await adm.goto(`${BASE}/admin#/verification`);
    const row = adm.locator("tr", { hasText: "Kgosi Live" }).filter({ hasText: "CIPC registration certificate" });
    await row.getByRole("button", { name: "Reject" }).click();
    await adm.locator("dialog[open]").getByLabel("What needs fixing").fill("The certificate is cut off at the bottom. Please upload the whole page.");
    await adm.locator("dialog[open]").getByRole("button", { name: "Confirm" }).click();
    await adm.getByText("Sent back to the organiser.").waitFor();
    const rej = mails(K.email).find((m) => /upload your CIPC registration certificate again/.test(m.subject));
    assert.ok(rej && rej.body.includes("cut off at the bottom"), "rejection email gives the reason");
    v = await reqs(K.o, K.orgId);
    const c1 = v.requirements.find((i) => i.key === "cipc_certificate");
    assert.equal(c1.status, "rejected"); assert.match(c1.rejectReason, /cut off/);
    assert.equal((await up(K.o, K.orgId, "cipc_certificate")).status, 201);
    await adm.reload();
    await adm.locator("tr", { hasText: "Kgosi Live" }).filter({ hasText: "CIPC registration certificate" }).getByRole("button", { name: "Approve" }).click();
    await adm.getByText("Approved.").waitFor();
    assert.ok(mails(K.email).some((m) => m.subject === "Approved: CIPC registration certificate"), "approval email");
    await approveAll(a, K.orgId);
    assert.equal((await a.post(`/api/admin/events/${ev.id}/status`, { action: "publish" })).status, 200, "on sale once approved");
    const done = mails(K.email).filter((m) => /is verified on TicketRoom/.test(m.subject));
    assert.equal(done.length, 0, "not complete yet: payouts still need the bank letter and address (paid)");
    // Organiser detail in the admin portal; revealing the ID number is logged and shown to the organiser.
    await adm.goto(`${BASE}/admin#/organisers/${K.orgId}`);
    await adm.getByRole("heading", { name: "Kgosi Live (Pty) Ltd" }).waitFor();
    await adm.getByRole("heading", { name: "Checklist" }).waitFor();
    assert.equal((await a.post(`/api/admin/organisers/${K.orgId}/verification/reveal-id`)).body.idNumber, good);
    assert.ok((await reqs(K.o, K.orgId)).accessLog.some((x) => /ID number/.test(x.action)));
    step("admin review queue: reject with a reason (emailed), re-upload, approve (emailed); organiser detail shows verification; ID reveal logged");

    // 7. Payouts wait for a verified bank account.
    assert.equal((await K.o.post(`/api/organiser/${K.orgId}/payouts`, { amountCents: 10000 })).body.error.code, "no_bank_details");
    await K.o.put(`/api/organiser/${K.orgId}/bank`, { bankName: "Nedbank", accountHolder: "Kgosi Live (Pty) Ltd", accountNumber: "1234567890", branchCode: "198765" });
    assert.equal((await K.o.post(`/api/organiser/${K.orgId}/payouts`, { amountCents: 10000 })).body.error.code, "bank_not_verified");
    await up(K.o, K.orgId, "bank_confirmation"); await up(K.o, K.orgId, "business_address");
    assert.equal((await K.o.post(`/api/organiser/${K.orgId}/payouts`, { amountCents: 10000 })).body.error.code, "bank_not_verified", "uploaded is not enough: it must be approved");
    await approveAll(a, K.orgId);
    assert.equal((await K.o.post(`/api/organiser/${K.orgId}/payouts`, { amountCents: 10000 })).body.error.code, "insufficient_balance", "verified: the only thing left is the balance");
    assert.ok(mails(K.email).some((m) => /Kgosi Live \(Pty\) Ltd is verified on TicketRoom/.test(m.subject)), "verification complete email");
    await K.o.put(`/api/organiser/${K.orgId}/bank`, { bankName: "Nedbank", accountHolder: "Kgosi Live (Pty) Ltd", accountNumber: "9999999999", branchCode: "198765" });
    assert.equal((await K.o.post(`/api/organiser/${K.orgId}/payouts`, { amountCents: 10000 })).body.error.code, "bank_not_verified", "a new account needs a new letter");
    await kp.goto(`${BASE}/organisers#/finance`);
    await kp.getByText(/Payouts are blocked until your bank account is verified/).waitFor();
    step("payouts: blocked until bank details and the bank letter are approved; changing the account blocks them again; verification-complete email");

    // 8. Event risk: permits only where the event needs them; high-risk events need more.
    const big2 = await newEvent(K.o, K.orgId, { capacity: 6000 });
    let ek = (await reqs(K.o, K.orgId)).events.find((e) => e.id === big2.id);
    assert.equal(ek.risk.level, "high");
    assert.deepEqual(ek.requirements.filter((r) => r.required).map((r) => r.key).sort(), ["event_permit", "extra_verification", "financial_info", "liability_insurance", "previous_events", "safety_plan", "supplier_agreements", "ticket_authority", "venue_agreement"]);
    sub = await K.o.post(`/api/organiser/${K.orgId}/events/${big2.id}/submit`);
    assert.equal(sub.body.error.code, "verification_required");
    assert.ok(sub.body.error.details.eventMissing.includes("Event permit or municipal approval"));
    const small = await newEvent(K.o, K.orgId, {}, 0);
    ek = (await reqs(K.o, K.orgId)).events.find((e) => e.id === small.id);
    assert.deepEqual(ek.requirements.map((r) => r.key), [], "a small free event needs nothing extra");
    assert.equal((await K.o.put(`/api/organiser/${K.orgId}/events/${small.id}/risk`, { sellsAlcohol: true, publicSpace: false, thirdParty: true })).status, 200);
    ek = (await reqs(K.o, K.orgId)).events.find((e) => e.id === small.id);
    assert.deepEqual(ek.requirements.map((r) => r.key).sort(), ["artist_authorisation", "liquor_licence"], "alcohol and someone else's show");
    // Staff can waive or force the extra checks.
    assert.equal((await a.post(`/api/admin/events/${big2.id}/risk`, { riskOverride: "normal" })).status, 200);
    ek = (await reqs(K.o, K.orgId)).events.find((e) => e.id === big2.id);
    assert.equal(ek.risk.level, "normal");
    assert.deepEqual(ek.requirements.filter((r) => r.required).map((r) => r.key).sort(), ["event_permit", "liability_insurance", "safety_plan"], "2 000+ people still need the legal permits");
    assert.equal(ek.requirements.find((r) => r.key === "venue_agreement").recommended, true, "paid: venue agreement recommended, never blocking");
    await a.post(`/api/admin/events/${big2.id}/risk`, { riskOverride: "high" });
    // The event tab in the portal: upload every event document, then it can go.
    await kp.goto(`${BASE}/organisers#/events/${big2.id}/checks`);
    await kp.getByRole("heading", { name: "Documents for this event" }).waitFor();
    await kp.getByText("high risk").first().waitFor();
    for (const r of (await reqs(K.o, K.orgId)).events.find((e) => e.id === big2.id).requirements) assert.equal((await up(K.o, K.orgId, r.key, TINY_PDF, "application/pdf", big2.id)).status, 201);
    assert.equal((await K.o.post(`/api/organiser/${K.orgId}/events/${big2.id}/submit`)).status, 200, "all uploaded: can be submitted");
    assert.equal((await a.post(`/api/admin/events/${big2.id}/status`, { action: "publish" })).body.error.code, "verification_required", "not approved yet");
    await approveAll(a, K.orgId);
    assert.equal((await a.post(`/api/admin/events/${big2.id}/status`, { action: "publish" })).status, 200, "high-risk event live once its documents are approved");
    step("event risk: permits for alcohol, 2 000+ people, public spaces and other people's shows; high-risk events need their extra documents before going live; staff override");

    // 9. Integrations: identity sandbox (simulated, auto-decides by a test rule).
    const saveKyc = (values) => a.put("/api/admin/integrations/identity", { currentPassword: ADMIN.password, values });
    assert.equal((await saveKyc({ provider: "sandbox" })).status, 200);
    await adm.goto(`${BASE}/admin#/integrations`);
    const card = adm.locator('[data-integ="identity"]');
    await card.getByText(/Sandbox \(simulated\)/).first().waitFor();
    const S = await newOrganiser(browser, a, "sandbox.org@example.co.za", "Sandbox Sounds", "Sam Sandbox");
    const sp = (id) => S.o.put(`/api/organiser/${S.orgId}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Sam Sandbox", idNumber: id });
    await sp(saId("900101", "0000"));
    let r = await up(S.o, S.orgId, "id_document", TINY_PNG, "image/png");
    assert.equal(r.body.document.status, "rejected", "sandbox: sequence 0000 is declined");
    assert.equal(r.body.document.provider.simulated, true);
    await sp(saId("900101", "0001"));
    r = await up(S.o, S.orgId, "id_document", TINY_PNG, "image/png");
    assert.equal(r.body.document.status, "submitted"); assert.equal(r.body.document.provider.outcome, "refer", "0001 goes to staff");
    await sp(saId("900101", "5555"));
    r = await up(S.o, S.orgId, "id_document", TINY_PNG, "image/png");
    assert.equal(r.body.document.status, "approved", "anything else is verified");
    assert.equal((await a.post("/api/admin/integrations/identity/test", { number: saId("900101", "0000") })).body.outcome, "declined");
    assert.match((await a.post("/api/admin/integrations/identity/test", { number: badLuhn })).body.detail, /not valid/);
    await S.p.goto(`${BASE}/organisers#/verification`);
    await S.p.getByText(/identity checks are simulated by the TicketRoom sandbox/).waitFor();
    step("identity sandbox: clearly labelled simulated; 0000 declined, 0001 referred to staff, others verified; outcome shown");

    // 10. Your own provider: https and public addresses only; secrets write-only.
    assert.equal((await saveKyc({ provider: "http", httpUrl: `${MOCK}/kyc/check`, httpAuth: "Bearer kyc-test-key" })).status, 200);
    assert.equal((await a.post("/api/admin/integrations/identity/health")).body.ok, false, "plain http on this machine is refused");
    const ig = JSON.stringify((await a.get("/api/admin/integrations")).body);
    assert.ok(!ig.includes("kyc-test-key") && !ig.includes("/kyc/check"), "address and key never sent back");
    fs.writeFileSync(cfgFile, original.replace("return [", "return [\n    'kyc' => ['allowPrivateHosts' => true],"));
    await new Promise((res) => setTimeout(res, 2500));
    assert.equal((await a.post("/api/admin/integrations/identity/test", { number: idEnding("9") })).body.outcome, "declined");
    assert.equal((await a.post("/api/admin/integrations/identity/test", { number: idEnding("3") })).body.outcome, "verified");
    const P = await newOrganiser(browser, a, "provider.org@example.co.za", "Provider Productions", "Pat Provider");
    await P.o.put(`/api/organiser/${P.orgId}/verification/profile`, { entityType: "individual", nationality: "sa", legalName: "Pat Provider", idNumber: idEnding("3") });
    r = await up(P.o, P.orgId, "id_document", TINY_PNG, "image/png");
    assert.equal(r.body.document.status, "approved", "your provider verified it");
    const log = fs.readFileSync(path.join(state, "kyc.log"), "utf8");
    assert.match(log, /Bearer kyc-test-key/); assert.match(log, /Pat Provider/);
    assert.equal((await saveKyc({ provider: "manual" })).status, 200);
    step("your own identity provider: https/public only, secrets write-only, called with the ID number, verified documents approved");

    // 11. POPIA: keeping rules, deletion, and the schema upgrade.
    assert.equal((await a.put("/api/admin/settings/verification", { retentionYears: 4, discardRejectedDays: 90 })).status, 422, "at least 5 years (FICA)");
    assert.equal((await a.put("/api/admin/settings/verification", { retentionYears: 5, discardRejectedDays: 30 })).status, 200);
    // The sandbox's declined ID (later replaced by a new upload), 40 days on.
    const rejected = sql("SELECT * FROM verification_documents WHERE organiser_id = ? AND status IN ('rejected','replaced') AND deleted_at IS NULL ORDER BY created_at LIMIT 1", S.orgId)[0];
    const longAgo = new Date(Date.now() - 40 * 86400e3).toISOString();
    sql("UPDATE verification_documents SET reviewed_at = ?, replaced_at = ?, created_at = ? WHERE id = ?", longAgo, longAgo, longAgo, rejected.id);
    php("kyc_retention();");
    assert.ok(!fs.existsSync(path.join(dataDir, "private", rejected.file_name)), "old rejected copy deleted");
    assert.equal((await S.p.request.get(`${BASE}/api/verification/documents/${rejected.id}/file`)).status(), 410);
    assert.equal((await a.post(`/api/admin/organisers/${S.orgId}/verification/close`, { reopen: false })).status, 200);
    sql("UPDATE organiser_verification SET closed_at = ? WHERE organiser_id = ?", new Date(Date.now() - 6 * 365 * 86400e3).toISOString(), S.orgId);
    php("kyc_retention();");
    assert.equal(Number(sql("SELECT count(*) AS n FROM verification_documents WHERE organiser_id = ? AND deleted_at IS NULL", S.orgId)[0].n), 0, "everything deleted after the keeping period");
    assert.equal(sql("SELECT id_number_enc FROM organiser_verification WHERE organiser_id = ?", S.orgId)[0].id_number_enc, null, "ID number deleted too");
    assert.equal(Number(sql("SELECT count(*) AS n FROM audit_log WHERE action = 'verification.retention_deleted' AND organiser_id = ?", S.orgId)[0].n), 1);
    // An older site (schema 10) gets the tables by upgrade 12, which touches nothing else.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tr-upg-"));
    fs.cpSync(path.join(ROOT, "api"), path.join(tmp, "public_html", "api"), { recursive: true });
    fs.cpSync(dataDir, path.join(tmp, "ticketroom-data"), { recursive: true });
    const old = path.join(tmp, "ticketroom-data", "ticketroom.sqlite");
    execFileSync("php", ["-r", `$d=new PDO('sqlite:${old}'); $d->exec("DROP TABLE organiser_verification; DROP TABLE verification_documents; DROP TABLE event_risk; UPDATE meta SET value = '10' WHERE key = 'schema_version'");`]);
    const out = execFileSync("php", ["-r", `require '${tmp}/public_html/api/bootstrap.php'; tr_load(); echo val("SELECT value FROM meta WHERE key = 'schema_version'"), ' ', val("SELECT count(*) FROM sqlite_master WHERE name IN ('organiser_verification','verification_documents','event_risk')");`]).toString();
    const [ver, tables] = out.split(" ").map(Number);
    assert.ok(ver >= 12 && tables === 3, `upgraded past 12 with the three verification tables (${out})`);
    fs.rmSync(tmp, { recursive: true, force: true });
    step("POPIA: keeping period (5 years minimum, set in the admin portal), old copies and closed organisers deleted automatically; upgrade to schema 12");

    // 12. Pages render for everyone involved.
    await adm.goto(`${BASE}/admin#/`);
    await adm.getByRole("heading", { name: "Overview" }).waitFor();
    await adm.goto(`${BASE}/admin#/verification`);
    await adm.getByRole("heading", { name: "Keeping documents (POPIA)" }).waitFor();
    await adm.goto(`${BASE}/admin#/emails`);
    await adm.getByText("Verification document not accepted").waitFor();
    if (problems.length) throw new Error(problems.join("\n"));
    console.log("PHP verification checks passed.");
  } finally {
    fs.writeFileSync(cfgFile, original);
    mock.kill();
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
