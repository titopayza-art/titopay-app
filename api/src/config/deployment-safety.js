"use strict";

// A SANDBOX BALANCE MUST NEVER BECOME A CLAIM ON REAL MONEY.
//
// Sandbox on TitoPay is not a separate database. It is one environment
// variable per integration choosing which URL and keys the server talks to,
// and no financial table records which mode created a row. So the only things
// standing between a test balance and a real bank payout are:
//
//   1. which database this process opened
//   2. which mode each integration is in
//
// Both were previously unstated and both failed OPEN. PEACH_PAYMENTS_MODE,
// DOCFOX_MODE and OTT_MODE each read `process.env.X || "production"`, so an
// unset variable, a typo, or a stripped environment file put the platform in
// PRODUCTION silently. Nothing checked that a production API had opened the
// production database, or the reverse.
//
// This module makes both explicit and makes them fail CLOSED.
//
// WHY A NEW VARIABLE RATHER THAN NODE_ENV.
//
// NODE_ENV on this codebase means what it means everywhere else: development
// or production. Two behaviours already key off it, and setting it to
// "sandbox" would change both silently:
//
//   config/env.js  CUSTOMER_REGISTRATION_GEO_LOCK defaults to OFF when
//                  NODE_ENV is not "production" — a compliance control
//   config/env.js  62 localhost origins are added to CORS
//
// Overloading NODE_ENV to carry the deployment identity would therefore turn a
// safety change into a safety regression. TITOPAY_ENV is a separate, explicit
// declaration, and NODE_ENV keeps its ordinary meaning. NODE_ENV=sandbox is
// still understood as a statement of intent, and disagreeing with TITOPAY_ENV
// is itself an error rather than something to resolve by guessing.
//
// WHERE THIS RUNS.
//
// At STARTUP, from server.js, before the process listens. Deliberately not at
// config module load: the test suite and every verification harness import
// services directly without booting a server, and a hard throw at require time
// would break all of them without making a single payment safer.

const VALID_MODES = ["sandbox", "production"];

// Read once, so a caller can pass a synthetic environment in a test without
// mutating process.env and leaking into the next test.
function readMode(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { name, ok: false, reason: `${name} is required and must be either "sandbox" or "production". It is not set. It used to default to "production", which meant an unset variable put TitoPay live silently.` };
  }
  const value = String(raw).trim();
  if (!VALID_MODES.includes(value)) {
    // Deliberately not lowercased or trimmed into shape. "Production ",
    // "PRODUCTION" and "prod" are all someone being imprecise about which
    // environment handles real money, and guessing what they meant is exactly
    // the behaviour this replaces.
    return { name, ok: false, reason: `${name} must be exactly "sandbox" or "production". It is "${value}".` };
  }
  return { name, ok: true, value };
}

// The database this process actually opened, named safely.
//
// A connection string carries a password, so it is never returned, never
// logged and never put in an error. Only the database name and host are used,
// and only the database name is reported.
function describeDatabaseTarget(connectionString) {
  const raw = String(connectionString || "").trim();
  if (!raw) return { name: "", host: "", parsed: false };
  try {
    const url = new URL(raw);
    return {
      name: decodeURIComponent(url.pathname.replace(/^\//, "")) || "",
      host: url.hostname || "",
      parsed: true
    };
  } catch {
    // A libpq keyword string ("host=... dbname=...") is not a URL. Reading the
    // dbname out of it is enough, and anything unparseable is reported as
    // unknown rather than assumed safe.
    const match = /(?:^|\s)dbname=([^\s]+)/.exec(raw);
    return { name: match ? match[1] : "", host: "", parsed: Boolean(match) };
  }
}

// Does this database name look like it belongs to the declared environment?
//
// This is a NAMING heuristic and it is only ever used to REFUSE, never to
// approve: a name that looks production-ish under TITOPAY_ENV=sandbox is a
// hard error, and a name that says nothing either way is passed to the
// authoritative check below, which asks the database itself.
function databaseNameConflicts(databaseName, environment) {
  const name = String(databaseName || "").toLowerCase();
  if (!name) return null;
  const looksProduction = /(^|[_-])(prod|production|live)([_-]|$)/.test(name);
  const looksSandbox = /(^|[_-])(sandbox|sbx|test|dev|staging|uat|qa|demo)([_-]|$)/.test(name);
  if (environment === "production" && looksSandbox && !looksProduction) {
    return `TITOPAY_ENV is "production" but the database is named "${databaseName}", which names a test environment. A production API must never open the sandbox database.`;
  }
  if (environment === "sandbox" && looksProduction && !looksSandbox) {
    return `TITOPAY_ENV is "sandbox" but the database is named "${databaseName}", which names the production environment. A sandbox API must never open the production database.`;
  }
  return null;
}

// Which credentials each mode requires. A sandbox key in production, or the
// reverse, is not a fallback: it is the wrong money.
const PEACH_CREDENTIALS = ["apiKey", "merchantId"];

function checkPeachCredentials(peach, mode) {
  if (!peach || peach.v2Enabled === false && !peach.apiKey && mode === "sandbox") {
    // Peach not configured at all in sandbox is normal: the fake provider is
    // used instead. It is only in production that its absence is fatal.
    return mode === "production"
      ? [`PEACH_PAYMENTS_MODE is "production" but no Peach credentials are configured.`]
      : [];
  }
  const missing = PEACH_CREDENTIALS.filter((key) => !String(peach[key] || "").trim());
  if (mode === "production" && missing.length) {
    return [`PEACH_PAYMENTS_MODE is "production" but these are not set: ${missing.map((key) => `PEACH_PAYMENTS_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`).join(", ")}. TitoPay must never fall back to sandbox credentials in production.`];
  }
  const baseUrl = String(mode === "production" ? peach.productionBaseUrl : peach.sandboxBaseUrl || "").toLowerCase();
  const problems = [];
  if (mode === "production" && /sandbox/.test(baseUrl)) {
    problems.push(`PEACH_PAYMENTS_MODE is "production" but the production base URL points at a sandbox host.`);
  }
  if (mode === "sandbox" && baseUrl && !/sandbox|localhost|127\.0\.0\.1/.test(baseUrl)) {
    problems.push(`PEACH_PAYMENTS_MODE is "sandbox" but the sandbox base URL does not point at a sandbox host.`);
  }
  return problems;
}

/**
 * Everything that can be decided from configuration alone, with no database.
 *
 * @param {object} options
 * @param {object} options.env      an environment object, defaults to process.env
 * @param {object} options.config   the loaded config, for the integration credentials
 * @returns {{ok: boolean, environment: string|null, modes: object, problems: string[], database: object}}
 */
function inspectDeployment({ env = process.env, config = null } = {}) {
  const problems = [];

  // 1. The deployment's own identity.
  const declared = readMode(env, "TITOPAY_ENV");
  if (!declared.ok) problems.push(declared.reason);
  const environment = declared.ok ? declared.value : null;

  // NODE_ENV is not overloaded, but if somebody has stated an environment
  // there too, the two must agree. Silently preferring one would reintroduce
  // exactly the guessing this replaces.
  const nodeEnv = String(env.NODE_ENV || "").trim();
  if (environment && VALID_MODES.includes(nodeEnv) && nodeEnv !== environment) {
    problems.push(`NODE_ENV is "${nodeEnv}" and TITOPAY_ENV is "${environment}". They must agree, or NODE_ENV must be left to its ordinary "development"/"production" meaning.`);
  }

  // 2. Every integration mode, explicitly.
  const modes = {};
  for (const name of ["PEACH_PAYMENTS_MODE", "DOCFOX_MODE", "OTT_MODE"]) {
    const mode = readMode(env, name);
    if (!mode.ok) { problems.push(mode.reason); continue; }
    modes[name] = mode.value;
    // A production deployment talking to a sandbox provider would take real
    // customers' card details to a test acquirer. A sandbox deployment
    // talking to a production provider would take real money. Both are fatal.
    if (environment && mode.value !== environment) {
      problems.push(`TITOPAY_ENV is "${environment}" but ${name} is "${mode.value}". Every integration must run in the same environment as the deployment.`);
    }
  }

  // 3. The database, by name only. Never the connection string.
  const database = describeDatabaseTarget(env.POSTGRES_URL || env.DATABASE_URL || config?.postgresUrl);
  if (!database.name) {
    problems.push("The database name could not be read from POSTGRES_URL, so it cannot be checked against TITOPAY_ENV.");
  } else if (environment) {
    const conflict = databaseNameConflicts(database.name, environment);
    if (conflict) problems.push(conflict);
  }

  // 4. Credentials for the mode actually selected.
  if (config && modes.PEACH_PAYMENTS_MODE) {
    problems.push(...checkPeachCredentials(config.integrations?.peachPayments, modes.PEACH_PAYMENTS_MODE));
  }

  return { ok: problems.length === 0, environment, modes, problems, database };
}

// The key the database stamps its own identity under. platform_settings is the
// existing mechanism for exactly this kind of platform-level fact, so no new
// table is introduced and no financial table gains a column.
const IDENTITY_KEY = "deployment_environment";

/**
 * The authoritative check: ask the DATABASE what it is.
 *
 * A name is a convention and conventions get broken. This reads a marker the
 * database itself carries, so a production database restored under a different
 * name, or a sandbox database renamed, is still recognised for what it is.
 *
 * On a database that has never been stamped, the marker is WRITTEN to match
 * the declared environment and the process is allowed to start. That is
 * deliberate: refusing would break every existing deployment on upgrade, and
 * the first stamp is the only moment where there is nothing to contradict. It
 * is additive, idempotent, and once stamped a mismatch is fatal forever after.
 *
 * @returns {Promise<{ok: boolean, stamped: string|null, wrote: boolean, problems: string[]}>}
 */
async function verifyDatabaseIdentity(pool, environment, { stampIfMissing = true } = {}) {
  if (!environment) return { ok: false, stamped: null, wrote: false, problems: ["The environment is not declared, so the database identity cannot be verified."] };
  try {
    const { rows } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [IDENTITY_KEY]
    );
    const stored = rows[0]?.value;
    const stamped = typeof stored === "string" ? stored : stored?.environment || null;

    if (stamped && stamped !== environment) {
      return {
        ok: false, stamped, wrote: false,
        problems: [`This database is stamped as the "${stamped}" database and TITOPAY_ENV is "${environment}". Refusing to start: a ${environment} API must never open the ${stamped} database.`]
      };
    }
    if (stamped) return { ok: true, stamped, wrote: false, problems: [] };
    if (!stampIfMissing) return { ok: true, stamped: null, wrote: false, problems: [] };

    // First stamp. ON CONFLICT DO NOTHING so two workers racing at boot cannot
    // both write, and so re-running is a no-op rather than an overwrite.
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2::JSONB, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [IDENTITY_KEY, JSON.stringify({ environment, stampedAt: new Date().toISOString() })]
    );
    // Re-read rather than assume the insert won the race.
    const { rows: after } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [IDENTITY_KEY]
    );
    const settled = after[0]?.value?.environment || null;
    if (settled && settled !== environment) {
      return {
        ok: false, stamped: settled, wrote: false,
        problems: [`This database is stamped as the "${settled}" database and TITOPAY_ENV is "${environment}".`]
      };
    }
    return { ok: true, stamped: settled, wrote: true, problems: [] };
  } catch (error) {
    // A database that cannot be asked is not a database that can be trusted
    // with real money, but neither is this the place to decide the schema is
    // missing. Report it and let the caller fail closed.
    return { ok: false, stamped: null, wrote: false, problems: [`The database identity could not be read: ${error.message}`] };
  }
}

// What an operator sees at boot. Modes and the database NAME only: never a
// connection string, a host with credentials in it, a key, or a secret.
function describeDeployment(inspection) {
  return [
    `Environment:      ${inspection.environment || "NOT DECLARED"}`,
    `Peach Payments:   ${inspection.modes.PEACH_PAYMENTS_MODE || "NOT DECLARED"}`,
    `DocFox:           ${inspection.modes.DOCFOX_MODE || "NOT DECLARED"}`,
    `OTT:              ${inspection.modes.OTT_MODE || "NOT DECLARED"}`,
    `Database target:  ${inspection.database.name || "unknown"}`
  ];
}

module.exports = {
  VALID_MODES,
  IDENTITY_KEY,
  readMode,
  describeDatabaseTarget,
  databaseNameConflicts,
  checkPeachCredentials,
  inspectDeployment,
  verifyDatabaseIdentity,
  describeDeployment
};
