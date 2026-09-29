"use strict";

// A PROVIDER SLOT CAN BE RENAMED. IT CANNOT BE REPOINTED.
//
// TitoPay's Integration Health table named the companies it was built against
// - Peach, DocFox, OTT, Flash - and those names were hard-coded. The day a
// different KYC house or a different VAS aggregator is contracted, an operator
// would be reading a supplier's name on a row that is calling somebody else's
// API, or reading the right name on nothing at all.
//
// So the label became editable. The key did not, and that distinction is the
// whole point of this file. The key selects the adapter: which endpoints are
// called, how the request is signed, which webhook consumer reads the
// callback. A console that could edit it would let somebody point a live money
// rail at a vendor whose protocol the code has never spoken.
//
// What is defended here:
//   1. a rename changes the label everywhere the label is read;
//   2. a rename writes NO credential - the provider's own settings row, the
//      one holding encrypted secrets, is never opened;
//   3. an unknown slot cannot be invented by renaming it;
//   4. the name cannot carry markup or control characters;
//   5. a blank name restores the catalogue's own label rather than emptying it.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL = "postgres://test:test@127.0.0.1:5432/test";
process.env.JWT_ACCESS_SECRET = "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { app } = require("../src/app");
const { pool } = require("../src/db/pool");
const { signAccessToken } = require("../src/lib/jwt");

const DISPLAY_NAME_KEY = "integration_provider_display_names";

function listen() {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// One super-admin session, one in-memory platform_settings table, and a record
// of every statement the request ran so the test can assert on what was NOT
// written as well as what was.
function harness({ displayNames = {} } = {}) {
  const sessionId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const accessJti = crypto.randomUUID();
  const token = signAccessToken({
    sub: userId, sid: sessionId, jti: accessJti,
    email: "root@titopay.test", role: "super_admin", typ: "admin"
  });
  const settings = new Map();
  if (Object.keys(displayNames).length) settings.set(DISPLAY_NAME_KEY, { ...displayNames });
  const statements = [];
  const originalQuery = pool.query;

  pool.query = async (sql, params = []) => {
    const statement = String(sql).replace(/\s+/g, " ").trim();
    statements.push({ statement, params });

    if (statement.startsWith("SELECT s.* FROM sessions s")) {
      return {
        rows: [{
          id: sessionId, user_id: userId, user_type: "admin", access_jti: accessJti,
          revoked_at: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
          last_activity_at: new Date().toISOString()
        }],
        rowCount: 1
      };
    }
    if (statement.startsWith("SELECT * FROM admin_users")) {
      return {
        rows: [{
          id: userId, email: "root@titopay.test", role: "super_admin",
          status: "active", full_name: "Root Owner", locked_until: null
        }],
        rowCount: 1
      };
    }
    if (statement.startsWith("SELECT value FROM platform_settings")) {
      const key = params[0];
      return settings.has(key) ? { rows: [{ value: settings.get(key) }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (statement.startsWith("INSERT INTO platform_settings")) {
      settings.set(params[0], JSON.parse(params[1]));
      return { rows: [{ value: settings.get(params[0]), updated_at: new Date().toISOString() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  return {
    token,
    settings,
    statements,
    restore: () => { pool.query = originalQuery; }
  };
}

async function withServer(fixture, run) {
  const server = await listen();
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1/admin`, {
      Authorization: `Bearer ${fixture.token}`,
      "Content-Type": "application/json"
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("RENAMING A SLOT CHANGES THE LABEL EVERYWHERE THE LABEL IS READ", async () => {
  const fixture = harness();
  try {
    await withServer(fixture, async (base, headers) => {
      const renameResponse = await fetch(`${base}/integrations/docfox/name`, {
        method: "PUT", headers, body: JSON.stringify({ displayName: "Verity KYC" })
      });
      assert.equal(renameResponse.status, 200);
      const renamed = await renameResponse.json();
      assert.equal(renamed.label, "Verity KYC");
      assert.equal(renamed.previousLabel, "DocFox / FICA", "the audit trail needs the name it replaced");
      assert.equal(renamed.defaultLabel, "DocFox / FICA", "the catalogue's own name is still reportable");

      // The Integration Health table.
      const listed = await (await fetch(`${base}/integrations/config`, { headers })).json();
      const docfox = listed.providers.find((item) => item.key === "docfox");
      assert.equal(docfox.label, "Verity KYC");
      assert.equal(docfox.key, "docfox", "THE SLOT IS UNCHANGED - only its name moved");

      // The provider's own page.
      const single = await (await fetch(`${base}/integrations/config/docfox`, { headers })).json();
      assert.equal(single.provider.label, "Verity KYC");
      assert.equal(single.provider.displayName, "Verity KYC");

      // The routing list, which is a different code path from the config list.
      const routing = await (await fetch(`${base}/provider-routing`, { headers })).json();
      const option = routing.providers.find((item) => item.key === "docfox");
      assert.equal(option?.label, "Verity KYC", "the routing dropdown must not keep the old vendor's name");
    });
  } finally {
    fixture.restore();
  }
});

test("A RENAME NEVER TOUCHES THE PROVIDER'S CREDENTIAL RECORD", async () => {
  // The names live in their own settings row. If a rename ever wrote
  // integration_docfox, a mistake in that write would be a mistake in the row
  // holding that provider's encrypted secrets.
  const fixture = harness();
  try {
    await withServer(fixture, async (base, headers) => {
      await fetch(`${base}/integrations/flash/name`, {
        method: "PUT", headers, body: JSON.stringify({ displayName: "Blue Label VAS" })
      });
    });
    const writes = fixture.statements.filter((item) => item.statement.startsWith("INSERT INTO platform_settings"));
    assert.equal(writes.length, 1, "exactly one row is written");
    assert.equal(writes[0].params[0], DISPLAY_NAME_KEY);
    for (const { statement, params } of fixture.statements) {
      if (!statement.startsWith("INSERT INTO platform_settings")) continue;
      assert.ok(!String(params[0]).startsWith("integration_flash"),
        "the credential row must not be opened by a rename");
    }
    assert.deepEqual(fixture.settings.get(DISPLAY_NAME_KEY), { flash: "Blue Label VAS" });
  } finally {
    fixture.restore();
  }
});

test("A SLOT THAT DOES NOT EXIST CANNOT BE CREATED BY NAMING IT", async () => {
  const fixture = harness();
  try {
    await withServer(fixture, async (base, headers) => {
      const response = await fetch(`${base}/integrations/some_new_vendor/name`, {
        method: "PUT", headers, body: JSON.stringify({ displayName: "Some New Vendor" })
      });
      assert.equal(response.status, 400, "renaming is not a way to add a provider");
    });
    assert.equal(fixture.settings.has(DISPLAY_NAME_KEY), false, "nothing was written");
  } finally {
    fixture.restore();
  }
});

test("a name cannot carry markup or control characters", async () => {
  const fixture = harness();
  try {
    await withServer(fixture, async (base, headers) => {
      for (const attempt of ["<img src=x onerror=alert(1)>", "Vendor X", "LineBreak"]) {
        const response = await fetch(`${base}/integrations/ott/name`, {
          method: "PUT", headers, body: JSON.stringify({ displayName: attempt })
        });
        assert.equal(response.status, 400, `rejected: ${JSON.stringify(attempt)}`);
      }
      const tooShort = await fetch(`${base}/integrations/ott/name`, {
        method: "PUT", headers, body: JSON.stringify({ displayName: "X" })
      });
      assert.equal(tooShort.status, 400);
      const tooLong = await fetch(`${base}/integrations/ott/name`, {
        method: "PUT", headers, body: JSON.stringify({ displayName: "V".repeat(61) })
      });
      assert.equal(tooLong.status, 400);
    });
  } finally {
    fixture.restore();
  }
});

test("a blank name restores the catalogue's own label rather than emptying the row", async () => {
  const fixture = harness({ displayNames: { ott: "Kazang", flash: "Blue Label VAS" } });
  try {
    await withServer(fixture, async (base, headers) => {
      const response = await fetch(`${base}/integrations/ott/name`, {
        method: "PUT", headers, body: JSON.stringify({ displayName: "   " })
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.label, "OTT", "back to the catalogue name");
      assert.equal(result.displayName, "");

      const listed = await (await fetch(`${base}/integrations/config`, { headers })).json();
      assert.equal(listed.providers.find((item) => item.key === "ott").label, "OTT");
      assert.equal(listed.providers.find((item) => item.key === "flash").label, "Blue Label VAS",
        "resetting one provider must not clear another");
    });
  } finally {
    fixture.restore();
  }
});

test("every provider slot is renameable, and none of them lose their key", async () => {
  const fixture = harness();
  try {
    await withServer(fixture, async (base, headers) => {
      const listed = await (await fetch(`${base}/integrations/config`, { headers })).json();
      for (const provider of listed.providers) {
        const response = await fetch(`${base}/integrations/${provider.key}/name`, {
          method: "PUT", headers, body: JSON.stringify({ displayName: `Renamed ${provider.key}` })
        });
        assert.equal(response.status, 200, `${provider.key} must be renameable`);
        const result = await response.json();
        assert.equal(result.label, `Renamed ${provider.key}`);
        assert.equal(result.key, provider.key);
      }
      const after = await (await fetch(`${base}/integrations/config`, { headers })).json();
      assert.deepEqual(
        after.providers.map((item) => item.key).sort(),
        listed.providers.map((item) => item.key).sort(),
        "the set of slots is exactly what it was"
      );
    });
  } finally {
    fixture.restore();
  }
});

test.after(() => pool.end().catch(() => null));
