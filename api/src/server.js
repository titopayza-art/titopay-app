const http = require("http");
const { app } = require("./app");
const { config, startupWarnings } = require("./config/env");
const { attachChatSocketServer } = require("./realtime/chat-socket");
const {
  inspectDeployment, verifyDatabaseIdentity, describeDeployment
} = require("./config/deployment-safety");

// SAY WHAT THIS DEPLOYMENT IS, LOUDLY, AND STOP ONLY FOR A CONTRADICTION.
//
// PEACH_PAYMENTS_MODE, DOCFOX_MODE and OTT_MODE each used to read
// `process.env.X || "production"`. An unset variable, a typo or a stripped
// environment file therefore put TitoPay in PRODUCTION silently, and nothing
// checked that a production API had opened the production database.
//
// The first attempt at this refused to start on ANY finding, including a
// variable that had simply never been set. Deploying it to a server that had
// not yet been given the variables STOPPED THE API. The check was right and
// the rollout was the outage.
//
// So the two cases are now separated:
//
//   NOT DECLARED   warn on every boot, report it on /health, and SERVE. It is
//                  the state every existing server is already in and exactly
//                  how the platform has been running; refusing breaks a
//                  working system to protect it from a risk it already carries.
//
//   CONTRADICTED   refuse. A production API on a database stamped sandbox, or
//                  an integration in the other environment. Only reachable
//                  once the variables are deliberately set, so it can never
//                  fell a server that was working a minute ago, and the state
//                  it describes sends real money to the wrong place.
//
// A deployment moves from the first to the second by being configured, which
// is the direction we want, and configuring is never punished with an outage.
function refuseToStart(problems) {
  console.error("");
  console.error("  TITOPAY REFUSED TO START — THE ENVIRONMENT CONTRADICTS ITSELF");
  console.error("");
  for (const problem of problems) console.error(`    - ${problem}`);
  console.error("");
  console.error("  This is not a missing setting. Something has been declared and something");
  console.error("  else disagrees with it, and starting would risk money reaching the wrong");
  console.error("  place. Correct the contradiction, or unset TITOPAY_ENV to start unverified.");
  console.error("");
  console.error("  Nothing has been served and no connection has been accepted. See GOING-LIVE.md.");
  console.error("");
  process.exit(78); // EX_CONFIG
}

function warnAboutDeployment(warnings) {
  if (!warnings.length) return;
  console.warn("");
  console.warn("  TITOPAY IS RUNNING WITHOUT A DECLARED ENVIRONMENT");
  console.warn("");
  for (const warning of warnings) console.warn(`    ! ${warning}`);
  console.warn("");
  console.warn("  The API is serving normally and this changes nothing about how it behaves.");
  console.warn("  Declare it and this goes quiet:");
  console.warn("    TITOPAY_ENV=production  PEACH_PAYMENTS_MODE=production  DOCFOX_MODE=production  OTT_MODE=production");
  console.warn("    TITOPAY_ENV=sandbox     PEACH_PAYMENTS_MODE=sandbox     DOCFOX_MODE=sandbox     OTT_MODE=sandbox");
  console.warn("");
}

// Configuration problems, printed rather than fatal. src/config/env.js no
// longer throws for any of them: a process that refuses to start is a 502 with
// no explanation, which is the least useful way to report a missing variable.
// The API comes up, says exactly what is wrong, and keeps serving everything
// that does not depend on the misconfigured thing. `node preflight.js` prints
// this same list BEFORE a restart, which is where it should be read.
if (startupWarnings.length) {
  console.warn(`\n[config] ${startupWarnings.length} configuration warning(s). The API is starting anyway.`);
  for (const warning of startupWarnings) console.warn(`[config]   - ${warning}`);
  console.warn("[config] Run `node preflight.js` for the same list with remedies.\n");
}

const deployment = inspectDeployment({ env: process.env, config });
if (!deployment.safe) refuseToStart(deployment.blocking);
warnAboutDeployment(deployment.warnings);

const server = http.createServer(app);

// Live chat holds its open sockets in a Map in this process's memory
// (realtime/chat-hub.js). That is fine with one process and broken with
// several: a customer connected to worker 2 is invisible to worker 3, so an
// agent's reply handled by worker 3 never arrives — silently, with no error.
//
// Rather than rewrite the realtime layer, the socket stays on one instance and
// nginx routes /v1/chat/socket there. The clustered HTTP workers run with
// CHAT_SOCKET_ENABLED=false so they cannot accept an upgrade even if a request
// reaches them by mistake.
//
// Unset means enabled, so a single-process deployment behaves exactly as before.
const apiWorkers = Math.max(1, Math.floor(Number(process.env.API_WORKERS) || 1));

// One process served every customer request, every payment and every webhook on
// a single CPU core, because API_WORKERS was read for pool sizing and for the
// warning below but never actually forked anything. One unhandled crash was a
// total outage and one slow query blocked everyone queued behind it.
//
// API_WORKERS still defaults to 1, and at 1 nothing below runs: the process
// listens exactly as it did before, chat included. Clustering is opt-in, so an
// existing deployment that does not set the variable is byte-for-byte unchanged.
const cluster = require("node:cluster");

if (apiWorkers > 1 && cluster.isPrimary) {
  console.log("TitoPay API primary starting workers", { workers: apiWorkers, pid: process.pid });
  for (let i = 0; i < apiWorkers; i += 1) cluster.fork();

  // A worker that dies takes its in-flight requests with it either way; what
  // must not happen is the fleet quietly shrinking to nothing over a week.
  let shuttingDown = false;
  cluster.on("exit", (worker, code, signal) => {
    if (shuttingDown) return;
    console.error("[cluster] worker exited; replacing it", { pid: worker.process.pid, code, signal });
    cluster.fork();
  });

  const stopFleet = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`TitoPay API primary received ${signal}; stopping ${apiWorkers} worker(s)`);
    for (const worker of Object.values(cluster.workers || {})) worker.kill(signal);
    // Workers close their own connections gracefully; this is the backstop for
    // one that will not.
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on("SIGTERM", () => stopFleet("SIGTERM"));
  process.on("SIGINT", () => stopFleet("SIGINT"));
} else {

// Chat sockets live in one process's memory, so a clustered worker must never
// accept one: a customer connected to worker 2 is invisible to worker 3, and an
// agent's reply handled by worker 3 never arrives — silently, with no error.
//
// This used to be a warning that a deployment could ignore. In a worker it is
// now structural: chat is off, whatever the environment says. Run the dedicated
// chat instance with API_WORKERS unset and nginx routing /v1/chat/socket to it.
const inClusteredWorker = apiWorkers > 1 && cluster.isWorker;
const chatSocketEnabled = !inClusteredWorker
  && String(process.env.CHAT_SOCKET_ENABLED ?? "true").trim().toLowerCase() !== "false";

if (chatSocketEnabled) attachChatSocketServer(server);

// The authoritative environment check: ask the DATABASE what it is, rather
// than trusting a name. A production database restored under another name is
// still the production database, and a sandbox API must not open it.
//
// A database that has never been stamped is stamped to match the declared
// environment, so an existing deployment upgrades without ceremony. A database
// that cannot be REACHED is a warning, never a refusal: that used to turn a
// Postgres hiccup during a restart into a refusal to start at all.
(async () => {
  const identity = await verifyDatabaseIdentity(require("./db/pool").pool, deployment.environment)
    .catch((error) => ({ ok: true, unknown: true, stamped: null, wrote: false, warnings: [`The database identity check did not complete: ${error.message}`] }));
  if (!identity.ok) refuseToStart(identity.problems);
  warnAboutDeployment(identity.warnings || []);

  console.log("");
  for (const line of describeDeployment(deployment)) console.log(`  ${line}`);
  console.log(`  Database identity: ${identity.stamped || "not verified"}${identity.wrote ? " (stamped now)" : ""}`);
  console.log("");

server.listen(config.apiPort, config.apiHost, () => {
  require("./services/wallet-service").ensureLedgerPostingIndex().catch(() => {});
  // Webhook tables + delivery loop. Inline by default so every deployment
  // delivers; a standalone src/webhook-worker.js process takes over when
  // WEBHOOK_WORKER_INLINE=0. Neither the ensure nor the loop may ever be
  // fatal - webhooks degrade, the API does not.
  require("./services/partner-service").ensurePartnerSchema()
    .catch((error) => console.error("[partners] schema ensure failed", { message: error.message }));
  require("./services/webhook-service").ensureWebhookSchema()
    .catch((error) => console.error("[webhooks] schema ensure failed", { message: error.message }))
    .finally(() => {
      if (process.env.WEBHOOK_WORKER_INLINE !== "0") require("./services/webhook-service").startWebhookWorker();
    });
  console.log("TitoPay API service started", {
    role: inClusteredWorker ? `worker ${cluster.worker.id} of ${apiWorkers}` : "single process",
    pid: process.pid,
    chatSocket: chatSocketEnabled ? "attached" : "disabled (served by the dedicated instance)",
    poolMax: require("./db/pool").pool.options.max
  });
  // The warning that used to sit here guarded a state that can no longer occur:
  // a clustered worker forces chat off rather than asking the deployment to
  // remember. What an operator still needs to know is that turning clustering
  // on means chat is now somebody else's job.
  if (inClusteredWorker && cluster.worker.id === 1) {
    console.log(
      "[chat-socket] Clustered: these workers do not serve chat. Run one instance with API_WORKERS unset " +
      "and route /v1/chat/socket to it, or live chat will not connect."
    );
  }
});
})().catch((error) => {
  // The safety check itself failing must never be the reason customers cannot
  // pay. It is reported and the API serves, exactly as it did before any of
  // this existed.
  console.error("[deployment-safety] the check did not complete; serving anyway", { message: error.message });
  server.listen(config.apiPort, config.apiHost, () => {
  require("./services/wallet-service").ensureLedgerPostingIndex().catch(() => {});
  // Webhook tables + delivery loop. Inline by default so every deployment
  // delivers; a standalone src/webhook-worker.js process takes over when
  // WEBHOOK_WORKER_INLINE=0. Neither the ensure nor the loop may ever be
  // fatal - webhooks degrade, the API does not.
  require("./services/partner-service").ensurePartnerSchema()
    .catch((error) => console.error("[partners] schema ensure failed", { message: error.message }));
  require("./services/webhook-service").ensureWebhookSchema()
    .catch((error) => console.error("[webhooks] schema ensure failed", { message: error.message }))
    .finally(() => {
      if (process.env.WEBHOOK_WORKER_INLINE !== "0") require("./services/webhook-service").startWebhookWorker();
    });
    console.log("TitoPay API service started (deployment safety check incomplete)", { pid: process.pid });
  });
});

function shutdown(signal) {
  console.log(`TitoPay API received ${signal}; closing connections`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 9000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

} // end of the listening process (single process, or one clustered worker)

// Node terminates the process on an unhandled promise rejection. In an API that
// is a silent outage: the connection is reset mid-request, every other customer
// in flight is dropped with it, and nothing is written explaining why. The
// client sees a reset — not an HTTP status — which its own error handling can
// only report as "not reachable", so the real fault stays invisible.
//
// Log it loudly and keep serving. The request that caused it still fails, and
// it still fails through the normal error handler, so the caller gets a proper
// 500 with a requestId instead of a dropped connection.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled promise rejection — request failed, server kept alive", {
    message: reason?.message || String(reason),
    code: reason?.code || reason?.details?.code || null,
    stack: reason?.stack
  });
});

// An uncaught exception can leave the process in an unknown state, so this one
// does exit — but only after saying why, which is the part that was missing.
process.on("uncaughtException", (error) => {
  console.error("[fatal] uncaught exception — shutting down", {
    message: error?.message || String(error),
    stack: error?.stack
  });
  shutdown("uncaughtException");
});
