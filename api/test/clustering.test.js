"use strict";

// ONE PROCESS, OR SEVERAL.
//
// API_WORKERS was read for pool sizing and for a warning, and never actually
// forked anything — so every customer request, every payment and every webhook
// was served by a single Node process on a single CPU core. One unhandled crash
// was a total outage.
//
// Clustering is opt-in and the default is unchanged, which is the property that
// matters most here: a deployment that does not set API_WORKERS must behave
// exactly as it did before, chat included.

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
const POOL = fs.readFileSync(path.join(__dirname, "..", "src", "db", "pool.js"), "utf8");

test("clustering is opt-in, and one worker is still the default", () => {
  assert.match(SERVER, /const apiWorkers = Math\.max\(1, Math\.floor\(Number\(process\.env\.API_WORKERS\) \|\| 1\)\)/,
    "an unset API_WORKERS must resolve to 1");
  assert.match(SERVER, /if \(apiWorkers > 1 && cluster\.isPrimary\) \{/,
    "nothing may fork unless clustering was asked for");
});

test("a clustered worker cannot serve chat, whatever the environment says", () => {
  // Chat sockets live in one process's memory. A customer connected to worker 2
  // is invisible to worker 3, so an agent's reply handled by worker 3 never
  // arrives — silently, with no error. This used to be a warning a deployment
  // could ignore; it is now structural.
  assert.match(SERVER, /const inClusteredWorker = apiWorkers > 1 && cluster\.isWorker/);
  assert.match(SERVER, /const chatSocketEnabled = !inClusteredWorker\s*&&\s*String\(process\.env\.CHAT_SOCKET_ENABLED/,
    "a worker must force chat off before consulting the environment");

  // And the rule holds for every combination an operator could configure.
  const decide = (workers, isWorker, envValue) => {
    const inWorker = workers > 1 && isWorker;
    return !inWorker && String(envValue ?? "true").trim().toLowerCase() !== "false";
  };
  assert.equal(decide(1, false, undefined), true, "single process keeps chat, as before");
  assert.equal(decide(1, false, "false"), false, "the dedicated-instance switch still works");
  assert.equal(decide(4, true, "true"), false, "a worker cannot be talked into serving chat");
  assert.equal(decide(4, true, undefined), false);
  assert.equal(decide(4, false, undefined), true, "the primary is not a listening process, but the rule is safe");
});

test("a worker that dies is replaced, and shutdown does not fight it", () => {
  assert.match(SERVER, /cluster\.on\("exit"[\s\S]{0,240}cluster\.fork\(\)/,
    "the fleet must not quietly shrink over time");
  assert.match(SERVER, /if \(shuttingDown\) return;[\s\S]{0,200}worker exited; replacing it/,
    "a deliberate shutdown must not respawn what it is trying to stop");
  assert.match(SERVER, /for \(const worker of Object\.values\(cluster\.workers \|\| \{\}\)\) worker\.kill\(signal\)/,
    "SIGTERM must reach every worker");
  assert.match(SERVER, /setTimeout\(\(\) => process\.exit\(0\), 10000\)\.unref\(\)/,
    "a worker that will not close must not hold the deploy open forever");
});

test("the connection pool is divided between workers, not multiplied by them", () => {
  // Four workers each opening the old 20 connections is 80 against a database
  // configured for 100 with 20 reserved — the fix would have caused the outage.
  const fn = POOL.match(/function poolSize\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "poolSize must exist");
  // eslint-disable-next-line no-new-func
  const poolSize = new Function("process", `${fn[0]}; return poolSize;`);
  const at = (workers) => poolSize({ env: { API_WORKERS: String(workers) } })();
  assert.equal(at(1), 20, "one worker keeps the historical pool");
  assert.equal(at(4), 16);
  assert.equal(at(8), 8);
  assert.ok(at(4) * 4 < 100 - 20, "four workers must fit inside the database's connection budget");
  assert.ok(at(16) >= 4, "a pool is never allowed below the floor that queues more than it serves");
});

test("the boot line says which process this is", () => {
  // With several identical processes in a log, "started" on its own is useless.
  assert.match(SERVER, /role: inClusteredWorker \? `worker \$\{cluster\.worker\.id\} of \$\{apiWorkers\}` : "single process"/);
  assert.match(SERVER, /pid: process\.pid/);
  // The old warning guarded a state that can no longer happen; what replaced it
  // tells an operator the thing that is now true.
  assert.doesNotMatch(SERVER, /WARNING: API_WORKERS is/,
    "a warning for an impossible state is noise");
  assert.match(SERVER, /these workers do not serve chat/);
});
