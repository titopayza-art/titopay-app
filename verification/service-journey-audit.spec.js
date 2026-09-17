// CAN EVERY SERVICE ACTUALLY BE FINISHED?
//
// every-service-has-a-path proves each tile LEADS somewhere real. Invoice,
// Quote and Proforma proved that is a different question: all three opened a
// perfectly good screen whose submit could never succeed, because the form
// posted to /v1/transactions and the engine refuses those codes. A service can
// look healthy all the way to the final button.
//
// So this measures the join, and measures BOTH halves rather than inferring
// either:
//
//   the engine   scripts/audit-service-journeys.js records, per service code,
//                whether createTransaction accepts or refuses it. Most
//                refusals are correct - a card top-up, a payout and a stokvel
//                contribution each have their own endpoint, and the refusal is
//                the guard working.
//   the app      this file drives every active service in a real browser and
//                WATCHES THE NETWORK. A refusal only matters if the app
//                actually posts that code, and that is observable rather than
//                guessable.
//
// A service is broken when it posts a code the engine refuses. That is exactly
// what Invoice did, and it is the only verdict this file returns, because it
// is the only one it can prove.
//
// Two earlier versions of this audit tried to classify journeys by reading
// app.js, then by guessing from the form's shape. Both produced confident
// wrong answers - one reported "0 broken" while the three broken services sat
// in the list. Nothing is inferred here.
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const VERDICTS = path.join(__dirname, "artifacts", "engine-verdicts.json");
const API_SRC = path.join(__dirname, "..", "api", "src", "services", "service-management-service.js");
const PORT = 8199;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

// The catalogue is READ from the API's own seed, never copied, so this audit
// cannot drift from the list it audits.
function catalogue() {
  const source = fs.readFileSync(API_SRC, "utf8");
  const start = source.indexOf("const DEFAULT_SERVICES = [");
  const end = source.indexOf("\n];", start);
  if (start === -1 || end === -1) throw new Error("DEFAULT_SERVICES not found - the seed moved");
  const rows = source.slice(start, end).split("\n")
    .filter((line) => line.trim().startsWith("["))
    .map((line) => {
      const parts = (line.match(/"([^"]*)"/g) || []).map((v) => v.slice(1, -1));
      return { code: parts[0], name: parts[1], action: parts[3], status: parts[5] };
    })
    .filter((row) => row.code);
  if (rows.length < 20) throw new Error(`only ${rows.length} services parsed - the seed shape changed`);
  return rows;
}

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const USER = (accountType) => ({
  id: "ff330000-4444-4555-8666-777777777777",
  fullName: "Audit Probe", username: "auditprobe",
  email: "audit@titopay.local", phone: "+27820000111",
  accountType, account_type: accountType, status: "active"
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

(async () => {
  if (!fs.existsSync(VERDICTS)) {
    console.error(`\nMissing ${path.relative(process.cwd(), VERDICTS)}.`);
    console.error("Run this first:  cd api && node scripts/audit-service-journeys.js\n");
    process.exit(1);
  }
  const verdicts = JSON.parse(fs.readFileSync(VERDICTS, "utf8"));
  const services = catalogue().filter((s) => s.status === "active");

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  const observed = new Map();   // code -> what it posted, if anything
  const errors = [];

  for (const accountType of ["personal", "business"]) {
    const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
    let posted = null;

    await context.route("https://api.titopay.co.za/**", async (route) => {
      const request = route.request();
      const p = new URL(request.url()).pathname.replace(/^\/v1/, "");
      const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, ...body }) });

      // THE MEASUREMENT. Anything the app sends to the wallet-debit endpoint is
      // recorded, then refused, so no flow proceeds past it.
      if (p === "/transactions" && request.method() === "POST") {
        try { posted = JSON.parse(request.postData() || "{}").serviceCode || "(none)"; }
        catch { posted = "(unparseable)"; }
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "audit stub" }) });
      }
      if (p === "/auth/me") return json({ user: USER(accountType) });
      if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
        available_balance: "5000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
      if (p === "/transactions/fee-preview") return json({ preview: { amount: 50, fee: 2.5, total: 52.5 } });
      if (p === "/chat/notifications") return json({ notifications: [] });
      return json({ items: [] });
    });

    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`${accountType}: ${e.message}`));
    await page.addInitScript((user) => {
      localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
        accessToken: "probe", refreshToken: "probe", user }));
      localStorage.setItem("titopay_last_active_v1", String(Date.now()));
    }, USER(accountType));
    await page.goto(ORIGIN, { waitUntil: "load" });
    await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(1800);

    for (const service of services) {
      posted = null;
      const landed = await page.evaluate(async ({ code }) => {
        // THE REAL CATALOGUE, UNTOUCHED.
        //
        // The first run of this audit injected a synthetic service record to
        // tap. That record carried type:"transaction", which OVERRODE the real
        // type the dispatcher branches on - learn, rewards, stockvel, receive -
        // and forced eight healthy services down the generic path. It reported
        // them as broken. They were not; the harness was.
        //
        // So nothing is injected. A service the app does not carry is reported
        // as absent rather than invented, because a made-up record proves
        // nothing about the real one.
        // Some services are handled by id BEFORE the catalogue is consulted -
        // fica and profile-security just navigate to the profile screen and
        // need no tile. Reporting those as "absent" would undersell a journey
        // that works, so the tap happens either way and absence is recorded
        // only when nothing at all responded.
        const inCatalogue = (state.services || []).some((s) => s.id === code || s.action === code);
        // Reset to a known screen first. Several services navigate to the same
        // place - fica, profile-security and business-profile all go to
        // profile - so leaving the hash where the previous service put it made
        // the second one look like it did nothing at all.
        location.hash = "home";
        await new Promise((r) => setTimeout(r, 120));
        const hashBefore = location.hash;
        if (typeof closeModal === "function") closeModal();
        await new Promise((r) => setTimeout(r, 120));
        let threw = "";
        try { handleService(code); } catch (error) { threw = String(error.message); }
        await new Promise((r) => setTimeout(r, 450));

        // Fill whatever this screen asks for, generically, and submit it. A
        // form that cannot be filled simply does not post, which is recorded
        // as "no wallet post" rather than counted either way.
        const form = document.querySelector(".modal-card form");
        if (form) {
          for (const field of form.querySelectorAll("input:not([type=hidden]), textarea")) {
            if (field.type === "checkbox" || field.type === "radio") continue;
            const name = (field.name || "").toLowerCase();
            field.value = /amount|total|price/.test(name) ? "50"
              : /email/.test(name) ? "probe@example.com"
                : /phone|mobile|msisdn|cell/.test(name) ? "0820000111"
                  : /recipient|identifier|customer|to\b/.test(name) ? "1234567890"
                    : field.type === "number" ? "1" : "Audit probe";
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
          }
          form.requestSubmit ? form.requestSubmit()
            : form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
          await new Promise((r) => setTimeout(r, 700));
          const confirm = document.querySelector('[data-action="confirm-transaction-review"]');
          if (confirm) { confirm.click(); await new Promise((r) => setTimeout(r, 900)); }
        }
        const card = document.querySelector(".modal-card");
        const navigated = location.hash !== hashBefore && location.hash !== "";
        return { threw, navigated, inCatalogue,
          absent: !inCatalogue && !card && !navigated,
          heading: card?.querySelector("h2")?.textContent.trim() || "" };
      }, service);

      const previous = observed.get(service.code) || { postedCodes: new Set(), threw: "", heading: "", absent: 0 };
      if (landed.absent) previous.absent += 1;
      if (posted) previous.postedCodes.add(posted);
      previous.threw = previous.threw || landed.threw;
      previous.heading = previous.heading || landed.heading;
      observed.set(service.code, previous);
    }
    await context.close();
  }

  /* ------------------------------------------------------------- report */

  console.log(`\n  ${services.length} active services, each opened and submitted in a real browser\n`);
  const width = Math.max(...services.map((s) => s.code.length)) + 2;
  const brokenCodes = [];
  for (const service of services) {
    const seen = observed.get(service.code) || { postedCodes: new Set(), absent: 2 };
    const codes = [...seen.postedCodes];
    if (seen.absent === 2) {
      console.log(`    ----   ${service.code.padEnd(width)}no tile and no screen - nothing responded`);
      continue;
    }
    if (!codes.length) {
      console.log(`    ok     ${service.code.padEnd(width)}no wallet post - its own journey`);
      continue;
    }
    const refused = codes.filter((c) => verdicts[String(c).replace(/_/g, "-")]?.verdict === "REFUSES"
      || verdicts[c]?.verdict === "REFUSES");
    if (refused.length) {
      brokenCodes.push(service.code);
      console.log(`    FAIL   ${service.code.padEnd(width)}posts ${refused.join(", ")} - THE ENGINE REFUSES IT`);
    } else {
      console.log(`    ok     ${service.code.padEnd(width)}posts ${codes.join(", ")} - accepted`);
    }
  }

  console.log("");
  ok("NO ACTIVE SERVICE POSTS A CODE THE ENGINE REFUSES", brokenCodes.length === 0,
    brokenCodes.length ? `${brokenCodes.join(", ")} - reachable, fillable, impossible to finish` : "");
  ok("no service threw when opened", [...observed.values()].every((v) => !v.threw),
    [...observed.entries()].filter(([, v]) => v.threw).map(([c, v]) => `${c}: ${v.threw}`).slice(0, 2).join(" | "));
  ok("no page errors across every service, both account types", errors.length === 0,
    errors.slice(0, 1).join(" | "));

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
