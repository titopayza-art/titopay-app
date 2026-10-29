// Operations and security regression tests (O* and S* in TRIAGE.md) for a
// local copy of the live package started with dev/serve.sh.
//
//   TR_TEST_ADMIN_PASSWORD=... node ticketroom/live/dev/tests/ops.js <dir> [port]
//
// Uses the HTTP API, PHP on the command line against the same data folder,
// small SMTP stand-ins on 127.0.0.1:8800-8802 and one Chromium page for the
// admin Backups and Messages screens. Every change it makes to the instance
// (maintenance, moved files, test rows) is put back before it ends.
const fs = require("fs");
const net = require("net");
const path = require("path");
const zlib = require("zlib");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const { Client, outbox, sql, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: ops.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const PUB = path.join(DIR, "public_html");
const TR = path.resolve(__dirname, "../../..");          // ticketroom/
const SRC = path.join(TR, "live", "public_html");          // the package source
const MOCK = { lease: 8800, plain: 8801, codes: 8802, closed: 8804 };

let failures = 0;
const ok = (name, detail = "") => console.log(`PASS  ${name}${detail ? "  " + detail : ""}`);
const bad = (name, detail) => { failures++; console.log(`FAIL  ${name}  ${detail}`); };
const check = (cond, name, detail = "") => (cond ? ok(name) : bad(name, detail || "condition false"));
async function step(name, fn) {
  try { await fn(); } catch (e) { bad(name, (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : String(e))); }
}

// ---------------------------------------------------------------- PHP on the command line
// Runs PHP with the instance's bootstrap loaded (tr_load) and returns its
// JSON output. $argv[1] is the instance folder; extra args follow.
const PRELUDE = `error_reporting(E_ALL); require $argv[1] . '/public_html/api/bootstrap.php'; tr_load();
foreach (glob(TR_APP . '/routes/*.php') as $f) if (!function_exists('tr_load_routes')) require_once $f;
if (function_exists('tr_load_routes')) tr_load_routes();
function out($v) { echo json_encode($v, JSON_UNESCAPED_SLASHES); }
function smtp_cfg(array $m) { $GLOBALS['TR_CONFIG']['mail'] = $m + ['mode' => 'smtp', 'smtpHost' => '127.0.0.1', 'smtpUser' => '', 'smtpPass' => '', 'fromEmail' => 'hello@ticketroom.co.za', 'fromName' => 'TicketRoom']; }
`;
const runAsync = promisify(execFile);
function php(code, ...args) {
  const outp = execFileSync("php", ["-r", PRELUDE + code, DIR, ...args.map(String)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try { return JSON.parse(outp || "null"); } catch { return outp; }
}
async function phpAsync(code, ...args) {
  const { stdout } = await runAsync("php", ["-r", PRELUDE + code, DIR, ...args.map(String)], { encoding: "utf8" });
  try { return JSON.parse(stdout || "null"); } catch { return stdout; }
}
const iso = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
const uuid = () => require("crypto").randomUUID();
function queue(to, extra = {}) {
  const id = uuid();
  const row = { id, channel: "email", kind: "transactional", to_address: to, subject: "Ops test", body: "Ops test message", created_at: iso(0), ...extra };
  const cols = Object.keys(row);
  sql(DATA, `INSERT INTO message_outbox (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, cols.map((c) => row[c]));
  return id;
}
const msg = (id) => sql(DATA, "SELECT * FROM message_outbox WHERE id = ?", [id])[0];

// ---------------------------------------------------------------- SMTP stand-ins
function smtpMock(port, { starttls = false, delayMs = 0, rcpt = () => "250 OK" } = {}) {
  const log = { cmds: [], delivered: [], auth: false };
  const srv = net.createServer((s) => {
    s.setEncoding("utf8");
    let buf = "", inData = false, to = null, authStep = 0;
    const send = (l) => { if (!s.destroyed) s.write(l + "\r\n"); };
    send("220 mock ESMTP ready");
    s.on("error", () => {});
    s.on("data", (chunk) => {
      buf += chunk;
      for (;;) {
        if (inData) {
          const i = buf.indexOf("\r\n.\r\n");
          if (i < 0) return;
          buf = buf.slice(i + 5); inData = false;
          const who = to;
          setTimeout(() => { log.delivered.push(who); send("250 2.0.0 queued"); }, delayMs);
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        log.cmds.push(line);
        const up = line.toUpperCase();
        if (authStep === 1) { authStep = 2; send("334 UGFzc3dvcmQ6"); continue; }
        if (authStep === 2) { authStep = 0; send("235 2.7.0 Authentication successful"); continue; }
        if (up.startsWith("EHLO") || up.startsWith("HELO")) s.write("250-mock\r\n" + (starttls ? "250-STARTTLS\r\n" : "") + "250 AUTH LOGIN PLAIN\r\n");
        else if (up.startsWith("AUTH")) { log.auth = true; authStep = 1; send("334 VXNlcm5hbWU6"); }
        else if (up.startsWith("MAIL FROM")) send("250 2.1.0 OK");
        else if (up.startsWith("RCPT TO")) { to = (line.match(/<([^>]*)>/) || [])[1] || ""; send(rcpt(to)); }
        else if (up === "DATA") { inData = true; send("354 go ahead"); }
        else if (up === "RSET" || up === "NOOP") send("250 OK");
        else if (up === "QUIT") { send("221 bye"); s.end(); }
        else send("502 not implemented");
      }
    });
  });
  return new Promise((resolve) => srv.listen(port, "127.0.0.1", () => resolve({ log, close: () => new Promise((r) => srv.close(r)) })));
}

// ---------------------------------------------------------------- tests
(async () => {
  const admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const cust = new Client(BASE, DATA);
  await cust.login(SEED.customer.email, SEED.customer.password, "customer");
  const org = new Client(BASE, DATA);
  await org.login(SEED.organiser.email, SEED.organiser.password, "organiser");
  const orgId = SEED.organiser.orgId;

  // O1: two or three delivery runs at the same moment never send one email twice.
  await step("O1 outbox lease", async () => {
    const m = await smtpMock(MOCK.lease, { delayMs: 60 });
    try {
      sql(DATA, "DELETE FROM meta WHERE key = 'mail_paused_until'");
      const ids = []; for (let i = 0; i < 30; i++) ids.push(queue(`lease-${i}@example.test`));
      const code = `smtp_cfg(['smtpPort' => ${MOCK.lease}]); out(outbox_deliver(25));`;
      await Promise.all([phpAsync(code), phpAsync(code), phpAsync(code)]);
      await phpAsync(code); // whatever is left over
      const mine = m.log.delivered.filter((t) => /^lease-\d+@example\.test$/.test(t));
      const dupes = mine.length - new Set(mine).size;
      check(dupes === 0 && new Set(mine).size === 30, "O1 concurrent delivery sends each email once", `delivered ${mine.length}, distinct ${new Set(mine).size}, duplicates ${dupes}`);
      const notSent = ids.filter((id) => msg(id).status !== "sent").length;
      check(notSent === 0, "O1 every leased email is marked sent", `${notSent} not sent`);
    } finally { await m.close(); }
  });

  // O4: back-off over hours, no retry storm, permanent failures stop, rate limits pause, admin retry.
  await step("O4 email retries", async () => {
    const m = await smtpMock(MOCK.codes, { rcpt: (to) => to.startsWith("tempfail") ? "451 4.3.0 Local error in processing" : to.startsWith("perm@") ? "550 5.1.1 No such user here" : to.startsWith("rate@") ? "450 4.7.1 Rate limit exceeded, slow down" : "250 OK" });
    try {
      sql(DATA, "DELETE FROM meta WHERE key = 'mail_paused_until'");
      const a = queue("tempfail@example.test");
      const b = queue("perm@example.test");
      const c = queue("tempfail-old@example.test", { attempts: 5, created_at: iso(-2 * 3600) });
      const code = `smtp_cfg(['smtpPort' => ${MOCK.codes}]); out(outbox_deliver(25));`;
      await phpAsync(code);
      const A = msg(a), B = msg(b), C = msg(c);
      check(A.status === "queued" && A.next_attempt_at && A.next_attempt_at > iso(50), "O4 a temporary failure waits before the next try", JSON.stringify({ status: A.status, next: A.next_attempt_at }));
      check(B.status === "failed", "O4 a permanent refusal (5xx) is not retried", `status ${B.status}`);
      check(C.status === "queued" && C.attempts === 6 && C.next_attempt_at > iso(3 * 3600), "O4 retries carry on for hours, not five quick tries", `status ${C.status} after ${C.attempts} attempts, next ${C.next_attempt_at}`);
      await phpAsync(code);
      check(msg(a).attempts === 1, "O4 no immediate second try", `attempts ${msg(a).attempts}`);
      const r = queue("rate@example.test");
      await phpAsync(code);
      const R = msg(r);
      const paused = sql(DATA, "SELECT value FROM meta WHERE key = 'mail_paused_until'")[0];
      check(R.status === "queued" && R.attempts === 0 && paused && Number(paused.value) > Date.now() / 1000 + 300, "O4 a rate limit pauses email and keeps the message's tries", JSON.stringify({ status: R.status, attempts: R.attempts, paused }));
      sql(DATA, "DELETE FROM meta WHERE key = 'mail_paused_until'");
      // Admin: retry one failed message, then all.
      const res = await admin.call("POST", "/api/admin/outbox/retry", { id: b });
      // Back in the queue (the server may already have sent it in "log" mode).
      check(res.retried === 1 && ["queued", "sent"].includes(msg(b).status) && msg(b).attempts <= 1, "O4 admin retries a failed message", JSON.stringify({ res, status: msg(b).status, attempts: msg(b).attempts }));
      const list = await admin.call("GET", "/api/admin/outbox");
      check(list.messages.some((x) => "next_attempt_at" in x), "O4 the Messages list shows when the next try is");
      const audited = sql(DATA, "SELECT count(*) AS n FROM audit_log WHERE action = 'outbox.retried'")[0].n;
      check(audited >= 1, "O4 retry is in the audit log");
      sql(DATA, `DELETE FROM message_outbox WHERE id IN (?,?,?,?)`, [a, b, c, r]);
    } finally { await m.close(); }
  });

  // S3: never AUTH in the clear when the server does not offer STARTTLS.
  await step("S3 STARTTLS", async () => {
    const m = await smtpMock(MOCK.plain, { starttls: false });
    try {
      sql(DATA, "DELETE FROM meta WHERE key = 'mail_paused_until'");
      const id = queue("s3@example.test");
      await phpAsync(`smtp_cfg(['smtpPort' => ${MOCK.plain}, 'smtpUser' => 'hello@ticketroom.co.za', 'smtpPass' => 'mailbox-secret']); out(outbox_deliver(25));`);
      check(!m.log.auth && !m.log.cmds.some((c) => /^AUTH/i.test(c)), "S3 the mailbox password is never sent without TLS", m.log.cmds.join(" / "));
      const M = msg(id);
      check(M.status !== "sent" && /secure|STARTTLS/i.test(M.last_error || ""), "S3 the message waits with a clear reason", `${M.status} ${M.last_error}`);
      sql(DATA, "DELETE FROM meta WHERE key = 'mail_paused_until'");
      sql(DATA, "DELETE FROM message_outbox WHERE id = ?", [id]);
    } finally { await m.close(); }
  });

  // O2: backups.
  await step("O2 backups", async () => {
    const made = await admin.call("POST", "/api/admin/backups", {}, 201);
    const name = made.backup && made.backup.name;
    const file = path.join(DATA, "backups", name || "none");
    check(name && fs.existsSync(file) && fs.readFileSync(file).subarray(0, 15).toString() === "SQLite format 3", "O2 Back up now makes a SQLite copy in ticketroom-data/backups", name);
    const n = sql(DATA, "SELECT count(*) AS n FROM users")[0].n;
    const copyUsers = execFileSync("php", ["-r", "$d=new PDO('sqlite:'.$argv[1]); echo $d->query('SELECT count(*) FROM users')->fetchColumn();", file], { encoding: "utf8" });
    check(Number(copyUsers) === n, "O2 the copy holds the data", `${copyUsers} vs ${n}`);
    const list = await admin.call("GET", "/api/admin/backups");
    check(list.backups.some((x) => x.name === name), "O2 the backups list shows it");
    const dl = list.backups.find((x) => x.name === name);
    const res = await fetch(`${BASE}/api/admin/backups/${encodeURIComponent(dl.id)}`, { headers: { cookie: admin.cookieHeader() } });
    const bytes = Buffer.from(await res.arrayBuffer());
    check(res.status === 200 && bytes.subarray(0, 15).toString() === "SQLite format 3" && /attachment/.test(res.headers.get("content-disposition") || ""), "O2 admin downloads the backup", `${res.status} ${res.headers.get("content-type")}`);
    const audited = sql(DATA, "SELECT action FROM audit_log WHERE action IN ('backup.created','backup.downloaded') AND entity_id = ?", [name]).map((r) => r.action);
    check(audited.includes("backup.created") && audited.includes("backup.downloaded"), "O2 making and downloading are audited", audited.join(","));
    const anon = await fetch(`${BASE}/api/admin/backups/${encodeURIComponent(dl.id)}`, { headers: { cookie: cust.cookieHeader() } });
    check([401, 403].includes(anon.status), "O2 a customer cannot download it", String(anon.status));
    const trav = await fetch(`${BASE}/api/admin/backups/..%2Fticketroom`, { headers: { cookie: admin.cookieHeader() } });
    const odd = await fetch(`${BASE}/api/admin/backups/ticketroom`, { headers: { cookie: admin.cookieHeader() } });
    check([403, 404].includes(trav.status) && odd.status === 404, "O2 only backup files can be downloaded", `${trav.status} ${odd.status}`);
    // Keep 14: old daily copies are pruned.
    for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(DATA, "backups", `ticketroom-20200101-0000${String(i).padStart(2, "0")}-daily.sqlite`), "SQLite format 3\0");
    const kept = php(`backup_take('daily'); out(array_column(backup_list(), 'name'));`);
    const regular = kept.filter((x) => !/before-upgrade/.test(x));
    check(regular.length === 14 && !regular.includes("ticketroom-20200101-000000-daily.sqlite"), "O2 the newest 14 are kept", `${regular.length} kept`);
    // A daily job and a copy before every database upgrade.
    const jobs = php(`out(array_map(fn($j) => [$j[0], $j[1]], jobs()));`);
    check(jobs.some(([n2, every]) => n2 === "backup" && every === 86400), "O2 a daily backup job runs");
    const before = fs.readdirSync(path.join(DATA, "backups")).filter((f) => f.includes("before-upgrade")).length;
    php(`q("UPDATE meta SET value = ? WHERE key = 'upgrades_done'", [implode(',', array_diff(array_keys(UPGRADES), [49]))]); tr_upgrade(); out(1);`);
    const after = fs.readdirSync(path.join(DATA, "backups")).filter((f) => f.includes("before-upgrade")).length;
    check(after === before + 1, "O2 a copy is made before a database upgrade", `${before} -> ${after}`);
    const doc = fs.readFileSync(path.join(SRC, "DEPLOY-AFRIHOST.md"), "utf8");
    check(/Backups/.test(doc) && /[Rr]estor/.test(doc) && /ticketroom-data\/backups/.test(doc), "O2 DEPLOY-AFRIHOST.md explains backups and restoring");
  });

  // O3: an installed site never makes new keys or a second data folder.
  await step("O3 keys and data folder", async () => {
    const keys = path.join(DATA, "keys.php");
    fs.renameSync(keys, keys + ".away");
    try {
      const r = await fetch(`${BASE}/api/health`);
      const j = await r.json().catch(() => ({}));
      check(r.status === 503 && j.error && j.error.code === "site_stopped", "O3 missing keys.php stops the site", `${r.status} ${JSON.stringify(j).slice(0, 160)}`);
      check(!fs.existsSync(keys), "O3 no new keys are made");
      let cronOut = "", cronCode = 0;
      try { execFileSync("php", [path.join(PUB, "api", "cron.php")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
      catch (e) { cronCode = e.status; cronOut = String(e.stderr); }
      check(cronCode !== 0 && /keys\.php/.test(cronOut), "O3 cron stops with a clear message", `${cronCode} ${cronOut.slice(0, 160)}`);
    } finally { if (fs.existsSync(keys)) fs.rmSync(keys); fs.renameSync(keys + ".away", keys); }
    check((await fetch(`${BASE}/api/health`)).status === 200, "O3 the site runs again once keys.php is back");
    fs.renameSync(DATA, DATA + ".away");
    try {
      const r = await fetch(`${BASE}/api/health`);
      check(r.status === 503, "O3 a missing data folder stops the site", String(r.status));
      check(!fs.existsSync(DATA), "O3 no second, empty data folder is made");
    } finally { if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true }); fs.renameSync(DATA + ".away", DATA); }
    check((await fetch(`${BASE}/api/health`)).status === 200, "O3 the site runs again once the folder is back");
  });

  // O5: PHP errors never on screen and never in a downloadable file.
  await step("O5 error log", async () => {
    const r = php(`out(['display' => ini_get('display_errors'), 'log' => ini_get('error_log'), 'data' => data_dir()]);`);
    check(["0", "", "off", "Off"].includes(String(r.display)), "O5 display_errors is off", String(r.display));
    check(String(r.log).startsWith(r.data + "/"), "O5 errors are logged in the data folder", String(r.log));
    fs.writeFileSync(path.join(PUB, "error_log"), "[ticketroom] secret details");
    try {
      const res = await fetch(`${BASE}/error_log`);
      check(res.status === 403, "O5 a stray error_log in public_html is not served", String(res.status));
    } finally { fs.rmSync(path.join(PUB, "error_log")); }
    check(/\^error_log\$|error_log/.test(fs.readFileSync(path.join(SRC, ".htaccess"), "utf8")), "O5 .htaccess blocks error_log");
  });

  // O6: browse limits without database writes; limits per account/email; gzip.
  await step("O6 rate limits and compression", async () => {
    sql(DATA, "DELETE FROM rate_limits WHERE key LIKE 'browse:%'");
    for (let i = 0; i < 3; i++) await (await fetch(`${BASE}/api/public/events`)).text();
    const rows = sql(DATA, "SELECT count(*) AS n FROM rate_limits WHERE key LIKE 'browse:%'")[0].n;
    check(rows === 0, "O6 browsing writes nothing to the database", `${rows} rows`);
    const soft = php(`$n = 0; for ($i = 0; $i < 4; $i++) { try { limit_light('opstest', 3, 60, 'k1'); $n++; } catch (AppError $e) { $code = $e->status; } }
      out(['passed' => $n, 'code' => $code ?? null, 'rows' => (int) val("SELECT count(*) FROM rate_limits WHERE key LIKE 'opstest:%'")]);`);
    check(soft.passed === 3 && soft.code === 429 && soft.rows === 0, "O6 the light limiter still stops a flood", JSON.stringify(soft));
    const codes = [];
    for (let i = 0; i < 7; i++) {
      const r = await fetch(`${BASE}/api/auth/password/forgot`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: `shared-ip-${i}@example.test` }) });
      codes.push(r.status);
    }
    check(codes.every((c) => c === 200), "O6 seven people on one connection can each ask for a reset", codes.join(","));
    const big = php(`$_SERVER['HTTP_ACCEPT_ENCODING'] = 'gzip, deflate, br'; ob_start(); emit(json_out(['rows' => array_fill(0, 3000, ['name' => 'Sunset Sessions', 'n' => 1])])); out(base64_encode(ob_get_clean()));`);
    let gz = false; try { gz = JSON.parse(zlib.gunzipSync(Buffer.from(big, "base64")).toString()).rows.length === 3000; } catch {}
    check(gz, "O6 large JSON answers are gzipped when the browser accepts it");
  });

  // O7: cron is quiet and recorded.
  await step("O7 cron", async () => {
    const outp = execFileSync("php", [path.join(PUB, "api", "cron.php")], { encoding: "utf8" });
    check(outp.trim() === "", "O7 cron prints nothing when all is well", JSON.stringify(outp.slice(0, 80)));
    const t = sql(DATA, "SELECT value FROM meta WHERE key = 'cron_last_run'")[0];
    check(t && Number(t.value) > Date.now() / 1000 - 60, "O7 the last cron run is recorded");
    const verbose = execFileSync("php", [path.join(PUB, "api", "cron.php"), "--verbose"], { encoding: "utf8" });
    check(/^ran:/.test(verbose), "O7 --verbose lists the jobs");
    const doc = fs.readFileSync(path.join(SRC, "DEPLOY-AFRIHOST.md"), "utf8");
    check(/\/usr\/local\/bin\/php \/home\/[A-Za-z]+\/public_html\/api\/cron\.php >\/dev\/null 2>&1/.test(doc), "O7 the guide gives the full cron command");
    check(!/cron[^\n]{0,80}optional|optional[^\n]{0,80}cron/i.test(doc + fs.readFileSync(path.join(SRC, "api", "cron.php"), "utf8")), "O7 cron is no longer called optional");
  });

  // O8: health shows job freshness and the email backlog; the owner is alerted, not spammed.
  await step("O8 health and alerts", async () => {
    const h = await (await fetch(`${BASE}/api/health`)).json();
    check(h.ok === true && h.jobs && typeof h.jobs.fresh === "boolean" && h.outbox && typeof h.outbox.queued === "number" && "healthy" in h, "O8 /api/health reports jobs and the email backlog", JSON.stringify(h).slice(0, 200));
    const r = php(`for ($i = 0; $i < 30; $i++) insert('message_outbox', ['id' => uuid(), 'channel' => 'email', 'kind' => 'transactional', 'to_address' => "backlog-$i@example.test", 'subject' => 'Backlog', 'body' => 'x', 'created_at' => iso_in(-7200), 'next_attempt_at' => iso_in(3600)]);
      q("DELETE FROM meta WHERE key = 'ops_alert_at'");
      $problems = ops_problems(); $a = ops_alert_check(); $b = ops_alert_check();
      $sent = (int) val("SELECT count(*) FROM message_outbox WHERE subject = 'TicketRoom needs a look' AND created_at > ?", [iso_in(-60)]);
      q("DELETE FROM message_outbox WHERE to_address LIKE 'backlog-%@example.test'");
      out(['problems' => $problems, 'a' => $a, 'b' => $b, 'sent' => $sent]);`);
    check(r.problems.some((p) => /waiting/.test(p)) && r.a === 1 && r.b === 0 && r.sent === 1, "O8 one alert email for a stuck queue, then quiet", JSON.stringify(r).slice(0, 300));
  });

  // O10: one command runs the live tests.
  await step("O10 test runner", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(TR, "package.json"), "utf8"));
    check(pkg.scripts && /live\/dev\/run-all\.sh/.test(pkg.scripts["test:live"] || ""), "O10 npm run test:live runs the live harness");
    const runAll = path.join(TR, "live", "dev", "run-all.sh");
    check(fs.existsSync(runAll) && (fs.statSync(runAll).mode & 0o111) && /tests\//.test(fs.readFileSync(runAll, "utf8")), "O10 run-all.sh runs every suite");
  });

  // O11: only the route files of this build are loaded.
  await step("O11 route files", async () => {
    const stray = path.join(PUB, "api", "routes", "zz-stale.php");
    fs.writeFileSync(stray, "<?php\nroute('GET', '/api/zz-stale', fn() => ['stale' => true]);\n");
    try {
      const r = await fetch(`${BASE}/api/zz-stale`);
      check(r.status === 404, "O11 a stale route file left on the server is not run", String(r.status));
    } finally { fs.rmSync(stray); }
    const listed = JSON.parse(execFileSync("php", ["-r", "require $argv[1] . '/api/bootstrap.php'; echo json_encode(defined('TR_ROUTE_FILES') ? TR_ROUTE_FILES : []);", SRC], { encoding: "utf8" }));
    const files = fs.readdirSync(path.join(SRC, "api", "routes")).filter((f) => f.endsWith(".php")).map((f) => f.slice(0, -4)).sort();
    check(JSON.stringify([...listed].sort()) === JSON.stringify(files), "O11 every route file in the package is listed in TR_ROUTE_FILES", `listed ${listed.join(",")}; files ${files.join(",")}`);
  });

  // O12: HSTS without includeSubDomains.
  await step("O12 HSTS", async () => {
    const api = (await fetch(`${BASE}/api/health`)).headers.get("strict-transport-security") || "";
    const page = (await fetch(`${BASE}/sell`)).headers.get("strict-transport-security") || "";
    check(/max-age=\d+/.test(api) && !/includeSubDomains/i.test(api) && !/includeSubDomains/i.test(page), "O12 HSTS leaves other subdomains alone", `${api} | ${page}`);
    check(!/Strict-Transport-Security "[^"]*includeSubDomains/.test(fs.readFileSync(path.join(SRC, ".htaccess"), "utf8")), "O12 .htaccess sends HSTS without includeSubDomains");
  });

  // O13: only build-live.js writes ticketroom.zip.
  await step("O13 build scripts", async () => {
    for (const s of ["build-afrihost.js", "build-php.js"]) {
      const src = fs.readFileSync(path.join(TR, "scripts", s), "utf8");
      check(!/path\.join\(ROOT, "\.\.", "ticketroom\.zip"\)/.test(src), `O13 ${s} does not write ../ticketroom.zip`);
    }
  });

  // O15: the gate keeps working in maintenance; deploy check; logo; image caching.
  await step("O15 maintenance, deploy check, assets", async () => {
    await admin.call("PUT", "/api/admin/settings/maintenance", { enabled: true, message: "Back soon." });
    try {
      const st = await fetch(`${BASE}/api/staff/events`, { headers: { cookie: org.cookieHeader() } });
      const desk = await fetch(`${BASE}/api/cashdesk/events`, { headers: { cookie: org.cookieHeader() } });
      const me = await fetch(`${BASE}/api/me/tickets`, { headers: { cookie: cust.cookieHeader() } });
      check(st.status === 200 && desk.status === 200, "O15 gate scanning and the desk keep working during maintenance", `${st.status} ${desk.status}`);
      check(me.status === 503, "O15 the rest of the site is still closed", String(me.status));
      const scanPage = await fetch(`${BASE}/scan`);
      check(scanPage.status === 200 && !/right back/.test(await scanPage.text()), "O15 the scanner page opens during maintenance", String(scanPage.status));
    } finally { await admin.call("PUT", "/api/admin/settings/maintenance", { enabled: false, message: "Back soon." }); }
    const cfgFile = path.join(DATA, "config.php");
    const cfg = fs.readFileSync(cfgFile, "utf8");
    fs.writeFileSync(cfgFile, cfg.replace("'anthropicApiKey' => '',", "'anthropicApiKey' => '', 'security' => ['diagnosticsEnabled' => true],"));
    fs.writeFileSync(path.join(DATA, "unlock-check"), "");
    let page = "";
    try {
      page = execFileSync("php", ["-r", `$_SERVER['HTTPS'] = 'on'; $_SERVER['HTTP_HOST'] = 'localhost'; $_SERVER['SERVER_PORT'] = '${MOCK.closed}'; $_SERVER['DOCUMENT_ROOT'] = $argv[1]; chdir($argv[1]); include $argv[1] . '/deploy-check.php';`, PUB], { encoding: "utf8", timeout: 120000 });
    } finally { fs.writeFileSync(cfgFile, cfg); fs.rmSync(path.join(DATA, "unlock-check"), { force: true }); }
    check(/SQLite/.test(page) && /Cron job/.test(page) && /Backups/.test(page), "O15 the deploy check covers SQLite, cron and backups");
    check(!page.includes(ADMIN_EMAIL) && !page.includes(DATA) && !page.includes(PUB), "S8 the deploy check shows no admin email or server paths");
    const logo = fs.statSync(path.join(SRC, "assets", "ticketroom-logo.png")).size;
    check(logo < 120 * 1024, "O15 the logo is small", `${Math.round(logo / 1024)} KB`);
    const img = (await fetch(`${BASE}/assets/ticketroom-logo.png`)).headers.get("cache-control") || "";
    check(/no-cache/.test(img), "O15 images are re-checked after an upload", img);
  });

  // S2: wrong passwords from many places cannot lock someone out.
  await step("S2 account lockout", async () => {
    const em = SEED.customer.email;
    const lock = () => sql(DATA, "UPDATE users SET failed_logins = 30, locked_until = ? WHERE lower(email) = lower(?)", [iso(900), em]);
    lock();
    const c1 = new Client(BASE, DATA);
    let first = 0;
    try { await c1.call("POST", "/api/auth/login", { email: em, password: SEED.customer.password, portal: "customer" }); first = c1.status; } catch (e) { first = Number((e.message.match(/-> (\d+)/) || [])[1]); }
    check(first === 200, "S2 the right password still works while others guess", String(first));
    lock();
    sql(DATA, "DELETE FROM rate_limits WHERE key LIKE 'loginpair:%'");
    const c2 = new Client(BASE, DATA);
    const wrong = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: em, password: "not-the-password-at-all", portal: "customer" }) });
    const after = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: em, password: SEED.customer.password, portal: "customer" }) });
    check(wrong.status === 401 && after.status === 429, "S2 while under attack each connection gets one try", `${wrong.status} ${after.status}`);
    sql(DATA, "UPDATE users SET failed_logins = 0, locked_until = NULL WHERE lower(email) = lower(?)", [em]);
    sql(DATA, "DELETE FROM rate_limits WHERE key LIKE 'loginpair:%'");
    void c2;
  });

  // S4: names people typed cannot carry links into emails to others.
  await step("S4 names in emails", async () => {
    const r = php(`$ev = ['title' => 'Sunset Sessions', 'starts_at' => iso_in(86400), 'id' => uuid()];
      $evil = "Win a prize at http://evil.example/claim now \u{202E}";
      out([tpl('transferOffer', ['fromName' => $evil, 'event' => $ev, 'claimUrl' => 'https://ticketroom.co.za/account#/claim/x']),
           tpl('orgMemberInvite', ['by' => 'Visit www.evil.example', 'organiser' => 'Prizes at evil.example', 'role' => 'manager', 'url' => 'https://ticketroom.co.za/x']),
           tpl('staffInvite', ['name' => 'Sipho', 'organiser' => 'Go to https://evil.example', 'event' => 'Sunset', 'url' => 'https://ticketroom.co.za/x', 'canScan' => true])]);`);
    const text = JSON.stringify(r);
    check(!/evil\.example/.test(text) && !/\\u202e/i.test(text), "S4 links and hidden characters are taken out of names", text.slice(0, 200));
    check(/Win a prize/.test(text), "S4 the rest of the name stays");
  });

  // S5: sign-up and invites do not reveal who has an account.
  await step("S5 enumeration", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const reg = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ fullName: "Someone Else", email: SEED.customer.email, password: "A-long-password-2026", acceptTerms: true, marketingOptIn: false }) });
    const rj = await reg.json();
    check(reg.status === 201 && rj.needsVerification === true, "S5 sign-up with a used email looks the same as a new one", `${reg.status} ${JSON.stringify(rj).slice(0, 120)}`);
    let told = false; try { outbox(DATA, SEED.customer.email, /already have/i, { after: since }); told = true; } catch {}
    check(told, "S5 the owner of the email is told instead");
    const os = await fetch(`${BASE}/api/organiser/signup`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ fullName: "Someone Else", email: SEED.customer.email, password: "A-long-password-2026", organisation: "Copycat Events", acceptTerms: true }) });
    check(os.status === 201, "S5 organiser sign-up with a used email looks the same", String(os.status));
    const inv = await cust.call("POST", `/api/me/wallets/${SEED.events.free.id}/invite`, { email: SEED.organiser.email }, undefined).catch((e) => ({ error: e.message }));
    check(inv && inv.ok === true, "S5 a friend invite does not say whether they have an account", JSON.stringify(inv).slice(0, 160));
  });

  // S6: existing accounts are told when added to an event team; the desk only finds confirmed numbers.
  await step("S6 team notice and desk phone lookup", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const custId = sql(DATA, "SELECT id FROM users WHERE lower(email) = lower(?)", [SEED.customer.email])[0].id;
    // smoke.js may already have put this customer on the team: start from off it.
    const was = sql(DATA, "SELECT can_scan, can_manage_tags, can_sell_tickets FROM event_staff WHERE event_id = ? AND user_id = ?", [SEED.events.free.id, custId])[0];
    await org.call("DELETE", `/api/organiser/${orgId}/events/${SEED.events.free.id}/staff/${custId}`);
    await org.call("POST", `/api/organiser/${orgId}/events/${SEED.events.free.id}/staff`, { email: SEED.customer.email, canScan: true }, 201);
    let told = false; try { outbox(DATA, SEED.customer.email, /event team/i, { after: since }); told = true; } catch {}
    check(told, "S6 an existing account is emailed when added to an event team");
    if (was) await org.call("POST", `/api/organiser/${orgId}/events/${SEED.events.free.id}/staff`, { email: SEED.customer.email, canScan: !!was.can_scan, canManageTags: !!was.can_manage_tags, canSellTickets: !!was.can_sell_tickets }, 201);
    else await org.call("DELETE", `/api/organiser/${orgId}/events/${SEED.events.free.id}/staff/${custId}`);
    // A guest with a ticket for the free event.
    const tt = sql(DATA, "SELECT id FROM ticket_types WHERE event_id = ? ORDER BY created_at LIMIT 1", [SEED.events.free.id])[0];
    const email = `desk-${Date.now().toString(36)}@example.test`;
    const g = new Client(BASE, DATA);
    await g.call("POST", "/api/public/orders", { eventSlug: SEED.events.free.slug, items: [{ ticketTypeId: tt.id, quantity: 1 }], idempotencyKey: "ops-desk-" + Date.now(), guest: { fullName: "Desk Guest", email } }, 201);
    const phone = "+2782" + String(Math.floor(1000000 + Math.random() * 8999999));
    sql(DATA, "UPDATE users SET phone = ?, phone_verified_at = NULL WHERE lower(email) = lower(?)", [phone, email]);
    const findCode = `$ev = row('SELECT * FROM events WHERE id = ?', [$argv[2]]); try { desk_find_guest($ev, $argv[3]); out('found'); } catch (AppError $e) { out($e->errCode); }`;
    const local = "0" + phone.slice(3);
    check(php(findCode, SEED.events.free.id, local) === "not_found", "S6 the desk does not look people up by an unconfirmed number");
    sql(DATA, "UPDATE users SET phone_verified_at = ? WHERE lower(email) = lower(?)", [iso(0), email]);
    check(php(findCode, SEED.events.free.id, local) === "found", "S6 a confirmed number still works");
  });

  // S7: upload quota and clean-up.
  await step("S7 uploads", async () => {
    const owner = sql(DATA, "SELECT user_id FROM organiser_members WHERE organiser_id = ? AND role = 'owner'", [orgId])[0].user_id;
    php(`for ($i = 0; $i < 100; $i++) insert('uploads', ['id' => uuid(), 'owner_id' => $argv[3], 'organiser_id' => $argv[2], 'mime_type' => 'image/png', 'size_bytes' => 2097152, 'sha256' => 'opsquota', 'created_at' => now_iso()]); out(1);`, orgId, owner);
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    let status = 0;
    try { await org.call("POST", `/api/organiser/${orgId}/uploads`, PNG, 413, { "content-type": "image/png" }); status = 413; } catch (e) { status = Number((e.message.match(/-> (\d+)/) || [])[1]); }
    sql(DATA, "DELETE FROM uploads WHERE sha256 = 'opsquota'");
    check(status === 413, "S7 an organisation cannot upload past its space", String(status));
    const r = php(`$old = iso_in(-40 * 86400); $dir = data_dir() . '/uploads';
      $a = uuid(); insert('uploads', ['id' => $a, 'owner_id' => $argv[3], 'organiser_id' => $argv[2], 'mime_type' => 'image/png', 'size_bytes' => 10, 'created_at' => $old]); file_put_contents("$dir/$a", 'x');
      $b = uuid(); insert('uploads', ['id' => $b, 'owner_id' => $argv[3], 'organiser_id' => $argv[2], 'mime_type' => 'image/png', 'size_bytes' => 10, 'created_at' => $old]); file_put_contents("$dir/$b", 'x');
      $prev = val('SELECT logo_upload_id FROM organisers WHERE id = ?', [$argv[2]]);
      q('UPDATE organisers SET logo_upload_id = ? WHERE id = ?', [$b, $argv[2]]);
      $n = uploads_cleanup();
      $res = ['orphanGone' => !val('SELECT 1 FROM uploads WHERE id = ?', [$a]) && !is_file("$dir/$a"), 'usedKept' => (bool) val('SELECT 1 FROM uploads WHERE id = ?', [$b]) && is_file("$dir/$b")];
      q('UPDATE organisers SET logo_upload_id = ? WHERE id = ?', [$prev, $argv[2]]); q('DELETE FROM uploads WHERE id IN (?, ?)', [$a, $b]); @unlink("$dir/$a"); @unlink("$dir/$b");
      out($res);`, orgId, owner);
    check(r.orphanGone && r.usedKept, "S7 unused old images are cleared, used ones kept", JSON.stringify(r));
    const jobs = php(`out(array_column(jobs(), 0));`);
    check(jobs.includes("upload-cleanup"), "S7 the clean-up runs as a job");
  });

  // S8: email text with links is not kept for months.
  await step("S8 outbox retention", async () => {
    const id = queue("s8@example.test", { status: "sent", body: "Choose a new password: https://ticketroom.co.za/account#/reset/secret-token", created_at: iso(-10 * 86400), sent_at: iso(-10 * 86400) });
    php(`foreach (jobs() as [$n, $e, $fn]) if ($n === 'retention') $fn(); out(1);`);
    check(msg(id).body === "[redacted]", "S8 sent email text is removed after a week", msg(id).body.slice(0, 40));
    sql(DATA, "DELETE FROM message_outbox WHERE id = ?", [id]);
  });

  // The admin screens: Backups (with Back up now) and Retry on Messages.
  await step("O2/O4 admin screens", async () => {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ executablePath: CHROME });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      await ctx.addCookies([{ name: "tr_sid", value: admin.cookies.tr_sid, url: BASE }]);
      const p = await ctx.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push(e.message));
      p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
      await p.goto(`${BASE}/admin#/backups`);
      await p.getByRole("heading", { name: "Backups" }).waitFor({ timeout: 15000 });
      const newest = () => document.querySelector("[data-backup-row] a[download]")?.getAttribute("href") || "";
      const before = await p.evaluate(newest);
      await p.waitForTimeout(1100); // backup names carry the second they were made
      await p.getByRole("button", { name: "Back up now" }).click();
      await p.waitForFunction((b) => (document.querySelector("[data-backup-row] a[download]")?.getAttribute("href") || "") !== b, before, { timeout: 15000 });
      check(await p.locator("a[download][href^='/api/admin/backups/']").count() > 0, "O2 the Backups page lists copies to download");
      const failed = queue("retry-ui@example.test", { status: "failed", attempts: 5, last_error: "SMTP: 550 test" });
      await p.goto(`${BASE}/admin#/outbox`);
      await p.getByRole("heading", { name: "Messages" }).waitFor({ timeout: 15000 });
      await p.getByRole("button", { name: /Retry failed/ }).click();
      await p.getByRole("button", { name: "Retry", exact: true }).click();
      await p.waitForFunction(() => /back in the queue/i.test(document.body.innerText), null, { timeout: 15000 });
      check(msg(failed).status === "queued" || msg(failed).status === "sent", "O4 Retry failed on the Messages page re-queues them", msg(failed).status);
      check(!errs.length, "admin screens have no console errors", errs.join(" | "));
      sql(DATA, "DELETE FROM message_outbox WHERE id = ?", [failed]);
    } finally { await browser.close(); }
  });

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll ops checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
