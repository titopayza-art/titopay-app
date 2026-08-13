const express = require("express");
const { pool } = require("../db/pool");
const { getPlatformSetting } = require("../services/platform-settings-service");
const { buildInfo } = require("../build-info");

const router = express.Router();

function apiHomeHtml(status) {
  return `<!doctype html>
<html lang="en-ZA">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <meta name="theme-color" content="#0057ff">
    <title>Protected Service</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8faff;color:#061a3d}
      main{width:min(100% - 32px,520px);padding:28px;border:1px solid #dbe6f7;border-radius:28px;background:#fff;box-shadow:0 22px 60px rgba(6,26,61,.08);text-align:center}
      h1{margin:0 0 8px;font-size:2rem}.status{color:#66748f}
    </style>
  </head>
  <body>
    <main>
      <h1>Protected Service</h1>
      <p class="status">Protected service. Use authenticated endpoints only.</p>
    </main>
  </body>
</html>`;
}

router.get("/", async (req, res, next) => {
  let status = { database: "unknown" };
  try {
    await pool.query("SELECT 1");
    status = { database: "ok" };
  } catch (error) {
    status = { database: "error" };
    if ((req.get("accept") || "").includes("text/html")) {
      res.status(503).type("html").send(apiHomeHtml(status));
      return;
    }
    next(error);
    return;
  }

  if ((req.get("accept") || "").includes("text/html")) {
    res.type("html").send(apiHomeHtml(status));
    return;
  }

  res.status(404).json({ ok: false, error: "Not found" });
});

async function healthStatus(_req, res, next) {
  try {
    await pool.query("SELECT 1");
    let emailWorker = { status: "not_migrated" };
    const table = await pool.query("SELECT to_regclass('public.email_queue') AS name");
    if (table.rows[0]?.name) {
      const { rows } = await pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='queued')::int AS queued,
        COUNT(*) FILTER (WHERE status='processing')::int AS processing,
        COUNT(*) FILTER (WHERE status='processing' AND locked_at<NOW()-INTERVAL '15 minutes')::int AS stale,
        COUNT(*) FILTER (WHERE status='dead_lettered')::int AS dead_lettered,
        MAX(sent_at) AS last_sent_at
        FROM email_queue`);
      emailWorker = { status: Number(rows[0].stale) ? "stalled" : "ready", ...rows[0] };
    }
    res.json({
      status: "ok",
      database: "ok",
      // Reported so that "is the deployed API current?" is one request rather
      // than an investigation. See src/build-info.js.
      ...buildInfo(),
      emailWorker
    });
  } catch (error) {
    next(error);
  }
}

router.get("/health", healthStatus);

router.get("/maintenance/public", async (_req, res, next) => {
  try {
    const setting = await getPlatformSetting("maintenance_mode", {
      pwa: { enabled: false, note: "", expectedBackAt: "" },
      admin: { enabled: false, note: "", expectedBackAt: "" },
      hr: { enabled: false, note: "", expectedBackAt: "" }
    });
    const value = setting.value || {};
    res.json({
      ok: true,
      maintenance: {
        pwa: value.pwa || { enabled: false, note: "", expectedBackAt: "" },
        admin: value.admin || { enabled: false, note: "", expectedBackAt: "" },
        hr: value.hr || { enabled: false, note: "", expectedBackAt: "" }
      },
      updatedAt: setting.updatedAt
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.healthStatus = healthStatus;
