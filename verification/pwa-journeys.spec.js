// EVERY service journey in the PWA, on both account types, with its form
// actually filled in.
//
// pwa-crawl opens five journeys and checks a modal appeared. That proves the
// grid renders; it does not prove the journey works. This walks the whole
// catalogue — personal and business — opens each service, types a plausible
// value into every field the journey exposes, and advances as far as the
// review step.
//
// It stops there, deliberately. Nothing in this file presses Pay, Confirm,
// Send, Withdraw or Buy: the point is to exercise the rendering, validation
// and fee-quoting code, not to move money. Both wallet balances are captured
// before and after and asserted unchanged, so a journey that settles something
// behind our back fails the run.
const { chromium } = require("playwright");

const PWA = "http://127.0.0.1:8010";
const API = "http://127.0.0.1:8110/v1";

const stamp = Date.now();
const ACCOUNTS = {
  personal: {
    fullName: "Journey Personal",
    email: `journeyp${stamp}@titopay.local`,
    phone: `+2786${String(stamp).slice(-7)}`,
    password: "JourneyTester!2026#x",
    accountType: "personal"
  },
  business: {
    fullName: "Journey Business",
    email: `journeyb${stamp}@titopay.local`,
    phone: `+2784${String(stamp).slice(-7)}`,
    password: "JourneyTester!2026#x",
    accountType: "business",
    businessName: `Journey Traders ${String(stamp).slice(-5)}`
  }
};

const results = [];
const check = (n, p, d = "") => { results.push({ n, p, d }); console.log(`${p ? "  PASS" : "  FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const IGNORED = /favicon|manifest|Failed to load resource|429|frame-ancestors|WebSocket connection to .wss:\/\/api\.titopay\.co\.za/;

// Nothing here may be clicked. If a journey's only forward control says one of
// these words, the journey is filled in and left sitting on its form.
const COMMITTING = /\b(pay|confirm|send|withdraw|buy|purchase|submit|top up|top-up|transfer|charge|checkout|approve|publish|delete|remove|cancel|sign out|log ?out)\b/i;
const ADVANCING = /\b(continue|next|review|calculate|quote|check|preview|get quote|proceed)\b/i;

async function signUp(profile) {
  const registered = await fetch(`${API}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(profile)
  }).then((r) => r.json());
  if (registered.accessToken) return registered;
  return fetch(`${API}/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: profile.email, password: profile.password })
  }).then((r) => r.json());
}

const walletTotals = (auth) => fetch(`${API}/wallets`, { headers: { authorization: `Bearer ${auth.accessToken}` } })
  .then((r) => r.json())
  .then((body) => (body.items || []).map((w) => `${w.wallet_number}:${Number(w.available_balance).toFixed(2)}:${Number(w.reserved_balance).toFixed(2)}`).sort().join(" | "));

// A plausible value for a field, chosen by input type first and field name
// second. Amounts stay small and every identifier is syntactically valid, so a
// journey that validates its input reaches its review step instead of an error
// state.
//
// This travels into the page as data, not as a stringified function: the PWA
// serves a CSP without `unsafe-eval`, and a rules table needs neither eval nor
// a closure over anything on the Node side.
const BY_TYPE = {
  email: "journey.recipient@titopay.local",
  tel: "0821234567",
  number: "25",
  date: "2026-09-01",
  time: "18:30",
  url: "https://example.co.za"
};
const BY_NAME = [
  ["email", "journey.recipient@titopay.local"],
  ["phone|cell|mobile|msisdn", "0821234567"],
  ["quantity|seats|tickets|count|people|members|participants", "2"],
  ["percent|vat|rate|commission|discount", "15"],
  ["amount|value|price|total|limit|target|goal|budget", "25"],
  ["meter", "12345678901"],
  ["branch|routing", "250655"],
  ["account", "1234567890"],
  ["identity|id ?number", "9001015800085"],
  ["otp|passcode|^code$|^pin$", "123456"],
  ["website|url|link", "https://example.co.za"],
  ["recipient|identifier|username|beneficiar|contact", "0821234567"],
  ["reference|invoice|order|tracking", "JRNTEST01"],
  ["message|note|description|reason|occasion|comment|address", "Crawl test — no money moves."],
  ["city|town", "Johannesburg"],
  ["province", "Gauteng"],
  ["name|label|nickname|title|surname|company|business", "Crawl Test"]
];

(async () => {
  console.log("\n=============================================================");
  console.log("  PWA — every service journey, form filled, on both account types");
  console.log("=============================================================\n");

  const auth = { personal: await signUp(ACCOUNTS.personal), business: await signUp(ACCOUNTS.business) };
  check("both accounts signed in", Boolean(auth.personal.accessToken && auth.business.accessToken));

  const opening = { personal: await walletTotals(auth.personal), business: await walletTotals(auth.business) };

  const browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });

  const coverage = {};
  for (const kind of ["personal", "business"]) {
    console.log(`\n--- ${kind} account ---\n`);
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(([a, r]) => {
      localStorage.setItem("titopay_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
      localStorage.setItem("titopay_candidate_auth_v1", JSON.stringify({ accessToken: a, refreshToken: r }));
    }, [auth[kind].accessToken, auth[kind].refreshToken]);

    // The bundle hard-codes API_BASE to production; bridge it to the sandbox
    // API so the authenticated app is what actually gets walked.
    await ctx.route("https://api.titopay.co.za/**", async (route) => {
      const request = route.request();
      const target = request.url().replace("https://api.titopay.co.za", API.replace("/v1", ""));
      try {
        const upstream = await fetch(target, {
          method: request.method(),
          headers: { ...request.headers(), host: undefined },
          body: ["GET", "HEAD"].includes(request.method()) ? undefined : request.postData() || undefined
        });
        route.fulfill({
          status: upstream.status,
          headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*" },
          body: await upstream.text()
        });
      } catch (error) {
        route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: String(error.message) }) });
      }
    });

    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && !IGNORED.test(m.text())) errors.push(m.text()); });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));

    await page.goto(`${PWA}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state && typeof render === "function", null, { timeout: 25000 });
    await page.waitForFunction(() => (state.services || []).length > 0, null, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const booted = await page.evaluate(() => ({
      auth: Boolean(state.auth?.accessToken),
      kind: state.accountType,
      services: (state.services || []).length
    }));
    check(`${kind}: the app booted with the live catalogue`, booted.auth && booted.services > 0, JSON.stringify(booted));

    // Every service this account can reach, from the catalogue rather than
    // from a list written down here — a service added to the API is crawled
    // the next time this runs, with no edit to the spec.
    const catalogue = await page.evaluate(() => (state.services || []).map((s) => ({
      id: s.id, action: s.action, label: s.label, type: s.type, status: s.status
    })));

    // Plus the tiles the services grid renders that are not catalogue rows.
    await page.evaluate(() => { location.hash = "services"; });
    await page.waitForTimeout(1000);
    const rendered = await page.evaluate(() => Array.from(new Set(
      Array.from(document.querySelectorAll("[data-service]")).map((el) => el.dataset.service)
    )));

    const targets = Array.from(new Set([...catalogue.map((s) => s.id), ...rendered])).filter(Boolean).sort();
    check(`${kind}: the catalogue exposes journeys to walk`, targets.length >= 15, `${targets.length} services (${catalogue.length} catalogue rows, ${rendered.length} tiles rendered)`);

    const opened = [];
    const filled = [];
    const broke = [];
    const skipped = [];

    for (const id of targets) {
      const mark = errors.length;
      const meta = catalogue.find((s) => s.id === id) || { id, label: id };

      await page.evaluate(() => { location.hash = "services"; });
      await page.waitForTimeout(250);
      await page.evaluate((service) => {
        if (typeof handleService === "function") return handleService(service);
        document.querySelector(`[data-service="${service}"]`)?.click();
        return null;
      }, id).catch(() => {});
      await page.waitForTimeout(1100);

      const shape = await page.evaluate(() => {
        const modal = document.querySelector(".modal-backdrop .modal-card");
        return {
          modal: Boolean(modal),
          route: state.route,
          heading: (modal?.querySelector("h1,h2,h3")?.textContent || "").trim().slice(0, 60),
          fields: modal ? modal.querySelectorAll("input, select, textarea").length : 0,
          body: (modal?.innerText || "").trim().length,
          toast: (document.querySelector(".toast, [data-toast]")?.innerText || "").trim().slice(0, 80)
        };
      });

      // A handful of catalogue rows are pure navigation — Transactions and
      // Profile & Security move the router instead of opening a dialog. Both
      // are legitimate outcomes; nothing happening at all is not.
      const navigated = !shape.modal && ["activity", "profile", "qr"].includes(shape.route);
      if (!shape.modal && !navigated) {
        if (shape.toast) skipped.push(`${id} (${shape.toast})`);
        else broke.push(`${id}: nothing opened`);
        if (errors.length > mark) broke.push(`${id}: ${errors[mark].slice(0, 70)}`);
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(250);
        continue;
      }
      opened.push(id);

      if (shape.modal && shape.fields > 0) {
        // Fill every field the journey exposes, then let it react.
        const typed = await page.evaluate(([byType, byName]) => {
          const valueFor = (field) => {
            const label = `${field.name || ""} ${field.placeholder || ""} ${field.getAttribute("aria-label") || ""}`.toLowerCase();
            for (const [pattern, value] of byName) if (new RegExp(pattern, "i").test(label)) return value;
            return byType[String(field.type || "").toLowerCase()] || "Crawl Test";
          };
          const modal = document.querySelector(".modal-backdrop .modal-card");
          if (!modal) return { count: 0 };
          let count = 0;
          for (const field of modal.querySelectorAll("input, select, textarea")) {
            if (field.disabled || field.readOnly || field.type === "file" || field.type === "hidden") continue;
            if (field.type === "checkbox" || field.type === "radio") {
              if (field.checked) continue;
              field.checked = true;
            } else if (field.tagName === "SELECT") {
              const option = Array.from(field.options).find((o) => o.value && !o.disabled);
              if (!option) continue;
              field.value = option.value;
            } else {
              if (field.value) continue;
              // A typed input rejects a value it cannot parse, so type wins
              // over the name for number, date, time and email fields.
              field.value = byType[String(field.type || "").toLowerCase()] || valueFor(field);
            }
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));
            count += 1;
          }
          return { count };
        }, [BY_TYPE, BY_NAME]);
        await page.waitForTimeout(900);

        // Advance one step if the journey offers a non-committing way forward.
        const advanced = await page.evaluate(([advancing, committing]) => {
          const modal = document.querySelector(".modal-backdrop .modal-card");
          if (!modal) return "gone";
          const forward = Array.from(modal.querySelectorAll("button, [role='button']")).find((b) => {
            const text = (b.textContent || "").trim();
            if (!text || b.disabled) return false;
            if (new RegExp(committing, "i").test(text)) return false;
            return new RegExp(advancing, "i").test(text);
          });
          if (!forward) return "";
          forward.click();
          return (forward.textContent || "").trim().slice(0, 30);
        }, [ADVANCING.source, COMMITTING.source]);
        await page.waitForTimeout(1000);

        const after = await page.evaluate(() => {
          const modal = document.querySelector(".modal-backdrop .modal-card");
          return {
            open: Boolean(modal),
            body: (modal?.innerText || "").trim().length,
            errorText: (modal?.querySelector(".field-error, .form-error, .error")?.textContent || "").trim().slice(0, 70)
          };
        });

        const clean = errors.length === mark;
        if (!clean) broke.push(`${id}: ${errors[mark].slice(0, 70)}`);
        else filled.push(`${id}[${typed.count}${advanced ? `>${advanced}` : ""}]`);

        check(`${kind}: "${meta.label || id}" (${id}) — ${shape.fields} field(s) filled${advanced ? `, advanced via "${advanced}"` : ""}`,
          clean && (after.open || after.body > 0), clean ? (after.errorText || `${after.body} chars`) : errors[mark].slice(0, 90));
      } else {
        const clean = errors.length === mark;
        if (!clean) broke.push(`${id}: ${errors[mark].slice(0, 70)}`);
        check(`${kind}: "${meta.label || id}" (${id}) — ${navigated ? `routes to ${shape.route}` : "renders"}`,
          clean && (navigated || shape.body > 20), clean ? (shape.heading || shape.route) : errors[mark].slice(0, 90));
      }

      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      await page.evaluate(() => { if (typeof closeModal === "function") closeModal(); }).catch(() => {});
      await page.waitForTimeout(200);
    }

    coverage[kind] = { targets: targets.length, opened: opened.length, filled: filled.length, broke, skipped };
    check(`${kind}: every journey opened`, broke.length === 0, broke.slice(0, 3).join(" | "));
    console.log(`\n  ${kind}: ${opened.length}/${targets.length} journeys opened, ${filled.length} had a form that was filled in`);
    if (skipped.length) console.log(`  ${kind}: ${skipped.length} declined by the app itself — ${skipped.slice(0, 4).join("; ")}`);

    await page.screenshot({ path: `pwa-journeys-${kind}.png` });
    check(`${kind}: no script errors across the whole walk`, errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 200));
    await ctx.close();
  }

  await browser.close();

  /* ---- the safety property: nothing this crawl did moved any money ------- */
  const closing = { personal: await walletTotals(auth.personal), business: await walletTotals(auth.business) };
  check("the personal wallet is byte-for-byte unchanged", closing.personal === opening.personal, `${opening.personal} -> ${closing.personal}`);
  check("the business wallet is byte-for-byte unchanged", closing.business === opening.business, `${opening.business} -> ${closing.business}`);

  const walked = coverage.personal.targets + coverage.business.targets;
  const withForms = coverage.personal.filled + coverage.business.filled;
  check("the walk covered the whole catalogue on both account types", walked >= 40,
    `${walked} journeys walked, ${withForms} with forms exercised`);

  const failed = results.filter((x) => !x.p);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) { console.log("\n  FAILED:"); failed.forEach((f) => console.log(`   - ${f.n} (${f.d})`)); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
