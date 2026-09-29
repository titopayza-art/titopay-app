"use strict";

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";
process.env.API_BASE_URL = "https://api.titopay.co.za";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("scoped HR authentication loads every production HR module route", async () => {
  const originalQuery = pool.query;
  const sessionId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const accessJti = crypto.randomUUID();
  const accessToken = signAccessToken({
    sub: userId,
    sid: sessionId,
    jti: accessJti,
    email: "ceo@titopay.test",
    role: "CEO",
    scope: "hr",
    typ: "hr"
  });

  let sessionQueryCount = 0;
  pool.query = async (sql) => {
    const statement = String(sql).replace(/\s+/g, " ").trim();
    if (statement.startsWith("UPDATE hr_sessions AS s") && statement.includes("s.access_jti")) {
      sessionQueryCount += 1;
      return {
        rows: [{
          session_id: sessionId,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
          id: userId,
          email: "ceo@titopay.test",
          name: "Test CEO",
          role: "CEO",
          status: "active",
          employee_id: null
        }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  };

  const server = await listen();
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/hr`;
    const modules = [
      "dashboard", "attendance", "employees", "leave", "payroll", "jobs",
      "projects", "meetings", "expenses", "performance", "onboarding"
    ];
    for (const moduleName of modules) {
      const response = await fetch(`${baseUrl}/${moduleName}?page=1&limit=20`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const payload = await response.json();
      assert.equal(response.status, 200, `${moduleName}: ${payload.error || "unexpected response"}`);
    }
    assert.equal(sessionQueryCount, modules.length, "each HR request must authenticate and touch its session in one query");
  } finally {
    pool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }
});
