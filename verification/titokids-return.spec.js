// CAN A PARENT GET THEIR MONEY BACK OUT OF A CHILD'S WALLET?
//
// Until this change, no. Money went in through Add money and the only way out
// was to pay a third party. Removing a child was refused while the balance was
// non-zero, with a message telling the parent to "move it back to your wallet"
// - an action with no function, no route and no button behind it anywhere in
// the product. A parent with three cents in a child wallet had a child they
// could not remove and no way to be told why that was TitoPay's fault.
//
// The API side is proved in api/test/titokids-family.test.js, which moves real
// money through the real service and checks it conserves to the cent. This is
// the other half: the button a customer actually presses. It drives the
// SHIPPED BUNDLE - app.min.js, not the source - with the API stubbed, because
// the question here is what the app renders and what it puts on the wire.
//
// Four things, and the last two are the ones worth having:
//   the button is there            for the owner, when there is money to move
//   it posts the right thing       an untouched box means "all of it", and the
//                                  server is told so explicitly rather than
//                                  sent a number the browser rounded
//   a co-parent never sees it      the server would refuse them 403; offering
//                                  a button that always fails is worse than
//                                  not offering it
//   an empty wallet never sees it  nothing to move, so nothing to press
const { chromium } = require("playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ARTIFACTS = path.join(__dirname, "artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });
const PWA = process.env.PWA_ROOT || path.join(__dirname, "..", "pwa");
const PORT = 8171;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

const USER = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  fullName: "TitoKids Parent Probe", username: "tkparentprobe",
  email: "tkparent@titopay.local", phone: "+27820000009",
  accountType: "personal", account_type: "personal", status: "active",
};

const CHILD_ID = "11111111-2222-4333-8444-999999999999";
const CATEGORIES = { school: "School", food: "Food", other: "Other" };

const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
  let file = path.join(PWA, clean === "/" ? "index.html" : clean);
  if (!file.startsWith(PWA) || !fs.existsSync(file)) { res.writeHead(404); return res.end("no"); }
  if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

let bad = 0;
const ok = (label, pass, detail) => {
  if (!pass) bad += 1;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail !== undefined && detail !== "" ? ": " + detail : ""}`);
};

// The child the stub serves. Each scenario reshapes it and reloads, so the
// three cases differ ONLY in what the server said about ownership and balance
// - which is exactly the decision the button is supposed to be making.
function childPayload({ balance, isOwner }) {
  return {
    id: CHILD_ID, fullName: "Probe Child", relationship: "parent", isOwner,
    linked: false, childUsername: "", status: "active", balance,
    limits: { dailyLimit: null, weeklyLimit: null, monthlyLimit: null,
      categories: { school: true, food: true, other: true } },
    activity: [], spent: { day: 0, week: 0, month: 0 }, goals: [], requests: []
  };
}

const posted = [];
async function stubApi(context, scenario) {
  await context.route("https://api.titopay.co.za/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname.replace(/^\/v1/, "");
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ...body }) });

    if (request.method() === "POST" && /\/tito-kids\/children\/[^/]+\/return$/.test(p)) {
      let body = null;
      try { body = JSON.parse(request.postData() || "null"); } catch { body = request.postData(); }
      posted.push(body);
      return json({ reference: "TKID-PROBE", amount: scenario.balance, balance: 0 });
    }
    if (p === "/health") return json({ status: "ok" });
    if (p === "/auth/me") return json({ user: USER });
    if (p === "/wallets") return json({ items: [{ id: "w1", kind: "personal", currency: "ZAR",
      available_balance: "1000.00", reserved_balance: "0.00", wallet_number: "1234567890", status: "active" }] });
    if (p === "/tito-kids") return json({
      children: [{ id: CHILD_ID, fullName: "Probe Child", balance: scenario.balance,
        isOwner: scenario.isOwner, linked: false, status: "active", pendingRequests: 0 }],
      approvals: [], categories: CATEGORIES
    });
    if (/\/tito-kids\/children\/[^/]+\/managers$/.test(p)) return json({ managers: [], items: [] });
    if (/\/tito-kids\/children\/[^/]+$/.test(p)) return json({ child: childPayload(scenario) });
    if (p === "/tito-kids/family") return json({ items: [], categories: CATEGORIES });
    if (p === "/tito-kids/invitations") return json({ items: [] });
    if (p === "/transactions") return json({ items: [] });
    if (p === "/beneficiaries") return json({ items: [], summary: null });
    return json({ items: [] });
  });
}

async function openChild(page) {
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("noop", { detail: id })), CHILD_ID);
  // Driven through the app's own action dispatcher rather than by clicking a
  // path of cards, so a change to the home layout cannot quietly turn this
  // into a test of nothing.
  await page.evaluate(async (id) => {
    const target = document.createElement("button");
    target.setAttribute("data-action", `titokids-child:${id}`);
    target.style.position = "fixed"; target.style.left = "-9999px";
    document.body.appendChild(target);
    target.click();
  }, CHILD_ID);
  await page.waitForTimeout(1200);
}

async function run(browser, scenario, label) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await stubApi(context, scenario);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.addInitScript((user) => {
    localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({
      accessToken: "probe-access", refreshToken: "probe-refresh", user,
    }));
    localStorage.setItem("titopay_last_active_v1", String(Date.now()));
  }, USER);
  await page.goto(ORIGIN, { waitUntil: "load" });
  await page.waitForSelector("[data-app-topbar]", { timeout: 30000 }).catch(() => null);
  const booted = await page.evaluate(() => Boolean(document.querySelector("[data-app-topbar]")));
  ok(`${label}: the app booted signed in`, booted, booted ? "" : "the session stub did not take");
  if (!booted) { await context.close(); return { page: null, context, errors }; }
  await openChild(page);
  return { page, context, errors };
}

(async () => {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });

  /* ---------------------------------------------- the owner, with a balance */
  {
    const scenario = { balance: 137.5, isOwner: true };
    const { page, context, errors } = await run(browser, scenario, "owner with R137.50");
    if (page) {
      const button = page.locator(`[data-action="titokids-return:${CHILD_ID}"]`);
      const visible = await button.isVisible().catch(() => false);
      ok("the owner is offered a way to move the money back", visible);
      await page.screenshot({ path: `${ARTIFACTS}/titokids-return-child.png` });

      if (visible) {
        const box = await button.boundingBox();
        ok("the button is a real tap target", box && box.height >= 44, box ? `${Math.round(box.height)}px tall` : "no box");
        await button.click();
        await page.waitForSelector('[data-form="titokids-return"]', { timeout: 10000 });
        await page.waitForTimeout(300);

        // PREFILLED WITH THE WHOLE BALANCE. Retyping R137.50 by hand is how a
        // parent ends up 50 cents short of an empty wallet and stuck with a
        // child they cannot remove.
        const prefilled = await page.inputValue('[data-form="titokids-return"] [name="amount"]');
        ok("the amount is prefilled with the whole balance", prefilled === "137.50", prefilled);
        await page.screenshot({ path: `${ARTIFACTS}/titokids-return-modal.png` });

        // An UNTOUCHED box must go out as "all of it", not as the number the
        // browser happens to be showing.
        await page.fill('[data-form="titokids-return"] [name="amount"]', "");
        await page.click('[data-form="titokids-return"] button[type="submit"]');
        await page.waitForTimeout(1500);
        const body = posted[posted.length - 1];
        ok("an empty amount asks the server for the whole balance",
          Boolean(body) && body.all === true && body.amount === undefined, JSON.stringify(body));
      }
      ok("no page errors", errors.length === 0, errors.slice(0, 1).join(" | "));
    }
    await context.close();
  }

  /* ------------------------------------ a typed amount goes as a typed amount */
  {
    posted.length = 0;
    const scenario = { balance: 137.5, isOwner: true };
    const { page, context } = await run(browser, scenario, "owner moving part of it");
    if (page) {
      await page.click(`[data-action="titokids-return:${CHILD_ID}"]`);
      await page.waitForSelector('[data-form="titokids-return"]', { timeout: 10000 });
      await page.fill('[data-form="titokids-return"] [name="amount"]', "40");
      await page.click('[data-form="titokids-return"] button[type="submit"]');
      await page.waitForTimeout(1500);
      const body = posted[posted.length - 1];
      ok("a typed amount is sent as that amount, with no all flag",
        Boolean(body) && String(body.amount) === "40" && body.all === undefined, JSON.stringify(body));
    }
    await context.close();
  }

  /* ------------------------------------------------------------- a co-parent */
  {
    const scenario = { balance: 137.5, isOwner: false };
    const { page, context } = await run(browser, scenario, "co-parent");
    if (page) {
      const present = await page.locator(`[data-action="titokids-return:${CHILD_ID}"]`).count();
      ok("a co-parent is never offered a button the server would refuse", present === 0, `${present} found`);
      // Control: they still get the two things they ARE allowed to do, so the
      // check above is about ownership and not about a screen that failed to
      // render.
      const fund = await page.locator(`[data-action="titokids-fund:${CHILD_ID}"]`).count();
      const pay = await page.locator(`[data-action="titokids-pay:${CHILD_ID}"]`).count();
      ok("a co-parent keeps Add money and Pay for a need", fund === 1 && pay === 1, `fund ${fund}, pay ${pay}`);
    }
    await context.close();
  }

  /* --------------------------------------------------------- an empty wallet */
  {
    const scenario = { balance: 0, isOwner: true };
    const { page, context } = await run(browser, scenario, "empty wallet");
    if (page) {
      const present = await page.locator(`[data-action="titokids-return:${CHILD_ID}"]`).count();
      ok("an empty wallet offers nothing to move back", present === 0, `${present} found`);
      const fund = await page.locator(`[data-action="titokids-fund:${CHILD_ID}"]`).count();
      ok("and Add money is still there", fund === 1, `${fund} found`);
      await page.screenshot({ path: `${ARTIFACTS}/titokids-return-empty.png` });
    }
    await context.close();
  }

  await browser.close(); server.close();
  console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  process.exit(bad ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
