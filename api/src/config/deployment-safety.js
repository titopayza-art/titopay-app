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

// WARNINGS AND BLOCKERS ARE NOT THE SAME THING, AND CONFLATING THEM TOOK AN
// API DOWN.
//
// The first version of this refused to start on ANY finding, including a
// variable that had simply never been set. Deploying it to a server that had
// not yet been given the variables therefore stopped the API: the gate did
// exactly what it was asked to do, and the deployment of it was the outage.
//
// The two cases are genuinely different:
//
//   NOT DECLARED    nobody has said what this deployment is. Bad, and worth
//                   shouting about on every boot, but it is the state every
//                   existing server is already in, and it is exactly how the
//                   platform has been running. Refusing here breaks a working
//                   system to protect it from a risk it already carries.
//
//   CONTRADICTED    somebody HAS said what this is, and something disagrees:
//                   a production API on a database stamped sandbox, an
//                   integration in the other environment. This can only arise
//                   after the variables are deliberately set, so refusing can
//                   never surprise a server that was working a minute ago, and
//                   the state it describes is one where real money goes to the
//                   wrong place.
//
// So: undeclared warns, contradicted refuses. A deployment moves from the
// first to the second by being configured, which is the direction we want,
// and no configuration step is ever punished with an outage.
function classify(problems) {
  return {
    blocking: problems.filter((problem) => problem.blocking).map((problem) => problem.message),
    warnings: problems.filter((problem) => !problem.blocking).map((problem) => problem.message)
  };
}

// THE BANKING LAYER, CHECKED THE SAME WAY EVERYTHING ELSE IS.
//
// Same rule as the rest of this file: a CONTRADICTION refuses, everything else
// warns, and an untouched deployment says nothing at all. The last part
// matters more here than anywhere else, because every server running today has
// none of these variables and none of them needs any.
//
// Returns [{ blocking, text }]. Empty when the banking layer is dormant.
function inspectBanking(env) {
  const found = [];
  const enabled = String(env.BANKING_INTEGRATION_ENABLED || "") === "true";
  const provider = String(env.BANKING_PROVIDER || "").trim();
  const bankingEnvironment = String(env.BANKING_ENVIRONMENT || "").trim().toLowerCase();
  const deployment = String(env.TITOPAY_ENV || "").trim().toLowerCase();

  // Nobody has touched it. Say nothing.
  if (!enabled && !provider && !bankingEnvironment) return found;

  // A CONTRADICTION. Both sides stated, and they disagree about which world
  // this is. Real money would reach a test bank, or test credentials would
  // reach a real one. Only reachable once somebody sets these deliberately,
  // so it can never fell a server that was working a minute ago.
  if (bankingEnvironment && deployment) {
    const bankingIsProduction = bankingEnvironment === "production";
    const deploymentIsProduction = deployment === "production";
    if (bankingIsProduction !== deploymentIsProduction) {
      found.push({
        blocking: true,
        text: `TITOPAY_ENV is "${deployment}" but BANKING_ENVIRONMENT is "${bankingEnvironment}". `
          + "A bank rail must run in the same world as the deployment it serves."
      });
    }
  }

  if (bankingEnvironment && !["development", "staging", "production"].includes(bankingEnvironment)) {
    found.push({
      blocking: false,
      text: `BANKING_ENVIRONMENT is "${bankingEnvironment}", which is not development, staging or production. `
        + "Every banking capability stays closed until it is one of those."
    });
  }

  // Half-configured states. All warnings: the effect of each is a rail that
  // stays shut, which is the safe direction, and refusing to start over a
  // partly finished configuration would punish somebody mid-setup.
  if (enabled && (!provider || provider === "none")) {
    found.push({
      blocking: false,
      text: "BANKING_INTEGRATION_ENABLED is true but BANKING_PROVIDER names no adapter, "
        + "so every banking capability refuses. Set BANKING_PROVIDER or turn the integration off."
    });
  }
  if (provider && provider !== "none" && !enabled) {
    found.push({
      blocking: false,
      text: `BANKING_PROVIDER is "${provider}" but BANKING_INTEGRATION_ENABLED is not "true", `
        + "so nothing is reachable through it."
    });
  }
  if (enabled && !bankingEnvironment) {
    found.push({
      blocking: false,
      text: "BANKING_INTEGRATION_ENABLED is true but BANKING_ENVIRONMENT is not declared, "
        + "so every banking capability refuses."
    });
  }

  // A capability switched on with the master switch off. It does nothing, and
  // somebody believing otherwise is worth one line at boot.
  const orphanFlags = Object.keys(env)
    .filter((name) => /^BANKING_[A-Z0-9_]+_ENABLED$/.test(name) && name !== "BANKING_INTEGRATION_ENABLED")
    .filter((name) => String(env[name]) === "true");
  if (orphanFlags.length && !enabled) {
    found.push({
      blocking: false,
      text: `${orphanFlags.length} banking capability flag(s) are set to true while `
        + "BANKING_INTEGRATION_ENABLED is not, so none of them has any effect."
    });
  }

  return found;
}

/**
 * Everything that can be decided from configuration alone, with no database.
 *
 * @param {object} options
 * @param {object} options.env      an environment object, defaults to process.env
 * @param {object} options.config   the loaded config, for the integration credentials
 * @returns {{ok: boolean, safe: boolean, environment: string|null, modes: object,
 *            problems: string[], blocking: string[], warnings: string[], database: object}}
 */
function inspectDeployment({ env = process.env, config = null } = {}) {
  const found = [];
  const warn = (message) => found.push({ blocking: false, message });
  const block = (message) => found.push({ blocking: true, message });
  const problems = [];

  // 1. The deployment's own identity.
  const declared = readMode(env, "TITOPAY_ENV");
  if (!declared.ok) { problems.push(declared.reason); warn(declared.reason); }
  const environment = declared.ok ? declared.value : null;

  // NODE_ENV is not overloaded, but if somebody has stated an environment
  // there too, the two must agree. Silently preferring one would reintroduce
  // exactly the guessing this replaces.
  const nodeEnv = String(env.NODE_ENV || "").trim();
  if (environment && VALID_MODES.includes(nodeEnv) && nodeEnv !== environment) {
    const message = `NODE_ENV is "${nodeEnv}" and TITOPAY_ENV is "${environment}". They must agree, or NODE_ENV must be left to its ordinary "development"/"production" meaning.`;
    problems.push(message); block(message);
  }

  // 2. Every integration mode, explicitly.
  const modes = {};
  for (const name of ["PEACH_PAYMENTS_MODE", "DOCFOX_MODE", "OTT_MODE"]) {
    const mode = readMode(env, name);
    if (!mode.ok) { problems.push(mode.reason); warn(mode.reason); continue; }
    modes[name] = mode.value;
    // A production deployment talking to a sandbox provider would take real
    // customers' card details to a test acquirer. A sandbox deployment
    // talking to a production provider would take real money. Both are fatal.
    if (environment && mode.value !== environment) {
      // Both sides were stated and they disagree. Real money would go to the
      // wrong place, and no working server can arrive here by accident.
      const message = `TITOPAY_ENV is "${environment}" but ${name} is "${mode.value}". Every integration must run in the same environment as the deployment.`;
      problems.push(message); block(message);
    }
  }

  // 3. The database, by name only. Never the connection string.
  const database = describeDatabaseTarget(env.POSTGRES_URL || env.DATABASE_URL || config?.postgresUrl);
  if (!database.name) {
    const message = "The database name could not be read from POSTGRES_URL, so it cannot be checked against TITOPAY_ENV.";
    problems.push(message); warn(message);
  } else if (environment) {
    const conflict = databaseNameConflicts(database.name, environment);
    // A declared environment against a database named for the other one. Only
    // reachable once TITOPAY_ENV is set, so this cannot fell a running server.
    if (conflict) { problems.push(conflict); block(conflict); }
  }

  // 4. Credentials for the mode actually selected.
  if (config && modes.PEACH_PAYMENTS_MODE) {
    for (const message of checkPeachCredentials(config.integrations?.peachPayments, modes.PEACH_PAYMENTS_MODE)) {
      // WARNING, NOT A BLOCKER, FOR TWO REASONS.
      //
      // This only reads the ENVIRONMENT. Peach credentials can also come from
      // the stored integration config an operator sets in the admin console,
      // which is resolved per call and is invisible from here, so "missing"
      // may simply mean "configured somewhere else". Refusing would stop a
      // perfectly working server.
      //
      // And the failure mode if they really are absent is that a top-up
      // fails, loudly, at the moment it is attempted. That is bad; it is not
      // money reaching the wrong place, which is the only thing worth
      // refusing to start over.
      problems.push(message); warn(message);
    }
  }

  // 5. The banking layer, if anybody has started configuring it.
  //
  // SILENT WHEN UNTOUCHED, AND THAT IS DELIBERATE. A server that has never
  // heard of the banking layer produces no new warning here, so
  // /health's `environmentWarnings` count does not move for any existing
  // deployment. Warning every server about a capability it has not asked for
  // would be noise, and noise is what gets a real warning ignored.
  for (const message of inspectBanking(env)) {
    problems.push(message.text);
    if (message.blocking) block(message.text); else warn(message.text);
  }

  const { blocking, warnings } = classify(found);
  return {
    // `ok` keeps its original meaning: nothing at all is wrong.
    ok: problems.length === 0,
    // `safe` is the one startup gates on: nothing CONTRADICTS.
    safe: blocking.length === 0,
    environment, modes, problems, blocking, warnings, database
  };
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
  // Nothing declared means nothing to contradict. Warn, do not refuse.
  if (!environment) return { ok: true, unknown: true, stamped: null, wrote: false, problems: [], warnings: ["TITOPAY_ENV is not set, so the database identity was not verified."] };
  try {
    const { rows } = await pool.query(
      "SELECT value FROM platform_settings WHERE key = $1 LIMIT 1", [IDENTITY_KEY]
    );
    const stored = rows[0]?.value;
    const stamped = typeof stored === "string" ? stored : stored?.environment || null;

    if (stamped && stamped !== environment) {
      // The one database finding that stops a process: it has positively
      // identified itself as the other environment.
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
    // A DATABASE THAT CANNOT BE REACHED IS NOT A DATABASE IN THE WRONG
    // ENVIRONMENT.
    //
    // This used to be fatal, which turned a Postgres hiccup during a restart
    // into a refusal to start at all — strictly worse than the old behaviour,
    // where the API came up and served 503s until the database returned.
    // Not knowing is a warning; knowing it is the wrong one is a blocker.
    return {
      ok: true, unknown: true, stamped: null, wrote: false, problems: [],
      warnings: [`The database identity could not be read, so it was not verified: ${error.message}`]
    };
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
  inspectBanking,
  inspectDeployment,
  verifyDatabaseIdentity,
  describeDeployment
};
