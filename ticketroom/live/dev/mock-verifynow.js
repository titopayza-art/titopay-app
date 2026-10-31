// A local stand-in for VerifyNow (https://www.verifynow.co.za/api/external),
// for tests only. It implements the endpoints TicketRoom calls and the
// documented sandbox behaviour:
//   - x-api-key must match the key it was started with (401 otherwise)
//   - Idempotency-Key (8-160 chars) required on production POSTs; the same key
//     and body replays the stored answer free, a different body is 409
//   - production calls cost one credit; no credits left is 402
//   - inputs ending 90 give the negative / review path, 91 an error (502)
//   - the same sandbox payload from the same IP within 2 s is 429, Retry-After: 2
//   - business and NPO bank checks answer 202 {jobId}, then POST a signed
//     webhook (x-verifynow-signature v1=HMAC-SHA256(timestamp + "." + body)) to
//     the webhookUrl; GET .../jobs/{jobId} reports the job; the
//     x-verifynow-sandbox-scenario header picks a scenario
//
//   node mock-verifynow.js <port> <apiKey>
//
// Test controls (no key needed): GET /__mock/calls, POST /__mock/config,
// POST /__mock/reset, POST /__mock/deliver/{jobId} {sig:"good"|"bad", age, eventId}.
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.argv[2] || 8805);
let KEY = process.argv[3] || "vn_live_mocktestkey000000";
const state = () => ({ credits: 50, charged: 0, calls: [], idem: new Map(), recent: new Map(), jobs: new Map(), failNext: [], chargeThenFail: [], slowNext: [], force429: [],
  deliverWebhooks: true, webhookDelayMs: 300, jobDelayMs: 300, surnames: {}, companies: {}, deliveries: [] });
let S = state();

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ends = (v, t) => String(v ?? "").replace(/\s+/g, "").endsWith(t);
const send = (res, status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const err = (code, message) => ({ success: false, error: { code, message } });
const take = (list, path) => { const i = list.findIndex((f) => !f.path || path.startsWith(f.path)); if (i < 0) return null; const f = list[i]; if (!f.times || --f.times <= 0) list.splice(i, 1); return f; };

function bankScenario(acct, scenario) {
  const checks = { accountFound: true, accountOpen: true, accountNumberLengthValid: true, accountTypeMatch: true, companyRegistrationMatch: true, initialsMatch: true, surnameMatch: true, acceptsDebits: true, acceptsCredits: true };
  const map = { company_registration_mismatch: ["companyRegistrationMatch", false, "review"], name_mismatch: ["surnameMatch", false, "review"], closed_account: ["accountOpen", false, "review"],
    debits_rejected: ["acceptsDebits", false, "verified"], credits_rejected: ["acceptsCredits", false, "verified"], name_unavailable: ["surnameMatch", null, "review"] };
  if (scenario === "verification_timed_out") return { outcome: "failed", error: { code: "verification_timed_out", message: "The bank did not respond in time." } };
  if (scenario && map[scenario]) { const [k, v, outcome] = map[scenario]; checks[k] = v; return { outcome, checks }; }
  if (ends(acct, "90")) { checks.surnameMatch = false; return { outcome: "review", checks }; }
  return { outcome: "verified", checks };
}

function deliver(jobId, { sig = "good", age = 0, eventId, body: rawOverride } = {}) {
  const job = S.jobs.get(jobId);
  if (!job) return Promise.resolve({ status: 0, error: "no such job" });
  const evt = { id: eventId || "evt_" + crypto.randomBytes(8).toString("hex"), type: `${job.kind}_bank.verification.${job.result.outcome === "failed" ? "failed" : "completed"}`, createdAt: new Date().toISOString(),
    data: { jobId, status: job.result.outcome === "failed" ? "failed" : "completed", mode: job.mode, reportType: "foreign-bank", creditsUsed: job.mode === "production" ? 1 : 0,
      result: { ...job.result, bank: { name: job.bankName, accountNumberLast4: String(job.acct).slice(-4) } } } };
  const body = rawOverride || JSON.stringify(evt);
  const ts = String(Math.floor(Date.now() / 1000) - age);
  const hmac = crypto.createHmac("sha256", sig === "bad" ? "not-the-secret-not-the-secret-000" : job.secret).update(ts + "." + body).digest("hex");
  return fetch(job.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-verifynow-signature": "v1=" + hmac, "x-verifynow-timestamp": ts }, body })
    .then(async (r) => { const out = { status: r.status, body: await r.text(), eventId: evt.id }; S.deliveries.push({ jobId, status: r.status, eventId: evt.id }); return out; })
    .catch((e) => ({ status: 0, error: String(e) }));
}

function handle(req, res, raw) {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/api\/external/, "");
  const ip = req.socket.remoteAddress;
  // ---- test controls
  if (path === "/__mock/calls") return send(res, 200, { pid: process.pid, calls: S.calls, credits: S.credits, charged: S.charged, deliveries: S.deliveries, jobs: [...S.jobs.keys()] });
  if (path === "/__mock/reset") { const keep = S; S = state(); S.deliverWebhooks = keep.deliverWebhooks; return send(res, 200, { ok: true }); }
  if (path === "/__mock/config") {
    const c = JSON.parse(raw || "{}");
    for (const k of ["credits", "deliverWebhooks", "webhookDelayMs", "jobDelayMs", "surnames", "companies"]) if (k in c) S[k] = c[k];
    for (const k of ["failNext", "chargeThenFail", "slowNext", "force429"]) if (c[k]) S[k].push(...c[k]);
    if (c.key) KEY = c.key;
    return send(res, 200, { ok: true });
  }
  const dm = path.match(/^\/__mock\/deliver\/(.+)$/);
  if (dm) return deliver(dm[1], JSON.parse(raw || "{}")).then((r) => send(res, 200, r));

  const idemKey = req.headers["idempotency-key"] || null;
  const call = { at: Date.now(), method: req.method, path, ip, idempotencyKey: idemKey, bodyHash: raw ? sha(raw) : null, scenario: req.headers["x-verifynow-sandbox-scenario"] || null };
  S.calls.push(call);
  const reply = (status, body, headers = {}) => { call.status = status; send(res, status, body, headers); };
  if (req.headers["x-api-key"] !== KEY) { call.keyLength = String(req.headers["x-api-key"] || "").length; call.keyPrefixOk = String(req.headers["x-api-key"] || "").startsWith("vn_live_"); }
  if (req.headers["x-api-key"] !== KEY) return reply(401, err("invalid_api_key", "Invalid API key"));

  // ---- reads
  if (req.method === "GET" && path === "/my_credits") return reply(200, { success: true, credits: S.credits });
  const jm = path.match(/^\/(business|npo)-bank-account-verification\/jobs\/([\w-]+)$/);
  if (req.method === "GET" && jm) {
    const job = S.jobs.get(jm[2]);
    if (!job) return reply(404, err("not_found", "Job not found"));
    if (Date.now() < job.readyAt) return reply(200, { jobId: job.id, status: "pending" });
    return reply(200, { jobId: job.id, status: job.result.outcome === "failed" ? "failed" : "completed", mode: job.mode, result: job.result });
  }
  if (req.method !== "POST") return reply(404, err("not_found", "Not found"));

  let b;
  try { b = JSON.parse(raw); } catch { return reply(400, err("bad_json", "Invalid JSON")); }
  const mode = b.mode === "production" ? "production" : "sandbox";
  if (mode === "production" && !idemKey) return reply(400, err("idempotency_key_required", "Idempotency-Key header is required for production calls"));
  if (idemKey && (idemKey.length < 8 || idemKey.length > 160)) return reply(400, err("bad_idempotency_key", "Idempotency-Key must be 8-160 characters"));
  const bodyHash = sha(path + raw);
  if (idemKey && S.idem.has(idemKey)) {
    const prev = S.idem.get(idemKey);
    if (prev.hash !== bodyHash) return reply(409, err("idempotency_conflict", "Idempotency-Key reused with a different body"));
    call.replayed = true;
    return reply(prev.status, prev.body, { "idempotent-replayed": "true" });
  }
  const forced = take(S.force429, path);
  if (forced) return reply(429, err("rate_limited", "Too many requests"), { "retry-after": String(forced.retryAfter ?? 2) });
  if (mode === "sandbox") {
    const k = ip + " " + bodyHash;
    const last = S.recent.get(k);
    S.recent.set(k, Date.now());
    if (last && Date.now() - last < 2000) return reply(429, err("rate_limited", "Repeated sandbox request, wait 2 seconds"), { "retry-after": "2" });
  }
  const fail = take(S.failNext, path);
  if (fail) return reply(fail.status, err("mock_failure", "Simulated failure"), fail.retryAfter ? { "retry-after": String(fail.retryAfter) } : {});
  if (mode === "production" && S.credits <= 0) return reply(402, err("insufficient_credits", "Insufficient credits"));

  let status = 200, out;
  const negative = (v) => ends(v, "90"), broken = (v) => ends(v, "91");
  const requestId = "req_" + crypto.randomBytes(6).toString("hex");
  if (path === "/verify") {
    if (b.reportType !== "said_verification" || !/^\d{13}$/.test(String(b.idNumber || ""))) return reply(400, err("invalid_parameters", "reportType said_verification and a 13-digit idNumber are required"));
    if (broken(b.idNumber)) return reply(502, err("processing_failed", "Upstream failure"));
    const valid = !negative(b.idNumber);
    out = { success: true, requestId, user_id: "11", remainingCredits: S.credits - (mode === "production" ? 1 : 0), mode, reportType: "said_verification", input: { idNumber: b.idNumber },
      results: { said_verification: { Status: "Success", realTimeResults: { Status: valid ? "ID Number Valid" : "ID Number Invalid",
        Verification: valid ? { Firstnames: "Test", Lastname: S.surnames[b.idNumber] || "Tester", Dob: "1990-01-01", Age: 36, Gender: "Female", Citizenship: "South African", DateIssued: "" } : {},
        transaction_id: "tx_" + requestId }, transaction_id: "tx_" + requestId, meta: { environment: mode, timestamp: new Date().toISOString() } } } };
  } else if (path === "/aml-screening") {
    if (!b.name || ![0, 1].includes(b.entity)) return reply(400, err("invalid_parameters", "name and entity (0 or 1) are required"));
    if (broken(b.name)) return reply(502, err("processing_failed", "Upstream failure"));
    const hits = negative(b.name) ? [{ name: b.name.replace(/\s*90$/, ""), datasets: ["PEP"], score: 0.91 }] : [];
    out = { success: true, requestId, mode, results: { aml_screening: { status: "Success", total_hits: hits.length, matches: hits } } };
  } else if (path === "/cipc") {
    if (b.reportType !== "cipc_company_match" || !b.registration_number) return reply(400, err("invalid_parameters", "registration_number is required"));
    if (broken(b.registration_number)) return reply(502, err("processing_failed", "Upstream failure"));
    out = negative(b.registration_number)
      ? { success: true, requestId, mode, results: { cipc_company_match: { status: "Success", match: false } } }
      : { success: true, requestId, mode, results: { cipc_company_match: { status: "Success", match: true, company_name: S.companies[b.registration_number] || "Mock Events (Pty) Ltd", company_status: "In Business", registration_number: b.registration_number } } };
  } else if (path === "/facematch") {
    if (!b.selfie_image_base64 || !b.id_number) return reply(400, err("invalid_parameters", "selfie_image_base64 and id_number are required"));
    if (Buffer.from(b.selfie_image_base64, "base64").length > 5 * 1024 * 1024) return reply(413, err("too_large", "Image too large"));
    out = { success: true, requestId, mode, results: { face_match: negative(b.id_number) ? { status: "no_match", score: 0.12 } : { status: "match", score: 0.97 } } };
  } else if (path === "/bank-account-verification") {
    if (b.type !== "Individual" || !b.bankAccountNumber || !b.identityNumber || !b.surname) return reply(400, err("invalid_parameters", "Missing fields"));
    if (broken(b.bankAccountNumber)) return reply(502, err("processing_failed", "Bank lookup failed"));
    const r = bankScenario(b.bankAccountNumber, null);
    out = { success: true, requestId, mode, status: "completed", result: r };
  } else if (path === "/business-bank-account-verification" || path === "/npo-bank-account-verification") {
    const kind = path.startsWith("/npo") ? "npo" : "business";
    if (!b.companyName || !b.bankAccountNumber || b.consentConfirmed !== true || !b.purpose || !b.webhookUrl || !b.webhookSecret || b.webhookSecret.length < 32 || b.webhookSecret.length > 256)
      return reply(400, err("invalid_parameters", "companyName, bank details, consentConfirmed, purpose, webhookUrl and webhookSecret (32-256) are required"));
    const scenario = req.headers["x-verifynow-sandbox-scenario"];
    const known = ["company_registration_mismatch", "name_mismatch", "closed_account", "debits_rejected", "credits_rejected", "name_unavailable", "verification_timed_out"];
    if (scenario && mode === "sandbox" && !known.includes(scenario)) return reply(400, err("unsupported_scenario", "Unsupported sandbox scenario"));
    if (broken(b.bankAccountNumber)) return reply(502, err("processing_failed", "Bank lookup failed"));
    const id = "job_" + crypto.randomBytes(8).toString("hex");
    const job = { id, kind, mode, secret: b.webhookSecret, webhookUrl: b.webhookUrl, acct: b.bankAccountNumber, bankName: b.bankName, readyAt: Date.now() + S.jobDelayMs,
      result: bankScenario(b.bankAccountNumber, mode === "sandbox" ? scenario : null) };
    S.jobs.set(id, job);
    if (S.deliverWebhooks) setTimeout(() => deliver(id), S.webhookDelayMs);
    status = 202; out = { success: true, jobId: id, status: "pending" };
  } else {
    return reply(404, err("not_found", "Unknown endpoint"));
  }
  if (mode === "production") { S.credits -= 1; S.charged += 1; }
  if (idemKey) S.idem.set(idemKey, { hash: bodyHash, status, body: out });
  // Charged and stored, but the answer is lost on the way back (a retry must replay it free).
  if (take(S.chargeThenFail, path)) return reply(503, err("unavailable", "Service unavailable"));
  const slow = take(S.slowNext, path);
  if (slow) { call.slow = true; return setTimeout(() => reply(status, out), slow.ms || 5000); }
  return reply(status, out);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => { try { handle(req, res, Buffer.concat(chunks).toString("utf8")); } catch (e) { send(res, 500, err("mock_crash", String(e))); } });
}).on("error", (e) => { process.stderr.write(`mock VerifyNow could not listen on ${PORT}: ${e.message}\n`); process.exit(1); })
  .listen(PORT, "127.0.0.1", () => process.stdout.write(`mock VerifyNow on ${PORT}\n`));
