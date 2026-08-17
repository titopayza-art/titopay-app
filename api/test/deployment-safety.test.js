"use strict";

// A SANDBOX BALANCE MUST NEVER BECOME A CLAIM ON REAL MONEY.
//
// Sandbox on TitoPay is not a separate database: it is one environment
// variable per integration, and no financial table records which mode created
// a row. All three variables used to read `process.env.X || "production"`, so
// an unset variable, a typo, or a stripped environment file put the platform
// LIVE in silence, and nothing checked that a production API had opened the
// production database.
//
// Every one of those cases is asserted here. The module is pure and takes its
// environment as an argument, so none of this touches process.env and no test
// can leak into the next one.

const test = require("node:test");
const assert = require("node:assert/strict");
const safety = require("../src/config/deployment-safety");

const PRODUCTION = {
  TITOPAY_ENV: "production",
  PEACH_PAYMENTS_MODE: "production",
  DOCFOX_MODE: "production",
  OTT_MODE: "production",
  POSTGRES_URL: "postgres://user:secret@db.internal:5432/titopay_production"
};
const SANDBOX = {
  TITOPAY_ENV: "sandbox",
  PEACH_PAYMENTS_MODE: "sandbox",
  DOCFOX_MODE: "sandbox",
  OTT_MODE: "sandbox",
  POSTGRES_URL: "postgres://user:secret@db.internal:5432/titopay_sandbox"
};
const withEnv = (base, patch) => safety.inspectDeployment({ env: { ...base, ...patch } });

/* ------------------------------------------------- the modes, one at a time */

test("a fully declared production deployment is accepted", () => {
  const result = safety.inspectDeployment({ env: PRODUCTION });
  assert.equal(result.ok, true, result.problems.join("; "));
  assert.equal(result.environment, "production");
});

test("a fully declared sandbox deployment is accepted", () => {
  const result = safety.inspectDeployment({ env: SANDBOX });
  assert.equal(result.ok, true, result.problems.join("; "));
  assert.equal(result.environment, "sandbox");
});

for (const name of ["PEACH_PAYMENTS_MODE", "DOCFOX_MODE", "OTT_MODE", "TITOPAY_ENV"]) {
  test(`a missing ${name} refuses to start, and does NOT default to production`, () => {
    const env = { ...PRODUCTION };
    delete env[name];
    const result = safety.inspectDeployment({ env });
    assert.equal(result.ok, false, `${name} was allowed to be missing`);
    assert.ok(result.problems.some((problem) => problem.includes(name)),
      `nothing in the refusal mentions ${name}: ${result.problems.join("; ")}`);
    // The specific regression: silence must never be read as production.
    assert.notEqual(result.modes[name], "production");
  });

  test(`an empty ${name} refuses to start`, () => {
    const result = withEnv(PRODUCTION, { [name]: "   " });
    assert.equal(result.ok, false, `${name}="   " was accepted`);
  });

  for (const bad of ["prod", "PRODUCTION", "Production ", "live", "sandbox2", "true", "1"]) {
    test(`${name}="${bad}" refuses to start rather than being interpreted`, () => {
      const result = withEnv(PRODUCTION, { [name]: bad });
      assert.equal(result.ok, false, `${name}="${bad}" was accepted`);
    });
  }
}

test("an integration in a different environment from the deployment is refused", () => {
  // A production API talking to a sandbox acquirer would take real card
  // details to a test gateway. The reverse would take real money.
  const mixed = withEnv(PRODUCTION, { PEACH_PAYMENTS_MODE: "sandbox" });
  assert.equal(mixed.ok, false, "production deployment accepted a sandbox acquirer");
  assert.ok(mixed.problems.some((problem) => /PEACH_PAYMENTS_MODE/.test(problem)));

  const other = withEnv(SANDBOX, { OTT_MODE: "production" });
  assert.equal(other.ok, false, "sandbox deployment accepted a production OTT");
});

test("NODE_ENV may not contradict TITOPAY_ENV", () => {
  const clash = withEnv(PRODUCTION, { NODE_ENV: "sandbox" });
  assert.equal(clash.ok, false, "a contradicting NODE_ENV was accepted");
  // But its ordinary values are none of this module's business.
  assert.equal(withEnv(PRODUCTION, { NODE_ENV: "production" }).ok, true);
  assert.equal(withEnv(SANDBOX, { NODE_ENV: "development" }).ok, true);
});

/* --------------------------------------------- environment vs database name */

test("production refuses a sandbox-looking database, and sandbox refuses production", () => {
  const productionOnSandboxDb = withEnv(PRODUCTION, {
    POSTGRES_URL: "postgres://user:secret@db.internal:5432/titopay_sandbox"
  });
  assert.equal(productionOnSandboxDb.ok, false, "a production API opened the sandbox database");

  const sandboxOnProductionDb = withEnv(SANDBOX, {
    POSTGRES_URL: "postgres://user:secret@db.internal:5432/titopay_production"
  });
  assert.equal(sandboxOnProductionDb.ok, false, "a sandbox API opened the production database");
});

test("the matching combinations are accepted", () => {
  assert.equal(withEnv(PRODUCTION, { POSTGRES_URL: "postgres://u:p@h:5432/titopay_production" }).ok, true);
  assert.equal(withEnv(SANDBOX, { POSTGRES_URL: "postgres://u:p@h:5432/titopay_sandbox" }).ok, true);
});

test("a database name that says nothing either way is not rejected on the name alone", () => {
  // The name is a convention. It is used only to REFUSE; approval comes from
  // the marker the database itself carries.
  assert.equal(withEnv(PRODUCTION, { POSTGRES_URL: "postgres://u:p@h:5432/titopay" }).ok, true);
  assert.equal(withEnv(SANDBOX, { POSTGRES_URL: "postgres://u:p@h:5432/titopay" }).ok, true);
});

test("a database name that cannot be read at all is refused rather than assumed", () => {
  assert.equal(withEnv(PRODUCTION, { POSTGRES_URL: "" }).ok, false);
});

test("the connection string never reaches a message", () => {
  // Every refusal is printed at startup. A password in one would be in the
  // logs of every server that ever mis-started.
  const leak = withEnv(PRODUCTION, {
    POSTGRES_URL: "postgres://titopay:hunter2SuperSecret@db.internal:5432/titopay_sandbox"
  });
  assert.equal(leak.ok, false);
  const printed = [...leak.problems, ...safety.describeDeployment(leak)].join("\n");
  assert.doesNotMatch(printed, /hunter2SuperSecret/, "the database password appeared in a startup message");
  assert.doesNotMatch(printed, /postgres:\/\//, "the connection string appeared in a startup message");
});

test("the database target is read without exposing the credentials in it", () => {
  const target = safety.describeDatabaseTarget("postgres://titopay:hunter2@db.internal:5432/titopay_production");
  assert.equal(target.name, "titopay_production");
  assert.equal(Object.values(target).join(" ").includes("hunter2"), false);
  // libpq keyword strings are understood too, not silently treated as unknown.
  assert.equal(safety.describeDatabaseTarget("host=db.internal dbname=titopay_sandbox user=x").name, "titopay_sandbox");
});

/* ------------------------------------------------------------- credentials */

test("production mode with no production credentials is refused", () => {
  const result = safety.inspectDeployment({
    env: PRODUCTION,
    config: { integrations: { peachPayments: { v2Enabled: true, apiKey: "", merchantId: "", productionBaseUrl: "https://app.next.peachpayments.com/api" } } }
  });
  assert.equal(result.ok, false, "production ran with no Peach credentials");
  assert.ok(result.problems.some((problem) => /PEACH_PAYMENTS/.test(problem)));
});

test("production credentials present are accepted", () => {
  const result = safety.inspectDeployment({
    env: PRODUCTION,
    config: { integrations: { peachPayments: { v2Enabled: true, apiKey: "k", merchantId: "m", productionBaseUrl: "https://app.next.peachpayments.com/api" } } }
  });
  assert.equal(result.ok, true, result.problems.join("; "));
});

test("production mode pointed at a sandbox host is refused", () => {
  const result = safety.inspectDeployment({
    env: PRODUCTION,
    config: { integrations: { peachPayments: { v2Enabled: true, apiKey: "k", merchantId: "m", productionBaseUrl: "https://app.sandbox-next.peachpayments.com/api" } } }
  });
  assert.equal(result.ok, false, "production accepted a sandbox acquirer URL");
});

test("sandbox with no Peach credentials is fine, because the fake provider is used", () => {
  const result = safety.inspectDeployment({
    env: SANDBOX,
    config: { integrations: { peachPayments: { v2Enabled: false, apiKey: "", merchantId: "", sandboxBaseUrl: "http://127.0.0.1:4400" } } }
  });
  assert.equal(result.ok, true, result.problems.join("; "));
});

/* -------------------------------------------------- what an operator is told */

test("the startup description names the modes and the database, and nothing else", () => {
  const lines = safety.describeDeployment(safety.inspectDeployment({ env: PRODUCTION }));
  const printed = lines.join("\n");
  assert.match(printed, /Environment: *production/);
  assert.match(printed, /Peach Payments: *production/);
  assert.match(printed, /DocFox: *production/);
  assert.match(printed, /OTT: *production/);
  assert.match(printed, /Database target: *titopay_production/);
  assert.doesNotMatch(printed, /secret|password|apiKey|@db\.internal/i);
});
