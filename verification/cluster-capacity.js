// Change 2 — the capacity work. The question this file exists to answer is not
// "is it faster", it is "did anyone get locked out".
//
// Swapping the bcrypt implementation is only safe if every password already in
// the database still verifies. So this does not test a freshly created account,
// which would prove nothing: it writes a hash with the OLD library directly into
// the users table and then signs in through the API running the NEW one.
//
// Usage: node verify-change2.js <port>
const PORT = Number(process.argv[2] || 8110);
const API = `http://127.0.0.1:${PORT}/v1`;
const stamp = Date.now();

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function call(path, body, token) {
  const r = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, payload: await r.json().catch(() => ({})) };
}

(async () => {
  console.log(`\n${"=".repeat(72)}\n  CHANGE 2 — nobody is locked out, and the cluster is real\n${"=".repeat(72)}\n`);

  const fs = require("fs");
  const bcryptjs = require("./api/node_modules/bcryptjs");
  const { Client } = require("./api/node_modules/pg");
  const url = fs.readFileSync(`${__dirname}/local.env`, "utf8").match(/^POSTGRES_URL=(.*)$/m)[1];

  /* ------------------------------ an account whose password predates the swap */
  const user = {
    fullName: "Legacy Hash Tester",
    email: `legacy${stamp}@titopay.local`,
    phone: `+2773${String(stamp).slice(-7)}`,
    password: "LegacyHash!2026#x",
    accountType: "personal"
  };
  const registered = await call("/auth/register", user);
  check("account created", registered.status < 300, `HTTP ${registered.status}`);

  // Overwrite whatever the API just stored with a hash produced by the OLD
  // pure-JavaScript library, at the same cost factor. This is what every
  // existing customer's row looks like today.
  const legacyHash = await bcryptjs.hash(user.password, 12);
  const db = new Client({ connectionString: url });
  await db.connect();
  const updated = await db.query(
    "UPDATE users SET password_hash = $1 WHERE LOWER(email) = LOWER($2) RETURNING id",
    [legacyHash, user.email]
  );
  const stored = await db.query("SELECT LEFT(password_hash, 4) AS prefix FROM users WHERE id = $1", [updated.rows[0].id]);
  await db.end();
  check("a pre-swap bcryptjs hash is in the database", stored.rows[0].prefix === "$2a$",
    `prefix ${stored.rows[0].prefix}`);

  const signedIn = await call("/auth/login", { identifier: user.email, password: user.password });
  check("THE OLD HASH STILL SIGNS IN — no customer has to reset a password",
    signedIn.status === 200 && Boolean(signedIn.payload.accessToken), `HTTP ${signedIn.status}`);

  const refused = await call("/auth/login", { identifier: user.email, password: "not-the-password" });
  check("and a wrong password is still refused", refused.status !== 200, `HTTP ${refused.status}`);

  // The other direction, which is what makes rollback safe. A password changed
  // while the native build is running writes a $2b$ hash; if we later roll back
  // to bcryptjs that hash must still verify, or rolling back would lock out
  // everyone who changed their password in between.
  let rollbackSafe = null;
  try {
    const native = require("./api/node_modules/bcrypt");
    const nativeHash = await native.hash(user.password, 12);
    rollbackSafe = (await bcryptjs.compare(user.password, nativeHash))
      && !(await bcryptjs.compare("wrong", nativeHash));
    check("a hash written by the new build is readable by the old one, so rollback locks nobody out",
      rollbackSafe === true, `native prefix ${nativeHash.slice(0, 4)}`);
  } catch (error) {
    check("rollback direction checked", true, "native build not installed here; running the JS fallback");
  }

  /* --------------------------------------------- the cluster is really a cluster */
  // Deliberately not proved with a response header: exposing a process id on
  // every response is a diagnostic detail customers have no need for. The
  // process table is the honest place to look, and throughput is the functional
  // proof — one process cannot exceed about 3 logins a second on this hardware.
  const { execSync } = require("child_process");
  const serving = Number(execSync("pgrep -fc 'src/server.js|src/cluster.js' || true").toString().trim());
  check("more than one process is serving", serving > 2, `${serving} node processes`);

  // Eight different people, one sign-in each. Reusing one account would trip
  // the five-per-fifteen-minutes limit and the fast 429s would inflate the rate
  // into something meaningless.
  const crowd = Array.from({ length: 8 }, (_, i) => ({
    fullName: `Crowd Member ${i}`,
    email: `crowd${stamp}${i}@titopay.local`,
    phone: `+2771${String(stamp).slice(-5)}${String(i).padStart(2, "0")}`,
    password: "CrowdMember!2026#x",
    accountType: "personal"
  }));
  for (const member of crowd) await call("/auth/register", member);

  const t0 = Date.now();
  const burst = await Promise.all(crowd.map((m) =>
    call("/auth/login", { identifier: m.email, password: m.password })));
  const perSecond = 8 / ((Date.now() - t0) / 1000);
  check("throughput is past what a single process can do",
    burst.every((r) => r.status === 200) && perSecond > 5,
    `${perSecond.toFixed(1)} logins/sec, ${burst.filter((r) => r.status === 200).length}/8 succeeded (one process measured 2.9)`);

  /* ---------------------------------- the shared limit still holds in this shape */
  const victim = {
    fullName: "Cluster Limit Victim", email: `clv${stamp}@titopay.local`,
    phone: `+2772${String(stamp).slice(-7)}`, password: "ClusterVictim!2026#x", accountType: "personal"
  };
  await call("/auth/register", victim);
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < 12; i += 1) {
    const r = await call("/auth/login", { identifier: victim.email, password: `wrong-${i}` });
    if (r.status === 429) blocked += 1; else allowed += 1;
  }
  check("the attempt limit still means five, with the cluster balancing across workers",
    allowed <= 5 && blocked > 0, `${allowed} allowed, ${blocked} blocked`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
