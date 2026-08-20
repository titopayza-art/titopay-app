"use strict";

// A DEPLOY MUST NEVER AGAIN LEARN ABOUT A NEW REQUIRED VARIABLE BY GOING DOWN.
//
// On 20 August 2026 the API returned 502 after a release. Nothing crashed:
// build 71 had made IDENTITY_PEPPER required, the new code correctly refused to
// start without it, and a process that refuses to start looks exactly like an
// outage from behind nginx. The guard was right. The gap was that the server had
// no way to discover the new requirement except by restarting into it.
//
// These tests close that gap permanently. Add a startup-blocking variable to
// src/config/env.js without declaring it in .env.example, without teaching
// preflight.js to check it, or without DEPLOY.md telling the operator to run the
// preflight before restarting, and the suite fails here.

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

// Every name env.js can THROW on, kept in its alternative GROUPS.
// requiredAny(["POSTGRES_URL", "DATABASE_URL"]) means either satisfies it, so
// the group is what must be declared, not every member of it.
function startupBlockingGroups() {
  const groups = [];
  for (const m of ENV_SOURCE.matchAll(/required(?:Any|Secret)\(\[([^\]]+)\]/g)) {
    const names = [...m[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((q) => q[1]);
    if (names.length) groups.push(names);
  }
  // identityPepperFromEnv reads IDENTITY_PEPPER and throws in production.
  if (/function identityPepperFromEnv/.test(ENV_SOURCE)) groups.push(["IDENTITY_PEPPER"]);
  return groups;
}

/* ------------------------------------------- the declaration cannot go stale */

test("every variable that can stop the API starting is declared in .env.example", () => {
  const undeclared = startupBlockingGroups()
    .filter((names) => !names.some((name) => new RegExp(`^${name}=`, "m").test(EXAMPLE)))
    .map((names) => names.join(" or "));
  assert.deepEqual(undeclared, [],
    `These can throw at startup but no member is declared in api/.env.example: ${undeclared.join("; ")}. ` +
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

test("every variable that can stop the API starting is checked by preflight.js", () => {
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
    IDENTITY_PEPPER: "a-long-enough-identity-pepper-for-the-floor"
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
  assert.match(output, /3 problems/,
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
    IDENTITY_PEPPER: secret
  };
  const output = execFileSync(process.execPath, ["preflight.js"], { cwd: API, env, encoding: "utf8" });
  assert.ok(!output.includes(secret),
    "a deployment log is not a place for key material; report presence and length only");
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
