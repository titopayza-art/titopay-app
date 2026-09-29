"use strict";

/* EVENT DISCOVERY, ON THE REAL API.
 *
 * The old screen pulled up to 100 events and filtered them in the browser, so
 * search only ever covered whatever batch the phone happened to hold. These
 * checks prove the search and the category filter are answered by the database,
 * over the whole approved catalogue.
 *
 *  1. Browsing with no filter returns approved events, and only approved ones.
 *  2. Search matches the event name.
 *  3. Search matches the city and the venue, not just the title.
 *  4. Search is case-insensitive and matches partial words.
 *  5. A search that matches nothing returns an empty list, not an error.
 *  6. Search cannot be used to inject SQL.
 *  7. The category filter returns only that category.
 *  8. Category counts are built from the whole catalogue, so a chip survives
 *     being tapped.
 *  9. Search and category combine.
 * 10. An unauthenticated visitor can browse: this is the shop window.
 *
 * Run: node verification/event-discovery-live.js
 */

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const API = path.join(__dirname, "..", "api");
const { pool } = require(path.join(API, "src", "db", "pool.js"));
const ticketing = require(path.join(API, "src", "services", "ticketing-service.js"));

const TAG = crypto.randomUUID().slice(0, 8).toUpperCase();
let passed = 0;
const ok = (m, extra = "") => { passed += 1; console.log("  PASS  " + m + (extra ? `  [${extra}]` : "")); };
const created = { users: [], events: [] };

async function seedEvent({ name, category, city, venue, status = "approved" }) {
  const organiserId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, account_type, full_name, username, email, password_hash, status, fica_status)
     VALUES ($1,'business','Discovery Organiser',$2,$3,'x','active','verified')`,
    [organiserId, `dsc_${crypto.randomUUID().slice(0, 8)}`, `dsc-${crypto.randomUUID().slice(0, 8)}@example.test`]);
  const eventId = crypto.randomUUID();
  const slug = `dsc-${crypto.randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO events (id, business_user_id, event_name, slug, status, category, city, province, venue_name, event_date, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Gauteng',$8, CURRENT_DATE + 30, NOW())`,
    [eventId, organiserId, name, slug, status, category, city, venue]);
  await pool.query(
    `INSERT INTO event_ticket_types (id, event_id, ticket_name, price, quantity_available, sort_order)
     VALUES (gen_random_uuid(),$1,'General',150,100,10)`, [eventId]);
  created.users.push(organiserId);
  created.events.push(eventId);
  return { eventId, slug, name };
}

async function cleanup() {
  for (const eventId of created.events) {
    await pool.query("DELETE FROM event_ticket_types WHERE event_id = $1", [eventId]).catch(() => {});
    await pool.query("DELETE FROM events WHERE id = $1", [eventId]).catch(() => {});
  }
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [created.users]).catch(() => {});
}

(async () => {
  const { app } = require(path.join(API, "src", "app.js"));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Deliberately NO Authorization header anywhere in this harness.
  const browse = async (query = "") => {
    const res = await fetch(`${base}/v1/ticketing/public/events${query}`);
    return { status: res.status, payload: await res.json() };
  };

  try {
    await ticketing.ensureTicketingSchema();
    console.log("\n" + "=".repeat(78));
    console.log("  EVENT DISCOVERY: SEARCH, CATEGORIES, SHOP WINDOW");
    console.log("=".repeat(78) + "\n");

    const jazz = await seedEvent({ name: `${TAG} Midnight Jazz Session`, category: "Music & Concerts", city: "Johannesburg", venue: "The Orbit" });
    const marathon = await seedEvent({ name: `${TAG} Coastal Marathon`, category: "Sports & Fitness", city: "Durban", venue: "Beachfront" });
    const summit = await seedEvent({ name: `${TAG} Fintech Summit`, category: "Conferences & Business", city: "Cape Town", venue: "CTICC" });
    const draft = await seedEvent({ name: `${TAG} Secret Unapproved Party`, category: "Nightlife & Parties", city: "Pretoria", venue: "Hidden", status: "draft" });

    // ---- 1. browsing returns approved events only --------------------------
    //
    // Scoped by this run's tag rather than read off the unfiltered list. The
    // unfiltered list is capped and ordered soonest-first, which is the right
    // product behaviour and means a freshly seeded event 30 days out is not
    // guaranteed to be on the first page of a catalogue this size.
    const all = await browse();
    assert.equal(all.status, 200);
    assert.ok(all.payload.items.length > 0, "the shop window is not empty");
    assert.ok(all.payload.items.every((item) => item.status === "approved"),
      "every event in the window is approved");
    const mine = await browse(`?search=${encodeURIComponent(TAG)}`);
    const names = mine.payload.items.map((item) => item.eventName);
    assert.ok(names.includes(jazz.name) && names.includes(marathon.name) && names.includes(summit.name),
      `expected all three seeded events, got ${JSON.stringify(names)}`);
    assert.ok(!names.includes(draft.name), "an unapproved event must never appear in the shop window");
    ok("browsing returns approved events, and never an unapproved one",
      `${all.payload.items.length} in the window`);

    // ---- 2. search by event name -------------------------------------------
    const byName = await browse(`?search=${encodeURIComponent(`${TAG} Midnight`)}`);
    assert.equal(byName.payload.items.length, 1, JSON.stringify(byName.payload.items.map((i) => i.eventName)));
    assert.equal(byName.payload.items[0].eventName, jazz.name);
    ok("search finds an event by its name");

    // ---- 3. search by city and by venue -------------------------------------
    const byCity = await browse(`?search=${encodeURIComponent("Durban")}`);
    assert.ok(byCity.payload.items.some((item) => item.eventName === marathon.name), "city search works");
    const byVenue = await browse(`?search=${encodeURIComponent("CTICC")}`);
    assert.ok(byVenue.payload.items.some((item) => item.eventName === summit.name), "venue search works");
    ok("search covers the city and the venue, not only the title");

    // ---- 4. case-insensitive and partial ------------------------------------
    const shouty = await browse(`?search=${encodeURIComponent(`${TAG} mIdNiGhT jAzZ`)}`);
    assert.equal(shouty.payload.items.length, 1, "case must not matter");
    const partial = await browse(`?search=${encodeURIComponent("ntech Summ")}`);
    assert.ok(partial.payload.items.some((item) => item.eventName === summit.name), "a partial word matches");
    ok("search ignores case and matches part of a word");

    // ---- 5. no match is an empty list, not an error --------------------------
    const nothing = await browse(`?search=${encodeURIComponent("zzzz-no-such-event-zzzz")}`);
    assert.equal(nothing.status, 200);
    assert.equal(nothing.payload.items.length, 0);
    assert.ok(Array.isArray(nothing.payload.categories) && nothing.payload.categories.length > 0,
      "the chips stay on screen so the buyer has a way back out");
    ok("a search with no match returns an empty list and keeps the categories");

    // ---- 6. the search box cannot become SQL ---------------------------------
    for (const nasty of ["' OR '1'='1", "'; DROP TABLE events; --", "100%' --"]) {
      const res = await browse(`?search=${encodeURIComponent(nasty)}`);
      assert.equal(res.status, 200, `injection attempt must be handled: ${nasty}`);
      assert.ok(Array.isArray(res.payload.items));
    }
    const stillThere = (await pool.query("SELECT to_regclass('public.events') AS t")).rows[0].t;
    assert.ok(stillThere, "the events table is intact");
    ok("the search box cannot be used to inject SQL");

    // ---- 7. category filter --------------------------------------------------
    const music = await browse(`?category=${encodeURIComponent("Music & Concerts")}`);
    assert.ok(music.payload.items.every((item) => item.category === "Music & Concerts"),
      "a category filter returns only that category");
    assert.ok(music.payload.items.some((item) => item.eventName === jazz.name));
    ok("the category filter returns only that category");

    // ---- 8. counts come from the whole catalogue -----------------------------
    const facets = music.payload.categories || [];
    const sportsChip = facets.find((entry) => entry.category === "Sports & Fitness");
    assert.ok(sportsChip && sportsChip.count > 0,
      "a chip for a category the buyer is NOT in must still be offered, or the filter is a trap");
    assert.ok(facets.every((entry) => Number.isInteger(entry.count) && entry.count > 0));
    ok("category chips are built from the whole catalogue, so a filter can always be undone",
      `${facets.length} categories offered`);

    // ---- 9. search and category combine ---------------------------------------
    const both = await browse(`?search=${encodeURIComponent(TAG)}&category=${encodeURIComponent("Sports & Fitness")}`);
    assert.equal(both.payload.items.length, 1);
    assert.equal(both.payload.items[0].eventName, marathon.name);
    const contradiction = await browse(`?search=${encodeURIComponent("Midnight")}&category=${encodeURIComponent("Sports & Fitness")}`);
    assert.equal(contradiction.payload.items.length, 0, "the two filters are ANDed, not ORed");
    ok("search and category narrow together");

    // ---- 10. no sign-in needed -------------------------------------------------
    assert.equal(all.status, 200, "browsing needs no token");
    const categoriesRes = await fetch(`${base}/v1/ticketing/public/event-categories`);
    const categoriesPayload = await categoriesRes.json();
    assert.equal(categoriesRes.status, 200);
    assert.ok(categoriesPayload.categories.includes("Music & Concerts"));
    ok("a visitor with no account can browse and read the category list");

    console.log(`\n${passed}/10 checks passed. Search reaches the whole catalogue, and the window is open to everyone.\n`);
  } catch (error) {
    console.error("\n  FAIL:", error.message);
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await cleanup();
    server.close();
    await pool.end();
  }
})();
