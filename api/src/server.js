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
const chatSocketEnabled = String(process.env.CHAT_SOCKET_ENABLED ?? "true").trim().toLowerCase() !== "false";
const apiWorkers = Math.max(1, Math.floor(Number(process.env.API_WORKERS) || 1));

if (chatSocketEnabled) attachChatSocketServer(server);

server.listen(config.apiPort, config.apiHost, () => {
  console.log("TitoPay API service started", {
    chatSocket: chatSocketEnabled ? "attached" : "disabled (served by the dedicated instance)",
    poolMax: require("./db/pool").pool.options.max
  });
  // The one configuration that loses customer messages without erroring. Worth
  // a loud line at every boot rather than a surprise in a support queue.
  if (apiWorkers > 1 && chatSocketEnabled) {
    console.warn(
      "[chat-socket] WARNING: API_WORKERS is " + apiWorkers + " and this process is accepting chat sockets. " +
      "Chat state is per-process, so messages will be lost across workers. Run the clustered HTTP workers with " +
      "CHAT_SOCKET_ENABLED=false and route /v1/chat/socket to one dedicated instance."
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
