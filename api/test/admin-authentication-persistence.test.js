"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/pool");
const {
  getAdminAuthenticationPolicy,
  setAdminAuthenticationPolicy
} = require("../src/services/platform-settings-service");

test.after(() => pool.end());

test("saved Admin authentication mode is returned after a fresh policy read", async () => {
  const originalQuery = pool.query;
  let savedValue = null;
  pool.query = async (sql, params = []) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("CREATE TABLE IF NOT EXISTS platform_settings")) return { rows: [] };
    if (query.startsWith("INSERT INTO platform_settings") && query.includes("updated_by")) {
      savedValue = JSON.parse(params[1]);
      return { rows: [{ value: savedValue, updated_at: "2026-08-05T09:00:00.000Z" }] };
    }
    if (query.startsWith("SELECT value FROM platform_settings")) {
      return { rows: savedValue ? [{ value: savedValue }] : [] };
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  try {
    const saved = await setAdminAuthenticationPolicy({
      mode: "password_email_otp",
      updatedBy: "11111111-1111-4111-8111-111111111111"
    });
    assert.equal(saved.mode, "password_email_otp");
    assert.equal(saved.otpRequired, true);

    const reloaded = await getAdminAuthenticationPolicy();
    assert.equal(reloaded.mode, "password_email_otp");
    assert.equal(reloaded.otpRequired, true);
    assert.equal(reloaded.source, "database");
  } finally {
    pool.query = originalQuery;
  }
});

test("database initialization never resets an existing authentication choice", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../src/db/schema.sql"), "utf8");
  const settingSeed = schema.match(/INSERT INTO platform_settings \(key, value\)[\s\S]*?ON CONFLICT \(key\)[^;]*;/)?.[0] || "";
  assert.match(settingSeed, /ON CONFLICT \(key\) DO NOTHING/);
  assert.doesNotMatch(settingSeed, /DO UPDATE SET value/);
});

test("every Admin entry page forces the same cache-busted asset build", () => {
  const adminRoot = path.join(__dirname, "../../admin");
  const htmlFiles = [];
  const collectHtml = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collectHtml(absolute);
      else if (entry.name.endsWith(".html")) htmlFiles.push(absolute);
    }
  };
  collectHtml(adminRoot);
  const admin = fs.readFileSync(path.join(__dirname, "../../admin/assets/admin.js"), "utf8");
  assert.ok(htmlFiles.length > 20);

  // What matters is that the console ships as ONE build: an operator must never
  // get this release's admin.js against a cached admin.css, or one page's
  // markup against another page's script. The build number itself moves every
  // release, so it is read from the entry page rather than written down here —
  // pinning a literal only ever produces a test that fails for being old.
  const entry = fs.readFileSync(path.join(adminRoot, "index.html"), "utf8");
  const build = entry.match(/<meta name="titopay-admin-build" content="(admin-console-v\d+)">/)?.[1];
  assert.ok(build, "admin/index.html must declare its build in a titopay-admin-build meta tag");

  const script = new RegExp(`admin\\.js\\?v=${build}(?![\\w-])`);
  const stylesheet = new RegExp(`admin\\.css\\?v=${build}(?![\\w-])`);
  let entryPages = 0;
  for (const htmlFile of htmlFiles) {
    const html = fs.readFileSync(htmlFile, "utf8");
    const where = path.relative(adminRoot, htmlFile);

    // 403 and 404 are static notices that deliberately load no console script.
    // They still carry the stylesheet, so they still have to match the build.
    if (script.test(html) || /admin\.js\?v=/.test(html)) {
      assert.match(html, script, where);
      entryPages += 1;
    }
    assert.match(html, stylesheet, where);

    // Nothing may quietly reference an older build alongside the current one.
    const stale = (html.match(/admin-console-v\d+/g) || []).filter((v) => v !== build);
    assert.deepEqual(stale, [], `${where} still points at ${stale.join(", ")} while the console ships ${build}`);
  }
  assert.ok(entryPages > 20, `only ${entryPages} pages load the console script`);

  // The lazily imported modules are fetched by admin.js at ADMIN_ASSET_VERSION.
  // If that falls behind the build in the markup, a console upgrade ships new
  // pages against cached modules — which is exactly what happened between v63
  // and v73. It now reads the stamp off its own script tag, and the written-down
  // fallback has to agree with the build too.
  const fallback = admin.match(/return "(admin-console-v\d+)";/)?.[1];
  assert.equal(fallback, build, "the ADMIN_ASSET_VERSION fallback in admin.js must match the shipped build");
  assert.match(admin, /searchParams\.get\("v"\)/, "admin.js must read its build stamp from its own script tag");
  assert.match(admin, /name="mode" value="password_only"/);
  assert.match(admin, /name="mode" value="password_email_otp"/);
  assert.match(admin, /Save Authentication Mode/);
  assert.match(admin, /Wallet Unlock Authentication/);
  assert.match(admin, /events=\["wallet_unlock"/);
});
