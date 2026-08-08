// Once Customer Care has been asked for, the escalation card — Start Live
// Chat, Request a Callback, Continue Waiting — must stay put.
//
// It is rendered INTO .chat-thread, and the support poll rebuilds that thread
// from the server every four seconds with replaceChildren(). That wipes every
// child, the card included, so the buttons vanish from under the customer's
// finger and reappear later somewhere else. This watches the card for a full
// minute — fifteen poll cycles — and fails if it ever disappears or moves.
const { chromium } = require("playwright");
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";

const stamp = Date.now();
const USER = {
  fullName: "Escalation Watch",
  email: `esc${stamp}@titopay.local`,
  phone: `+2782${String(stamp).slice(-7)}`,
  password: "Escalation!2026#x",
  accountType: "personal"
};

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket connection to .wss:\/\/api\.titopay\.co\.za/;

const WATCH_MS = 60000;   // fifteen four-second poll cycles
const SAMPLE_MS = 500;

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — the Customer Care escalation card stays put");
  console.log("=============================================================\n");

  const reg = await fetch(`${API}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(USER) }).then((r) => r.json());
  const auth = reg.accessToken ? reg : await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: USER.email, password: USER.password }) }).then((r) => r.json());
  check("customer signed in", Boolean(auth.accessToken));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [auth.accessToken, auth.refreshToken]);

  // Count requests that reach the API without an Authorization header. The
  // production log showed a steady drip of 401 "Bearer token required" while
  // this screen was open.
  let unauthenticated = 0;
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    if (!request.headers().authorization && !/\/(services|maintenance|health)/.test(request.url())) unauthenticated += 1;
    const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: undefined },
        body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
      });
      route.fulfill({ status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" }, body: await upstream.text() });
    } catch (e) { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1200);

  await page.evaluate(() => handleAction("chatbot"));
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const chip = Array.from(document.querySelectorAll(".chatbot-suggestions .chip")).find((c) => c.textContent.trim() === "Speak to Customer Care");
    chip?.click();
  });
  await page.waitForTimeout(3000);

  const appeared = await page.evaluate(() => {
    const card = document.querySelector(".support-escalation");
    return { present: Boolean(card), buttons: card ? card.querySelectorAll("[data-support-escalation]").length : 0 };
  });
  check("asking for Customer Care shows the escalation card", appeared.present && appeared.buttons === 3,
    `${appeared.buttons} buttons`);

  console.log(`\n  watching the card for ${WATCH_MS / 1000}s (the support poll runs every 4s)...\n`);
  const samples = await page.evaluate(([windowMs, everyMs]) => new Promise((resolve) => {
    const out = [];
    const read = () => {
      const card = document.querySelector(".support-escalation");
      if (!card) return { present: false };
      const rect = card.getBoundingClientRect();
      const live = Array.from(card.querySelectorAll("[data-support-escalation]"));
      const chat = live.find((b) => b.dataset.supportEscalation === "live_chat");
      const chatRect = chat ? chat.getBoundingClientRect() : null;
      return {
        present: true,
        buttons: live.length,
        y: Math.round(rect.y),
        liveChatY: chatRect ? Math.round(chatRect.y) : null,
        // Is the middle of Start Live Chat actually that button right now?
        hittable: chatRect ? (() => {
          const el = document.elementFromPoint(chatRect.x + chatRect.width / 2, chatRect.y + chatRect.height / 2);
          return Boolean(el && (el === chat || chat.contains(el)));
        })() : false
      };
    };
    let n = 0;
    const timer = setInterval(() => {
      out.push({ at: (n * everyMs) / 1000, ...read() });
      n += 1;
      if (n * everyMs >= windowMs) { clearInterval(timer); resolve(out); }
    }, everyMs);
  }), [WATCH_MS, SAMPLE_MS]);

  const vanished = samples.filter((s) => !s.present);
  check("the card never disappears", vanished.length === 0,
    vanished.length ? `gone in ${vanished.length}/${samples.length} samples, first at t=${vanished[0].at}s` : `${samples.length} samples`);

  const present = samples.filter((s) => s.present);
  const lostButtons = present.filter((s) => s.buttons !== 3);
  check("all three buttons are there the whole time", lostButtons.length === 0,
    lostButtons.length ? `first bad at t=${lostButtons[0].at}s with ${lostButtons[0].buttons}` : "");

  const firstY = present[0]?.liveChatY;
  const jumped = present.filter((s) => Math.abs(s.liveChatY - firstY) > 1);
  check("Start Live Chat never moves", jumped.length === 0,
    jumped.length ? `moved in ${jumped.length}/${present.length} samples, first at t=${jumped[0].at}s (${firstY} -> ${jumped[0].liveChatY})` : `steady at y=${firstY}`);

  const unhittable = present.filter((s) => !s.hittable);
  check("Start Live Chat is tappable at every moment", unhittable.length === 0,
    unhittable.length ? `not hittable in ${unhittable.length}/${present.length} samples` : "");

  check("nothing calls the API without a token while the chat is open", unauthenticated === 0,
    `${unauthenticated} unauthenticated request(s)`);

  await page.screenshot({ path: "pwa-support-escalation.png" });
  check("no script errors", errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));

  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
