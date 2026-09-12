"use strict";

// THE SERVICE BUILDER'S REGISTRY LIVED IN ONE BROWSER.
//
// The console shipped with its banner saying so: definitions sat in
// localStorage until GET /admin/service-builder/services existed, and a
// cleared cache, a second machine, or a colleague's login started from
// nothing. These tests cover the endpoints that move the registry
// server-side, and the one infrastructure change they needed: a definition
// carries up to four branding images as data URIs, which does not fit the
// API's 768kb JSON ceiling — so exactly one path gets a larger parser, and
// these tests hold that every other path keeps the old one.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "sb-test-access-secret";
process.env.JWT_REFRESH_SECRET ||= "sb-test-refresh-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const builder = require("../src/services/service-builder-service");
const { pool } = require("../src/db/pool");

test("definitions round-trip: save, list, update, delete", async () => {
  const id = `svc_test_${Date.now().toString(36)}`;
  try {
    const saved = await builder.saveDefinition({ sbVersion: 1, id, name: "Test Service", status: "draft" }, null);
    assert.equal(saved.id, id);

    let listed = (await builder.listDefinitions()).find((item) => item.id === id);
    assert.ok(listed, "a saved definition must come back from the list");
    assert.equal(listed.name, "Test Service");

    await builder.saveDefinition({ sbVersion: 1, id, name: "Renamed Service", status: "active" }, null);
    listed = (await builder.listDefinitions()).find((item) => item.id === id);
    assert.equal(listed.name, "Renamed Service", "saving the same id must update, not duplicate");

    await builder.deleteDefinition(id);
    assert.equal((await builder.listDefinitions()).find((item) => item.id === id), undefined);
    await assert.rejects(() => builder.deleteDefinition(id), /not found/);
  } finally {
    await pool.query("DELETE FROM service_builder_definitions WHERE id = $1", [id]);
  }
});

test("a definition that is not a definition is refused", async () => {
  await assert.rejects(() => builder.saveDefinition(null), /definition object/);
  await assert.rejects(() => builder.saveDefinition([]), /definition object/);
  await assert.rejects(() => builder.saveDefinition({ id: "not-a-service-id", name: "x" }), /svc_/);
  await assert.rejects(() => builder.saveDefinition({ id: "svc_ok_1", name: "  " }), /needs a name/);
  const oversized = { id: "svc_big_1", name: "Big", blob: "x".repeat(builder.MAX_DEFINITION_BYTES) };
  await assert.rejects(() => builder.saveDefinition(oversized), /too large/);
});

test("the routes answer on the exact path the console module calls", () => {
  const module_ = fs.readFileSync(path.join(REPO, "admin", "assets", "admin-service-builder.js"), "utf8");
  assert.match(module_, /const SB_API_BASE = "\/admin\/service-builder\/services";/,
    "the console module's base path moved — the routes below must move with it");

  const routes = fs.readFileSync(path.join(REPO, "api", "src", "routes", "admin.routes.js"), "utf8");
  assert.match(routes, /router\.get\("\/service-builder\/services", requireAdminPermission\("services"\)/);
  assert.match(routes, /router\.post\("\/service-builder\/services", requireAdminPermission\("services"\)/);
  assert.match(routes, /router\.delete\("\/service-builder\/services\/:id", requireAdminPermission\("services"\)/);

  // The console flips to API storage only when the GET answer carries a
  // services array — the response key is part of the contract.
  assert.match(routes, /services: await listServiceBuilderDefinitions\(\)/);
  assert.match(module_, /Array\.isArray\(result\.services\)/);
});

test("only the service-builder POST gets the larger JSON parser", () => {
  // Raising the global limit for one feature would loosen every endpoint on
  // the API at once. The larger parser is pinned to the one admin-only path,
  // and the global ceiling is pinned to its old value.
  const app = fs.readFileSync(path.join(REPO, "api", "src", "app.js"), "utf8");
  assert.match(app, /const serviceBuilderJsonParser = express\.json\(\{ limit: "4mb", strict: true \}\);/);
  assert.match(app, /req\.method === "POST" && requestPath === "\/v1\/admin\/service-builder\/services"/,
    "the larger parser applies to exactly one method and path");
  assert.equal((app.match(/limit: "768kb"/g) || []).length, 2,
    "the global JSON and urlencoded ceilings stay at 768kb");
  assert.equal((app.match(/limit: "4mb"/g) || []).length, 1,
    "no second route quietly borrows the larger parser");
});
