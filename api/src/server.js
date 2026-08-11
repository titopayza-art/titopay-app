const http = require("http");
const { app } = require("./app");
const { config } = require("./config/env");
const { attachChatSocketServer } = require("./realtime/chat-socket");

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

server.listen(config.apiPort, config.apiHost, () => {
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
