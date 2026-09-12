// Does the brute-force limit actually hold, and does it still let a crowd in?
//
// Before the fix, clientIpKey read CF-Connecting-IP — a plain request header —
// ahead of req.ip. Anyone hitting the origin could send a different value on
// every request and mint a fresh bucket each time, which switched off the
// 5-attempts-per-15-minutes limit on login, OTP and password reset entirely.
//
// Both directions have to be true at once, which is why both are measured here:
//   1. a spoofed rotating header must NOT buy extra attempts
//   2. real customers behind a shared edge must NOT lock each other out
const API = "http://127.0.0.1:8110/v1";
const stamp = Date.now();

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function post(path, body, headers = {}) {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  await r.text();
  return r.status;
}

(async () => {
  console.log(`\n${"=".repeat(70)}\n  RATE LIMIT — spoofable? and does it still let a crowd through?\n${"=".repeat(70)}\n`);

  const victim = { fullName: "Limit Victim", email: `victim${stamp}@titopay.local`,
    phone: `+2779${String(stamp).slice(-7)}`, password: "Victim!2026#xy", accountType: "personal" };
  await post("/auth/register", victim);

  // 1. Rotate a forged CF-Connecting-IP on every wrong-password attempt. The
  //    peer here is loopback, which is NOT a Cloudflare address, so the header
  //    must be ignored entirely and all of these must count as one attacker.
  let spoofBlocked = 0;
  for (let i = 0; i < 25; i += 1) {
    const status = await post("/auth/login", { identifier: victim.email, password: `wrong-${i}` },
      { "cf-connecting-ip": `203.0.113.${i + 1}` });
    if (status === 429) spoofBlocked += 1;
  }
  check("a forged CF-Connecting-IP does not buy extra attempts", spoofBlocked > 0,
    `${spoofBlocked}/25 attempts blocked`);

  // 2. A real edge. Peer is still loopback, so the header is still ignored and
  //    everything keys on the one loopback address — the "shared edge" case.
  //    The general limit is 120/min, so 60 reads must all get through.
  let throttled = 0;
  for (let i = 0; i < 60; i += 1) {
    const r = await fetch(`${API}/health`);
    await r.text();
    if (r.status === 429) throttled += 1;
  }
  check("ordinary traffic is not throttled by the fix", throttled === 0, `${throttled}/60 throttled`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(1); });
