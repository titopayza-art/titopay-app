// Fire the webhook, the browser return and several status polls at the SAME
// instant against one paid checkout. Only one wallet credit may result.
const API = "http://127.0.0.1:8110/v1";
const PEACH = "http://127.0.0.1:4400";
const stamp = Date.now();
let token = "";

async function call(path, options = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, options.headers || {});
  if (options.auth !== false && token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, {
    method: options.method || "GET", headers,
    body: options.body ? JSON.stringify(options.body) : undefined, redirect: "manual"
  });
  const t = await r.text();
  try { return { status: r.status, payload: JSON.parse(t || "{}") }; } catch { return { status: r.status, payload: { raw: t } }; }
}
const peach = (p, b) => fetch(`${PEACH}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const balance = async () => Number(((await call("/wallets")).payload.items || [])[0]?.available_balance ?? NaN);

(async () => {
  const user = {
    fullName: "Race Tester", email: `race${stamp}@titopay.local`,
    phone: `+2783${String(stamp).slice(-7)}`, password: "RaceTester!2026#x", accountType: "personal"
  };
  await call("/auth/register", { method: "POST", auth: false, body: user });
  token = (await call("/auth/login", { method: "POST", auth: false, body: { identifier: user.email, password: user.password } })).payload.accessToken;

  const opening = await balance();
  const idem = `race-${stamp}`;
  const created = await call("/payments/topup", {
    method: "POST", headers: { "idempotency-key": idem },
    body: { amount: 1234.56, currency: "ZAR", idempotencyKey: idem }
  });
  const { reference, checkoutId, transactionId } = created.payload;
  console.log(`\n  checkout ${checkoutId}\n  reference ${reference}\n  opening balance R${opening.toFixed(2)}\n`);

  // Peach now considers the payment successful.
  await peach("/__complete", { checkoutId, outcome: "successful" });

  // Everything that could settle it, at once.
  console.log("  firing 6 status polls + 4 webhooks + 3 browser returns simultaneously...");
  const returnForm = `merchantTransactionId=${encodeURIComponent(reference)}&checkoutId=${encodeURIComponent(checkoutId)}`;
  const racers = [
    ...Array.from({ length: 6 }, () => call(`/payments/topup/${encodeURIComponent(reference)}`)),
    ...Array.from({ length: 4 }, () => peach("/__webhook", { checkoutId })),
    ...Array.from({ length: 3 }, () => fetch(`${API}/payments/topup/return`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: returnForm, redirect: "manual"
    }))
  ];
  await Promise.allSettled(racers);
  await new Promise((r) => setTimeout(r, 2500));

  const finalBalance = await balance();
  const expected = opening + 1234.56;
  const ok = Math.abs(finalBalance - expected) < 0.005;
  console.log(`\n  final balance   R${finalBalance.toFixed(2)}`);
  console.log(`  expected        R${expected.toFixed(2)}`);
  console.log(`\n  ${ok ? "PASS" : "FAIL"} — credited exactly once under a 13-way race\n`);
  console.log(`  transactionId ${transactionId}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(2); });
