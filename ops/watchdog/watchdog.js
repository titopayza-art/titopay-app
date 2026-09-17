"use strict";

/*
 * TitoPay watchdog - turns the pull-only /v1/health endpoint into PUSH
 * alerts, from a machine that is NOT the production server (an alerter that
 * shares the server's fate cannot report the server's death; pair it with a
 * free external uptime probe for the case where the watchdog host itself
 * dies - see MONITORING.md).
 *
 * Zero dependencies, Node 18+. Run from cron every minute:
 *
 *   * * * * * . /etc/titopay-watchdog.env && node /path/ops/watchdog/watchdog.js
 *
 * or continuously:  node watchdog.js --loop
 *
 * Environment:
 *   WATCHDOG_API_URL          e.g. https://api.titopay.co.za   (required)
 *   WATCHDOG_WEBHOOK_URL      where alerts POST as JSON {text, severity,
 *                             checks} - Slack/Discord/Teams-compatible
 *                             {text} shape. Optional; without it, alerts go
 *                             to stderr and the process exits non-zero, so
 *                             cron's MAILTO delivers them by email.
 *   WATCHDOG_BACKUP_DIR       when set (watchdog runs where backups land,
 *                             or on a mirror), the newest titopay-*.dump.enc
 *                             older than WATCHDOG_BACKUP_MAX_HOURS (26)
 *                             raises CRITICAL - a missed backup night must
 *                             not be silent.
 *   WATCHDOG_STATE_FILE       default ./watchdog-state.json - remembers what
 *                             has already been alerted so a standing failure
 *                             pages once, re-pages every
 *                             WATCHDOG_REALERT_MINUTES (60), and sends one
 *                             recovery notice when it clears.
 *   WATCHDOG_TIMEOUT_MS       health request timeout (10000)
 *   WATCHDOG_DEAD_THRESHOLD   dead webhook deliveries that raise WARN (1)
 *
 * Severities: CRITICAL = money or availability is impaired now.
 *             WARN     = degradation that becomes CRITICAL if ignored.
 *             INFO     = state change worth a line, never a page.
 */

const fs = require("fs");
const path = require("path");

const API_URL = (process.env.WATCHDOG_API_URL || "").replace(/\/+$/, "");
const WEBHOOK_URL = process.env.WATCHDOG_WEBHOOK_URL || "";
const BACKUP_DIR = process.env.WATCHDOG_BACKUP_DIR || "";
const STATE_FILE = process.env.WATCHDOG_STATE_FILE || path.join(__dirname, "watchdog-state.json");
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS || 10000);
const BACKUP_MAX_HOURS = Number(process.env.WATCHDOG_BACKUP_MAX_HOURS || 26);
const REALERT_MINUTES = Number(process.env.WATCHDOG_REALERT_MINUTES || 60);
const DEAD_THRESHOLD = Number(process.env.WATCHDOG_DEAD_THRESHOLD || 1);

if (!API_URL) {
  console.error("WATCHDOG_API_URL is required");
  process.exit(2);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { alerts: {} }; }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch (error) {
    console.error("watchdog: cannot persist state:", error.message);
  }
}

async function fetchHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/v1/health`, { signal: controller.signal });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

// Each check returns {key, severity, text} for a problem, or null when fine.
function evaluate(health) {
  const findings = [];
  if (!health.ok) {
    findings.push({
      key: "api_down", severity: "CRITICAL",
      text: `API health check failed: ${health.status ? `HTTP ${health.status}` : health.error}. Customers cannot transact.`
    });
    return findings; // nothing else is knowable while it is down
  }
  const body = health.body || {};
  const warnings = body.configWarnings || [];
  if (warnings.length) {
    findings.push({
      key: "config_warnings", severity: "WARN",
      text: `API reports ${warnings.length} configuration warning(s); first: ${String(warnings[0]?.message || warnings[0]).slice(0, 140)}`
    });
  }
  for (const [name, label] of [["emailWorker", "Email worker"], ["webhookWorker", "Webhook delivery"], ["settlementWorker", "Settlement sweep"]]) {
    const worker = body[name];
    if (!worker) continue;
    if (worker.status === "stalled") {
      findings.push({ key: `${name}_stalled`, severity: "CRITICAL", text: `${label} is STALLED (last heartbeat ${worker.lastHeartbeat || "unknown"}). Its queue is not draining.` });
    } else if (worker.status === "never_ran") {
      findings.push({ key: `${name}_never_ran`, severity: "WARN", text: `${label} has never run on this deployment.` });
    }
  }
  if (Number(body.webhookWorker?.dead || 0) >= DEAD_THRESHOLD) {
    findings.push({ key: "webhook_dead_letters", severity: "WARN", text: `${body.webhookWorker.dead} webhook delivery(ies) in the dead-letter queue await replay.` });
  }
  if (Number(body.settlementWorker?.attention || 0) > 0) {
    findings.push({ key: "settlement_attention", severity: "WARN", text: `${body.settlementWorker.attention} settlement batch(es) in discrepancy/failed state need an operator.` });
  }
  if (BACKUP_DIR) {
    let newest = 0;
    try {
      for (const file of fs.readdirSync(BACKUP_DIR)) {
        if (/^titopay-.*\.dump\.enc$/.test(file)) {
          newest = Math.max(newest, fs.statSync(path.join(BACKUP_DIR, file)).mtimeMs);
        }
      }
    } catch (error) {
      findings.push({ key: "backup_dir", severity: "WARN", text: `Backup directory unreadable: ${error.message}` });
    }
    if (newest === 0) {
      findings.push({ key: "backup_missing", severity: "CRITICAL", text: `No backup file found in ${BACKUP_DIR} at all.` });
    } else if (Date.now() - newest > BACKUP_MAX_HOURS * 3600 * 1000) {
      findings.push({ key: "backup_stale", severity: "CRITICAL", text: `Newest backup is ${Math.round((Date.now() - newest) / 3600000)}h old (limit ${BACKUP_MAX_HOURS}h). Last night's backup did not run.` });
    }
  }
  return findings;
}

async function deliver(severity, text, checks) {
  const line = `[titopay-watchdog] ${severity}: ${text}`;
  if (WEBHOOK_URL) {
    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: line, severity, checks, at: new Date().toISOString() })
      });
      if (response.ok) return true;
      console.error(`watchdog: alert webhook answered HTTP ${response.status}`);
    } catch (error) {
      console.error(`watchdog: alert webhook unreachable: ${error.message}`);
    }
  }
  // Fallback channel: stderr + non-zero exit -> cron MAILTO emails it.
  console.error(line);
  return false;
}

async function runOnce() {
  const state = loadState();
  const health = await fetchHealth();
  const findings = evaluate(health);
  const now = Date.now();
  const activeKeys = new Set(findings.map((finding) => finding.key));
  let worstNew = null;

  for (const finding of findings) {
    const previous = state.alerts[finding.key];
    const due = !previous || now - previous.lastSentAt >= REALERT_MINUTES * 60 * 1000;
    if (due) {
      await deliver(finding.severity, finding.text, findings.map((f) => f.key));
      state.alerts[finding.key] = { lastSentAt: now, severity: finding.severity };
      if (finding.severity === "CRITICAL") worstNew = "CRITICAL";
      else if (!worstNew) worstNew = "WARN";
    }
  }
  // Recovery notices: anything previously alerted that is now clean.
  for (const key of Object.keys(state.alerts)) {
    if (!activeKeys.has(key)) {
      await deliver("INFO", `Recovered: ${key.replace(/_/g, " ")} is healthy again.`, [...activeKeys]);
      delete state.alerts[key];
    }
  }
  saveState(state);
  if (!findings.length) console.log(`[titopay-watchdog] OK build=${health.body?.build} ${new Date().toISOString()}`);
  return worstNew;
}

(async () => {
  if (process.argv.includes("--loop")) {
    const interval = Number(process.env.WATCHDOG_LOOP_SECONDS || 60) * 1000;
    for (;;) {
      await runOnce().catch((error) => console.error("watchdog tick failed:", error.message));
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  const worst = await runOnce();
  // Non-zero exit on a newly raised CRITICAL so cron MAILTO fires even with
  // no webhook configured. WARN and quiet runs exit zero.
  process.exit(worst === "CRITICAL" && !WEBHOOK_URL ? 1 : 0);
})();
