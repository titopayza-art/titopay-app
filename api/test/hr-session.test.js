"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(
  path.join(__dirname, "../../hr/hr-session.js"),
  "utf8"
);

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function runBridge(nativeFetch, initialStorage) {
  const localStorage = storage(initialStorage);
  const window = { fetch: nativeFetch };
  const location = {
    pathname: "/attendance",
    replace() {},
    assign() {}
  };
  vm.runInNewContext(bridgeSource, {
    window,
    localStorage,
    location,
    Headers,
    Request,
    JSON
  });
  return { fetch: window.fetch, localStorage };
}

test("HR session bridge replaces a stale compiled Authorization header", async () => {
  const calls = [];
  const nativeFetch = async (input, init = {}) => {
    calls.push({ url: String(input), headers: new Headers(init.headers) });
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const bridge = runBridge(nativeFetch, {
    titopay_hr_session_build: "6",
    hr_token: "latest-access-token",
    hr_refresh_token: "refresh-token",
    hr_user: JSON.stringify({ id: "employee-1" })
  });

  await bridge.fetch("https://api.titopay.co.za/api/v1/hr/attendance", {
    headers: { Authorization: "Bearer stale-compiled-token" }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("authorization"), "Bearer latest-access-token");
});

test("HR login stores the scoped session and every HR module sends its access token", async () => {
  const calls = [];
  const nativeFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    calls.push({ url, authorization: headers.get("authorization") });
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({
        token: "hr-scoped-access-token",
        accessToken: "hr-scoped-access-token",
        refreshToken: "hr-scoped-refresh-token",
        user: { id: "employee-1", role: "Employee" }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const bridge = runBridge(nativeFetch, {
    titopay_hr_session_build: "6"
  });

  await bridge.fetch("https://api.titopay.co.za/api/v1/hr/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "employee@titopay.co.za", password: "test-only" })
  });

  const modules = [
    "attendance", "employees", "leave", "payroll", "jobs", "projects",
    "meetings", "expenses", "performance", "onboarding"
  ];
  for (const moduleName of modules) {
    await bridge.fetch(`https://api.titopay.co.za/api/v1/hr/${moduleName}`);
  }

  assert.equal(bridge.localStorage.getItem("hr_token"), "hr-scoped-access-token");
  assert.equal(bridge.localStorage.getItem("hr_refresh_token"), "hr-scoped-refresh-token");
  assert.deepEqual(
    calls.slice(1).map((call) => call.authorization),
    modules.map(() => "Bearer hr-scoped-access-token")
  );
});

test("HR session bridge rotates an expired access token and retries once", async () => {
  const calls = [];
  const nativeFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    calls.push({ url, authorization: headers.get("authorization") });
    if (url.endsWith("/auth/refresh")) {
      return new Response(JSON.stringify({
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (calls.filter((call) => call.url.endsWith("/attendance")).length === 1) {
      return new Response(JSON.stringify({ error: "HR session expired" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const bridge = runBridge(nativeFetch, {
    titopay_hr_session_build: "6",
    hr_token: "expired-access-token",
    hr_refresh_token: "original-refresh-token",
    hr_user: JSON.stringify({ id: "employee-1" })
  });

  const response = await bridge.fetch("https://api.titopay.co.za/api/v1/hr/attendance");

  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).authorization, "Bearer rotated-access-token");
  assert.equal(bridge.localStorage.getItem("hr_token"), "rotated-access-token");
  assert.equal(bridge.localStorage.getItem("hr_refresh_token"), "rotated-refresh-token");
});

test("HR session bridge clears legacy browser sessions once before the portal boots", () => {
  const bridge = runBridge(async () => new Response(null, { status: 204 }), {
    hr_token: "legacy-access-token",
    hr_refresh_token: "legacy-refresh-token",
    hr_user: JSON.stringify({ id: "legacy-user" }),
    hr_mode: "live-api"
  });

  assert.equal(bridge.localStorage.getItem("hr_token"), null);
  assert.equal(bridge.localStorage.getItem("hr_refresh_token"), null);
  assert.equal(bridge.localStorage.getItem("hr_user"), null);
  assert.equal(bridge.localStorage.getItem("hr_mode"), null);
  assert.equal(bridge.localStorage.getItem("titopay_hr_session_build"), "6");
});
