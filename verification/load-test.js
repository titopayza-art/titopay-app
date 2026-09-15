// HOW MUCH THIS ACTUALLY TAKES.
//
// Every statement about TitoPay's capacity so far — including mine — has been
// reasoning from the code rather than measurement, because nothing in the
// repository could measure it. This is the missing tool.
//
// It ramps concurrency against a running API and reports latency percentiles,
// not just an average: an average hides the tail, and the tail is what a
// customer on a Vodacom connection at month-end actually experiences.
//
//   node verification/load-test.js
//   TARGET=https://staging.titopay.co.za node verification/load-test.js
//   LEVELS=5,10,25,50 DURATION_MS=8000 node verification/load-test.js
//
// TWO HONEST LIMITS, and they matter more than the numbers it prints:
//
// 1. Rate limiting is per IP. All load from one machine looks like one caller,
//    so past a certain concurrency you measure the rate limiter, not the
//    server. 429s are counted SEPARATELY from errors for exactly this reason —
//    a run that is mostly 429 has told you nothing about capacity. For a true
//    ceiling you need distributed load, or a staging box with the limit raised.
//
// 2. A sandbox is not production hardware. Numbers from a developer machine
//    establish shape and relative change — single process against four workers,
//    before a fix against after — not an absolute figure to plan a launch on.
//
// It reads only. No account is created, nothing is written, no money moves.

const TARGET = (process.env.TARGET || "http://127.0.0.1:8110").replace(/\/+$/, "");
const PATH = process.env.LOAD_PATH || "/v1/health";
const LEVELS = (process.env.LEVELS || "1,2,5,10,25,50").split(",").map((n) => Number(n.trim())).filter(Boolean);
const DURATION_MS = Number(process.env.DURATION_MS || 5000);
const WARMUP_MS = Number(process.env.WARMUP_MS || 800);

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]);
}

async function once(url) {
  const started = process.hrtime.bigint();
  try {
    const response = await fetch(url, { headers: { "user-agent": "titopay-load-test" } });
    // Draining matters: an undrained body keeps the socket busy and flatters
    // every number below it.
    await response.arrayBuffer();
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, status: response.status };
  } catch (error) {
    return { ms: Number(process.hrtime.bigint() - started) / 1e6, status: 0, error: (error.cause && error.cause.code) || error.name };
  }
}

async function level(url, concurrency, durationMs) {
  const latencies = [];
  const statuses = new Map();
  const errors = new Map();
  const deadline = Date.now() + durationMs;
  let inFlight = 0;
  let done = 0;

  await new Promise((resolve) => {
    const pump = () => {
      while (inFlight < concurrency && Date.now() < deadline) {
        inFlight += 1;
        once(url).then((r) => {
          inFlight -= 1;
          done += 1;
          latencies.push(r.ms);
          statuses.set(r.status, (statuses.get(r.status) || 0) + 1);
          if (r.error) errors.set(r.error, (errors.get(r.error) || 0) + 1);
          if (Date.now() < deadline) pump();
          else if (inFlight === 0) resolve();
        });
      }
      if (Date.now() >= deadline && inFlight === 0) resolve();
    };
    pump();
  });

  latencies.sort((a, b) => a - b);
  const ok = statuses.get(200) || 0;
  const limited = statuses.get(429) || 0;
  const failed = done - ok - limited;
  return {
    concurrency,
    requests: done,
    rps: Math.round(done / (durationMs / 1000)),
    ok, limited, failed,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: Math.round(latencies[latencies.length - 1] || 0),
    errors: [...errors.entries()].map(([k, v]) => `${k}×${v}`).join(" ")
  };
}

(async () => {
  const url = `${TARGET}${PATH}`;
  console.log(`\n${"=".repeat(88)}`);
  console.log(`  LOAD — ${url}`);
  console.log(`  ${DURATION_MS}ms per level, concurrency ${LEVELS.join(", ")}`);
  console.log(`${"=".repeat(88)}\n`);

  const probe = await once(url);
  if (probe.status !== 200) {
    console.log(`  The target answered ${probe.status || probe.error} before any load was applied.`);
    console.log("  Stopping rather than reporting numbers from a target that is not healthy.\n");
    process.exit(1);
  }
  await level(url, 2, WARMUP_MS);

  console.log(`  ${"conc".padStart(5)} ${"req".padStart(7)} ${"req/s".padStart(7)} ${"p50".padStart(6)} ${"p95".padStart(7)} ${"p99".padStart(7)} ${"max".padStart(7)}  ${"ok".padStart(6)} ${"429".padStart(6)} ${"fail".padStart(5)}`);
  console.log(`  ${"-".repeat(84)}`);

  const rows = [];
  for (const concurrency of LEVELS) {
    const r = await level(url, concurrency, DURATION_MS);
    rows.push(r);
    console.log(
      `  ${String(r.concurrency).padStart(5)} ${String(r.requests).padStart(7)} ${String(r.rps).padStart(7)}` +
      ` ${String(r.p50).padStart(6)} ${String(r.p95).padStart(7)} ${String(r.p99).padStart(7)} ${String(r.max).padStart(7)}` +
      `  ${String(r.ok).padStart(6)} ${String(r.limited).padStart(6)} ${String(r.failed).padStart(5)}` +
      (r.errors ? `  ${r.errors}` : "")
    );
    // Let counters and sockets settle so the next level starts clean.
    await new Promise((r2) => setTimeout(r2, 1200));
  }

  console.log("");
  const clean = rows.filter((r) => r.limited === 0 && r.failed === 0);
  const throttled = rows.filter((r) => r.limited > 0);
  if (clean.length) {
    const best = clean[clean.length - 1];
    console.log(`  Highest concurrency answered cleanly: ${best.concurrency} — ${best.rps} req/s, p95 ${best.p95}ms, p99 ${best.p99}ms`);
  }
  if (throttled.length) {
    console.log(`  Rate limiting began at concurrency ${throttled[0].concurrency}. Everything above that measured`);
    console.log("  the limiter, not the server. For a real ceiling: distributed load, or raise the limit on staging.");
  }
  if (rows.some((r) => r.failed > 0)) {
    console.log("  Some requests failed outright — that is the server or the network, not throttling. Read the error column.");
  }
  console.log("");
})().catch((error) => { console.error(error); process.exit(1); });
