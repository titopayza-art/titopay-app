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

test("repairing a schema never rewrites the fees an operator set", () => {
  // `node src/db/init.js` applies the schema AND calls
  // syncApprovedPricingSchedule, which writes the shipped schedule over
  // pricing_rules with ON CONFLICT DO UPDATE and forces enabled = TRUE. That
  // is correct for a new database and destructive on a live one, and the
  // diagnosis used to send operators straight at it.
  const repair = fs.readFileSync(path.join(__dirname, "..", "scripts", "repair-schema.js"), "utf8");
  // The header explains at length why pricing is NOT synced here, so the scan
  // has to read the code rather than the reasoning that protects it.
  const repairCode = repair.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(repairCode, /syncApprovedPricingSchedule|pricing-service/,
    "the repair must not touch pricing");
  assert.match(repair, /schema\.sql/);
  assert.match(repair, /email-centre-schema\.sql/);
  assert.match(repair, /hr-schema\.sql/);
  assert.match(repair, /the operator's change is gone/,
    "the reason this exists separately from init.js is recorded where it will be read");

  const init = fs.readFileSync(path.join(__dirname, "..", "src", "db", "init.js"), "utf8");
  assert.match(init, /syncApprovedPricingSchedule/,
    "init.js is still the new-database path, and still seeds pricing");

  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.scripts["db:repair-schema"], "node scripts/repair-schema.js");

  // The guidance an operator is handed at 2am must name the safe command.
  const diagnosis = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "console-diagnosis-service.js"), "utf8");
  const guidance = diagnosis.slice(diagnosis.indexOf("guidance: ok"), diagnosis.indexOf("guidance: ok") + 900);
  assert.match(guidance, /scripts\/repair-schema\.js/);
  assert.doesNotMatch(guidance.replace(/\/\/[^\n]*/g, ""), /src\/db\/init\.js/,
    "the guidance must not send a live database at the pricing-rewriting command");
});

test("the diagnosis counts one table's foreign keys, not every schema's", () => {
  // pg_class.relname is not schema-qualified. Without the namespace join this
  // summed every platform_settings in the database: a production node with
  // archived schemas alongside public reported 35 where the answer was 1, and
  // a number like that reads as a fault when nothing is wrong.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "console-diagnosis-service.js"), "utf8");
  const query = source.slice(source.indexOf("platformSettingsForeignKeys"),
    source.indexOf("platformSettingsColumns"));
  assert.match(query, /JOIN pg_namespace/, "the count is scoped to a schema");
  assert.match(query, /ns\.nspname = 'public'/, "and to the one the API actually writes to");
});

test("the health version field is left exactly as it is", () => {
  // appVersion was changed to carry the build number because the field was
  // asked about. A question is not a request, and /health is a live response
  // shape that things outside this repository may read. Restored, and pinned
  // so it is not "improved" again without someone deciding to.
  const { buildInfo, API_BUILD } = require("../src/build-info");
  const info = buildInfo();
  assert.equal(info.appVersion, "1.0", "the response shape is not ours to change unasked");
  assert.equal(info.build, API_BUILD, "the build is the field that moves");
});

test("the schema uses trigger syntax every PostgreSQL version accepts", () => {
  // CREATE TRIGGER ... EXECUTE FUNCTION requires PostgreSQL 11. On anything
  // older it is a SYNTAX error, and because schema.sql runs as one statement a
  // syntax error rolls the entire file back: not one table is created.
  //
  // That is exactly what happened on a production node. Every table declared
  // before line 1762 existed and every table declared after it was missing,
  // for months, because the file had silently stopped applying the day this
  // syntax was introduced. The failure is invisible until someone runs the
  // schema by hand, which is the day a table is needed.
  //
  // EXECUTE PROCEDURE is the older spelling, is semantically identical for
  // triggers, and is still accepted by every PostgreSQL release to date. The
  // schema already carries a gen_random_uuid() shim for old servers, so
  // supporting them is a deliberate property of this file, not an accident.
  assert.doesNotMatch(SCHEMA, /EXECUTE FUNCTION/,
    "EXECUTE FUNCTION needs PostgreSQL 11 and silently voids the whole schema on older servers");
  assert.match(SCHEMA, /FOR EACH ROW EXECUTE PROCEDURE titopay_record_tx_status\(\)/,
    "the status-history triggers are still attached");
  assert.equal((SCHEMA.match(/EXECUTE PROCEDURE titopay_record_tx_status/g) || []).length, 2,
    "both the insert and the update trigger");

  for (const file of ["email-centre-schema.sql", "hr-schema.sql"]) {
    const sql = fs.readFileSync(path.join(__dirname, "..", "src", "db", file), "utf8");
    assert.doesNotMatch(sql, /EXECUTE FUNCTION/, `${file} must not reintroduce it either`);
  }
});
