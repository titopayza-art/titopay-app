"use strict";

// BOOK'S SCHEMA EXISTS IN THREE PLACES. THIS PROVES THEY AGREE.
//
//   1. src/db/migrations/20260819_book_foundation.up.sql  - existing databases
//   2. the block at the end of src/db/schema.sql           - brand new databases
//   3. src/services/book-schema.js                         - never-migrated ones
//
// All three are necessary, because db:init-production reads the .sql files and
// NEVER reads migrations, while an existing deployment applies migrations and
// never re-reads schema.sql. A table that lives in only one of them is missing
// entirely for one whole population of deployments.
//
// The cost of three copies is drift, and drift here is invisible: CREATE TABLE
// IF NOT EXISTS is a no-op against a table that already exists, so whichever
// copy ran first defines the table forever and a column added to only one of
// them is silently absent on some deployments and present on others. That is not
// hypothetical - it is the bug that shipped in business-verification-service.
//
// So this file is the thing that actually makes the arrangement safe. It reads
// all three sources and compares them table by table, column by column.

process.env.NODE_ENV = "test";
process.env.POSTGRES_URL ||= "postgres://postgres@127.0.0.1:55432/titopay";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-with-sufficient-length";
process.env.JWT_REFRESH_SECRET ||= "test-refresh-secret-with-sufficient-length";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const API = path.join(__dirname, "..");
const MIGRATION = path.join(API, "src/db/migrations/20260819_book_foundation.up.sql");
const DOWN = path.join(API, "src/db/migrations/20260819_book_foundation.down.sql");
const SCHEMA = path.join(API, "src/db/schema.sql");
const { CREATE_SQL, DEFERRED_FK_SQL } = require("../src/services/book-schema");

const EXPECTED_TABLES = [
  "book_venues", "book_activations", "book_services", "book_resources",
  "book_service_resources", "book_availability_rules",
  "book_availability_exceptions", "book_bookings"
];

/* ---------------------------------------------------------------- parsing */

// Strip comments and collapse whitespace so formatting differences between the
// three copies never read as drift, while real differences still do.
function normalise(sql) {
  return String(sql)
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pull each `CREATE TABLE IF NOT EXISTS <name> ( ... );` body out of a source,
// matching parentheses rather than using a regex, because the bodies contain
// nested parens in CHECK constraints and NUMERIC(18,2).
function tableBodies(sql) {
  const flat = normalise(sql);
  const bodies = {};
  const re = /CREATE TABLE IF NOT EXISTS (book_[a-z_]+) \(/gi;
  let match;
  while ((match = re.exec(flat))) {
    let depth = 1;
    let index = re.lastIndex;
    while (index < flat.length && depth > 0) {
      if (flat[index] === "(") depth += 1;
      else if (flat[index] === ")") depth -= 1;
      index += 1;
    }
    bodies[match[1]] = flat.slice(re.lastIndex, index - 1).trim();
  }
  return bodies;
}

// Split a table body on top-level commas only, so NUMERIC(18,2) and
// CHECK (a IN ('x','y')) stay in one piece.
function definitions(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function columnMap(body) {
  const map = {};
  for (const item of definitions(body)) {
    // Table-level constraints are compared separately from columns.
    if (/^(CONSTRAINT|PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\b/i.test(item)) continue;
    const name = item.split(/\s+/)[0];
    map[name] = item.replace(/\s+/g, " ");
  }
  return map;
}

function constraintSet(body) {
  return definitions(body)
    .filter((item) => /^CONSTRAINT\b/i.test(item))
    .map((item) => item.replace(/\s+/g, " "))
    .sort();
}

function indexSet(sql) {
  return [...normalise(sql).matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+) ON (book_[a-z_]+)([^;]*);/gi)]
    .map((m) => `${m[1]} ON ${m[2]}${m[3]}`.replace(/\s+/g, " ").trim())
    .sort();
}

/* ------------------------------------------------------------- the sources */

const migrationSql = fs.readFileSync(MIGRATION, "utf8");
const schemaSql = fs.readFileSync(SCHEMA, "utf8");
// Only the Book block of schema.sql; the rest of that file is every other table
// in TitoPay and is none of this test's business.
const schemaBookBlock = schemaSql.slice(schemaSql.indexOf("TitoPay Book: the booking foundation."));

const SOURCES = {
  migration: migrationSql,
  "schema.sql": schemaBookBlock,
  "book-schema.js": CREATE_SQL + "\n" + DEFERRED_FK_SQL
};

/* ------------------------------------------------------------------ tests */

test("all three copies define exactly the same eight tables", () => {
  for (const [label, sql] of Object.entries(SOURCES)) {
    const tables = Object.keys(tableBodies(sql)).sort();
    assert.deepEqual(tables, [...EXPECTED_TABLES].sort(),
      `${label} defines a different set of tables`);
  }
});

test("every column agrees across all three copies", () => {
  const bodies = Object.fromEntries(
    Object.entries(SOURCES).map(([label, sql]) => [label, tableBodies(sql)])
  );
  for (const table of EXPECTED_TABLES) {
    const reference = columnMap(bodies.migration[table]);
    for (const label of ["schema.sql", "book-schema.js"]) {
      const other = columnMap(bodies[label][table]);
      assert.deepEqual(Object.keys(other).sort(), Object.keys(reference).sort(),
        `${table}: ${label} has a different column list from the migration`);
      for (const column of Object.keys(reference)) {
        assert.equal(other[column], reference[column],
          `${table}.${column} is defined differently in ${label}`);
      }
    }
  }
});

test("every named constraint agrees across all three copies", () => {
  const bodies = Object.fromEntries(
    Object.entries(SOURCES).map(([label, sql]) => [label, tableBodies(sql)])
  );
  for (const table of EXPECTED_TABLES) {
    const reference = constraintSet(bodies.migration[table]);
    for (const label of ["schema.sql", "book-schema.js"]) {
      assert.deepEqual(constraintSet(bodies[label][table]), reference,
        `${table}: ${label} has different constraints from the migration`);
    }
  }
});

test("every index agrees across all three copies", () => {
  const reference = indexSet(SOURCES.migration);
  assert.ok(reference.length >= 10, "the migration should define the Book indexes");
  for (const label of ["schema.sql", "book-schema.js"]) {
    assert.deepEqual(indexSet(SOURCES[label]), reference,
      `${label} defines different indexes from the migration`);
  }
});

/* ------------------------------- the things that must never appear at all */

test("no copy declares an inline foreign key to business_profiles", () => {
  // business_profiles is created by the 20260816 migration and by
  // ensureBusinessSchema(), NEVER by schema.sql. An inline REFERENCES would
  // abort schema.sql on a fresh database, and because that file runs as one
  // statement the ENTIRE schema rolls back and the database is left empty.
  for (const [label, sql] of Object.entries(SOURCES)) {
    for (const [table, body] of Object.entries(tableBodies(sql))) {
      assert.ok(!/REFERENCES business_profiles/i.test(body),
        `${label}: ${table} declares an inline FK to business_profiles, which breaks a fresh install`);
    }
  }
});

test("all three copies attach the deferred foreign keys, guarded", () => {
  for (const [label, sql] of Object.entries(SOURCES)) {
    const flat = normalise(sql);
    assert.match(flat, /book_venues_business_profile_fkey/,
      `${label} never attaches the venue's business_profiles foreign key`);
    assert.match(flat, /book_bookings_booked_for_business_fkey/,
      `${label} never attaches the booking's business_profiles foreign key`);
    // Guarded, or it aborts on a database where business_profiles is absent.
    assert.match(flat, /IF EXISTS \(SELECT 1 FROM information_schema\.tables WHERE table_name = 'business_profiles'\)/,
      `${label} attaches the foreign keys without checking business_profiles exists`);
  }
});

test("Book owns no balance, no ledger and no second financial record", () => {
  // Section 3 of the brief, enforced rather than promised. A column called
  // balance/escrow/float on a Book table is a second financial system, and the
  // integrity checker would never see it.
  const forbidden = /\b(balance|escrow|float|ledger_entry|available_balance|reserved_balance)\b/i;
  for (const [label, sql] of Object.entries(SOURCES)) {
    for (const [table, body] of Object.entries(tableBodies(sql))) {
      for (const column of Object.keys(columnMap(body))) {
        assert.ok(!forbidden.test(column),
          `${label}: ${table}.${column} looks like a second financial record`);
      }
    }
  }
});

test("the migration is additive only: it alters nothing that already exists", () => {
  const lines = migrationSql.split("\n").map((l) => l.replace(/--.*$/, "").trim());
  for (const line of lines) {
    assert.ok(!/^(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\s/i.test(line),
      `a .up.sql must never contain: ${line}`);
  }
  // The only ALTERs permitted are the two guarded FK attachments on Book's own
  // tables. Anything else means the migration is reaching outside Book.
  for (const line of lines) {
    if (/^ALTER TABLE/i.test(line)) {
      assert.match(line, /^ALTER TABLE book_/i,
        `the migration alters a table Book does not own: ${line}`);
    }
  }
});

test("the down migration reverses every table and destroys no financial record", () => {
  const down = fs.readFileSync(DOWN, "utf8");
  for (const table of EXPECTED_TABLES) {
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table}\\b`),
      `${table} is never reversed`);
  }
  for (const protectedTable of ["wallets", "wallet_ledger", "revenue_ledger", "transactions", "users", "business_profiles"]) {
    assert.ok(!new RegExp(`(DROP|DELETE|TRUNCATE|ALTER)[^\\n]*\\b${protectedTable}\\b`, "i").test(down),
      `the down migration touches ${protectedTable}, which is not Book's to touch`);
  }
});
