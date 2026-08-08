// The Customer Care chatbot's quick-help options must be reachable and
// tappable on a phone.
//
// They used to sit on one horizontal line 3467px wide inside a 364px viewport
// — one and a half chips visible, the other fifteen off-screen behind a
// momentum-scrolling strip, and "Speak to Customer Care" at position fifteen.
// A tap during the glide landed on the wrong chip or was swallowed as the
// start of another swipe.
const { chromium } = require("playwright");
const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";

const stamp = Date.now();
const USER = {
  fullName: "Chat Options",
  email: `chatopt${stamp}@titopay.local`,
  phone: `+2786${String(stamp).slice(-7)}`,
  password: "ChatOptions!2026#x",
  accountType: "personal"
};

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket connection to .wss:\/\/api\.titopay\.co\.za/;

// Phones this app is actually used on, smallest first.
const VIEWPORTS = [
  { name: "small Android (360x640)", width: 360, height: 640 },
  { name: "iPhone (390x844)", width: 390, height: 844 },
  { name: "large phone (430x932)", width: 430, height: 932 }
];

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — Customer Care quick-help options are tappable");
  console.log("=============================================================\n");

  const reg = await fetch(`${API}/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(USER) }).then((r) => r.json());
  const auth = reg.accessToken ? reg : await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: USER.email, password: USER.password }) }).then((r) => r.json());
  check("customer signed in", Boolean(auth.accessToken));

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

  for (const viewport of VIEWPORTS) {
    console.log(`\n--- ${viewport.name} ---\n`);
    const ctx = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2, isMobile: true, hasTouch: true
    });
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
    page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
    await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && typeof render === "function", null, { timeout: 25000 });
    await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    await page.evaluate(() => handleAction("chatbot"));
    await page.waitForTimeout(1800);

    const geometry = await page.evaluate(() => {
      const row = document.querySelector(".chatbot-suggestions");
      const chips = Array.from(document.querySelectorAll(".chatbot-suggestions .chip"));
      const compose = document.querySelector(".chatbot-compose");
      return {
        chips: chips.length,
        scrollWidth: row?.scrollWidth,
        clientWidth: row?.clientWidth,
        scrollHeight: row?.scrollHeight,
        clientHeight: row?.clientHeight,
        composeVisible: compose ? compose.getBoundingClientRect().bottom <= window.innerHeight + 1 : false
      };
    });

    check(`${viewport.name}: the options never scroll sideways`,
      geometry.scrollWidth <= geometry.clientWidth + 1,
      `${geometry.scrollWidth}px of content in a ${geometry.clientWidth}px row`);

    // The check that matters. Capping the block and letting it scroll simply
    // moved the problem: the first two options sat above the fold, and tapping
    // one near the bottom scrolled them further away. Every option must be on
    // screen at once, with nothing to scroll in either direction.
    check(`${viewport.name}: no option is hidden — the block does not scroll at all`,
      geometry.scrollHeight <= geometry.clientHeight + 1,
      `${geometry.scrollHeight}px of options in a ${geometry.clientHeight}px block`);

    check(`${viewport.name}: the message box stays on screen`, geometry.composeVisible);

    // Every option must be reachable by scrolling the block vertically, and
    // the point a finger lands on must belong to that option.
    // Hit-test every option WITHOUT scrolling anything first. Scrolling to
    // reach an option is the behaviour being removed, so a test that scrolls
    // would hide the very fault it is meant to catch.
    const reach = await page.evaluate(async () => {
      const row = document.querySelector(".chatbot-suggestions");
      const chips = Array.from(row.querySelectorAll(".chip"));
      const unreachable = [];
      for (const chip of chips) {
        const rect = chip.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        if (hit !== chip && !chip.contains(hit)) unreachable.push(chip.textContent.trim());
        if (rect.height < 40) unreachable.push(`${chip.textContent.trim()} (only ${Math.round(rect.height)}px tall)`);
      }
      return { total: chips.length, unreachable };
    });
    check(`${viewport.name}: all ${reach.total} options can be reached and hit`,
      reach.unreachable.length === 0, reach.unreachable.slice(0, 3).join(" | "));

    // Tapping the one people need most must send that question, not its neighbour.
    const wanted = "Speak to Customer Care";
    const tapped = await page.evaluate(async (label) => {
      const chip = Array.from(document.querySelectorAll(".chatbot-suggestions .chip")).find((c) => c.textContent.trim() === label);
      if (!chip) return { ok: false, why: "option missing" };
      const rect = chip.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { ok: hit === chip || chip.contains(hit), landedOn: (hit?.textContent || "").trim().slice(0, 40) };
    }, wanted);
    check(`${viewport.name}: tapping "${wanted}" hits that option`, tapped.ok, tapped.why || `landed on "${tapped.landedOn}"`);

    if (tapped.ok) {
      const positionsBefore = await page.evaluate(() => Array.from(document.querySelectorAll(".chatbot-suggestions .chip")).map((c) => Math.round(c.getBoundingClientRect().y)));
      await page.evaluate((label) => {
        const chip = Array.from(document.querySelectorAll(".chatbot-suggestions .chip")).find((c) => c.textContent.trim() === label);
        chip?.click();
      }, wanted);
      await page.waitForTimeout(2000);
      const sent = await page.evaluate(() => (document.querySelector(".chatbot-fullscreen-modal .chat-thread")?.innerText || ""));
      check(`${viewport.name}: it puts that question into the conversation`, sent.includes(wanted), sent.replace(/\s+/g, " ").slice(-110));

      // Asking a question must not move the options. This is the reported
      // fault: tap one, and the ones above it slide out of view.
      const positionsAfter = await page.evaluate(() => Array.from(document.querySelectorAll(".chatbot-suggestions .chip")).map((c) => Math.round(c.getBoundingClientRect().y)));
      const moved = positionsBefore.filter((y, i) => Math.abs(y - (positionsAfter[i] ?? 1e6)) > 1).length;
      check(`${viewport.name}: asking a question leaves every option where it was`, moved === 0,
        `${moved} of ${positionsBefore.length} options moved`);
      const stillAll = await page.evaluate(() => {
        const row = document.querySelector(".chatbot-suggestions");
        return { hidden: row.scrollHeight > row.clientHeight + 1, count: row.querySelectorAll(".chip").length };
      });
      check(`${viewport.name}: all ${stillAll.count} options are still on screen afterwards`, stillAll.hidden === false);
    }

    await page.screenshot({ path: `pwa-chat-options-${viewport.width}.png` });
    check(`${viewport.name}: no script errors`, errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 160));
    await ctx.close();
  }

  await browser.close();
  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
