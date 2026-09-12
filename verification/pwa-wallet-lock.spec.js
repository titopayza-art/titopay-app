// The two Profile security journeys customers actually use, driven end to end
// against the shipped bundle:
//   1. Profile -> Security Centre -> Authentication Method  (choose the OTP method)
//   2. Profile -> Security Centre -> Lock Wallet -> Unlock Wallet
//
// Locking is the customer's own action and it must keep working exactly as it
// always has. Freezing is the admin portal's separate action and is not
// exercised here.
const { chromium } = require("playwright");
// Harness screenshots go here, not into the repo root. A verification run
// must never leave build artifacts in the working tree; three got committed
// that way before this existed. The directory is gitignored.
const ARTIFACTS = require("path").join(__dirname, "artifacts");
require("fs").mkdirSync(ARTIFACTS, { recursive: true });
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";

const stamp = Date.now();
const USER = {
  fullName: "Lock Probe",
  email: `lock${stamp}@titopay.local`,
  phone: `+2789${String(stamp).slice(-7)}`,
  password: "LockProbe!2026#x",
  accountType: "personal"
};

const results = [];
const check = (n, p, d = "") => { results.push({ n, p }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };

(async () => {
  const reg = await fetch(`${API}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(USER) }).then((r) => r.json());
  const auth = reg.accessToken ? reg : await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: USER.email, password: USER.password }) }).then((r) => r.json());

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  await ctx.addInitScript(([a, r]) => {
    localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
  }, [auth.accessToken, auth.refreshToken]);
  await ctx.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
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
  // lockWallet() asks for confirmation with a native confirm(); Playwright
  // dismisses dialogs by default, which silently cancels the freeze.
  page.on("dialog", (d) => { console.log(`  ..    native confirm: "${d.message().slice(0, 70)}…" -> accepting`); d.accept().catch(() => {}); });
  await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
  await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1800);

  await page.evaluate(() => { location.hash = "profile"; });
  await page.waitForTimeout(1500);

  const profileRow = await page.evaluate(() => {
    const el = document.querySelector('[data-action="security-centre"]');
    return el ? (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 90) : "";
  });
  check("Profile offers Security Centre", Boolean(profileRow), profileRow);

  const openCentre = async () => {
    await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); });
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('[data-action="security-centre"]')?.click());
    await page.waitForTimeout(1500);
  };

  /* ---- 1. the OTP / authentication method chooser ------------------------ */
  console.log("\n--- Authentication method ---\n");
  await openCentre();
  const methodRow = await page.evaluate(() => {
    const el = document.querySelector('[data-action="authentication-preference"]');
    return el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
  });
  check("Security Centre offers Authentication Method", Boolean(methodRow), methodRow);

  await page.evaluate(() => document.querySelector('[data-action="authentication-preference"]')?.click());
  await page.waitForTimeout(1600);
  const chooser = await page.evaluate(() => {
    const modal = document.querySelector(".modal-backdrop .modal-card");
    const inputs = modal ? Array.from(modal.querySelectorAll("input[type=radio], input[type=checkbox], select, button[data-auth-method], [data-action]")) : [];
    return {
      open: Boolean(modal),
      text: (modal?.innerText || "").replace(/\n+/g, " | ").slice(0, 600),
      choices: inputs.map((el) => el.value || el.dataset.action || el.name).filter(Boolean).slice(0, 20)
    };
  });
  check("choosing the authentication method opens its own screen", chooser.open, chooser.text.slice(0, 160));
  check("it offers more than one method to pick from", chooser.choices.length > 1, chooser.choices.join(", "));
  await page.screenshot({ path: `${ARTIFACTS}/pwa-auth-method.png`, fullPage: true });

  /* ---- 2. freeze and unlock the wallet ----------------------------------- */
  console.log("\n--- Lock and unlock ---\n");
  await openCentre();
  const lockRow = await page.evaluate(() => {
    const el = document.querySelector('[data-action="lock-wallet"]');
    return el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
  });
  check("Security Centre offers Lock Wallet while unlocked", Boolean(lockRow), lockRow);

  await page.evaluate(() => document.querySelector('[data-action="lock-wallet"]')?.click());
  await page.waitForTimeout(2500);
  const flipped = await page.evaluate(() => isWalletLocked());
  check("confirming the lock actually locks the wallet", flipped === true, `isWalletLocked()=${flipped}`);
  await page.screenshot({ path: `${ARTIFACTS}/pwa-wallet-lock.png`, fullPage: true });

  await openCentre();
  const unlockRow = await page.evaluate(() => {
    const el = document.querySelector('[data-action="unlock-wallet"]');
    return el ? (el.innerText || "").replace(/\s+/g, " ").trim() : "";
  });
  check("the row becomes Unlock Wallet once the wallet is locked", Boolean(unlockRow), `locked=${flipped} row="${unlockRow}"`);

  if (unlockRow) {
    await page.evaluate(() => document.querySelector('[data-action="unlock-wallet"]')?.click());
    await page.waitForTimeout(1600);
    const unlockScreen = await page.evaluate(() => (document.querySelector(".modal-backdrop .modal-card")?.innerText || "").replace(/\n+/g, " | ").slice(0, 400));
    check("Unlock Wallet opens the OTP verification screen", /otp|one-time|code|verify/i.test(unlockScreen), unlockScreen.slice(0, 170));
    await page.screenshot({ path: `${ARTIFACTS}/pwa-wallet-unlock.png`, fullPage: true });
  }

  const usesAdminWord = await page.evaluate(() => /freeze|frozen/i.test(document.body.innerText || ""));
  check("the customer app never says freeze — that is the admin's word", usesAdminWord === false);

  check("no script errors during any of it", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERR", e); process.exit(2); });
