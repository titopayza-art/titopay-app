"use strict";

// THE ONE-SHOT THAT ADDS THE TITOPRO TILE, DRIVEN ON ITS OWN.
//
// addTitoProTileOnce exists because the seed in ensureDefaultServices only
// writes when the catalogue is SHORT: adding a row to DEFAULT_SERVICES reaches
// a fresh installation and, in principle, nothing else. Its INSERT named three
// columns that do not exist on service_config - icon, display_order and badge,
// against the real service_icon, sort_order and feature_badge - so it threw on
// every run and the catch around it turned that into a log line.
//
// WHAT MADE THAT HARD TO SEE is the thing this file is shaped around. The
// seed's "is the catalogue short" test counts the DEFAULT_SERVICES codes
// PRESENT, so a database missing only this one reads as short and the seed
// inserts the tile correctly on its way past. Every test that went through
// ensureDefaultServices therefore passed with the repair completely broken:
// the seed got there first. The repair is the belt to the seed's braces, and a
// broken belt is only discovered the day the braces are needed.
//
// So the repair is called DIRECTLY here. That is the only way to prove it does
// its own job rather than watching something else do it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = process.env.POSTGRES_URL || "postgres://test:test@127.0.0.1:5432/titopay";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const services = require("../src/services/service-management-service");

const FIXUP_KEY = "services_titopro_tile_2026_09";

// The state of an installed database that predates TitoPro: a full catalogue,
// no TitoPro row, and the one-shot never applied.
async function asAnInstalledDatabaseWithoutTitoPro() {
  await pool.query("DELETE FROM service_config WHERE service_code = 'titopro'");
  await pool.query("DELETE FROM platform_settings WHERE key = $1", [FIXUP_KEY]);
}

test.before(async () => {
  await services.ensureDefaultServices();
});

test("THE REPAIR ADDS THE TILE BY ITSELF, WITH NO SEED TO COVER FOR IT", async () => {
  await asAnInstalledDatabaseWithoutTitoPro();

  // Called directly. Through ensureDefaultServices the seed would insert this
  // row first and this test would pass with the repair throwing, which is
  // exactly how the fault survived.
  await services.addTitoProTileOnce();

  const { rows } = await pool.query(
    `SELECT service_name, service_icon, action, description, status,
            personal_visible, business_visible, sort_order, feature_badge
       FROM service_config WHERE service_code = 'titopro'`);
  assert.equal(rows.length, 1, "a thrown INSERT leaves the tile absent");

  const tile = rows[0];
  assert.equal(tile.service_name, "TitoPro");
  assert.equal(tile.status, "active");
  assert.equal(tile.action, "titopro", "the action is what the app dispatches on");
  // Personal AND business: a salon owner needs an electrician just as much as
  // a household does.
  assert.equal(tile.personal_visible, true);
  assert.equal(tile.business_visible, true);
  // 306 puts it beside Book. The original INSERT wrote this value into a column
  // that does not exist and pinned the real one to 0, which would have put
  // TitoPro at the very top of the catalogue, above Top Up.
  assert.equal(tile.sort_order, 306);
  assert.equal(tile.feature_badge, "new");
  assert.ok(tile.service_icon, "a tile with no icon renders as a blank square");
  assert.match(tile.description, /verified/i);
});

test("the run is recorded, so it cannot repeat on every catalogue read", async () => {
  await asAnInstalledDatabaseWithoutTitoPro();
  await services.addTitoProTileOnce();
  const { rows } = await pool.query(
    "SELECT value FROM platform_settings WHERE key = $1", [FIXUP_KEY]);
  // The marker was written AFTER the INSERT, so a throwing INSERT never
  // reached it: the broken repair re-ran and re-logged on every single read.
  assert.equal(rows.length, 1, "without the marker the repair re-runs forever");
  assert.ok(rows[0].value.appliedAt, "and says when it ran");
});

test("THE REPAIR RUNS ONCE AND THEN LEAVES AN OPERATOR'S DECISION ALONE", async () => {
  await asAnInstalledDatabaseWithoutTitoPro();
  await services.addTitoProTileOnce();

  // An operator decides TitoPro is not for them and turns it off.
  await pool.query("UPDATE service_config SET status = 'disabled' WHERE service_code = 'titopro'");
  await services.addTitoProTileOnce();

  const { rows } = await pool.query("SELECT status FROM service_config WHERE service_code = 'titopro'");
  assert.equal(rows[0].status, "disabled",
    "a one-shot corrects a default once; it never overrides a choice");
});

test("and the tile is served to the app, not merely present in the table", async () => {
  await asAnInstalledDatabaseWithoutTitoPro();
  await services.ensureDefaultServices();
  const served = (await services.listServices()).find((row) => row.service_code === "titopro");
  assert.ok(served, "listServices is what every surface reads");
  assert.equal(served.status, "active",
    "TitoPro is not capability-gated - it buys nothing from a supplier");
});

// THE CLASS, NOT THE INSTANCE. The fault was a column name, and a column name
// is something a database can be asked about directly - so it is asked, for
// every INSERT in the file, rather than trusted.
test("EVERY COLUMN WRITTEN TO service_config REALLY EXISTS", async () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/services/service-management-service.js"), "utf8");
  const { rows } = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'service_config'");
  const columns = new Set(rows.map((row) => row.column_name));

  const named = new Set();
  for (const match of source.matchAll(/INSERT INTO service_config\s*\(([^)]+)\)/g)) {
    for (const column of match[1].split(",")) {
      const clean = column.trim().replace(/\s+/g, " ");
      if (clean && /^[a-z_]+$/.test(clean)) named.add(clean);
    }
  }
  assert.ok(named.size >= 10, `expected to find the insert column lists, found ${named.size}`);
  const missing = [...named].filter((column) => !columns.has(column));
  assert.deepEqual(missing, [],
    `these columns are written to service_config and do not exist: ${missing.join(", ")}`);
});

test.after(async () => {
  await pool.end().catch(() => null);
});
