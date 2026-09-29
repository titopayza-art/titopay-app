"use strict";

// WHAT AN ORGANISER ACTUALLY SENDS, AND WHAT THE PERSON RECEIVING IT SEES.
//
// The Share button used to copy the API's own preview path:
//
//   https://api.titopay.co.za/v1/ticketing/public/events/<slug>/preview
//
// It worked. It also meant every organiser was sending their audience a link
// that reads like a developer URL, on the one screen where the whole point is
// that the event looks real and trustworthy.
//
// The reason it existed is genuine: WhatsApp, Facebook, X and Slack fetch a URL
// and read its <meta> tags, and they do not run JavaScript, so a link into a
// client-rendered app previews as a bare "TitoPay". The answer is not to make
// the human's link ugly, it is to send only the CRAWLERS to the preview.
//
//   1. The app shares the real link, on the app's own origin.
//   2. The preview page still carries the event's title, date and venue.
//   3. og:image points at a poster a crawler can FETCH. It used to be omitted
//      entirely, because every poster is stored as a data: URL.
//   4. That poster URL returns real image bytes with an image content type.
//   5. The description is cut at a word boundary, not mid-word, and carries no
//      raw line breaks into an HTML attribute.
//   6. A promoter's ?ref= still survives the hop, so attribution is not lost.
//   7. An event with no poster offers no og:image, rather than one that 404s.
//   8. The Apache rule sends crawlers to the preview and everyone else to the
//      app, and it matches ONLY /events/<slug>.
//
//   POSTGRES_URL=postgres://postgres@127.0.0.1:55432/titopay \
//     node verification/event-share-link-live.js
//
// Needs the API on 8110. Seeds and deletes its own event.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pool } = require("../api/src/db/pool");
const notif = require("../api/src/services/notification-service");
notif.deliverEmail = async () => ({ id: "stub" });
const ticketing = require("../api/src/services/ticketing-service");

const API = process.env.API_BASE || "http://127.0.0.1:8110";
const TAG = `sh${String(Date.now()).slice(-7)}`;
const org = randomUUID(), wal = randomUUID(), mer = randomUUID();
// A real 2x1 PNG, so "returns image bytes" means bytes that decode.
const POSTER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC";
const LONG_DESCRIPTION =
  "TitoPay is a South African digital payments platform built to make everyday payments smarter, simpler and more accessible.\n\n"
  + "With TitoPay, users can manage their wallet, send money, buy tickets and pay merchants from one place.";

const grab = (html, re) => (html.match(re) || [])[1] || "";

async function makeEvent(name, poster) {
  const draft = await ticketing.createEventDraft(org, {
    eventName: name, category: "conference", description: LONG_DESCRIPTION,
    eventDate: "2027-06-06", startTime: "09:00", endTime: "17:00",
    venueName: "TitoPay Head Office", fullVenueAddress: "1 St", city: "Johannesburg", province: "Gauteng",
    termsConditions: "t", refundPolicy: { summary: "s" },
    ...(poster ? { eventBannerUrl: poster } : {}),
    ticketTypes: [{ ticketName: "General", price: 0, quantityAvailable: 100 }]
  });
  await pool.query("UPDATE events SET status='approved', approved_at=NOW() WHERE id=$1", [draft.id]);
  return (await pool.query("SELECT slug FROM events WHERE id=$1", [draft.id])).rows[0].slug;
}

(async () => {
  let passed = 0; const ok = (m, d = "") => { console.log(`  PASS  ${m}${d ? "  — " + d : ""}`); passed++; };
  try {
    await ticketing.ensureTicketingSchema();
    await pool.query(`INSERT INTO users (id,account_type,full_name,username,email,phone,password_hash,status,profile_locked,fica_status)
      VALUES ($1,'business','${TAG} Org','${TAG}_o','${TAG}_o@example.invalid','27110000141','x','active',FALSE,'approved')`, [org]);
    await pool.query(`INSERT INTO wallets (id,wallet_number,user_id,kind,currency,available_balance,reserved_balance,status)
      VALUES ($1,$2,$3,'business','ZAR',0,0,'active')`, [wal, String(Date.now()).slice(-9), org]);
    await pool.query(`INSERT INTO merchants (id,user_id,business_name,merchant_id,status,verification_status)
      VALUES ($1,$2,$3,$4,'active','verified')`, [mer, org, `${TAG} Org`, `M${TAG}`]);

    const slug = await makeEvent(`${TAG} Launch`, POSTER);
    const bare = await makeEvent(`${TAG} No Poster`, null);

    // 1. What the app puts on the clipboard.
    const shareSource = fs.readFileSync(path.join(__dirname, "..", "pwa", "app.js"), "utf8");
    const shareFn = shareSource.slice(shareSource.indexOf("async function shareTicketingEvent"),
      shareSource.indexOf("async function openPublicTicketingEvent"));
    assert.match(shareFn, /const url = `\$\{origin\}\/events\/\$\{encodeURIComponent\(slug\)\}`/,
      "the app must share the real event link on its own origin");
    // Comments still describe the old link, and should; what must not survive is
    // an API path in the CODE.
    const shareCode = shareFn.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    assert.doesNotMatch(shareCode, /\/v1\/ticketing\/public\/events/,
      "the app must not hand an organiser an API path to send to their audience");
    assert.doesNotMatch(shareCode, /API_BASE/,
      "the shared link must not be built from the API host");
    ok("the app shares the real event link, not an API path", "https://app.titopay.co.za/events/<slug>");

    // 2-5. What a crawler gets.
    const previewUrl = `${API}/v1/ticketing/public/events/${encodeURIComponent(slug)}/preview`;
    const preview = await fetch(previewUrl);
    assert.equal(preview.status, 200);
    const html = await preview.text();

    assert.match(grab(html, /property="og:title" content="([^"]*)"/), new RegExp(TAG));
    assert.match(html, /property="og:url" content="https:\/\/app\.titopay\.co\.za\/events\//,
      "og:url must be the app link, so the crawler attributes the preview to the right page");
    ok("the preview carries the event's title, and points at the app link");

    const image = grab(html, /property="og:image" content="([^"]*)"/);
    assert.ok(image, "og:image is missing, so the poster will not appear in a shared link");
    assert.match(image, /\/v1\/ticketing\/public\/events\/[^"]+\/poster$/);
    assert.match(image, /^https?:\/\//, "og:image must be a URL a crawler can fetch, never a data: URL");
    ok("og:image points at a poster a crawler can fetch", image.replace(API, ""));

    const poster = await fetch(image.replace(/^https?:\/\/[^/]+/, API));
    assert.equal(poster.status, 200, `the poster URL answered ${poster.status}`);
    assert.match(poster.headers.get("content-type") || "", /^image\//,
      `the poster URL returned ${poster.headers.get("content-type")}`);
    const bytes = Buffer.from(await poster.arrayBuffer());
    assert.ok(bytes.length > 0, "the poster URL returned no bytes");
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "the bytes are not a PNG");
    ok("and that URL returns real image bytes", `${bytes.length} bytes, ${poster.headers.get("content-type")}`);

    const description = grab(html, /property="og:description" content="([^"]*)"/);
    assert.doesNotMatch(description, /[\r\n]/, "a raw line break went into an HTML attribute");
    assert.doesNotMatch(description, /manage their$/, "the description is still cut mid-sentence with no ellipsis");
    assert.ok(description.length <= 260, `the description is ${description.length} characters`);
    assert.match(description, /…$|Johannesburg$|accessible\.$/, "an extract must show that it is one");
    ok("the description is cut at a word boundary, with no raw line breaks", `"${description.slice(-46)}"`);

    // 6. Promoter attribution survives.
    const withRef = await fetch(`${previewUrl}?ref=ABC123`);
    const refHtml = await withRef.text();
    assert.match(refHtml, /https:\/\/app\.titopay\.co\.za\/events\/[^"?]+\?ref=ABC123/,
      "a promoter's ref did not survive the preview hop");
    ok("a promoter's ?ref= survives the hop, so attribution is not lost");

    // 7. No poster, no broken og:image.
    const bareHtml = await (await fetch(`${API}/v1/ticketing/public/events/${encodeURIComponent(bare)}/preview`)).text();
    assert.equal(grab(bareHtml, /property="og:image" content="([^"]*)"/), "",
      "an event with no poster must not offer an og:image that 404s");
    const barePoster = await fetch(`${API}/v1/ticketing/public/events/${encodeURIComponent(bare)}/poster`);
    assert.equal(barePoster.status, 404);
    ok("an event with no poster offers no og:image, rather than one that 404s");

    // 8. The Apache rule itself.
    const htaccess = fs.readFileSync(path.join(__dirname, "..", "pwa", ".htaccess"), "utf8");
    const rule = htaccess.match(/RewriteCond %\{HTTP_USER_AGENT\} \(([^)]+)\) \[NC\]\s*\n\s*RewriteRule (\S+) (\S+) \[([^\]]+)\]/);
    assert.ok(rule, "the crawler rule is missing from the app's .htaccess");
    for (const agent of ["WhatsApp", "facebookexternalhit", "Twitterbot", "Slackbot", "LinkedInBot"]) {
      assert.ok(rule[1].includes(agent), `${agent} is not routed to the preview`);
    }
    assert.match(rule[4], /R=302/, "the crawler hop must be a redirect, not a rewrite");
    // The pattern must match an event path and nothing else on the site.
    const pattern = new RegExp(rule[2]);
    assert.ok(pattern.test("events/titopay-launch"), "the rule does not match a real event path");
    assert.ok(pattern.test("events/titopay-launch/"), "the rule does not match a trailing slash");
    for (const other of ["", "index.html", "assets/app.png", "dashboard", "events", "verify-email/x", "events/a/b"]) {
      assert.equal(pattern.test(other), false, `the rule also matches "${other}", which it must not`);
    }
    ok("the Apache rule matches /events/<slug> and nothing else", `${rule[1].split("|").length} crawlers, 302`);

    // And the rule must run BEFORE the app-shell fallback, or it never fires.
    assert.ok(htaccess.indexOf("HTTP_USER_AGENT") < htaccess.indexOf("RewriteRule ^ index.html"),
      "the crawler rule must be declared before the single-page-app fallback");
    ok("and it is declared before the app-shell fallback, so it actually fires");

    console.log(`\n  ${passed}/9 checks passed\n`);
  } catch (error) { console.error("\nFAILED:", error.message); process.exitCode = 1; }
  finally {
    const events = (await pool.query("SELECT id FROM events WHERE business_user_id=$1", [org])).rows.map((r) => r.id);
    for (const id of events) {
      for (const table of ["tickets", "ticket_orders", "event_ticket_types", "event_audit_logs"]) {
        await pool.query(`DELETE FROM ${table} WHERE event_id=$1`, [id]).catch(() => {});
      }
      await pool.query("DELETE FROM events WHERE id=$1", [id]).catch(() => {});
    }
    await pool.query("DELETE FROM merchants WHERE id=$1", [mer]).catch(() => {});
    await pool.query("DELETE FROM wallets WHERE id=$1", [wal]).catch(() => {});
    await pool.query("DELETE FROM users WHERE id=$1", [org]).catch(() => {});
    await pool.end().catch(() => {});
  }
})();
