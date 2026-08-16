"use strict";

// THE SCHEMA MUST BE ABLE TO REBUILD AN EMPTY DATABASE.
//
// src/db/init.js runs schema.sql as ONE statement, so a single forward
// reference does not merely fail that line: Postgres rolls the whole file back
// and leaves an empty database behind. Two ticketing tables referenced
// `transactions` two hundred lines before it was created, which meant the
// schema could no longer bootstrap from nothing.
//
// That is the kind of break nobody notices, because every existing environment
// already has the tables. It is discovered on the day a database has to be
// rebuilt, which is the worst day to discover it.
//
// This checks the ordering statically, so it fails in CI rather than during a
// recovery. The end-to-end proof is running init.js against a fresh database;
// this is the cheap guard that runs on every commit.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "src", "db", "schema.sql"), "utf8");

// Strip comments first: prose about a table is not a reference to it.
const CODE = SCHEMA.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

function createdAt(table) {
  const match = CODE.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  return match ? match.index : -1;
}

test("every inline foreign key points at a table created earlier in the file", () => {
  // REFERENCES inside a CREATE TABLE is resolved as the statement runs, so the
  // target has to exist by then. A constraint added by ALTER TABLE at the end
  // of the file is exempt, which is how the two ticketing keys are declared.
  const offenders = [];
  const createRe = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(/g;
  let create;
  while ((create = createRe.exec(CODE)) !== null) {
    const bodyStart = create.index + create[0].length;
    // The body ends at the first ");" that closes the CREATE TABLE.
    const bodyEnd = CODE.indexOf("\n);", bodyStart);
    const body = CODE.slice(bodyStart, bodyEnd === -1 ? bodyStart : bodyEnd);
    const refRe = /REFERENCES\s+(\w+)\s*\(/g;
    let ref;
    while ((ref = refRe.exec(body)) !== null) {
      const target = ref[1];
      if (target === create[1]) continue;              // self reference is fine
      const target_at = createdAt(target);
      if (target_at === -1) continue;                  // defined in another file
      if (target_at > create.index) {
        offenders.push(`${create[1]} references ${target}, which is created later`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `schema.sql cannot rebuild an empty database:\n  ${offenders.join("\n  ")}`);
});

test("the two deferred ticketing keys are still added, not simply dropped", () => {
  // Breaking the cycle by deleting the constraints would also make this file
  // load, and would silently lose referential integrity on the money path.
  for (const name of ["ticket_orders_transaction_id_fkey", "ticket_refunds_transaction_id_fkey"]) {
    assert.match(CODE, new RegExp(`ADD CONSTRAINT ${name}`), `${name} is added back`);
    assert.match(CODE, new RegExp(`conname = '${name}'`), `${name} is added only once`);
  }
  assert.match(CODE, /FOREIGN KEY \(transaction_id\) REFERENCES transactions\(id\) ON DELETE SET NULL/);
});

test("init.js applies the schema files it ships with", () => {
  const init = fs.readFileSync(path.join(__dirname, "..", "src", "db", "init.js"), "utf8");
  for (const file of ["schema.sql", "email-centre-schema.sql", "hr-schema.sql"]) {
    assert.ok(init.includes(file), `init.js applies ${file}`);
    assert.ok(fs.existsSync(path.join(__dirname, "..", "src", "db", file)), `${file} ships`);
  }
});

test("the console's failure note no longer names a build number", () => {
  // It read "Requires API build 15" for any endpoint that did not answer, which
  // sent an operator running a LATER build off to redeploy the API.
  const consoleJs = fs.readFileSync(path.join(__dirname, "..", "..", "admin", "admin.js"), "utf8");
  const code = consoleJs.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
  assert.doesNotMatch(code, /<strong>Requires API build \d+<\/strong>/,
    "the panel must not claim a build requirement it never checked");
  assert.match(code, /This panel could not load/);
  assert.match(code, /diagnose-admin-console/, "it points at the tool that reports the real reason");
});
