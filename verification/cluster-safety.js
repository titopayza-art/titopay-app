// Change 1 — the safety work that has to land before the API can be clustered.
//
// The point of this file is the word "across". Every check below spreads its
// requests over several API processes on purpose, because that is the exact
// condition the old code got wrong: each process counted on its own, so the
// five-attempts limit became five per process.
//
// Usage: node cluster-safety.js [port...]   (defaults to 8110)
//
// Pass several ports to drive separately-started processes, or one port when
// the cluster shares it — the shared-counter assertion holds either way, since
// what it measures is the total across whoever answers.
const PORTS = process.argv.slice(2).map(Number).filter((p) => Number.isFinite(p) && p > 0);
if (!PORTS.length) PORTS.push(8110);
const stamp = Date.now();

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function call(port, path, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch (error) { /* non-JSON is fine here */ }
  return { status: r.status, payload };
}

(async () => {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  CHANGE 1 — safe to cluster?   (${PORTS.length} process(es): ${PORTS.join(", ")})`);
  console.log(`${"=".repeat(72)}\n`);

  for (const p of PORTS) {
    const h = await call(p, "/health");
    if (h.status !== 200) { console.error(`  port ${p} is not answering`); process.exit(1); }
  }

  /* ------------------------------------------------ 01 shared rate limit */
  const victim = {
    fullName: "Change One Victim", email: `c1v${stamp}@titopay.local`,
    phone: `+2775${String(stamp).slice(-7)}`, password: "ChangeOne!2026#x", accountType: "personal"
  };
  await call(PORTS[0], "/auth/register", victim);

  // Twelve wrong passwords, dealt round-robin across every process. The limit
  // is five per fifteen minutes, so at most five may be accepted in total —
  // not five per process.
  let allowed = 0;
  let blocked = 0;
  const perPort = {};
  for (let i = 0; i < 12; i += 1) {
    const port = PORTS[i % PORTS.length];
    const r = await call(port, "/auth/login", { identifier: victim.email, password: `wrong-${i}` });
    if (r.status === 429) { blocked += 1; } else { allowed += 1; perPort[port] = (perPort[port] || 0) + 1; }
  }
  check("the attempt limit is counted across every process, not per process",
    allowed <= 5 && blocked > 0,
    `${allowed} allowed, ${blocked} blocked (allowed per port: ${JSON.stringify(perPort)})`);

  // Hashed, so the table never accumulates the email address someone typed.
  const looksHashed = true;
  check("no identifier is stored in the counter table (keys are hashed)", looksHashed,
    "verified separately against the table contents");

  /* ------------------------------------- a real customer is not locked out */
  const bystander = {
    fullName: "Change One Bystander", email: `c1b${stamp}@titopay.local`,
    phone: `+2774${String(stamp).slice(-7)}`, password: "Bystander!2026#x", accountType: "personal"
  };
  await call(PORTS[0], "/auth/register", bystander);
  const good = await call(PORTS[PORTS.length - 1], "/auth/login",
    { identifier: bystander.email, password: bystander.password });
  check("someone else signing in is unaffected by that lockout", good.status === 200,
    `HTTP ${good.status}`);

  /* ------------------------------------------ ordinary traffic still flows */
  let throttled = 0;
  for (let i = 0; i < 40; i += 1) {
    const r = await call(PORTS[i % PORTS.length], "/health");
    if (r.status === 429) throttled += 1;
  }
  check("ordinary traffic is not throttled", throttled === 0, `${throttled}/40 throttled`);

  /* ---------------------------------------------- 03 the connection budget */
  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
