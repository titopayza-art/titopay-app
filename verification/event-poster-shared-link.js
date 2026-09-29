"use strict";

// THE POSTER ON THE SHARED EVENT LINK.
//
// There are two screens that show one event, and only one of them is reached by
// tapping a card inside the app:
//
//   publicTicketingEventModal   the in-app sheet, opened from Events
//   publicTicketingEventView    the standalone screen a shared /events/<slug>
//                               link lands on, seen by people who do not have
//                               the app open and often do not have it at all
//
// The sheet drew the poster. The shared-link screen never did, so the one
// screen an organiser actually sends to their audience opened on a heading and
// a wall of text. The poster was in the API payload the whole time.
//
// This drives the real bundle in a real browser against a real approved event
// and asserts the poster is on the page a shared link opens.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/event-poster-shared-link.js
//
// Needs the API on 8110 and the PWA served on 8010. It seeds its own throwaway
// organiser and deletes everything at the end.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const t = require("../api/src/services/ticketing-service");
const { chromium } = require("playwright");

const TAG = `sl${String(Date.now()).slice(-7)}`;
const org = randomUUID(), wal = randomUUID(), mer = randomUUID();
// A real, decodable PNG, so "the browser drew it" means the browser drew it.
const POSTER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC";

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  let browser = null;
  try {
    await t.ensureTicketingSchema();
    await pool.query(`INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
      VALUES ($1,'business','${TAG} Org','${TAG}_o','${TAG}_o@example.invalid','27110000031','x','active',FALSE,'approved')`, [org]);
    await pool.query(`INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
      VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`, [wal, String(Date.now()).slice(-9), org]);
    await pool.query(`INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
      VALUES ($1,$2,$3,$4,'active','verified')`, [mer, org, `${TAG} Org`, `M${TAG}`]);

    const draft = await t.createEventDraft(org, {
      eventName: `${TAG} Launch`, category: "conference", description: "d",
      eventDate: "2027-06-06", startTime: "09:00", endTime: "17:00",
      venueName: "HQ", fullVenueAddress: "1 St", city: "JHB", province: "Gauteng",
      termsConditions: "t", refundPolicy: { summary: "s" }, eventBannerUrl: POSTER,
      ticketTypes: [{ ticketName: "General", price: 0, quantityAvailable: 100 }]
    });
    await pool.query("UPDATE events SET status='approved', approved_at=NOW() WHERE id=$1", [draft.id]);
    const slug = (await pool.query("SELECT slug FROM events WHERE id=$1", [draft.id])).rows[0].slug;
    ok("an approved event with a poster exists", `/events/${slug}`);

    const api = await t.getPublicApprovedEvent(slug);
    assert.equal(api.eventBannerUrl, POSTER, "the public payload dropped the poster");
    ok("the public payload carries the poster");

    browser = await chromium.launch({ args: ["--no-sandbox"], executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    // The bundle hardcodes the production API host.
    await context.route("https://api.titopay.co.za/**", async (route) => {
      const request = route.request();
      const target = request.url().replace("https://api.titopay.co.za", "http://127.0.0.1:8110");
      const headers = Object.assign({}, request.headers());
      delete headers.host; delete headers.origin; delete headers.referer;
      const upstream = await fetch(target, { method: request.method(), headers, body: request.postData() || undefined, redirect: "manual" });
      const body = Buffer.from(await upstream.arrayBuffer());
      const out = {};
      upstream.headers.forEach((value, key) => {
        if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(key)) out[key] = value;
      });
      out["access-control-allow-origin"] = "*";
      await route.fulfill({ status: upstream.status, headers: out, body });
    });
    // Production rewrites /events/<slug> to index.html in .htaccess; the local
    // static server has no SPA fallback, so the deep link is served the same way.
    await context.route("http://127.0.0.1:8010/events/**", async (route) => {
      const shell = await fetch("http://127.0.0.1:8010/index.html");
      await route.fulfill({ status: 200, contentType: "text/html", body: await shell.text() });
    });

    const page = await context.newPage();
    const errors = []; page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:8010/events/${slug}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const seen = await page.evaluate(() => {
      const screen = document.querySelector(".public-event-screen");
      const hero = document.querySelector(".public-event-screen .event-hero");
      const box = hero ? hero.getBoundingClientRect() : null;
      return {
        onPublicScreen: Boolean(screen),
        heroPresent: Boolean(hero),
        heroHasImage: hero ? /url\(/.test(getComputedStyle(hero).backgroundImage) : false,
        width: box ? Math.round(box.width) : 0,
        height: box ? Math.round(box.height) : 0
      };
    });

    assert.equal(seen.onPublicScreen, true, "the shared link did not land on the public event screen");
    ok("the shared link opens the standalone public event screen");

    assert.equal(seen.heroPresent, true, "no poster on the shared-link screen");
    ok("the poster is on that screen");

    assert.equal(seen.heroHasImage, true, "the poster element is there but carries no image");
    ok("and the browser actually drew the image");

    const ratio = seen.height ? seen.width / seen.height : 0;
    assert.ok(Math.abs(ratio - 16 / 9) < 0.05, `the poster is ${ratio.toFixed(2)}, not 16:9`);
    ok("drawn at 16:9, the shape the form asks for", `${seen.width}x${seen.height} (ratio ${ratio.toFixed(2)})`);

    assert.equal(errors.length, 0, errors[0] || "");
    ok("no script errors on the page");

    console.log(`\n  ${passed}/7 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    if (browser) await browser.close().catch(() => {});
    const events = (await pool.query("SELECT id FROM events WHERE business_user_id=$1", [org])).rows.map((r) => r.id);
    for (const id of events) {
      for (const table of ["tickets", "ticket_orders", "event_ticket_types", "event_audit_logs"]) {
        await pool.query(`DELETE FROM ${table} WHERE event_id=$1`, [id]).catch(() => {});
      }
      await pool.query("DELETE FROM events WHERE id=$1", [id]).catch(() => {});
    }
    await pool.query("DELETE FROM wallets WHERE id=$1", [wal]).catch(() => {});
    await pool.query("DELETE FROM merchants WHERE id=$1", [mer]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [org]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
