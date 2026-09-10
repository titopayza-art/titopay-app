// The wallet card, rendered through the app's own dashboardView() with real
// state, in every verification state — because the chip's whole job is to be
// right in each of them.
const { chromium } = require("playwright");
const http = require("http"); const fs = require("fs"); const path = require("path");
// Harness screenshots go here, not into the repo root. A verification run
// must never leave build artifacts in the working tree; three got committed
// that way before this existed. The directory is gitignored.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });
const PWA="/home/user/titopay-app/pwa"; const PORT=8145;
const T={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",
".webmanifest":"application/manifest+json",".png":"image/png",".jpg":"image/jpeg",".ico":"image/x-icon"};
const srv=http.createServer((q,r)=>{const c=decodeURIComponent(q.url.split("?")[0]);
let f=path.join(PWA,c==="/"?"index.html":c);
if(!f.startsWith(PWA)||!fs.existsSync(f)){r.writeHead(404).end();return;}
if(fs.statSync(f).isDirectory())f=path.join(f,"index.html");
r.writeHead(200,{"Content-Type":T[path.extname(f)]||"application/octet-stream"});fs.createReadStream(f).pipe(r);});
let bad=0; const ok=(l,v,d)=>{if(!v)bad++;console.log(`  ${v?"PASS":"FAIL"}  ${l}${d!==undefined?": "+d:""}`);};

const STATES = [
  ["unknown (still loading)", null, "Limits", "quiet"],
  ["not verified",            {tier:0,verified:false}, "Verify", "warn"],
  ["basic",                   {tier:1,verified:false}, "Basic", "quiet"],
  ["fully verified",          {tier:2,verified:true},  "Verified", "quiet"],
  ["under review",            {tier:1,verified:false,eddActive:true}, "In review", "warn"],
  ["API state fully_verified",  {verificationState:"fully_verified",verificationLabel:"\u2713 Fully Verified"}, "Verified", "quiet"],
  ["API label it does not know", {verificationState:"basic_verified",verificationLabel:"Provisional"}, "Provisional", "quiet"],
  ["an API state it does not know", {verificationState:"brand_new_state",verificationLabel:"Something new"}, "Something new", "warn"],
];

(async()=>{
await new Promise(r=>srv.listen(PORT,"127.0.0.1",r));
const b=await chromium.launch({executablePath:"/opt/pw-browsers/chromium",args:["--no-sandbox"]});
const p=await b.newPage({viewport:{width:430,height:932},deviceScaleFactor:2});
const errs=[]; p.on("pageerror",e=>errs.push(String(e.message)));
let compliancePayload = null;
// A signed-in session, so loadAccount() runs and puts a real wallet into
// state. Without one the card renders its "Generating" branch, which is
// correct behaviour but not the branch under test.
await p.addInitScript(() => {
  localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
    accessToken: "harness", refreshToken: "harness", accountType: "personal" }));
  // The 10-minute idle gate discards a session with no recent activity stamp,
  // which is exactly what it is for — the harness has to look like a live app.
  localStorage.setItem("titopay_last_active_v1", String(Date.now()));
});
await p.route("**/api.titopay.co.za/**", (r) => {
  const path = new URL(r.request().url()).pathname;
  let body = { ok: true, items: [] };
  if (path === "/v1/auth/me") body = { ok: true, user: { id: "u1", fullName: "Thuso", username: "thuso", accountType: "personal" } };
  else if (path === "/v1/wallets") body = { ok: true, items: [{ id: "w1", kind: "personal", currency: "ZAR",
    available_balance: 2932.8, wallet_number: "9152641376", status: "active" }] };
  if (/compliance\/status/.test(path)) {
    // null means "has not answered yet". Fulfilling with {} would make
    // state.compliance truthy and so could never represent the pending state
    // the neutral chip exists for — the first run of this harness measured
    // exactly that and reported a failure that was its own.
    if (!compliancePayload) return r.abort();
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(compliancePayload) });
  }
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
});
await p.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:"load"}); await p.waitForTimeout(2500);

// Drive the app's OWN loaders rather than poking at state, which is a module
// const and deliberately not reachable. The route stub decides what
// /v1/compliance/status and /v1/wallets answer; loadComplianceStatus() and
// loadAccount() then put it into state exactly as they do in production.
const paint = async (compliance) => {
  compliancePayload = compliance;
  await p.evaluate(async () => {
    await window.syncTitoPayAccountStatus?.({ silent: true });
    await window.loadComplianceStatus?.({ silent: true });
    document.getElementById("app").innerHTML = window.dashboardView();
  });
  await p.waitForTimeout(150);
};

for (const [name, compliance, expectLabel, expectTone] of STATES) {
  await paint(compliance);
  const chip = await p.evaluate(() => {
    const el = document.querySelector(".wallet-verify");
    return el ? { label: el.textContent.trim(),
      tone: el.classList.contains("needs-action") ? "warn" : "quiet" } : null;
  });
  const good = chip && chip.label === expectLabel && chip.tone === (expectTone || "quiet");
  ok(`${name} reads "${expectLabel}"`, good, chip ? `"${chip.label}" (${chip.tone})` : "MISSING");
}

// Structure checks on the default paint.
await paint({ tier: 0, verified: false });
const s = await p.evaluate(() => {
  const card = document.querySelector(".wallet-card");
  const chip = document.querySelector(".wallet-verify");
  const id = document.querySelector(".wallet-id-line");
  return {
    chipInHeader: !!(chip && chip.closest(".wallet-card-top")),
    chipTap: chip ? chip.getBoundingClientRect().height : 0,
    // Slop check: the affordance is TYPE PLUS ONE ARROW, not a component.
    //
    // It used to require zero children, because the chip was bare type with an
    // underline. The underline is gone - on a saturated blue card a 1px rule at
    // 28% white read as a stray mark rather than a link - and an arrow says the
    // same thing while pointing the way the control goes. So the budget is one
    // label and one arrow: still no dot, no border, no fill, and crucially no
    // underline, which is what this now guards against coming back.
    //
    // Both of these were declared twice in this object, so the first pair never
    // ran. Consolidated while correcting them.
    oldStrip: !!document.querySelector(".wallet-verification"),
    noOrnament: (() => {
      const v = document.querySelector(".wallet-verify");
      if (!v) return false;
      const cs = getComputedStyle(v);
      return v.children.length === 1 + v.querySelectorAll("svg").length
        && v.querySelectorAll("svg").length === 1
        && cs.textDecorationLine === "none"
        && cs.borderTopWidth === "0px"
        && cs.backgroundImage === "none"
        && cs.backgroundColor === "rgba(0, 0, 0, 0)";
    })(),
    ornament: (() => {
      const v = document.querySelector(".wallet-verify");
      if (!v) return "missing";
      const cs = getComputedStyle(v);
      return `children=${v.children.length} svg=${v.querySelectorAll("svg").length} `
        + `decoration=${cs.textDecorationLine} border=${cs.borderTopWidth} bg=${cs.backgroundColor}`;
    })(),
    idCopyable: !!(id && id.tagName === "BUTTON" && id.dataset.copyValue),
    idTag: id ? id.tagName : "none",
    idText: id ? id.textContent.trim().replace(/\s+/g," ") : "",
    bal: (document.querySelector(".wallet-balance")||{}).textContent || "",
    idTag: id ? id.tagName : "none", idText: id ? id.textContent.trim() : "",
    walletCount: (window.__wc = (document.querySelector(".wallet-balance")||{}).textContent) || "",
    actions: document.querySelectorAll(".wallet-actions-compact button").length,
    cardBg: getComputedStyle(card).backgroundImage.slice(0, 30),
    sheen: getComputedStyle(card, "::before").content,
  };
});
console.log("");
ok("the verification affordance is in the card header", s.chipInHeader);
ok("it is one word and one arrow: no badge, no dot, no underline", s.noOrnament, s.ornament);
ok("it is a real tap target", s.chipTap >= 30, `${Math.round(s.chipTap)}px tall`);
ok("the old full-width strip is gone", !s.oldStrip);
ok("the wallet ID is tap-to-copy", s.idCopyable, `${s.idTag||"?"} "${s.idText||""}" bal="${s.bal||""}"`);
ok("Top Up and Withdraw are untouched", s.actions === 2, String(s.actions));
ok("the card has a gradient, not a flat fill", /gradient/.test(s.cardBg), s.cardBg);
ok("the sheen is painting", s.sheen !== "none", s.sheen);
ok("no page errors", errs.length === 0, errs.join(" | "));

await p.locator(".wallet-card").screenshot({path:`${ARTIFACTS}/wallet-card.png`});
await b.close(); srv.close();
console.log(bad?`\n${bad} check(s) failed`:"\nall checks passed"); process.exit(bad?1:0);})();
