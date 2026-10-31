// The public home page (landing page), L1-L8:
//   L1 the announcement is a slim, dismissible bar above the site header (still
//      set in Admin > Site settings), and the events follow the hero directly
//   L2 trust strip under the hero: one row on a computer, wrapping on a phone,
//      payment methods as plain text (no third-party logos), wallets only when on
//   L3 the "Cashless events" band is always there: a rail when cashless events
//      are on sale, otherwise four "how it works" steps and a link for organisers
//   L4 "Browse by city" tiles from the API's city list (hidden under 2 cities)
//   L5 fewer than 4 events: wider cards and a "More events are on the way" card
//   L6 "How tickets work" and "Event safety" side by side in one balanced row
//   L7 the hero's featured event card on a computer (hidden on a phone)
//   L8 the whole page at 390x844 and 1366x900: no sideways scroll, no console
//      errors, text contrast of the new parts, tap targets, Help button clear of
//      the footer
//
//   node ticketroom/live/dev/tests/landing.js <dir from serve.sh> [port]
//   TR_ONLY=L3 runs one item.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { Client, sql, ADMIN_EMAIL } = require("../lib");

const DIR = path.resolve(process.argv[2] || "");
const PORT = process.argv[3] || "8640";
const BASE = `http://localhost:${PORT}`;
const ADMIN_PW = process.env.TR_TEST_ADMIN_PASSWORD;
const CHROME = process.env.TR_CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.argv[2] || !fs.existsSync(path.join(DIR, "seed.json"))) { console.error("usage: landing.js <dir from serve.sh> [port]"); process.exit(2); }
if (!ADMIN_PW) { console.error("TR_TEST_ADMIN_PASSWORD is required"); process.exit(2); }
const SEED = JSON.parse(fs.readFileSync(path.join(DIR, "seed.json"), "utf8"));
const DATA = path.join(DIR, "ticketroom-data");
const SHOTS = path.join(DIR, "landing-shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0, passes = 0;
const ONLY = process.env.TR_ONLY;
async function test(name, fn) {
  if (ONLY && !name.startsWith(ONLY)) return;
  try { await fn(); passes++; console.log(`PASS  ${name}`); }
  catch (e) { failures++; console.log(`FAIL  ${name}  ${String(e.message || e).slice(0, 1600)}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const PHONE = [390, 844], DESKTOP = [1366, 900];

let browser;
// A fresh visitor (cookie choice made, so the cookie box stays out of the way).
// `events` rewrites the unfiltered /api/public/events answer; `config` the /api/config one.
async function open([width, height], { events, config, cashless } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("tr_consent", JSON.stringify({ v: 1, at: new Date().toISOString(), functional: false, analytics: false })); } catch {} });
  // (A request still on its way when the test closes the page is simply dropped.)
  if (events || cashless) await ctx.route(/\/api\/public\/events(\?.*)?$/, async (route) => {
    try {
      const res = await route.fetch();
      const body = await res.json();
      const isCashless = /[?&]cashless=1/.test(route.request().url());
      const out = isCashless ? (cashless ? cashless(body) : body) : (events ? events(body) : body);
      await route.fulfill({ response: res, json: out });
    } catch { /* page closed */ }
  });
  if (config) await ctx.route(/\/api\/config$/, async (route) => { try { const res = await route.fetch(); await route.fulfill({ response: res, json: config(await res.json()) }); } catch { /* page closed */ } });
  const p = await ctx.newPage();
  p.problems = [];
  p.on("console", (m) => { if (m.type() === "error") p.problems.push(`console: ${m.text().slice(0, 200)}`); });
  p.on("pageerror", (e) => p.problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  p.on("response", (r) => { if (r.status() >= 400) p.problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await p.waitForFunction(() => !document.documentElement.classList.contains("booting") && document.querySelector("#grid") && !document.querySelector("#grid .spinner"), null, { timeout: 10000 });
  await p.waitForTimeout(300);
  p.ctx = ctx;
  return p;
}
async function shot(p, name) { try { await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } catch {} }
const rect = (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: r.left, y: r.top + scrollY, w: r.width, h: r.height, right: r.right, bottom: r.bottom + scrollY, shown: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0 }; }, sel);
// n copies of the first real event with their own titles, cities and slugs.
function manyEvents(body, n, cities = ["Cape Town", "Johannesburg", "Durban"]) {
  const base = body.events[0];
  const events = Array.from({ length: n }, (_, i) => ({ ...base, id: `${base.id}-${i}`, title: `${base.title} ${i + 1}`, city: cities[i % cities.length], featured: 0 }));
  return { ...body, events, total: n };
}

(async () => {
  browser = await chromium.launch({ executablePath: CHROME });
  const admin = new Client(BASE, DATA);
  await admin.staffLogin(ADMIN_EMAIL, ADMIN_PW);
  const site = await admin.call("GET", "/api/admin/settings");
  const bannerBefore = (site.settings || site).banner;
  const cashlessBefore = sql(DATA, "SELECT id, cashless_enabled FROM events");

  await test("L1 announcement sits inside the page under the opening section, dismissible and admin-controlled", async () => {
    const text = `Card payments are now live for every organiser ${Date.now().toString(36)}.`;
    await admin.call("PUT", "/api/admin/settings/banner", { enabled: true, text, linkText: "Start selling", linkUrl: "/sell" });
    for (const size of [DESKTOP, PHONE]) {
      const p = await open(size);
      const r = await p.evaluate(() => {
        const b = document.querySelector(".site-banner"), h = document.querySelector("#header");
        return { exists: !!b, next: b?.nextElementSibling?.id, inMain: !!b?.closest("main"), text: b?.innerText || "", bh: b?.getBoundingClientRect().height, bBottom: b?.getBoundingClientRect().bottom, hTop: h.getBoundingClientRect().top,
          afterHero: document.querySelector(".hero")?.closest("section").nextElementSibling?.className || "", link: b?.querySelector("a")?.getAttribute("href"), close: b?.querySelector("[data-hide]")?.getBoundingClientRect().height };
      });
      // The owner wants the notice inside the page, under the opening section, never in or above the header.
      assert(r.exists && r.inMain && r.bBottom > r.hTop, `${size[0]}: the notice is not inside the page under the header ${JSON.stringify(r)}`);
      assert(r.text.includes(text) && r.link === "/sell", `${size[0]}: admin text or link missing ${JSON.stringify(r)}`);
      assert(r.close >= 32, `${size[0]}: dismiss button ${r.close}px tall`);
      await p.click(".site-banner [data-hide]");
      assert(!(await p.$(".site-banner")), `${size[0]}: dismiss did not hide the bar`);
      await p.reload({ waitUntil: "networkidle" }); await p.waitForTimeout(300);
      assert(!(await p.$(".site-banner")), `${size[0]}: the bar came back after dismissing`);
      if (size === PHONE) await shot(p, "L1-phone");
      assert(!p.problems.length, p.problems.join("; "));
      await p.ctx.close();
    }
    await admin.call("PUT", "/api/admin/settings/banner", { ...bannerBefore, enabled: false });
    const p = await open(DESKTOP);
    assert(!(await p.$(".site-banner")), "a switched-off banner still shows");
    await p.ctx.close();
    await admin.call("PUT", "/api/admin/settings/banner", bannerBefore);
  });

  await test("L2 trust strip: one row on a computer, wraps on a phone, plain payment text, wallets only when on", async () => {
    for (const size of [DESKTOP, PHONE]) {
      const p = await open(size, { config: (c) => ({ ...c, features: { ...(c.features || {}), walletApple: false, walletGoogle: false } }) });
      const r = await p.evaluate(() => {
        const s = document.querySelector("[data-trust]");
        const items = s ? [...s.children].map((li) => { const b = li.getBoundingClientRect(); return { top: Math.round(b.top), right: b.right, svg: !!li.querySelector("svg"), text: li.innerText }; }) : [];
        const hero = document.querySelector(".hero").getBoundingClientRect().bottom, top = s?.closest("section").getBoundingClientRect().top;
        return { items, imgs: s ? [...s.querySelectorAll("img")].map((i) => i.src) : [], gapToHero: top - hero, vw: document.documentElement.clientWidth };
      });
      assert(r.items.length === 4, `${size[0]}: expected 4 trust items, got ${r.items.length}`);
      assert(Math.abs(r.gapToHero) < 2, `${size[0]}: the strip is not straight under the hero (${r.gapToHero})`);
      assert(r.items.every((i) => i.svg) && !r.imgs.length, `${size[0]}: icons must be line icons, no images ${JSON.stringify(r.imgs)}`);
      const all = r.items.map((i) => i.text).join(" | ");
      for (const want of ["Secure card payments", "Card, instant EFT, SnapScan and Zapper", "Tickets on your phone", "Fair resale at face value", "Refunds handled by TicketRoom"]) assert(all.includes(want), `${size[0]}: "${want}" missing in ${all}`);
      assert(!/Wallet/.test(all), `${size[0]}: wallets named while switched off: ${all}`);
      if (size === DESKTOP) assert(new Set(r.items.map((i) => i.top)).size === 1, `desktop: trust items not in one row ${JSON.stringify(r.items.map((i) => i.top))}`);
      else assert(new Set(r.items.map((i) => i.top)).size > 1 && r.items.every((i) => i.right <= r.vw + 1), `phone: trust items do not wrap ${JSON.stringify(r.items)}`);
      assert(!p.problems.length, p.problems.join("; "));
      await p.ctx.close();
    }
    const p = await open(DESKTOP, { config: (c) => ({ ...c, features: { ...(c.features || {}), walletApple: true, walletGoogle: true } }) });
    const t = await p.locator("[data-trust]").innerText();
    assert(/Apple Wallet/.test(t) && /Google Wallet/.test(t), `wallets on but not named: ${t}`);
    await p.ctx.close();
    const q = await open(DESKTOP, { config: (c) => ({ ...c, features: { ...(c.features || {}), walletApple: false, walletGoogle: true } }) });
    const t2 = await q.locator("[data-trust]").innerText();
    assert(!/Apple Wallet/.test(t2) && /Google Wallet/.test(t2), `only Google Wallet on: ${t2}`);
    await q.ctx.close();
  });

  await test("L3 cashless band is always there: steps when nothing is on sale, a rail when it is", async () => {
    sql(DATA, "UPDATE events SET cashless_enabled = 0");
    for (const size of [DESKTOP, PHONE]) {
      const p = await open(size);
      const r = await p.evaluate(() => {
        const band = document.querySelector("#cashless");
        const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
        return { shown: vis(band), steps: [...document.querySelectorAll("#cashless-how li")].filter(vis).map((li) => li.innerText.replace(/\s+/g, " ")), rail: vis(document.querySelector("#cashless-rail")), org: document.querySelector("[data-cl-org]")?.getAttribute("href"), all: vis(document.querySelector("[data-cl-all]")), state: band?.querySelector(".cashless-home")?.dataset.cashlessState };
      });
      assert(r.shown, `${size[0]}: no cashless band without cashless events`);
      assert(r.steps.length === 4 && /wristband/i.test(r.steps[0]) && /top up/i.test(r.steps[1]) && /tap/i.test(r.steps[2]) && /don.t spend/i.test(r.steps[3]), `${size[0]}: steps ${JSON.stringify(r.steps)}`);
      assert(r.org === "/sell" && !r.rail && !r.all && r.state === "how", `${size[0]}: ${JSON.stringify(r)}`);
      assert(!p.problems.length, p.problems.join("; "));
      await p.ctx.close();
    }
    sql(DATA, "UPDATE events SET cashless_enabled = 1 WHERE id = ?", [SEED.events.paid.id]);
    const p = await open(DESKTOP);
    const r = await p.evaluate(() => {
      const vis = (el) => !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0;
      return { cards: [...document.querySelectorAll("#cashless-rail .event-card")].map((a) => a.getAttribute("href")), steps: vis(document.querySelector("#cashless-how")), all: vis(document.querySelector("[data-cl-all]")), state: document.querySelector(".cashless-home").dataset.cashlessState };
    });
    assert(r.cards.length === 1 && r.cards[0] === `/events/${SEED.events.paid.slug}` && !r.steps && r.all && r.state === "events", JSON.stringify(r));
    await p.click("[data-cl-all]");
    await p.waitForFunction(() => /cashless=1/.test(location.search));
    assert(!p.problems.length, p.problems.join("; "));
    await p.ctx.close();
  });
  for (const row of cashlessBefore) sql(DATA, "UPDATE events SET cashless_enabled = ? WHERE id = ?", [row.cashless_enabled, row.id]);

  await test("L4 city tiles: top cities with upcoming events, hidden under two, a tile filters the list", async () => {
    let p = await open(DESKTOP, { events: (b) => ({ ...b, cities: [{ city: "Cape Town", n: 2 }] }) });
    assert(!(await rect(p, "#cities")).shown, "one city should not show the tiles");
    await p.ctx.close();
    const cities = [["Cape Town", 4], ["Johannesburg", 3], ["Durban", 2], ["Pretoria", 2], ["Gqeberha", 1], ["Bloemfontein", 1], ["Polokwane", 1]].map(([city, n]) => ({ city, n }));
    for (const size of [DESKTOP, PHONE]) {
      p = await open(size, { events: (b) => ({ ...b, cities }) });
      const r = await p.evaluate(() => ({ tiles: [...document.querySelectorAll("#city-grid .city-tile")].map((a) => ({ t: a.innerText.replace(/\s+/g, " "), h: a.getBoundingClientRect().height, right: a.getBoundingClientRect().right })), vw: document.documentElement.clientWidth }));
      assert(r.tiles.length === 6, `${size[0]}: expected the top 6 cities, got ${r.tiles.length}`);
      assert(/Cape Town/.test(r.tiles[0].t) && /4 upcoming events/.test(r.tiles[0].t) && /Gqeberha/.test(r.tiles[4].t) && /1 upcoming event\b/.test(r.tiles[4].t), JSON.stringify(r.tiles));
      assert(r.tiles.every((t) => t.h >= 44 && t.right <= r.vw + 1), `${size[0]}: tile size ${JSON.stringify(r.tiles)}`);
      if (size === DESKTOP) {
        await p.click('#city-grid [data-city-tile="Johannesburg"]');
        await p.waitForFunction(() => /city=Johannesburg/.test(location.search));
        assert(await p.evaluate(() => document.querySelector("#city").value === "Johannesburg"), "the city box did not follow the tile");
      }
      assert(!p.problems.length, p.problems.join("; "));
      await p.ctx.close();
    }
  });

  await test("L5 fewer than 4 events: wider cards and a 'More events are on the way' card", async () => {
    for (const n of [1, 2, 3]) {
      const p = await open(DESKTOP, { events: (b) => manyEvents(b, n) });
      const r = await p.evaluate(() => {
        const g = document.querySelector("#grid"), gr = g.getBoundingClientRect();
        const kids = [...g.children].map((c) => { const b = c.getBoundingClientRect(); return { cls: c.className, top: Math.round(b.top), right: b.right, w: b.width }; });
        const soon = g.querySelector("[data-more-soon]");
        return { gridRight: gr.right, kids, soonText: soon?.innerText || "", alerts: soon?.querySelector("a.btn")?.getAttribute("href") };
      });
      assert(r.kids.length === n + 1 && /more-soon/.test(r.kids[n].cls), `${n} events: ${JSON.stringify(r.kids)}`);
      assert(/More events are on the way/.test(r.soonText) && r.alerts === "/subscribe", `${n} events: ${r.soonText} ${r.alerts}`);
      assert(new Set(r.kids.map((k) => k.top)).size === 1 && Math.abs(r.kids[n].right - r.gridRight) < 2, `${n} events: the row leaves empty space ${JSON.stringify(r)}`);
      assert(!p.problems.length, p.problems.join("; "));
      if (n === 2) await shot(p, "L5-desktop-2");
      await p.ctx.close();
    }
    const p = await open(PHONE, { events: (b) => manyEvents(b, 2) });
    const r = await p.evaluate(() => ({ soon: !!document.querySelector("#grid [data-more-soon]"), side: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    assert(r.soon && r.side <= 0, `phone: ${JSON.stringify(r)}`);
    await p.ctx.close();
    const q = await open(DESKTOP, { events: (b) => manyEvents(b, 6) });
    const r6 = await q.evaluate(() => ({ soon: !!document.querySelector("#grid [data-more-soon]"), cls: document.querySelector("#grid").className, cards: document.querySelectorAll("#grid .event-card").length }));
    assert(!r6.soon && !/few/.test(r6.cls) && r6.cards === 6, `6 events: ${JSON.stringify(r6)}`);
    await q.ctx.close();
  });

  await test("L6 'How tickets work' and 'Event safety' sit in one balanced row", async () => {
    let p = await open(DESKTOP);
    const r = await p.evaluate(() => {
      const row = document.querySelector("[data-home-pair]"), wrap = row.getBoundingClientRect();
      const [a, b] = [...row.children].map((c) => { const x = c.getBoundingClientRect(); return { cls: c.className, l: x.left, r: x.right, t: Math.round(x.top), h: Math.round(x.height), text: c.innerText.replace(/\s+/g, " ") }; });
      const cs = getComputedStyle(row);
      return { a, b, wl: wrap.left + parseFloat(cs.paddingLeft), wr: wrap.right - parseFloat(cs.paddingRight), steps: document.querySelectorAll(".how-steps li").length };
    });
    assert(/how-card/.test(r.a.cls) && /safety-teaser/.test(r.b.cls), JSON.stringify(r));
    assert(r.a.t === r.b.t && Math.abs(r.a.h - r.b.h) <= 2, `not one balanced row: ${JSON.stringify(r)}`);
    assert(Math.abs(r.a.l - r.wl) < 2 && Math.abs(r.b.r - r.wr) < 2 && r.b.l > r.a.r, `row does not span the page: ${JSON.stringify(r)}`);
    assert(r.steps === 4 && /Buy/.test(r.a.text) && /phone/.test(r.a.text) && /gate/.test(r.a.text) && /resell/i.test(r.a.text), r.a.text);
    assert(/Event safety/.test(r.b.text) && /Read the guide/.test(r.b.text), r.b.text);
    assert(!p.problems.length, p.problems.join("; "));
    await p.ctx.close();
    p = await open(PHONE);
    const s = await p.evaluate(() => { const row = document.querySelector("[data-home-pair]"); const cs = getComputedStyle(row); const w = row.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); return [...row.children].map((c) => Math.round(c.getBoundingClientRect().width - w)); });
    assert(s.every((d) => Math.abs(d) <= 1), `phone: cards are not full width ${JSON.stringify(s)}`);
    await p.ctx.close();
  });

  await test("L7 hero card: featured (or next big) event on a computer, hidden on a phone", async () => {
    const feature = (b) => ({ ...b, events: b.events.map((e) => ({ ...e, featured: e.slug === SEED.events.paid.slug ? 1 : 0 })).sort((x, y) => y.featured - x.featured) });
    let p = await open(DESKTOP, { events: feature });
    const r = await p.evaluate(() => {
      const a = document.querySelector("[data-hero-pick]"); const h = document.querySelector(".hero-main").getBoundingClientRect(), x = a?.getBoundingClientRect();
      return { href: a?.getAttribute("href"), text: a?.innerText.replace(/\s+/g, " "), right: x && x.left > h.right, inHero: !!a?.closest(".hero"), railPick: [...document.querySelectorAll("#featured .feature")].filter((f) => getComputedStyle(f).display !== "none").length };
    });
    assert(r.href === `/events/${SEED.events.paid.slug}` && /Featured/i.test(r.text) && /Get tickets/.test(r.text) && r.right && r.inHero, JSON.stringify(r));
    assert(r.railPick === 0, `the hero's event repeats in the rail: ${JSON.stringify(r)}`);
    await p.ctx.close();
    p = await open(DESKTOP, { events: (b) => ({ ...b, events: b.events.map((e) => ({ ...e, featured: 0 })) }) });
    const t = await p.locator("[data-hero-pick]").innerText();
    assert(/Coming up/i.test(t), `no featured event: ${t}`);
    await p.ctx.close();
    p = await open(PHONE, { events: feature });
    const ph = await rect(p, "#hero-pick");
    const hero = await rect(p, ".hero");
    assert(!ph.shown && hero.h < 640, `phone: hero card shown or hero too tall ${JSON.stringify({ ph, hero })}`);
    await p.ctx.close();
  });

  await test("L8 whole page at 390 and 1366: no sideways scroll or console errors, contrast, tap targets, Help clear of the footer", async () => {
    for (const size of [PHONE, DESKTOP]) {
      const p = await open(size, { events: (b) => manyEvents(b, 2) });
      await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await p.waitForTimeout(300);
      const r = await p.evaluate((phone) => {
        const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return [0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]), m[3] ?? 1]; };
        const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); const bg = s.backgroundColor; if (s.backgroundImage !== "none" && !/^url/.test(s.backgroundImage)) { const cs = s.backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,6}/gi); if (cs) return cs; } if (bg && lum(bg)[1] > 0.5) return [bg]; } return ["rgb(255,255,255)"]; };
        const low = [];
        for (const el of document.querySelectorAll(".site-banner *, .home-trust *, #cities *, #cashless *, #grid .more-soon *, [data-home-pair] *, .hero-pick *")) {
          if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
          const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).visibility === "hidden") continue;
          const fg = lum(getComputedStyle(el).color)[0];
          for (const bg of bgOf(el)) { const b = /^#/.test(bg) ? null : lum(bg)[0]; if (b === null) continue; const ratio = (Math.max(fg, b) + 0.05) / (Math.min(fg, b) + 0.05); if (ratio < 4.5) low.push(`${ratio.toFixed(2)} "${el.textContent.trim().slice(0, 30)}"`); }
        }
        const tap = [];
        if (phone) for (const el of document.querySelectorAll("main .btn, main button, main .chip, .site-banner button, main select, main input, .city-tile, .cl-org, .more-soon-link, .safety-teaser-link")) {
          const r = el.getBoundingClientRect(); if (!r.width || getComputedStyle(el).display === "none" || el.closest(".sr-only, [hidden]")) continue;
          if (r.height < 40 - 0.5) tap.push(`${Math.round(r.height)} "${el.innerText.trim().slice(0, 20)}"`);
        }
        const fab = document.querySelector(".chat-fab")?.getBoundingClientRect();
        const last = [...document.querySelectorAll(".site-footer a, .site-footer button, .site-footer select")].filter((e) => e.getBoundingClientRect().width).map((e) => e.getBoundingClientRect());
        const covered = fab ? last.filter((b) => !(b.right <= fab.left || b.left >= fab.right || b.bottom <= fab.top || b.top >= fab.bottom)).length : 0;
        const text = document.body.innerText;
        return { side: document.documentElement.scrollWidth - document.documentElement.clientWidth, low, tap, covered, dash: /—|!/.test(document.querySelector("main").innerText) };
      }, size === PHONE);
      assert(r.side <= 0, `${size[0]}: sideways scroll ${r.side}px`);
      assert(!r.low.length, `${size[0]}: low contrast ${r.low.slice(0, 6).join("; ")}`);
      assert(!r.tap.length, `${size[0]}: small tap targets ${r.tap.join("; ")}`);
      assert(!r.covered, `${size[0]}: the Help button covers ${r.covered} footer links at the end of the page`);
      assert(!r.dash, `${size[0]}: em dash or exclamation mark on the page`);
      assert(!p.problems.length, `${size[0]}: ${p.problems.join("; ")}`);
      await shot(p, `L8-${size[0]}`);
      await p.ctx.close();
    }
  });

  await admin.call("PUT", "/api/admin/settings/banner", bannerBefore).catch(() => {});
  await browser.close();
  console.log(`\nlanding: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(async (e) => { console.error(e.stack || String(e)); try { await browser?.close(); } catch {} process.exit(1); });
