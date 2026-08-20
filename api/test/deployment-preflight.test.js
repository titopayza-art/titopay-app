"use strict";

// A CONFIGURATION PROBLEM MUST NEVER BE A 502.
//
// On 20 August 2026 the API returned 502 after a release. Nothing crashed:
// build 71 had made IDENTITY_PEPPER required, the new code refused to start
// without it, and a process that refuses to start is indistinguishable from an
// outage once nginx is in front. The complaint was correct and unreadable.
//
// Two rules now, and these tests hold both.
//
// ONE, nothing in src/config/env.js throws. Every fault becomes a warning that
// is printed at boot, counted on GET /health and listed by preflight.js, and the
// API serves. The tests below load the configuration in a child process with the
// environment stripped bare and assert it still resolves.
//
// TWO, the declaration cannot go stale. Add a variable the API needs without
// putting it in .env.example, without teaching preflight.js to check it, or move
// the preflight after the restart in DEPLOY.md, and the suite fails by name.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const API = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(API, ...p), "utf8");

const ENV_SOURCE = read("src", "config", "env.js");
const EXAMPLE = read(".env.example");
const PREFLIGHT = read("preflight.js");
const DEPLOY = fs.readFileSync(path.join(API, "..", "DEPLOY.md"), "utf8");

// Every name env.js WARNS about, kept in its alternative GROUPS.
// requiredAnyOrWarn(["POSTGRES_URL", "DATABASE_URL"]) means either satisfies it,
// so the group is what must be declared, not every member of it.
function startupBlockingGroups() {
  const groups = [];
  for (const m of ENV_SOURCE.matchAll(/required(?:AnyOrWarn|Secret)\(\[([^\]]+)\]/g)) {
    const names = [...m[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((q) => q[1]);
    if (names.length) groups.push(names);
  }
  // identityPepperFromEnv reads IDENTITY_PEPPER and warns in production.
  if (/function identityPepperFromEnv/.test(ENV_SOURCE)) groups.push(["IDENTITY_PEPPER"]);
  return groups;
}

/* ------------------------------------------- the declaration cannot go stale */

test("every variable the API needs is declared in .env.example", () => {
  const undeclared = startupBlockingGroups()
    .filter((names) => !names.some((name) => new RegExp(`^${name}=`, "m").test(EXAMPLE)))
    .map((names) => names.join(" or "));
  assert.deepEqual(undeclared, [],
    `The API needs these but no member is declared in api/.env.example: ${undeclared.join("; ")}. ` +
    "An operator has no way to know they are needed, which is exactly how the 20 August 502 happened.");
});

test("the accepted alternative names are at least mentioned, so neither spelling strands an operator", () => {
  // DATABASE_URL works as well as POSTGRES_URL. Somebody who set the other name
  // must not read this file and conclude their configuration is wrong.
  const unmentioned = startupBlockingGroups()
    .flat()
    .filter((name) => !EXAMPLE.includes(name));
  assert.deepEqual(unmentioned, [],
    `Not mentioned anywhere in .env.example: ${unmentioned.join(", ")}.`);
});

test("every variable the API needs is checked by preflight.js", () => {
  const missing = startupBlockingGroups().flat().filter((name) => !PREFLIGHT.includes(`"${name}"`));
  assert.deepEqual(missing, [],
    `preflight.js does not check: ${missing.join(", ")}. It must report every problem before a restart, not the first one.`);
});

test(".env.example carries names only, never values", () => {
  const leaked = EXAMPLE.split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .filter((line) => line.split("=").slice(1).join("=").trim() !== "");
  assert.deepEqual(leaked, [],
    "A template of NAMES is how somebody knows what to set. A value here is a committed secret.");
});

/* ------------------------------------------------ the operator is told to run it */

test("DEPLOY.md runs the preflight before the restart, not after", () => {
  assert.match(DEPLOY, /node preflight\.js/,
    "DEPLOY.md must tell the operator to run the preflight; a check nobody is told to run prevents nothing.");
  const preflightAt = DEPLOY.indexOf("node preflight.js");
  const restartAt = DEPLOY.search(/^### Restart the API/m);
  assert.ok(restartAt > 0, "DEPLOY.md still has a restart section");
  assert.ok(preflightAt < restartAt,
    "The preflight must come BEFORE the restart. Run after, and the API is already down, which is the whole failure.");
});

test("DEPLOY.md says the running API survives a failed preflight", () => {
  const window = DEPLOY.slice(DEPLOY.indexOf("node preflight.js"));
  assert.match(window.slice(0, 1200), /DO NOT RESTART|do not restart/,
    "The operator must be told that stopping here costs nothing, so that stopping is the easy choice.");
});

/* ============================================================================
   THE GUARANTEE: A CONFIGURATION PROBLEM IS NEVER AN OUTAGE
   ==========================================================================*/

test("src/config/env.js contains no throw at all", () => {
  assert.equal((ENV_SOURCE.match(/throw new Error/g) || []).length, 0,
    "A throw while loading configuration kills the process before it can listen, " +
    "and nginx turns that into a 502 nobody can read. Warn instead.");
});

// The real proof: load the config in a child process with the environment
// stripped to nothing and confirm it still resolves. Each case is one that
// previously took the API down or would have.
const STRIPPED = [
  ["nothing set at all", {}],
  ["no IDENTITY_PEPPER in production", {
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://u@127.0.0.1:5432/d",
    JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor",
    JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor"
  }],
  ["secrets far too short", {
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://u@127.0.0.1:5432/d",
    JWT_ACCESS_SECRET: "x",
    JWT_REFRESH_SECRET: "y",
    IDENTITY_PEPPER: "z"
  }],
  ["no database string", {
    NODE_ENV: "production",
    JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor",
    JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor",
    IDENTITY_PEPPER: "a-long-enough-identity-pepper-for-the-floor"
  }],
  ["a non-numeric port and TTL", {
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://u@127.0.0.1:5432/d",
    JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor",
    JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor",
    IDENTITY_PEPPER: "a-long-enough-identity-pepper-for-the-floor",
    API_PORT: "not-a-number",
    OTP_TTL_SECONDS: "banana"
  }]
];

for (const [label, environment] of STRIPPED) {
  test(`configuration still loads with ${label}`, () => {
    // PATH and the Node binary only. dotenv would otherwise read a real .env
    // and quietly repair the very hole under test, so point it at an empty dir.
    const bare = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent/.env", ...environment };
    const script =
      'const { config, startupWarnings } = require(process.argv[1]);' +
      'if (!config) { console.error("NO CONFIG"); process.exit(3); }' +
      'console.log("LOADED warnings=" + startupWarnings.length);';
    const out = execFileSync(process.execPath, ["-e", script, path.join(API, "src", "config", "env.js")],
      { cwd: "/tmp", env: bare, encoding: "utf8" });
    assert.match(out, /^LOADED warnings=\d+/,
      `Loading configuration with ${label} must produce a config object and warnings, never an exception.`);
  });
}

test("a missing signing key is replaced, never left empty", () => {
  const bare = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent/.env", NODE_ENV: "production" };
  const script =
    'const { config } = require(process.argv[1]);' +
    'console.log(JSON.stringify({ a: config.accessSecret.length, r: config.refreshSecret.length,' +
    ' same: config.accessSecret === config.refreshSecret }));';
  const out = execFileSync(process.execPath, ["-e", script, path.join(API, "src", "config", "env.js")],
    { cwd: "/tmp", env: bare, encoding: "utf8" });
  const { a, r, same } = JSON.parse(out);
  assert.ok(a >= 32, "an absent access secret must become a strong random one, not an empty string");
  assert.ok(r >= 32, "same for the refresh secret");
  assert.equal(same, false, "and the two must not be the same key");
});

test("the identity pepper still comes from a secret outside the database when unset", () => {
  // The fallback is what stops a missing pepper being a 502. It must not become
  // a constant, which is the vulnerability the whole remediation was about.
  const run = (accessSecret) => {
    const bare = {
      PATH: process.env.PATH, DOTENV_CONFIG_PATH: "/nonexistent/.env",
      NODE_ENV: "production", JWT_ACCESS_SECRET: accessSecret,
      JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor",
      POSTGRES_URL: "postgres://u@127.0.0.1:5432/d"
    };
    return execFileSync(process.execPath,
      ["-e", 'console.log(require(process.argv[1]).config.identityPepper);', path.join(API, "src", "config", "env.js")],
      { cwd: "/tmp", env: bare, encoding: "utf8" }).trim();
  };
  const one = run("first-access-secret-long-enough-for-floor");
  const two = run("second-access-secret-long-enough-for-floor");
  assert.notEqual(one, two,
    "a derived pepper must follow the access secret; a constant is exactly the bug the August audit found");
  assert.equal(one, run("first-access-secret-long-enough-for-floor"),
    "and it must be stable for the same secret, or stored hashes stop matching between restarts");
  assert.ok(one.length >= 64, "the derived pepper is a SHA-256 digest in hex");
});

test("the health endpoint reports the configuration warning count", () => {
  const health = fs.readFileSync(path.join(API, "src", "routes", "health.routes.js"), "utf8");
  assert.match(health, /configWarnings/,
    "an API that starts despite a problem must say so somewhere a human will look");
  assert.match(health, /startupWarnings\.length/,
    "report the count, never the warnings themselves: a public health response must not hint at which key is weak");
});

test("the server prints the warnings at boot", () => {
  const server = fs.readFileSync(path.join(API, "src", "server.js"), "utf8");
  assert.match(server, /startupWarnings/);
  assert.match(server, /The API is starting anyway/,
    "the operator reading the log must be told plainly that it came up regardless");
});

/* ------------------------------------------------------- it actually works */

test("the preflight fails, and names the variable, when a required one is missing", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://user@127.0.0.1:5432/db",
    JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor",
    JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor"
  };
  delete env.IDENTITY_PEPPER;
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, ["preflight.js"], { cwd: API, env, encoding: "utf8" });
  } catch (error) {
    status = error.status;
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.equal(status, 1, "a missing required variable must exit non-zero so a deploy script stops");
  assert.match(output, /IDENTITY_PEPPER is not set/, "it must name the variable, not just fail");
  assert.match(output, /DO NOT RESTART YET/, "and it must say the running API is still safe");
});

test("the preflight passes on a configuration that will start", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://user@127.0.0.1:5432/db",
    JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor",
    JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor",
    IDENTITY_PEPPER: "a-long-enough-identity-pepper-for-the-floor",
    EMAIL_ENCRYPTION_KEY: "an-email-encryption-key-pinned-once-forever"
  };
  const output = execFileSync(process.execPath, ["preflight.js"], { cwd: API, env, encoding: "utf8" });
  assert.match(output, /Safe to restart/);
});

test("the preflight catches a secret that is present but too short", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://user@127.0.0.1:5432/db",
    JWT_ACCESS_SECRET: "tooshort",
    JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor",
    IDENTITY_PEPPER: "a-long-enough-identity-pepper-for-the-floor"
  };
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, ["preflight.js"], { cwd: API, env, encoding: "utf8" });
  } catch (error) {
    status = error.status;
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.equal(status, 1);
  assert.match(output, /JWT_ACCESS_SECRET is 8 bytes; the minimum is 32/);
  assert.match(output, /signs everyone out/,
    "the operator must be warned about the side effect before they change it, not after");
});

test("the preflight reports every problem at once, not just the first", () => {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://user@127.0.0.1:5432/db",
    JWT_ACCESS_SECRET: "tooshort"
  };
  delete env.JWT_REFRESH_SECRET;
  delete env.REFRESH_TOKEN_SECRET;
  delete env.IDENTITY_PEPPER;
  let output = "";
  try {
    output = execFileSync(process.execPath, ["preflight.js"], { cwd: API, env, encoding: "utf8" });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.match(output, /3 configuration problems/,
    "fixing one variable, restarting, and finding the next is three outages instead of none");
});

test("the preflight never prints a secret's value", () => {
  const secret = "ThisExactStringMustNeverBeEchoedBackToTheOperator1234";
  const env = {
    ...process.env,
    NODE_ENV: "production",
    POSTGRES_URL: "postgres://user@127.0.0.1:5432/db",
    JWT_ACCESS_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    IDENTITY_PEPPER: secret,
    EMAIL_ENCRYPTION_KEY: secret
  };
  const output = execFileSync(process.execPath, ["preflight.js"], { cwd: API, env, encoding: "utf8" });
  assert.ok(!output.includes(secret),
    "a deployment log is not a place for key material; report presence and length only");
});

/* ============================================================================
   THE KEY THAT ROTATING A JWT SECRET SILENTLY DESTROYED
   ==========================================================================*/

// 20 August 2026, an hour after the 502 was fixed: a routine JWT rotation,
// advised as "nothing is lost", broke every stored email credential - they
// are encrypted under a key derived from JWT_REFRESH_SECRET whenever
// EMAIL_ENCRYPTION_KEY is absent. Every send failed with `Missing credentials
// for "PLAIN"` and the admin OTP email never arrived, locking the operator
// out. The preflight must name this coupling BEFORE a rotation, and the
// remedy must pin the key without changing what anything decrypts to.

test("the preflight warns that rotating the refresh secret breaks email when the key is unset", () => {
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "preflight.js")], {
      cwd: bareDir(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        POSTGRES_URL: "postgres://user@127.0.0.1:5432/db",
        JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor",
        JWT_REFRESH_SECRET: "a-long-enough-refresh-secret-for-the-floor",
        IDENTITY_PEPPER: "a-long-enough-identity-pepper-for-the-floor"
      },
      encoding: "utf8"
    });
  } catch (error) {
    status = error.status;
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.equal(status, 1, "a live landmine is a problem to fix, not a footnote");
  assert.match(output, /EMAIL_ENCRYPTION_KEY is not set/);
  assert.match(output, /Rotating that secret will silently break every stored email/);
  assert.match(output, /Missing credentials for "PLAIN"/, "naming the exact error the operator would otherwise meet cold");
  assert.match(output, /EMAIL_ENCRYPTION_KEY=\$\(grep '\^JWT_REFRESH_SECRET=' \.env/,
    "the remedy pins the key to the value credentials are ALREADY encrypted under - zero-risk, nothing re-encrypts");
});

test("the second vault obeys the same pinned key, and its failures are never silent", () => {
  // The 20 August incident had a second act: fixing EMAIL_ENCRYPTION_KEY
  // reopened only the Email Centre's own store, while the SMTP password
  // actually lives in the admin Integrations store - encrypted under a key
  // derived DIRECTLY from the refresh secret, with no override, and with
  // decrypt failures swallowed by a bare catch-continue. Email stayed dead
  // and nothing said why. Both halves are pinned here.
  const notify = read("src", "services", "notification-service.js");
  const fn = notify.slice(notify.indexOf("function integrationEncryptionKey"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /INTEGRATION_ENCRYPTION_KEY/, "an explicit override wins");
  assert.match(body, /EMAIL_ENCRYPTION_KEY/,
    "the key operators are told to pin must govern this vault too");
  assert.ok(body.indexOf("EMAIL_ENCRYPTION_KEY") < body.indexOf("config.refreshSecret"),
    "and it must be consulted BEFORE the rotatable JWT fallback, or pinning changes nothing");
  assert.match(notify, /stored integration secret would not decrypt/,
    "an undecryptable stored secret must be said out loud, not swallowed into a bare fallback");
  assert.doesNotMatch(notify, /catch \(_error\) \{\s*continue;/,
    "the silent catch-continue that hid the real cause may not return");
});

test("the rotation advice itself now carries the email warning, not 'nothing is lost'", () => {
  assert.doesNotMatch(PREFLIGHT, /Nothing is lost/,
    "that exact phrase was disproven in production; it may not return");
  assert.match(PREFLIGHT, /EMAIL_ENCRYPTION_KEY to the CURRENT refresh secret value FIRST/,
    "the short-secret remedy must order the steps: pin the key, then rotate");
  assert.match(EXAMPLE, /^EMAIL_ENCRYPTION_KEY=$/m, "and .env.example declares the key");
  assert.match(EXAMPLE, /ROTATING THAT SECRET SILENTLY BREAKS EVERY STORED EMAIL/,
    ".env.example says why in the words of what actually happened");
});

/* ============================================================================
   A BARE SHELL IS NOT THE PROCESS MANAGER
   ==========================================================================*/

// The second act of 20 August: minutes after the 502 was fixed, the preflight
// run over SSH reported every variable missing on the machine where the API
// was serving fine, and `npm run db:apply-migrations` failed with `password
// authentication failed for user "root"`. Both tools were reading a login
// shell that does not inherit the process manager's environment, and neither
// said so. These tests hold the explanations that were missing.

const os = require("os");

// A directory guaranteed to hold no .env, so the "shell sees nothing" branch
// is reachable no matter what the sandbox working copy contains.
function bareDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "titopay-bare-"));
}

test("a shell with no configuration at all is told where the configuration probably lives", () => {
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "preflight.js")],
      { cwd: bareDir(), env: { PATH: process.env.PATH }, encoding: "utf8" });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.match(output, /THIS SHELL SEES NO TITOPAY CONFIGURATION AT ALL/,
    "three ✗ marks with no explanation read as an outage on a healthy server");
  assert.match(output, /process manager/, "it must name the real cause: cPanel, pm2 and systemd inject variables a login shell never sees");
  assert.match(output, /curl -s https:\/\/api\.titopay\.co\.za\/v1\/health/,
    "and point at the one command that reports the RUNNING process's configuration");
  assert.match(output, /configWarnings/, "naming the field to read");
  assert.match(output, /create a \.env here/, "and how to make shell scripts see what the API sees");
});

test("a shell holding ANY TitoPay variable is not told it sees nothing at all", () => {
  // The adversarial review's catch: judging "nothing" against only the seven
  // core names called a shell holding NODE_ENV=production and the SMTP block
  // one that "SEES NO TITOPAY CONFIGURATION AT ALL", which is false — that
  // operator's missing core variables are real problems, not somebody else's
  // environment. "Nothing" is now judged against every name .env.example
  // declares.
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "preflight.js")], {
      cwd: bareDir(),
      env: { PATH: process.env.PATH, SMTP_HOST: "mail.titopay.co.za", EMAIL_PROVIDER: "smtp" },
      encoding: "utf8"
    });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.doesNotMatch(output, /THIS SHELL SEES NO TITOPAY CONFIGURATION/,
    "SMTP_HOST is TitoPay configuration; this shell is partly configured, not bare");
  assert.match(output, /POSTGRES_URL or DATABASE_URL is not set/, "and its real problems still print");
});

test("the health-endpoint pointer says whose configuration it reports, and what a failed request means", () => {
  // Two more review catches. configWarnings comes from the process that is
  // STILL RUNNING — the old build until the restart — so a variable the new
  // build adds cannot show there yet; saying "zero means complete" without
  // that caveat steers the operator wrong in exactly the build-71 scenario
  // this tool exists for. And when the running API's database is broken, the
  // health request itself fails, so the absence of the field is itself the
  // signal.
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "preflight.js")],
      { cwd: bareDir(), env: { PATH: process.env.PATH }, encoding: "utf8" });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.match(output, /the OLD build until you restart/);
  assert.match(output, /if\nthat request itself fails|that request itself fails/,
    "a failed health request must be explained as the running API's own report");
});

test("apply-migrations honours libpq's PG* variables instead of refusing them", () => {
  // A shell configured the libpq way — PGHOST/PGDATABASE/PGUSER, no
  // POSTGRES_URL — worked before the guard existed, because pg reads those
  // when no connection string is given. The refusal must not break it.
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "scripts", "apply-migrations.js")], {
      cwd: bareDir(),
      env: { PATH: process.env.PATH, PGHOST: "127.0.0.1", PGPORT: "55432", PGUSER: "postgres", PGDATABASE: "titopay" },
      encoding: "utf8",
      timeout: 60000
    });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.doesNotMatch(output, /POSTGRES_URL is not set in this shell/,
    "PG* variables ARE database configuration; the script must attempt the connection, not refuse");
});

test("the refusal names DATABASE_URL as the equal alternative it is", () => {
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "scripts", "apply-migrations.js")],
      { cwd: bareDir(), env: { PATH: process.env.PATH }, encoding: "utf8" });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.match(output, /DATABASE_URL works too/,
    "env.js accepts either name; naming only one tells a DATABASE_URL user their configuration is wrong");
});

test("the bare-shell explanation does not appear when configuration is merely incomplete", () => {
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "preflight.js")], {
      cwd: bareDir(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        POSTGRES_URL: "postgres://u@127.0.0.1:5432/d",
        JWT_ACCESS_SECRET: "a-long-enough-access-secret-for-the-floor"
      },
      encoding: "utf8"
    });
  } catch (error) {
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.doesNotMatch(output, /THIS SHELL SEES NO TITOPAY CONFIGURATION/,
    "a partly configured shell has real problems to fix; do not wave them off as somebody else's environment");
  assert.match(output, /JWT_REFRESH_SECRET or REFRESH_TOKEN_SECRET is not set/);
});

test("apply-migrations with no database URL says so, instead of failing as the OS user", () => {
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [path.join(API, "scripts", "apply-migrations.js")],
      { cwd: bareDir(), env: { PATH: process.env.PATH }, encoding: "utf8" });
  } catch (error) {
    status = error.status;
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.equal(status, 1, "no database URL means nothing to migrate; exit non-zero so a deploy script stops");
  assert.match(output, /POSTGRES_URL is not set in this shell/,
    "the missing variable must be named in those words");
  assert.match(output, /password\s+authentication failed/,
    "and the confusing pg fallback error must be explained before anyone sees it for real");
  assert.match(output, /process manager/, "with the same shell-versus-service explanation as the preflight");
  assert.match(output, /POSTGRES_URL="<connection string>" npm run db:apply-migrations/,
    "and the exact command that works");
});

/* -------------------------------------------------------- it actually ships */

test("preflight.js and .env.example are inside the API package", () => {
  assert.ok(fs.existsSync(path.join(API, "preflight.js")),
    "the check has to be on the server to be run on the server");
  assert.ok(fs.existsSync(path.join(API, ".env.example")),
    "the declaration has to ship with the code it describes");
  const ignore = fs.readFileSync(path.join(API, "..", ".gitignore"), "utf8");
  assert.match(ignore, /!\.env\.example/,
    ".gitignore excludes .env.* and must keep exempting the template, or this file silently disappears");
});
