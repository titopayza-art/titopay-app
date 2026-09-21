"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/pool");
const { login, requirePermission } = require("../src/services/auth-service");
const { requireSuperAdmin } = require("../src/middleware/super-admin");

test.after(() => pool.end());

test("Chat Monitor authorization permits root owner, CEO and Super Admin roles", () => {
  for (const role of ["owner", "root", "ceo", "CEO", "super_admin", "super-admin", "Super Admin"]) {
    let called = false;
    requireSuperAdmin(
      { auth: { userType: "admin", role } },
      {},
      (error) => {
        assert.equal(error, undefined);
        called = true;
      }
    );
    assert.equal(called, true);
  }
});

test("Chat Monitor authorization rejects non-root staff roles", () => {
  for (const role of ["engineering", "customer_support", "finance", "marketing"]) {
    let received;
    requireSuperAdmin(
      { auth: { userType: "admin", role } },
      {},
      (error) => {
        received = error;
      }
    );
    assert.equal(received?.statusCode, 403);
  }
});

test("Super Admin receives wildcard access even when role formatting varies", async () => {
  for (const role of ["super_admin", "super-admin", "Super Admin"]) {
    await assert.doesNotReject(() => requirePermission({ user_type: "admin", role }, "integrations"));
    await assert.doesNotReject(() => requirePermission({ user_type: "admin", role }, "security"));
    await assert.doesNotReject(() => requirePermission({ user_type: "admin", role }, "analytics"));
  }
});

test("legacy Admin login lookup falls back safely when timestamp columns are missing", async () => {
  const originalQuery = pool.query;
  let fallbackUsed = false;
  pool.query = async (sql) => {
    const query = String(sql).replace(/\s+/g, " ").trim();
    if (query.startsWith("SELECT * FROM admin_users") && query.includes("updated_at DESC")) {
      const error = new Error("column updated_at does not exist");
      error.code = "42703";
      throw error;
    }
    if (query.startsWith("SELECT * FROM admin_users")) {
      fallbackUsed = true;
      return { rows: [] };
    }
    return { rows: [] };
  };
  try {
    await assert.rejects(
      login(
        { scope: "admin", identifier: "missing-admin", password: "invalid" },
        { ipAddress: "127.0.0.1", userAgent: "test" }
      ),
      (error) => error.statusCode === 401 && error.message === "Invalid credentials"
    );
    assert.equal(fallbackUsed, true);
  } finally {
    pool.query = originalQuery;
  }
});
