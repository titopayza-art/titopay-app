// Does the login bottleneck actually go away with more processes, and how much
// of it is bcrypt sitting on the event loop?
//
// Nothing here is a proposal. It measures the two candidate fixes against the
// real code so the plan is built on numbers rather than on what usually works.
//
// Assumes API instances are already listening on the ports passed in argv.
const PORTS = process.argv.slice(2).map(Number);
const stamp = Date.now();
const PASSWORD = "ScaleProbe!2026#x";

async function post(port, path, body) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  await r.text();
  return { status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
async function get(port, path) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(`http://127.0.0.1:${port}/v1${path}`);
  await r.text();
  return { status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

(async () => {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`  SCALE MEASUREMENT — ${PORTS.length} API process(es) on ports ${PORTS.join(", ")}`);
  console.log(`${"=".repeat(78)}\n`);

  // ---------------------------------------------------------------- bcrypt
  // What the hash itself costs, and what it costs everyone else. bcryptjs is
  // the pure-JS build, so the work happens on the event loop rather than in a
  // worker thread — this measures both halves of that.
  const bcrypt = require("./api/node_modules/bcryptjs");
  for (const cost of [12, 11, 10]) {
    const t0 = process.hrtime.bigint();
    await bcrypt.hash(PASSWORD, cost);
    console.log(`  bcryptjs cost ${cost}: ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)}ms per hash`);
  }
  // How long the loop is unavailable while one hash runs.
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 5);
  const t0 = process.hrtime.bigint();
  await bcrypt.hash(PASSWORD, 12);
  const hashMs = Number(process.hrtime.bigint() - t0) / 1e6;
  clearInterval(ticker);
  console.log(`  during one cost-12 hash (${hashMs.toFixed(0)}ms) a 5ms timer fired ${ticks} times`);
  console.log(`    → it should have fired ~${Math.round(hashMs / 5)}; the event loop was blocked for the difference\n`);

  // ------------------------------------------------------------- accounts
  const N = 12;
  const users = Array.from({ length: N }, (_, i) => ({
    fullName: `Scale Probe ${i}`,
    email: `scale${stamp}${i}@titopay.local`,
    phone: `+2776${String(stamp).slice(-5)}${String(i).padStart(2, "0")}`,
    password: PASSWORD, accountType: "personal"
  }));
  for (const u of users) await post(PORTS[0], "/auth/register", u);
  console.log(`  ${N} probe accounts created\n`);

  // ------------------------------------------- concurrent logins, spread out
  // Requests are dealt round-robin across whatever processes are running. With
  // one process this is pure serialisation; with several it should divide.
  const health = [];
  let probing = true;
  (async () => { while (probing) { health.push((await get(PORTS[0], "/health")).ms); await new Promise((r) => setTimeout(r, 120)); } })();

  const wall0 = process.hrtime.bigint();
  const logins = await Promise.all(users.map((u, i) =>
    post(PORTS[i % PORTS.length], "/auth/login", { identifier: u.email, password: u.password })));
  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  probing = false;
  await new Promise((r) => setTimeout(r, 200));

  const ok = logins.filter((l) => l.status === 200).length;
  const times = logins.map((l) => l.ms);
  console.log(`  ${N} logins at once across ${PORTS.length} process(es):`);
  console.log(`    login latency      p50 ${pct(times, 0.5).toFixed(0)}ms   p95 ${pct(times, 0.95).toFixed(0)}ms   max ${Math.max(...times).toFixed(0)}ms   (${ok}/${N} succeeded)`);
  console.log(`    wall clock         ${wallMs.toFixed(0)}ms  →  ${(N / (wallMs / 1000)).toFixed(1)} logins/second`);
  console.log(`    /health meanwhile  p50 ${pct(health, 0.5).toFixed(0)}ms   p95 ${pct(health, 0.95).toFixed(0)}ms   max ${Math.max(...health).toFixed(0)}ms   (${health.length} samples)`);
  console.log(`\n${"=".repeat(78)}\n`);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
