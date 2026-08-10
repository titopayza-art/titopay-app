"use strict";

// Run the API on every core instead of one.
//
// Node is single-threaded, so one process uses one core no matter how large the
// machine is. Measured on a 4-core box: one process sustained 2.9 logins per
// second and froze unrelated requests for up to 3.8 seconds while people signed
// in; four processes sustained 10.5 per second with the worst unrelated request
// at 957ms.
//
// This lives in the application rather than in the process manager on purpose.
// The deployment notes are honest that production might be pm2 or might be
// cPanel's Setup Node.js App, and pm2's own cluster mode only helps in the
// first case. Node's cluster module works the same under pm2 in fork mode,
// under systemd, and under a plain `node src/cluster.js`, so the capacity does
// not depend on which supervisor happens to be in front of it.
//
// Everything that made this unsafe was dealt with in the previous change: rate
// limits count in PostgreSQL rather than per process, the connection pool
// divides the database ceiling instead of repeating it, and chat sockets stay
// on their own instance. This file only forks; it introduces no shared state of
// its own.
//
// WORKERS=1, or not setting it on a single-core host, runs exactly one worker,
// which behaves like the server always has.

const cluster = require("cluster");
const os = require("os");

function workerCount() {
  const requested = Number(process.env.API_WORKERS);
  if (Number.isFinite(requested) && requested > 0) return Math.floor(requested);
  // Leave a core for PostgreSQL, the email worker and the chat instance. On a
  // single or dual core host that still yields at least one.
  return Math.max(1, os.cpus().length - 1);
}

const workers = workerCount();

if (!cluster.isPrimary || workers === 1) {
  // Either we are a forked worker, or there is only one worker to run and
  // forking would just add a process for nothing. Serve directly.
  require("./server");
} else {
  // Every worker needs to agree with the primary about how many there are,
  // because the connection pool sizes itself from this. Without it each worker
  // would size for one and together they would exhaust max_connections.
  process.env.API_WORKERS = String(workers);

  console.log(`TitoPay API cluster starting ${workers} workers on ${os.cpus().length} cores`);

  for (let i = 0; i < workers; i += 1) cluster.fork();

  // A worker that dies takes its in-flight requests with it; not replacing it
  // would silently shrink capacity until a restart. Replaced unless we are
  // deliberately shutting down, which is what `stopping` distinguishes.
  let stopping = false;

  cluster.on("exit", (worker, code, signal) => {
    if (stopping) return;
    console.error("[cluster] worker exited; starting a replacement", {
      pid: worker.process.pid,
      code,
      signal: signal || null
    });
    cluster.fork();
  });

  function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`TitoPay API cluster received ${signal}; stopping ${workers} workers`);
    for (const worker of Object.values(cluster.workers || {})) worker.kill(signal);
    // Workers close their own listeners and exit; this is the backstop for one
    // that will not.
    setTimeout(() => process.exit(0), 11000).unref();
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
