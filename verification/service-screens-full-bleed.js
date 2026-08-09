// Photograph the services that were NOT full-screen before, at the exact
// viewport the reported screenshots came from, so the change can be judged
// where it was complained about.
const { chromium } = require("playwright");
const crypto = require("crypto");
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";

const stamp = Date.now();
const tail = String(stamp).slice(-7);
const PASSWORD = "SvcShots!2026#x";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRateLimit(send) {
  for (let i = 0; i < 6; i += 1) {
    const r = await send();
    if (r.status !== 429) return r;
    const wait = Number(r.payload?.retryAfterSeconds) || 15;
    console.log(`  ...rate limited, waiting ${wait + 2}s`);
    await sleep((wait + 2) * 1000);
  }
  throw new Error("still rate limited");
}
async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return withRateLimit(async () => {
    const r = await fetch(`${API}${path}`, {
      method: options.method || "GET", headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await r.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    return { status: r.status, payload };
  });
}
async function register(kind, label, prefix) {
  const body = { fullName: label, email: `${kind}${tail}@titopay.local`, phone: `+27${prefix}${tail}`, password: PASSWORD, accountType: "personal" };
  const reg = await call("/auth/register", { method: "POST", body });
  if (reg.payload.accessToken) return { ...body, ...reg.payload };
  return { ...body, ...(await call("/auth/login", { method: "POST", body: { identifier: body.email, password: PASSWORD } })).payload };
}
async function fundWallet(token, amount) {
  const key = `svc-${stamp}-${amount}-${crypto.randomBytes(3).toString("hex")}`;
  const created = await call("/payments/topup", { token, method: "POST", headers: { "idempotency-key": key }, body: { amount, currency: "ZAR", idempotencyKey: key } });
  if (!created.payload.checkoutId) return;
  await fetch(`${PEACH}/__complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkoutId: created.payload.checkoutId, outcome: "successful" }) });
  for (let i = 0; i < 15; i += 1) {
    const s = await call(`/payments/topup/${encodeURIComponent(created.payload.reference)}`, { token });
    if (s.payload.status === "completed") return;
    await sleep(300);
  }
}

(async () => {
  const user = await register("svc", "Service Screens", "79");
  await fundWallet(user.accessToken, 900);
  console.log("  cooling down so the rate-limit window resets...");
  await sleep(65000);

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  // iPhone 15 Pro, which is where the screenshots came from.
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [user.accessToken, user.refreshToken]);
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const rq = route.request();
    const target = rq.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
    try {
      const up = await fetch(target, { method: rq.method(), headers: { ...rq.headers(), host: undefined }, body: ["GET", "HEAD"].includes(rq.method()) ? undefined : rq.postData() || undefined });
      route.fulfill({ status: up.status, headers: { "content-type": up.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" }, body: await up.text() });
    } catch { route.fulfill({ status: 502, contentType: "application/json", body: "{}" }); }
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
  await sleep(1500);

  // A screen is full-bleed when its card fills the viewport and shows no
  // backdrop above it. Measure rather than eyeball.
  const measure = async (name) => {
    const m = await page.evaluate(() => {
      const card = document.querySelector(".modal-backdrop > .modal-card");
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return {
        top: Math.round(r.top), left: Math.round(r.left),
        width: Math.round(r.width), height: Math.round(r.height),
        vw: window.innerWidth, vh: window.innerHeight,
        radius: getComputedStyle(card).borderTopLeftRadius
      };
    });
    const full = m && m.top <= 1 && m.left <= 1 && m.width >= m.vw - 1 && m.height >= m.vh - 1;
    console.log(`  ${full ? "FULL " : "PART "} ${name.padEnd(26)} ${m ? `${m.width}x${m.height} at (${m.left},${m.top}) of ${m.vw}x${m.vh}, radius ${m.radius}` : "no modal"}`);
    await page.screenshot({ path: `svc-${name}.png` });
    return full;
  };

  const results = [];
  const open = async (name, fn) => {
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
    await sleep(400);
    await page.evaluate(fn).catch(() => {});
    await sleep(1600);
    results.push([name, await measure(name)]);
  };

  // Every service the customer can actually open, by its real id.
  // "transactions" and "profile-security" navigate to full pages rather than
  // opening a modal, so there is nothing here to make full-screen.
  const SERVICES = [
    "airtime", "airtime-data", "data", "electricity", "voucher", "pay-bills",
    "payment-request", "bill-split", "send-gift", "statements",
    "refund", "learn", "tip"
  ];
  await open("stokvel", () => openStockvelModal());
  await open("my-tickets", () => openMyTicketsModal());
  await open("events", () => openPersonalTicketsDashboard());
  await open("receive", () => openReceiveModal());
  await open("qr-pay", () => openQrPayModal());
  for (const id of SERVICES) {
    await open(id, new Function("return handleService(" + JSON.stringify(id) + ")"));
  }

  console.log("\n  script errors: " + (errors.length ? errors.slice(0, 3).join(" | ") : "none"));
  const part = results.filter(([, full]) => !full).map(([n]) => n);
  console.log("  not full-bleed: " + (part.length ? part.join(", ") : "none"));
  await browser.close();
  process.exit(part.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
