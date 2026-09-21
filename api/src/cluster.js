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

  // A worker that dies takes its in-flight requests with it; not replacing it
  // would silently shrink capacity until a restart. Replaced unless we are
  // deliberately shutting down, which is what `stopping` distinguishes.
  //
  // But replacing unconditionally is worse than not replacing at all. If
  // workers die immediately — the port already taken, a bad environment
  // variable, a missing migration — an unconditional respawn becomes an
  // infinite fork loop that burns a core, floods the log and never recovers,
  // while the port stays held so an operator's restart appears to succeed and
  // silently does nothing. That happened during testing of this very file: a
  // stale primary respawned workers for forty minutes while every "restart"
  // quietly served stale code.
  //
  // So a worker that dies young counts against a budget. Crossing it stops the
  // cluster with a clear reason instead of thrashing, and the supervisor gets a
  // non-zero exit — which is what makes pm2's own restart backoff apply.
  const YOUNG_MS = 10000;
  const MAX_RAPID_FAILURES = 10;
  const startedAt = new Map();
  let stopping = false;
  let rapidFailures = 0;

  function fork() {
    const worker = cluster.fork();
    startedAt.set(worker.id, Date.now());
    return worker;
  }

  for (let i = 0; i < workers; i += 1) fork();

  cluster.on("exit", (worker, code, signal) => {
    const age = Date.now() - (startedAt.get(worker.id) || 0);
    startedAt.delete(worker.id);
    if (stopping) return;

    if (age < YOUNG_MS) {
      rapidFailures += 1;
      console.error("[cluster] worker died within " + YOUNG_MS + "ms of starting", {
        pid: worker.process.pid, code, signal: signal || null,
        rapidFailures, limit: MAX_RAPID_FAILURES
      });
      if (rapidFailures >= MAX_RAPID_FAILURES) {
        console.error(
          "[cluster] " + MAX_RAPID_FAILURES + " workers failed to stay up. Refusing to keep forking — " +
          "this is a startup fault, not a crash. Check that the port is free, the environment is complete " +
          "and the database is reachable. Exiting so the supervisor can back off."
        );
        stopping = true;
        for (const w of Object.values(cluster.workers || {})) w.kill("SIGKILL");
        process.exit(1);
      }
    } else {
      // A worker that ran for a while and then died is an ordinary crash, so
      // the budget resets. Only a run of young deaths means startup is broken.
      rapidFailures = 0;
      console.error("[cluster] worker exited; starting a replacement", {
        pid: worker.process.pid, code, signal: signal || null, ranForMs: age
      });
    }
    fork();
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
