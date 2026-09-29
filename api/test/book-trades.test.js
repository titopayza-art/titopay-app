"use strict";

// TRADES IN TITOPAY BOOK.
//
// A plumber, an electrician, an appliance technician and a handyman are now
// bookable the same way a restaurant table is. The engine did not change - a
// trade is "a resource with capacity, for a span of time" like everything else
// already in the catalogue.
//
// What is pinned here is the judgement, not the spelling:
//
//   1. a trade books a JOB, not an appointment - the word reaches the screen;
//   2. only CALLOUT-SHAPED trades are listed, because the engine caps a span
//      at 1440 minutes and a painter on a three-day job is not a slot;
//   3. adding them did not disturb any category that already existed;
//   4. the category list is configuration, so the business-side picker gets
//      them with no migration and no second list to maintain.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const reference = require("../src/config/book-reference");

const TRADES = ["plumber", "electrician", "appliance_repair", "handyman"];

test("the four trades are real, bookable categories", () => {
  for (const key of TRADES) {
    assert.equal(reference.isCategory(key), true, `${key} must validate`);
    const category = reference.category(key);
    assert.equal(category.group, "Trades", `${key} belongs to the Trades group`);
    assert.ok(category.label && category.hint, `${key} needs a label and a hint`);
  }
});

test("A TRADE BOOKS A JOB, NOT AN APPOINTMENT", () => {
  // The word reaches the customer. Somebody with a burst geyser is not making
  // an appointment, they are getting somebody out, and the screen should say so.
  for (const key of TRADES) {
    assert.equal(reference.bookingWord(key), "Job", `${key} books a Job`);
  }
  // And the resource is a person with a van, never a room or a chair.
  const resourceWords = TRADES.map((key) => reference.resourceWord(key));
  assert.deepEqual(resourceWords, ["Plumber", "Electrician", "Technician", "Handyman"]);
});

test("ONLY CALLOUT-SHAPED TRADES ARE OFFERED", () => {
  // book_services_duration_check caps a booked span at 1440 minutes. A trade
  // whose work runs over days cannot be modelled as a slot without the diary
  // lying about availability from the first booking, so it is not listed until
  // there is a project model to put it in.
  const schema = fs.readFileSync(path.join(__dirname, "..", "src", "services", "book-schema.js"), "utf8");
  assert.match(schema, /duration_minutes > 0 AND duration_minutes <= 1440/,
    "the cap this decision rests on still exists");

  const multiDay = ["painter", "builder", "tiler", "renovation", "roofer", "paving"];
  for (const key of multiDay) {
    assert.equal(reference.isCategory(key), false,
      `${key} runs over days and must not be offered as a time slot`);
  }
});

test("adding trades disturbed nothing that was already there", () => {
  // Every category that existed before must still validate, in its own group.
  const untouched = {
    restaurant: "Dining", cafe: "Dining", bakery: "Dining",
    doctor: "Health", dentist: "Health", clinic: "Health",
    car_wash: "Automotive", auto_detailing: "Automotive", auto_service: "Automotive",
    salon: "Beauty", barber: "Beauty", spa: "Beauty", beauty_studio: "Beauty",
    gym: "Fitness", fitness_studio: "Fitness", personal_training: "Fitness",
    hotel: "Hospitality", guesthouse: "Hospitality",
    experience: "Experiences", studio: "Experiences",
    other: "Other"
  };
  for (const [key, group] of Object.entries(untouched)) {
    assert.equal(reference.isCategory(key), true, `${key} still validates`);
    assert.equal(reference.category(key).group, group, `${key} kept its group`);
  }
  assert.equal(reference.CATEGORY_KEYS.length, Object.keys(untouched).length + TRADES.length,
    "exactly four categories were added and none removed");
});

test("a trade's availability counter is public, like every trade's should be", () => {
  // Doctors, dentists and clinics hide theirs because a pollable "3 slots left"
  // is a patient-load signal. For a plumber it is the marketing - a customer
  // choosing between two wants to see who can come today.
  for (const key of TRADES) {
    assert.equal(reference.defaultShowsAvailabilityCount(key), true, `${key} may show open slots`);
  }
});

test("the category keys stay machine-safe", () => {
  // These become URL segments and stored values on book_venues.category, which
  // carries no CHECK constraint - the config IS the constraint.
  for (const key of reference.CATEGORY_KEYS) {
    assert.match(key, /^[a-z][a-z0-9_]*$/, `${key} is lowercase snake_case`);
  }
  assert.equal(new Set(reference.CATEGORY_KEYS).size, reference.CATEGORY_KEYS.length, "no duplicates");
});

// ---------------------------------------------------------------------------
// THE APP'S SIDE. The grid is two columns and the group list decides its shape,
// so these are layout rules expressed as source checks - cheap, and they fail
// when somebody adds a ninth group rather than when a customer sees it broken.
// ---------------------------------------------------------------------------

const APP = fs.readFileSync(path.join(__dirname, "..", "..", "pwa", "app.js"), "utf8");

function bookGroups() {
  const block = APP.match(/const BOOK_GROUPS = \[([\s\S]*?)\n\];/);
  assert.ok(block, "BOOK_GROUPS must still be a literal the test can read");
  return [...block[1].matchAll(/\["([^"]+)",\s*"([^"]+)",\s*\[([^\]]*)\]\]/g)]
    .map((row) => ({ label: row[1], glyph: row[2], keys: row[3].match(/"([^"]+)"/g).map((k) => k.replaceAll('"', "")) }));
}

test("THE GRID DOES NOT STRAND A TILE, WHATEVER THE GROUP COUNT", () => {
  // .bk-grid is two columns. The final tile spans both ONLY when the count is
  // odd and it would otherwise sit alone. Written as "always widen the last
  // one" this was right at seven groups and wrong at eight - it stranded the
  // seventh, which is the ragged wrap the group list exists to prevent.
  assert.match(APP, /function bookTileIsWide\(index\)\s*\{\s*return index === BOOK_GROUPS\.length - 1 && BOOK_GROUPS\.length % 2 === 1;/,
    "the wide-tile rule must depend on the parity, not on the number seven");
  assert.ok(!/index === BOOK_GROUPS\.length - 1 \? " bk-tile-wide"/.test(APP),
    "the old unconditional rule must be gone");

  // And the rule is correct for the count actually shipping.
  const groups = bookGroups();
  const wide = groups.map((_, index) => index === groups.length - 1 && groups.length % 2 === 1);
  assert.equal(wide.filter(Boolean).length, groups.length % 2 === 1 ? 1 : 0);
  assert.equal((groups.length + wide.filter(Boolean).length) % 2, 0,
    "every row ends up full - no tile alone in a row");
});

test("Trades is on the browse grid, and no two groups share a glyph", () => {
  const groups = bookGroups();
  const trades = groups.find((group) => group.label === "Trades");
  assert.ok(trades, "the Trades group is on the grid");
  assert.equal(trades.glyph, "maintenance");
  assert.deepEqual(trades.keys, TRADES, "and points at the four trade categories");

  // Car used to borrow the wrench. Two tiles side by side wearing the same
  // glyph reads as a rendering fault, not as two categories.
  const glyphs = groups.map((group) => group.glyph);
  assert.equal(new Set(glyphs).size, glyphs.length, `duplicate glyph among: ${glyphs.join(", ")}`);
  assert.equal(groups.find((group) => group.label === "Car").glyph, "car");
  assert.match(APP, /\n    car: `<path d="M19 17h2/, "the car glyph is drawn, not just named");
});

test("EVERY GROUP GLYPH EXISTS - a missing one renders an empty tile", () => {
  for (const { label, glyph } of bookGroups()) {
    assert.ok(new RegExp(`\\n    (?:"${glyph}"|${glyph}): \``).test(APP),
      `${label} asks for the "${glyph}" icon, which is not in ICON_PATHS`);
  }
});

test("every group key is a category the API will accept", () => {
  // A tile pointing at a key the reference does not know returns an empty
  // browse with no error, which is the worst way for this to fail.
  for (const { label, keys } of bookGroups()) {
    for (const key of keys) {
      assert.equal(reference.isCategory(key), true, `${label} points at unknown category "${key}"`);
    }
  }
});

test("no category is orphaned from the browse grid except the catch-all", () => {
  // A category a business can choose but nobody can browse to is a listing
  // that will never be found. "other" is deliberately unbrowsable.
  const onGrid = new Set(bookGroups().flatMap((group) => group.keys));
  const orphans = reference.CATEGORY_KEYS.filter((key) => key !== "other" && !onGrid.has(key));
  assert.deepEqual(orphans, [], `not reachable from any tile: ${orphans.join(", ")}`);
});
